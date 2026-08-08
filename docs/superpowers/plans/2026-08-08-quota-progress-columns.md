# Quota Progress Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore legacy 5H and 1week progress columns while retaining Availability, details, auto-refresh, and low-read polling.

**Architecture:** Reuse the existing `display_windows` data and restore a focused progress-cell renderer in `index.html`. Keep the lifecycle model and API unchanged; only active-table presentation and its tests change.

**Tech Stack:** Static HTML/CSS/JavaScript, Node.js test runner.

---

### Task 1: Restore quota progress columns

**Files:**
- Modify: `tests/dashboard-static.test.mjs`
- Modify: `tests/dashboard-refresh-behavior.test.mjs`
- Modify: `index.html`

- [ ] **Step 1: Write failing presentation tests**

Add assertions that the active table headers are `Source`, `Account & Uploader`, `5H (Claude)`, `1week`, `Fetched By`, and `Availability`; that current windows render `.progress`, `.track`, `.fill`, the percentage, and reset countdown; that stale windows use gray styling; and that a missing Codex 5H window renders `n/a`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/dashboard-static.test.mjs tests/dashboard-refresh-behavior.test.mjs`

Expected: failures for missing headers and progress-cell markup.

- [ ] **Step 3: Implement the legacy progress renderer**

Restore the legacy progress CSS and `progressCell(window, isStale)` behavior in `index.html`. Render `display_windows["5h"]` and `display_windows["1week"]` before Fetched By, retain the Availability trigger, scope six-column widths to `#active-entries-table`, and keep the archived table rules independent.

- [ ] **Step 4: Verify focused and full tests**

Run:

```bash
node --test tests/dashboard-static.test.mjs tests/dashboard-refresh-behavior.test.mjs
npm test
git diff --check
```

Expected: all tests pass and the diff check is clean.

- [ ] **Step 5: Commit and deploy**

Commit the tests, UI, spec, and plan; push `main`; wait for the Vercel production deployment tied to the commit; read back the production HTML and verify both progress headers and Availability are present.
