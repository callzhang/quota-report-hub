#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from quota_reporters import (
    ARCHIVE_DIR,
    CLAUDE_HOME,
    SOURCE_AUTH_PATH,
    archive_current_codex_auth,
    load_config,
    post_report,
    probe_archived_codex_accounts,
    probe_codex,
    probe_claude,
)

def codex_remaining_percent(payload: dict, window_key: str) -> float:
    window = (payload.get("windows") or {}).get(window_key) or {}
    value = window.get("remaining_percent")
    return float(value) if value is not None else -1.0


def codex_rotation_sort_key(payload: dict) -> tuple[float, float]:
    return (
        codex_remaining_percent(payload, "5h"),
        codex_remaining_percent(payload, "1week"),
    )


def maybe_rotate_codex_auth(
    codex_payloads: list[dict],
    codex_auth_path: Path,
    archive_dir: Path,
    threshold_percent: float = 20.0,
) -> dict | None:
    current_snapshot = archive_current_codex_auth(codex_auth_path, archive_dir)
    if current_snapshot is None:
        return None

    current_payload = next(
        (payload for payload in codex_payloads if payload.get("auth_path") == str(current_snapshot)),
        None,
    )
    if current_payload is None:
        current_payload = probe_codex(current_snapshot)

    current_remaining = codex_remaining_percent(current_payload, "5h")
    if current_remaining >= threshold_percent:
        return None

    candidates = [
        payload
        for payload in codex_payloads
        if payload.get("auth_path") != str(current_snapshot)
        and codex_remaining_percent(payload, "5h") >= 0
    ]
    if not candidates:
        return None

    best_payload = max(candidates, key=codex_rotation_sort_key)
    if codex_rotation_sort_key(best_payload) <= codex_rotation_sort_key(current_payload):
        return None

    shutil.copy2(best_payload["auth_path"], codex_auth_path)
    return {
        "rotated": True,
        "from_account_id": current_payload.get("account_id"),
        "to_account_id": best_payload.get("account_id"),
        "from_auth_path": current_payload.get("auth_path"),
        "to_auth_path": best_payload.get("auth_path"),
        "from_5h_remaining_percent": codex_remaining_percent(current_payload, "5h"),
        "to_5h_remaining_percent": codex_remaining_percent(best_payload, "5h"),
    }


def claude_should_report(payload: dict) -> bool:
    if payload.get("source") != "claude":
        return True
    if sys.platform != "darwin":
        return True
    windows = payload.get("windows") or {}
    return windows.get("5h") is not None and windows.get("1week") is not None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Report all available local agent usage sources to a shared dashboard.")
    parser.add_argument("--server-url")
    parser.add_argument("--ingest-token")
    parser.add_argument("--codex-auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--archive-dir", type=Path, default=ARCHIVE_DIR)
    parser.add_argument("--claude-home", type=Path, default=CLAUDE_HOME)
    parser.add_argument("--claude-bin")
    parser.add_argument("--codex-rotate-threshold-percent", type=float, default=20.0)
    parser.add_argument("--print-payload", action="store_true")
    return parser


def collect_reports(args: argparse.Namespace) -> list[dict]:
    reports = probe_archived_codex_accounts(args.codex_auth_path, args.archive_dir)
    maybe_rotate_codex_auth(
        reports,
        args.codex_auth_path,
        args.archive_dir,
        threshold_percent=args.codex_rotate_threshold_percent,
    )
    claude_payload = probe_claude(args.claude_home, args.claude_bin)
    if claude_should_report(claude_payload):
        reports.append(claude_payload)
    return reports


def main() -> None:
    args = build_parser().parse_args()
    payloads = collect_reports(args)
    if args.print_payload:
        print(json.dumps(payloads, ensure_ascii=False, indent=2))
        return

    config = load_config(args)
    results = [post_report(config["server_url"], config["ingest_token"], payload) for payload in payloads]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
