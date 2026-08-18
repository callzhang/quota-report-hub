#!/usr/bin/env python3

from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Iterable, Iterator
from typing import Any


COUNTER_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "total_tokens",
)
MAX_SAFE_INTEGER = 2**53 - 1


@dataclasses.dataclass(frozen=True)
class UsageRecord:
    provider: str
    event_at: str
    logical_record_key: str
    model_id: str
    counters: dict[str, int]
    fingerprint: str


@dataclasses.dataclass
class CodexParseContext:
    logical_session_id: str | None = None
    model_id: str | None = None
    warning_count: int = 0


@dataclasses.dataclass
class ClaudeParseContext:
    warning_count: int = 0


def _safe_identifier(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        return None
    return normalized


def _safe_counter(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > MAX_SAFE_INTEGER:
        return None
    return value


def _fingerprint(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_codex_line(line: str, context: CodexParseContext) -> UsageRecord | None:
    try:
        value = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        context.warning_count += 1
        return None
    if not isinstance(value, dict):
        context.warning_count += 1
        return None

    record_type = value.get("type")
    payload = value.get("payload")
    if record_type == "session_meta":
        if not isinstance(payload, dict):
            context.warning_count += 1
            return None
        session_id = _safe_identifier(payload.get("session_id")) or _safe_identifier(payload.get("id"))
        if session_id is None:
            context.warning_count += 1
        else:
            context.logical_session_id = session_id
        return None
    if record_type == "turn_context":
        if not isinstance(payload, dict):
            context.warning_count += 1
            return None
        model_id = _safe_identifier(payload.get("model"))
        if model_id is None:
            context.warning_count += 1
        else:
            context.model_id = model_id
        return None
    if record_type != "event_msg":
        return None
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        context.warning_count += 1
        return None

    event_at = _safe_identifier(value.get("timestamp"))
    info = payload.get("info")
    usage = info.get("total_token_usage") if isinstance(info, dict) else None
    if (
        event_at is None
        or context.logical_session_id is None
        or context.model_id is None
        or not isinstance(usage, dict)
    ):
        context.warning_count += 1
        return None
    source_fields = {
        "input_tokens": "input_tokens",
        "output_tokens": "output_tokens",
        "cache_read_tokens": "cached_input_tokens",
        "cache_write_tokens": "cache_write_input_tokens",
        "reasoning_tokens": "reasoning_output_tokens",
        "total_tokens": "total_tokens",
    }
    counters: dict[str, int] = {}
    for target, source in source_fields.items():
        counter = _safe_counter(usage.get(source, 0))
        if counter is None:
            context.warning_count += 1
            return None
        counters[target] = counter

    structural = {
        "provider": "codex",
        "logical_session_id": context.logical_session_id,
        "event_at": event_at,
        "model_id": context.model_id,
        "counters": counters,
    }
    return UsageRecord(
        provider="codex",
        event_at=event_at,
        logical_record_key=f"codex:{context.logical_session_id}",
        model_id=context.model_id,
        counters=counters,
        fingerprint=_fingerprint(structural),
    )


def parse_codex_lines(lines: Iterable[str]) -> Iterator[UsageRecord]:
    context = CodexParseContext()
    for line in lines:
        record = parse_codex_line(line, context)
        if record is not None:
            yield record


def codex_counter_delta(
    current: dict[str, int],
    acknowledged: dict[str, int] | None,
) -> dict[str, int]:
    normalized_current = {field: int(current.get(field, 0)) for field in COUNTER_FIELDS}
    if acknowledged is None:
        return normalized_current
    normalized_acknowledged = {field: int(acknowledged.get(field, 0)) for field in COUNTER_FIELDS}
    if any(normalized_current[field] < normalized_acknowledged[field] for field in COUNTER_FIELDS):
        return normalized_current
    return {
        field: normalized_current[field] - normalized_acknowledged[field]
        for field in COUNTER_FIELDS
    }


def parse_claude_line(
    line: str,
    context: ClaudeParseContext | None = None,
) -> UsageRecord | None:
    parse_context = context if context is not None else ClaudeParseContext()
    try:
        value = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        parse_context.warning_count += 1
        return None
    if not isinstance(value, dict):
        parse_context.warning_count += 1
        return None
    if value.get("type") != "assistant":
        return None
    message = value.get("message")
    if not isinstance(message, dict):
        parse_context.warning_count += 1
        return None
    message_id = _safe_identifier(message.get("id"))
    model_id = _safe_identifier(message.get("model"))
    event_at = _safe_identifier(value.get("timestamp"))
    usage = message.get("usage")
    if message_id is None or model_id is None or event_at is None or not isinstance(usage, dict):
        parse_context.warning_count += 1
        return None

    source_fields = {
        "input_tokens": ("input_tokens", True),
        "output_tokens": ("output_tokens", True),
        "cache_read_tokens": ("cache_read_input_tokens", False),
        "cache_write_tokens": ("cache_creation_input_tokens", False),
    }
    counters: dict[str, int] = {}
    for target, (source, required) in source_fields.items():
        if required and source not in usage:
            parse_context.warning_count += 1
            return None
        counter = _safe_counter(usage.get(source, 0))
        if counter is None:
            parse_context.warning_count += 1
            return None
        counters[target] = counter
    counters["reasoning_tokens"] = 0
    counters["total_tokens"] = sum(counters[field] for field in (
        "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"
    ))
    if counters["total_tokens"] > MAX_SAFE_INTEGER:
        parse_context.warning_count += 1
        return None

    structural = {
        "provider": "claude",
        "message_id": message_id,
        "event_at": event_at,
        "model_id": model_id,
        "counters": counters,
    }
    return UsageRecord(
        provider="claude",
        event_at=event_at,
        logical_record_key=f"claude:{message_id}",
        model_id=model_id,
        counters=counters,
        fingerprint=_fingerprint(structural),
    )


def claude_counter_delta(
    current: dict[str, int],
    acknowledged: dict[str, int] | None,
) -> dict[str, int]:
    normalized_current = {field: int(current.get(field, 0)) for field in COUNTER_FIELDS}
    if acknowledged is None:
        return normalized_current
    normalized_acknowledged = {field: int(acknowledged.get(field, 0)) for field in COUNTER_FIELDS}
    delta = {
        field: max(0, normalized_current[field] - normalized_acknowledged[field])
        for field in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
    }
    delta["reasoning_tokens"] = 0
    delta["total_tokens"] = sum(delta.values())
    return delta
