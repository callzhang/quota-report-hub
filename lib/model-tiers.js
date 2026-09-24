// What each model costs, and which ones the shared pool actually pays for.
//
// Prices are USD per 1M tokens from the vendors' public rate cards, and only their RATIOS matter:
// the pool runs on subscriptions, not API billing. OpenAI's own price-cut announcement says the
// Terra/Luna reductions "are also reflected in how usage is counted against paid subscriptions when
// using Codex and ChatGPT Work" -- subscription credit burn tracks API pricing, so the rate card is
// a sound proxy for how fast a model drains a pooled account.
//
// Current rates, promotions included: the spend column and the demand shares should read what the
// pool is burning today. GPT-5.6 Sol's $4/$20 is promotional through at least 2026-11-21; when it
// ends, its row moves back to the $5/$30 list rate. GPT-6 Sol and Luna launched on 2026-09-22 at
// half GPT-5.6 Sol's promotional rates, and OpenAI states that price is permanent.
//
// Sources, checked 2026-09-24: developers.openai.com/api/docs/pricing and its gpt-6-sol / gpt-6-luna
// model pages (cache writes are 1.25x input on every OpenAI model), and
// platform.claude.com/docs/en/about-claude/pricing (5-minute cache writes).
const PRICES = Object.freeze({
  "gpt-6-astra":         { input: 10.00, cache_read: 1.00, cache_write: 12.50, output: 50.00 },
  "gpt-6-sol":           { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
  "gpt-6-luna":          { input: 0.10, cache_read: 0.01, cache_write: 0.125, output: 0.50 },
  "gpt-5.6-sol":         { input: 4.00, cache_read: 0.40, cache_write: 5.00, output: 20.00 },
  "gpt-5.6":             { input: 4.00, cache_read: 0.40, cache_write: 5.00, output: 20.00 },
  "gpt-5.6-terra":       { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 12.00 },
  "gpt-5.6-luna":        { input: 0.20, cache_read: 0.02, cache_write: 0.25, output: 1.20 },
  // Codex's "Luna Reserve" fallback: a separately metered allowance that runs GPT-5.6 Luna once the
  // regular one is spent. OpenAI publishes no price for it, so it is charged as the model it runs.
  "gpt-reserve":         { input: 0.20, cache_read: 0.02, cache_write: 0.25, output: 1.20 },
  "gpt-5.5":             { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 30.00 },
  "gpt-5.4":             { input: 2.50, cache_read: 0.25, cache_write: 3.125, output: 15.00 },
  "gpt-5.4-mini":        { input: 0.75, cache_read: 0.075, cache_write: 0.9375, output: 4.50 },
  "gpt-5.3-codex-spark": { input: 1.75, cache_read: 0.175, cache_write: 2.1875, output: 14.00 },
  // OpenAI's rate card still bills Codex code review at the gpt-5.3-codex rate.
  "codex-auto-review":   { input: 1.75, cache_read: 0.175, cache_write: 2.1875, output: 14.00 },
  "claude-fable-5-1":    { input: 10.00, cache_read: 0.25, cache_write: 12.50, output: 50.00 },
  "claude-fable-5":      { input: 10.00, cache_read: 1.00, cache_write: 12.50, output: 50.00 },
  "claude-opus-5-5":     { input: 4.00, cache_read: 0.20, cache_write: 5.00, output: 20.00 },
  "claude-opus-5":       { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
  "claude-opus-4-8":     { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
  "claude-sonnet-5":     { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
  // Claude Code reports Haiku 4.5 by its dated snapshot id, which is the model's canonical API id.
  "claude-haiku-4-5-20251001": { input: 1.00, cache_read: 0.10, cache_write: 1.25, output: 5.00 },
});

// A model reached through somebody's own API key or a self-hosted box costs the pool nothing, so it
// adds nothing to demand -- DeepSeek and self-hosted Qwen included. That is not a loophole, it is
// the point: moving work off the pool is exactly the behaviour rationing is meant to encourage.
//
// The risk is a NEW pooled model nobody has priced yet reading as free. Family prefixes close that:
// an unrecognised member of a pooled family is charged that family's top rate, because a new model
// in a live family is far more likely to be a flagship than a bargain tier.
const POOLED_FAMILIES = Object.freeze([
  { prefix: "gpt-", fallback: "gpt-6-astra" },
  { prefix: "claude-", fallback: "claude-fable-5" },
  { prefix: "codex-", fallback: "codex-auto-review" },
]);

// Which models earn the "you are burning the expensive stuff" nudge. A blacklist, not an allow-list:
// this only drives a notice now, never a refusal, so a miss costs one missing hint rather than a
// wrongly throttled user. Cost, not membership here, is what decides who gets held back.
export const PREMIUM_MODEL_IDS = Object.freeze([
  // The first two are what the notice names as examples, so they are the premium models people
  // actually run most (2026-09-24, 30 days: 5.6 Sol 83B tokens, 6 Astra 17B).
  "gpt-5.6-sol",
  "gpt-6-astra",
  "gpt-5.6",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
]);

// What the notices tell people to switch to. A test asserts these are priced below every premium
// model -- advice that recommends something equally expensive is worse than no advice.
export const SUGGESTED_STANDARD_MODEL_IDS = Object.freeze(["gpt-6-luna", "claude-sonnet-5"]);

const PREMIUM_SET = new Set(PREMIUM_MODEL_IDS);

export function normalizeModelId(modelId) {
  return String(modelId ?? "").trim().toLowerCase();
}

export function isPremiumModel(modelId) {
  return PREMIUM_SET.has(normalizeModelId(modelId));
}

// Null for anything the pool does not pay for, so callers can tell "free" from "priced at zero".
export function modelPrice(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return null;
  if (PRICES[normalized]) return PRICES[normalized];
  const family = POOLED_FAMILIES.find((entry) => normalized.startsWith(entry.prefix));
  return family ? PRICES[family.fallback] : null;
}

export function pricedModelIds() {
  return Object.keys(PRICES);
}

// Dollars per 1M tokens of each kind, so one table covers both the model tier and the token type.
// The previous formula weighted output at 1x input; every real rate card puts it at 5-6x, which
// systematically under-counted exactly the agent-fleet workloads this is meant to catch.
export function modelCost(modelId, counters) {
  const price = modelPrice(modelId);
  if (!price) return 0;
  // Cache read and cache write are both subsets of input, each with its own price; only what is left
  // is fresh input. Subtracting only the reads would bill every cache write twice.
  const freshInput = Math.max(
    0,
    Number(counters?.input_tokens || 0) - Number(counters?.cache_read_tokens || 0) - Number(counters?.cache_write_tokens || 0),
  );
  return (
    freshInput * price.input +
    Number(counters?.cache_read_tokens || 0) * price.cache_read +
    Number(counters?.cache_write_tokens || 0) * price.cache_write +
    Number(counters?.output_tokens || 0) * price.output
  ) / 1_000_000;
}

// The same arithmetic as SQL, so the gate and any dashboard cannot drift apart.
export function modelCostSql() {
  const priceCase = (field) => [
    "CASE",
    ...Object.entries(PRICES).map(([id, price]) => `WHEN model_id = '${id}' THEN ${price[field]}`),
    ...POOLED_FAMILIES.map((entry) => `WHEN model_id LIKE '${entry.prefix}%' THEN ${PRICES[entry.fallback][field]}`),
    "ELSE 0 END",
  ].join(" ");
  return `(
    MAX(0, input_tokens - cache_read_tokens - cache_write_tokens) * (${priceCase("input")})
    + cache_read_tokens * (${priceCase("cache_read")})
    + cache_write_tokens * (${priceCase("cache_write")})
    + output_tokens * (${priceCase("output")})
  ) / 1000000.0`;
}
