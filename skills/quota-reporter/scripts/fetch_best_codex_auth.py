#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quota_reporters import KNOWN_AUTH_PATH, SOURCE_AUTH_PATH, auth_metadata, fetch_best_auth, load_config, write_known_auth_state


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch the best available Codex auth from the shared auth pool.")
    parser.add_argument("--auth-pool-url")
    parser.add_argument("--auth-pool-user-token")
    parser.add_argument("--target-auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--known-auth-path", type=Path, default=KNOWN_AUTH_PATH)
    parser.add_argument("--exclude-account-id", action="append", default=[])
    parser.add_argument("--print-only", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    config = load_config(args)
    result = fetch_best_auth(config["auth_pool_url"], config["auth_pool_user_token"], exclude_account_ids=args.exclude_account_id)

    if args.print_only:
        safe = dict(result)
        safe.pop("auth_json", None)
        print(json.dumps(safe, ensure_ascii=False, indent=2))
        return

    args.target_auth_path.parent.mkdir(parents=True, exist_ok=True)
    args.target_auth_path.write_text(result["auth_json"], encoding="utf-8")
    args.target_auth_path.chmod(0o600)
    known_auth = write_known_auth_state(
        args.target_auth_path,
        args.known_auth_path,
        last_uploaded_digest=auth_metadata(args.target_auth_path)["digest"],
        state_source="fetched_from_auth_pool",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "target_auth_path": str(args.target_auth_path),
                "account_id": result["account_id"],
                "email": result["email"],
                "plan_name": result["plan_name"],
                "latest_report": result["latest_report"],
                "known_auth": known_auth,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
