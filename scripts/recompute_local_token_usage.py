#!/usr/bin/env python3
"""Re-derive this machine's true 15-minute usage buckets from the raw session logs.

The purge script filters by magnitude: it deletes what cannot be usage and keeps the rest, which
leaves whatever contamination happened to land under the line. This does the other thing -- it
reads the source of truth. Every codex rollout and claude transcript is parsed from its first byte
with the fixed delta logic, so no session is ever picked up part way through and no cumulative is
ever charged as a turn. What comes out is what this machine actually used.

    python3 scripts/recompute_local_token_usage.py [--since ISO] [--out FILE] [--compare]

`--compare` fetches the hub's rows for the same window and prints the difference per bucket.

Two things it cannot do, and both matter when reading the output:

  * It sees ONE machine. `token_usage_15m` has no installation column, so a hub bucket carrying
    several machines' work cannot be split, and this machine's number is a floor for that bucket,
    not the whole of it. Run it on every machine that reports under the same hub user before
    treating the totals as complete.
  * Account attribution replays the switch boundaries recorded in the local collector state. Events
    before the oldest recorded boundary fall back to the earliest account known for that provider,
    which is a guess -- the same approximation the collector makes live, no better.
"""

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "skills" / "quota-reporter" / "scripts"))

from token_usage_collector import (  # noqa: E402
    DEFAULT_CLAUDE_PROJECT_ROOT,
    DEFAULT_CODEX_SESSION_ROOTS,
    _bucket_start,
    _parse_time,
    account_for_event,
)
from token_usage_parsers import (  # noqa: E402
    COUNTER_FIELDS,
    ClaudeParseContext,
    CodexParseContext,
    claude_counter_delta,
    codex_counter_delta,
    parse_claude_line,
    parse_codex_line,
)
from token_usage_state import DEFAULT_TOKEN_USAGE_STATE_PATH  # noqa: E402


def load_switches(state_path: Path, since_iso: str) -> dict[str, list[dict]]:
    """Replay the collector's own account boundaries rather than inventing attribution.

    Same query shape the collector uses live (`switches_for_range`): finalized boundaries at or
    after the window start, ordered by `prepared_at`. `account_for_event` reads the first entry's
    `from_account_id` as the account in force before any of them, so the window's opening
    attribution comes from the same record the live path would have used.
    """
    switches: dict[str, list[dict]] = {"codex": [], "claude": []}
    if not state_path.exists():
        return switches
    connection = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT provider, prepared_at, from_account_id, to_account_id FROM account_switches "
            "WHERE status = 'finalized' AND prepared_at >= ? ORDER BY prepared_at, id",
            (since_iso,),
        ).fetchall()
    finally:
        connection.close()
    for row in rows:
        switches.setdefault(str(row["provider"]), []).append(dict(row))
    return switches


def current_accounts(state_path: Path) -> dict[str, str | None]:
    """The account each provider most recently switched TO, as the no-boundaries fallback."""
    accounts: dict[str, str | None] = {"codex": None, "claude": None}
    if not state_path.exists():
        return accounts
    connection = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
    try:
        for provider, account in connection.execute(
            "SELECT provider, to_account_id FROM account_switches WHERE status = 'finalized' "
            "ORDER BY prepared_at, id"
        ):
            accounts[str(provider)] = account
    finally:
        connection.close()
    return accounts


def candidate_files(since: datetime) -> list[tuple[str, Path]]:
    """Every log that could hold an event in the window.

    Selected on mtime, not on the date in the filename: a session opened in June and still being
    written to today holds today's turns, and it is exactly those long-lived sessions whose
    cumulative counters the bug turned into phantom usage.
    """
    found: list[tuple[str, Path]] = []
    roots = [("codex", root) for root in DEFAULT_CODEX_SESSION_ROOTS]
    roots.append(("claude", DEFAULT_CLAUDE_PROJECT_ROOT))
    for provider, root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            try:
                if datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc) >= since:
                    found.append((provider, path))
            except FileNotFoundError:
                continue
    return found


def recompute(since: datetime, state_path: Path) -> dict:
    since_iso = since.isoformat().replace("+00:00", "Z")
    switches = load_switches(state_path, since_iso)
    # Only reached when there is no boundary at all for a provider, in which case the collector
    # would have used the account observed at report time. Offline the closest equivalent is the
    # account the machine is on now.
    fallback = current_accounts(state_path)
    aggregate: dict[tuple, dict[str, int]] = defaultdict(lambda: {field: 0 for field in COUNTER_FIELDS})
    counters: dict[str, dict[str, int]] = {}
    seen: set[str] = set()
    files = candidate_files(since)
    stats = {"files": len(files), "bytes": 0, "events": 0, "emitted": 0, "duplicates": 0, "unparsed": 0}

    for index, (provider, path) in enumerate(files, start=1):
        if index % 100 == 0:
            print(f"  ... {index}/{len(files)} files, {stats['bytes'] / 1e9:.1f} GB", file=sys.stderr)
        codex_context = CodexParseContext()
        claude_context = ClaudeParseContext()
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    stats["bytes"] += len(line)
                    record = (
                        parse_codex_line(line, codex_context)
                        if provider == "codex"
                        else parse_claude_line(line, claude_context)
                    )
                    if record is None:
                        continue
                    stats["events"] += 1
                    # Same structural dedupe the collector applies: a forked session copies its
                    # parent's history verbatim, and those turns were already counted once.
                    if record.fingerprint in seen:
                        stats["duplicates"] += 1
                        continue
                    seen.add(record.fingerprint)
                    acknowledged = counters.get(record.logical_record_key)
                    delta = (
                        codex_counter_delta(record.counters, acknowledged)
                        if provider == "codex"
                        else claude_counter_delta(record.counters, acknowledged)
                    )
                    # Seed regardless of whether the delta is charged: the next turn is measured
                    # against what this event actually reported, never against a stale predecessor.
                    counters[record.logical_record_key] = dict(record.counters)
                    event_time = _parse_time(record.event_at)
                    bucket = _bucket_start(record.event_at)
                    if event_time is None or bucket is None:
                        stats["unparsed"] += 1
                        continue
                    # Parsing starts at the file's first byte so that every session is watched from
                    # its own beginning, but only events inside the window are charged.
                    if event_time < since or not any(delta.values()):
                        continue
                    account = account_for_event(
                        event_at=record.event_at,
                        report_account_id=fallback.get(provider),
                        switches=switches.get(provider, []),
                    )
                    stats["emitted"] += 1
                    row = aggregate[(bucket, provider, account or "", record.model_id)]
                    for field in COUNTER_FIELDS:
                        row[field] += int(delta[field])
        except OSError:
            stats["unparsed"] += 1
            continue

    rows = [
        {
            "bucket_start": key[0], "provider": key[1], "model_account_id": key[2],
            "model_id": key[3], **value,
        }
        for key, value in sorted(aggregate.items())
    ]
    return {"since": since_iso, "stats": stats, "rows": rows}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="ISO timestamp; defaults to the collector's backfill cutoff")
    parser.add_argument("--out", default=None, help="write the recomputed rows here as JSON")
    parser.add_argument("--compare", action="store_true", help="print the difference against the hub's rows")
    parser.add_argument("--state", default=str(DEFAULT_TOKEN_USAGE_STATE_PATH))
    parser.add_argument(
        "--replace-user", default=None, metavar="EMAIL",
        help="REPLACE this hub user's rows for the window with the recomputed ones. Only sound when "
             "this machine is that user's only reporter, or so dominant that the rest is noise -- "
             "the hub cannot separate machines, so anything another machine contributed is dropped. "
             "Check the per-provider agreement printed by --compare first: a provider that already "
             "matches 1.00x is proof this machine is the whole of it.",
    )
    parser.add_argument("--apply", action="store_true", help="with --replace-user, actually write")
    args = parser.parse_args()

    state_path = Path(args.state)
    if args.since:
        since = _parse_time(args.since)
    else:
        connection = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
        try:
            row = connection.execute(
                "SELECT value FROM collector_meta WHERE key = 'backfill_cutoff'"
            ).fetchone()
        finally:
            connection.close()
        since = _parse_time(row[0]) if row else datetime.now(timezone.utc) - timedelta(days=30)
    if since is None:
        sys.exit("could not read a start time")

    print(f"recomputing from {since.isoformat()}", file=sys.stderr)
    result = recompute(since, state_path)
    stats = result["stats"]
    print(
        f"parsed {stats['files']} files / {stats['bytes'] / 1e9:.1f} GB: "
        f"{stats['events']} events, {stats['duplicates']} duplicates, {stats['emitted']} charged"
    )
    by_provider: dict[str, int] = defaultdict(int)
    for row in result["rows"]:
        by_provider[row["provider"]] += row["total_tokens"]
    for provider, total in sorted(by_provider.items()):
        count = sum(1 for row in result["rows"] if row["provider"] == provider)
        print(f"  {provider:7} {count:5} buckets  {total / 1e9:8.3f}B tokens")

    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=1))
        print(f"written to {args.out}")

    if args.compare:
        if not args.replace_user:
            sys.exit("--compare needs --replace-user EMAIL to say whose hub rows to compare against")
        compare_against_hub(args.replace_user, result)
    if args.replace_user:
        replace_user_window(args.replace_user, result, apply=args.apply)
    return 0


def compare_against_hub(email: str, result: dict) -> None:
    """Per day and provider, what the hub holds against what the logs say.

    Compared at day granularity rather than per bucket because offline attribution and the live
    collector's can disagree about which account a given quarter hour belongs to -- the switch
    boundary is recorded at the moment the credential is installed, and events either side of it
    move between accounts depending on exactly when the state was written. Totals per day and
    provider are unaffected by that, so they are the honest comparison.

    Read the ratio per provider. One that already sits at 1.00x is a provider this machine is the
    whole of, which is what licenses the replace: the recompute is reproducing a number the hub got
    right. A provider well above 1.00x is either the other machines' work or contamination that
    survived the purge, and only the first is a reason to leave it alone.
    """
    sys.path.insert(0, str(REPO / "scripts"))
    from purge_contaminated_usage import query, sql_quote

    _, hub_rows, _ = query(
        "SELECT bucket_start, provider, total_tokens FROM token_usage_15m "
        f"WHERE hub_user_email = {sql_quote(email)} AND bucket_start >= {sql_quote(result['since'])}"
    )
    hub: dict[tuple[str, str], int] = defaultdict(int)
    for bucket, provider, total in hub_rows:
        hub[(bucket[:10], provider)] += int(total)
    local: dict[tuple[str, str], int] = defaultdict(int)
    for row in result["rows"]:
        local[(row["bucket_start"][:10], row["provider"])] += row["total_tokens"]

    providers = sorted({provider for _, provider in list(hub) + list(local)})
    print(f"\n{email}: hub (every machine) against this machine's recomputed truth")
    header = "".join(f"{provider + ' hub':>13}{provider + ' local':>14}{'ratio':>8}" for provider in providers)
    print(f"{'day':12}{header}")
    for day in sorted({day for day, _ in list(hub) + list(local)}):
        line = f"{day:12}"
        for provider in providers:
            h, l = hub[(day, provider)], local[(day, provider)]
            line += f"{h / 1e9:12.3f}B{l / 1e9:13.3f}B{(f'{h / l:.2f}x' if l else '-'):>8}"
        print(line)
    line = f"{'TOTAL':12}"
    for provider in providers:
        h = sum(v for (_, p), v in hub.items() if p == provider)
        l = sum(v for (_, p), v in local.items() if p == provider)
        line += f"{h / 1e9:12.3f}B{l / 1e9:13.3f}B{(f'{h / l:.2f}x' if l else '-'):>8}"
    print(line)


def replace_user_window(email: str, result: dict, *, apply: bool) -> None:
    """Swap one hub user's window for what the logs say, backing up what was there first.

    Deleting by magnitude leaves whatever contamination landed under the line; this puts the
    measured number in its place. It is a heavier operation than a purge -- it writes values rather
    than removing rows -- so it defaults to a dry run and always exports the rows it replaces.
    There is no way to recompute those from the hub, and after this they are gone.
    """
    sys.path.insert(0, str(REPO / "scripts"))
    from purge_contaminated_usage import query, sql_quote

    since = result["since"]
    scope = f"hub_user_email = {sql_quote(email)} AND bucket_start >= {sql_quote(since)}"
    columns, existing, _ = query(f"SELECT * FROM token_usage_15m WHERE {scope}")
    records = [dict(zip(columns, row)) for row in existing]
    before = sum(int(record["total_tokens"]) for record in records)
    after = sum(row["total_tokens"] for row in result["rows"])
    print(f"\n{email}: {len(records)} rows / {before / 1e9:.3f}B  ->  "
          f"{len(result['rows'])} rows / {after / 1e9:.3f}B")
    if not apply:
        print("dry run; pass --apply to write")
        return

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = REPO / f"replaced-usage-{email.split('@')[0]}-{stamp}.json"
    backup.write_text(json.dumps({"hub_user_email": email, "since": since, "rows": records}, indent=1))
    print(f"backed up to {backup}")

    _, _, removed = query(f"DELETE FROM token_usage_15m WHERE {scope}")
    print(f"removed {removed} rows")

    written = 0
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # Chunked rather than a statement per row: three thousand round trips over the HTTP API is
    # minutes of wall clock, and a half-finished replace is the one state no backup describes.
    for start in range(0, len(result["rows"]), 200):
        values = ", ".join(
            "({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})".format(
                sql_quote(email), sql_quote(row["provider"]), sql_quote(row["model_account_id"]),
                sql_quote(row["model_id"]), sql_quote(row["bucket_start"]),
                row["input_tokens"], row["output_tokens"], row["cache_read_tokens"],
                row["cache_write_tokens"], row["reasoning_tokens"], row["total_tokens"],
                sql_quote(now_iso),
            )
            for row in result["rows"][start:start + 200]
        )
        _, _, affected = query(
            "INSERT INTO token_usage_15m (hub_user_email, provider, model_account_id, model_id, "
            "bucket_start, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
            f"reasoning_tokens, total_tokens, updated_at) VALUES {values}"
        )
        written += affected or 0
    print(f"wrote {written} recomputed rows")


if __name__ == "__main__":
    raise SystemExit(main())
