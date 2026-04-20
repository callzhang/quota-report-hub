#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from quota_reporters import (
    ARCHIVE_DIR,
    CLAUDE_HOME,
    SOURCE_AUTH_PATH,
    load_config,
    post_report,
    probe_archived_codex_accounts,
    probe_claude,
)

def codex_has_quota_windows(payload: dict) -> bool:
    if payload.get("source") != "codex":
        return True
    windows = payload.get("windows") or {}
    return windows.get("5h") is not None and windows.get("1week") is not None


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
    parser.add_argument("--print-payload", action="store_true")
    return parser


def collect_reports(args: argparse.Namespace) -> list[dict]:
    reports = [
        payload
        for payload in probe_archived_codex_accounts(args.codex_auth_path, args.archive_dir)
        if codex_has_quota_windows(payload)
    ]
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
