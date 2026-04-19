#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
SOURCE_AUTH_PATH = Path.home() / ".codex" / "auth.json"
CLAUDE_HOME = Path.home() / ".claude"
CODEx_PROMPT = "reply with ok"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def decode_jwt_payload(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def reporter_name() -> str:
    host = socket.gethostname()
    user = os.environ.get("USER") or getpass.getuser() or "unknown"
    return f"{user}@{host}"


def human_plan_name(plan_type: str | None) -> str | None:
    if plan_type is None:
        return None
    return {
        "free": "Free",
        "plus": "Plus",
        "pro": "Pro",
        "prolite": "Pro Lite",
        "team": "Team",
        "max": "Max",
    }.get(plan_type, plan_type)


def auth_metadata(path: Path) -> dict:
    payload = read_json(path)
    identity = decode_jwt_payload(payload["tokens"]["id_token"])
    auth_claim = identity.get("https://api.openai.com/auth", {})
    plan_type = auth_claim.get("chatgpt_plan_type")
    return {
        "account_id": payload["tokens"]["account_id"],
        "email": identity.get("email"),
        "name": identity.get("name"),
        "plan_name": human_plan_name(plan_type),
        "auth_last_refresh": payload.get("last_refresh"),
        "auth_path": str(path),
    }


def latest_token_count_event(codex_home: Path) -> dict | None:
    rollout_files = sorted(codex_home.glob("sessions/*/*/*/rollout-*.jsonl"))
    if not rollout_files:
        return None
    rollout = rollout_files[-1]
    token_event = None
    for line in rollout.read_text(encoding="utf-8").splitlines():
        payload = json.loads(line)
        if payload.get("type") == "event_msg" and payload.get("payload", {}).get("type") == "token_count":
            token_event = payload
    return token_event


def normalize_window(window: dict, now_ts: float) -> dict:
    reset_in_seconds = window.get("resets_in_seconds")
    if reset_in_seconds is None and window.get("resets_at") is not None:
        reset_in_seconds = max(int(window["resets_at"] - now_ts), 0)
    reset_at = None
    if reset_in_seconds is not None:
        reset_at = (
            datetime.fromtimestamp(now_ts + reset_in_seconds, tz=timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
    used_percent = float(window["used_percent"])
    return {
        "used_percent": used_percent,
        "remaining_percent": round(100.0 - used_percent, 1),
        "window_minutes": window["window_minutes"],
        "reset_in_seconds": reset_in_seconds,
        "reset_at": reset_at,
    }


def empty_windows() -> dict:
    return {"5h": None, "1week": None}


def probe_codex(auth_path: Path) -> dict:
    metadata = auth_metadata(auth_path)
    checked_at = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix="quota-report-") as temp_dir:
        codex_home = Path(temp_dir)
        shutil.copy2(auth_path, codex_home / "auth.json")
        env = dict(os.environ)
        env["CODEX_HOME"] = str(codex_home)
        result = subprocess.run(
            ["codex", "exec", "--skip-git-repo-check", "-C", "/tmp", CODEx_PROMPT],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        token_event = latest_token_count_event(codex_home)

    base = {
        "source": "codex",
        "hostname": socket.gethostname(),
        "reporter_name": reporter_name(),
        "reported_at": checked_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "account_id": metadata["account_id"],
        "email": metadata["email"],
        "name": metadata["name"],
        "plan_name": metadata["plan_name"],
        "auth_last_refresh": metadata["auth_last_refresh"],
        "auth_path": metadata["auth_path"],
        "usage_summary": None,
    }

    if token_event is None:
        return {
            **base,
            "status": "error",
            "error": (result.stderr.strip() or result.stdout.strip() or "codex exec failed")[:1200],
            "windows": empty_windows(),
        }

    token_payload = token_event.get("payload", {})
    info = token_payload.get("info")
    rate_limits = token_payload.get("rate_limits")
    if not info or not rate_limits or "primary" not in rate_limits or "secondary" not in rate_limits:
        return {
            **base,
            "status": "error",
            "error": "token_count event was present but missing quota details",
            "windows": empty_windows(),
        }

    now_ts = checked_at.timestamp()
    return {
        **base,
        "model_context_window": info.get("model_context_window"),
        "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
        "status": "ok",
        "windows": {
            "5h": normalize_window(rate_limits["primary"], now_ts),
            "1week": normalize_window(rate_limits["secondary"], now_ts),
        },
    }


def discover_claude_executable(claude_bin: str | None = None) -> str | None:
    if claude_bin:
        if shutil.which(claude_bin) is not None or Path(claude_bin).exists():
            return claude_bin
        return None

    bundled = Path.home() / ".local" / "bin" / "claude"
    if bundled.exists():
        return str(bundled)

    return shutil.which("claude")


def read_claude_credentials(claude_home: Path) -> dict | None:
    path = claude_home / ".credentials.json"
    if not path.exists():
        return None
    return read_json(path)


def read_claude_stats(claude_home: Path) -> dict | None:
    path = claude_home / "stats-cache.json"
    if not path.exists():
        return None
    return read_json(path)


def summarize_claude_stats(stats: dict | None) -> dict | None:
    if not stats:
        return None

    daily_activity = stats.get("dailyActivity") or []
    latest_day = daily_activity[-1] if daily_activity else None
    model_usage = stats.get("modelUsage") or {}
    total_input = sum((entry or {}).get("inputTokens", 0) for entry in model_usage.values())
    total_output = sum((entry or {}).get("outputTokens", 0) for entry in model_usage.values())
    total_cache_read = sum((entry or {}).get("cacheReadInputTokens", 0) for entry in model_usage.values())
    total_cache_write = sum((entry or {}).get("cacheCreationInputTokens", 0) for entry in model_usage.values())

    return {
        "last_computed_date": stats.get("lastComputedDate"),
        "total_sessions": stats.get("totalSessions"),
        "total_messages": stats.get("totalMessages"),
        "latest_activity_date": latest_day.get("date") if latest_day else None,
        "latest_activity_messages": latest_day.get("messageCount") if latest_day else None,
        "latest_activity_sessions": latest_day.get("sessionCount") if latest_day else None,
        "latest_activity_tool_calls": latest_day.get("toolCallCount") if latest_day else None,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read_tokens": total_cache_read,
        "total_cache_write_tokens": total_cache_write,
        "models": [
            {
                "model": name,
                "input_tokens": entry.get("inputTokens", 0),
                "output_tokens": entry.get("outputTokens", 0),
                "cache_read_tokens": entry.get("cacheReadInputTokens", 0),
                "cache_write_tokens": entry.get("cacheCreationInputTokens", 0),
                "cost_usd": entry.get("costUSD", 0),
            }
            for name, entry in sorted(model_usage.items())
        ],
    }


def claude_account_id(credentials: dict | None, auth_status: dict) -> str:
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    token = oauth.get("refreshToken") or oauth.get("accessToken")
    if token:
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
        return f"claude-oauth-{digest}"
    return f"claude-{auth_status.get('authMethod', 'unknown')}"


def probe_claude(claude_home: Path = CLAUDE_HOME, claude_bin: str | None = None) -> dict:
    claude_executable = discover_claude_executable(claude_bin)
    base = {
        "source": "claude",
        "hostname": socket.gethostname(),
        "reporter_name": reporter_name(),
        "reported_at": iso_now(),
        "email": None,
        "name": None,
        "auth_path": str(claude_home),
        "auth_last_refresh": None,
        "windows": empty_windows(),
        "model_context_window": None,
    }

    if claude_executable is None:
        return {
            **base,
            "account_id": "claude-missing-binary",
            "plan_name": None,
            "status": "error",
            "error": "claude command not found",
            "usage_summary": None,
        }

    auth_result = subprocess.run(
        [claude_executable, "auth", "status"],
        capture_output=True,
        text=True,
        check=False,
    )
    if auth_result.returncode != 0:
        return {
            **base,
            "account_id": "claude-auth-unavailable",
            "plan_name": None,
            "status": "error",
            "error": (auth_result.stderr.strip() or auth_result.stdout.strip() or "claude auth status failed")[:1200],
            "usage_summary": None,
        }

    auth_status = json.loads(auth_result.stdout)
    credentials = read_claude_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    stats = read_claude_stats(claude_home)
    summary = summarize_claude_stats(stats)

    return {
        **base,
        "account_id": claude_account_id(credentials, auth_status),
        "plan_name": human_plan_name(oauth.get("subscriptionType")) or oauth.get("subscriptionType"),
        "status": "ok" if auth_status.get("loggedIn") else "error",
        "error": None if auth_status.get("loggedIn") else "claude auth status reported loggedIn=false",
        "usage_summary": {
            "auth_method": auth_status.get("authMethod"),
            "api_provider": auth_status.get("apiProvider"),
            "subscription_type": oauth.get("subscriptionType"),
            "rate_limit_tier": oauth.get("rateLimitTier"),
            "oauth_expires_at": oauth.get("expiresAt"),
            "stats": summary,
        },
    }


def load_config(args: argparse.Namespace) -> dict:
    if getattr(args, "server_url", None) and getattr(args, "ingest_token", None):
        return {"server_url": args.server_url, "ingest_token": args.ingest_token}
    return read_json(CONFIG_PATH)


def post_report(server_url: str, ingest_token: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        server_url.rstrip("/") + "/api/report",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ingest_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))
