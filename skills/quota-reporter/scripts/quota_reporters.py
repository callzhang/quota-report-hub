#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import copy
import ctypes
import getpass
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from reporter_version import CLIENT_VERSION
from datetime import datetime, timedelta, timezone
from pathlib import Path


CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
AUTH_STATE_DIR = Path.home() / ".agents" / "auth"
ARCHIVE_DIR = AUTH_STATE_DIR
KNOWN_AUTH_PATH = AUTH_STATE_DIR / "known_auth.json"
TOKEN_INVALIDATED_EMAIL_STATE_PATH = AUTH_STATE_DIR / "token-invalidated-email.json"
SOURCE_AUTH_PATH = Path.home() / ".codex" / "auth.json"
CLAUDE_HOME = Path.home() / ".claude"
UNCHANGED_AUTH_REUPLOAD_INTERVAL_SECONDS = 3600
CLAUDE_STATUSLINE_SNAPSHOT_PATH = "statusline-rate-limits.json"
CODEx_PROMPT = "reply with ok"
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
CLAUDE_SAFE_STORAGE_SERVICE = "Claude Safe Storage"
CLAUDE_SAFE_STORAGE_ACCOUNTS = ("Claude", "Claude Key")
CLAUDE_TOKEN_CACHE_FIELDS = ("oauth:tokenCacheV2", "oauth:tokenCache")
CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com"
# Claude Code first-party OAuth (extracted from the claude CLI: TOKEN_URL + the
# client_id next to its oauth/code/callback). Used to refresh an expired access
# token from the stored refresh token so the probe sees real quota, not a 401.
CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CLAUDE_OAUTH_USER_AGENT = "claude-cli (quota-reporter)"
CLAUDE_TOKEN_REFRESH_SKEW_MS = 120_000
# The single value meaning "the CLI answered, and there is no usable credential". Both probe_claude
# branches emit it -- exit-zero-with-loggedIn-false, and the nonzero exit the CLI uses for the same
# state -- so the rotation rule has one value to match instead of two shapes of free text.
CLAUDE_LOGGED_OUT_ERROR = "claude auth status reported loggedIn=false"
# Placeholder refresh tokens the hub serves in disabled_refresh_token mode (must match the hub's
# lib/fetch-best.js). A local auth carrying one of these is access-token-only: never re-upload it
# (the hub would reject it anyway, and it must not overwrite the real shared refresh token).
STRIPPED_CODEX_REFRESH_TOKEN = "rt.1." + "A" * 32
STRIPPED_CLAUDE_REFRESH_TOKEN = "disabled-by-hub-refresh-token"
# A 401 seen by an AT-only client proves the ACCESS token stopped working — never that the credential
# family died. The client holds a placeholder RT, so it cannot even attempt the refresh that would
# tell the two apart; the hub holds the real RT and is the only party that can. Reporting this as
# `claude auth invalid (authentication_error)` hard-invalidated healthy accounts on one transient 401.
CLAUDE_AT_ONLY_TOKEN_REJECTED = "claude access token rejected (at-only; hub holds the RT)"
# /api/oauth/usage rate-limits the polling itself (429 + a long Retry-After). Persist a
# backoff deadline so we don't hammer it every 15-minute guard run, and stay polite even
# after a 200 by not re-polling more often than this.
CLAUDE_USAGE_BACKOFF_PATH = AUTH_STATE_DIR / "claude-usage-backoff.json"
CLAUDE_USAGE_MIN_INTERVAL_SECONDS = 1800
# `claude auth status` is fast once warm and slow on the first call after an idle stretch — measured
# 10.66s / 1.43s / 0.57s back to back on 2026-08-29. At 10s the cold call lands right on the line, and
# losing that race costs the whole run: the probe reports `claude-auth-timeout`, the guard goes
# `probe_unavailable`, and it makes no rotation decision at all until the next cycle. It had already
# done so 235 times in this machine's log. The cost of waiting is bounded and only paid when something
# is genuinely wrong, so give the cold call room.
CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS = 30
CLAUDE_STATUS_TIMEOUT_SECONDS = 30
CLAUDE_ENV_DROP_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
}
COMMON_CLI_DIRS = (
    Path.home() / ".local" / "bin",
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
)


def common_cli_binary_candidates(binary_name: str) -> list[Path]:
    return [directory / binary_name for directory in COMMON_CLI_DIRS]


def discover_cli_executable(
    binary_name: str,
    explicit_binary: str | None = None,
    *,
    fallback_to_name: bool = False,
) -> str | None:
    if explicit_binary:
        resolved = shutil.which(explicit_binary)
        if resolved is not None:
            return resolved
        explicit_path = Path(explicit_binary).expanduser()
        if explicit_path.exists():
            return str(explicit_path)
        return None

    for candidate in common_cli_binary_candidates(binary_name):
        if candidate.exists():
            return str(candidate)

    resolved = shutil.which(binary_name)
    if resolved is not None:
        return resolved
    return binary_name if fallback_to_name else None


def discover_codex_executable(codex_bin: str | None = None, *, fallback_to_name: bool = False) -> str | None:
    return discover_cli_executable("codex", codex_bin, fallback_to_name=fallback_to_name)


def runtime_cli_path(current_path: str | None = None) -> str:
    parts = [part for part in (current_path or "").split(os.pathsep) if part]
    for directory in COMMON_CLI_DIRS:
        text = str(directory)
        if text not in parts:
            parts.append(text)
    return os.pathsep.join(parts)


def _scutil_proxy_settings() -> dict:
    try:
        result = subprocess.run(
            ["scutil", "--proxy"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except Exception:
        return {}
    settings = {}
    for line in (result.stdout or "").splitlines():
        match = re.match(r"\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$", line)
        if match:
            settings[match.group(1)] = match.group(2)
    return settings


def _proxy_enabled(settings: dict, prefix: str) -> bool:
    return str(settings.get(f"{prefix}Enable", "0")).strip() == "1"


def _proxy_url(settings: dict, prefix: str, scheme: str) -> str | None:
    if not _proxy_enabled(settings, prefix):
        return None
    host = (settings.get(f"{prefix}Proxy") or "").strip()
    port = (settings.get(f"{prefix}Port") or "").strip()
    if not host:
        return None
    if port:
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def ensure_runtime_network_defaults() -> None:
    """Mirror macOS proxy/CA defaults for launchd-started non-interactive runs."""
    if platform.system() != "Darwin":
        return

    if not os.environ.get("SSL_CERT_FILE"):
        homebrew_cert = Path("/opt/homebrew/etc/openssl@3/cert.pem")
        system_cert = Path("/etc/ssl/cert.pem")
        if not homebrew_cert.exists() and system_cert.exists():
            os.environ["SSL_CERT_FILE"] = str(system_cert)

    if any(os.environ.get(key) for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")):
        return

    settings = _scutil_proxy_settings()
    http_proxy = _proxy_url(settings, "HTTP", "http")
    https_proxy = _proxy_url(settings, "HTTPS", "http")
    socks_proxy = _proxy_url(settings, "SOCKS", "socks5")
    if http_proxy:
        os.environ["HTTP_PROXY"] = http_proxy
    if https_proxy:
        os.environ["HTTPS_PROXY"] = https_proxy
    if socks_proxy:
        os.environ["ALL_PROXY"] = socks_proxy


ensure_runtime_network_defaults()


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
    env["PATH"] = runtime_cli_path(env.get("PATH"))
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


def is_excluded_free_plan(plan_name: str | None) -> bool:
    return (plan_name or "").strip().lower() == "free"


def canonical_codex_account_id(raw_account_id: str | None, email: str | None) -> str:
    normalized_email = (email or "").strip().lower()
    if normalized_email:
        return normalized_email
    return str(raw_account_id or "codex-email-missing")


def auth_metadata(path: Path) -> dict:
    payload = read_json(path)
    identity = decode_jwt_payload(payload["tokens"]["id_token"])
    auth_claim = identity.get("https://api.openai.com/auth", {})
    plan_type = auth_claim.get("chatgpt_plan_type")
    last_refresh = payload.get("last_refresh")
    provider_account_id = payload["tokens"]["account_id"]
    email = identity.get("email")
    return {
        "account_id": canonical_codex_account_id(provider_account_id, email),
        "provider_account_id": provider_account_id,
        "email": email,
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


def parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def should_reupload_unchanged_auth(known: dict, now: datetime | None = None) -> bool:
    last_reuploaded_at = parse_iso_timestamp(known.get("last_reuploaded_at"))
    if last_reuploaded_at is None:
        return True
    now = now or datetime.now(timezone.utc)
    return (now - last_reuploaded_at).total_seconds() >= UNCHANGED_AUTH_REUPLOAD_INTERVAL_SECONDS


def uploaded_entry_metadata(uploaded: dict) -> dict:
    entry = uploaded.get("entry") if isinstance(uploaded, dict) else None
    return entry if isinstance(entry, dict) else {}


def claude_auth_blob_metadata(blob_text: str) -> dict:
    payload = json.loads(blob_text)
    if payload.get("schema") != "claude_credentials_v1":
        raise ValueError("unsupported claude auth blob schema")
    return {
        "account_id": payload["account_id"],
        "session_id": payload.get("session_id"),
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


def read_claude_settings(claude_home: Path = CLAUDE_HOME) -> dict | None:
    settings_path = claude_home / "settings.json"
    if not settings_path.exists():
        return None
    payload = read_json(settings_path)
    return payload if isinstance(payload, dict) else None


def detect_claude_custom_provider_env(claude_home: Path = CLAUDE_HOME) -> dict | None:
    settings = read_claude_settings(claude_home)
    if not isinstance(settings, dict):
        return None
    for key, value in settings.items():
        if not key.startswith("env"):
            continue
        if not isinstance(value, dict):
            continue
        provider_env = {
            env_key: value.get(env_key)
            for env_key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
            if value.get(env_key)
        }
        if provider_env:
            return {
                "settings_key": key,
                "env": provider_env,
            }
    # Also honor a custom provider configured in the live process environment: an API
    # key/token, or a non-default ANTHROPIC_BASE_URL. When the machine routes Claude
    # through a custom provider, its claude.ai keychain login isn't the active auth, so
    # the pool shouldn't probe/upload it.
    env_provider = {}
    for env_key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        value = os.environ.get(env_key)
        if not value:
            continue
        if env_key == "ANTHROPIC_BASE_URL" and value.rstrip("/") == CLAUDE_DEFAULT_BASE_URL.rstrip("/"):
            continue
        env_provider[env_key] = value
    if env_provider:
        return {"settings_key": "process_env", "env": env_provider}
    return None


def write_known_auth_state(
    *,
    source: str,
    metadata: dict,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    last_uploaded_digest: str | None,
    last_uploaded_account_id: str | None = None,
    last_uploaded_auth_last_refresh: str | None = None,
    last_reuploaded_at: str | None = None,
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
        "last_reuploaded_at": last_reuploaded_at,
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


def codex_window_key_for_minutes(window_minutes) -> str | None:
    try:
        minutes = int(float(window_minutes))
    except (TypeError, ValueError):
        return None
    if minutes == 300:
        return "5h"
    if minutes == 10080:
        return "1week"
    return None


def codex_windows_from_rate_limits(rate_limits: dict | None, now_ts: float) -> dict:
    windows = empty_windows()
    if not isinstance(rate_limits, dict):
        return windows
    for raw_window in (rate_limits.get("primary"), rate_limits.get("secondary")):
        if not isinstance(raw_window, dict):
            continue
        window_key = codex_window_key_for_minutes(raw_window.get("window_minutes"))
        if window_key is None or raw_window.get("used_percent") is None:
            continue
        windows[window_key] = normalize_window(raw_window, now_ts)
    return windows


def empty_windows() -> dict:
    return {"5h": None, "1week": None}


def codex_probe_temp_root() -> Path:
    if sys.platform == "darwin":
        root = Path.home() / "Library" / "Caches" / "quota-report-hub"
    else:
        xdg_cache = os.environ.get("XDG_CACHE_HOME")
        root = Path(xdg_cache) / "quota-report-hub" if xdg_cache else Path.home() / ".cache" / "quota-report-hub"
    root.mkdir(parents=True, exist_ok=True)
    return root


CODEX_PROBE_ENV_BLOCKLIST = {
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_AUTH_TOKEN",
    "CODEX_BASE_URL",
    "CODEX_PROVIDER",
    "CODEX_MODEL_PROVIDER",
    "CHATGPT_BASE_URL",
    "CHATGPT_API_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
}


def codex_probe_env(codex_home: Path) -> dict:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in CODEX_PROBE_ENV_BLOCKLIST
    }
    env["CODEX_HOME"] = str(codex_home)
    env["PATH"] = runtime_cli_path(env.get("PATH"))
    return env


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
    if "try again at " in combined and "usage limit" in combined:
        return True
    reached_type = (rate_limits or {}).get("rate_limit_reached_type")
    return reached_type not in (None, "")


def codex_workspace_credits_exhausted(rate_limits: dict | None, stderr: str, stdout: str) -> bool:
    if not isinstance(rate_limits, dict):
        return False
    credits = rate_limits.get("credits")
    if not isinstance(credits, dict) or credits.get("has_credits") is not False:
        return False
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part).lower()
    return "workspace is out of credits" in combined


def to_float(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def codex_usage_limit_exhausted(rate_limits: dict | None, stderr: str, stdout: str) -> bool:
    if not isinstance(rate_limits, dict):
        return False

    for window_key in ("primary", "secondary"):
        window = rate_limits.get(window_key)
        if not isinstance(window, dict):
            continue
        remaining_percent = to_float(window.get("remaining_percent"))
        if remaining_percent is not None and remaining_percent <= 0:
            return True
        used_percent = to_float(window.get("used_percent"))
        if used_percent is not None and used_percent >= 100:
            return True

    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part).lower()
    if "you've hit your usage limit" in combined:
        return True
    if "usage limit" in combined and "try again at " in combined:
        return True

    return False


def codex_usage_limit_reset_at(stderr: str, stdout: str, now: datetime | None = None) -> tuple[str | None, int | None]:
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part)
    full_date_match = re.search(
        r"try again at ([A-Za-z]{3} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} [AP]M)",
        combined,
        flags=re.IGNORECASE,
    )
    local_tz = datetime.now().astimezone().tzinfo
    if local_tz is None:
        return None, None
    now_value = now.astimezone(local_tz) if now is not None and now.tzinfo is not None else (now or datetime.now(local_tz))

    if full_date_match:
        raw_value = re.sub(r"(\d)(st|nd|rd|th)", r"\1", full_date_match.group(1), flags=re.IGNORECASE)
        try:
            parsed = datetime.strptime(raw_value, "%b %d, %Y %I:%M %p")
        except ValueError:
            return None, None
        aware = parsed.replace(tzinfo=local_tz)
    else:
        time_match = re.search(r"try again at (\d{1,2}:\d{2}\s*[AP]M)", combined, flags=re.IGNORECASE)
        if not time_match:
            return None, None
        try:
            parsed_time = datetime.strptime(re.sub(r"\s+", " ", time_match.group(1).upper()), "%I:%M %p").time()
        except ValueError:
            return None, None
        aware = now_value.replace(
            hour=parsed_time.hour,
            minute=parsed_time.minute,
            second=0,
            microsecond=0,
        )
        if aware <= now_value:
            aware += timedelta(days=1)

    reset_at = aware.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    reset_in_seconds = max(int(aware.timestamp() - now_value.timestamp()), 0)
    return reset_at, reset_in_seconds


def parse_codex_reset_value(value, now: datetime) -> tuple[str | None, int | None]:
    if value is None:
        return None, None

    parsed: datetime | None = None
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp = timestamp / 1000
        parsed = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    elif isinstance(value, str) and value.strip():
        raw_value = value.strip()
        try:
            parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
        except ValueError:
            return None, None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

    if parsed is None:
        return None, None

    reset_at = parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    reset_in_seconds = max(int(parsed.timestamp() - now.timestamp()), 0)
    return reset_at, reset_in_seconds


def codex_usage_limit_reset_from_rate_limits(rate_limits: dict | None, now: datetime) -> tuple[str | None, int | None]:
    if not isinstance(rate_limits, dict):
        return None, None

    for window_key in ("primary", "secondary"):
        window = rate_limits.get(window_key)
        if not isinstance(window, dict):
            continue
        reset_in_seconds = window.get("resets_in_seconds")
        if reset_in_seconds is not None:
            try:
                seconds = max(int(float(reset_in_seconds)), 0)
            except (TypeError, ValueError):
                return None, None
            reset_at = (
                datetime.fromtimestamp(now.timestamp() + seconds, tz=timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            )
            return reset_at, seconds
        reset_at, seconds = parse_codex_reset_value(window.get("resets_at"), now)
        if reset_at is not None:
            return reset_at, seconds

    for field in ("next_retry_at", "retry_at", "reset_at"):
        reset_at, seconds = parse_codex_reset_value(rate_limits.get(field), now)
        if reset_at is not None:
            return reset_at, seconds

    return None, None


def zero_remaining_window(window_minutes: int, reset_at: str | None = None, reset_in_seconds: int | None = None) -> dict:
    return {
        "used_percent": 100.0,
        "remaining_percent": 0.0,
        "window_minutes": window_minutes,
        "reset_in_seconds": reset_in_seconds,
        "reset_at": reset_at,
    }


def codex_missing_binary_payload(base: dict) -> dict:
    return {
        **base,
        "account_id": "codex-missing-binary",
        "status": "error",
        "error": "codex command not found",
        "windows": empty_windows(),
    }


def probe_codex(auth_path: Path, *, capture_refreshed_auth: bool = False, codex_bin: str | None = None) -> dict:
    metadata = auth_metadata(auth_path)
    checked_at = datetime.now(timezone.utc)
    base = {
        "source": "codex",
        "hostname": socket.gethostname(),
        "reporter_name": reporter_name(),
        "reported_at": checked_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "account_id": metadata["account_id"],
        "provider_account_id": metadata["provider_account_id"],
        "email": metadata["email"],
        "name": metadata["name"],
        "plan_name": metadata["plan_name"],
        "auth_last_refresh": metadata["auth_last_refresh"],
        "auth_path": metadata["auth_path"],
        "usage_summary": None,
    }
    codex_command = discover_codex_executable(codex_bin, fallback_to_name=True)
    if codex_command is None:
        return codex_missing_binary_payload(base)

    temp_dir = tempfile.mkdtemp(prefix="quota-report-", dir=str(codex_probe_temp_root()))
    refreshed_metadata = None
    refreshed_auth_text = None
    try:
        codex_home = Path(temp_dir)
        workspace = codex_home / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        temp_auth_path = codex_home / "auth.json"
        shutil.copy2(auth_path, temp_auth_path)
        env = codex_probe_env(codex_home)
        result = subprocess.run(
            [
                codex_command,
                "exec",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "-C",
                str(workspace),
                CODEx_PROMPT,
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        token_event = latest_token_count_event(codex_home)
        if capture_refreshed_auth and temp_auth_path.exists():
            refreshed_auth_text = temp_auth_path.read_text(encoding="utf-8")
            refreshed_metadata = auth_metadata(temp_auth_path)
    except FileNotFoundError:
        return codex_missing_binary_payload(base)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

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
    now_ts = checked_at.timestamp()
    windows = codex_windows_from_rate_limits(rate_limits, now_ts)
    has_any_window = windows["5h"] is not None or windows["1week"] is not None
    has_complete_windows = windows["5h"] is not None and windows["1week"] is not None
    if rate_limits and not has_complete_windows and codex_workspace_credits_exhausted(rate_limits, result.stderr, result.stdout):
        payload = {
            **base,
            "model_context_window": info.get("model_context_window") if isinstance(info, dict) else None,
            "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
            "status": "ok",
            "error": "codex workspace out of credits",
            "windows": {
                "5h": zero_remaining_window(300),
                "1week": zero_remaining_window(10080),
            },
            "usage_summary": {
                "credits": rate_limits.get("credits"),
                "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                "next_retry_at": None,
            },
        }
        if refresh_capture is not None:
            payload["refresh_capture"] = refresh_capture
        return payload

    if rate_limits and not has_complete_windows and codex_usage_limit_reached(rate_limits, result.stderr, result.stdout):
        quota_exhausted = codex_usage_limit_exhausted(rate_limits, result.stderr, result.stdout)
        reset_at, reset_in_seconds = codex_usage_limit_reset_from_rate_limits(rate_limits, checked_at)
        if reset_at is None:
            reset_at, reset_in_seconds = codex_usage_limit_reset_at(result.stderr, result.stdout, now=checked_at)
        if not quota_exhausted:
            payload = {
                **base,
                "model_context_window": info.get("model_context_window") if isinstance(info, dict) else None,
                "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
                "status": "error",
                "error": "codex rate limited but quota exhaustion was not confirmed",
                "windows": empty_windows(),
                "usage_summary": {
                    "credits": rate_limits.get("credits"),
                    "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                    "next_retry_at": reset_at,
                },
            }
            if refresh_capture is not None:
                payload["refresh_capture"] = refresh_capture
            return payload
        if reset_at is None:
            payload = {
                **base,
                "model_context_window": info.get("model_context_window") if isinstance(info, dict) else None,
                "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
                "status": "error",
                "error": "codex usage limit reached but reset time was not found",
                "windows": empty_windows(),
                "usage_summary": {
                    "credits": rate_limits.get("credits"),
                    "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                    "next_retry_at": None,
                },
            }
            if refresh_capture is not None:
                payload["refresh_capture"] = refresh_capture
            return payload
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

    if not info or not rate_limits or not has_any_window:
        payload = {
            **base,
            "status": "error",
            "error": "token_count event was present but missing quota details",
            "windows": empty_windows(),
        }
        if refresh_capture is not None:
            payload["refresh_capture"] = refresh_capture
        return payload

    payload = {
        **base,
        "model_context_window": info.get("model_context_window"),
        "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
        "status": "ok",
        "windows": windows,
    }
    if refresh_capture is not None:
        payload["refresh_capture"] = refresh_capture
    return payload


def current_codex_payload(source_auth_path: Path = SOURCE_AUTH_PATH) -> dict | None:
    if not source_auth_path.exists():
        return None
    return probe_codex(source_auth_path)


def discover_claude_executable(claude_bin: str | None = None) -> str | None:
    return discover_cli_executable("claude", claude_bin)


def read_claude_credentials(claude_home: Path) -> dict | None:
    path = claude_home / ".credentials.json"
    if not path.exists():
        return None
    return read_json(path)


def claude_credentials_have_oauth(credentials: dict | None) -> bool:
    oauth = (credentials or {}).get("claudeAiOauth") if isinstance(credentials, dict) else None
    return isinstance(oauth, dict) and bool(oauth.get("accessToken"))


def claude_keychain_account_candidates() -> list[str]:
    user = os.environ.get("USER") or getpass.getuser() or ""
    candidates = ["unknown"]
    if user and user not in candidates:
        candidates.append(user)
    return candidates


def claude_application_config_path(claude_home: Path = CLAUDE_HOME) -> Path:
    return claude_home.parent / "Library" / "Application Support" / "Claude" / "config.json"


def read_claude_safe_storage_secret() -> str | None:
    if sys.platform != "darwin":
        return None
    for account in CLAUDE_SAFE_STORAGE_ACCOUNTS:
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", CLAUDE_SAFE_STORAGE_SERVICE, "-a", account, "-w"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
        except Exception:
            continue
        secret = (result.stdout or "").rstrip("\n")
        if result.returncode == 0 and secret:
            return secret
    return None


def claude_safe_storage_key(secret: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha1", secret.encode("utf-8"), b"saltysalt", 1003, 16)


def claude_common_crypto_aes_cbc_pkcs7(data: bytes, key: bytes, iv: bytes, operation: int) -> bytes:
    if sys.platform != "darwin":
        raise RuntimeError("CommonCrypto Claude token-cache decrypt is only supported on macOS")
    lib = ctypes.cdll.LoadLibrary("/usr/lib/libSystem.dylib")
    out = ctypes.create_string_buffer(len(data) + 16)
    out_len = ctypes.c_size_t(0)
    status = lib.CCCrypt(
        ctypes.c_uint32(operation),
        ctypes.c_uint32(0),  # kCCAlgorithmAES
        ctypes.c_uint32(1),  # kCCOptionPKCS7Padding
        ctypes.create_string_buffer(key),
        ctypes.c_size_t(len(key)),
        ctypes.create_string_buffer(iv),
        ctypes.create_string_buffer(data),
        ctypes.c_size_t(len(data)),
        out,
        ctypes.c_size_t(len(out)),
        ctypes.byref(out_len),
    )
    if status != 0:
        raise ValueError(f"CommonCrypto CCCrypt failed: {status}")
    return out.raw[: out_len.value]


def decrypt_claude_safe_storage_json(encoded: str, secret: str) -> dict | None:
    try:
        raw = base64.b64decode(encoded)
    except Exception:
        return None
    if not raw.startswith(b"v10"):
        return None
    try:
        plaintext = claude_common_crypto_aes_cbc_pkcs7(
            raw[3:],
            claude_safe_storage_key(secret),
            b" " * 16,
            1,  # kCCDecrypt
        )
        payload = json.loads(plaintext.decode("utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def encrypt_claude_safe_storage_json(payload: dict, secret: str) -> str | None:
    try:
        plaintext = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ciphertext = claude_common_crypto_aes_cbc_pkcs7(
            plaintext,
            claude_safe_storage_key(secret),
            b" " * 16,
            0,  # kCCEncrypt
        )
        return base64.b64encode(b"v10" + ciphertext).decode("ascii")
    except Exception:
        return None


def claude_token_cache_entry_score(cache_key: str, entry: dict) -> tuple[int, int]:
    score = 0
    if cache_key.startswith(CLAUDE_OAUTH_CLIENT_ID + ":"):
        score += 100
    if f"{CLAUDE_DEFAULT_BASE_URL}:" in cache_key:
        score += 20
    if "user:sessions:claude_code" in cache_key:
        score += 10
    if entry.get("refreshToken"):
        score += 5
    try:
        expires_at = int(entry.get("expiresAt") or 0)
    except (TypeError, ValueError):
        expires_at = 0
    return score, expires_at


def select_claude_token_cache_entry(cache: dict) -> tuple[str | None, dict | None]:
    candidates = []
    for cache_key, entry in cache.items():
        if not isinstance(cache_key, str) or not isinstance(entry, dict):
            continue
        if not entry.get("token"):
            continue
        if not entry.get("refreshToken"):
            continue
        candidates.append((claude_token_cache_entry_score(cache_key, entry), cache_key, entry))
    if not candidates:
        return None, None
    _, cache_key, entry = max(candidates, key=lambda item: item[0])
    return cache_key, entry


def claude_token_cache_scopes(cache_key: str) -> list[str]:
    marker = f"{CLAUDE_DEFAULT_BASE_URL}:"
    if marker not in cache_key:
        return []
    return [scope for scope in cache_key.split(marker, 1)[1].split() if scope]


def claude_token_cache_entry_to_credentials(cache_key: str, entry: dict) -> dict:
    oauth = {
        "accessToken": entry.get("token"),
        "refreshToken": entry.get("refreshToken"),
    }
    for key in ("expiresAt", "subscriptionType", "rateLimitTier"):
        if entry.get(key) is not None:
            oauth[key] = entry.get(key)
    scopes = claude_token_cache_scopes(cache_key)
    if scopes:
        oauth["scopes"] = scopes
    return {"claudeAiOauth": oauth}


def read_claude_token_cache_credentials(claude_home: Path = CLAUDE_HOME) -> tuple[dict | None, str]:
    if sys.platform != "darwin":
        return None, "unavailable"
    config_path = claude_application_config_path(claude_home)
    if not config_path.exists():
        return None, "unavailable"
    config = read_json(config_path)
    if not isinstance(config, dict):
        return None, "unavailable"
    secret = read_claude_safe_storage_secret()
    if not secret:
        return None, "unavailable"
    for field in CLAUDE_TOKEN_CACHE_FIELDS:
        encoded = config.get(field)
        if not isinstance(encoded, str) or not encoded:
            continue
        cache = decrypt_claude_safe_storage_json(encoded, secret)
        if not isinstance(cache, dict):
            continue
        cache_key, entry = select_claude_token_cache_entry(cache)
        if cache_key and entry:
            return claude_token_cache_entry_to_credentials(cache_key, entry), "token_cache_v2" if field.endswith("V2") else "token_cache"
    return None, "unavailable"


def write_claude_token_cache_credentials(credentials: dict, claude_home: Path, source: str) -> bool:
    if sys.platform != "darwin":
        return False
    field = "oauth:tokenCacheV2" if source == "token_cache_v2" else "oauth:tokenCache"
    config_path = claude_application_config_path(claude_home)
    if not config_path.exists():
        return False
    config = read_json(config_path)
    if not isinstance(config, dict) or not isinstance(config.get(field), str):
        return False
    secret = read_claude_safe_storage_secret()
    if not secret:
        return False
    cache = decrypt_claude_safe_storage_json(config[field], secret)
    if not isinstance(cache, dict):
        return False
    cache_key, entry = select_claude_token_cache_entry(cache)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    if not cache_key or not isinstance(entry, dict) or not oauth.get("accessToken"):
        return False
    entry["token"] = oauth["accessToken"]
    if oauth.get("refreshToken") is not None:
        entry["refreshToken"] = oauth["refreshToken"]
    for key in ("expiresAt", "subscriptionType", "rateLimitTier"):
        if oauth.get(key) is not None:
            entry[key] = oauth.get(key)
    cache[cache_key] = entry
    encoded = encrypt_claude_safe_storage_json(cache, secret)
    if not encoded:
        return False
    config[field] = encoded
    tmp_path = config_path.with_name(config_path.name + ".tmp")
    try:
        tmp_path.write_text(json.dumps(config, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(config_path)
    except Exception:
        try:
            tmp_path.unlink()
        except Exception:
            pass
        return False
    check_credentials, check_source = read_claude_token_cache_credentials(claude_home)
    check_oauth = (check_credentials or {}).get("claudeAiOauth") or {}
    return check_source == source and check_oauth.get("accessToken") == oauth.get("accessToken") and check_oauth.get("refreshToken") == oauth.get("refreshToken")


def install_claude_credentials(credentials: dict, claude_home: Path = CLAUDE_HOME) -> dict:
    """Write a Claude OAuth credential into every store Claude Code might read, and verify.

    read_claude_oauth_credentials prefers the encrypted token cache on darwin (modern Claude Code's
    source of truth), so a keychain-or-file install is SHADOWED by whatever the cache still holds:
    the write returns True, nothing changes, and the caller "installs" the same credential again
    every cycle. Write the cache too, then read back and report which store actually answers.
    """
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    written = {"token_cache_v2": False, "token_cache": False, "keychain": False, "file": False}
    if not oauth.get("accessToken"):
        return {"installed": False, "reason": "no_access_token", "written": written, "active_store": None}

    if sys.platform == "darwin":
        written["token_cache_v2"] = write_claude_token_cache_credentials(credentials, claude_home, "token_cache_v2")
        written["token_cache"] = write_claude_token_cache_credentials(credentials, claude_home, "token_cache")
        written["keychain"] = write_claude_keychain_credentials(credentials)
        if (claude_home / ".credentials.json").exists():
            written["file"] = write_claude_credentials_file(credentials, claude_home)
    else:
        written["file"] = write_claude_credentials_file(credentials, claude_home)
        written["keychain"] = write_claude_keychain_credentials(credentials)

    active_credentials, active_store = read_claude_oauth_credentials(claude_home)
    active_token = ((active_credentials or {}).get("claudeAiOauth") or {}).get("accessToken")
    installed = bool(active_token) and active_token == oauth.get("accessToken")
    result = {"installed": installed, "written": written, "active_store": active_store}
    if not installed:
        result["reason"] = "shadowed_by_" + str(active_store)
    return result


def claude_cache_entry_can_mint_inference(cache_key: str) -> bool:
    """Whether this cache entry's grant can mint an inference-capable credential for the account.

    Rotating ANY such grant revokes the access tokens the provider already issued for it — including
    the one the hub is handing out to borrowers. So every grant that can do inference has to go
    AT-only, not just the hub's own client id.

    Measured 2026-08-29: with only the hub client stripped, Claude.app re-minted within minutes and
    rotated 9-10 times in two hours, because a SECOND grant on the same account (client `a473d7bb`,
    scopes `user:inference user:profile user:sessions:claude_code`) kept a real refresh token that
    the client-id filter never touched. Stripping that grant too stopped it dead: 0 re-mints and 0
    rotations across 60 samples spanning a full guard cycle.

    Grants with no inference scope (a profile-only one, say) cannot mint a credential that competes
    with the pool. They belong to other desktop features, so leave them alone — stripping them buys
    nothing and can break something we do not own.
    """
    if not isinstance(cache_key, str):
        return False
    if cache_key.startswith(CLAUDE_OAUTH_CLIENT_ID + ":"):
        return True
    return "user:inference" in claude_token_cache_scopes(cache_key)


def count_claude_token_cache_real_refresh_tokens(claude_home: Path, field: str) -> int:
    """How many entries of one encrypted cache still hold a rotatable inference-capable refresh token."""
    if sys.platform != "darwin":
        return 0
    config_path = claude_application_config_path(claude_home)
    if not config_path.exists():
        return 0
    config = read_json(config_path)
    if not isinstance(config, dict) or not isinstance(config.get(field), str):
        return 0
    secret = read_claude_safe_storage_secret()
    if not secret:
        return 0
    cache = decrypt_claude_safe_storage_json(config[field], secret)
    if not isinstance(cache, dict):
        return 0
    total = 0
    for cache_key, entry in cache.items():
        if not isinstance(cache_key, str) or not isinstance(entry, dict):
            continue
        if not claude_cache_entry_can_mint_inference(cache_key):
            continue
        refresh_token = entry.get("refreshToken")
        if refresh_token and refresh_token != STRIPPED_CLAUDE_REFRESH_TOKEN:
            total += 1
    return total


def strip_claude_token_cache_refresh_tokens(claude_home: Path, field: str) -> dict:
    """Replace the refresh token in EVERY inference-capable entry of one encrypted token cache.

    write_claude_token_cache_credentials only rewrites the single highest-scored entry, but the
    cache routinely holds more than one entry for the hub's client id (one per scope set / base
    URL). An unstripped sibling still carries a real refresh token, which makes this machine a
    second custodian that rotates the pooled family out from under the hub — the exact death
    spiral AUTH_TOKENS.md section 3 describes. Strip them all, or the strip is cosmetic.

    Membership is decided by `claude_cache_entry_can_mint_inference`, not by client id: a different
    client's grant on the same account rotates the same family and re-mints just as effectively.
    Only the refresh token is touched; the access token in the cache is whatever Claude Code is
    using right now and must not be swapped underneath it.
    """
    outcome = {"written": False, "reason": None, "stripped_entries": 0}
    if sys.platform != "darwin":
        outcome["reason"] = "unavailable"
        return outcome
    config_path = claude_application_config_path(claude_home)
    if not config_path.exists():
        outcome["reason"] = "no_config"
        return outcome
    config = read_json(config_path)
    if not isinstance(config, dict) or not isinstance(config.get(field), str):
        outcome["reason"] = "no_field"
        return outcome
    secret = read_claude_safe_storage_secret()
    if not secret:
        outcome["reason"] = "no_secret"
        return outcome
    cache = decrypt_claude_safe_storage_json(config[field], secret)
    if not isinstance(cache, dict):
        outcome["reason"] = "undecryptable"
        return outcome

    for cache_key, entry in cache.items():
        if not isinstance(cache_key, str) or not isinstance(entry, dict):
            continue
        if not claude_cache_entry_can_mint_inference(cache_key):
            continue
        refresh_token = entry.get("refreshToken")
        if not refresh_token or refresh_token == STRIPPED_CLAUDE_REFRESH_TOKEN:
            continue
        entry["refreshToken"] = STRIPPED_CLAUDE_REFRESH_TOKEN
        cache[cache_key] = entry
        outcome["stripped_entries"] += 1
    if not outcome["stripped_entries"]:
        outcome["reason"] = "nothing_to_strip"
        return outcome

    encoded = encrypt_claude_safe_storage_json(cache, secret)
    if not encoded:
        outcome["reason"] = "encrypt_failed"
        return outcome
    config[field] = encoded
    tmp_path = config_path.with_name(config_path.name + ".tmp")
    try:
        tmp_path.write_text(json.dumps(config, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(config_path)
    except Exception:
        try:
            tmp_path.unlink()
        except Exception:
            pass
        outcome["reason"] = "write_failed"
        return outcome
    outcome["written"] = True
    return outcome


def claude_stores_with_real_refresh_token(claude_home: Path = CLAUDE_HOME) -> list[str]:
    """Every local store that still holds a rotatable (non-placeholder) Claude refresh token.

    This is the read-back the strip needs: a store left holding a real RT can refresh, and one
    refresh is enough to orphan whichever custodian holds the older generation.
    """
    def _is_real(refresh_token) -> bool:
        return bool(refresh_token) and refresh_token != STRIPPED_CLAUDE_REFRESH_TOKEN

    found = []
    if sys.platform == "darwin":
        for field in CLAUDE_TOKEN_CACHE_FIELDS:
            if count_claude_token_cache_real_refresh_tokens(claude_home, field):
                found.append("token_cache_v2" if field.endswith("V2") else "token_cache")
        keychain = read_claude_keychain_credentials()
        if _is_real(((keychain or {}).get("claudeAiOauth") or {}).get("refreshToken")):
            found.append("keychain")
    credentials = read_claude_credentials(claude_home)
    if _is_real(((credentials or {}).get("claudeAiOauth") or {}).get("refreshToken")):
        found.append("credentials_file")
    return found


def read_claude_oauth_credentials(claude_home: Path = CLAUDE_HOME) -> tuple[dict | None, str]:
    # On macOS the encrypted token cache is modern Claude Code's source of truth. A ~/.claude/.credentials.json can
    # linger and go stale (e.g. a past file-fallback write or a Phase-4 strip that landed in the
    # file): reading it first would shadow the live OAuth blob and make every downstream step
    # (probe, sync, strip) act on dead credentials. Modern Claude Code stores the real OAuth
    # record in Claude's encrypted tokenCacheV2; older builds used the keychain service directly.
    # So prefer tokenCache on darwin, then the direct keychain entry, and only fall back to the file.
    # Other platforms keep file-first (no macOS safe storage there).
    if sys.platform == "darwin":
        credentials, source = read_claude_token_cache_credentials(claude_home)
        if claude_credentials_have_oauth(credentials):
            return credentials, source
        credentials = read_claude_keychain_credentials()
        if claude_credentials_have_oauth(credentials):
            return credentials, "keychain"
        credentials = read_claude_credentials(claude_home)
        if claude_credentials_have_oauth(credentials):
            return credentials, "credentials_file"
        return None, "unavailable"
    credentials = read_claude_credentials(claude_home)
    if claude_credentials_have_oauth(credentials):
        return credentials, "credentials_file"
    credentials = read_claude_keychain_credentials()
    if claude_credentials_have_oauth(credentials):
        return credentials, "keychain"
    return None, "unavailable"


def claude_oauth_token_expired(oauth: dict, now_ms: float | None = None) -> bool:
    expires_at = oauth.get("expiresAt")
    if not isinstance(expires_at, (int, float)):
        return False
    if now_ms is None:
        now_ms = datetime.now(timezone.utc).timestamp() * 1000
    return expires_at <= now_ms + CLAUDE_TOKEN_REFRESH_SKEW_MS


def refresh_claude_oauth_token(refresh_token: str, scopes: list | None = None) -> dict:
    """Exchange a Claude refresh token for a fresh access token.

    Mirrors the claude CLI request: POST JSON {grant_type, refresh_token, client_id,
    scope} to TOKEN_URL. The `scope` field is required (omitting it returns 403).
    Returns {"ok": True, "access_token", "refresh_token", "expires_in"} on success, or
    {"ok": False, "auth_rejected": bool, "status": int|None, "error": str}. A failed
    refresh does not rotate the token, so it is safe to retry next run.
    """
    if not refresh_token:
        return {"ok": False, "auth_rejected": True, "status": None, "error": "no refresh token"}
    scope_value = " ".join(scopes) if scopes else "user:inference"
    body = json.dumps({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_OAUTH_CLIENT_ID,
        "scope": scope_value,
    }).encode("utf-8")
    request = urllib.request.Request(
        CLAUDE_OAUTH_TOKEN_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # platform.claude.com sits behind Cloudflare, which 403s the default
            # Python-urllib User-Agent (Error 1010). A CLI-style UA gets through.
            "User-Agent": CLAUDE_OAUTH_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # 400/401 = the refresh token itself is dead -> genuine, needs re-login.
        # 403 and other codes are ambiguous (WAF/infra), so treat them as transient.
        return {"ok": False, "auth_rejected": exc.code in (400, 401), "status": exc.code,
                "error": f"refresh http {exc.code}"}
    except Exception as exc:
        return {"ok": False, "auth_rejected": False, "status": None, "error": str(exc)[:200]}
    access = payload.get("access_token")
    if not access:
        return {"ok": False, "auth_rejected": False, "status": 200, "error": "no access_token in refresh response"}
    return {
        "ok": True,
        "access_token": access,
        "refresh_token": payload.get("refresh_token") or refresh_token,
        "expires_in": payload.get("expires_in"),
    }


def write_claude_keychain_credentials(credentials: dict) -> bool:
    """Write the Claude credential blob to the macOS keychain, then verify the write
    round-trips to readable JSON.

    The value MUST be compact with no trailing whitespace: a trailing newline (or any
    control byte) makes `security` store the value as binary, which it then returns
    hex-encoded and Claude Code fails to parse — silently logging the user out. We write
    compact JSON and read it back to confirm it parses and still carries the same token;
    if not, we report failure so the caller can fall back to the file.
    """
    if sys.platform != "darwin":
        return False
    blob = json.dumps(credentials, separators=(",", ":"))
    want = (credentials.get("claudeAiOauth") or {}).get("accessToken")
    if not want:
        return False
    wrote_any = False
    for account in claude_keychain_account_candidates():
        result = subprocess.run(
            ["security", "add-generic-password", "-U", "-s", CLAUDE_KEYCHAIN_SERVICE,
             "-a", account, "-w", blob],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            continue
        check = subprocess.run(
            ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            parsed = json.loads((check.stdout or "").strip())
        except Exception:
            continue  # hex-corrupted / unreadable round-trip
        got = (parsed.get("claudeAiOauth") or {}).get("accessToken")
        wrote_any = wrote_any or got == want
    return wrote_any


def write_claude_credentials_file(credentials: dict, claude_home: Path) -> bool:
    """Write the Claude credential blob to ~/.claude/.credentials.json (the credential
    store on Linux/Windows, and the macOS fallback when the keychain write fails)."""
    try:
        path = claude_home / ".credentials.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(credentials, indent=2) + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)  # best-effort; no-op / may fail on Windows
        except Exception:
            pass
        return True
    except Exception:
        return False


def persist_claude_credentials(credentials: dict, claude_home: Path, source: str) -> dict:
    """Persist refreshed credentials back to their store. Refresh rotates the refresh
    token, so a successful refresh MUST be persisted or the stored auth points at a dead
    token. macOS keychain when available (verified); otherwise the credentials file
    (Linux/Windows, or macOS fallback)."""
    written = {"keychain": False, "token_cache": False, "file": False}
    if sys.platform == "darwin" and source in ("token_cache_v2", "token_cache"):
        written["token_cache"] = write_claude_token_cache_credentials(credentials, claude_home, source)
        if written["token_cache"]:
            return written
    if sys.platform == "darwin" and source != "credentials_file":
        written["keychain"] = write_claude_keychain_credentials(credentials)
    if not written["keychain"]:
        written["file"] = write_claude_credentials_file(credentials, claude_home)
    return written


def strip_claude_refresh_token_from_all_stores(credentials: dict, claude_home: Path) -> dict:
    """Write an AT-only Claude credential to every local store that can shadow the hub RT."""
    stripped = json.loads(json.dumps(credentials))
    oauth = stripped.get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        return {"keychain": False, "token_cache": False, "token_cache_v2": False, "file": False}
    oauth["refreshToken"] = STRIPPED_CLAUDE_REFRESH_TOKEN
    stripped["claudeAiOauth"] = oauth

    written = {"keychain": False, "token_cache": False, "token_cache_v2": False, "file": False}
    if sys.platform == "darwin":
        # Strip every hub-client entry in each cache, not just the highest-scored one — a sibling
        # entry left holding a real RT is a second custodian and rotates the pooled family.
        caches = {
            field: strip_claude_token_cache_refresh_tokens(claude_home, field)
            for field in CLAUDE_TOKEN_CACHE_FIELDS
        }
        written["cache_detail"] = caches
        written["token_cache_v2"] = bool(caches.get("oauth:tokenCacheV2", {}).get("written"))
        written["token_cache"] = bool(written["token_cache_v2"] or caches.get("oauth:tokenCache", {}).get("written"))
        written["keychain"] = write_claude_keychain_credentials(stripped)
        if (claude_home / ".credentials.json").exists():
            written["file"] = write_claude_credentials_file(stripped, claude_home)
    else:
        written["file"] = write_claude_credentials_file(stripped, claude_home)
        written["keychain"] = write_claude_keychain_credentials(stripped)

    # Read back. A write returning True is not proof the store is AT-only: Claude Code holds its
    # credentials in memory and rewrites the cache on its own refresh, so a strip can be undone
    # seconds after it lands. Report what is still rotatable instead of assuming success.
    remaining = claude_stores_with_real_refresh_token(claude_home)
    written["unstripped_stores"] = remaining
    written["verified"] = not remaining
    return written


def ensure_fresh_claude_access_token(claude_home: Path = CLAUDE_HOME) -> tuple[dict | None, str, dict]:
    """Read Claude credentials; if the access token is expired, refresh it from the
    stored refresh token and persist the rotated credentials. Returns
    (credentials, source, token_refresh) where token_refresh.status is one of
    no_credentials | not_needed | refreshed | no_refresh_token | auth_rejected | transient_error."""
    credentials, source = read_claude_oauth_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        return credentials, source, {"status": "no_credentials"}
    if not claude_oauth_token_expired(oauth):
        return credentials, source, {"status": "not_needed"}
    refresh_token = oauth.get("refreshToken")
    if not refresh_token:
        return credentials, source, {"status": "no_refresh_token"}
    outcome = refresh_claude_oauth_token(refresh_token, scopes=oauth.get("scopes"))
    if not outcome.get("ok"):
        return credentials, source, {
            "status": "auth_rejected" if outcome.get("auth_rejected") else "transient_error",
            "error": outcome.get("error"),
        }
    oauth["accessToken"] = outcome["access_token"]
    oauth["refreshToken"] = outcome["refresh_token"]
    if outcome.get("expires_in"):
        now_ms = datetime.now(timezone.utc).timestamp() * 1000
        oauth["expiresAt"] = int(now_ms + float(outcome["expires_in"]) * 1000)
    credentials["claudeAiOauth"] = oauth
    persisted = persist_claude_credentials(credentials, claude_home, source)
    return credentials, source, {"status": "refreshed", "persisted": persisted}


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
    *,
    quota_source: str | None = None,
    oauth_usage_probe: dict | None = None,
) -> dict:
    summary = {
        "login_method": auth_text_details.get("login_method"),
        "organization": auth_text_details.get("organization"),
        "subscription_type": oauth.get("subscriptionType"),
        "rate_limit_tier": oauth.get("rateLimitTier"),
        "oauth_expires_at": oauth.get("expiresAt"),
        "quota_source": quota_source or ("statusline_snapshot" if windows["5h"] is not None or windows["1week"] is not None else "unavailable"),
        "snapshot_reported_at": (statusline_snapshot or {}).get("captured_at"),
    }
    if oauth_usage_probe:
        summary["oauth_usage_probe"] = {
            key: oauth_usage_probe.get(key)
            for key in (
                "available",
                "source",
                "status_code",
                "base_url",
                "status",
                "representative_claim",
                "overage_status",
                "api_error",
                "reason",
            )
            if oauth_usage_probe.get(key) is not None
        }
        token_refresh = oauth_usage_probe.get("token_refresh")
        if isinstance(token_refresh, dict):
            summary["token_refresh"] = {
                key: token_refresh.get(key)
                for key in ("status", "error")
                if token_refresh.get(key) is not None
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


def claude_session_id(credentials: dict, account_id: str) -> str:
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    session_material = oauth.get("refreshToken") or oauth.get("accessToken") or account_id
    return hashlib.sha256(str(session_material).encode("utf-8")).hexdigest()[:24]


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
    for account in claude_keychain_account_candidates():
        result = subprocess.run(
            ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            continue
        try:
            credentials = json.loads(result.stdout)
        except Exception:
            continue
        if claude_credentials_have_oauth(credentials):
            return credentials
    return None


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


def claude_retry_after_window(headers) -> dict | None:
    retry_after = headers.get("Retry-After") if headers else None
    try:
        seconds = max(int(float(retry_after)), 0)
    except (TypeError, ValueError):
        return None
    now = datetime.now(timezone.utc)
    reset_at = (
        datetime.fromtimestamp(now.timestamp() + seconds, tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    return zero_remaining_window(300, reset_at=reset_at, reset_in_seconds=seconds)


def parse_claude_statusline_rate_limits(snapshot: dict | None) -> dict:
    windows = empty_windows()
    rate_limits = (snapshot or {}).get("rate_limits") or {}
    now_ts = datetime.now(timezone.utc).timestamp()

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
        if resets_at <= now_ts:
            return None
        return build_claude_window(used_percentage / 100.0, resets_at, window_minutes)

    windows["5h"] = parse_window("five_hour", 300)
    windows["1week"] = parse_window("seven_day", 10080)
    return windows


def parse_claude_oauth_usage_body(payload: dict) -> dict:
    """Parse the /api/oauth/usage 200 JSON body — the real source Claude Code reads.

    Shape: {"five_hour": {"utilization": <0-100>, "resets_at": <ISO8601>}, "seven_day":
    {...}, ...}. Note `utilization` is already a PERCENTAGE (2.0 == 2%), and resets_at is
    an ISO timestamp string — both different from the statusline/header formats.
    """
    windows = empty_windows()
    if not isinstance(payload, dict):
        return windows
    now = datetime.now(timezone.utc)

    def parse_window(key: str, window_minutes: int) -> dict | None:
        raw = payload.get(key)
        if not isinstance(raw, dict):
            return None
        try:
            used_percent = round(float(raw.get("utilization")), 1)
        except (TypeError, ValueError):
            return None
        reset_at = None
        reset_in_seconds = None
        raw_reset = raw.get("resets_at")
        if isinstance(raw_reset, str) and raw_reset:
            try:
                reset_dt = datetime.fromisoformat(raw_reset.replace("Z", "+00:00"))
                if reset_dt.tzinfo is None:
                    reset_dt = reset_dt.replace(tzinfo=timezone.utc)
                reset_in_seconds = max(int((reset_dt - now).total_seconds()), 0)
                reset_at = reset_dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError):
                pass
        return {
            "used_percent": used_percent,
            "remaining_percent": round(max(0.0, 100.0 - used_percent), 1),
            "window_minutes": window_minutes,
            "reset_in_seconds": reset_in_seconds,
            "reset_at": reset_at,
        }

    windows["5h"] = parse_window("five_hour", 300)
    windows["1week"] = parse_window("seven_day", 10080)
    return windows


def probe_claude_rate_limits(claude_home: Path = CLAUDE_HOME) -> dict:
    credentials, source, token_refresh = ensure_fresh_claude_access_token(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if token is None:
        return {
            "available": False,
            "source": source,
            "reason": "missing Claude OAuth access token",
            "base_url": CLAUDE_DEFAULT_BASE_URL,
            "windows": empty_windows(),
            "token_refresh": token_refresh,
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
            "token_refresh": token_refresh,
        }

    try:
        payload = json.loads(response_body) if response_body else {}
    except json.JSONDecodeError:
        payload = {}
    # Primary: the JSON body (five_hour/seven_day) — that is what /api/oauth/usage
    # returns on 200 and what Claude Code itself reads. The unified rate-limit headers
    # are NOT present on these responses, so header parsing alone always came up empty.
    windows = parse_claude_oauth_usage_body(payload)
    has_unified_headers = any(
        str(name).lower().startswith("anthropic-ratelimit-unified-")
        for name in (headers.keys() if headers else [])
    )
    if windows["5h"] is None and windows["1week"] is None:
        # Fallback for responses that carry unified rate-limit headers instead of a body.
        windows = parse_claude_rate_limit_headers(headers)
    # A 429 from /api/oauth/usage that carries no unified rate-limit headers (just a
    # generic rate_limit_error + Retry-After) is the usage-info endpoint throttling our
    # polling, NOT model-usage exhaustion. Only synthesize an exhausted 5h window when
    # the 429 actually describes a model-usage rejection via unified headers; otherwise
    # report quota as unavailable so the caller falls back to the statusline snapshot
    # instead of misreporting "5h 100% used".
    usage_endpoint_throttled = (
        status_code == 429
        and not has_unified_headers
        and windows["5h"] is None
        and windows["1week"] is None
    )
    if (
        status_code == 429
        and has_unified_headers
        and windows["5h"] is None
        and windows["1week"] is None
    ):
        windows["5h"] = claude_retry_after_window(headers)
    retry_after_seconds = None
    raw_retry_after = headers.get("Retry-After") if headers else None
    if raw_retry_after is not None:
        try:
            retry_after_seconds = max(int(float(raw_retry_after)), 0)
        except (TypeError, ValueError):
            retry_after_seconds = None
    return {
        "available": windows["5h"] is not None or windows["1week"] is not None,
        "source": source,
        "status_code": status_code,
        "usage_endpoint_throttled": usage_endpoint_throttled,
        "retry_after_seconds": retry_after_seconds,
        "token_refresh": token_refresh,
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


def read_claude_usage_state(path: Path = CLAUDE_USAGE_BACKOFF_PATH) -> dict:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def read_claude_usage_backoff(path: Path = CLAUDE_USAGE_BACKOFF_PATH) -> float:
    try:
        return float(read_claude_usage_state(path).get("next_allowed_at") or 0)
    except (TypeError, ValueError):
        return 0.0


def fresh_cached_claude_usage_windows(state: dict, now_ts: float) -> dict:
    cached = state.get("windows") if isinstance(state, dict) else None
    cached = cached if isinstance(cached, dict) else {}
    windows = empty_windows()
    for key in windows:
        window = cached.get(key)
        if not isinstance(window, dict):
            continue
        reset_at = window.get("reset_at")
        if not isinstance(reset_at, str) or not reset_at:
            continue
        try:
            reset_ts = datetime.fromisoformat(reset_at.replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            continue
        if reset_ts <= now_ts:
            continue
        windows[key] = copy.deepcopy(window)
        windows[key]["reset_in_seconds"] = max(int(reset_ts - now_ts), 0)
    return windows


def write_claude_usage_backoff(
    next_allowed_at: float,
    path: Path = CLAUDE_USAGE_BACKOFF_PATH,
    *,
    windows: dict | None = None,
) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        state = {"next_allowed_at": next_allowed_at}
        if isinstance(windows, dict) and any(windows.get(key) is not None for key in ("5h", "1week")):
            state["windows"] = windows
        path.write_text(json.dumps(state) + "\n", encoding="utf-8")
    except Exception:
        pass


def run_claude_auth_status_command(claude_executable: str, args: list[str]):
    """Run a `claude auth status` variant, retrying once on timeout.

    The call is slow cold and fast warm — measured on one machine at 10.66s then 1.43s then 0.57s,
    and separately 7.09s then 2.96s — and it occasionally blows past any fixed ceiling: raising the
    timeout from 10s to 30s did not stop it losing. Losing costs the entire run, not just the quota
    reading: probe_claude bails, the guard reports `probe_unavailable`, it makes no rotation
    decision, and the account's quota goes stale on the dashboard until the next cycle. The retry
    costs a few seconds and lands on the warm path, which is the one that has never been slow.
    """
    last_timeout = None
    for _ in range(2):
        try:
            return subprocess.run(
                [claude_executable, *args],
                env=clean_claude_env(),
                capture_output=True,
                text=True,
                check=False,
                timeout=CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            last_timeout = error
    raise last_timeout


def probe_claude(
    claude_home: Path = CLAUDE_HOME,
    claude_bin: str | None = None,
    now: float | None = None,
    usage_backoff_path: Path = CLAUDE_USAGE_BACKOFF_PATH,
) -> dict:
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
        auth_result = run_claude_auth_status_command(claude_executable, ["auth", "status"])
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
        # `claude auth status` exits nonzero exactly when it is not logged in, and still prints its
        # normal JSON on stdout. That is the CLI answering the question, not failing to be asked.
        # Collapsing it into an opaque command failure buried the answer in a raw JSON blob -- which
        # then reached the owner's desktop toast verbatim -- and left the rotation rule with nothing
        # to match, so a dead AT-only credential could never trigger a fetch (SYSTEM_DESIGN.md 3.4).
        try:
            logged_out = json.loads(auth_result.stdout).get("loggedIn") is False
        except Exception:
            logged_out = False
        return {
            **base,
            "account_id": "claude-auth-unavailable",
            "plan_name": None,
            "status": "error",
            "error": CLAUDE_LOGGED_OUT_ERROR
            if logged_out
            else (auth_result.stderr.strip() or auth_result.stdout.strip() or "claude auth status failed")[:1200],
            "usage_summary": None,
        }

    auth_status = json.loads(auth_result.stdout)
    # Degrade, don't explode. This call had no timeout handling at all, so a slow `--text` raised
    # straight out of probe_claude as an opaque "claude probe failed: TimeoutExpired" — losing the
    # run even though `auth status` above had already answered. Empty details fall through to the
    # existing "claude auth email unavailable" path, which the rotation rule understands.
    try:
        auth_text_result = run_claude_auth_status_command(claude_executable, ["auth", "status", "--text"])
        auth_text_stdout = auth_text_result.stdout if auth_text_result.returncode == 0 else ""
    except subprocess.TimeoutExpired:
        auth_text_stdout = ""
    auth_text_details = parse_claude_auth_status_text(auth_text_stdout)
    cli_state = read_claude_cli_state(claude_home)
    oauth_account = (cli_state or {}).get("oauthAccount") if isinstance(cli_state, dict) else None
    if not auth_text_details.get("email") and isinstance(oauth_account, dict) and oauth_account.get("emailAddress"):
        auth_text_details["email"] = oauth_account.get("emailAddress")
    if not auth_text_details.get("organization") and isinstance(oauth_account, dict) and oauth_account.get("organizationUuid"):
        auth_text_details["organization"] = oauth_account.get("organizationUuid")
    credentials, _ = read_claude_oauth_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    stats = read_claude_stats(claude_home)
    statusline_snapshot = read_claude_statusline_snapshot(claude_home)
    statusline_windows = parse_claude_statusline_rate_limits(statusline_snapshot)
    oauth_usage_probe = None
    windows = statusline_windows
    quota_source = "statusline_snapshot" if statusline_windows["5h"] is not None or statusline_windows["1week"] is not None else "unavailable"
    # Prefer a fresh statusline snapshot (free); fall back to the /api/oauth/usage probe
    # only when the snapshot has no usable windows. Respect a 429 backoff window so we
    # don't keep hammering the usage endpoint that throttled us.
    if quota_source == "unavailable":
        now_ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        usage_state = read_claude_usage_state(usage_backoff_path)
        cached_windows = fresh_cached_claude_usage_windows(usage_state, now_ts)
        if now_ts < read_claude_usage_backoff(usage_backoff_path):
            if cached_windows["5h"] is not None or cached_windows["1week"] is not None:
                windows = cached_windows
                quota_source = "oauth_usage_cache"
            else:
                quota_source = "usage_endpoint_backoff"
        else:
            oauth_usage_probe = probe_claude_rate_limits(claude_home)
            retry_after = oauth_usage_probe.get("retry_after_seconds")
            if oauth_usage_probe.get("usage_endpoint_throttled") and retry_after:
                write_claude_usage_backoff(
                    now_ts + retry_after,
                    usage_backoff_path,
                    windows=cached_windows,
                )
            elif oauth_usage_probe.get("available"):
                # Be polite even on success: don't re-poll for a while.
                write_claude_usage_backoff(
                    now_ts + CLAUDE_USAGE_MIN_INTERVAL_SECONDS,
                    usage_backoff_path,
                    windows=oauth_usage_probe.get("windows"),
                )
            if oauth_usage_probe.get("available"):
                windows = oauth_usage_probe.get("windows") or empty_windows()
                quota_source = "oauth_usage_api"
    auth_error = None
    if oauth_usage_probe and oauth_usage_probe.get("status_code") == 401:
        # A 401 is a real auth failure only when the token couldn't be refreshed back
        # to a working one — i.e. the refresh token is gone/rejected, or a non-expired
        # token was rejected outright. A transient refresh failure (network/5xx) is not
        # proof the account died, so don't hard-invalidate it then.
        refresh_status = (oauth_usage_probe.get("token_refresh") or {}).get("status")
        local_rt = (oauth or {}).get("refreshToken")
        at_only = not local_rt or not str(local_rt).strip() or local_rt == STRIPPED_CLAUDE_REFRESH_TOKEN
        if refresh_status == "auth_rejected":
            auth_error = "refresh_token_rejected"
        elif at_only:
            # AT-only: this client has no refresh token to test, so it cannot distinguish a dead
            # credential from a request that was simply rejected. It reports "my access token
            # stopped working" and the guard asks the hub — the only holder of the real RT — for a
            # fresh one for the SAME account. Hard-invalidating here marked working accounts dead.
            auth_error = CLAUDE_AT_ONLY_TOKEN_REJECTED
        elif refresh_status != "transient_error":
            auth_error = "claude auth invalid (authentication_error)"
    summary = summarize_claude_stats(stats)
    return {
        **base,
        "account_id": claude_account_id(auth_text_details),
        "email": auth_text_details.get("email"),
        "name": auth_text_details.get("organization"),
        "plan_name": human_plan_name(auth_text_details.get("subscription_type")) or human_plan_name(oauth.get("subscriptionType")) or oauth.get("subscriptionType"),
        "status": "ok" if auth_error is None and auth_status.get("loggedIn") and auth_text_details.get("email") else "error",
        "error": (
            auth_error
            if auth_error is not None
            else None
            if auth_status.get("loggedIn") and auth_text_details.get("email")
            else "claude auth email unavailable"
            if auth_status.get("loggedIn")
            else CLAUDE_LOGGED_OUT_ERROR
        ),
        "windows": windows,
        "usage_summary": compact_claude_usage_summary(
            auth_status,
            auth_text_details,
            oauth,
            statusline_snapshot,
            summary,
            windows,
            quota_source=quota_source,
            oauth_usage_probe=oauth_usage_probe,
        ),
    }


def build_claude_auth_blob(
    claude_home: Path = CLAUDE_HOME,
    claude_bin: str | None = None,
    probed_payload: dict | None = None,
) -> tuple[str | None, dict | None]:
    payload = probed_payload if probed_payload is not None else probe_claude(claude_home, claude_bin)
    if payload.get("status") != "ok" or not payload.get("email"):
        return None, payload

    credentials, credential_source = read_claude_oauth_credentials(claude_home)
    if not credentials:
        return None, {
            **payload,
            "status": "error",
            "error": "claude credentials unavailable",
        }

    custom_provider = detect_claude_custom_provider_env(claude_home)
    settings_only_custom_provider = custom_provider is not None and custom_provider.get("settings_key") != "process_env"
    usage_summary = payload.get("usage_summary") or {}
    uploadable_official_cache = (
        credential_source in ("token_cache_v2", "token_cache", "keychain", "credentials_file")
        and usage_summary.get("api_provider") == "firstParty"
        and usage_summary.get("auth_method") == "oauth_token"
    )
    if custom_provider is not None and not (settings_only_custom_provider and uploadable_official_cache):
        return None, {
            **payload,
            "status": "error",
            "error": "claude active provider uses custom ANTHROPIC_* settings; cloud auth pool only supports direct Claude subscriptions",
            "usage_summary": {
                **(payload.get("usage_summary") or {}),
                "custom_provider_env": {
                    "settings_key": custom_provider["settings_key"],
                    "keys": sorted(custom_provider["env"].keys()),
                    "base_url": custom_provider["env"].get("ANTHROPIC_BASE_URL"),
                },
            },
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
            "session_id": claude_session_id(credentials, payload["account_id"]),
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


def persist_auth_pool_token_upgrade(payload: dict) -> dict:
    token = payload.get("auth_pool_user_token")
    if not token:
        return {"updated": False, "reason": "no_token_upgrade"}

    config = read_json(CONFIG_PATH) if CONFIG_PATH.exists() else {}
    config["auth_pool_user_token"] = token
    email = (payload.get("token_upgrade") or {}).get("email")
    if email:
        config["auth_pool_user_email"] = email
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    CONFIG_PATH.chmod(0o600)
    return {
        "updated": True,
        "email": email,
        "reason": (payload.get("token_upgrade") or {}).get("reason"),
    }


def redact_auth_pool_token(payload: dict) -> dict:
    if "auth_pool_user_token" not in payload:
        return payload
    redacted = dict(payload)
    redacted.pop("auth_pool_user_token", None)
    return redacted


def read_auth_pool_response(response) -> dict:
    payload = json.loads(response.read().decode("utf-8"))
    upgrade = persist_auth_pool_token_upgrade(payload)
    payload = redact_auth_pool_token(payload)
    if upgrade.get("updated"):
        payload["local_token_upgrade"] = upgrade
    return payload


def auth_pool_error_is_token_invalidated(payload: dict) -> bool:
    return payload.get("error") == "token_invalidated" or payload.get("reason") == "token_invalidated"


def auth_pool_email_for_token(auth_pool_user_token: str) -> str | None:
    config = read_json(CONFIG_PATH) if CONFIG_PATH.exists() else {}
    configured_email = config.get("auth_pool_user_email")
    if configured_email:
        return str(configured_email)
    if str(auth_pool_user_token or "").startswith("qrp."):
        try:
            return decode_jwt_payload(auth_pool_user_token).get("e")
        except Exception:
            return None
    return None


def request_auth_pool_token_email_once(
    auth_pool_url: str,
    auth_pool_user_token: str,
    state_path: Path | None = None,
) -> dict:
    state_path = state_path or TOKEN_INVALIDATED_EMAIL_STATE_PATH
    email = auth_pool_email_for_token(auth_pool_user_token)
    if not email:
        return {"requested": False, "reason": "email_unavailable"}
    token_digest = hashlib.sha256(str(auth_pool_user_token).encode("utf-8")).hexdigest()
    state = read_json(state_path) if state_path.exists() else {}
    if state.get("email") == email and state.get("token_digest") == token_digest:
        return {
            "requested": False,
            "reason": "already_requested",
            "email": email,
            "requested_at": state.get("requested_at"),
        }
    try:
        request_auth_pool_token(auth_pool_url, email)
    except Exception as error:
        return {
            "requested": False,
            "reason": "request_failed",
            "email": email,
            "error": str(error),
        }
    requested_at = iso_now()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "email": email,
                "token_digest": token_digest,
                "requested_at": requested_at,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    state_path.chmod(0o600)
    return {
        "requested": True,
        "reason": "requested",
        "email": email,
        "requested_at": requested_at,
    }


def read_auth_pool_http_error(
    error: urllib.error.HTTPError,
    *,
    auth_pool_url: str | None = None,
    auth_pool_user_token: str | None = None,
) -> dict:
    body = error.read().decode("utf-8", errors="replace")
    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError:
        payload = {"raw_body": body}
    result = {
        "ok": False,
        "status_code": error.code,
        "reason": "http_error",
        "error": payload.get("error") or payload.get("message") or error.reason,
        "response": payload,
    }
    if auth_pool_url and auth_pool_user_token and auth_pool_error_is_token_invalidated(payload):
        result["token_reissue_email"] = request_auth_pool_token_email_once(
            auth_pool_url,
            auth_pool_user_token,
        )
    return result


def post_auth_pool_entry(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    auth_json_text: str,
    quota_payload: dict | None = None,
) -> dict:
    upload_body = {
        "source": source,
        "auth_json": auth_json_text,
        "reporter_name": reporter_name(),
        "hostname": socket.gethostname(),
    }
    # Bundle the locally-probed quota so the hub updates quota_latest in the same request as the
    # auth — no gap where a fresh upload still shows stale quota. The server applies the same
    # acceptance rules as /api/auth/quota and ignores an incomplete/unavailable payload.
    if quota_payload is not None:
        upload_body["quota_payload"] = quota_payload
    body = json.dumps(upload_body).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/upload",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return read_auth_pool_response(response)
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(error, auth_pool_url=auth_pool_url, auth_pool_user_token=auth_pool_user_token)


def post_auth_pool_quota(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    quota_payload: dict | None = None,
    heartbeat: dict | None = None,
) -> dict:
    """Report this run to the hub. `quota_payload` is omitted when the probe produced nothing the
    hub would accept; `heartbeat` is sent either way so a machine whose probe keeps failing is
    distinguishable from a machine that is simply not running the guard."""
    request_body: dict = {"source": source}
    if quota_payload is not None:
        request_body["quota_payload"] = quota_payload
    if heartbeat is not None:
        request_body["heartbeat"] = heartbeat
    body = json.dumps(request_body).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/quota",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return read_auth_pool_response(response)
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(error, auth_pool_url=auth_pool_url, auth_pool_user_token=auth_pool_user_token)


def post_token_usage_batch(
    auth_pool_url: str,
    auth_pool_user_token: str,
    payload: dict,
) -> dict:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/token-usage",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            result = read_auth_pool_response(response)
            result.setdefault("status_code", int(getattr(response, "status", 200)))
            return result
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(
            error,
            auth_pool_url=auth_pool_url,
            auth_pool_user_token=auth_pool_user_token,
        )


def delete_auth_pool_entry(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    account_id: str,
) -> dict:
    body = json.dumps(
        {
            "source": source,
            "account_id": account_id,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/auth/delete",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_pool_user_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return read_auth_pool_response(response)
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(error, auth_pool_url=auth_pool_url, auth_pool_user_token=auth_pool_user_token)


def sync_current_auth_pool_entry(
    *,
    source: str,
    auth_pool_url: str,
    auth_pool_user_token: str,
    auth_json_text: str,
    metadata: dict,
    known_auth_path: Path,
    quota_payload: dict | None = None,
) -> dict:
    known = known_auth_state_for_source(read_known_auth_state(known_auth_path), source)
    if is_excluded_free_plan(metadata.get("plan_name")):
        deleted = delete_auth_pool_entry(
            auth_pool_url,
            auth_pool_user_token,
            source=source,
            account_id=metadata["account_id"],
        )
        if deleted.get("ok") is False:
            return {
                "ok": False,
                "uploaded": False,
                "reason": "delete_auth_pool_entry_failed",
                "delete_result": deleted,
            }
        state = write_known_auth_state(
            source=source,
            metadata=metadata,
            known_auth_path=known_auth_path,
            last_uploaded_digest=known.get("last_uploaded_digest"),
            last_uploaded_account_id=known.get("last_uploaded_account_id"),
            last_uploaded_auth_last_refresh=known.get("last_uploaded_auth_last_refresh"),
            state_source="free_plan_excluded",
        )
        return {
            "ok": True,
            "uploaded": False,
            "deleted": bool(deleted.get("deleted")),
            "reason": "free_plan_removed_from_auth_pool" if deleted.get("deleted") else "free_plan_excluded",
            "delete_result": deleted,
            "known_auth": state,
        }

    already_uploaded = (
        known.get("last_uploaded_account_id") == metadata["account_id"]
        and known.get("last_uploaded_auth_last_refresh") == metadata["auth_last_refresh"]
        and known.get("last_uploaded_digest") == metadata["digest"]
    )

    if already_uploaded:
        if not should_reupload_unchanged_auth(known):
            state = write_known_auth_state(
                source=source,
                metadata=metadata,
                known_auth_path=known_auth_path,
                last_uploaded_digest=metadata["digest"],
                last_uploaded_account_id=metadata["account_id"],
                last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
                last_reuploaded_at=known.get("last_reuploaded_at"),
                state_source="unchanged_local_auth",
            )
            return {
                "ok": True,
                "uploaded": False,
                "reason": "unchanged_auth_recently_reuploaded",
                "known_auth": state,
            }

        uploaded = post_auth_pool_entry(
            auth_pool_url,
            auth_pool_user_token,
            source=source,
            auth_json_text=auth_json_text,
            quota_payload=quota_payload,
        )
        if uploaded.get("ok") is False:
            return {
                "ok": False,
                "uploaded": False,
                "reason": "upload_auth_pool_entry_failed",
                "entry": uploaded,
            }
        uploaded_metadata = uploaded_entry_metadata(uploaded)
        server_kept_different_auth = bool(
            uploaded.get("entry", {}).get("deduplicated")
            and uploaded_metadata.get("digest")
            and uploaded_metadata.get("digest") != metadata["digest"]
        )
        state = write_known_auth_state(
            source=source,
            metadata=metadata,
            known_auth_path=known_auth_path,
            last_uploaded_digest=uploaded_metadata.get("digest") or metadata["digest"],
            last_uploaded_account_id=uploaded_metadata.get("account_id") or metadata["account_id"],
            last_uploaded_auth_last_refresh=uploaded_metadata.get("auth_last_refresh") or metadata["auth_last_refresh"],
            last_reuploaded_at=iso_now(),
            state_source="server_kept_newer_auth" if server_kept_different_auth else "unchanged_local_auth",
        )
        return {
            "ok": True,
            "uploaded": not server_kept_different_auth,
            "reason": "server_kept_newer_auth" if server_kept_different_auth else "reuploaded_existing_auth",
            "entry": uploaded,
            "known_auth": state,
        }

    uploaded = post_auth_pool_entry(
        auth_pool_url,
        auth_pool_user_token,
        source=source,
        auth_json_text=auth_json_text,
        quota_payload=quota_payload,
    )
    if uploaded.get("ok") is False:
        return {
            "ok": False,
            "uploaded": False,
            "reason": "upload_auth_pool_entry_failed",
            "entry": uploaded,
        }
    uploaded_metadata = uploaded_entry_metadata(uploaded)
    server_kept_different_auth = bool(
        uploaded.get("entry", {}).get("deduplicated")
        and uploaded_metadata.get("digest")
        and uploaded_metadata.get("digest") != metadata["digest"]
    )
    state = write_known_auth_state(
        source=source,
        metadata=metadata,
        known_auth_path=known_auth_path,
        last_uploaded_digest=uploaded_metadata.get("digest") or metadata["digest"],
        last_uploaded_account_id=uploaded_metadata.get("account_id") or metadata["account_id"],
        last_uploaded_auth_last_refresh=uploaded_metadata.get("auth_last_refresh") or metadata["auth_last_refresh"],
        last_reuploaded_at=iso_now(),
        state_source="server_kept_newer_auth" if server_kept_different_auth else "uploaded_to_auth_pool",
    )
    return {
        "ok": True,
        "uploaded": not server_kept_different_auth,
        "reason": "server_kept_newer_auth" if server_kept_different_auth else "uploaded_to_auth_pool",
        "entry": uploaded,
        "known_auth": state,
    }


def auth_json_is_stripped(source: str, auth_json_text: str) -> bool:
    """True when a local auth blob has no usable real refresh token (hub placeholder OR empty/absent),
    so it must not be re-uploaded into the shared pool — uploading it would overwrite the real shared
    RT with nothing. The Claude Desktop app rewrites the CLI keychain credential access-token-only
    (refreshToken=""), so empty/absent must count as stripped too, not just the literal placeholder."""
    try:
        parsed = json.loads(auth_json_text)
    except Exception:
        return False

    def _no_usable_rt(rt, placeholder):
        return not rt or not str(rt).strip() or rt == placeholder

    if source == "codex":
        return _no_usable_rt((parsed.get("tokens") or {}).get("refresh_token"), STRIPPED_CODEX_REFRESH_TOKEN)
    if source == "claude":
        oauth = (parsed.get("credentials") or {}).get("claudeAiOauth") or {}
        return _no_usable_rt(oauth.get("refreshToken"), STRIPPED_CLAUDE_REFRESH_TOKEN)
    return False


# --- Seed-state detection -------------------------------------------------------------------------
# Classify the local CLI-lane (guard-managed) credential for a source so the installer/guard can guide
# one-time seeding. Only the CLI lane (keychain "Claude Code-credentials" / ~/.codex/auth.json) can be
# pooled; the desktop apps (Claude Desktop, Codex.app) keep a SEPARATE credential the guard can't read,
# so a desktop-app-only user must `<cli> login` once to put a real refresh token where the guard sees it.
SEED_STATE_READY = "ready_to_seed"          # real RT present locally → guard will upload it to the pool
SEED_STATE_POOLED = "already_pooled"        # RT stripped to placeholder (AT-only) → hub already refreshes it
SEED_STATE_NOT_LOGGED_IN = "not_logged_in"  # no CLI credential → needs `<cli> login` once to seed


def cli_auth_seed_state(
    source: str,
    *,
    claude_home: Path = CLAUDE_HOME,
    codex_auth_path: Path = SOURCE_AUTH_PATH,
) -> dict:
    """Classify the local CLI-lane credential for `source` as one of SEED_STATE_*.
    The desktop-app lane is intentionally NOT consulted — it cannot be pooled. Returns {source, state}."""
    if source == "claude":
        creds, _origin = read_claude_oauth_credentials(claude_home)
        rt = ((creds or {}).get("claudeAiOauth") or {}).get("refreshToken") or ""
        placeholder = STRIPPED_CLAUDE_REFRESH_TOKEN
    elif source == "codex":
        rt = ""
        try:
            if codex_auth_path.exists():
                rt = (json.loads(codex_auth_path.read_text(encoding="utf-8")).get("tokens") or {}).get("refresh_token") or ""
        except Exception:
            rt = ""
        placeholder = STRIPPED_CODEX_REFRESH_TOKEN
    else:
        return {"source": source, "state": "unknown"}

    if not rt:
        return {"source": source, "state": SEED_STATE_NOT_LOGGED_IN}
    if rt == placeholder:
        return {"source": source, "state": SEED_STATE_POOLED}
    return {"source": source, "state": SEED_STATE_READY}


def seed_guidance_lines(state: dict) -> list[str]:
    """Human-readable guidance for a cli_auth_seed_state() result. The not-logged-in case is the
    important one: a desktop-app-only user has no CLI credential, so their account is silently never
    pooled until they run `<cli> login` once."""
    source = state.get("source", "?")
    cli = "claude" if source == "claude" else "codex"
    st = state.get("state")
    if st == SEED_STATE_READY:
        return [f"  [ok] {source}: logged in via CLI — the guard will seed it to the pool on the next cycle."]
    if st == SEED_STATE_POOLED:
        return [f"  [ok] {source}: already pooled (access-token-only locally; the hub refreshes it)."]
    if st == SEED_STATE_NOT_LOGGED_IN:
        return [
            f"  [!] {source}: NOT logged in via the CLI -> it will NOT be shared to the pool.",
            f"      To contribute {source}, run `{cli} login` ONCE to seed the pool.",
            f"      If you use the {source} desktop app it keeps working on its own session; the CLI login",
            f"      only seeds the pool and is then auto-stripped to access-token-only locally.",
            f"      Don't run `{cli} login` again afterward.",
        ]
    return [f"  [?] {source}: unknown auth state."]


# Re-fetch a fetched AT-only auth this long before its access token expires, so the CLI never
# has to fall back to the (dead) placeholder refresh token between guard runs.
AT_NEAR_EXPIRY_SKEW_SECONDS = 20 * 60


def _local_access_token_expiry_epoch(source: str, *, codex_auth_path: Path | None = None, claude_home: Path | None = None) -> float | None:
    """Epoch seconds when the local access token expires, or None if unknown."""
    try:
        if source == "codex":
            if not codex_auth_path or not codex_auth_path.exists():
                return None
            blob = json.loads(codex_auth_path.read_text(encoding="utf-8"))
            id_token = (blob.get("tokens") or {}).get("id_token")
            if not isinstance(id_token, str):
                return None
            exp = decode_jwt_payload(id_token).get("exp")
            return float(exp) if isinstance(exp, (int, float)) else None
        if source == "claude":
            credentials, _ = read_claude_oauth_credentials(claude_home or CLAUDE_HOME)
            expires_at = ((credentials or {}).get("claudeAiOauth") or {}).get("expiresAt")
            return float(expires_at) / 1000.0 if isinstance(expires_at, (int, float)) else None
    except Exception:
        return None
    return None


def local_access_token_seconds_left(
    source: str,
    *,
    codex_auth_path: Path | None = None,
    claude_home: Path | None = None,
    now: float | None = None,
) -> float | None:
    """Seconds until the local access token expires (negative once past), or None if unknown."""
    expiry = _local_access_token_expiry_epoch(source, codex_auth_path=codex_auth_path, claude_home=claude_home)
    if expiry is None:
        return None
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    return expiry - now


def fetched_auth_near_expiry(
    source: str,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    *,
    codex_auth_path: Path | None = None,
    claude_home: Path | None = None,
    skew_seconds: int = AT_NEAR_EXPIRY_SKEW_SECONDS,
    now: float | None = None,
) -> bool:
    """True when the local auth was fetched from the pool (so it is AT-only) and its access
    token is within skew_seconds of expiry — time to proactively re-fetch a fresh one."""
    state = read_known_auth_state(known_auth_path)
    source_state = (state.get("sources") or {}).get(source) or {}
    if source_state.get("state_source") != "fetched_from_auth_pool":
        return False
    expiry = _local_access_token_expiry_epoch(source, codex_auth_path=codex_auth_path, claude_home=claude_home)
    if expiry is None:
        return False
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    return expiry - now <= skew_seconds


def strip_local_codex_refresh_token(auth_path: Path = SOURCE_AUTH_PATH) -> dict:
    """Replace the local codex refresh token with the hub placeholder so this CLI runs AT-only
    and never rotates the shared refresh token. The hub already holds the real RT (just
    uploaded). Written atomically via a temp file + replace."""
    if not auth_path.exists():
        return {"stripped": False, "reason": "missing_auth"}
    try:
        blob = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception:
        return {"stripped": False, "reason": "unparseable"}
    tokens = blob.get("tokens")
    if not isinstance(tokens, dict) or not tokens.get("access_token"):
        return {"stripped": False, "reason": "no_access_token"}
    if tokens.get("refresh_token") == STRIPPED_CODEX_REFRESH_TOKEN:
        return {"stripped": False, "reason": "already_stripped"}
    tokens["refresh_token"] = STRIPPED_CODEX_REFRESH_TOKEN
    blob["tokens"] = tokens
    tmp_path = auth_path.with_name(auth_path.name + ".tmp")
    tmp_path.write_text(json.dumps(blob), encoding="utf-8")
    tmp_path.chmod(0o600)
    tmp_path.replace(auth_path)
    return {"stripped": True}


def strip_local_claude_refresh_token(claude_home: Path = CLAUDE_HOME) -> dict:
    """Replace local Claude refresh tokens with the hub placeholder (AT-only).

    Claude Code can have a modern encrypted token cache, an older keychain item, and a
    .credentials.json fallback on disk. Strip every reachable store so a stale backup RT cannot
    later reappear and rotate the hub-owned token family.
    """
    credentials, source = read_claude_oauth_credentials(claude_home)
    oauth = (credentials or {}).get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        return {"stripped": False, "reason": "no_credentials"}
    already_stripped = oauth.get("refreshToken") == STRIPPED_CLAUDE_REFRESH_TOKEN
    written = strip_claude_refresh_token_from_all_stores(credentials, claude_home)
    # "stripped" means the local stores are AT-only NOW, verified by read-back — not merely that a
    # write returned True. Callers gate `fetched_from_auth_pool` on this, and claiming AT-only while
    # a real RT survives is what lets both custodians rotate each other out.
    stripped = bool(written.get("verified"))
    result = {"stripped": stripped, "persisted": written, "source": source}
    if not stripped:
        result["reason"] = "strip_not_sticking"
        result["unstripped_stores"] = written.get("unstripped_stores") or []
    elif already_stripped:
        result["reason"] = "already_stripped"
    return result


def set_known_auth_state_source(source: str, known_auth_path: Path, state_source: str) -> bool:
    """Flip the recorded state_source for a source — used after an owner strips its local RT so
    the near-expiry proactive-refresh path (fetched_auth_near_expiry) applies to it too."""
    state = read_known_auth_state(known_auth_path)
    source_state = (state.get("sources") or {}).get(source)
    if not isinstance(source_state, dict):
        return False
    source_state["state_source"] = state_source
    state["sources"][source] = source_state
    known_auth_path.parent.mkdir(parents=True, exist_ok=True)
    known_auth_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    known_auth_path.chmod(0o600)
    return True


def upload_reported_disabled_refresh_token(sync_result: dict) -> bool:
    """The /api/auth/upload response carries the hub's disabled_refresh_token flag at the TOP LEVEL
    (api/auth/upload.js: {ok, entry, disabled_refresh_token, ...}). Read it from there so the client
    strips its local RT (Phase 4) in the SAME cycle as the upload — not deferred to a later path,
    which left the real local RT live as a second refresher (collision window). The previous code
    read it nested under `entry`, where it never is, so the strip silently never fired. Accept the
    legacy nested shape too, for safety."""
    if bool(sync_result.get("disabled_refresh_token")):
        return True
    return bool((sync_result.get("entry") or {}).get("disabled_refresh_token"))


def uploaded_refreshed_auth_json(sync_result: dict) -> str | None:
    """The AT-only blob /api/auth/upload hands back after it refreshed our upload.

    Mirrors upload_reported_disabled_refresh_token's lookup: the field is top level in the HTTP
    response, which the sync result nests under "entry"."""
    direct = sync_result.get("refreshed_auth_json")
    if isinstance(direct, str) and direct:
        return direct
    nested = (sync_result.get("entry") or {}).get("refreshed_auth_json")
    return nested if isinstance(nested, str) and nested else None


def install_uploaded_claude_refresh(sync_result: dict, claude_home: Path) -> dict:
    """Install the access token the hub minted while verifying our upload.

    Verifying an upload means refreshing it, and this provider revokes every access token it
    previously issued for that grant. So by the time the upload returns, the token this machine is
    still using is already dead. Installing the returned AT-only blob here — before the strip —
    is what keeps the machine working without giving it a refresh token back.
    """
    blob_text = uploaded_refreshed_auth_json(sync_result)
    if not blob_text:
        return {"installed": False, "reason": "hub_returned_no_refreshed_auth"}
    try:
        credentials = (json.loads(blob_text) or {}).get("credentials")
    except Exception:
        return {"installed": False, "reason": "unparseable_refreshed_auth"}
    if not isinstance(credentials, dict) or not (credentials.get("claudeAiOauth") or {}).get("accessToken"):
        return {"installed": False, "reason": "refreshed_auth_missing_access_token"}
    return install_claude_credentials(credentials, claude_home)


def install_uploaded_codex_refresh(sync_result: dict, auth_path: Path) -> dict:
    """Install the codex credential the hub minted while verifying our upload.

    The hub verifies by refreshing, which mints a new access_token AND a new ~1-hour id_token. The
    codex CLI decides when to self-refresh from the **id_token's** expiry, not the access_token's, so
    an AT-only client left holding the pre-upload id_token starts failing its own refresh ("Invalid
    refresh token") within the hour even though its access token is good for days. Installing the
    returned blob hands it the fresh id_token too. Mirrors the claude path: install, then strip.
    """
    blob_text = uploaded_refreshed_auth_json(sync_result)
    if not blob_text:
        return {"installed": False, "reason": "hub_returned_no_refreshed_auth"}
    try:
        blob = json.loads(blob_text)
    except Exception:
        return {"installed": False, "reason": "unparseable_refreshed_auth"}
    if not isinstance(blob.get("tokens"), dict) or not blob["tokens"].get("access_token"):
        return {"installed": False, "reason": "refreshed_auth_missing_access_token"}
    try:
        tmp_path = auth_path.with_name(auth_path.name + ".tmp")
        tmp_path.write_text(json.dumps(blob), encoding="utf-8")
        tmp_path.chmod(0o600)
        tmp_path.replace(auth_path)
    except Exception as error:
        return {"installed": False, "reason": "write_failed", "error": str(error)[:200]}
    try:
        written = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception:
        return {"installed": False, "reason": "unreadable_after_write"}
    installed = (written.get("tokens") or {}).get("access_token") == blob["tokens"]["access_token"]
    return {"installed": installed} if installed else {"installed": False, "reason": "readback_mismatch"}


def sync_current_codex_auth_pool(
    auth_pool_url: str,
    auth_pool_user_token: str,
    auth_path: Path = SOURCE_AUTH_PATH,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    quota_payload: dict | None = None,
) -> dict:
    if not auth_path.exists():
        return {"ok": True, "uploaded": False, "reason": "missing_auth"}

    auth_json_text = auth_path.read_text(encoding="utf-8")
    if auth_json_is_stripped("codex", auth_json_text):
        return {"ok": True, "uploaded": False, "reason": "local_auth_is_at_only"}

    metadata = auth_metadata(auth_path)
    result = sync_current_auth_pool_entry(
        source="codex",
        auth_pool_url=auth_pool_url,
        auth_pool_user_token=auth_pool_user_token,
        auth_json_text=auth_json_text,
        metadata=metadata,
        known_auth_path=known_auth_path,
        quota_payload=quota_payload,
    )
    # Phase 4: once the hub holds our real RT (just uploaded) and reports disabled_refresh_token
    # mode, strip the local RT so this owner also runs AT-only — its CLI can no longer rotate
    # the shared RT — and mark it fetched so the near-expiry path keeps its AT fresh.
    if result.get("uploaded") and upload_reported_disabled_refresh_token(result):
        # Install before stripping, as claude does. The hub's verification refresh rotated this
        # grant; the returned blob carries the access_token and the fresh ~1-hour id_token it minted,
        # and the id_token is what the codex CLI reads to decide when to refresh itself.
        installed = install_uploaded_codex_refresh(result, auth_path)
        result["refreshed_auth_installed"] = installed
        if not installed.get("installed"):
            # Same interlock as claude: never strip without a working credential in hand. An older
            # hub returns nothing here, and a failed write must not leave this machine AT-only on a
            # credential the hub just rotated away from.
            result["local_refresh_token_stripped"] = {
                "stripped": False,
                "reason": "strip_withheld_no_working_at",
                "install": installed,
            }
            return result
        strip = strip_local_codex_refresh_token(auth_path)
        result["local_refresh_token_stripped"] = strip
        # The blob we just installed is already AT-only, so this strip is normally a no-op reporting
        # "already_stripped" — which is success, not failure. Gating the state transition on
        # stripped=True alone would leave the machine permanently in owner_local and the near-expiry
        # refresh (which requires fetched_from_auth_pool) would never run for it.
        if strip.get("stripped") or strip.get("reason") == "already_stripped":
            set_known_auth_state_source("codex", known_auth_path, "fetched_from_auth_pool")
    return result


def sync_current_claude_auth_pool(
    auth_pool_url: str,
    auth_pool_user_token: str,
    claude_home: Path = CLAUDE_HOME,
    known_auth_path: Path = KNOWN_AUTH_PATH,
    claude_bin: str | None = None,
    probed_payload: dict | None = None,
    quota_payload: dict | None = None,
) -> dict:
    blob_text, payload = build_claude_auth_blob(claude_home, claude_bin, probed_payload=probed_payload)
    if blob_text is None:
        return {
            "ok": True,
            "uploaded": False,
            "reason": payload.get("error") or "missing_auth",
        }

    if auth_json_is_stripped("claude", blob_text):
        return {
            "ok": True,
            "uploaded": False,
            "reason": "local_auth_is_at_only",
            "local_refresh_token_stripped": strip_local_claude_refresh_token(claude_home),
        }

    metadata = claude_auth_blob_metadata(blob_text)
    result = sync_current_auth_pool_entry(
        source="claude",
        auth_pool_url=auth_pool_url,
        auth_pool_user_token=auth_pool_user_token,
        auth_json_text=blob_text,
        metadata=metadata,
        known_auth_path=known_auth_path,
        quota_payload=quota_payload,
    )
    # Phase 4: once the hub holds our real RT (just uploaded) and reports disabled_refresh_token
    # mode, strip the local RT so this owner also runs AT-only and mark it fetched so the
    # near-expiry path keeps its AT fresh.
    if result.get("uploaded") and upload_reported_disabled_refresh_token(result):
        # Order matters: install first, strip second. The hub refreshed this blob to verify it,
        # which revoked the access token we are still running on. Stripping before installing is
        # what left this machine holding a revoked AT and a placeholder RT — dead, and unable to
        # refresh its way out.
        installed = install_uploaded_claude_refresh(result, claude_home)
        result["refreshed_auth_installed"] = installed
        if not installed.get("installed"):
            # Safety interlock: never strip without a working access token in hand. An older hub
            # returns no refreshed blob, and a cache that shadows the install leaves the old token
            # in place — in both cases the token we hold was just revoked by the hub's verification
            # refresh, so stripping would take away the only way back. Keep the RT and retry next
            # cycle; a machine that can still refresh is recoverable, one that cannot is not.
            result["local_refresh_token_stripped"] = {
                "stripped": False,
                "reason": "strip_withheld_no_working_at",
                "install": installed,
            }
            return result
        strip = strip_local_claude_refresh_token(claude_home)
        result["local_refresh_token_stripped"] = strip
        if strip.get("stripped"):
            set_known_auth_state_source("claude", known_auth_path, "fetched_from_auth_pool")
    return result


def fetch_best_auth(
    auth_pool_url: str,
    auth_pool_user_token: str,
    *,
    source: str,
    current_account_id: str | None = None,
    current_quota: dict | None = None,
    exclude_account_ids: list[str] | None = None,
    requester_id: str | None = None,
    refresh_current: bool = False,
) -> dict:
    body = json.dumps(
        {
            "source": source,
            "exclude_account_ids": exclude_account_ids or [],
            "current_account_id": current_account_id,
            "current_quota": current_quota or {},
            "requester_id": requester_id or reporter_name(),
            "refresh_current": refresh_current,
            # The hub gates on this. It travels with the request rather than being looked up from
            # the last usage batch so a fresh install -- which fetches auth before it has any usage
            # to report -- can still be recognised as current.
            "client_version": CLIENT_VERSION,
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
    try:
        with urllib.request.urlopen(request) as response:
            return read_auth_pool_response(response)
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(error, auth_pool_url=auth_pool_url, auth_pool_user_token=auth_pool_user_token)


def fetch_auth_pool_status(auth_pool_url: str, auth_pool_user_token: str) -> dict:
    request = urllib.request.Request(
        auth_pool_url.rstrip("/") + "/api/status",
        headers={"Authorization": f"Bearer {auth_pool_user_token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return read_auth_pool_response(response)
    except urllib.error.HTTPError as error:
        return read_auth_pool_http_error(error, auth_pool_url=auth_pool_url, auth_pool_user_token=auth_pool_user_token)


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Internal quota-reporter helper library. This script is normally imported by the other quota-reporter "
            "commands instead of being run directly."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--show-paths",
        action="store_true",
        help="Print the key local file and directory paths used by quota-reporter, then exit.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.show_paths:
        print(
            json.dumps(
                {
                    "config_path": str(CONFIG_PATH),
                    "known_auth_path": str(KNOWN_AUTH_PATH),
                    "codex_auth_path": str(SOURCE_AUTH_PATH),
                    "claude_home": str(CLAUDE_HOME),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    print(
        "quota_reporters.py is an internal helper library. Use -h for usage or run one of the user-facing scripts such as quota_guard.py, install_quota_guard.py, or trigger_remote_probe.py."
    )


if __name__ == "__main__":
    main()
