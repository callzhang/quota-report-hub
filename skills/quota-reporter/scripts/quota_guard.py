#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
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
    probe_claude,
    probe_codex,
    sync_current_claude_auth_pool,
    sync_current_codex_auth_pool,
    write_known_auth_state,
)


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
        description="Check local Codex and Claude quota every 15 minutes and fetch a better same-source auth when needed."
    )
    parser.add_argument("--auth-pool-url")
    parser.add_argument("--auth-pool-user-token")
    parser.add_argument("--codex-auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--claude-home", type=Path, default=CLAUDE_HOME)
    parser.add_argument("--known-auth-path", type=Path, default=KNOWN_AUTH_PATH)
    parser.add_argument("--threshold-percent", type=float, default=20.0)
    parser.add_argument("--weekly-threshold-percent", type=float, default=5.0)
    parser.add_argument("--print-only", action="store_true")
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
    if config.get("auth_pool_url") and config.get("auth_pool_user_token"):
        sync_result["codex"] = sync_current_codex_auth_pool(
            config["auth_pool_url"],
            config["auth_pool_user_token"],
            auth_path=args.codex_auth_path,
            known_auth_path=args.known_auth_path,
        )
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

    return {
        "ok": True,
        "threshold_percent": args.threshold_percent,
        "weekly_threshold_percent": args.weekly_threshold_percent,
        "codex": codex_payload,
        "claude": claude_payload,
        "auth_pool_sync": sync_result,
        "replacement": {
            "codex": codex_replacement,
            "claude": claude_replacement,
        },
    }


def main() -> None:
    args = build_parser().parse_args()
    result = run_guard(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
