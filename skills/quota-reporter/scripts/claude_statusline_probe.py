#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


SNAPSHOT_PATH = Path.home() / ".claude" / "statusline-rate-limits.json"


def load_previous_snapshot(snapshot_path: Path) -> dict | None:
    if not snapshot_path.exists():
        return None
    try:
        return json.loads(snapshot_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def rate_limit_window_is_fresh(window: dict | None, now: datetime) -> bool:
    if not isinstance(window, dict):
        return False
    if window.get("used_percentage") is None:
        return False
    try:
        resets_at = float(window.get("resets_at"))
    except (TypeError, ValueError):
        return False
    return resets_at > now.timestamp()


def merge_rate_limits(payload_rate_limits: dict | None, previous_snapshot: dict | None, now: datetime) -> tuple[dict | None, str, str | None]:
    current = payload_rate_limits if isinstance(payload_rate_limits, dict) else {}
    previous = (previous_snapshot or {}).get("rate_limits") if isinstance(previous_snapshot, dict) else {}
    previous = previous if isinstance(previous, dict) else {}
    merged = {}
    used_current = False
    used_previous = False

    for key in ("five_hour", "seven_day"):
        current_window = current.get(key)
        previous_window = previous.get(key)
        if rate_limit_window_is_fresh(current_window, now):
            merged[key] = current_window
            used_current = True
        elif rate_limit_window_is_fresh(previous_window, now):
            merged[key] = previous_window
            used_previous = True

    if not merged:
        return None, "unavailable", "absent_before_first_api_response" if not current else None
    if used_current and used_previous:
        return merged, "merged_current_and_previous", None
    if used_current:
        return merged, "statusline_payload", None
    return merged, "previous_snapshot", "absent_before_first_api_response" if not current else "current_windows_unusable"


def build_snapshot(payload: dict, previous_snapshot: dict | None = None, now: datetime | None = None) -> dict:
    captured_at = now or datetime.now(timezone.utc)
    rate_limits, rate_limits_source, missing_reason = merge_rate_limits(
        payload.get("rate_limits"),
        previous_snapshot,
        captured_at,
    )
    snapshot = {
        "captured_at": captured_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "model": payload.get("model"),
        "workspace": payload.get("workspace"),
        "session_id": payload.get("session_id"),
        "version": payload.get("version"),
        "rate_limits": rate_limits,
        "rate_limits_source": rate_limits_source,
        "context_window": payload.get("context_window"),
        "cost": payload.get("cost"),
    }
    if missing_reason:
        snapshot["rate_limits_missing_reason"] = missing_reason
    return snapshot


def build_summary(payload: dict) -> str:
    model = ((payload.get("model") or {}).get("display_name")) or "Claude"
    rate_limits = payload.get("rate_limits") or {}

    def format_window(key: str, label: str) -> str | None:
        window = rate_limits.get(key)
        if not isinstance(window, dict):
            return None
        used = window.get("used_percentage")
        if used is None:
            return None
        try:
            return f"{label}: {float(used):.0f}%"
        except (TypeError, ValueError):
            return None

    parts = [part for part in [format_window("five_hour", "5h"), format_window("seven_day", "7d")] if part]
    if parts:
        return f"[{model}] " + " ".join(parts)
    return f"[{model}] usage snapshot active"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Read Claude Code statusline JSON from stdin, write a compact quota snapshot to disk, "
            "and print a short terminal summary for the status line."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--snapshot-path",
        type=Path,
        default=SNAPSHOT_PATH,
        help="Output path for the captured Claude statusline snapshot JSON.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    raw = sys.stdin.read()
    if not raw.strip():
        print("[Claude] statusline waiting")
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print("[Claude] statusline waiting")
        return
    snapshot = build_snapshot(payload, previous_snapshot=load_previous_snapshot(args.snapshot_path))
    args.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    args.snapshot_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(build_summary(snapshot))


if __name__ == "__main__":
    main()
