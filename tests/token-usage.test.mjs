import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTokenUsageBatch,
  parseTokenUsageQuery,
  TokenUsageValidationError,
} from "../lib/token-usage.js";

const now = new Date("2026-08-18T12:00:00.000Z");

function codexRow(overrides = {}) {
  return {
    bucket_start: "2026-08-18T11:45:00.000Z",
    provider: "codex",
    model_account_id: "ir@stardust.ai",
    model_id: "gpt-5.6-sol",
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 80,
    cache_write_tokens: 0,
    reasoning_tokens: 10,
    total_tokens: 150,
    ...overrides,
  };
}

function validBody(overrides = {}) {
  return {
    installation_id: "install-019f",
    batch_id: "batch-01",
    rows: [codexRow()],
    ...overrides,
  };
}

test("normalizes exact ingestion fields and sorts rows deterministically", () => {
  const result = normalizeTokenUsageBatch(validBody({
    installation_id: " install-019f ",
    rows: [
      codexRow({ model_id: "z-model", bucket_start: "2026-08-18T11:45:00.000Z" }),
      codexRow({ model_id: "a-model", bucket_start: "2026-08-18T11:30:00.000Z" }),
    ],
  }), { now });

  assert.equal(result.installation_id, "install-019f");
  assert.deepEqual(result.rows.map((row) => row.model_id), ["a-model", "z-model"]);
  assert.deepEqual(Object.keys(result).sort(), ["batch_id", "client_version", "installation_id", "rows"]);
  assert.equal(result.client_version, null, "a reporter predating client_version still normalizes");
  assert.equal(result.rows[0].model_id, "a-model");
});

test("rejects unknown batch and row fields", () => {
  assert.throws(
    () => normalizeTokenUsageBatch({ ...validBody(), hub_user_email: "spoof@stardust.ai" }, { now }),
    /unknown field/i,
  );
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: [codexRow({ prompt: "private" })] }), { now }),
    /unknown field/i,
  );
});

test("requires canonical quarter-hour buckets within the accepted window", () => {
  for (const bucket_start of [
    "2026-08-18T11:46:00.000Z",
    "2026-08-18T11:45:00Z",
    "2026-08-18T19:45:00.000+08:00",
    "2026-08-18T12:15:00.000Z",
    "2026-05-19T11:45:00.000Z",
  ]) {
    assert.throws(
      () => normalizeTokenUsageBatch(validBody({ rows: [codexRow({ bucket_start })] }), { now }),
      TokenUsageValidationError,
      bucket_start,
    );
  }
});

test("validates row count, identifiers, provider, and non-negative safe counters", () => {
  assert.throws(() => normalizeTokenUsageBatch(validBody({ rows: [] }), { now }), /rows/i);
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: Array.from({ length: 401 }, () => codexRow()) }), { now }),
    /rows/i,
  );
  for (const row of [
    codexRow({ provider: "other" }),
    codexRow({ model_id: " " }),
    codexRow({ model_account_id: "bad\naccount" }),
    codexRow({ input_tokens: -1 }),
    codexRow({ output_tokens: 1.5 }),
    codexRow({ total_tokens: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    assert.throws(() => normalizeTokenUsageBatch(validBody({ rows: [row] }), { now }));
  }
});

test("keeps Codex cache and reasoning as subsets of total", () => {
  const normalized = normalizeTokenUsageBatch(validBody(), { now });
  assert.equal(normalized.rows[0].total_tokens, 150);
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: [codexRow({ cache_read_tokens: 121 })] }), { now }),
    /cache_read_tokens/i,
  );
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: [codexRow({ reasoning_tokens: 31 })] }), { now }),
    /reasoning_tokens/i,
  );
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: [codexRow({ total_tokens: 230 })] }), { now }),
    /total_tokens/i,
  );
});

test("requires Claude total to include input, output, cache read, and cache write", () => {
  const claude = codexRow({
    provider: "claude",
    model_id: "claude-opus-4-1",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 40,
    reasoning_tokens: 0,
    total_tokens: 100,
  });
  assert.equal(normalizeTokenUsageBatch(validBody({ rows: [claude] }), { now }).rows[0].total_tokens, 100);
  assert.throws(
    () => normalizeTokenUsageBatch(validBody({ rows: [{ ...claude, total_tokens: 60 }] }), { now }),
    /total_tokens/i,
  );
});

test("parses exact query parameters, repeated filters, and a public echo", () => {
  const query = parseTokenUsageQuery(
    "/api/token-usage-query?start=2026-08-11T12%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=hour&group_by=hub_user&metric=total&hub_user=derek%40stardust.ai&hub_user=member%40stardust.ai&provider=codex&model_account=ir%40stardust.ai&model=gpt-5.6-sol",
    { now },
  );

  assert.deepEqual(query.hubUsers, ["derek@stardust.ai", "member@stardust.ai"]);
  assert.deepEqual(query.providers, ["codex"]);
  assert.deepEqual(query.modelAccounts, ["ir@stardust.ai"]);
  assert.deepEqual(query.models, ["gpt-5.6-sol"]);
  assert.equal(query.groupBy, "hub_user");
  assert.deepEqual(query.publicQuery, {
    start: "2026-08-11T12:00:00.000Z",
    end: "2026-08-18T12:00:00.000Z",
    granularity: "hour",
    group_by: "hub_user",
    metric: "total",
    hub_users: ["derek@stardust.ai", "member@stardust.ai"],
    providers: ["codex"],
    model_accounts: ["ir@stardust.ai"],
    models: ["gpt-5.6-sol"],
  });
});

test("rejects duplicate singleton, unknown, invalid-range, and oversized query parameters", () => {
  const base = "start=2026-08-11T12%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=hour&group_by=hub_user&metric=total";
  for (const suffix of [
    "&metric=input",
    "&unknown=value",
    "&provider=other",
    "&group_by=installation",
    "&model=%20",
  ]) {
    assert.throws(() => parseTokenUsageQuery(`/api/token-usage-query?${base}${suffix}`, { now }));
  }

  assert.throws(() => parseTokenUsageQuery(
    "/api/token-usage-query?start=2026-08-18T12%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=15m&group_by=model&metric=input",
    { now },
  ), /start/i);
  assert.throws(() => parseTokenUsageQuery(
    "/api/token-usage-query?start=2026-05-01T00%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=15m&group_by=model&metric=input",
    { now },
  ), /90 days/i);

  const tooManyFilters = Array.from({ length: 26 }, (_, index) => `model=model-${index}`).join("&");
  assert.throws(
    () => parseTokenUsageQuery(`/api/token-usage-query?${base}&${tooManyFilters}`, { now }),
    /too many/i,
  );
});

test("allows daily queries older than the 90-day detail window", () => {
  const query = parseTokenUsageQuery(
    "/api/token-usage-query?start=2026-01-01T00%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=day&group_by=provider&metric=cache_write",
    { now },
  );
  assert.equal(query.granularity, "day");
  assert.equal(query.metric, "cache_write");
});

test("accepts an optional client_version so the server can gate on reporter age", () => {
  const result = normalizeTokenUsageBatch(validBody({ client_version: " 2.1.0 " }), { now });
  assert.equal(result.client_version, "2.1.0");
});

test("rejects a malformed client_version rather than storing junk", () => {
  for (const value of [42, "", "x".repeat(33), "2.1\u00000"]) {
    assert.throws(
      () => normalizeTokenUsageBatch(validBody({ client_version: value }), { now }),
      TokenUsageValidationError,
      `client_version ${JSON.stringify(value)} must be rejected`,
    );
  }
});
