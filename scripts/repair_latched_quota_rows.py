#!/usr/bin/env python3
"""Repair `auth_pool_quota_latest` rows the merge guard froze on a pre-reset window.

`incomingWindowJumpsBeforePreviousReset` (lib/reports.js) refuses any report whose window `reset_at`
moves later while the stored one has not expired. A genuine re-anchor -- codex's "Full reset" credit
grants a brand-new weekly window on the spot -- is indistinguishable from the fabrication that rule
was written for, so the stored window becomes its own comparison baseline and nothing lifts it until
the *preserved* reset passes, which can be a full week away.

The event log is unaffected: every report is recorded there verbatim. So the repair is a copy, not a
reconstruction -- the newest event that actually carries a plan-bucket window is written over the
frozen row, column for column. Both tables have identical columns by design.

This is a cleanup tool for rows already frozen, NOT a standing defence: until the guard itself is
fixed, a row repaired here can freeze again the next time that account takes a Full reset.

Talks to Turso over its HTTP API rather than @libsql/client because this host resolves the Turso name
into Tailscale's intercepted range, which curl and urllib traverse but node's TLS stack does not
(same reason as purge_contaminated_usage.py).

    python3 scripts/repair_latched_quota_rows.py                      # dry run, all latched rows
    python3 scripts/repair_latched_quota_rows.py --account ceshi@...  # dry run, one account
    python3 scripts/repair_latched_quota_rows.py --account ceshi@... --apply
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.request
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parent.parent

# The plan's own bucket. Other metered ids in one response describe a different limit entirely
# (`codex_bengalfox` is GPT-5.3-Codex-Spark), and `premium` is the tier named on a 429; neither is
# this account's quota, so neither may be the source of a repair. Mirrors
# quota_reporters.codex_meter_is_plan_quota.
PLAN_LIMIT_ID = "codex"

COLUMNS = [
    "hostname", "reporter_name", "reported_at", "email", "name", "plan_name",
    "auth_path", "auth_last_refresh", "status", "error", "model_context_window",
    "five_h_used_percent", "five_h_remaining_percent", "five_h_reset_at",
    "one_week_used_percent", "one_week_remaining_percent", "one_week_reset_at",
    "payload_json",
]


def load_credentials() -> tuple[str, str]:
    import os

    url, token = os.environ.get("TURSO_DATABASE_URL"), os.environ.get("TURSO_AUTH_TOKEN")
    if not (url and token):
        env_path = REPO / ".env.local"
        if not env_path.exists():
            sys.exit("no Turso credentials in the environment and no .env.local to read")
        for line in env_path.read_text().splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, _, value = line.partition("=")
            value = value.strip().strip("\"'")
            if key.strip() == "TURSO_DATABASE_URL" and not url:
                url = value
            elif key.strip() == "TURSO_AUTH_TOKEN" and not token:
                token = value
    if not (url and token):
        sys.exit("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set")
    return url.replace("libsql://", "").replace("https://", ""), token


HOST, TOKEN = load_credentials()


def execute(sql: str, args: list | None = None) -> tuple[list[str], list[list], int | None]:
    def encode(value):
        if value is None:
            return {"type": "null", "value": None}
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return {"type": "float", "value": float(value)}
        return {"type": "text", "value": str(value)}

    stmt = {"sql": sql}
    if args is not None:
        stmt["args"] = [encode(a) for a in args]
    request = urllib.request.Request(
        f"https://{HOST}/v2/pipeline",
        data=json.dumps({"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    result = json.load(urllib.request.urlopen(request, timeout=60))["results"][0]
    if result["type"] != "ok":
        sys.exit(f"query failed: {json.dumps(result)[:400]}")
    payload = result["response"]["result"]
    columns = [column["name"] for column in payload["cols"]]
    rows = [[cell.get("value") for cell in row] for row in payload["rows"]]
    return columns, rows, payload.get("affected_row_count")


def rows_as_dicts(columns, rows):
    return [dict(zip(columns, row)) for row in rows]


def latched_rows(account: str | None):
    """Rows whose stored window disagrees with the newest plan-bucket window in the event log.

    The event must carry a *complete* weekly window and come from the plan bucket. A report with no
    windows (an exhausted account, or -- since client 2.7.0 -- a reading that belonged to another
    bucket) proves nothing about the plan window and must not become the repair source.
    """
    where = "AND l.account_id = ?" if account else ""
    args = [PLAN_LIMIT_ID, account] if account else [PLAN_LIMIT_ID]
    columns, rows, _ = execute(
        f"""
        SELECT l.account_id,
               l.one_week_used_percent  AS shown_used,
               l.one_week_reset_at      AS shown_reset,
               json_extract(l.payload_json, '$.windows."1week".captured_at') AS shown_captured,
               e.reported_at            AS src_at,
               e.one_week_used_percent  AS src_used,
               e.one_week_reset_at      AS src_reset,
               e.id                     AS src_id
        FROM auth_pool_quota_latest l
        JOIN auth_pool_quota_events e
          ON  e.source = l.source AND e.account_id = l.account_id
          AND e.reported_at = (
                SELECT MAX(x.reported_at) FROM auth_pool_quota_events x
                WHERE x.source = l.source AND x.account_id = l.account_id
                  AND x.one_week_reset_at IS NOT NULL
                  AND x.one_week_used_percent IS NOT NULL
                  AND COALESCE(json_extract(x.payload_json, '$.usage_summary.meter.limit_id'), ?) = ?
              )
        WHERE l.source = 'codex'
          AND e.one_week_reset_at <> COALESCE(l.one_week_reset_at, '')
          {where}
        ORDER BY l.account_id
        """,
        [PLAN_LIMIT_ID] + args,
    )
    return rows_as_dicts(columns, rows)


def repair(account_id: str, src_id: str) -> None:
    columns, rows, _ = execute(
        f"SELECT {', '.join(COLUMNS)} FROM auth_pool_quota_events WHERE id = ?", [src_id]
    )
    source = rows_as_dicts(columns, rows)[0]
    # The stored row is the incoming report adopted whole; nothing is merged forward, which is the
    # entire point -- what was merged forward is the frozen window being replaced. windows_stale is
    # cleared for the same reason: the row now holds a window that was actually just measured.
    payload = json.loads(source["payload_json"])
    payload["windows_stale"] = False
    source["payload_json"] = json.dumps(payload, separators=(",", ":"))
    assignments = ", ".join(f"{column} = ?" for column in COLUMNS)
    _, _, affected = execute(
        f"UPDATE auth_pool_quota_latest SET {assignments} WHERE source = 'codex' AND account_id = ?",
        [source[column] for column in COLUMNS] + [account_id],
    )
    if affected != 1:
        sys.exit(f"expected to update exactly 1 row for {account_id}, updated {affected}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--account", help="repair one account instead of every latched row")
    parser.add_argument("--apply", action="store_true", help="write; without it this only reports")
    args = parser.parse_args()

    targets = latched_rows(args.account)
    if not targets:
        print("no latched rows found")
        return 0

    print(f"{len(targets)} latched row(s):\n")
    for row in targets:
        print(f"  {row['account_id']}")
        print(f"    shown : {row['shown_used']}% used, resets {row['shown_reset']}, measured {row['shown_captured']}")
        print(f"    actual: {row['src_used']}% used, resets {row['src_reset']}, measured {row['src_at']}")
    print()

    if not args.apply:
        print("dry run -- nothing written. Re-run with --apply.")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = REPO / f"latched-quota-rows-{stamp}.json"
    ids = ", ".join("?" for _ in targets)
    columns, rows, _ = execute(
        f"SELECT * FROM auth_pool_quota_latest WHERE source = 'codex' AND account_id IN ({ids})",
        [row["account_id"] for row in targets],
    )
    backup_path.write_text(json.dumps(rows_as_dicts(columns, rows), indent=1))
    print(f"backed up {len(rows)} row(s) to {backup_path.name}")

    for row in targets:
        repair(row["account_id"], row["src_id"])
        print(f"  repaired {row['account_id']}")

    print("\nverifying...")
    remaining = latched_rows(args.account)
    still = {row["account_id"] for row in remaining} & {row["account_id"] for row in targets}
    if still:
        sys.exit(f"still latched after repair: {sorted(still)}")
    print("all repaired rows now agree with the event log")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
