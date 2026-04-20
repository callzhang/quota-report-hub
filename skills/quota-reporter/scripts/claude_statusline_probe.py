#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


SNAPSHOT_PATH = Path.home() / ".claude" / "statusline-rate-limits.json"


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print("[Claude] statusline waiting")
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print("[Claude] statusline waiting")
        return
    snapshot = {
        "captured_at": iso_now(),
        "model": payload.get("model"),
        "workspace": payload.get("workspace"),
        "session_id": payload.get("session_id"),
        "version": payload.get("version"),
        "rate_limits": payload.get("rate_limits"),
        "context_window": payload.get("context_window"),
        "cost": payload.get("cost"),
    }
    SNAPSHOT_PATH.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(build_summary(payload))


if __name__ == "__main__":
    main()
