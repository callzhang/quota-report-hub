#!/usr/bin/env python3

from __future__ import annotations

import dataclasses
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from quota_reporters import post_token_usage_batch
from token_usage_parsers import (
    COUNTER_FIELDS,
    ClaudeParseContext,
    CodexParseContext,
    UsageRecord,
    claude_counter_delta,
    codex_counter_delta,
    parse_claude_line,
    parse_codex_line,
)
from token_usage_state import (
    DEFAULT_TOKEN_USAGE_STATE_PATH,
    TokenUsageState,
    iso_timestamp,
    utc_now,
)


DEFAULT_CODEX_SESSION_ROOTS = (
    Path.home() / ".codex" / "sessions",
    Path.home() / ".codex" / "archived_sessions",
)
DEFAULT_CLAUDE_PROJECT_ROOT = Path.home() / ".claude" / "projects"
MAX_AGGREGATE_ROWS = 400
FINGERPRINT_RETENTION_DAYS = 90


@dataclasses.dataclass(frozen=True)
class FileCandidate:
    provider: str
    path: Path
    file_key: str
    offset: int
    size: int
    mtime_ns: int


def _parse_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bucket_start(event_at: str) -> str | None:
    parsed = _parse_time(event_at)
    if parsed is None:
        return None
    bucket = parsed.replace(minute=(parsed.minute // 15) * 15, second=0, microsecond=0)
    return iso_timestamp(bucket)


def _base_file_key(stat_result: os.stat_result) -> str:
    return f"{stat_result.st_dev}:{stat_result.st_ino}"


def _file_checkpoint(candidate: FileCandidate, offset: int, stat_result: os.stat_result | None = None) -> dict[str, Any]:
    return {
        "file_key": candidate.file_key,
        "path": str(candidate.path),
        "offset": int(offset),
        "size": int(stat_result.st_size if stat_result is not None else candidate.size),
        "mtime_ns": int(stat_result.st_mtime_ns if stat_result is not None else candidate.mtime_ns),
    }


def discover_changed_files(
    state: TokenUsageState,
    *,
    codex_roots: tuple[Path, ...],
    claude_root: Path,
) -> tuple[list[FileCandidate], list[dict[str, Any]], int]:
    cutoff = _parse_time(state.backfill_cutoff)
    if cutoff is None:
        raise RuntimeError("invalid persisted backfill cutoff")
    candidates: list[FileCandidate] = []
    checkpoints: list[dict[str, Any]] = []
    warnings = 0
    roots = [("codex", root) for root in codex_roots] + [("claude", claude_root)]
    for provider, root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            try:
                stat_result = path.stat()
            except FileNotFoundError:
                warnings += 1
                continue
            base_key = _base_file_key(stat_result)
            previous = state.file_cursor_for_path(str(path))
            if previous is None:
                candidate = FileCandidate(provider, path, base_key, 0, stat_result.st_size, stat_result.st_mtime_ns)
                modified_at = datetime.fromtimestamp(stat_result.st_mtime, tz=timezone.utc)
                if modified_at < cutoff:
                    checkpoints.append(_file_checkpoint(candidate, stat_result.st_size, stat_result))
                else:
                    candidates.append(candidate)
                continue

            same_file = str(previous["file_key"]).split(":", 2)[:2] == base_key.split(":", 1)
            previous_offset = int(previous["offset"])
            previous_size = int(previous["size"])
            previous_mtime = int(previous["mtime_ns"])
            if not same_file:
                candidates.append(FileCandidate(provider, path, base_key, 0, stat_result.st_size, stat_result.st_mtime_ns))
                continue
            if stat_result.st_size == previous_size and stat_result.st_mtime_ns == previous_mtime and previous_offset == stat_result.st_size:
                continue
            if stat_result.st_size < previous_offset or (
                stat_result.st_size == previous_size and stat_result.st_mtime_ns != previous_mtime
            ):
                replacement_key = f"{base_key}:{stat_result.st_mtime_ns}:{stat_result.st_size}"
                candidates.append(FileCandidate(provider, path, replacement_key, 0, stat_result.st_size, stat_result.st_mtime_ns))
                continue
            candidates.append(FileCandidate(
                provider, path, str(previous["file_key"]), previous_offset,
                stat_result.st_size, stat_result.st_mtime_ns,
            ))
    return candidates, checkpoints, warnings


def account_for_event(
    *,
    event_at: str,
    report_account_id: str | None,
    switches: list[dict[str, Any]],
) -> str | None:
    if not switches:
        return report_account_id
    account = switches[0].get("from_account_id") or report_account_id
    for switch in switches:
        if switch["prepared_at"] <= event_at:
            account = switch.get("to_account_id") or account
        else:
            break
    return account


def _empty_summary(*, started: float, monotonic: Callable[[], float], reason: str | None = None) -> dict[str, Any]:
    result = {
        "ok": reason is None,
        "reported": False,
        "rows": 0,
        "total_tokens": 0,
        "bytes_read": 0,
        "backfill_complete": False,
        "retry": False,
        "warnings": {"files": 0, "parse": 0},
        "elapsed_seconds": max(0.0, monotonic() - started),
    }
    if reason is not None:
        result["reason"] = reason
    return result


def _handle_pending_upload(
    *,
    state: TokenUsageState,
    pending: dict[str, Any],
    auth_pool_url: str,
    auth_pool_user_token: str,
    started: float,
    monotonic: Callable[[], float],
    bytes_read: int = 0,
    warnings: dict[str, int] | None = None,
    backfill_complete: bool = False,
) -> dict[str, Any]:
    payload = pending["payload"]
    try:
        response = post_token_usage_batch(auth_pool_url, auth_pool_user_token, payload)
    except Exception:
        return {
            "ok": False, "reported": False, "rows": len(payload.get("rows", [])),
            "total_tokens": sum(int(row.get("total_tokens", 0)) for row in payload.get("rows", [])),
            "bytes_read": bytes_read, "backfill_complete": backfill_complete,
            "retry": True, "warnings": warnings or {"files": 0, "parse": 0},
            "elapsed_seconds": max(0.0, monotonic() - started), "reason": "upload_retry_pending",
        }
    status_code = int(response.get("status_code") or (200 if response.get("ok") else 0))
    if response.get("ok"):
        state.ack_pending_batch(pending["batch_id"])
        return {
            "ok": True, "reported": True, "rows": len(payload.get("rows", [])),
            "total_tokens": sum(int(row.get("total_tokens", 0)) for row in payload.get("rows", [])),
            "bytes_read": bytes_read, "backfill_complete": backfill_complete,
            "retry": False, "warnings": warnings or {"files": 0, "parse": 0},
            "elapsed_seconds": max(0.0, monotonic() - started),
        }
    if status_code == 400:
        state.reject_pending_batch(
            pending["batch_id"], status_code=400,
            error_code=str(response.get("error") or response.get("reason") or "invalid_token_usage"),
        )
        return {
            "ok": False, "reported": False, "rows": len(payload.get("rows", [])),
            "total_tokens": sum(int(row.get("total_tokens", 0)) for row in payload.get("rows", [])),
            "bytes_read": bytes_read, "backfill_complete": backfill_complete,
            "retry": False, "warnings": warnings or {"files": 0, "parse": 0},
            "elapsed_seconds": max(0.0, monotonic() - started), "reason": "upload_rejected",
        }
    return {
        "ok": False, "reported": False, "rows": len(payload.get("rows", [])),
        "total_tokens": sum(int(row.get("total_tokens", 0)) for row in payload.get("rows", [])),
        "bytes_read": bytes_read, "backfill_complete": backfill_complete,
        "retry": True, "warnings": warnings or {"files": 0, "parse": 0},
        "elapsed_seconds": max(0.0, monotonic() - started),
        "reason": "token_invalidated" if status_code == 401 else "upload_retry_pending",
    }


def collect_and_report_token_usage(
    *,
    config: dict,
    codex_account_id: str | None,
    claude_account_id: str | None,
    state: TokenUsageState | None = None,
    state_path: Path = DEFAULT_TOKEN_USAGE_STATE_PATH,
    codex_roots: tuple[Path, ...] = DEFAULT_CODEX_SESSION_ROOTS,
    claude_root: Path = DEFAULT_CLAUDE_PROJECT_ROOT,
    budget_seconds: float = 10.0,
    wall_now: Callable[[], datetime] = utc_now,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    started = monotonic()
    auth_pool_url = str(config.get("auth_pool_url") or "").strip()
    auth_pool_user_token = str(config.get("auth_pool_user_token") or "").strip()
    if not auth_pool_url or not auth_pool_user_token:
        return _empty_summary(started=started, monotonic=monotonic, reason="missing_auth_pool_config")

    owned_state = state is None
    usage_state = state or TokenUsageState(state_path, now=wall_now)
    try:
        now = wall_now()
        now_iso = iso_timestamp(now)
        if codex_account_id is not None:
            usage_state.reconcile_prepared_switches(
                provider="codex", observed_account_id=codex_account_id, observed_at=now_iso
            )
        if claude_account_id is not None:
            usage_state.reconcile_prepared_switches(
                provider="claude", observed_account_id=claude_account_id, observed_at=now_iso
            )
        pending = usage_state.pending_upload()
        if pending is not None:
            return _handle_pending_upload(
                state=usage_state, pending=pending, auth_pool_url=auth_pool_url,
                auth_pool_user_token=auth_pool_user_token, started=started, monotonic=monotonic,
            )

        candidates, initial_checkpoints, file_warnings = discover_changed_files(
            usage_state, codex_roots=codex_roots, claude_root=claude_root
        )
        warnings = {"files": file_warnings, "parse": 0}
        cutoff = usage_state.backfill_cutoff
        report_accounts = {"codex": codex_account_id, "claude": claude_account_id}
        range_end = iso_timestamp(now + timedelta(seconds=1))
        switches = {
            provider: usage_state.switches_for_range(provider, cutoff, range_end)
            for provider in ("codex", "claude")
        }
        file_checkpoints = {item["file_key"]: item for item in initial_checkpoints}
        proposed_counters: dict[str, dict[str, Any]] = {}
        proposed_fingerprints: dict[str, dict[str, str]] = {}
        working_counters: dict[str, dict[str, int]] = {}
        aggregate: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        bytes_read = 0
        stopped = False

        def acknowledged_counter(record_key: str) -> dict[str, int] | None:
            if record_key not in working_counters:
                stored = usage_state.usage_counter(record_key)
                if stored is not None:
                    working_counters[record_key] = {field: int(stored.get(field, 0)) for field in COUNTER_FIELDS}
            return working_counters.get(record_key)

        for candidate in candidates:
            if monotonic() - started >= budget_seconds:
                stopped = True
                break
            context_key = f"context:{candidate.file_key}"
            stored_context = usage_state.usage_counter(context_key) or {}
            codex_context = CodexParseContext(
                logical_session_id=stored_context.get("logical_session_id"),
                model_id=stored_context.get("model_id"),
                warning_count=0,
            )
            claude_context = ClaudeParseContext()
            processed_offset = candidate.offset
            try:
                with candidate.path.open("rb") as source:
                    source.seek(candidate.offset)
                    while True:
                        line_start = source.tell()
                        raw = source.readline()
                        if not raw:
                            break
                        bytes_read += len(raw)
                        if not raw.endswith(b"\n"):
                            processed_offset = line_start
                            break
                        try:
                            text = raw.decode("utf-8")
                        except UnicodeDecodeError:
                            warnings["parse"] += 1
                            processed_offset = source.tell()
                            continue
                        before_warnings = codex_context.warning_count if candidate.provider == "codex" else claude_context.warning_count
                        record = (
                            parse_codex_line(text, codex_context)
                            if candidate.provider == "codex"
                            else parse_claude_line(text, claude_context)
                        )
                        after_warnings = codex_context.warning_count if candidate.provider == "codex" else claude_context.warning_count
                        warnings["parse"] += after_warnings - before_warnings
                        if record is not None:
                            event_time = _parse_time(record.event_at)
                            bucket = _bucket_start(record.event_at)
                            if event_time is None or bucket is None:
                                warnings["parse"] += 1
                            elif not usage_state.has_fingerprint(record.fingerprint) and record.fingerprint not in proposed_fingerprints:
                                acknowledged = acknowledged_counter(record.logical_record_key)
                                if record.provider == "codex":
                                    delta = codex_counter_delta(record.counters, acknowledged)
                                else:
                                    delta = claude_counter_delta(record.counters, acknowledged)
                                account_id = account_for_event(
                                    event_at=record.event_at,
                                    report_account_id=report_accounts[record.provider],
                                    switches=switches[record.provider],
                                )
                                should_emit = event_time >= _parse_time(cutoff) and any(delta.values())
                                aggregate_key = (bucket, record.provider, account_id or "", record.model_id)
                                if should_emit and account_id is None:
                                    warnings["parse"] += 1
                                    stopped = True
                                    processed_offset = line_start
                                    break
                                if should_emit and aggregate_key not in aggregate and len(aggregate) >= MAX_AGGREGATE_ROWS:
                                    stopped = True
                                    processed_offset = line_start
                                    break
                                working_counters[record.logical_record_key] = dict(record.counters)
                                proposed_counters[record.logical_record_key] = {
                                    "record_key": record.logical_record_key, "value": dict(record.counters)
                                }
                                proposed_fingerprints[record.fingerprint] = {
                                    "digest": record.fingerprint, "event_at": record.event_at
                                }
                                if should_emit:
                                    row = aggregate.setdefault(aggregate_key, {
                                        "bucket_start": bucket,
                                        "provider": record.provider,
                                        "model_account_id": account_id,
                                        "model_id": record.model_id,
                                        **{field: 0 for field in COUNTER_FIELDS},
                                    })
                                    for field in COUNTER_FIELDS:
                                        row[field] += int(delta[field])
                        processed_offset = source.tell()
                        if monotonic() - started >= budget_seconds:
                            stopped = True
                            break
                    current_stat = os.fstat(source.fileno())
                file_checkpoints[candidate.file_key] = _file_checkpoint(candidate, processed_offset, current_stat)
            except FileNotFoundError:
                warnings["files"] += 1
                continue
            if candidate.provider == "codex":
                proposed_counters[context_key] = {
                    "record_key": context_key,
                    "value": {
                        "logical_session_id": codex_context.logical_session_id,
                        "model_id": codex_context.model_id,
                    },
                }
            if stopped:
                break

        proposed = {
            "files": list(file_checkpoints.values()),
            "counters": list(proposed_counters.values()),
            "fingerprints": list(proposed_fingerprints.values()),
        }
        rows = sorted(aggregate.values(), key=lambda row: (
            row["bucket_start"], row["provider"], row["model_account_id"], row["model_id"]
        ))
        backfill_complete = not stopped
        if not rows:
            if any(proposed.values()):
                usage_state.apply_checkpoint(proposed)
            usage_state.prune_fingerprints(iso_timestamp(now - timedelta(days=FINGERPRINT_RETENTION_DAYS)))
            result = _empty_summary(started=started, monotonic=monotonic)
            result.update({
                "bytes_read": bytes_read,
                "backfill_complete": backfill_complete,
                "warnings": warnings,
            })
            return result

        payload = {
            "installation_id": usage_state.installation_id,
            "batch_id": str(uuid.uuid4()),
            "rows": rows,
        }
        pending = usage_state.stage_batch(payload=payload, proposed=proposed)
        result = _handle_pending_upload(
            state=usage_state, pending=pending, auth_pool_url=auth_pool_url,
            auth_pool_user_token=auth_pool_user_token, started=started, monotonic=monotonic,
            bytes_read=bytes_read, warnings=warnings, backfill_complete=backfill_complete,
        )
        if not result["retry"]:
            usage_state.prune_fingerprints(iso_timestamp(now - timedelta(days=FINGERPRINT_RETENTION_DAYS)))
        return result
    finally:
        if owned_state:
            usage_state.close()
