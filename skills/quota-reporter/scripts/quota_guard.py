#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from quota_reporters import (
    CLAUDE_HOME,
    KNOWN_AUTH_PATH,
    SOURCE_AUTH_PATH,
    auth_metadata,
    claude_auth_blob_metadata,
    detect_claude_custom_provider_env,
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
    }


def source_needs_replacement(payload: dict, threshold_percent: float, weekly_threshold_percent: float) -> bool:
    if not payload:
        return True
    if is_hard_invalidated(payload):
        return True
    five_hour_remaining = remaining_percent(payload, "5h")
    weekly_remaining = remaining_percent(payload, "1week")
    if five_hour_remaining < 0 or weekly_remaining < 0:
        return True
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
    result = post_auth_pool_quota(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        source=source,
        quota_payload=payload,
    )
    return {
        "ok": True,
        "reported": True,
        "account_id": payload.get("account_id"),
        "result": result,
    }


def replacement_toast_message(source: str, replacement: dict) -> str:
    display_name = replacement.get("to_email") or replacement.get("to_account_id") or "the new account"
    plan_name = replacement.get("to_plan_name")
    account_label = f"{display_name} ({plan_name})" if plan_name else str(display_name)
    app_name = "Codex" if source == "codex" else "Claude Code" if source == "claude" else source
    return f"{app_name} account switched to {account_label}. Quit the current {app_name} session and start a new one to use it."


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
    shown = show_desktop_notification("Quota Guard", message)
    return {"shown": shown, "message": message}


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
        allow_invalidated_reauth=False,
    )
    replacement = result.get("replacement")
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
        allow_invalidated_reauth=False,
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
        "--skip-self-update",
        action="store_true",
        help="Skip the startup check that updates this installed skill from GitHub before running the guard.",
    )
    return parser


def current_codex_payload(codex_auth_path: Path) -> dict | None:
    if not codex_auth_path.exists():
        return None
    return probe_codex(codex_auth_path)


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
    notifications = {}
    if not getattr(args, "no_toast", False):
        notifications["codex"] = notify_replacement_success("codex", codex_replacement)
        notifications["claude"] = notify_replacement_success("claude", claude_replacement)

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
        "notifications": notifications,
    }


def main() -> None:
    args = build_parser().parse_args()
    self_update = (
        {"ok": True, "updated": False, "reason": "skipped"}
        if args.skip_self_update
        else self_update_skill()
    )
    result = run_guard(args)
    result["self_update"] = self_update
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
