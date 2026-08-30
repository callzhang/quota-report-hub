import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import {
  authPoolEntry,
  bestAuthPoolEntry,
  dbConfigured,
  getFeatureFlag,
  getInvalidatedUploaderEntry,
  fetchPolicyInputs,
  poolScarcityState,
  recordAuthPoolFetch,
  upsertAuthPoolEntry,
} from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";
import { invalidatedEntryToRepairAuth, stripRefreshToken } from "../../lib/fetch-best.js";
import { NOTICE_REPEAT_SECONDS, PREMIUM_RATIO_WINDOW_DAYS, evaluateFetchPolicy } from "../../lib/premium-ratio.js";
import { scarcityFromState } from "../../lib/pool-scarcity.js";
import { decryptAuthJson } from "../../lib/auth-pool.js";
import { accessTokenMsUntilExpiry, codexIdTokenMsUntilExpiry, verifyAndRefreshAuthBlob } from "../../lib/token-refresh.js";

// The client trips refresh_current at T-20min. Anything at or below this is not worth serving back
// to it — by the time it installs the copy, the copy is expiring too. Sized above the client's
// trigger so the answer is always a token the client can actually work with.
const REFRESH_CURRENT_MIN_LIFETIME_MS = 45 * 60 * 1000;

// The codex CLI/app decide locally when to self-refresh based on id_token's ~1h exp, not
// access_token's ~10-day one. A pooled/AT-only borrower holds a stripped placeholder
// refresh_token, so once id_token goes stale their own refresh attempt always 400s even though
// access_token is still valid for days. This applies just as much to an account a caller is
// freshly switched onto as to one it already holds — the pool can easily be holding an entry
// whose id_token went stale hours or days ago because nothing had asked for it since. Do a real
// upstream refresh in place (using the real RT this hub holds server-side) and persist it,
// instead of handing out an id_token-expired blob that will 400 the moment the client relies on
// it. Returns { authJson, deadRefreshToken } — deadRefreshToken means the real RT was rejected,
// so this account can't self-heal even though its access_token still looks fresh.
async function ensureCodexIdTokenFresh(authJson, entryMeta) {
  const idMsLeft = codexIdTokenMsUntilExpiry(authJson);
  const atMsLeft = accessTokenMsUntilExpiry(authJson, "codex");
  const idStale = idMsLeft !== null && idMsLeft <= 5 * 60 * 1000;
  const atFresh = atMsLeft !== null && atMsLeft > 5 * 60 * 1000;
  if (!idStale || !atFresh) {
    return { authJson, deadRefreshToken: false };
  }
  const refreshed = await verifyAndRefreshAuthBlob(authJson, "codex");
  if (refreshed.ok) {
    await upsertAuthPoolEntry({
      source: "codex",
      auth_json: refreshed.auth_json,
      uploader_email: entryMeta.uploader_email || null,
      reporter_name: entryMeta.reporter_name || "api-refresh-current",
      hostname: entryMeta.hostname || "api-refresh-current",
    });
    return { authJson: refreshed.auth_json, deadRefreshToken: false };
  }
  return { authJson, deadRefreshToken: Boolean(refreshed.auth_rejected) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
    return;
  }

  if (!dbConfigured() || !authPoolConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth pool is not configured" }));
    return;
  }

  const body = await readJsonBody(req);
  const source = body?.source ? String(body.source) : "codex";
  const currentAccountId = body?.current_account_id ? String(body.current_account_id) : null;
  const requesterId = body?.requester_id ? String(body.requester_id) : null;
  const currentQuota = {
    five_h_remaining_percent: body?.current_quota?.five_h_remaining_percent,
    one_week_remaining_percent: body?.current_quota?.one_week_remaining_percent,
  };

  const invalidatedEntry = await getInvalidatedUploaderEntry({
    source,
    uploaderEmail: authContext.email,
    accountId: currentAccountId,
  });
  const repairAuth = invalidatedEntryToRepairAuth(invalidatedEntry);

  // Premium-share gate. It runs before both fetch paths on purpose: 82% of pool traffic is
  // refresh_current, so a gate that only covered account switches would leave the subsidy that
  // actually matters — the hub keeping one account's access token alive indefinitely — untouched.
  const policyWindowStart = new Date(Date.now() - PREMIUM_RATIO_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const requestClientVersion = body?.client_version ? String(body.client_version) : null;
  const [policyInputs, scarcityState] = await Promise.all([
    fetchPolicyInputs({ email: authContext.email, since: policyWindowStart }),
    poolScarcityState(source),
  ]);
  const policy = evaluateFetchPolicy({
    ...policyInputs,
    requestClientVersion,
    poolScarce: scarcityFromState(scarcityState).scarce,
  });

  // Live kill switch, separate from the hardcoded schedule: if a phase lands badly the flag turns
  // refusals off within one request, while the notices keep flowing so users still see where they
  // stand. Turning enforcement off must never also turn the warnings off.
  const enforcePolicy = await getFeatureFlag("premium_ratio_enforcement", true);

  if (!policy.allowed && enforcePolicy) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: null,
      reason: policy.reason,
      currentAccountId,
      currentQuota,
      clientVersion: requestClientVersion,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({
      ok: true,
      requested_by: authContext.email,
      replacement: null,
      // The repair path stays open even while gated: this hands back the caller's OWN invalidated
      // auth so they can re-login. It borrows nothing from the pool, and locking someone out of
      // fixing their own credentials would make the gate impossible to escape.
      repair_auth: repairAuth,
      reason: policy.reason,
      retry_after_seconds: policy.retry_after_seconds,
      premium_share: policy.premium_share,
      demand_share: policy.demand_share,
      notices: policy.notices,
      message: policy.notices[0]?.message || null,
    }, authContext)));
    return;
  }

  // Phase 2: a client whose access token is near expiry asks to refresh the account it is
  // already using rather than switch accounts. Return that account's current pool blob (kept
  // fresh by the worker's central refresh), stripped when disabled_refresh_token is on — same
  // account, a fresh access token, no rotation by the client. Falls through to a normal
  // replacement if that account is no longer in the pool.
  if (body?.refresh_current && currentAccountId) {
    const sameEntry = await authPoolEntry(source, currentAccountId);
    if (sameEntry) {
      let sameAuthJson = await decryptAuthJson(sameEntry);
      let idTokenRefreshDead = false;
      if (source === "codex") {
        const ensured = await ensureCodexIdTokenFresh(sameAuthJson, sameEntry);
        sameAuthJson = ensured.authJson;
        idTokenRefreshDead = ensured.deadRefreshToken;
      }
      // The client only asks for refresh_current when its OWN access token is nearly gone, so
      // serving the pooled copy as-is is only useful if that copy is meaningfully fresher. It
      // usually is not: both sides hold the same token until the worker happens to rotate it. This
      // path used to just serve, on the assumption the worker had kept the pool fresh — measured
      // twice (2026-08-29 and 08-30), it had not, the client reinstalled its own dying token, and
      // the machine went 401 for 45-120 minutes until its owner re-logged in by hand.
      //
      // So refresh HERE when the pooled copy cannot outlive the client's need. The hub holds the
      // real refresh token; this is precisely the moment it exists for.
      let msLeft = accessTokenMsUntilExpiry(sameAuthJson, source);
      if (!idTokenRefreshDead && msLeft !== null && msLeft <= REFRESH_CURRENT_MIN_LIFETIME_MS) {
        const refreshed = await verifyAndRefreshAuthBlob(sameAuthJson, source);
        if (refreshed.ok) {
          sameAuthJson = refreshed.auth_json;
          msLeft = accessTokenMsUntilExpiry(sameAuthJson, source);
          await upsertAuthPoolEntry({
            source,
            auth_json: sameAuthJson,
            uploader_email: sameEntry.uploader_email || null,
            // a rotation write-back, not a new upload: keep the original owner's machine on it
            reporter_name: sameEntry.reporter_name || "hub@refresh-current",
            hostname: sameEntry.hostname || "hub",
          });
        } else if (refreshed.auth_rejected) {
          // the pooled refresh token is dead; a different account is the only way to keep working
          idTokenRefreshDead = true;
        }
      }
      if (!idTokenRefreshDead && (msLeft === null || msLeft > 5 * 60 * 1000)) {
        const disabledRefreshToken = await getFeatureFlag("disabled_refresh_token", false);
        const servedAuthJson = disabledRefreshToken ? stripRefreshToken(sameAuthJson, source) : sameAuthJson;
        await recordAuthPoolFetch({
          requesterEmail: authContext.email,
          requesterId,
          source,
          servedEntry: sameEntry,
          reason: "refreshed_current",
          currentAccountId,
          currentQuota,
          clientVersion: requestClientVersion,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(withTokenUpgrade({
          ok: true,
          requested_by: authContext.email,
          disabled_refresh_token: disabledRefreshToken,
          notices: policy.notices,
          premium_share: policy.premium_share,
      demand_share: policy.demand_share,
          refreshed_current: true,
          replacement: {
            source: sameEntry.source,
            account_id: sameEntry.account_id,
            session_id: sameEntry.session_id || "",
            email: sameEntry.email,
            name: sameEntry.name,
            plan_name: sameEntry.plan_name,
            auth_last_refresh: sameEntry.auth_last_refresh,
            digest: sameEntry.digest,
            uploaded_at: sameEntry.uploaded_at,
            reporter_name: sameEntry.reporter_name,
            hostname: sameEntry.hostname,
            latest_report: null,
            auth_json: servedAuthJson,
          },
        }, authContext)));
        return;
      }
      // stale pooled copy -> fall through to a normal replacement (switch account)
    }
  }

  const entry = await bestAuthPoolEntry({
    source,
    requester_email: authContext.email,
    selection_key: [
      authContext.email,
      requesterId,
      currentAccountId,
      req.headers["x-vercel-ip-city"] || req.headers["x-forwarded-for"] || "",
    ].filter(Boolean).join("|"),
    exclude_account_ids: Array.isArray(body?.exclude_account_ids) ? body.exclude_account_ids : [],
    current_account_id: currentAccountId,
    current_quota: currentQuota,
  });

  if (!entry) {
    // Nothing borrowable exists right now. Selection has already run and come back empty, so this
    // branch refuses nobody -- it only distinguishes, for the audit log and for what the caller is
    // told, between somebody who has a dead auth of their own to repair and somebody who is drawing
    // on a pool they do not supply. Rationing non-contributors happens in the policy above, while
    // there is still something to ration.
    if (!policyInputs.hasHealthyUpload) {
      await recordAuthPoolFetch({
        requesterEmail: authContext.email,
        requesterId,
        source,
        servedEntry: repairAuth ? invalidatedEntry : null,
        reason: repairAuth ? "repair_returned" : "no_uploaded_auth",
        currentAccountId,
        currentQuota,
        clientVersion: requestClientVersion,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify(withTokenUpgrade({
          ok: true,
          requested_by: authContext.email,
          replacement: null,
          repair_auth: repairAuth,
          reason: repairAuth ? "uploaded_auth_requires_reauth" : "pool_empty_no_contribution",
          // Notices are what the client actually shows (`notify_hub_notices`), so anything the user
          // needs to read has to travel as one. The policy notices already carry the contribution
          // warning; this adds the one fact only this branch knows -- the pool is empty right now.
          notices: [
            ...policy.notices,
            {
              code: "pool_empty",
              title: "共享池暂无可用账号",
              message:
                "共享池当前没有额度可借的账号，因此这次没有给你换号——你手上正在用的账号不受影响。" +
                (repairAuth
                  ? "同时，你上传的账号已失效，已把它交还给你：重新登录一次即可恢复。"
                  : "把你自己的 Codex 或 Claude 账号同步进池子，能直接缓解这种缺口。"),
              repeat_seconds: NOTICE_REPEAT_SECONDS,
            },
          ],
        }, authContext))
      );
      return;
    }

    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId,
      currentQuota,
      clientVersion: requestClientVersion,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({
      ok: true,
      replacement: null,
      notices: policy.notices,
      reason: "no_better_auth_available",
    }, authContext)));
    return;
  }

  await recordAuthPoolFetch({
    requesterEmail: authContext.email,
    requesterId,
    source,
    servedEntry: entry,
    reason: "served",
    currentAccountId,
    currentQuota,
    clientVersion: requestClientVersion,
  });

  // A freshly-selected entry can just as easily have a stale id_token as the one being refreshed
  // above — nothing serves this account until now, so nothing has kept its id_token fresh either.
  // Best-effort: still serve what we have if the real RT turns out to be dead here (a borrowed,
  // near-expiry-id_token credential beats leaving the caller with nothing).
  let entryAuthJson = entry.auth_json;
  if (entry.source === "codex") {
    entryAuthJson = (await ensureCodexIdTokenFresh(entryAuthJson, entry)).authJson;
  }

  // When disabled_refresh_token is on, strip the refresh token so the borrower can use the access
  // token but cannot rotate the shared refresh token (the hub refreshes centrally).
  const atOnlyMode = await getFeatureFlag("disabled_refresh_token", false);
  const servedAuthJson = atOnlyMode ? stripRefreshToken(entryAuthJson, entry.source) : entryAuthJson;

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      ok: true,
      requested_by: authContext.email,
      disabled_refresh_token: atOnlyMode,
      notices: policy.notices,
      premium_share: policy.premium_share,
      demand_share: policy.demand_share,
      replacement: {
        source: entry.source,
        account_id: entry.account_id,
        session_id: entry.session_id || "",
        email: entry.email,
        name: entry.name,
        plan_name: entry.plan_name,
        auth_last_refresh: entry.auth_last_refresh,
        digest: entry.digest,
        uploaded_at: entry.uploaded_at,
        reporter_name: entry.reporter_name,
        hostname: entry.hostname,
        latest_report: entry.report,
        auth_json: servedAuthJson,
      },
    }, authContext))
  );
}
