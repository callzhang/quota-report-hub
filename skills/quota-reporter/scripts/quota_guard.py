#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from install_quota_guard import (
    CRON_MARKER,
    LABEL as SCHEDULER_LABEL,
    PLIST_PATH as LAUNCH_AGENT_PLIST_PATH,
    WINDOWS_TASK_NAME,
    install_linux_crontab,
    install_windows_task_scheduler,
    load_launch_agent,
    write_plist,
)
from quota_reporters import (
    CLAUDE_HOME,
    KNOWN_AUTH_PATH,
    SOURCE_AUTH_PATH,
    auth_metadata,
    claude_auth_blob_metadata,
    detect_claude_custom_provider_env,
    fetch_auth_pool_status,
    fetch_best_auth,
    fetched_auth_near_expiry,
    load_config,
    post_auth_pool_quota,
    probe_claude,
    probe_codex,
    sync_current_claude_auth_pool,
    sync_current_codex_auth_pool,
    write_claude_keychain_credentials,
    write_known_auth_state,
)

DEFAULT_SELF_UPDATE_REPO = "callzhang/quota-report-hub"
DEFAULT_SELF_UPDATE_REF = "main"
SELF_UPDATE_STATE_PATH = Path.home() / ".agents" / "auth" / "quota-reporter-self-update.json"
SKILL_ROOT = Path(__file__).resolve().parents[1]


def auth_json_digest(auth_json: str | None) -> str | None:
    if auth_json is None:
        return None
    return hashlib.sha256(auth_json.encode("utf-8")).hexdigest()


def fetched_auth_digest(auth_record: dict | None) -> str | None:
    auth_record = auth_record or {}
    return auth_json_digest(auth_record.get("auth_json")) or auth_record.get("digest")


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
        return bool(payload.get("account_id"))
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


def quota_payload_is_confirmed_out_of_credits(payload: dict) -> bool:
    if not payload or payload.get("error") != "codex workspace out of credits":
        return False
    for window_key in ("5h", "1week"):
        window = (payload.get("windows") or {}).get(window_key) or {}
        if window.get("remaining_percent") != 0.0:
            return False
    credits = (payload.get("usage_summary") or {}).get("credits") or {}
    return credits.get("has_credits") is False


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
        if not (
            is_hard_invalidated(payload)
            or (payload.get("status") == "ok" and quota_payload_has_complete_windows(payload))
            or (payload.get("status") == "ok" and quota_payload_is_confirmed_out_of_credits(payload))
        ):
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


def guard_exception_result(reason: str, error: Exception) -> dict:
    return {
        "ok": False,
        "reason": reason,
        "error_type": type(error).__name__,
        "error": str(error),
    }


def source_probe_error_payload(source: str, error: Exception, auth_path: Path | None = None) -> dict:
    return {
        "source": source,
        "hostname": None,
        "reporter_name": None,
        "reported_at": None,
        "account_id": f"{source}-probe-failed",
        "email": None,
        "name": None,
        "plan_name": None,
        "auth_path": str(auth_path) if auth_path is not None else None,
        "auth_last_refresh": None,
        "windows": {"5h": None, "1week": None},
        "model_context_window": None,
        "status": "error",
        "error": f"{source} probe failed: {type(error).__name__}: {error}",
        "usage_summary": None,
    }


def run_guard_step(reason: str, callback) -> dict:
    try:
        return callback()
    except Exception as error:
        return guard_exception_result(reason, error)


def timed_guard_step(timings: dict, name: str, callback):
    started = time.perf_counter()
    try:
        return callback()
    finally:
        timings[name] = round(time.perf_counter() - started, 3)


def custom_provider_claude_payload(claude_home: Path, custom_provider: dict) -> dict:
    return {
        "source": "claude",
        "hostname": None,
        "reporter_name": None,
        "reported_at": None,
        "email": None,
        "name": None,
        "auth_path": str(claude_home),
        "auth_last_refresh": None,
        "windows": {"5h": None, "1week": None},
        "model_context_window": None,
        "account_id": "claude-custom-provider",
        "plan_name": None,
        "status": "error",
        "error": "claude active provider uses custom ANTHROPIC_* settings; cloud auth pool only supports direct Claude subscriptions",
        "usage_summary": {
            "custom_provider_env": {
                "settings_key": custom_provider["settings_key"],
                "keys": sorted(custom_provider["env"].keys()),
                "base_url": custom_provider["env"].get("ANTHROPIC_BASE_URL"),
            },
        },
    }


def replacement_toast_message(source: str, replacement: dict) -> str:
    display_name = replacement.get("to_email") or replacement.get("to_account_id") or "新账号"
    plan_name = replacement.get("to_plan_name")
    account_label = f"{display_name} ({plan_name})" if plan_name else str(display_name)
    app_name = "Codex" if source == "codex" else "Claude Code" if source == "claude" else source
    return f"{app_name} 已切换到 {account_label}。请退出当前 {app_name} 会话并重新打开，新会话才会使用这个账号。"


def applescript_string(value: str) -> str:
    """Build an AppleScript string literal.

    osascript reads -e arguments as UTF-8, and AppleScript string literals accept
    literal non-ASCII characters but NOT JSON-style \\uXXXX escapes. Using json.dumps
    here silently produces invalid AppleScript for any non-ASCII text (e.g. Chinese),
    so the dialog/notification fails to parse and never appears.
    """
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if "\n" in text:
        return " & return & ".join('"' + part + '"' for part in text.split("\n"))
    return '"' + text + '"'


def show_desktop_notification(title: str, message: str) -> bool:
    system = platform.system().lower()
    try:
        if system == "darwin":
            subprocess.run(
                ["osascript", "-e", f'display notification {applescript_string(message)} with title {applescript_string(title)}'],
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


def scheduler_install_command(config: dict | None = None) -> str:
    config = config or {}
    command = [sys.executable or "python3", str(Path(__file__).with_name("install_quota_guard.py"))]
    if config.get("auth_pool_url"):
        command.extend(["--auth-pool-url", str(config["auth_pool_url"])])
    email = str(config.get("auth_pool_user_email") or "").strip()
    if email and not email.startswith("your.name@"):
        command.extend(["--email", email])
    return shlex.join(command)


def check_scheduler_registration(config: dict | None = None) -> dict:
    system = platform.system()
    install_command = scheduler_install_command(config)
    if system == "Darwin":
        uid = str(os.getuid())
        service = f"gui/{uid}/{SCHEDULER_LABEL}"
        if not LAUNCH_AGENT_PLIST_PATH.exists():
            return {
                "ok": False,
                "scheduler": "launchd",
                "reason": "plist_missing",
                "label": SCHEDULER_LABEL,
                "plist_path": str(LAUNCH_AGENT_PLIST_PATH),
                "install_command": install_command,
            }
        result = subprocess.run(["launchctl", "print", service], capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return {
                "ok": False,
                "scheduler": "launchd",
                "reason": "not_registered",
                "label": SCHEDULER_LABEL,
                "service": service,
                "plist_path": str(LAUNCH_AGENT_PLIST_PATH),
                "detail": (result.stderr or result.stdout or "").strip()[-1000:],
                "install_command": install_command,
            }
        return {
            "ok": True,
            "scheduler": "launchd",
            "label": SCHEDULER_LABEL,
            "service": service,
            "plist_path": str(LAUNCH_AGENT_PLIST_PATH),
        }

    if system == "Linux":
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
        managed_lines = [line for line in result.stdout.splitlines() if CRON_MARKER in line] if result.returncode == 0 else []
        if len(managed_lines) < 2:
            return {
                "ok": False,
                "scheduler": "cron",
                "reason": "not_registered",
                "detail": (result.stderr or result.stdout or "").strip()[-1000:],
                "install_command": install_command,
            }
        return {"ok": True, "scheduler": "cron", "entries": managed_lines}

    if system == "Windows":
        powershell_path = shutil.which("powershell") or shutil.which("powershell.exe") or shutil.which("pwsh") or shutil.which("pwsh.exe")
        if powershell_path is None:
            return {
                "ok": False,
                "scheduler": "task_scheduler",
                "reason": "powershell_missing",
                "task_name": WINDOWS_TASK_NAME,
                "install_command": install_command,
            }
        result = subprocess.run(
            [
                powershell_path,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                f"Get-ScheduledTask -TaskName {json.dumps(WINDOWS_TASK_NAME)} | Select-Object -ExpandProperty TaskName",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or WINDOWS_TASK_NAME not in result.stdout:
            return {
                "ok": False,
                "scheduler": "task_scheduler",
                "reason": "not_registered",
                "task_name": WINDOWS_TASK_NAME,
                "detail": (result.stderr or result.stdout or "").strip()[-1000:],
                "install_command": install_command,
            }
        return {"ok": True, "scheduler": "task_scheduler", "task_name": WINDOWS_TASK_NAME}

    return {"ok": True, "scheduler": "unsupported", "reason": f"unsupported_platform:{system}"}


def install_scheduler_registration(config: dict | None = None) -> dict:
    system = platform.system()
    python_path = sys.executable or "python3"
    worker_script = Path(__file__).resolve()
    if system == "Darwin":
        write_plist(python_path, worker_script)
        load_launch_agent()
        return {
            "ok": True,
            "scheduler": "launchd",
            "label": SCHEDULER_LABEL,
            "plist_path": str(LAUNCH_AGENT_PLIST_PATH),
        }
    if system == "Linux":
        install_linux_crontab(python_path, worker_script)
        return {"ok": True, "scheduler": "cron"}
    if system == "Windows":
        result = install_windows_task_scheduler(python_path, worker_script)
        return {"ok": True, **result}
    return {"ok": True, "scheduler": "unsupported", "reason": f"unsupported_platform:{system}"}


def ensure_scheduler_registration(config: dict | None = None) -> dict:
    initial = check_scheduler_registration(config)
    if initial.get("ok") is not False:
        return initial

    try:
        install_result = install_scheduler_registration(config)
        verified = check_scheduler_registration(config)
        if verified.get("ok") is not False:
            return {
                **verified,
                "installed": True,
                "initial_check": initial,
                "install_result": install_result,
            }
        return {
            **verified,
            "ok": False,
            "reason": verified.get("reason") or "install_verification_failed",
            "initial_check": initial,
            "install_result": install_result,
            "install_command": verified.get("install_command") or initial.get("install_command") or scheduler_install_command(config),
        }
    except Exception as error:
        return {
            "ok": False,
            "scheduler": initial.get("scheduler"),
            "reason": "install_failed",
            "initial_check": initial,
            "error": str(error),
            "install_command": initial.get("install_command") or scheduler_install_command(config),
        }


def scheduler_warning_message(warning: dict) -> str:
    scheduler = warning.get("scheduler") or "scheduler"
    reason = warning.get("reason") or "not_registered"
    command = warning.get("install_command") or scheduler_install_command({})
    return (
        f"未检测到 quota_guard 的 15 分钟定时任务（{scheduler}: {reason}）。"
        f"请让 agent 运行安装命令修复：{command}"
    )


def notify_scheduler_warning(warning: dict) -> dict:
    if not warning or warning.get("ok") is not False:
        return {"shown": False, "reason": "scheduler_ok"}
    message = scheduler_warning_message(warning)
    shown = show_desktop_notification("额度守护：定时任务未安装", message)
    return {"shown": shown, "message": message, "reason": "shown" if shown else "notify_failed"}


def codex_binary_for_app_server_restart() -> str | None:
    local_codex = Path.home() / ".local" / "bin" / "codex"
    if local_codex.exists() and os.access(local_codex, os.X_OK):
        return str(local_codex)
    return shutil.which("codex")


def unmanaged_codex_app_server_pids() -> list[int]:
    processes = unmanaged_codex_app_server_processes()
    if processes:
        return [process["pid"] for process in processes]

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


def unmanaged_codex_app_server_processes() -> list[dict]:
    if platform.system().lower() == "windows":
        return []

    result = subprocess.run(
        ["ps", "-eo", "pid=,etimes=,args="],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []

    current_pid = os.getpid()
    now = time.time()
    processes = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split(None, 2)
        if len(parts) != 3:
            continue
        pid_text, etimes_text, args = parts
        try:
            pid = int(pid_text)
            etimes = int(etimes_text)
        except ValueError:
            continue
        if pid == current_pid:
            continue
        if " be-child ssh " in args or "/bin/bash -c" in args or " grep " in f" {args} ":
            continue
        if "codex app-server --listen" not in args:
            continue
        processes.append(
            {
                "pid": pid,
                "started_at_epoch": now - etimes,
                "etimes_seconds": etimes,
                "args": args,
            }
        )
    return processes


def stale_codex_app_server_for_auth(codex_auth_path: Path) -> dict:
    if not codex_auth_path.exists():
        return {"stale": False, "reason": "auth_missing"}

    try:
        auth_mtime = codex_auth_path.stat().st_mtime
    except OSError as error:
        return {"stale": False, "reason": "auth_stat_failed", "error": str(error)}

    stale_processes = []
    for process in unmanaged_codex_app_server_processes():
        started_at = process.get("started_at_epoch")
        if started_at is None:
            continue
        if float(started_at) + 1.0 < auth_mtime:
            stale_processes.append(process)

    if not stale_processes:
        return {"stale": False, "reason": "no_stale_app_server", "auth_mtime_epoch": auth_mtime}

    return {
        "stale": True,
        "reason": "app_server_started_before_auth",
        "auth_mtime_epoch": auth_mtime,
        "processes": stale_processes,
    }


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
        if (
            "not managed by codex app-server daemon" in combined_output
            or "managed standalone Codex install not found" in combined_output
        ):
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


INVALIDATED_NOTIFY_STATE_PATH = Path.home() / ".agents" / "auth" / "invalidated-notify-state.json"
INVALIDATED_NOTIFY_REPEAT_SECONDS = 24 * 60 * 60


def read_invalidated_notify_state(path: Path = INVALIDATED_NOTIFY_STATE_PATH) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_invalidated_notify_state(state: dict, path: Path = INVALIDATED_NOTIFY_STATE_PATH) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass


def notify_uploaded_invalidated_auths(
    config: dict,
    now: float | None = None,
    state_path: Path = INVALIDATED_NOTIFY_STATE_PATH,
) -> dict:
    if not config.get("auth_pool_url") or not config.get("auth_pool_user_token"):
        return {"shown": False, "reason": "missing_auth_pool_config"}
    try:
        status_payload = fetch_auth_pool_status(config["auth_pool_url"], config["auth_pool_user_token"])
    except Exception as error:
        return {"shown": False, "reason": "status_fetch_failed", "error": str(error)}

    rows = uploaded_invalidated_auths(status_payload)
    if not rows:
        return {"shown": False, "reason": "no_uploaded_invalidated_auths", "count": 0}

    accounts = [
        {
            "source": row.get("source"),
            "account_id": row.get("account_id"),
            "email": row.get("email"),
            "plan_name": row.get("plan_name"),
            "error": row.get("error"),
        }
        for row in rows
    ]
    message = invalidated_auths_message(rows)
    now_ts = time.time() if now is None else now

    # Non-intrusive system notification (not a modal dialog), at most once per 24h
    # REGARDLESS of which auths are invalidated. The cloud-side invalidated set can
    # flap between probes, so keying the cooldown on the set (not just time) would
    # post a banner far more than once a day. Pure time window = one reminder/day.
    state = read_invalidated_notify_state(state_path)
    if (now_ts - float(state.get("notified_at") or 0)) < INVALIDATED_NOTIFY_REPEAT_SECONDS:
        return {
            "shown": False,
            "reason": "recently_notified",
            "count": len(rows),
            "accounts": accounts,
            "message": message,
        }

    shown = show_desktop_notification("额度守护：需要重新登录", message)
    if shown:
        write_invalidated_notify_state({"notified_at": now_ts}, state_path)
    return {
        "shown": shown,
        "reason": "shown" if shown else "notify_failed",
        "count": len(rows),
        "accounts": accounts,
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
    # Quota-low (or invalidated) triggers a normal replacement; a healthy-but-near-expiry
    # fetched AT-only auth instead asks the hub to refresh the SAME account's access token.
    refresh_current = False
    if not source_needs_replacement(current_codex_payload, threshold_percent, weekly_threshold_percent):
        if fetched_auth_near_expiry("codex", known_auth_path, codex_auth_path=codex_auth_path):
            refresh_current = True
        else:
            return {"ok": True, "replaced": False, "reason": "healthy", "triggered_by": []}

    result = fetch_best_auth(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source="codex",
        current_account_id=current_account_id,
        current_quota=current_quota,
        exclude_account_ids=[],
        requester_id=current_codex_payload.get("reporter_name") if current_codex_payload else None,
        refresh_current=refresh_current,
    )
    replacement = result.get("replacement")
    repair_auth = result.get("repair_auth")
    if replacement is None and repair_auth is not None:
        # The hub handed back an auth this user uploaded that has gone invalid — install
        # it (even if it isn't the current account) so the owner lands on their own dead
        # account and re-logs in, instead of borrowing a pool auth. The local auth that
        # triggered this fetch was already unhealthy, so nothing healthy is overwritten.
        fetched_account_id = repair_auth.get("account_id")
        current_digest = None
        if codex_auth_path.exists():
            try:
                current_digest = auth_metadata(codex_auth_path).get("digest")
            except Exception:
                current_digest = None
        repair_digest = fetched_auth_digest(repair_auth)
        if fetched_account_id == current_account_id and repair_digest == current_digest:
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

    replacement_digest = fetched_auth_digest(replacement)
    if fetched_account_id == current_account_id and replacement_digest == current_digest:
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
    if fetched_account_id == current_account_id:
        return {
            "ok": True,
            "replaced": False,
            "auth_refreshed": True,
            "reason": "same_account_auth_refreshed",
            "triggered_by": ["codex"],
            "account_id": fetched_account_id,
            "known_auth": known_auth,
        }

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
    # Quota-low (or invalidated) triggers a normal replacement; a healthy-but-near-expiry
    # fetched AT-only auth instead asks the hub to refresh the SAME account's access token.
    refresh_current = False
    if not source_needs_replacement(current_claude_payload, threshold_percent, weekly_threshold_percent):
        if fetched_auth_near_expiry("claude", known_auth_path, claude_home=claude_home):
            refresh_current = True
        else:
            return {"ok": True, "replaced": False, "reason": "healthy", "triggered_by": []}

    result = fetch_best_auth(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source="claude",
        current_account_id=current_account_id,
        current_quota=current_quota,
        exclude_account_ids=[],
        requester_id=current_claude_payload.get("reporter_name") if current_claude_payload else None,
        refresh_current=refresh_current,
    )
    replacement = result.get("replacement")
    repair_auth = result.get("repair_auth")
    if replacement is None and repair_auth is not None:
        # The hub handed back this user's own invalidated Claude auth — install it so the
        # owner lands on their own dead account and re-logs in, instead of borrowing.
        try:
            repair_blob = json.loads(repair_auth["auth_json"])
        except Exception:
            return {"ok": True, "replaced": False, "reason": "repair_auth_unparseable", "triggered_by": ["claude"]}
        repair_credentials = repair_blob.get("credentials")
        wrote_keychain = False
        if platform.system().lower() == "darwin":
            wrote_keychain = write_claude_keychain_credentials(repair_credentials)
        if not wrote_keychain:
            credentials_path = claude_home / ".credentials.json"
            credentials_path.parent.mkdir(parents=True, exist_ok=True)
            credentials_path.write_text(json.dumps(repair_credentials, indent=2) + "\n", encoding="utf-8")
            credentials_path.chmod(0o600)
        metadata = claude_auth_blob_metadata(repair_auth["auth_json"])
        known_auth = write_known_auth_state(
            source="claude",
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
            "triggered_by": ["claude"],
            "from_account_id": current_account_id,
            "to_account_id": repair_auth.get("account_id"),
            "to_email": repair_auth.get("email"),
            "to_plan_name": repair_auth.get("plan_name"),
            "known_auth": known_auth,
        }
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
    if replacement.get("account_id") == current_account_id:
        return {
            "ok": True,
            "replaced": False,
            "auth_refreshed": True,
            "reason": "same_account_auth_refreshed",
            "triggered_by": ["claude"],
            "account_id": replacement.get("account_id"),
            "known_auth": known_auth,
        }

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


def format_percent(value) -> str:
    if value is None:
        return "n/a"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "n/a"
    if number.is_integer():
        return f"{int(number)}%"
    return f"{number:.1f}%"


def format_quota_window(payload: dict | None, window_key: str) -> str:
    window = ((payload or {}).get("windows") or {}).get(window_key)
    if not window:
        return "n/a"
    remaining = window.get("remaining_percent")
    if remaining is None:
        return "n/a"
    text = format_percent(remaining)
    reset_at = window.get("reset_at")
    try:
        is_zero = float(remaining) <= 0.0
    except (TypeError, ValueError):
        is_zero = False
    return f"{text} -> {reset_at}" if is_zero and reset_at else text


def format_quota_report(result: dict | None) -> str:
    if not result:
        return "quota not configured"
    if result.get("reported"):
        return "quota reported"
    reason = result.get("reason")
    if result.get("ok") is False:
        return f"quota report failed ({reason or 'error'})"
    return f"quota not reported ({reason})" if reason else "quota not reported"


def format_replacement(result: dict | None) -> str:
    if not result:
        return "replacement skipped"
    if result.get("replaced"):
        target = result.get("to_email") or result.get("to_account_id") or "new auth"
        return f"replaced -> {target}"
    if result.get("auth_refreshed"):
        target = result.get("account_id") or "current auth"
        return f"auth refreshed -> {target}"
    reason = result.get("reason")
    if result.get("ok") is False:
        return f"replacement failed ({reason or 'error'})"
    return f"replacement {reason}" if reason else "replacement skipped"


def format_source_summary(source_label: str, payload: dict | None, quota_report: dict | None, replacement: dict | None) -> str:
    status = (payload or {}).get("status") or "unknown"
    account = (payload or {}).get("account_id") or (payload or {}).get("email") or "unknown"
    parts = [
        f"{source_label}: {status} {account}",
        f"5H {format_quota_window(payload, '5h')}",
        f"1week {format_quota_window(payload, '1week')}",
        format_quota_report(quota_report),
        format_replacement(replacement),
    ]
    error = (payload or {}).get("error")
    if error:
        parts.append(f"error {error}")
    return " | ".join(parts)


def format_auth_pool_sync(sync_result: dict | None) -> str:
    sync_result = sync_result or {}
    parts = []
    for source in ("codex", "claude"):
        result = sync_result.get(source)
        if not result:
            parts.append(f"{source} not configured")
            continue
        if result.get("uploaded"):
            parts.append(f"{source} uploaded")
        elif result.get("ok") is False:
            parts.append(f"{source} failed")
        else:
            parts.append(f"{source} {result.get('reason') or 'ok'}")
    return "; ".join(parts)


def format_guard_summary(result: dict) -> str:
    status = "OK" if result.get("ok") else "ERROR"
    timings = result.get("timings") or {}
    total_seconds = timings.get("process_total") or timings.get("total")
    header = f"Quota guard: {status}"
    if total_seconds is not None:
        header += f" ({total_seconds}s)"

    app_server = result.get("codex_app_server") or {}
    app_server_status = "restarted" if app_server.get("restarted") else "not restarted"
    app_server_reason = app_server.get("reason")
    self_update = result.get("self_update") or {}
    self_update_text = "updated" if self_update.get("updated") else self_update.get("reason") or "ok"
    errors = result.get("errors") or {}

    lines = [
        header,
        format_source_summary("Codex", result.get("codex"), (result.get("quota_report") or {}).get("codex"), (result.get("replacement") or {}).get("codex")),
        format_source_summary("Claude", result.get("claude"), (result.get("quota_report") or {}).get("claude"), (result.get("replacement") or {}).get("claude")),
        f"Auth pool: {format_auth_pool_sync(result.get('auth_pool_sync'))}",
        f"Codex app-server: {app_server_status}" + (f" ({app_server_reason})" if app_server_reason else ""),
        f"Self update: {self_update_text}",
    ]

    invalidated = (result.get("notifications") or {}).get("uploaded_invalidated_auths") or {}
    if invalidated.get("count"):
        labels = []
        for account in (invalidated.get("accounts") or [])[:5]:
            name = account.get("email") or account.get("account_id") or "unknown account"
            source_label = str(account.get("source") or "auth").upper()
            plan = account.get("plan_name")
            labels.append(f"{source_label} {name}" + (f" ({plan})" if plan else ""))
        extra = invalidated["count"] - len(labels)
        suffix = f", +{extra} more" if extra > 0 else ""
        note = "" if invalidated.get("shown") else f" [{invalidated.get('reason')}]"
        lines.append("Login required (re-login then rerun): " + "; ".join(labels) + suffix + note)

    warnings = result.get("warnings") or {}
    if warnings:
        warning_labels = []
        scheduler = warnings.get("scheduler")
        if scheduler:
            warning_labels.append(f"scheduler {scheduler.get('reason') or 'warning'}")
        for key in sorted(k for k in warnings.keys() if k != "scheduler"):
            warning = warnings.get(key) or {}
            warning_labels.append(f"{key} {warning.get('reason') or 'warning'}")
        lines.append("Warnings: " + ", ".join(warning_labels))

    lines.append("Errors: " + (", ".join(sorted(errors.keys())) if errors else "none"))
    return "\n".join(lines)


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
        "--json",
        action="store_true",
        dest="json_output",
        help="Print the full guard result JSON. This is not a dry-run; uploads and replacements still occur.",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        dest="json_output",
        help="Deprecated alias for --json.",
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
    timings = {}
    total_started = time.perf_counter()
    guard_errors = {}
    try:
        config = timed_guard_step(timings, "load_config", lambda: load_config(args))
    except Exception as error:
        config = {}
        guard_errors["config"] = guard_exception_result("load_config_failed", error)
    try:
        threshold_percent = float(config.get("threshold_percent", args.threshold_percent))
        weekly_threshold_percent = float(config.get("weekly_threshold_percent", args.weekly_threshold_percent))
    except Exception as error:
        threshold_percent = args.threshold_percent
        weekly_threshold_percent = args.weekly_threshold_percent
        guard_errors["config_thresholds"] = guard_exception_result("load_config_thresholds_failed", error)

    warnings = {}
    scheduler_check = run_guard_step(
        "scheduler_check_failed",
        lambda: timed_guard_step(timings, "scheduler_check", lambda: ensure_scheduler_registration(config)),
    )
    if scheduler_check.get("ok") is False:
        warnings["scheduler"] = scheduler_check

    try:
        codex_payload = timed_guard_step(timings, "codex_probe", lambda: current_codex_payload(args.codex_auth_path))
    except Exception as error:
        codex_payload = source_probe_error_payload("codex", error, args.codex_auth_path)
        guard_errors["codex_probe"] = guard_exception_result("codex_probe_failed", error)

    claude_custom_provider = detect_claude_custom_provider_env(args.claude_home)
    try:
        if claude_custom_provider is not None:
            claude_payload = timed_guard_step(
                timings,
                "claude_probe",
                lambda: custom_provider_claude_payload(args.claude_home, claude_custom_provider),
            )
        else:
            claude_payload = timed_guard_step(timings, "claude_probe", lambda: probe_claude(args.claude_home))
    except Exception as error:
        claude_payload = source_probe_error_payload("claude", error, args.claude_home)
        guard_errors["claude_probe"] = guard_exception_result("claude_probe_failed", error)

    sync_result = {}
    quota_report_result = {}
    if config.get("auth_pool_url") and config.get("auth_pool_user_token"):
        sync_result["codex"] = run_guard_step(
            "codex_auth_pool_sync_failed",
            lambda: timed_guard_step(
                timings,
                "codex_auth_pool_sync",
                lambda: sync_current_codex_auth_pool(
                    config["auth_pool_url"],
                    config["auth_pool_user_token"],
                    auth_path=args.codex_auth_path,
                    known_auth_path=args.known_auth_path,
                ),
            ),
        )
        quota_report_result["codex"] = run_guard_step(
            "codex_quota_report_failed",
            lambda: timed_guard_step(timings, "codex_quota_report", lambda: report_current_quota_to_auth_pool(config, "codex", codex_payload)),
        )
        quota_report_result["claude"] = run_guard_step(
            "claude_quota_report_failed",
            lambda: timed_guard_step(timings, "claude_quota_report", lambda: report_current_quota_to_auth_pool(config, "claude", claude_payload)),
        )
        if claude_custom_provider is not None:
            sync_result["claude"] = {"ok": True, "uploaded": False, "reason": claude_payload.get("error")}
            timings["claude_auth_pool_sync"] = 0.0
        else:
            sync_result["claude"] = run_guard_step(
                "claude_auth_pool_sync_failed",
                lambda: timed_guard_step(
                    timings,
                    "claude_auth_pool_sync",
                    lambda: sync_current_claude_auth_pool(
                        config["auth_pool_url"],
                        config["auth_pool_user_token"],
                        claude_home=args.claude_home,
                        known_auth_path=args.known_auth_path,
                        probed_payload=claude_payload,
                    ),
                ),
            )

    codex_replacement = run_guard_step(
        "codex_replacement_failed",
        lambda: timed_guard_step(
            timings,
            "codex_replacement",
            lambda: maybe_replace_codex_auth(
                config,
                codex_payload,
                args.codex_auth_path,
                args.known_auth_path,
                threshold_percent,
                weekly_threshold_percent,
            ),
        ),
    )
    claude_replacement = run_guard_step(
        "claude_replacement_failed",
        lambda: timed_guard_step(
            timings,
            "claude_replacement",
            lambda: maybe_replace_claude_auth(
                config,
                claude_payload,
                args.claude_home,
                args.known_auth_path,
                threshold_percent,
                weekly_threshold_percent,
            ),
        ),
    )
    codex_auth_changed = bool(
        (codex_payload or {}).get("local_auth_refresh", {}).get("written")
        or codex_replacement.get("replaced")
        or codex_replacement.get("auth_refreshed")
    )
    stale_app_server = stale_codex_app_server_for_auth(args.codex_auth_path)
    codex_app_server = {"restarted": False, "reason": "codex_auth_unchanged", "stale_check": stale_app_server}
    if codex_auth_changed or stale_app_server.get("stale"):
        if getattr(args, "no_restart_codex_app_server", False):
            codex_app_server = {
                "restarted": False,
                "reason": "disabled",
                "trigger": "codex_auth_changed" if codex_auth_changed else stale_app_server.get("reason"),
                "stale_check": stale_app_server,
            }
        else:
            codex_app_server = timed_guard_step(timings, "codex_app_server", restart_codex_app_server)
            codex_app_server["trigger"] = "codex_auth_changed" if codex_auth_changed else stale_app_server.get("reason")
            codex_app_server["stale_check"] = stale_app_server
    else:
        timings["codex_app_server"] = 0.0

    notifications = {}
    if not getattr(args, "no_toast", False):
        def notify_all():
            if warnings.get("scheduler"):
                notifications["scheduler"] = notify_scheduler_warning(warnings["scheduler"])
            notifications["codex"] = notify_replacement_success("codex", codex_replacement)
            notifications["claude"] = notify_replacement_success("claude", claude_replacement)
            notifications["uploaded_invalidated_auths"] = notify_uploaded_invalidated_auths(config)
        timed_guard_step(timings, "notifications", notify_all)
    else:
        timings["notifications"] = 0.0

    timings["total"] = round(time.perf_counter() - total_started, 3)

    return {
        "ok": True,
        "threshold_percent": threshold_percent,
        "weekly_threshold_percent": weekly_threshold_percent,
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
        "warnings": warnings,
        "errors": guard_errors,
        "timings": timings,
    }


def main() -> None:
    args = build_parser().parse_args()
    process_started = time.perf_counter()
    self_update_started = time.perf_counter()
    try:
        startup_config = load_config(args)
    except Exception:
        startup_config = {}
    self_update = (
        {"ok": True, "updated": False, "reason": "skipped"}
        if args.skip_self_update or startup_config.get("disable_self_update") is True
        else self_update_skill()
    )
    self_update_elapsed = round(time.perf_counter() - self_update_started, 3)
    if self_update.get("updated"):
        os.chdir(Path.home())
    result = run_guard(args)
    result["self_update"] = self_update
    result.setdefault("timings", {})["self_update"] = self_update_elapsed
    result["timings"]["process_total"] = round(time.perf_counter() - process_started, 3)
    if args.json_output:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_guard_summary(result))


if __name__ == "__main__":
    main()
