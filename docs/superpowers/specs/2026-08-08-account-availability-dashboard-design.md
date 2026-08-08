# Account Availability Dashboard Design

## Goal

Make each auth-pool row answer the operator's primary question first: **can this account be used for rotation now?** Preserve probe, token, quota, and refresh evidence as secondary diagnostics without presenting historical success as current availability.

The dashboard must remain responsive while reducing database reads relative to polling the complete `/api/status` payload every minute.

## Primary state model

Each account has exactly one prominent state:

| State | Condition | Primary message |
| --- | --- | --- |
| `AVAILABLE` | Current quota is usable and meets the source-specific sharing threshold | Current remaining quota and reset countdown |
| `LOW QUOTA` | Current quota is usable but below the sharing threshold | Current remaining quota and `not eligible for rotation` |
| `WAITING FOR NEW QUOTA` | The latest quota window reset and no post-reset snapshot exists | Age of the expired snapshot and next automatic check |
| `QUOTA UNKNOWN` | The latest probe did not provide a complete usable quota window | Concrete missing or unusable evidence |
| `UNAVAILABLE` | Refresh rejected, auth invalidated, access cannot be recovered, or account is ineligible | Concrete reason and required owner action |

Precedence is:

1. `UNAVAILABLE`
2. `WAITING FOR NEW QUOTA`
3. `QUOTA UNKNOWN`
4. `LOW QUOTA`
5. `AVAILABLE`

A successful probe alone never produces `AVAILABLE`. Availability requires a currently valid quota snapshot that meets the applicable threshold.

## Row presentation

The collapsed row shows only:

- primary state;
- current quota and reset countdown when current quota exists;
- otherwise, the concise reason the current quota is unavailable.

Examples:

```text
AVAILABLE
99% weekly quota - resets in 6d 20h
```

```text
WAITING FOR NEW QUOTA
Previous quota window reset 8m ago
```

```text
UNAVAILABLE
Refresh token rejected - owner must log in again
```

The existing parallel `Probe`, `Token`, `Quota`, and `Refresh` status lines move out of the collapsed row.

## Detail popover

Hovering or keyboard-focusing a row opens a detail popover. On touch devices, tapping the state opens the same popover; tapping outside or pressing Escape closes it.

The popover contains:

1. Current availability conclusion and reason.
2. Latest quota snapshot:
   - 5-hour and/or weekly remaining quota as applicable;
   - exact capture time;
   - reset time;
   - explicit `Historical - not current quota` treatment when expired or invalidated.
3. A 24-hour quota chart:
   - separate source-appropriate series;
   - exact timestamps available on point hover/focus;
   - reset boundaries marked when derivable;
   - expired/historical portions shown in gray;
   - gaps remain gaps and are never interpolated as known quota.
4. Diagnostics:
   - last probe result and time;
   - token upload time;
   - access-token expiry when known;
   - refresh state and last actual refresh check time.

## Data model and API

### Current account state

The existing status assembly remains the source of current account data. A pure state-derivation function converts each annotated item into the primary state, reason, tone, and current quota summary. This function is shared by rendering tests and contains no DOM or database logic.

### Lightweight change detection

The browser must not fetch the complete dashboard every minute.

Add a singleton dashboard revision record containing a monotonically increasing revision and update timestamp. Any write that changes dashboard-visible current state increments the revision in the same logical operation, including:

- auth upload or deletion;
- latest quota update;
- invalidation recovery or rejection;
- feature-flag update;
- health snapshot update;
- fetch activity that changes displayed fetch ownership.

Add an authenticated lightweight endpoint that returns only the revision and timestamp. The browser checks it every minute while visible and immediately on visibility regain. It fetches full `/api/status` only when:

- no dashboard has been loaded yet;
- the revision differs from the last loaded revision;
- the user explicitly requests a retry after an error.

The lightweight endpoint performs one bounded singleton read. Full status keeps its existing bounded current-state reads and never scans quota history.

### Quota history

Add an authenticated account-scoped endpoint accepting exact `source` and `account_id`. It returns only events from the previous 24 hours, ordered chronologically, with a strict maximum point count.

The query uses the existing `(source, account_id, reported_at DESC)` index. It must require all three constraints:

- exact source;
- exact account ID;
- `reported_at` lower bound of 24 hours.

It must never expose encrypted auth material, access tokens, refresh tokens, or unrelated accounts.

## Read-pressure controls

1. Full status is revision-driven, not timer-driven.
2. The one-minute timer performs one singleton revision read only while the tab is visible.
3. Returning to the tab performs the same revision check unless a server-supplied time-derived state deadline passed while hidden; in that case it performs one full status load.
4. History is fetched only when the detail popover is first opened for an account.
5. Browser history results are cached per `source + account_id` for five minutes.
6. Only one history request per account may be in flight at a time.
7. History responses are capped and reduced to the smallest chart-safe representation.
8. Closing and reopening a popover within the cache window performs no database read.
9. Current-state endpoints remain independent of the append-only history table.
10. Database-read static tests prevent full status, candidate selection, and routine ingestion from scanning history.

Availability responses expose the earliest time at which the conclusion can change without a database write (report freshness, quota reset, or access expiry). The visible browser schedules one bounded full refresh for that deadline, preserving cheap revision polling at all other times.

## Error behavior

- Revision-check failure preserves current rows and retries on the next interval.
- Full-status failure preserves the last rendered state and never displays login unless the response is explicitly `401`.
- History failure leaves the main state intact and shows `History temporarily unavailable` inside the popover.
- An explicit `401` follows the existing login recovery flow.
- Missing history is shown as `No quota history in the last 24 hours`, not as zero quota.

## Accessibility

- State is conveyed by text and icon as well as color.
- Popovers open by pointer, keyboard focus, and touch.
- Escape closes the popover and returns focus to its trigger.
- Chart points expose timestamp and value as accessible text; the latest snapshot remains readable without interpreting the chart.

## Testing

Automated coverage must include:

- every primary-state transition and precedence rule;
- successful probe plus expired quota produces `WAITING FOR NEW QUOTA`, never `AVAILABLE`;
- successful probe plus missing quota produces `QUOTA UNKNOWN`;
- valid below-threshold quota produces `LOW QUOTA`;
- revision unchanged skips full status;
- revision changed triggers one full status request;
- hidden tabs perform no polling;
- visibility regain performs a revision check;
- history is lazy, account-scoped, 24-hour bounded, capped, cached, and deduplicated in flight;
- historical quota includes capture/reset timestamps and cannot be rendered as current;
- transient errors preserve the current dashboard and do not show login;
- `401` still shows login.

## Out of scope

- Triggering a provider probe from the browser.
- Forcing refresh-token rotation to remove an untested state.
- More than 24 hours of chart history.
- Predicting post-reset quota before a new probe supplies evidence.
