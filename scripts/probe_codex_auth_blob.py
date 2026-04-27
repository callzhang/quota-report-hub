#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_SCRIPT_DIR = REPO_ROOT / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPT_DIR))

from quota_reporters import probe_codex  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe a stored Codex auth blob by launching codex CLI and reading token_count windows."
    )
    parser.add_argument("--auth-blob-path", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    report = probe_codex(args.auth_blob_path, capture_refreshed_auth=True)
    report["hostname"] = "github-actions"
    report["reporter_name"] = f"actions@{socket.gethostname()}"
    report["auth_path"] = None
    report["model_context_window"] = report.get("model_context_window")
    report["usage_summary"] = report.get("usage_summary")
    report["error"] = report.get("error")
    report["windows"] = report.get("windows") or {"5h": None, "1week": None}
    print(json.dumps(report))


if __name__ == "__main__":
    main()
