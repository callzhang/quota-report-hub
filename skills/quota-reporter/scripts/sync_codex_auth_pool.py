#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import ARCHIVE_DIR, SOURCE_AUTH_PATH, archive_current_codex_auth, load_config, sync_codex_auth_pool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Upload archived Codex auth snapshots to the shared auth pool.")
    parser.add_argument("--auth-pool-url")
    parser.add_argument("--auth-pool-token")
    parser.add_argument("--auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--archive-dir", type=Path, default=ARCHIVE_DIR)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    archive_current_codex_auth(args.auth_path, args.archive_dir)
    config = load_config(args)
    results = sync_codex_auth_pool(config["auth_pool_url"], config["auth_pool_token"], archive_dir=args.archive_dir)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
