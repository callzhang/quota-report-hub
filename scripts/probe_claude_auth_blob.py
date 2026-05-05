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
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

import pexpect


REPO_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE_SCRIPT = REPO_ROOT / "skills" / "quota-reporter" / "scripts" / "claude_statusline_probe.py"
STATUSLINE_SNAPSHOT = "statusline-rate-limits.json"
PROBE_STATUSLINE_REFRESH_SECONDS = 2
CLAUDE_ENV_DROP_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
}
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ESC_SINGLE_RE = re.compile(r"\x1b[@-_]")
ESC_78_RE = re.compile(r"\x1b[78]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
TRUST_PROMPT_RE = re.compile(r"(?:security(?:.|\n){0,80}guide|trust(?:.|\n){0,120}folder)", re.I)
THEME_PROMPT_RE = re.compile(r"(?:choose(?:.|\n){0,80}text(?:.|\n){0,80}style|syntax(?:.|\n){0,40}theme|/theme)", re.I)
LOGIN_PROMPT_RE = re.compile(
    r"(?:select(?:.|\n){0,80}login(?:.|\n){0,80}method|claude(?:.|\n){0,40}account(?:.|\n){0,80}subscription|anthropic(?:.|\n){0,40}console(?:.|\n){0,40}account)",
    re.I,
)
MAIN_PROMPT_RE = re.compile(r"❯(?:\s|$)")
USAGE_PAGE_RE = re.compile(r"(?:current\s+session|current\s+week|extra\s+usage)", re.I)


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


def parse_reset_text(reset_text: str, timezone_name: str | None, now: datetime | None = None) -> int | None:
    now = now or datetime.now(timezone.utc)
    tz = ZoneInfo(timezone_name or "UTC")
    local_now = now.astimezone(tz)
    text = re.sub(r"\s+", " ", reset_text.strip())

    time_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text, re.I)
    if not time_match:
        return None

    hour = int(time_match.group(1))
    minute = int(time_match.group(2) or "0")
    meridiem = time_match.group(3).lower()
    if meridiem == "pm" and hour != 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0

    month_match = re.search(
        r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})\b",
        text,
        re.I,
    )
    if month_match:
        month_names = {
            "jan": 1,
            "feb": 2,
            "mar": 3,
            "apr": 4,
            "may": 5,
            "jun": 6,
            "jul": 7,
            "aug": 8,
            "sep": 9,
            "sept": 9,
            "oct": 10,
            "nov": 11,
            "dec": 12,
        }
        month = month_names[month_match.group(1).lower()]
        day = int(month_match.group(2))
        candidate = datetime(local_now.year, month, day, hour, minute, tzinfo=tz)
        if candidate < local_now:
            candidate = datetime(local_now.year + 1, month, day, hour, minute, tzinfo=tz)
        return int(candidate.astimezone(timezone.utc).timestamp())

    candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate < local_now:
        candidate = candidate + timedelta(days=1)
    return int(candidate.astimezone(timezone.utc).timestamp())


def parse_usage_windows(text: str, now: datetime | None = None) -> dict:
    cleaned = normalize_terminal_text(text)
    windows = empty_windows()

    timezone_match = re.search(r"\(([^()]+/[A-Za-z_]+)\)", cleaned)
    timezone_name = timezone_match.group(1) if timezone_match else "UTC"

    def parse_section(label_pattern: str, window_key: str, window_minutes: int) -> None:
        pattern = re.compile(
            label_pattern
            + r"(?P<body>[\s\S]{0,500}?)(?P<used>\d{1,3}(?:\.\d+)?)%\s*used[\s\S]{0,180}?Resets\s+(?P<reset>[^\n\r]+)",
            re.I,
        )
        match = pattern.search(cleaned)
        if not match:
            return
        used = min(max(float(match.group("used")), 0.0), 100.0)
        reset_text = match.group("reset").split("Current ")[0].strip()
        resets_at = parse_reset_text(reset_text, timezone_name, now=now)
        if resets_at is None:
            windows[window_key] = {
                "used_percent": round(used, 1),
                "remaining_percent": round(max(0.0, 100.0 - used), 1),
                "window_minutes": window_minutes,
                "reset_in_seconds": None,
                "reset_at": None,
            }
            return
        windows[window_key] = build_window(used, resets_at, window_minutes)

    parse_section(r"Current\s+session", "5h", 300)
    parse_section(r"Current\s+week\s+\(all\s+models\)", "1week", 10080)
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
            "refreshInterval": PROBE_STATUSLINE_REFRESH_SECONDS,
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
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    state_path.chmod(0o600)


def normalize_terminal_text(text: str) -> str:
    cleaned = OSC_RE.sub("", text)
    cleaned = CSI_RE.sub("", cleaned)
    cleaned = ESC_78_RE.sub("", cleaned)
    cleaned = ESC_SINGLE_RE.sub("", cleaned)
    cleaned = CONTROL_RE.sub("", cleaned)
    return cleaned


def summarize_probe_error(text: str) -> str:
    normalized = normalize_terminal_text(text or "")
    compact = re.sub(r"\s+", " ", normalized).strip()
    lowered = compact.lower()
    lowered_flat = re.sub(r"\s+", "", lowered)
    if not compact:
        return "claude statusline snapshot was not produced"
    if "trust this folder" in lowered or "security guide" in lowered or "trustthisfolder" in lowered_flat or "securityguide" in lowered_flat:
        return "claude probe stalled at trust prompt"
    if "choose the text style" in lowered or "syntax theme" in lowered or "/theme" in lowered or "choosethetextstyle" in lowered_flat or "syntaxtheme" in lowered_flat:
        return "claude probe stalled at theme prompt"
    if "select login method" in lowered or "claude account with subscription" in lowered or "anthropic console account" in lowered or "selectloginmethod" in lowered_flat or "claudeaccountwithsubscription" in lowered_flat or "anthropicconsoleaccount" in lowered_flat:
        return "claude probe stalled at login prompt"
    if (
        "welcome back" in lowered
        or "tips for getting started" in lowered
        or "claude code v" in lowered
        or "welcomeback" in lowered_flat
        or "tipsforgettingstarted" in lowered_flat
        or "claudecodev" in lowered_flat
    ):
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
        "usage_requested": False,
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

            usage_windows = parse_usage_windows("".join(output))
            if usage_windows["5h"] is not None or usage_windows["1week"] is not None:
                return usage_windows, None

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
                if not state["usage_requested"]:
                    child.send("/status")
                    time.sleep(0.5)
                    child.send("\r")
                    time.sleep(1)
                    child.send("\x1b[C")
                    time.sleep(0.2)
                    child.send("\x1b[C")
                    state["usage_requested"] = True
                    state["last_interaction_at"] = time.time()
                elif not state["prompt_sent"] and time.time() - state["last_interaction_at"] >= 6:
                    child.send("reply with ok")
                    time.sleep(0.5)
                    child.send("\r")
                    state["prompt_sent"] = True
                    state["last_interaction_at"] = time.time()
                continue
            if match_index == 4:
                if (not state["usage_requested"]) and (
                    time.time() - state["last_interaction_at"] >= 2
                ) and (time.time() + 2 < deadline):
                    child.send("/status")
                    time.sleep(0.5)
                    child.send("\r")
                    time.sleep(1)
                    child.send("\x1b[C")
                    time.sleep(0.2)
                    child.send("\x1b[C")
                    state["usage_requested"] = True
                    state["last_interaction_at"] = time.time()
                elif state["usage_requested"] and (not state["prompt_sent"]) and (
                    time.time() - state["last_interaction_at"] >= 6
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
        windows = parse_usage_windows("".join(output))
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
