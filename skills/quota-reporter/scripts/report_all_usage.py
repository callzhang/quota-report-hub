#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import (
    CLAUDE_HOME,
    SOURCE_AUTH_PATH,
    load_config,
    post_report,
    probe_claude,
    probe_codex,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Report all available local agent usage sources to a shared dashboard.")
    parser.add_argument("--server-url")
    parser.add_argument("--ingest-token")
    parser.add_argument("--codex-auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--claude-home", type=Path, default=CLAUDE_HOME)
    parser.add_argument("--claude-bin")
    parser.add_argument("--print-payload", action="store_true")
    return parser


def collect_reports(args: argparse.Namespace) -> list[dict]:
    reports = []
    if args.codex_auth_path.exists():
        reports.append(probe_codex(args.codex_auth_path))
    reports.append(probe_claude(args.claude_home, args.claude_bin))
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
