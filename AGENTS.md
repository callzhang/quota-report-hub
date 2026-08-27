# AGENTS.md — working rules for this repo

Project-scoped rules. They add to `~/.agents/AGENT.md` and win where they conflict, inside this
repository only.

## The reference document

[`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) is the canonical description of how this system works — every
component, every load-bearing decision, and the reasoning behind it.
[`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) covers why/what; [`AUTH_TOKENS.md`](AUTH_TOKENS.md) covers
the provider credential formats and lanes in detail.

1. **Read before you write.** Before changing anything, read the `SYSTEM_DESIGN.md` section covering
   that area. Its contents table maps sections to areas. Most of the traps in this codebase are
   already written down there; rediscovering them from the code costs hours and often ends in a
   wrong conclusion (see §11's codex access-token pitfall for a real one).
2. **Cite it instead of re-explaining it.** In a plan, a PR body, or an answer, point at the section
   (`SYSTEM_DESIGN.md §7.2`) rather than restating it.
3. **Update it in the same commit.** Any change to behaviour the document describes updates the
   document too — same commit, not a follow-up. A section that no longer matches the code is worse
   than no section: the whole value is that a reader can trust it without re-deriving it.
4. **New component, new section.** Appending a numbered section is fine; renumbering existing ones
   breaks every inbound anchor, so don't. Keep the contents table in sync.
5. **Prose is the claim, `file:line` is a hint.** Citations drift as code moves. Fix them when you
   are in the area; never let a stale line number stop you from trusting the prose, and never let a
   correct line number substitute for explaining *why*.

## Commands

```bash
npm test                  # node --test over tests/*.test.mjs
python3 -m pytest tests -q
```

Both suites pass before any commit. There is no lint step and no build step; `api/**` and `lib/**`
are plain ESM run by Vercel, the client is plain Python 3.

## How code is written here

- **Explain the why, not the what.** Comments in this repo carry the reasoning that is not
  recoverable from the code — why a threshold is that number, what a rule is protecting against,
  what was tried and rejected. Match that. A comment restating the line below it is noise.
- **No fallback paths, no legacy branches, no compatibility shims.** Change the logic and delete what
  it replaced. If two code paths do the same thing, one of them is a bug waiting to be found.
- **No patch-shaped fixes.** Find the root cause; do not add an `if` to make a test pass or a regex
  to paper over a data shape. No hardcoded keyword lists or static string enumerations where a
  structural signal exists.
- **Simplicity first.** The minimum code that solves the actual problem, nothing speculative.
- **Every bug fix ships a regression test** that fails before the fix and passes after it. Narrowest
  useful level first.
- **Keep the policy layer pure.** `lib/premium-ratio.js` and friends take every input — including
  `now` — as arguments. Anything that reaches for a clock, a database, or `process.env` inside a
  decision function makes it untestable; move that to the caller.

## Invariants that are easy to break

- **Never let a stripped credential overwrite a pooled one.** The AT-only placeholder poison guard
  (§6.2) is what keeps the shared refresh token alive. Any new upload path goes through
  `upsertAuthPoolEntry`.
- **One refresher.** Under `disabled_refresh_token`, the hub is the sole party that may rotate a
  pooled refresh token (§9). Do not add a client-side refresh of a pooled credential.
- **Only a notice reaches the user.** The client renders `notices[]` and nothing else — a `message`
  field on a response is invisible. Anything a person needs to read is a notice with a `code`, a
  `title` and a `repeat_seconds` (§9b).
- **Client-visible changes are phased, not hot.** Clients self-update from `main` on their next
  15-minute run, so a protocol change stays backward-compatible for at least a cycle and any new
  enforcement goes behind a phase date with a live kill-switch flag (§9b, §17.3).
- **Rationing rules fire only during scarcity.** Throttling an abundant pool is pure friction; a
  broken scarcity cron must fail *open* (§9b).
- **Escape every server string rendered into markup.** All dashboards use `escapeHtml`; keep it that
  way (§14.4).
- **Never log, echo, or commit a credential.** Auth blobs, refresh tokens, API tokens (stored
  hash-only), `.env*`. Error responses use `sendServiceUnavailable` rather than echoing internals.

## Working against production data

Read-only queries against the production Turso database are fine and are often the fastest way to
size a decision — prefer real numbers over reasoning about hypothetical users, and put the numbers
in the commit message or the design section so the next reader can check the sizing.

Writes, deletions, and migrations are not routine: back up first, run a small batch, verify the
result matches the expectation (not merely that the call succeeded), and only then run the rest.

## Commits

One feature or fix per commit. The subject line says what changed and, where it fits, why — the
existing log is the style guide (`fix: stop counting context compaction as a session restart`). The
body carries the reasoning and the evidence a reviewer would otherwise have to reconstruct.
