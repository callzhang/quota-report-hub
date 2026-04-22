#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import KNOWN_AUTH_PATH, SOURCE_AUTH_PATH, load_config, sync_current_codex_auth_pool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Upload the current local Codex auth to the shared auth pool when it changes.")
    parser.add_argument("--auth-pool-url")
    parser.add_argument("--auth-pool-user-token")
    parser.add_argument("--auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--known-auth-path", type=Path, default=KNOWN_AUTH_PATH)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    config = load_config(args)
    result = sync_current_codex_auth_pool(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        auth_path=args.auth_path,
        known_auth_path=args.known_auth_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
