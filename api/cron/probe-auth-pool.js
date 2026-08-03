import { dbConfigured, poolHealthSnapshots } from "../../lib/db.js";

const DEFAULT_REPO = "callzhang/quota-report-hub";
const DEFAULT_WORKFLOW = "probe-auth-pool.yml";
const DEFAULT_REF = "main";
const DEFAULT_MIN_INTERVAL_SECONDS = 20 * 60;

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req, env) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  return req.headers.authorization === `Bearer ${secret}`;
}

function parsePositiveInteger(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function secondsSince(value, now) {
  const millis = Date.parse(String(value || ""));
  if (!Number.isFinite(millis)) {
    return null;
  }
  return Math.floor((now.getTime() - millis) / 1000);
}

function githubDispatchConfig(env) {
  return {
    token: env.GITHUB_WORKFLOW_DISPATCH_TOKEN || "",
    repo: env.GITHUB_WORKFLOW_DISPATCH_REPO || DEFAULT_REPO,
    workflow: env.GITHUB_WORKFLOW_DISPATCH_WORKFLOW || DEFAULT_WORKFLOW,
    ref: env.GITHUB_WORKFLOW_DISPATCH_REF || DEFAULT_REF,
  };
}

export async function dispatchProbeWorkflow({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = githubDispatchConfig(env);
  if (!config.token) {
    return { ok: false, status: 500, error: "github_workflow_dispatch_token_missing" };
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${config.repo}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "User-Agent": "quota-report-hub-cron",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: config.ref }),
    }
  );

  if (response.status === 204) {
    return {
      ok: true,
      status: 204,
      repo: config.repo,
      workflow: config.workflow,
      ref: config.ref,
    };
  }

  return {
    ok: false,
    status: response.status,
    error: "github_workflow_dispatch_failed",
    detail: (await response.text()).slice(0, 1200),
    repo: config.repo,
    workflow: config.workflow,
    ref: config.ref,
  };
}

export async function probeCronHandlerImpl(req, res, deps = {
  dbConfigured,
  poolHealthSnapshots,
  dispatchProbeWorkflow,
  env: process.env,
  now: () => new Date(),
}) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }

  if (!authorized(req, deps.env)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  if (!deps.dbConfigured()) {
    json(res, 500, { error: "Auth pool database is not configured" });
    return;
  }

  const minIntervalSeconds = parsePositiveInteger(
    deps.env.AUTH_POOL_PROBE_MIN_INTERVAL_SECONDS,
    DEFAULT_MIN_INTERVAL_SECONDS
  );
  const latestSnapshots = await deps.poolHealthSnapshots({ limit: 1 });
  const latest = latestSnapshots[latestSnapshots.length - 1] || null;
  const latestAgeSeconds = latest ? secondsSince(latest.captured_at, deps.now()) : null;

  if (latestAgeSeconds !== null && latestAgeSeconds >= 0 && latestAgeSeconds < minIntervalSeconds) {
    json(res, 200, {
      ok: true,
      dispatched: false,
      reason: "recent_probe_snapshot",
      latest_captured_at: latest.captured_at,
      latest_age_seconds: latestAgeSeconds,
      min_interval_seconds: minIntervalSeconds,
    });
    return;
  }

  const dispatch = await deps.dispatchProbeWorkflow({ env: deps.env });
  if (!dispatch.ok) {
    json(res, dispatch.status || 502, {
      ok: false,
      dispatched: false,
      error: dispatch.error,
      detail: dispatch.detail,
      latest_captured_at: latest?.captured_at || null,
      latest_age_seconds: latestAgeSeconds,
      min_interval_seconds: minIntervalSeconds,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    dispatched: true,
    repo: dispatch.repo,
    workflow: dispatch.workflow,
    ref: dispatch.ref,
    latest_captured_at: latest?.captured_at || null,
    latest_age_seconds: latestAgeSeconds,
    min_interval_seconds: minIntervalSeconds,
  });
}

export default async function handler(req, res) {
  return probeCronHandlerImpl(req, res);
}
