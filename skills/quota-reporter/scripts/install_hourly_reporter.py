#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path


LABEL = "com.openai.quota-reporter"
CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def write_config(server_url: str, ingest_token: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(
            {
                "server_url": server_url,
                "ingest_token": ingest_token,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def write_plist(python_path: str, reporter_script: Path) -> None:
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [
            python_path,
            str(reporter_script),
        ],
        "StartInterval": 3600,
        "RunAtLoad": True,
        "StandardOutPath": str(Path.home() / ".agents" / "auth" / "quota-reporter.log"),
        "StandardErrorPath": str(Path.home() / ".agents" / "auth" / "quota-reporter.error.log"),
        "EnvironmentVariables": {
            "PATH": os.environ.get("PATH", ""),
        },
    }
    with PLIST_PATH.open("wb") as handle:
        plistlib.dump(payload, handle)


def load_launch_agent() -> None:
    uid = str(os.getuid())
    service = f"gui/{uid}/{LABEL}"
    existing = subprocess.run(["launchctl", "print", service], capture_output=True, text=True)
    if existing.returncode == 0:
        subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(PLIST_PATH)], check=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST_PATH)], check=True)
    subprocess.run(["launchctl", "kickstart", "-k", service], check=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install hourly quota reporting via launchd.")
    parser.add_argument("--server-url", required=True)
    parser.add_argument("--ingest-token", required=True)
    parser.add_argument("--python-path", default=sys.executable)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    reporter_script = Path(__file__).with_name("report_codex_quota.py")
    write_config(args.server_url, args.ingest_token)
    write_plist(args.python_path, reporter_script)
    load_launch_agent()
    print(json.dumps({"label": LABEL, "config_path": str(CONFIG_PATH), "plist_path": str(PLIST_PATH)}, indent=2))


if __name__ == "__main__":
    main()
