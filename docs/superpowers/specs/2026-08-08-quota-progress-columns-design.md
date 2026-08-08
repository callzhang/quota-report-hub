# Quota Progress Columns Design

## Goal

Restore the useful legacy `5H (Claude)` and `1week` quota progress columns in the active account table without removing the newer availability lifecycle, details popover, automatic refresh, session restoration, or low-read revision polling.

## Active table

The active table uses these columns, in order:

1. `Source`
2. `Account & Uploader`
3. `5H (Claude)`
4. `1week`
5. `Fetched By`
6. `Availability`

The archived-invalidated table keeps its existing independent layout.

## Progress cells

Each available quota window reuses the legacy presentation:

- a horizontal progress track and fill;
- the exact remaining percentage;
- green, amber, or red severity coloring using the existing thresholds;
- a reset countdown below the bar;
- gray styling and an explicit stale or historical label when the evidence is not current.

Unavailable windows show the existing precise reason where possible, otherwise `n/a`. Codex must show `n/a` for `5H` when no current Codex 5-hour window exists; the UI must not infer or fabricate one.

Progress bars are display-only. The `Availability` column remains the authoritative lifecycle conclusion and keeps its hover, focus, and touch details popover with exact timestamps and 24-hour history.

## Responsive behavior

The table keeps usable minimum widths for both progress columns. On narrow screens the existing table shell scrolls horizontally instead of squeezing bars or hiding the Availability control. Active and archived table widths remain scoped independently.

## Data and refresh behavior

No API or database changes are required. The progress columns render the existing `display_windows` returned by full status loads. They do not trigger history requests and do not change revision polling, time-derived refresh deadlines, authentication, or session restoration.

## Testing

Tests must verify:

- the active header contains both quota columns in the approved order;
- current windows render legacy progress tracks, percentages, severity colors, and reset countdowns;
- stale or historical windows render gray;
- a missing Codex 5H window renders `n/a`;
- Availability remains present and retains the details trigger;
- the active six-column layout and archived layout use independent width rules;
- routine refresh still does not request quota history.
