#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json

from quota_reporters import request_auth_pool_token


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Request a personal auth-pool token by company email.")
    parser.add_argument("--auth-pool-url", required=True)
    parser.add_argument("--email", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    result = request_auth_pool_token(args.auth_pool_url, args.email)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
