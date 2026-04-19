#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import plistlib
import platform
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


LABEL = "com.openai.quota-reporter"
CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.log"
ERROR_LOG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.error.log"
CRON_MARKER = "# quota-reporter-managed"


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
        "StandardOutPath": str(LOG_PATH),
        "StandardErrorPath": str(ERROR_LOG_PATH),
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


def cron_lines(python_path: str, reporter_script: Path) -> list[str]:
    command = (
        f"{shlex.quote(python_path)} {shlex.quote(str(reporter_script))} "
        f">> {shlex.quote(str(LOG_PATH))} 2>> {shlex.quote(str(ERROR_LOG_PATH))}"
    )
    return [
        f"@reboot {command} {CRON_MARKER}",
        f"0 * * * * {command} {CRON_MARKER}",
    ]


def install_linux_crontab(python_path: str, reporter_script: Path) -> None:
    if shutil.which("crontab") is None:
        raise SystemExit("crontab command not found; install cron before running the quota reporter installer")

    existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if existing.returncode not in (0, 1):
        raise subprocess.CalledProcessError(existing.returncode, existing.args, output=existing.stdout, stderr=existing.stderr)

    preserved_lines: list[str] = []
    for line in existing.stdout.splitlines():
        if CRON_MARKER in line:
            continue
        preserved_lines.append(line)

    new_lines = preserved_lines + cron_lines(python_path, reporter_script)
    cron_payload = "\n".join(new_lines).rstrip() + "\n"
    subprocess.run(["crontab", "-"], input=cron_payload, text=True, check=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install quota reporting that survives reboot on macOS or Linux.")
    parser.add_argument("--server-url", required=True)
    parser.add_argument("--ingest-token", required=True)
    parser.add_argument("--python-path", default=sys.executable)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    reporter_script = Path(__file__).with_name("report_all_usage.py")
    write_config(args.server_url, args.ingest_token)
    system = platform.system()

    if system == "Darwin":
        write_plist(args.python_path, reporter_script)
        load_launch_agent()
        print(
            json.dumps(
                {
                    "scheduler": "launchd",
                    "label": LABEL,
                    "config_path": str(CONFIG_PATH),
                    "plist_path": str(PLIST_PATH),
                    "run_at_load": True,
                    "start_interval_seconds": 3600,
                },
                indent=2,
            )
        )
        return

    if system == "Linux":
        install_linux_crontab(args.python_path, reporter_script)
        print(
            json.dumps(
                {
                    "scheduler": "cron",
                    "config_path": str(CONFIG_PATH),
                    "log_path": str(LOG_PATH),
                    "error_log_path": str(ERROR_LOG_PATH),
                    "entries": cron_lines(args.python_path, reporter_script),
                },
                indent=2,
            )
        )
        return

    raise SystemExit(f"unsupported platform: {system}")


if __name__ == "__main__":
    main()
