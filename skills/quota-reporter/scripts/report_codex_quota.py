#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import SOURCE_AUTH_PATH, load_config, post_report, probe_codex


def codex_has_quota_windows(payload: dict) -> bool:
    windows = payload.get("windows") or {}
    return windows.get("5h") is not None and windows.get("1week") is not None


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
    if not codex_has_quota_windows(payload):
        print(
            json.dumps(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "codex quota windows unavailable",
                    "account_id": payload.get("account_id"),
                    "email": payload.get("email"),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    config = load_config(args)
    result = post_report(config["server_url"], config["ingest_token"], payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
