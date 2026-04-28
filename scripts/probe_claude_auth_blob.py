#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import socket
import sys
import tempfile
import time
import shutil
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
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ESC_SINGLE_RE = re.compile(r"\x1b[@-_]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
TRUST_PROMPT_RE = re.compile(r"(?:security(?:.|\n){0,80}guide|trust(?:.|\n){0,120}folder)", re.I)
THEME_PROMPT_RE = re.compile(r"(?:choose(?:.|\n){0,80}text(?:.|\n){0,80}style|syntax(?:.|\n){0,40}theme|/theme)", re.I)
LOGIN_PROMPT_RE = re.compile(
    r"(?:select(?:.|\n){0,80}login(?:.|\n){0,80}method|claude(?:.|\n){0,40}account(?:.|\n){0,80}subscription|anthropic(?:.|\n){0,40}console(?:.|\n){0,40}account)",
    re.I,
)
MAIN_PROMPT_RE = re.compile(r"❯(?:\s|$)")


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


def materialize_cli_state(home: Path, workdir: Path, blob: dict) -> None:
    state = blob.get("claude_cli_state")
    if not isinstance(state, dict):
        return
    state = json.loads(json.dumps(state))
    projects = state.get("projects")
    if not isinstance(projects, dict):
        projects = {}
        state["projects"] = projects
    projects[str(workdir)] = {
        "allowedTools": [],
        "mcpContextUris": [],
        "enabledMcpjsonServers": [],
        "disabledMcpjsonServers": [],
        "hasTrustDialogAccepted": True,
        "projectOnboardingSeenCount": 1,
        "hasClaudeMdExternalIncludesApproved": False,
        "hasClaudeMdExternalIncludesWarningShown": False,
    }
    state_path = home / ".claude.json"
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    state_path.chmod(0o600)


def normalize_terminal_text(text: str) -> str:
    cleaned = OSC_RE.sub("", text)
    cleaned = CSI_RE.sub("", cleaned)
    cleaned = ESC_SINGLE_RE.sub("", cleaned)
    cleaned = CONTROL_RE.sub("", cleaned)
    return cleaned


def summarize_probe_error(text: str) -> str:
    normalized = normalize_terminal_text(text or "")
    compact = re.sub(r"\s+", " ", normalized).strip()
    lowered = compact.lower()
    if not compact:
        return "claude statusline snapshot was not produced"
    if "trust this folder" in lowered or "security guide" in lowered:
        return "claude probe stalled at trust prompt"
    if "choose the text style" in lowered or "syntax theme" in lowered or "/theme" in lowered:
        return "claude probe stalled at theme prompt"
    if "select login method" in lowered or "claude account with subscription" in lowered or "anthropic console account" in lowered:
        return "claude probe stalled at login prompt"
    if "welcome back" in lowered or "tips for getting started" in lowered or "claude code v" in lowered:
        return "claude probe reached ui but no statusline snapshot was produced"
    return compact[:200]


def maybe_handle_setup_prompt(child: pexpect.spawn, text: str, state: dict) -> bool:
    lowered = normalize_terminal_text(text).lower()
    if not state["trust_handled"] and (
        "trust this folder" in lowered
        or "yes, i trust this folder" in lowered
        or "security guide" in lowered
    ):
        child.sendline("")
        state["trust_handled"] = True
        state["last_interaction_at"] = time.time()
        return True
    if not state["theme_handled"] and (
        "choose the text style" in lowered
        or "syntax theme:" in lowered
        or "/theme" in lowered
    ):
        child.sendline("1")
        state["theme_handled"] = True
        state["last_interaction_at"] = time.time()
        return True
    if not state["login_handled"] and (
        "select login method" in lowered
        or "claude account with subscription" in lowered
        or "anthropic console account" in lowered
    ):
        child.sendline("1")
        state["login_handled"] = True
        state["last_interaction_at"] = time.time()
        return True
    return False


def warm_statusline_snapshot(claude_bin: str, home: Path, workdir: Path, timeout_seconds: int) -> tuple[dict, str | None]:
    snapshot_path = home / ".claude" / STATUSLINE_SNAPSHOT
    env = clean_env(home)
    child = pexpect.spawn(claude_bin, cwd=str(workdir), env=env, encoding="utf-8", timeout=5)
    output = []
    state = {
        "prompt_sent": False,
        "trust_handled": False,
        "theme_handled": False,
        "login_handled": False,
        "last_interaction_at": time.time(),
    }
    deadline = time.time() + timeout_seconds
    error = None
    patterns = [TRUST_PROMPT_RE, THEME_PROMPT_RE, LOGIN_PROMPT_RE, MAIN_PROMPT_RE, pexpect.TIMEOUT, pexpect.EOF]

    try:
        while time.time() < deadline:
            if snapshot_path.exists():
                windows = parse_statusline_snapshot(snapshot_path)
                if windows["5h"] is not None or windows["1week"] is not None:
                    return windows, None

            match_index = child.expect(patterns, timeout=1)
            if child.before:
                output.append(child.before)
            if isinstance(child.after, str):
                output.append(child.after)

            if match_index == 0:
                child.send("\r")
                state["trust_handled"] = True
                state["last_interaction_at"] = time.time()
                continue
            if match_index == 1:
                child.sendline("1")
                state["theme_handled"] = True
                state["last_interaction_at"] = time.time()
                continue
            if match_index == 2:
                child.sendline("1")
                state["login_handled"] = True
                state["last_interaction_at"] = time.time()
                continue
            if match_index == 3:
                if not state["prompt_sent"]:
                    child.send("reply with ok")
                    time.sleep(0.5)
                    child.send("\r")
                    state["prompt_sent"] = True
                    state["last_interaction_at"] = time.time()
                continue
            if match_index == 4:
                if (not state["prompt_sent"]) and (
                    time.time() - state["last_interaction_at"] >= 2
                ) and (time.time() + 2 < deadline):
                    child.send("reply with ok")
                    time.sleep(0.5)
                    child.send("\r")
                    state["prompt_sent"] = True
                    state["last_interaction_at"] = time.time()
                continue
            if match_index == 5:
                break
        windows = parse_statusline_snapshot(snapshot_path)
        if windows["5h"] is not None or windows["1week"] is not None:
            return windows, None
        error = summarize_probe_error("".join(output))
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
    temp_dir = tempfile.mkdtemp(prefix="claude-cloud-probe-")
    try:
        home = Path(temp_dir) / "home"
        claude_home = home / ".claude"
        workdir = Path(temp_dir) / "workspace"
        workdir.mkdir(parents=True, exist_ok=True)
        materialize_credentials(claude_home, blob)
        materialize_cli_state(home, workdir, blob)
        write_settings(claude_home)
        windows, error = warm_statusline_snapshot(claude_bin, home, workdir, timeout_seconds)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

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
