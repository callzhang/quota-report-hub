#!/usr/bin/env python3
"""Remove usage buckets that record physically impossible volumes, and report client uptake.

Until every reporter self-updates past the compaction-as-reset bug, un-upgraded clients keep
re-emitting whole session cumulatives as fresh usage. One pass removed 79 such rows holding 86% of
all recorded volume; more arrive from every machine still running the old collector.

    python3 scripts/purge_contaminated_usage.py [--dry-run]

Talks to Turso over its HTTP API rather than @libsql/client: this host resolves the Turso name into
Tailscale's intercepted range, which curl and urllib traverse but node's TLS stack does not.
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 1e9 tokens in a 900-second bucket is 1.11M tokens/second. Twenty concurrent agents would each have
# to sustain 55K tokens/second -- an order of magnitude past anything an agent produces. Buckets
# below this are reachable by a large fleet, so they stay: deleting them would destroy real usage.
IMPOSSIBLE_BUCKET_TOKENS = 1_000_000_000


def load_credentials() -> tuple[str, str]:
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


def query(sql: str) -> tuple[list[str], list[list], int | None]:
    request = urllib.request.Request(
        f"https://{HOST}/v2/pipeline",
        data=json.dumps({"requests": [{"type": "execute", "stmt": {"sql": sql}}, {"type": "close"}]}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    result = json.load(urllib.request.urlopen(request, timeout=60))["results"][0]
    if result["type"] != "ok":
        sys.exit(f"query failed: {json.dumps(result)[:400]}")
    payload = result["response"]["result"]
    columns = [column["name"] for column in payload["cols"]]
    rows = [[cell.get("value") for cell in row] for row in payload["rows"]]
    return columns, rows, payload.get("affected_row_count")


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="report what would be removed, change nothing")
    args = parser.parse_args()

    _, uptake, _ = query(
        "SELECT COALESCE(client_version, 'OLD/NONE') v, COUNT(*) n FROM auth_pool_user_fetch_stats "
        "WHERE last_fetched_at >= datetime('now', '-7 days') GROUP BY 1 ORDER BY n DESC"
    )
    print("active reporter versions (7d):", ", ".join(f"{v}×{n}" for v, n in uptake) or "none")

    columns, rows, _ = query(
        f"SELECT * FROM token_usage_15m WHERE total_tokens >= {IMPOSSIBLE_BUCKET_TOKENS}"
    )
    if not rows:
        print("no impossible buckets found; nothing to purge")
        return 0

    records = [dict(zip(columns, row)) for row in rows]
    total = sum(int(record["total_tokens"]) for record in records)
    owners = sorted({record["hub_user_email"] for record in records})
    print(f"found {len(records)} impossible buckets totalling {total / 1e9:.1f}B tokens")
    for owner in owners:
        owned = [r for r in records if r["hub_user_email"] == owner]
        print(f"  {owner:32} {len(owned):4} buckets  {sum(int(r['total_tokens']) for r in owned) / 1e9:8.1f}B")

    if args.dry_run:
        print("dry run; nothing removed")
        return 0

    # Back up before deleting. There is no way to recompute these from the hub alone -- the raw
    # session logs live on each user's machine -- so the export is the only copy.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = REPO / f"contaminated-usage-{stamp}.json"
    backup.write_text(json.dumps(records, indent=1))
    print(f"backed up to {backup}")

    # Scoped per owner rather than one broad DELETE: each statement's affected count can then be
    # checked against what was backed up, so a miscount is visible instead of silent.
    removed = 0
    for owner in owners:
        expected = sum(1 for r in records if r["hub_user_email"] == owner)
        _, _, affected = query(
            f"DELETE FROM token_usage_15m WHERE total_tokens >= {IMPOSSIBLE_BUCKET_TOKENS} "
            f"AND hub_user_email = {sql_quote(owner)}"
        )
        removed += affected or 0
        note = "" if affected == expected else f"  (expected {expected}; more arrived since the backup)"
        print(f"  removed {affected} for {owner}{note}")

    _, [[left]], _ = query(
        f"SELECT COUNT(*) FROM token_usage_15m WHERE total_tokens >= {IMPOSSIBLE_BUCKET_TOKENS}"
    )
    print(f"removed {removed} rows; {left} impossible buckets remain")
    if int(left):
        print("WARNING: contamination is still arriving -- some clients have not self-updated yet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
