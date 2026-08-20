# Quota Full Browser Notification Design

## Goal

When a coding account's quota window recovers to 100% while the dashboard tab is open, show a browser (Web Notification API) popup so the viewer notices without watching the table.

## Scope

Main dashboard (`index.html`) only — this is the only page that renders per-account quota windows. No changes to `token-usage.html`, `users.html`, or any API/database.

## Trigger condition

A notification fires when either tracked window for an account transitions from `< 100` to `>= 100`:

- `5h` window (Claude accounts; Codex accounts have no 5h window and are skipped for this key)
- `1week` window (both providers)

All accounts currently in the active table are watched — not just ones the viewer uploaded.

A window only counts as a valid reading when:

- `display_windows_stale ?? windows_stale` is falsy for the item (not stale/historical data)
- the window has a non-null `remaining_percent`
- the window has no `reset_unavailable_reason`

Stale, missing, or unavailable readings are skipped entirely — they neither update tracked state nor trigger a notification.

## State tracking

An in-memory `Map` (`quotaFullNotifyState`), keyed `${source}:${account_id}:${windowKey}`, holds the last valid `remaining_percent` seen for that account/window. On each dashboard load:

1. For every valid window reading, look up the previous value.
2. Store the new value (overwriting the previous one).
3. If a previous value existed and was `< 100`, and the new value is `>= 100`, fire a notification.
4. After processing all current items, drop every map entry whose `source:account_id` is not present in this load's `items` (both the `5h` and `1week` keys for that account).

No previous value (first load, first valid reading for that account/window, or the account's first reading after reappearing) never fires — this prevents notifying for accounts that are already full when the page opens. It also means an account that disappears from the active table (archived, invalidated, temporarily absent) and later reappears is treated as a fresh baseline: even if it comes back already at 100%, that alone does not fire, because step 4 erased what we knew about it while it was gone and we cannot tell whether it was already full or just recovered during the gap. A notification only fires again once a subsequent load observes a `<100 → 100` transition while the account stays continuously present. State is process-local to the tab and resets on reload; this is a live-tab alert, not a persisted log.

## Integration point

The check runs once per dashboard refresh, inside `loadDashboard()` in `index.html`, right after `items` is computed from the `/api/status` payload. `loadDashboard()` is the single function invoked by both the initial `load()` and every revision-triggered refresh (`checkDashboardRevision`, polled every `DASHBOARD_REFRESH_MS` while the tab is visible), so no separate polling loop is introduced. Because `checkDashboardRevision` only polls while `document.visibilityState === "visible"`, the tab must remain the active tab in its window (it does not need OS focus) for a recovery to be detected promptly.

## Permission

On dashboard init, if `"Notification" in window` and `window.Notification.permission === "default"`, call `window.Notification.requestPermission()` once (errors swallowed). Notifications are only constructed when `window.Notification.permission === "granted"`. All Notification access goes through the `window` global (never a bare `Notification` reference) so the code degrades to a silent no-op in any environment without the API, including the existing test harness's `window` mock.

## Notification content

- **Title**: identifies the account — email (or account_id if no email) plus source, e.g. `alice@example.com (claude) quota is back to 100%`.
- **Body**: which window recovered, e.g. `5h window full` or `1week window full`.
- **tag**: the same `${source}:${account_id}:${windowKey}` state key, so the OS notification center coalesces repeat events for the same account/window instead of stacking duplicates.
- **onclick**: calls `window.focus()` to bring the dashboard tab forward.

## Error handling

Notification construction and `requestPermission()` are wrapped so a browser exception (e.g. permission revoked mid-session, disallowed context) cannot break dashboard rendering or the refresh loop.

## Testing

Extend the existing `vm`-based dashboard test harness (`tests/dashboard-refresh-behavior.test.mjs` or a new file) with a mock `Notification` constructor/`requestPermission` on the harness's `window` object, and verify via `/api/status` payload sequences that:

- a window moving from `<100` to `100` across two loads fires exactly one notification with the expected title/body/tag;
- an account already at 100% on first load does not fire a notification;
- a stale, missing, or `reset_unavailable_reason` reading neither updates state nor fires;
- a window moving between two values both `<100` (e.g. 40% → 60%) does not fire;
- Codex accounts (no `5h` window) do not throw and are only evaluated on `1week`;
- an account that drops out of `items` on one load and reappears already at 100% on a later load does not fire (its prior state was cleared while absent);
- an account that drops out and reappears below 100%, then on a subsequent load reaches 100%, does fire (fresh baseline established, then a genuine transition observed);
- running the existing dashboard suite with no `Notification` on the harness `window` (current default) still passes unchanged.
