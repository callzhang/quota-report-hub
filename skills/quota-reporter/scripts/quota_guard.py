#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import json
import os
import platform
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from quota_reporters import (
    CLAUDE_HOME,
    KNOWN_AUTH_PATH,
    SOURCE_AUTH_PATH,
    auth_metadata,
    claude_auth_blob_metadata,
    detect_claude_custom_provider_env,
    fetch_auth_pool_status,
    fetch_best_auth,
    load_config,
    post_auth_pool_quota,
    probe_claude,
    probe_codex,
    sync_current_claude_auth_pool,
    sync_current_codex_auth_pool,
    write_known_auth_state,
)

DEFAULT_SELF_UPDATE_REPO = "callzhang/quota-report-hub"
DEFAULT_SELF_UPDATE_REF = "main"
SELF_UPDATE_STATE_PATH = Path.home() / ".agents" / "auth" / "quota-reporter-self-update.json"
SKILL_ROOT = Path(__file__).resolve().parents[1]


def read_self_update_state(state_path: Path = SELF_UPDATE_STATE_PATH) -> dict:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_self_update_state(state: dict, state_path: Path = SELF_UPDATE_STATE_PATH) -> dict:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    state_path.chmod(0o600)
    return state


def github_latest_sha(repo: str = DEFAULT_SELF_UPDATE_REPO, ref: str = DEFAULT_SELF_UPDATE_REF, timeout: int = 20) -> str:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/commits/{ref}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "quota-reporter-self-update",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    sha = payload.get("sha")
    if not sha:
        raise RuntimeError(f"GitHub response did not include a commit sha for {repo}@{ref}")
    return str(sha)


def download_github_tarball(repo: str, sha: str, destination: Path, timeout: int = 60) -> Path:
    archive_path = destination / "quota-report-hub.tar.gz"
    request = urllib.request.Request(
        f"https://codeload.github.com/{repo}/tar.gz/{sha}",
        headers={"User-Agent": "quota-reporter-self-update"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        archive_path.write_bytes(response.read())
    return archive_path


def unpack_skill_from_tarball(archive_path: Path, destination: Path) -> Path:
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            member_path = (destination / member.name).resolve()
            if destination.resolve() not in [member_path, *member_path.parents]:
                raise RuntimeError(f"Unsafe path in downloaded archive: {member.name}")
        archive.extractall(destination)
    candidates = sorted(destination.glob("*/skills/quota-reporter"))
    if not candidates:
        raise RuntimeError("Downloaded repository did not contain skills/quota-reporter")
    return candidates[0]


def copy_skill_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        target = destination / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def self_update_skill(
    *,
    repo: str = DEFAULT_SELF_UPDATE_REPO,
    ref: str = DEFAULT_SELF_UPDATE_REF,
    skill_root: Path = SKILL_ROOT,
    state_path: Path = SELF_UPDATE_STATE_PATH,
) -> dict:
    try:
        latest_sha = github_latest_sha(repo=repo, ref=ref)
        state = read_self_update_state(state_path)
        current_sha = state.get("last_applied_sha")
        if current_sha == latest_sha:
            return {"ok": True, "updated": False, "reason": "already_current", "sha": latest_sha}

        with tempfile.TemporaryDirectory(prefix="quota-reporter-update-") as temp_dir:
            temp_path = Path(temp_dir)
            archive_path = download_github_tarball(repo, latest_sha, temp_path)
            downloaded_skill = unpack_skill_from_tarball(archive_path, temp_path)
            copy_skill_tree(downloaded_skill, skill_root)

        write_self_update_state(
            {
                "repo": repo,
                "ref": ref,
                "last_applied_sha": latest_sha,
                "skill_root": str(skill_root),
            },
            state_path,
        )
        return {"ok": True, "updated": True, "from_sha": current_sha, "to_sha": latest_sha}
    except Exception as error:
        return {"ok": False, "updated": False, "error": str(error)}


def remaining_percent(payload: dict, window_key: str) -> float:
    window = (payload.get("windows") or {}).get(window_key) or {}
    value = window.get("remaining_percent")
    return float(value) if value is not None else -1.0


def is_hard_invalidated(payload: dict) -> bool:
    return payload.get("status") == "error" and payload.get("error") in {
        "auth invalidated (token_invalidated)",
        "auth failed (401 unauthorized)",
        "claude auth invalid (authentication_error)",
        "claude auth email unavailable",
    }


def source_needs_replacement(payload: dict, threshold_percent: float, weekly_threshold_percent: float) -> bool:
    if not payload:
        return False
    if is_hard_invalidated(payload):
        return True
    if payload.get("status") != "ok":
        return False
    five_hour_remaining = remaining_percent(payload, "5h")
    weekly_remaining = remaining_percent(payload, "1week")
    if five_hour_remaining < 0 or weekly_remaining < 0:
        return False
    return five_hour_remaining < threshold_percent or weekly_remaining < weekly_threshold_percent


def quota_payload_has_window(payload: dict) -> bool:
    if not payload:
        return False
    for window_key in ("5h", "1week"):
        window = (payload.get("windows") or {}).get(window_key) or {}
        if window.get("remaining_percent") is not None:
            return True
    return False


def quota_payload_has_complete_windows(payload: dict) -> bool:
    if not payload:
        return False
    for window_key in ("5h", "1week"):
        window = (payload.get("windows") or {}).get(window_key) or {}
        if window.get("remaining_percent") is None or not window.get("reset_at"):
            return False
    return True


def quota_payload_should_report(payload: dict | None) -> bool:
    if not payload or not payload.get("account_id"):
        return False
    if is_hard_invalidated(payload):
        return True
    return payload.get("status") == "ok" and quota_payload_has_window(payload)


def report_current_quota_to_auth_pool(config: dict, source: str, payload: dict | None) -> dict:
    if not config.get("auth_pool_url") or not config.get("auth_pool_user_token"):
        return {"ok": True, "reported": False, "reason": "missing_auth_pool_config"}
    if source == "codex":
        if not payload or not payload.get("account_id"):
            return {"ok": True, "reported": False, "reason": "quota_unavailable"}
        if not (is_hard_invalidated(payload) or (payload.get("status") == "ok" and quota_payload_has_complete_windows(payload))):
            return {"ok": True, "reported": False, "reason": "quota_unavailable"}
    elif not quota_payload_should_report(payload):
        return {"ok": True, "reported": False, "reason": "quota_unavailable"}
    quota_payload = without_sensitive_refresh_capture(payload)
    result = post_auth_pool_quota(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source=source,
        quota_payload=quota_payload,
    )
    if result.get("ok") is False:
        return {
            "ok": False,
            "reported": False,
            "reason": "post_auth_pool_quota_failed",
            "account_id": quota_payload.get("account_id"),
            "result": result,
        }
    return {
        "ok": True,
        "reported": True,
        "account_id": quota_payload.get("account_id"),
        "result": result,
    }


def replacement_toast_message(source: str, replacement: dict) -> str:
    display_name = replacement.get("to_email") or replacement.get("to_account_id") or "新账号"
    plan_name = replacement.get("to_plan_name")
    account_label = f"{display_name} ({plan_name})" if plan_name else str(display_name)
    app_name = "Codex" if source == "codex" else "Claude Code" if source == "claude" else source
    return f"{app_name} 已切换到 {account_label}。请退出当前 {app_name} 会话并重新打开，新会话才会使用这个账号。"


def show_desktop_notification(title: str, message: str) -> bool:
    system = platform.system().lower()
    try:
        if system == "darwin":
            subprocess.run(
                ["osascript", "-e", f'display notification {json.dumps(message)} with title {json.dumps(title)}'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return True
        if system == "linux" and shutil.which("notify-send"):
            subprocess.run(
                ["notify-send", title, message],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return True
        if system == "windows":
            powershell = shutil.which("powershell") or shutil.which("powershell.exe") or shutil.which("pwsh")
            if powershell:
                script = (
                    "$wshell = New-Object -ComObject WScript.Shell; "
                    f"$wshell.Popup({json.dumps(message)}, 8, {json.dumps(title)}, 64) | Out-Null"
                )
                subprocess.run(
                    [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                return True
    except Exception:
        return False
    return False


def notify_replacement_success(source: str, replacement: dict) -> dict:
    if not replacement.get("replaced"):
        return {"shown": False, "reason": "not_replaced"}
    message = replacement_toast_message(source, replacement)
    shown = show_desktop_notification("额度守护", message)
    return {"shown": shown, "message": message}


def codex_binary_for_app_server_restart() -> str | None:
    local_codex = Path.home() / ".local" / "bin" / "codex"
    if local_codex.exists() and os.access(local_codex, os.X_OK):
        return str(local_codex)
    return shutil.which("codex")


def unmanaged_codex_app_server_pids() -> list[int]:
    if platform.system().lower() == "windows":
        return []
    result = subprocess.run(
        ["ps", "-eo", "pid=,args="],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []

    current_pid = os.getpid()
    pids = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, args = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == current_pid:
            continue
        if " be-child ssh " in args or "/bin/bash -c" in args or " grep " in f" {args} ":
            continue
        if "codex app-server --listen" not in args:
            continue
        pids.append(pid)
    return pids


def stop_unmanaged_codex_app_server() -> dict:
    pids = unmanaged_codex_app_server_pids()
    if not pids:
        return {"ok": False, "stopped": False, "reason": "unmanaged_app_server_not_found"}

    terminated = []
    failed = []
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            terminated.append(pid)
        except ProcessLookupError:
            terminated.append(pid)
        except Exception as error:
            failed.append({"pid": pid, "error": str(error)})

    time.sleep(0.5)
    still_running = []
    for pid in terminated:
        try:
            os.kill(pid, 0)
            still_running.append(pid)
        except ProcessLookupError:
            pass
        except Exception:
            pass

    killed = []
    for pid in still_running:
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(pid)
        except ProcessLookupError:
            pass
        except Exception as error:
            failed.append({"pid": pid, "error": str(error)})

    return {
        "ok": not failed,
        "stopped": True,
        "terminated_pids": terminated,
        "killed_pids": killed,
        "failed": failed,
    }


def restart_codex_app_server() -> dict:
    codex_bin = codex_binary_for_app_server_restart()
    if not codex_bin:
        return {"ok": False, "restarted": False, "reason": "codex_binary_not_found"}

    command = [codex_bin, "app-server", "daemon", "restart"]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "restarted": False,
            "reason": "restart_timeout",
            "command": command,
        }
    except Exception as error:
        return {
            "ok": False,
            "restarted": False,
            "reason": "restart_failed",
            "error": str(error),
            "command": command,
        }

    if result.returncode != 0:
        combined_output = f"{result.stdout}\n{result.stderr}"
        if "not managed by codex app-server daemon" in combined_output:
            stopped = stop_unmanaged_codex_app_server()
            return {
                "ok": stopped.get("ok", False),
                "restarted": bool(stopped.get("stopped")),
                "reason": "unmanaged_app_server_stopped",
                "daemon_restart": {
                    "returncode": result.returncode,
                    "stdout": result.stdout.strip()[-1000:],
                    "stderr": result.stderr.strip()[-1000:],
                },
                "fallback": stopped,
                "command": command,
            }
        return {
            "ok": False,
            "restarted": False,
            "reason": "restart_command_failed",
            "returncode": result.returncode,
            "stdout": result.stdout.strip()[-1000:],
            "stderr": result.stderr.strip()[-1000:],
            "command": command,
        }
    return {
        "ok": True,
        "restarted": True,
        "command": command,
        "stdout": result.stdout.strip()[-1000:],
        "stderr": result.stderr.strip()[-1000:],
    }


def uploaded_invalidated_auths(status_payload: dict) -> list[dict]:
    viewer_email = status_payload.get("viewer_email")
    if not viewer_email:
        return []

    rows = list(status_payload.get("items") or []) + list(status_payload.get("archived_invalidated_items") or [])
    selected = []
    seen = set()
    for row in rows:
        if row.get("uploader_email") != viewer_email:
            continue
        if not is_hard_invalidated(row):
            continue
        key = (row.get("source"), row.get("account_id"))
        if key in seen:
            continue
        seen.add(key)
        selected.append(row)
    return selected


def invalidated_auths_message(rows: list[dict]) -> str:
    labels = []
    for row in rows[:5]:
        account = row.get("email") or row.get("account_id") or "未知账号"
        plan = row.get("plan_name")
        source = str(row.get("source") or "auth").upper()
        label = f"{source} {account}"
        if plan:
            label = f"{label} ({plan})"
        labels.append(label)
    extra = len(rows) - len(labels)
    suffix = f"，另有 {extra} 个账号" if extra > 0 else ""
    return "你上传的 auth 已失效：" + "；".join(labels) + suffix + "。请重新登录这些账号，然后再运行一次 quota_guard.py。"


def notify_uploaded_invalidated_auths(config: dict) -> dict:
    if not config.get("auth_pool_url") or not config.get("auth_pool_user_token"):
        return {"shown": False, "reason": "missing_auth_pool_config"}
    try:
        status_payload = fetch_auth_pool_status(config["auth_pool_url"], config["auth_pool_user_token"])
    except Exception as error:
        return {"shown": False, "reason": "status_fetch_failed", "error": str(error)}

    rows = uploaded_invalidated_auths(status_payload)
    if not rows:
        return {"shown": False, "reason": "no_uploaded_invalidated_auths", "count": 0}
    message = invalidated_auths_message(rows)
    shown = show_desktop_notification("额度守护", message)
    return {
        "shown": shown,
        "count": len(rows),
        "accounts": [
            {
                "source": row.get("source"),
                "account_id": row.get("account_id"),
                "email": row.get("email"),
                "plan_name": row.get("plan_name"),
                "error": row.get("error"),
            }
            for row in rows
        ],
        "message": message,
    }


def maybe_replace_codex_auth(
    config: dict,
    current_codex_payload: dict | None,
    codex_auth_path: Path,
    known_auth_path: Path,
    threshold_percent: float,
    weekly_threshold_percent: float,
) -> dict:
    current_account_id = current_codex_payload.get("account_id") if current_codex_payload else None
    current_quota = {
        "five_h_remaining_percent": remaining_percent(current_codex_payload or {}, "5h"),
        "one_week_remaining_percent": remaining_percent(current_codex_payload or {}, "1week"),
    }
    if not source_needs_replacement(current_codex_payload, threshold_percent, weekly_threshold_percent):
        return {"ok": True, "replaced": False, "reason": "healthy", "triggered_by": []}

    result = fetch_best_auth(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source="codex",
        current_account_id=current_account_id,
        current_quota=current_quota,
        exclude_account_ids=[],
    )
    replacement = result.get("replacement")
    repair_auth = result.get("repair_auth")
    if replacement is None and repair_auth is not None:
        fetched_account_id = repair_auth.get("account_id")
        if fetched_account_id != current_account_id:
            return {
                "ok": True,
                "replaced": False,
                "reason": "repair_auth_for_different_account",
                "triggered_by": ["codex"],
                "current_account_id": current_account_id,
                "repair_account_id": fetched_account_id,
            }
        current_digest = None
        if codex_auth_path.exists():
            try:
                current_digest = auth_metadata(codex_auth_path).get("digest")
            except Exception:
                current_digest = None
        if fetched_account_id == current_account_id and repair_auth.get("digest") == current_digest:
            return {
                "ok": True,
                "replaced": False,
                "reason": "repair_auth_already_installed",
                "triggered_by": ["codex"],
                "account_id": fetched_account_id,
            }

        codex_auth_path.parent.mkdir(parents=True, exist_ok=True)
        codex_auth_path.write_text(repair_auth["auth_json"], encoding="utf-8")
        codex_auth_path.chmod(0o600)
        metadata = auth_metadata(codex_auth_path)
        known_auth = write_known_auth_state(
            source="codex",
            metadata=metadata,
            known_auth_path=known_auth_path,
            last_uploaded_digest=metadata["digest"],
            last_uploaded_account_id=metadata["account_id"],
            last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
            state_source="repair_auth_from_auth_pool",
        )

        return {
            "ok": True,
            "replaced": True,
            "repair": True,
            "triggered_by": ["codex"],
            "from_account_id": current_account_id,
            "to_account_id": fetched_account_id,
            "to_email": repair_auth.get("email"),
            "to_plan_name": repair_auth.get("plan_name"),
            "latest_report": repair_auth.get("latest_report"),
            "known_auth": known_auth,
        }
    if replacement is None:
        return {
            "ok": True,
            "replaced": False,
            "reason": result.get("reason") or "no_better_auth_available",
            "triggered_by": ["codex"],
        }

    fetched_account_id = replacement.get("account_id")
    current_digest = None
    if codex_auth_path.exists():
        try:
            current_digest = auth_metadata(codex_auth_path).get("digest")
        except Exception:
            current_digest = None

    if fetched_account_id == current_account_id and replacement.get("digest") == current_digest:
        return {
            "ok": True,
            "replaced": False,
            "reason": "best_auth_already_installed",
            "triggered_by": ["codex"],
            "account_id": fetched_account_id,
        }

    codex_auth_path.parent.mkdir(parents=True, exist_ok=True)
    codex_auth_path.write_text(replacement["auth_json"], encoding="utf-8")
    codex_auth_path.chmod(0o600)
    metadata = auth_metadata(codex_auth_path)
    known_auth = write_known_auth_state(
        source="codex",
        metadata=metadata,
        known_auth_path=known_auth_path,
        last_uploaded_digest=metadata["digest"],
        last_uploaded_account_id=metadata["account_id"],
        last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
        state_source="fetched_from_auth_pool",
    )

    return {
        "ok": True,
        "replaced": True,
        "triggered_by": ["codex"],
        "from_account_id": current_account_id,
        "to_account_id": fetched_account_id,
        "to_email": replacement.get("email"),
        "to_plan_name": replacement.get("plan_name"),
        "latest_report": replacement.get("latest_report"),
        "known_auth": known_auth,
    }


def maybe_replace_claude_auth(
    config: dict,
    current_claude_payload: dict | None,
    claude_home: Path,
    known_auth_path: Path,
    threshold_percent: float,
    weekly_threshold_percent: float,
) -> dict:
    custom_provider = detect_claude_custom_provider_env(claude_home)
    if custom_provider is not None:
        return {
            "ok": True,
            "replaced": False,
            "reason": "unsupported_custom_provider",
            "triggered_by": [],
        }
    if not current_claude_payload or current_claude_payload.get("status") != "ok":
        return {"ok": True, "replaced": False, "reason": "missing_stable_claude_auth", "triggered_by": []}

    current_account_id = current_claude_payload.get("account_id")
    current_quota = {
        "five_h_remaining_percent": remaining_percent(current_claude_payload, "5h"),
        "one_week_remaining_percent": remaining_percent(current_claude_payload, "1week"),
    }
    if not source_needs_replacement(current_claude_payload, threshold_percent, weekly_threshold_percent):
        return {"ok": True, "replaced": False, "reason": "healthy", "triggered_by": []}

    result = fetch_best_auth(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source="claude",
        current_account_id=current_account_id,
        current_quota=current_quota,
        exclude_account_ids=[],
    )
    replacement = result.get("replacement")
    if replacement is None:
        return {"ok": True, "replaced": False, "reason": result.get("reason") or "no_better_auth_available", "triggered_by": ["claude"]}

    blob = json.loads(replacement["auth_json"])
    credentials_path = claude_home / ".credentials.json"
    credentials_path.parent.mkdir(parents=True, exist_ok=True)
    credentials_path.write_text(json.dumps(blob["credentials"], indent=2) + "\n", encoding="utf-8")
    credentials_path.chmod(0o600)
    metadata = claude_auth_blob_metadata(replacement["auth_json"])
    known_auth = write_known_auth_state(
        source="claude",
        metadata=metadata,
        known_auth_path=known_auth_path,
        last_uploaded_digest=metadata["digest"],
        last_uploaded_account_id=metadata["account_id"],
        last_uploaded_auth_last_refresh=metadata["auth_last_refresh"],
        state_source="fetched_from_auth_pool",
    )
    return {
        "ok": True,
        "replaced": True,
        "triggered_by": ["claude"],
        "from_account_id": current_account_id,
        "to_account_id": replacement.get("account_id"),
        "to_email": replacement.get("email"),
        "to_plan_name": replacement.get("plan_name"),
        "latest_report": replacement.get("latest_report"),
        "known_auth": known_auth,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run one local quota-guard cycle: probe current Codex and Claude state, upload changed auths, "
            "and fetch a better same-source auth when the current quota falls below threshold."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--auth-pool-url",
        help="Hub base URL. If omitted, falls back to ~/.agents/auth/quota-reporter.json.",
    )
    parser.add_argument(
        "--auth-pool-user-token",
        help="Personal auth-pool token. If omitted, falls back to ~/.agents/auth/quota-reporter.json.",
    )
    parser.add_argument(
        "--codex-auth-path",
        type=Path,
        default=SOURCE_AUTH_PATH,
        help="Local Codex auth.json path to probe, upload, and replace when a better Codex auth is fetched.",
    )
    parser.add_argument(
        "--claude-home",
        type=Path,
        default=CLAUDE_HOME,
        help="Claude home directory containing .credentials.json, settings.json, and statusline snapshots.",
    )
    parser.add_argument(
        "--known-auth-path",
        type=Path,
        default=KNOWN_AUTH_PATH,
        help="State file that remembers the last uploaded auth metadata for each source.",
    )
    parser.add_argument(
        "--threshold-percent",
        type=float,
        default=20.0,
        help="Rotate to a better same-source auth when the current 5H remaining quota is below this percentage.",
    )
    parser.add_argument(
        "--weekly-threshold-percent",
        type=float,
        default=5.0,
        help="Rotate to a better same-source auth when the current 1week remaining quota is below this percentage.",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="Print the full guard result JSON for this run. This is not a dry-run; uploads and replacements still occur.",
    )
    parser.add_argument(
        "--no-toast",
        action="store_true",
        help="Do not show a desktop notification after a successful auth replacement.",
    )
    parser.add_argument(
        "--no-restart-codex-app-server",
        action="store_true",
        help="Do not restart the local Codex app-server after quota guard writes a new Codex auth.json.",
    )
    parser.add_argument(
        "--skip-self-update",
        action="store_true",
        help="Skip the startup check that updates this installed skill from GitHub before running the guard.",
    )
    return parser


def without_sensitive_refresh_capture(payload: dict | None) -> dict | None:
    if payload is None:
        return None
    sanitized = copy.deepcopy(payload)
    refresh_capture = sanitized.get("refresh_capture")
    if isinstance(refresh_capture, dict):
        refresh_capture.pop("refreshed_auth_json", None)
    return sanitized


def persist_refreshed_codex_auth(codex_auth_path: Path, payload: dict | None) -> dict:
    refresh_capture = (payload or {}).get("refresh_capture") or {}
    delta = refresh_capture.get("delta") or {}
    refreshed_metadata = refresh_capture.get("refreshed_metadata") or {}
    refreshed_auth_json = refresh_capture.get("refreshed_auth_json")
    if not (delta.get("refreshed") and refreshed_auth_json and refreshed_metadata):
        return {"written": False, "reason": "not_refreshed"}

    current_account_id = (payload or {}).get("account_id")
    refreshed_account_id = refreshed_metadata.get("account_id")
    if current_account_id != refreshed_account_id:
        return {"written": False, "reason": "account_changed"}

    codex_auth_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(codex_auth_path.parent),
        prefix=f".{codex_auth_path.name}.",
        delete=False,
    ) as temp_file:
        temp_file.write(refreshed_auth_json)
        temp_file.flush()
        os.fsync(temp_file.fileno())
        temp_path = Path(temp_file.name)
    temp_path.chmod(0o600)
    os.replace(temp_path, codex_auth_path)
    codex_auth_path.chmod(0o600)

    for key in ("provider_account_id", "email", "name", "plan_name", "auth_last_refresh", "auth_path"):
        if key in refreshed_metadata:
            payload[key] = refreshed_metadata[key]
    payload["local_auth_refresh"] = {
        "written": True,
        "auth_last_refresh": refreshed_metadata.get("auth_last_refresh"),
        "digest": refreshed_metadata.get("digest"),
    }
    return payload["local_auth_refresh"]


def current_codex_payload(codex_auth_path: Path) -> dict | None:
    if not codex_auth_path.exists():
        return None
    payload = probe_codex(codex_auth_path, capture_refreshed_auth=True)
    persist_refreshed_codex_auth(codex_auth_path, payload)
    return without_sensitive_refresh_capture(payload)


def run_guard(args: argparse.Namespace) -> dict:
    config = load_config(args)
    codex_payload = current_codex_payload(args.codex_auth_path)
    claude_payload = probe_claude(args.claude_home)

    sync_result = {}
    quota_report_result = {}
    if config.get("auth_pool_url") and config.get("auth_pool_user_token"):
        sync_result["codex"] = sync_current_codex_auth_pool(
            config["auth_pool_url"],
            config["auth_pool_user_token"],
            auth_path=args.codex_auth_path,
            known_auth_path=args.known_auth_path,
        )
        quota_report_result["codex"] = report_current_quota_to_auth_pool(config, "codex", codex_payload)
        quota_report_result["claude"] = report_current_quota_to_auth_pool(config, "claude", claude_payload)
        sync_result["claude"] = sync_current_claude_auth_pool(
            config["auth_pool_url"],
            config["auth_pool_user_token"],
            claude_home=args.claude_home,
            known_auth_path=args.known_auth_path,
        )

    codex_replacement = maybe_replace_codex_auth(
        config,
        codex_payload,
        args.codex_auth_path,
        args.known_auth_path,
        args.threshold_percent,
        args.weekly_threshold_percent,
    )
    claude_replacement = maybe_replace_claude_auth(
        config,
        claude_payload,
        args.claude_home,
        args.known_auth_path,
        args.threshold_percent,
        args.weekly_threshold_percent,
    )
    codex_auth_changed = bool(
        (codex_payload or {}).get("local_auth_refresh", {}).get("written")
        or codex_replacement.get("replaced")
    )
    codex_app_server = {"restarted": False, "reason": "codex_auth_unchanged"}
    if codex_auth_changed:
        if getattr(args, "no_restart_codex_app_server", False):
            codex_app_server = {"restarted": False, "reason": "disabled"}
        else:
            codex_app_server = restart_codex_app_server()

    notifications = {}
    if not getattr(args, "no_toast", False):
        notifications["codex"] = notify_replacement_success("codex", codex_replacement)
        notifications["claude"] = notify_replacement_success("claude", claude_replacement)
        notifications["uploaded_invalidated_auths"] = notify_uploaded_invalidated_auths(config)

    return {
        "ok": True,
        "threshold_percent": args.threshold_percent,
        "weekly_threshold_percent": args.weekly_threshold_percent,
        "codex": codex_payload,
        "claude": claude_payload,
        "auth_pool_sync": sync_result,
        "quota_report": quota_report_result,
        "replacement": {
            "codex": codex_replacement,
            "claude": claude_replacement,
        },
        "codex_app_server": codex_app_server,
        "notifications": notifications,
    }


def main() -> None:
    args = build_parser().parse_args()
    self_update = (
        {"ok": True, "updated": False, "reason": "skipped"}
        if args.skip_self_update
        else self_update_skill()
    )
    if self_update.get("updated"):
        os.chdir(Path.home())
    result = run_guard(args)
    result["self_update"] = self_update
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
