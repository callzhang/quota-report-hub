// What each model costs, and which ones the shared pool actually pays for.
//
// Prices are USD per 1M tokens from the vendors' public rate cards, and only their RATIOS matter:
// the pool runs on subscriptions, not API billing. OpenAI's own price-cut announcement says the
// Terra/Luna reductions "are also reflected in how usage is counted against paid subscriptions when
// using Codex and ChatGPT Work" -- subscription credit burn tracks API pricing, so the rate card is
// a sound proxy for how fast a model drains a pooled account.
//
// Standard rates only. GPT-5.6 Sol is discounted >20% until roughly November 2026; this is a
// long-lived rationing mechanism and must not drift with a three-month promotion.
//
// Sources: developers.openai.com/api/docs/pricing, the claude-api skill's model table (2026-06-24).
const PRICES = Object.freeze({
  "gpt-5.6-sol":         { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 30.00 },
  "gpt-5.6":             { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 30.00 },
  "gpt-5.6-terra":       { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 12.00 },
  "gpt-5.6-luna":        { input: 0.20, cache_read: 0.02, cache_write: 0.25, output: 1.20 },
  "gpt-5.5":             { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 30.00 },
  "gpt-5.4":             { input: 2.50, cache_read: 0.25, cache_write: 3.13, output: 15.00 },
  "gpt-5.4-mini":        { input: 0.75, cache_read: 0.08, cache_write: 0.94, output: 4.50 },
  "gpt-5.3-codex-spark": { input: 1.75, cache_read: 0.18, cache_write: 2.19, output: 14.00 },
  // OpenAI's rate card still bills Codex code review at the gpt-5.3-codex rate.
  "codex-auto-review":   { input: 1.75, cache_read: 0.18, cache_write: 2.19, output: 14.00 },
  "claude-opus-5":       { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
  "claude-fable-5":      { input: 10.00, cache_read: 1.00, cache_write: 12.50, output: 50.00 },
  "claude-sonnet-5":     { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
});

// A model reached through somebody's own API key or a self-hosted box costs the pool nothing, so it
// adds nothing to demand -- DeepSeek and self-hosted Qwen included. That is not a loophole, it is
// the point: moving work off the pool is exactly the behaviour rationing is meant to encourage.
//
// The risk is a NEW pooled model nobody has priced yet reading as free. Family prefixes close that:
// an unrecognised member of a pooled family is charged that family's top rate, because a new model
// in a live family is far more likely to be a flagship than a bargain tier.
const POOLED_FAMILIES = Object.freeze([
  { prefix: "gpt-", fallback: "gpt-5.6-sol" },
  { prefix: "claude-", fallback: "claude-fable-5" },
  { prefix: "codex-", fallback: "codex-auto-review" },
]);

// Which models earn the "you are burning the expensive stuff" nudge. A blacklist, not an allow-list:
// this only drives a notice now, never a refusal, so a miss costs one missing hint rather than a
// wrongly throttled user. Cost, not membership here, is what decides who gets held back.
export const PREMIUM_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6",
  "claude-opus-5",
  "claude-fable-5",
]);

// What the notices tell people to switch to. A test asserts these are priced below every premium
// model -- advice that recommends something equally expensive is worse than no advice.
export const SUGGESTED_STANDARD_MODEL_IDS = Object.freeze(["gpt-5.6-terra", "claude-sonnet-5"]);

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
  const freshInput = Math.max(0, Number(counters?.input_tokens || 0) - Number(counters?.cache_read_tokens || 0));
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
    MAX(0, input_tokens - cache_read_tokens) * (${priceCase("input")})
    + cache_read_tokens * (${priceCase("cache_read")})
    + cache_write_tokens * (${priceCase("cache_write")})
    + output_tokens * (${priceCase("output")})
  ) / 1000000.0`;
}
