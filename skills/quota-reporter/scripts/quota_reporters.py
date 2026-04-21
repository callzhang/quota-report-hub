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
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
ARCHIVE_DIR = Path.home() / ".agents" / "auth"
SOURCE_AUTH_PATH = Path.home() / ".codex" / "auth.json"
CLAUDE_HOME = Path.home() / ".claude"
CLAUDE_STATUSLINE_SNAPSHOT_PATH = "statusline-rate-limits.json"
CODEx_PROMPT = "reply with ok"
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com"
CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS = 10
CLAUDE_STATUS_TIMEOUT_SECONDS = 10
CLAUDE_ENV_DROP_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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


def clean_claude_env() -> dict:
    env = dict(os.environ)
    for key in CLAUDE_ENV_DROP_KEYS:
        env.pop(key, None)
    return env


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
    last_refresh = payload.get("last_refresh")
    return {
        "account_id": payload["tokens"]["account_id"],
        "email": identity.get("email"),
        "name": identity.get("name"),
        "plan_name": human_plan_name(plan_type),
        "auth_last_refresh": last_refresh,
        "auth_path": str(path),
        "digest": sha256_file(path),
        "last_refresh_sort_key": last_refresh or "",
    }


def auth_snapshot_name(metadata: dict) -> str:
    return f"auth-{metadata['account_id']}-{metadata['digest'][:12]}.json"


def archive_current_codex_auth(source_auth_path: Path = SOURCE_AUTH_PATH, archive_dir: Path = ARCHIVE_DIR) -> Path | None:
    if not source_auth_path.exists():
        return None
    metadata = auth_metadata(source_auth_path)
    archive_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = archive_dir / auth_snapshot_name(metadata)
    if not snapshot_path.exists():
        shutil.copy2(source_auth_path, snapshot_path)
    return snapshot_path


def codex_archive_files(archive_dir: Path = ARCHIVE_DIR) -> list[Path]:
    if not archive_dir.exists():
        return []
    return sorted(archive_dir.glob("auth-*.json"))


def latest_codex_snapshots_by_account(archive_dir: Path = ARCHIVE_DIR) -> list[Path]:
    latest: dict[str, tuple[tuple[str, int, str], Path]] = {}
    for path in codex_archive_files(archive_dir):
        metadata = auth_metadata(path)
        key = metadata["account_id"]
        sort_key = (
            metadata["last_refresh_sort_key"],
            path.stat().st_mtime_ns,
            metadata["digest"],
        )
        current = latest.get(key)
        if current is None or sort_key > current[0]:
            latest[key] = (sort_key, path)
    return [entry[1] for entry in sorted(latest.values(), key=lambda item: item[0], reverse=True)]


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


def summarize_codex_exec_error(stdout: str, stderr: str) -> str:
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part).strip()
    lowered = combined.lower()
    if "token_invalidated" in lowered or "your authentication token has been invalidated" in lowered:
        return "auth invalidated (token_invalidated)"
    if "401 unauthorized" in lowered:
        return "auth failed (401 unauthorized)"
    if "reading additional input from stdin" in lowered:
        cleaned = combined.replace("Reading additional input from stdin...", "").strip()
        if cleaned:
            combined = cleaned
    return (combined or "codex exec failed")[:240]


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
            "error": summarize_codex_exec_error(result.stdout, result.stderr),
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


def probe_archived_codex_accounts(
    source_auth_path: Path = SOURCE_AUTH_PATH,
    archive_dir: Path = ARCHIVE_DIR,
) -> list[dict]:
    archive_current_codex_auth(source_auth_path=source_auth_path, archive_dir=archive_dir)
    snapshots = latest_codex_snapshots_by_account(archive_dir=archive_dir)
    return [probe_codex(snapshot_path) for snapshot_path in snapshots]


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


def read_claude_oauth_credentials(claude_home: Path = CLAUDE_HOME) -> tuple[dict | None, str]:
    credentials = read_claude_credentials(claude_home)
    if credentials is not None:
        return credentials, "credentials_file"
    credentials = read_claude_keychain_credentials()
    if credentials is not None:
        return credentials, "keychain"
    return None, "unavailable"


def read_claude_stats(claude_home: Path) -> dict | None:
    path = claude_home / "stats-cache.json"
    if not path.exists():
        return None
    return read_json(path)


def read_claude_statusline_snapshot(claude_home: Path) -> dict | None:
    path = claude_home / CLAUDE_STATUSLINE_SNAPSHOT_PATH
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


def run_claude_status(claude_executable: str) -> dict:
    try:
        result = subprocess.run(
            [claude_executable, "-p", "/status"],
            env=clean_claude_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=CLAUDE_STATUS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {
            "command": "/status",
            "available": False,
            "exit_code": None,
            "text": f"/status timed out after {CLAUDE_STATUS_TIMEOUT_SECONDS}s",
        }
    text = (result.stdout.strip() or result.stderr.strip() or "")[:4000]
    unavailable = text == "/status isn't available in this environment."
    return {
        "command": "/status",
        "available": result.returncode == 0 and not unavailable and bool(text),
        "exit_code": result.returncode,
        "text": text or None,
    }


def parse_claude_auth_status_text(text: str) -> dict:
    details = {
        "login_method": None,
        "organization": None,
        "email": None,
        "subscription_type": None,
    }
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if key == "Login method":
            details["login_method"] = value
            lowered = value.lower()
            if lowered.startswith("claude ") and lowered.endswith(" account"):
                details["subscription_type"] = lowered.removeprefix("claude ").removesuffix(" account").strip()
        elif key == "Organization":
            details["organization"] = value
        elif key == "Email":
            details["email"] = value
    return details


def read_claude_keychain_credentials() -> dict | None:
    if sys.platform != "darwin":
        return None
    user = os.environ.get("USER") or getpass.getuser() or ""
    if not user:
        return None
    result = subprocess.run(
        ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-a", user, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def build_claude_window(utilization: float, resets_at: int, window_minutes: int) -> dict:
    used_percent = round(utilization * 100.0, 1)
    return {
        "used_percent": used_percent,
        "remaining_percent": round(max(0.0, 100.0 - used_percent), 1),
        "window_minutes": window_minutes,
        "reset_in_seconds": max(int(resets_at - datetime.now(timezone.utc).timestamp()), 0),
        "reset_at": datetime.fromtimestamp(resets_at, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


def parse_claude_rate_limit_headers(headers) -> dict:
    windows = empty_windows()

    def parse_window(claim_abbrev: str, window_key: str, window_minutes: int) -> dict | None:
        utilization_value = headers.get(f"anthropic-ratelimit-unified-{claim_abbrev}-utilization")
        reset_value = headers.get(f"anthropic-ratelimit-unified-{claim_abbrev}-reset")
        if utilization_value is None or reset_value is None:
            return None
        try:
            utilization = float(utilization_value)
            resets_at = int(float(reset_value))
        except (TypeError, ValueError):
            return None
        return build_claude_window(utilization, resets_at, window_minutes)

    windows["5h"] = parse_window("5h", "5h", 300)
    windows["1week"] = parse_window("7d", "1week", 10080)
    return windows


def parse_claude_statusline_rate_limits(snapshot: dict | None) -> dict:
    windows = empty_windows()
    rate_limits = (snapshot or {}).get("rate_limits") or {}

    def parse_window(window_key: str, window_minutes: int) -> dict | None:
        raw = rate_limits.get(window_key)
        if not isinstance(raw, dict):
            return None
        used_percentage = raw.get("used_percentage")
        resets_at = raw.get("resets_at")
        try:
            used_percentage = float(used_percentage)
            resets_at = int(float(resets_at))
        except (TypeError, ValueError):
            return None
        return build_claude_window(used_percentage / 100.0, resets_at, window_minutes)

    windows["5h"] = parse_window("five_hour", 300)
    windows["1week"] = parse_window("seven_day", 10080)
    return windows


def probe_claude_rate_limits(claude_home: Path = CLAUDE_HOME) -> dict:
    credentials, source = read_claude_oauth_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if token is None:
        return {
            "available": False,
            "source": source,
            "reason": "missing Claude OAuth access token",
            "base_url": CLAUDE_DEFAULT_BASE_URL,
            "windows": empty_windows(),
        }
    request = urllib.request.Request(
        CLAUDE_DEFAULT_BASE_URL + "/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request) as response:
            headers = response.headers
            status_code = getattr(response, "status", None) or response.getcode()
            response_body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        headers = exc.headers
        status_code = exc.code
        response_body = exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return {
            "available": False,
            "source": "keychain",
            "reason": str(exc)[:400],
            "base_url": CLAUDE_DEFAULT_BASE_URL,
            "windows": empty_windows(),
        }

    try:
        payload = json.loads(response_body) if response_body else {}
    except json.JSONDecodeError:
        payload = {}
    windows = parse_claude_rate_limit_headers(headers)
    return {
        "available": windows["5h"] is not None or windows["1week"] is not None,
        "source": source,
        "status_code": status_code,
        "base_url": CLAUDE_DEFAULT_BASE_URL,
        "windows": windows,
        "status": headers.get("anthropic-ratelimit-unified-status"),
        "representative_claim": headers.get("anthropic-ratelimit-unified-representative-claim"),
        "overage_status": headers.get("anthropic-ratelimit-unified-overage-status"),
        "subscription_type": oauth.get("subscriptionType"),
        "rate_limit_tier": oauth.get("rateLimitTier"),
        "oauth_expires_at": oauth.get("expiresAt"),
        "api_error": ((payload.get("error") or {}).get("message") if isinstance(payload, dict) else None),
    }


def claude_account_id(credentials: dict | None, auth_status: dict, auth_text_details: dict | None = None) -> str:
    email = (auth_text_details or {}).get("email")
    if email:
        return f"claude-{email.lower()}"
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

    try:
        auth_result = subprocess.run(
            [claude_executable, "auth", "status"],
            env=clean_claude_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {
            **base,
            "account_id": "claude-auth-timeout",
            "plan_name": None,
            "status": "error",
            "error": f"claude auth status timed out after {CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS}s",
            "usage_summary": None,
        }
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
    auth_text_result = subprocess.run(
        [claude_executable, "auth", "status", "--text"],
        env=clean_claude_env(),
        capture_output=True,
        text=True,
        check=False,
        timeout=CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS,
    )
    auth_text_details = parse_claude_auth_status_text(auth_text_result.stdout if auth_text_result.returncode == 0 else "")
    credentials, _ = read_claude_oauth_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    stats = read_claude_stats(claude_home)
    statusline_snapshot = read_claude_statusline_snapshot(claude_home)
    statusline_windows = parse_claude_statusline_rate_limits(statusline_snapshot)
    summary = summarize_claude_stats(stats)
    status_command = run_claude_status(claude_executable)
    rate_limit_probe = {
        "available": statusline_windows["5h"] is not None or statusline_windows["1week"] is not None,
        "source": "statusline_snapshot",
        "snapshot_path": str(claude_home / CLAUDE_STATUSLINE_SNAPSHOT_PATH),
        "snapshot_reported_at": (statusline_snapshot or {}).get("captured_at"),
    }

    return {
        **base,
        "account_id": claude_account_id(credentials, auth_status, auth_text_details),
        "email": auth_text_details.get("email"),
        "name": auth_text_details.get("organization"),
        "plan_name": human_plan_name(auth_text_details.get("subscription_type")) or human_plan_name(oauth.get("subscriptionType")) or oauth.get("subscriptionType"),
        "status": "ok" if auth_status.get("loggedIn") else "error",
        "error": None if auth_status.get("loggedIn") else "claude auth status reported loggedIn=false",
        "windows": statusline_windows,
        "usage_summary": {
            "auth_method": auth_status.get("authMethod"),
            "api_provider": auth_status.get("apiProvider"),
            "login_method": auth_text_details.get("login_method"),
            "organization": auth_text_details.get("organization"),
            "subscription_type": oauth.get("subscriptionType"),
            "rate_limit_tier": oauth.get("rateLimitTier"),
            "oauth_expires_at": oauth.get("expiresAt"),
            "quota_status": status_command,
            "rate_limit_probe": rate_limit_probe,
            "statusline_snapshot": {
                "has_rate_limits": rate_limit_probe["available"],
                "captured_at": (statusline_snapshot or {}).get("captured_at"),
                "raw_rate_limits": (statusline_snapshot or {}).get("rate_limits"),
            },
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
