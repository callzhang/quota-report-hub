#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import SOURCE_AUTH_PATH, load_config, post_report, probe_codex


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Report local Codex quota to a shared dashboard.")
    parser.add_argument("--server-url")
    parser.add_argument("--ingest-token")
    parser.add_argument("--auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--print-payload", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = probe_codex(args.auth_path)
    if args.print_payload:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    config = load_config(args)
    result = post_report(config["server_url"], config["ingest_token"], payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
