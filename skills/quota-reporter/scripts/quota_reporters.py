#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import re
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
AUTH_STATE_DIR = Path.home() / ".agents" / "auth"
ARCHIVE_DIR = AUTH_STATE_DIR
KNOWN_AUTH_PATH = AUTH_STATE_DIR / "known_auth.json"
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

def known_auth_state_for_source(state: dict | None, source: str) -> dict:
    state = state or {}
    sources = state.get("sources")
    if isinstance(sources, dict):
        value = sources.get(source)
        return value if isinstance(value, dict) else {}
    return {}


def read_known_auth_state(path: Path = KNOWN_AUTH_PATH) -> dict:
    if not path.exists():
        return {"sources": {}}
    payload = read_json(path)
    if not isinstance(payload, dict):
        return {"sources": {}}
    if not isinstance(payload.get("sources"), dict):
        payload["sources"] = {}
    return payload


def claude_auth_blob_metadata(blob_text: str) -> dict:
    payload = json.loads(blob_text)
    if payload.get("schema") != "claude_credentials_v1":
        raise ValueError("unsupported claude auth blob schema")
    return {
        "account_id": payload["account_id"],
        "email": payload.get("email"),
        "name": payload.get("name"),
        "plan_name": payload.get("plan_name"),
        "auth_last_refresh": payload.get("auth_last_refresh"),
        "auth_path": str(CLAUDE_HOME / ".credentials.json"),
        "digest": hashlib.sha256(blob_text.encode("utf-8")).hexdigest(),
        "last_refresh_sort_key": payload.get("auth_last_refresh") or "",
    }


def read_claude_cli_state(claude_home: Path = CLAUDE_HOME) -> dict | None:
    state_path = claude_home.parent / ".claude.json"
    if not state_path.exists():
        return None
    payload = read_json(state_path)
    return payload if isinstance(payload, dict) else None


def write_known_auth_state(
    *,
    source: str,
    metadata: dict,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    last_uploaded_digest: str | None,
    last_uploaded_account_id: str | None = None,
    last_uploaded_auth_last_refresh: str | None = None,
    state_source: str,
) -> dict | None:
    payload = read_known_auth_state(known_auth_path)
    source_payload = {
        "account_id": metadata["account_id"],
        "email": metadata["email"],
        "name": metadata["name"],
        "plan_name": metadata["plan_name"],
        "auth_last_refresh": metadata["auth_last_refresh"],
        "auth_path": metadata["auth_path"],
        "digest": metadata["digest"],
        "observed_at": iso_now(),
        "last_uploaded_digest": last_uploaded_digest,
        "last_uploaded_account_id": last_uploaded_account_id,
        "last_uploaded_auth_last_refresh": last_uploaded_auth_last_refresh,
        "state_source": state_source,
    }
    payload["sources"][source] = source_payload
    known_auth_path.parent.mkdir(parents=True, exist_ok=True)
    known_auth_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    known_auth_path.chmod(0o600)
    return payload["sources"][source]


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


def codex_auth_refresh_delta(before: dict, after: dict) -> dict:
    same_account = before.get("account_id") == after.get("account_id")
    refresh_changed = before.get("auth_last_refresh") != after.get("auth_last_refresh")
    digest_changed = before.get("digest") != after.get("digest")
    return {
        "same_account": same_account,
        "account_changed": not same_account,
        "refresh_changed": refresh_changed,
        "digest_changed": digest_changed,
        "refreshed": same_account and (refresh_changed or digest_changed),
    }


def codex_usage_limit_reached(rate_limits: dict | None, stderr: str, stdout: str) -> bool:
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part).lower()
    if "you've hit your usage limit" in combined:
        return True
    credits = (rate_limits or {}).get("credits") or {}
    if credits.get("has_credits") is False:
        return True
    balance = credits.get("balance")
    try:
        return balance is not None and float(balance) <= 0.0
    except (TypeError, ValueError):
        return False


def codex_usage_limit_reset_at(stderr: str, stdout: str) -> tuple[str | None, int | None]:
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part)
    match = re.search(
        r"try again at ([A-Za-z]{3} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} [AP]M)",
        combined,
        flags=re.IGNORECASE,
    )
    if not match:
        return None, None

    raw_value = re.sub(r"(\d)(st|nd|rd|th)", r"\1", match.group(1), flags=re.IGNORECASE)
    try:
        parsed = datetime.strptime(raw_value, "%b %d, %Y %I:%M %p")
    except ValueError:
        return None, None

    local_tz = datetime.now().astimezone().tzinfo
    if local_tz is None:
        return None, None
    aware = parsed.replace(tzinfo=local_tz)
    reset_at = aware.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    reset_in_seconds = max(int(aware.timestamp() - datetime.now(local_tz).timestamp()), 0)
    return reset_at, reset_in_seconds


def zero_remaining_window(window_minutes: int, reset_at: str | None = None, reset_in_seconds: int | None = None) -> dict:
    return {
        "used_percent": 100.0,
        "remaining_percent": 0.0,
        "window_minutes": window_minutes,
        "reset_in_seconds": reset_in_seconds,
        "reset_at": reset_at,
    }


def probe_codex(auth_path: Path, *, capture_refreshed_auth: bool = False) -> dict:
    metadata = auth_metadata(auth_path)
    checked_at = datetime.now(timezone.utc)
    temp_dir = tempfile.mkdtemp(prefix="quota-report-")
    refreshed_metadata = None
    refreshed_auth_text = None
    try:
        codex_home = Path(temp_dir)
        temp_auth_path = codex_home / "auth.json"
        shutil.copy2(auth_path, temp_auth_path)
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
        if capture_refreshed_auth and temp_auth_path.exists():
            refreshed_auth_text = temp_auth_path.read_text(encoding="utf-8")
            refreshed_metadata = auth_metadata(temp_auth_path)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

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

    refresh_capture = None
    if capture_refreshed_auth and refreshed_metadata is not None and refreshed_auth_text is not None:
        delta = codex_auth_refresh_delta(metadata, refreshed_metadata)
        refresh_capture = {
            "delta": delta,
            "refreshed_metadata": refreshed_metadata,
        }
        if delta["refreshed"]:
            refresh_capture["refreshed_auth_json"] = refreshed_auth_text

    if token_event is None:
        payload = {
            **base,
            "status": "error",
            "error": summarize_codex_exec_error(result.stdout, result.stderr),
            "windows": empty_windows(),
        }
        if refresh_capture is not None:
            payload["refresh_capture"] = refresh_capture
        return payload

    token_payload = token_event.get("payload", {})
    info = token_payload.get("info")
    rate_limits = token_payload.get("rate_limits")
    if rate_limits and rate_limits.get("primary") is None and rate_limits.get("secondary") is None and codex_usage_limit_reached(rate_limits, result.stderr, result.stdout):
        reset_at, reset_in_seconds = codex_usage_limit_reset_at(result.stderr, result.stdout)
        payload = {
            **base,
            "model_context_window": info.get("model_context_window") if isinstance(info, dict) else None,
            "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
            "status": "ok",
            "error": None,
            "windows": {
                "5h": zero_remaining_window(300, reset_at=reset_at, reset_in_seconds=reset_in_seconds),
                "1week": zero_remaining_window(10080, reset_at=reset_at, reset_in_seconds=reset_in_seconds),
            },
            "usage_summary": {
                "credits": rate_limits.get("credits"),
                "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                "next_retry_at": reset_at,
            },
        }
        if refresh_capture is not None:
            payload["refresh_capture"] = refresh_capture
        return payload

    if not info or not rate_limits or "primary" not in rate_limits or "secondary" not in rate_limits:
        payload = {
            **base,
            "status": "error",
            "error": "token_count event was present but missing quota details",
            "windows": empty_windows(),
        }
        if refresh_capture is not None:
            payload["refresh_capture"] = refresh_capture
        return payload

    now_ts = checked_at.timestamp()
    payload = {
        **base,
        "model_context_window": info.get("model_context_window"),
        "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
        "status": "ok",
        "windows": {
            "5h": normalize_window(rate_limits["primary"], now_ts),
            "1week": normalize_window(rate_limits["secondary"], now_ts),
        },
    }
    if refresh_capture is not None:
        payload["refresh_capture"] = refresh_capture
    return payload


def current_codex_payload(source_auth_path: Path = SOURCE_AUTH_PATH) -> dict | None:
    if not source_auth_path.exists():
        return None
    return probe_codex(source_auth_path)


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


def compact_claude_usage_summary(
    auth_status: dict,
    auth_text_details: dict,
    oauth: dict,
    statusline_snapshot: dict | None,
    stats_summary: dict | None,
    windows: dict,
) -> dict:
    summary = {
        "login_method": auth_text_details.get("login_method"),
        "organization": auth_text_details.get("organization"),
        "subscription_type": oauth.get("subscriptionType"),
        "rate_limit_tier": oauth.get("rateLimitTier"),
        "oauth_expires_at": oauth.get("expiresAt"),
        "quota_source": "statusline_snapshot" if windows["5h"] is not None or windows["1week"] is not None else "unavailable",
        "snapshot_reported_at": (statusline_snapshot or {}).get("captured_at"),
    }
    if auth_status.get("authMethod"):
        summary["auth_method"] = auth_status.get("authMethod")
    if auth_status.get("apiProvider"):
        summary["api_provider"] = auth_status.get("apiProvider")
    if stats_summary:
        summary["stats_summary"] = {
            "last_computed_date": stats_summary.get("last_computed_date"),
            "total_sessions": stats_summary.get("total_sessions"),
            "total_messages": stats_summary.get("total_messages"),
            "latest_activity_date": stats_summary.get("latest_activity_date"),
            "total_input_tokens": stats_summary.get("total_input_tokens"),
            "total_output_tokens": stats_summary.get("total_output_tokens"),
            "total_cache_read_tokens": stats_summary.get("total_cache_read_tokens"),
            "total_cache_write_tokens": stats_summary.get("total_cache_write_tokens"),
        }
    return summary


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


def claude_account_id(auth_text_details: dict | None = None) -> str:
    email = (auth_text_details or {}).get("email")
    if email:
        return f"claude-{email.lower()}"
    return "claude-email-missing"


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
    return {
        **base,
        "account_id": claude_account_id(auth_text_details),
        "email": auth_text_details.get("email"),
        "name": auth_text_details.get("organization"),
        "plan_name": human_plan_name(auth_text_details.get("subscription_type")) or human_plan_name(oauth.get("subscriptionType")) or oauth.get("subscriptionType"),
        "status": "ok" if auth_status.get("loggedIn") and auth_text_details.get("email") else "error",
        "error": (
            None
            if auth_status.get("loggedIn") and auth_text_details.get("email")
            else "claude auth email unavailable"
            if auth_status.get("loggedIn")
            else "claude auth status reported loggedIn=false"
        ),
        "windows": statusline_windows,
        "usage_summary": compact_claude_usage_summary(
            auth_status,
            auth_text_details,
            oauth,
            statusline_snapshot,
            summary,
            statusline_windows,
        ),
    }


def build_claude_auth_blob(claude_home: Path = CLAUDE_HOME, claude_bin: str | None = None) -> tuple[str | None, dict | None]:
    payload = probe_claude(claude_home, claude_bin)
    if payload.get("status") != "ok" or not payload.get("email"):
        return None, payload

    credentials, credential_source = read_claude_oauth_credentials(claude_home)
    if not credentials:
        return None, {
            **payload,
            "status": "error",
            "error": "claude credentials unavailable",
        }

    auth_last_refresh = (
        ((credentials or {}).get("claudeAiOauth") or {}).get("expiresAt")
        or payload.get("usage_summary", {}).get("oauth_expires_at")
    )
    cli_state = read_claude_cli_state(claude_home)
    blob = json.dumps(
        {
            "schema": "claude_credentials_v1",
            "account_id": payload["account_id"],
            "email": payload["email"],
            "name": payload.get("name"),
            "plan_name": payload.get("plan_name"),
            "auth_last_refresh": str(auth_last_refresh) if auth_last_refresh is not None else None,
            "credential_source": credential_source,
            "credentials": credentials,
            "claude_cli_state": cli_state,
        },
        ensure_ascii=False,
    )
    return blob, payload


def load_config(args: argparse.Namespace) -> dict:
    config = read_json(CONFIG_PATH) if CONFIG_PATH.exists() else {}
    if getattr(args, "server_url", None):
        config["server_url"] = args.server_url
    if getattr(args, "ingest_token", None):
        config["ingest_token"] = args.ingest_token
    if getattr(args, "auth_pool_url", None):
        config["auth_pool_url"] = args.auth_pool_url
    if getattr(args, "auth_pool_user_token", None):
        config["auth_pool_user_token"] = args.auth_pool_user_token
    return config


def post_auth_pool_entry(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    auth_json_text: str,
) -> dict:
    body = json.dumps(
        {
            "source": source,
            "auth_json": auth_json_text,
            "reporter_name": reporter_name(),
            "hostname": socket.gethostname(),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/upload",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def post_auth_pool_quota(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    quota_payload: dict,
) -> dict:
    body = json.dumps(
        {
            "source": source,
            "quota_payload": quota_payload,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/quota",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def sync_current_auth_pool_entry(
    *,
    source: str,
    auth_pool_url: str,
    auth_pool_user_token: str,
    auth_json_text: str,
    metadata: dict,
    known_auth_path: Path,
) -> dict:
    known = known_auth_state_for_source(read_known_auth_state(known_auth_path), source)
    already_uploaded = (
        known.get("last_uploaded_account_id") == metadata["account_id"]
        and known.get("last_uploaded_auth_last_refresh") == metadata["auth_last_refresh"]
        and known.get("last_uploaded_digest") == metadata["digest"]
    )

    if already_uploaded:
        state = write_known_auth_state(
            source=source,
            metadata=metadata,
            known_auth_path=known_auth_path,
            last_uploaded_digest=metadata["digest"],
            last_uploaded_account_id=metadata["account_id"],
            last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
            state_source="unchanged_local_auth",
        )
        return {
            "ok": True,
            "uploaded": False,
            "reason": "already_uploaded",
            "known_auth": state,
        }

    uploaded = post_auth_pool_entry(
        auth_pool_url,
        auth_pool_user_token,
        source=source,
        auth_json_text=auth_json_text,
    )
    state = write_known_auth_state(
        source=source,
        metadata=metadata,
        known_auth_path=known_auth_path,
        last_uploaded_digest=metadata["digest"],
        last_uploaded_account_id=metadata["account_id"],
        last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
        state_source="uploaded_to_auth_pool",
    )
    return {
        "ok": True,
        "uploaded": True,
        "reason": "quota_refreshed_with_same_auth" if already_uploaded else "uploaded_to_auth_pool",
        "entry": uploaded,
        "known_auth": state,
    }


def sync_current_codex_auth_pool(
    auth_pool_url: str,
    auth_pool_user_token: str,
    auth_path: Path = SOURCE_AUTH_PATH,
    known_auth_path: Path = KNOWN_AUTH_PATH,
) -> dict:
    if not auth_path.exists():
        return {"ok": True, "uploaded": False, "reason": "missing_auth"}

    metadata = auth_metadata(auth_path)
    return sync_current_auth_pool_entry(
        source="codex",
        auth_pool_url=auth_pool_url,
        auth_pool_user_token=auth_pool_user_token,
        auth_json_text=auth_path.read_text(encoding="utf-8"),
        metadata=metadata,
        known_auth_path=known_auth_path,
    )


def sync_current_claude_auth_pool(
    auth_pool_url: str,
    auth_pool_user_token: str,
    claude_home: Path = CLAUDE_HOME,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    claude_bin: str | None = None,
) -> dict:
    blob_text, payload = build_claude_auth_blob(claude_home, claude_bin)
    if blob_text is None:
        return {
            "ok": True,
            "uploaded": False,
            "reason": payload.get("error") or "missing_auth",
        }

    metadata = claude_auth_blob_metadata(blob_text)
    result = sync_current_auth_pool_entry(
        source="claude",
        auth_pool_url=auth_pool_url,
        auth_pool_user_token=auth_pool_user_token,
        auth_json_text=blob_text,
        metadata=metadata,
        known_auth_path=known_auth_path,
    )
    return result


def fetch_best_auth(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    current_account_id: str | None = None,
    current_quota: dict | None = None,
    exclude_account_ids: list[str] | None = None,
) -> dict:
    body = json.dumps(
        {
            "source": source,
            "exclude_account_ids": exclude_account_ids or [],
            "current_account_id": current_account_id,
            "current_quota": current_quota or {},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/fetch-best",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def request_auth_pool_token(auth_pool_url: str, email: str) -> dict:
    body = json.dumps({"email": email}).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/issue-token",
        data=body,
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))
