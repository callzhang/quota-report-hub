#!/usr/bin/env python3
"""Did this machine's Codex rotate (or try to rotate) its refresh token in a time window?

The hub can see that a pooled refresh token died; it cannot see *who* spent it. The one place that
records the local half of that story is Codex's own log database, `~/.codex/logs_2.sqlite`, under the
target `codex_login::auth::manager`. It logs, at INFO:

    Reloading auth for account <id> / Reloaded auth, changed: <bool>
    Refreshing token
    Failed to refresh token: 401 Unauthorized: {... "Your session has ended" ...}
    Skipping token refresh because auth changed after guarded reload.
    Skipping auth reload due to account id mismatch (expected: <a>, found: <b>)

So an empty result for a window is real evidence that no Codex process on this machine refreshed the
grant in it, and a non-empty one names the moment. It is read-only (SQLite URI mode=ro) and prints no
token material: JWTs are masked before anything is shown.

Measured 2026-09-23 on the machine that uploaded derek@stardust.ai: across the 45 hours between a
fresh login and the hub's first (rejected) refresh there was not one "Refreshing token" line, and the
running app-server was on a different account than auth.json ("Skipping auth reload due to account id
mismatch"). Whoever spent that grant was not this machine's Codex.

Usage:
    scripts/codex_local_auth_events.py --since 2026-09-21T14:00:00Z --until 2026-09-23T12:00:00Z
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".codex" / "logs_2.sqlite"
TARGET = "codex_login::auth::manager"
JWT = re.compile(r"eyJ[A-Za-z0-9_\-.]{20,}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def parse_utc(text: str) -> int:
    parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def classify(message: str) -> str:
    if "Failed to refresh token" in message:
        return "refresh_failed"
    if "Refreshing token" in message:
        return "refresh_attempted"
    if "Skipping token refresh" in message:
        return "refresh_skipped_after_reload"
    if "Skipping auth reload due to account id mismatch" in message:
        return "reload_skipped_account_mismatch"
    if "Reloaded auth" in message:
        return "reloaded"
    if "Reloading auth" in message:
        return "reloading"
    return "other"


def message_tail(body: str) -> str:
    # The body is a tracing span prefix followed by the message; the message is what follows the last
    # closing brace of the span. Mask JWTs and account ids so nothing identifying is printed.
    tail = body.replace("\n", " ").rsplit("}:", 1)[-1].strip()
    return UUID.sub("<id>", JWT.sub("<jwt>", tail))


def events(db_path: Path, since: int, until: int) -> list[tuple[int, str, str]]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT ts, feedback_log_body FROM logs WHERE target = ? AND ts BETWEEN ? AND ? ORDER BY ts",
            (TARGET, since, until),
        ).fetchall()
    finally:
        connection.close()
    result = []
    for ts, body in rows:
        message = message_tail(body or "")
        result.append((ts, classify(message), message))
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--since", required=True, help="ISO-8601 UTC, e.g. 2026-09-21T14:00:00Z")
    parser.add_argument("--until", required=True)
    args = parser.parse_args(argv)
    if not args.db.exists():
        print(f"no Codex log database at {args.db}", file=sys.stderr)
        return 2

    found = events(args.db, parse_utc(args.since), parse_utc(args.until))
    counts: dict[str, int] = {}
    for _, kind, _ in found:
        counts[kind] = counts.get(kind, 0) + 1
    print(f"{len(found)} auth-manager events between {args.since} and {args.until}")
    for kind, number in sorted(counts.items(), key=lambda item: -item[1]):
        print(f"  {number:5}  {kind}")
    attempted = counts.get("refresh_attempted", 0) + counts.get("refresh_failed", 0)
    print()
    if attempted:
        print(f"Codex on this machine attempted a token refresh {attempted} time(s) in the window:")
        for ts, kind, message in found:
            if kind in {"refresh_attempted", "refresh_failed"}:
                stamp = dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
                print(f"  {stamp}  {kind:18} {message[:150]}")
    else:
        print("No refresh attempt by Codex on this machine in the window. If a pooled grant died in it,")
        print("the process that spent it was not a Codex on this machine.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
