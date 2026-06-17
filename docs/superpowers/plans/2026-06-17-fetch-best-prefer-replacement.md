# Fetch Best Prefer Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/auth/fetch-best` serve a healthy shared replacement before returning the requester's invalidated auth for repair.

**Architecture:** Keep the handler API unchanged. Move the "no healthy upload from requester" gate so the handler first attempts normal `bestAuthPoolEntry` selection; only if no replacement exists should it return `repair_auth` or `must_upload_auth_to_pool`.

**Tech Stack:** Vercel-style Node API route, libsql test database, Node built-in test runner.

---

### Task 1: Regression Test

**Files:**
- Modify: `tests/fetch-best-handler.test.mjs`

- [ ] **Step 1: Add a failing test**

Add a test where the requester has an invalidated uploaded auth and no healthy upload of their own, while another uploader has a healthy auth. The expected response is `replacement` for the healthy account and no `repair_auth`.

- [ ] **Step 2: Run the targeted test**

Run: `node --test tests/fetch-best-handler.test.mjs`

Expected before implementation: FAIL because the current handler returns `repair_auth` when the requester has no healthy uploaded auth.

### Task 2: Handler Behavior

**Files:**
- Modify: `api/auth/fetch-best.js`

- [ ] **Step 1: Prefer replacement**

Move the requester upload gate after the normal `bestAuthPoolEntry` lookup. The new order is:

1. Handle `refresh_current` same-account refresh.
2. Try `bestAuthPoolEntry`.
3. If a replacement exists, return it.
4. If no replacement exists and the requester has no healthy upload, return `repair_auth` or `must_upload_auth_to_pool`.
5. Otherwise return `no_better_auth_available`.

- [ ] **Step 2: Preserve audit reasons**

Keep normal successful replacement fetches recorded as `served`. Keep repair handback recorded as `repair_returned`, and no-upload blocking as `no_uploaded_auth`.

### Task 3: Verification

**Files:**
- Test: `tests/fetch-best-handler.test.mjs`
- Test: full test suite

- [ ] **Step 1: Run targeted tests**

Run: `node --test tests/fetch-best-handler.test.mjs`

Expected after implementation: PASS.

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected after implementation: PASS.
