import crypto from "node:crypto";

function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  const normalized = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
}

function humanPlanName(planType) {
  if (!planType) {
    return null;
  }
  return {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    max: "Max",
  }[planType] || planType;
}

function encryptionKey() {
  const raw = process.env.AUTH_POOL_ENCRYPTION_KEY || "";
  if (!raw) {
    throw new Error("AUTH_POOL_ENCRYPTION_KEY is not configured");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  throw new Error("AUTH_POOL_ENCRYPTION_KEY must be 32 bytes in base64 or 64 hex characters");
}

export function deriveAuthPoolEntry(authJsonText, reporter = {}) {
  const payload = JSON.parse(authJsonText);
  const accountId = payload?.tokens?.account_id;
  const identity = decodeJwtPayload(payload?.tokens?.id_token || "");
  const authClaim = identity?.["https://api.openai.com/auth"] || {};

  if (!accountId) {
    throw new Error("auth json is missing tokens.account_id");
  }

  return {
    source: "codex",
    account_id: String(accountId),
    email: identity?.email ? String(identity.email) : null,
    name: identity?.name ? String(identity.name) : null,
    plan_name: humanPlanName(authClaim?.chatgpt_plan_type),
    auth_last_refresh: payload?.last_refresh ? String(payload.last_refresh) : null,
    digest: crypto.createHash("sha256").update(authJsonText).digest("hex"),
    reporter_name: reporter.reporter_name ? String(reporter.reporter_name) : null,
    hostname: reporter.hostname ? String(reporter.hostname) : null,
    auth_json: authJsonText,
  };
}

export function encryptAuthJson(authJsonText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(authJsonText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted_auth_json: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: tag.toString("base64"),
  };
}

export function decryptAuthJson(entry) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(entry.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(entry.auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.encrypted_auth_json, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function windowRemainingPercent(report, key) {
  const value = report?.windows?.[key]?.remaining_percent;
  return value === null || value === undefined ? -1 : Number(value);
}

function isHardInvalidation(report) {
  return (
    report?.source === "codex" &&
    report?.status === "error" &&
    (
      report?.error === "auth invalidated (token_invalidated)" ||
      report?.error === "auth failed (401 unauthorized)"
    )
  );
}

export function pickBestAuthPoolCandidate(reports, authPoolEntries, options = {}) {
  const exclude = new Set(options.exclude_account_ids || []);
  const entryByAccount = new Map(authPoolEntries.map((entry) => [entry.account_id, entry]));

  const candidates = reports
    .filter((report) => report.source === "codex")
    .filter((report) => !exclude.has(report.account_id))
    .filter((report) => !isHardInvalidation(report))
    .filter((report) => entryByAccount.has(report.account_id))
    .filter((report) => windowRemainingPercent(report, "5h") > 0)
    .filter((report) => windowRemainingPercent(report, "1week") > 0)
    .sort((left, right) => {
      const fiveHourDelta = windowRemainingPercent(right, "5h") - windowRemainingPercent(left, "5h");
      if (fiveHourDelta !== 0) {
        return fiveHourDelta;
      }
      const weeklyDelta = windowRemainingPercent(right, "1week") - windowRemainingPercent(left, "1week");
      if (weeklyDelta !== 0) {
        return weeklyDelta;
      }
      return String(right.reported_at || "").localeCompare(String(left.reported_at || ""));
    });

  if (!candidates.length) {
    return null;
  }

  const report = candidates[0];
  return {
    entry: entryByAccount.get(report.account_id),
    report,
  };
}

export function shouldReplaceAuthPoolEntry(existingEntry, incomingEntry) {
  if (!existingEntry) {
    return true;
  }
  if (existingEntry.source !== incomingEntry.source || existingEntry.account_id !== incomingEntry.account_id) {
    return true;
  }

  const existingRefresh = String(existingEntry.auth_last_refresh || "");
  const incomingRefresh = String(incomingEntry.auth_last_refresh || "");

  if (existingRefresh && incomingRefresh) {
    return incomingRefresh > existingRefresh;
  }

  if (existingRefresh && !incomingRefresh) {
    return false;
  }

  if (!existingRefresh && incomingRefresh) {
    return true;
  }

  return existingEntry.digest !== incomingEntry.digest;
}
