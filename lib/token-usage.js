export const TOKEN_USAGE_COUNTERS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "total_tokens",
]);

export const TOKEN_USAGE_MAX_ROWS = 400;
export const TOKEN_USAGE_TREND_LIMIT = 2000;
export const TOKEN_USAGE_BREAKDOWN_LIMIT = 500;
export const TOKEN_USAGE_DETAIL_DAYS = 90;

const PROVIDERS = new Set(["codex", "claude"]);
const GRANULARITIES = new Set(["15m", "hour", "day"]);
const GROUPINGS = new Set(["hub_user", "provider", "model_account", "model"]);
const METRICS = new Set(["total", "input", "output", "cache_read", "cache_write", "reasoning"]);
const BATCH_KEYS = new Set(["installation_id", "batch_id", "rows"]);
const ROW_KEYS = new Set(["bucket_start", "provider", "model_account_id", "model_id", ...TOKEN_USAGE_COUNTERS]);
const QUERY_KEYS = new Set([
  "start",
  "end",
  "granularity",
  "group_by",
  "metric",
  "hub_user",
  "provider",
  "model_account",
  "model",
]);
const SINGLE_QUERY_KEYS = ["start", "end", "granularity", "group_by", "metric"];
const MAX_FILTER_VALUES = 25;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class TokenUsageValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "TokenUsageValidationError";
    this.statusCode = statusCode;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenUsageValidationError(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TokenUsageValidationError(`${label} contains unknown field: ${key}`);
    }
  }
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeIdentifier(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new TokenUsageValidationError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw new TokenUsageValidationError(`${label} is invalid`);
  }
  return normalized;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new TokenUsageValidationError(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TokenUsageValidationError(`${label} must be a canonical UTC timestamp`);
  }
  return { value, ms: parsed };
}

function normalizeCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TokenUsageValidationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeRow(input, { nowMs }) {
  assertPlainObject(input, "row");
  assertExactKeys(input, ROW_KEYS, "row");
  for (const key of ROW_KEYS) {
    if (!Object.hasOwn(input, key)) {
      throw new TokenUsageValidationError(`row is missing field: ${key}`);
    }
  }

  const bucket = canonicalTimestamp(input.bucket_start, "bucket_start");
  const bucketDate = new Date(bucket.ms);
  if (bucketDate.getUTCMinutes() % 15 !== 0 || bucketDate.getUTCSeconds() !== 0 || bucketDate.getUTCMilliseconds() !== 0) {
    throw new TokenUsageValidationError("bucket_start must be a UTC quarter-hour boundary");
  }
  if (bucket.ms > nowMs + FIVE_MINUTES_MS) {
    throw new TokenUsageValidationError("bucket_start is too far in the future");
  }
  if (bucket.ms < nowMs - TOKEN_USAGE_DETAIL_DAYS * DAY_MS) {
    throw new TokenUsageValidationError("bucket_start is older than 90 days");
  }

  const provider = normalizeIdentifier(input.provider, "provider", 16).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new TokenUsageValidationError("provider must be codex or claude");
  }

  const row = {
    bucket_start: bucket.value,
    provider,
    model_account_id: normalizeIdentifier(input.model_account_id, "model_account_id", 320),
    model_id: normalizeIdentifier(input.model_id, "model_id", 256),
  };
  for (const counter of TOKEN_USAGE_COUNTERS) {
    row[counter] = normalizeCounter(input[counter], counter);
  }

  if (provider === "codex") {
    if (row.cache_read_tokens > row.input_tokens) {
      throw new TokenUsageValidationError("cache_read_tokens cannot exceed Codex input_tokens");
    }
    if (row.cache_write_tokens > row.input_tokens) {
      throw new TokenUsageValidationError("cache_write_tokens cannot exceed Codex input_tokens");
    }
    if (row.reasoning_tokens > row.output_tokens) {
      throw new TokenUsageValidationError("reasoning_tokens cannot exceed Codex output_tokens");
    }
    if (row.total_tokens !== row.input_tokens + row.output_tokens) {
      throw new TokenUsageValidationError("Codex total_tokens must equal input_tokens plus output_tokens");
    }
  } else {
    const claudeTotal = row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
    if (!Number.isSafeInteger(claudeTotal) || row.total_tokens !== claudeTotal) {
      throw new TokenUsageValidationError("Claude total_tokens must include input, output, cache read, and cache write tokens");
    }
    if (row.reasoning_tokens !== 0) {
      throw new TokenUsageValidationError("Claude reasoning_tokens must be zero when unavailable");
    }
  }

  return row;
}

function rowSortKey(row) {
  return [row.bucket_start, row.provider, row.model_account_id, row.model_id];
}

function compareRows(left, right) {
  const leftKey = rowSortKey(left);
  const rightKey = rowSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const comparison = leftKey[index].localeCompare(rightKey[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function normalizeTokenUsageBatch(body, { now = new Date() } = {}) {
  assertPlainObject(body, "body");
  assertExactKeys(body, BATCH_KEYS, "body");
  for (const key of BATCH_KEYS) {
    if (!Object.hasOwn(body, key)) {
      throw new TokenUsageValidationError(`body is missing field: ${key}`);
    }
  }
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > TOKEN_USAGE_MAX_ROWS) {
    throw new TokenUsageValidationError(`rows must contain 1 to ${TOKEN_USAGE_MAX_ROWS} items`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must be a valid date");
  }
  return {
    installation_id: normalizeIdentifier(body.installation_id, "installation_id", 128),
    batch_id: normalizeIdentifier(body.batch_id, "batch_id", 128),
    rows: body.rows.map((row) => normalizeRow(row, { nowMs })).sort(compareRows),
  };
}

function readSingleton(searchParams, key) {
  const values = searchParams.getAll(key);
  if (values.length !== 1) {
    throw new TokenUsageValidationError(`${key} must appear exactly once`);
  }
  return values[0];
}

function readFilters(searchParams, key, label, maxLength) {
  const values = searchParams.getAll(key);
  if (values.length > MAX_FILTER_VALUES) {
    throw new TokenUsageValidationError(`${key} has too many values`);
  }
  return values.map((value) => normalizeIdentifier(value, label, maxLength));
}

export function parseTokenUsageQuery(url, { now = new Date() } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url, "https://quota-report-hub.invalid");
  } catch {
    throw new TokenUsageValidationError("query URL is invalid");
  }
  for (const key of parsedUrl.searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) {
      throw new TokenUsageValidationError(`query contains unknown parameter: ${key}`);
    }
  }

  const singleton = Object.fromEntries(SINGLE_QUERY_KEYS.map((key) => [key, readSingleton(parsedUrl.searchParams, key)]));
  const start = canonicalTimestamp(singleton.start, "start");
  const end = canonicalTimestamp(singleton.end, "end");
  if (start.ms >= end.ms) {
    throw new TokenUsageValidationError("start must be before end");
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");
  if (end.ms > nowMs + FIVE_MINUTES_MS) {
    throw new TokenUsageValidationError("end is too far in the future");
  }

  const granularity = normalizeIdentifier(singleton.granularity, "granularity", 16);
  const groupBy = normalizeIdentifier(singleton.group_by, "group_by", 32);
  const metric = normalizeIdentifier(singleton.metric, "metric", 32);
  if (!GRANULARITIES.has(granularity)) throw new TokenUsageValidationError("granularity is invalid");
  if (!GROUPINGS.has(groupBy)) throw new TokenUsageValidationError("group_by is invalid");
  if (!METRICS.has(metric)) throw new TokenUsageValidationError("metric is invalid");
  if (granularity !== "day" && end.ms - start.ms > TOKEN_USAGE_DETAIL_DAYS * DAY_MS) {
    throw new TokenUsageValidationError("15m and hour ranges cannot exceed 90 days");
  }

  const hubUsers = readFilters(parsedUrl.searchParams, "hub_user", "hub_user", 320);
  const providers = readFilters(parsedUrl.searchParams, "provider", "provider", 16).map((value) => value.toLowerCase());
  for (const provider of providers) {
    if (!PROVIDERS.has(provider)) throw new TokenUsageValidationError("provider filter is invalid");
  }
  const modelAccounts = readFilters(parsedUrl.searchParams, "model_account", "model_account", 320);
  const models = readFilters(parsedUrl.searchParams, "model", "model", 256);

  return {
    start: start.value,
    end: end.value,
    granularity,
    groupBy,
    metric,
    hubUsers,
    providers,
    modelAccounts,
    models,
    publicQuery: {
      start: start.value,
      end: end.value,
      granularity,
      group_by: groupBy,
      metric,
      hub_users: hubUsers,
      providers,
      model_accounts: modelAccounts,
      models,
    },
  };
}
