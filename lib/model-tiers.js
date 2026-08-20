// Which models count toward the premium share of a user's usage.
//
// The list is deliberately an allow-list of NON-premium models, not a list of premium ones.
// A model id the hub has never seen is far more likely to be a new flagship than a new budget
// tier, and guessing "cheap" opens a loophole that stays open until somebody notices the bill.
// Guessing "premium" costs one line in STANDARD_MODEL_IDS and a complaint.
export const PREMIUM_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "claude-opus-5",
  "claude-fable-5",
]);

export const STANDARD_MODEL_IDS = Object.freeze([
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "codex-auto-review",
  "claude-sonnet-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

const STANDARD_SET = new Set(STANDARD_MODEL_IDS);

export function normalizeModelId(modelId) {
  return String(modelId ?? "").trim().toLowerCase();
}

export function isPremiumModel(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return false;
  }
  return !STANDARD_SET.has(normalized);
}
