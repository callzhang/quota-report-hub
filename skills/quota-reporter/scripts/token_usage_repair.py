"""One-time repair: re-derive this machine's whole retained window from the raw logs.

The live collector is incremental by design -- it resumes at a byte offset and differences each
session's cumulative against the last value it saw. That is right for steady state and wrong for
history it got wrong, because the numbers it would need to correct are exactly the ones it no
longer has. So the repair does the one thing the collector never does: it reads every log from its
first byte, so every session is watched from its own beginning and no cumulative is ever charged as
a turn.

It runs once per installation, in a detached process, because parsing several gigabytes takes
minutes and the guard's whole cycle budget is ten seconds. The hub applies it as a replacement of
this machine's own contribution ([lib/db.js] ingestTokenUsageBatch, `replaceFrom`), which is only
possible because usage is keyed per installation -- one machine correcting a shared row would be
overwriting work it cannot see.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from quota_reporters import load_config, post_token_usage_batch, reporter_name
from reporter_version import CLIENT_VERSION
from token_usage_collector import (
    DEFAULT_CLAUDE_PROJECT_ROOT,
    DEFAULT_CODEX_SESSION_ROOTS,
    MAX_AGGREGATE_ROWS,
    _bucket_start,
    _parse_time,
    account_for_event,
)
from token_usage_parsers import (
    COUNTER_FIELDS,
    ClaudeParseContext,
    CodexParseContext,
    claude_counter_delta,
    codex_counter_delta,
    parse_claude_line,
    parse_codex_line,
)
from token_usage_state import TokenUsageState, iso_timestamp, utc_now

# The repair rewrites what the hub keeps at 15-minute detail. Reaching further back would delete
# rows it cannot replace: past the detail window the hub holds only daily rollups, and this pass
# produces buckets.
REPAIR_WINDOW_DAYS = 90
# Bumped when a fix changes what the recomputed numbers would be, so every machine repairs again.
REPAIR_GENERATION = "1"
REPAIR_STATE_KEY = "repair_generation"


def repair_completed(state: TokenUsageState) -> bool:
    return state.meta(REPAIR_STATE_KEY) == REPAIR_GENERATION


def account_before(state: TokenUsageState, provider: str, moment: str) -> str | None:
    """The account this machine was on when the window opened, or None if it never recorded one."""
    switches = state.switches_for_range(provider, "", moment)
    return switches[-1]["to_account_id"] if switches else None


def recompute_window(
    since: datetime,
    *,
    state: TokenUsageState,
    codex_roots: tuple[Path, ...] = DEFAULT_CODEX_SESSION_ROOTS,
    claude_root: Path = DEFAULT_CLAUDE_PROJECT_ROOT,
) -> list[dict]:
    """Every bucket this machine can prove, from the logs rather than from the checkpoint."""
    since_iso = iso_timestamp(since)
    range_end = iso_timestamp(utc_now() + timedelta(seconds=1))
    switches = {
        provider: state.switches_for_range(provider, since_iso, range_end)
        for provider in ("codex", "claude")
    }
    # The boundaries inside the window say when the account changed; they do not say what it was
    # when the window opened. Live, the collector fills that gap with the account observed at report
    # time. Offline the equivalent is the last switch finalized before the window -- the account the
    # machine was actually on -- and without it a window that opens after the most recent switch has
    # no boundaries at all and every event would be dropped as unattributable.
    opening = {provider: account_before(state, provider, since_iso) for provider in ("codex", "claude")}
    aggregate: dict[tuple, dict[str, int]] = defaultdict(lambda: {field: 0 for field in COUNTER_FIELDS})
    counters: dict[str, dict[str, int]] = {}
    seen: set[str] = set()

    roots = [("codex", root) for root in codex_roots] + [("claude", claude_root)]
    for provider, root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            try:
                # Selected on mtime, not on the date in the name: a session opened months ago and
                # still being written to holds this window's turns, and those long-lived sessions
                # are precisely the ones whose cumulatives became phantom usage.
                if datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc) < since:
                    continue
                handle = path.open("r", encoding="utf-8", errors="replace")
            except OSError:
                continue
            codex_context = CodexParseContext()
            claude_context = ClaudeParseContext()
            with handle:
                for line in handle:
                    record = (
                        parse_codex_line(line, codex_context)
                        if provider == "codex"
                        else parse_claude_line(line, claude_context)
                    )
                    if record is None or record.fingerprint in seen:
                        continue
                    seen.add(record.fingerprint)
                    delta = (
                        codex_counter_delta(record.counters, counters.get(record.logical_record_key))
                        if provider == "codex"
                        else claude_counter_delta(record.counters, counters.get(record.logical_record_key))
                    )
                    # Seeded whether or not the delta is charged, so the next turn is measured
                    # against what this event reported rather than a stale predecessor.
                    counters[record.logical_record_key] = dict(record.counters)
                    event_time = _parse_time(record.event_at)
                    bucket = _bucket_start(record.event_at)
                    if event_time is None or bucket is None or event_time < since:
                        continue
                    if not any(delta.values()):
                        continue
                    account = account_for_event(
                        event_at=record.event_at,
                        report_account_id=opening[provider],
                        switches=switches[provider],
                    )
                    if account is None:
                        # No boundary covers this event, so there is no account to file it under.
                        # Dropping it undercounts; guessing would put another account's tokens on
                        # someone's name, which is worse and unfixable.
                        continue
                    row = aggregate[(bucket, provider, account, record.model_id)]
                    for field in COUNTER_FIELDS:
                        row[field] += int(delta[field])

    return [
        {
            "bucket_start": key[0], "provider": key[1], "model_account_id": key[2],
            "model_id": key[3], **value,
        }
        for key, value in sorted(aggregate.items())
    ]


def run_repair(config: dict, *, state: TokenUsageState) -> dict:
    """Recompute, then upload as a replacement of this machine's own history.

    The first batch carries `replace_from`, which is what clears this machine's rows for the window
    before anything is added back. Every batch after it is an ordinary additive one: the window has
    already been cleared and the buckets are disjoint, so accumulating them is exact. Only the first
    may replace -- a second replace would delete the chunks that came before it.
    """
    auth_pool_url = str(config.get("auth_pool_url") or "").strip()
    auth_pool_user_token = str(config.get("auth_pool_user_token") or "").strip()
    if not auth_pool_url or not auth_pool_user_token:
        return {"ok": False, "reason": "missing_auth_pool_config"}
    if repair_completed(state):
        return {"ok": True, "repaired": False, "reason": "already_repaired"}

    since = utc_now() - timedelta(days=REPAIR_WINDOW_DAYS)
    # Never earlier than the point this installation started reporting. Rows before it belong to
    # nobody here, and a replace reaching back that far would delete another machine's history.
    backfill_cutoff = _parse_time(state.backfill_cutoff)
    if backfill_cutoff is not None and backfill_cutoff > since:
        since = backfill_cutoff
    since = since.replace(minute=(since.minute // 15) * 15, second=0, microsecond=0)

    rows = recompute_window(since, state=state)
    if not rows:
        state.set_meta(REPAIR_STATE_KEY, REPAIR_GENERATION)
        return {"ok": True, "repaired": True, "rows": 0, "reason": "nothing_to_report"}

    chunks = [rows[start:start + MAX_AGGREGATE_ROWS] for start in range(0, len(rows), MAX_AGGREGATE_ROWS)]
    uploaded = 0
    for index, chunk in enumerate(chunks):
        payload = {
            "installation_id": state.installation_id,
            # Deterministic per chunk so a retry of a half-finished repair re-sends the same batch
            # id with the same payload, and the hub's receipt makes it a no-op instead of a double
            # count. A random id would apply the same tokens twice.
            "batch_id": f"repair-{REPAIR_GENERATION}-{iso_timestamp(since)}-{index}",
            "client_version": CLIENT_VERSION,
            "rows": chunk,
        }
        if index == 0:
            payload["replace_from"] = iso_timestamp(since)
        response = post_token_usage_batch(auth_pool_url, auth_pool_user_token, payload)
        if not response.get("ok"):
            # Leave the marker unset: the next guard run starts the repair again, re-sends the same
            # deterministic batch ids, and the already-applied chunks are refused as duplicates.
            return {
                "ok": False, "repaired": False, "uploaded": uploaded,
                "reason": "upload_failed", "status_code": response.get("status_code"),
            }
        uploaded += len(chunk)

    state.set_meta(REPAIR_STATE_KEY, REPAIR_GENERATION)
    return {"ok": True, "repaired": True, "rows": uploaded, "since": iso_timestamp(since),
            "reporter": reporter_name()}


def main() -> int:
    """Entry point for the detached process the guard starts."""
    try:
        config = load_config(None)
    except Exception as error:
        print(json.dumps({"ok": False, "reason": "config_unreadable", "error": str(error)[:200]}))
        return 1
    with TokenUsageState() as state:
        result = run_repair(config, state=state)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
