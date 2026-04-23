#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pexpect


REPO_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE_SCRIPT = REPO_ROOT / "skills" / "quota-reporter" / "scripts" / "claude_statusline_probe.py"
STATUSLINE_SNAPSHOT = "statusline-rate-limits.json"
CLAUDE_ENV_DROP_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def empty_windows() -> dict:
    return {"5h": None, "1week": None}


def build_window(used_percentage: float, resets_at: int, window_minutes: int) -> dict:
    return {
        "used_percent": round(float(used_percentage), 1),
        "remaining_percent": round(max(0.0, 100.0 - float(used_percentage)), 1),
        "window_minutes": window_minutes,
        "reset_in_seconds": max(int(resets_at - datetime.now(timezone.utc).timestamp()), 0),
        "reset_at": datetime.fromtimestamp(resets_at, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


def parse_statusline_snapshot(snapshot_path: Path) -> dict:
    if not snapshot_path.exists():
        return empty_windows()
    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    rate_limits = payload.get("rate_limits") or {}
    windows = empty_windows()
    five_hour = rate_limits.get("five_hour")
    seven_day = rate_limits.get("seven_day")
    if isinstance(five_hour, dict) and five_hour.get("used_percentage") is not None and five_hour.get("resets_at") is not None:
        windows["5h"] = build_window(float(five_hour["used_percentage"]), int(float(five_hour["resets_at"])), 300)
    if isinstance(seven_day, dict) and seven_day.get("used_percentage") is not None and seven_day.get("resets_at") is not None:
        windows["1week"] = build_window(float(seven_day["used_percentage"]), int(float(seven_day["resets_at"])), 10080)
    return windows


def clean_env(home: Path) -> dict:
    env = dict(os.environ)
    env["HOME"] = str(home)
    for key in CLAUDE_ENV_DROP_KEYS:
        env.pop(key, None)
    return env


def write_settings(claude_home: Path) -> None:
    settings_path = claude_home / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings = {
        "statusLine": {
            "type": "command",
            "command": f"{shlex.quote(sys.executable)} {shlex.quote(str(STATUSLINE_SCRIPT))}",
            "refreshInterval": 60,
        }
    }
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def materialize_credentials(claude_home: Path, blob: dict) -> None:
    credentials_path = claude_home / ".credentials.json"
    credentials_path.parent.mkdir(parents=True, exist_ok=True)
    credentials_path.write_text(json.dumps(blob["credentials"], indent=2) + "\n", encoding="utf-8")
    credentials_path.chmod(0o600)


def warm_statusline_snapshot(claude_bin: str, home: Path, workdir: Path, timeout_seconds: int) -> tuple[dict, str | None]:
    snapshot_path = home / ".claude" / STATUSLINE_SNAPSHOT
    env = clean_env(home)
    child = pexpect.spawn(claude_bin, cwd=str(workdir), env=env, encoding="utf-8", timeout=5)
    output = []
    prompt_sent = False
    trust_handled = False
    deadline = time.time() + timeout_seconds
    error = None

    try:
        while time.time() < deadline:
            if snapshot_path.exists():
                windows = parse_statusline_snapshot(snapshot_path)
                if windows["5h"] is not None or windows["1week"] is not None:
                    return windows, None

            try:
                chunk = child.read_nonblocking(size=4096, timeout=1)
                if chunk:
                    output.append(chunk)
                    lowered = chunk.lower()
                    if (not trust_handled) and ("trust this folder" in lowered or "yes, i trust this folder" in lowered):
                        child.sendline("1")
                        trust_handled = True
                        continue
                    if (not prompt_sent) and ("❯" in chunk or ">" in chunk or "trust this folder" not in lowered):
                        child.sendline("reply with ok")
                        prompt_sent = True
            except pexpect.TIMEOUT:
                if not prompt_sent and time.time() + 2 < deadline:
                    child.sendline("reply with ok")
                    prompt_sent = True
            except pexpect.EOF:
                break
        windows = parse_statusline_snapshot(snapshot_path)
        if windows["5h"] is not None or windows["1week"] is not None:
            return windows, None
        error = ("".join(output).strip() or "Claude statusline snapshot was not produced")[:1200]
        return empty_windows(), error
    finally:
        try:
            child.sendcontrol("c")
        except Exception:
            pass
        try:
            child.kill(signal.SIGTERM)
        except Exception:
            pass
        try:
            child.close(force=True)
        except Exception:
            pass


def probe_blob(blob: dict, claude_bin: str, timeout_seconds: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="claude-cloud-probe-") as temp_dir:
        home = Path(temp_dir) / "home"
        claude_home = home / ".claude"
        workdir = Path(temp_dir) / "workspace"
        workdir.mkdir(parents=True, exist_ok=True)
        materialize_credentials(claude_home, blob)
        write_settings(claude_home)
        windows, error = warm_statusline_snapshot(claude_bin, home, workdir, timeout_seconds)

    return {
        "source": "claude",
        "hostname": "github-actions",
        "reporter_name": f"actions@{socket.gethostname()}",
        "reported_at": iso_now(),
        "account_id": blob["account_id"],
        "email": blob.get("email"),
        "name": blob.get("name"),
        "plan_name": blob.get("plan_name"),
        "auth_path": None,
        "auth_last_refresh": blob.get("auth_last_refresh"),
        "status": "ok" if windows["5h"] or windows["1week"] else "error",
        "error": error,
        "model_context_window": None,
        "windows": windows,
        "usage_summary": {
            "probe_source": "claude_cli_statusline",
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Probe a stored Claude auth blob by launching Claude CLI and reading its statusline snapshot.")
    parser.add_argument("--auth-blob-path", type=Path, required=True)
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--timeout-seconds", type=int, default=45)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    blob = json.loads(args.auth_blob_path.read_text(encoding="utf-8"))
    report = probe_blob(blob, args.claude_bin, args.timeout_seconds)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
