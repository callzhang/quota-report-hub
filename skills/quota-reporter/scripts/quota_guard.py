#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from quota_reporters import (
    CLAUDE_HOME,
    KNOWN_AUTH_PATH,
    SOURCE_AUTH_PATH,
    auth_metadata,
    fetch_best_auth,
    load_config,
    probe_claude,
    probe_codex,
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


def codex_needs_replacement(payload: dict, threshold_percent: float) -> bool:
    if not payload:
        return True
    if is_hard_invalidated(payload):
        return True
    five_hour_remaining = remaining_percent(payload, "5h")
    weekly_remaining = remaining_percent(payload, "1week")
    if five_hour_remaining < 0 or weekly_remaining < 0:
        return True
    return five_hour_remaining < threshold_percent or weekly_remaining <= 0.0


def claude_low_quota(payload: dict, threshold_percent: float) -> bool:
    if not payload or payload.get("source") != "claude":
        return False
    windows = payload.get("windows") or {}
    if windows.get("5h") is None or windows.get("1week") is None:
        return False
    return remaining_percent(payload, "5h") < threshold_percent or remaining_percent(payload, "1week") <= 0.0


def should_fetch_replacement(codex_payload: dict | None, claude_payload: dict | None, threshold_percent: float) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if codex_needs_replacement(codex_payload or {}, threshold_percent):
        reasons.append("codex")
    if claude_low_quota(claude_payload or {}, threshold_percent):
        reasons.append("claude")
    return (len(reasons) > 0, reasons)


def maybe_replace_codex_auth(
    config: dict,
    current_codex_payload: dict | None,
    codex_auth_path: Path,
    known_auth_path: Path,
    threshold_percent: float,
    claude_payload: dict | None = None,
) -> dict:
    current_account_id = current_codex_payload.get("account_id") if current_codex_payload else None
    needs_replacement, reasons = should_fetch_replacement(current_codex_payload, claude_payload, threshold_percent)
    if not needs_replacement:
        return {"ok": True, "replaced": False, "reason": "healthy", "triggered_by": []}

    result = fetch_best_auth(
        config["auth_pool_url"],
        config["auth_pool_user_token"],
        exclude_account_ids=[],
    )
    fetched_account_id = result.get("account_id")
    current_digest = None
    if codex_auth_path.exists():
        try:
            current_digest = auth_metadata(codex_auth_path).get("digest")
        except Exception:
            current_digest = None

    if fetched_account_id == current_account_id and result.get("digest") == current_digest:
        return {
            "ok": True,
            "replaced": False,
            "reason": "best_auth_already_installed",
            "triggered_by": reasons,
            "account_id": fetched_account_id,
        }

    codex_auth_path.parent.mkdir(parents=True, exist_ok=True)
    codex_auth_path.write_text(result["auth_json"], encoding="utf-8")
    codex_auth_path.chmod(0o600)
    known_auth = write_known_auth_state(
        codex_auth_path,
        known_auth_path,
        last_uploaded_digest=auth_metadata(codex_auth_path)["digest"],
        state_source="fetched_from_auth_pool",
    )

    return {
        "ok": True,
        "replaced": True,
        "triggered_by": reasons,
        "from_account_id": current_account_id,
        "to_account_id": fetched_account_id,
        "to_email": result.get("email"),
        "to_plan_name": result.get("plan_name"),
        "latest_report": result.get("latest_report"),
        "known_auth": known_auth,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check local Codex and Claude quota every 15 minutes and fetch a better Codex auth when needed.")
    parser.add_argument("--auth-pool-url")
    parser.add_argument("--auth-pool-user-token")
    parser.add_argument("--codex-auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--known-auth-path", type=Path, default=KNOWN_AUTH_PATH)
    parser.add_argument("--claude-home", type=Path, default=CLAUDE_HOME)
    parser.add_argument("--claude-bin")
    parser.add_argument("--threshold-percent", type=float, default=20.0)
    parser.add_argument("--print-only", action="store_true")
    return parser


def current_codex_payload(codex_auth_path: Path) -> dict | None:
    if not codex_auth_path.exists():
        return None
    return probe_codex(codex_auth_path)


def run_guard(args: argparse.Namespace) -> dict:
    config = load_config(args)
    codex_payload = current_codex_payload(args.codex_auth_path)
    claude_payload = probe_claude(args.claude_home, args.claude_bin)

    sync_result = None
    if config.get("auth_pool_url") and config.get("auth_pool_user_token"):
        sync_result = sync_current_codex_auth_pool(
            config["auth_pool_url"],
            config["auth_pool_user_token"],
            auth_path=args.codex_auth_path,
            known_auth_path=args.known_auth_path,
        )

    replacement = maybe_replace_codex_auth(
        config,
        codex_payload,
        args.codex_auth_path,
        args.known_auth_path,
        args.threshold_percent,
        claude_payload=claude_payload,
    )

    return {
        "ok": True,
        "threshold_percent": args.threshold_percent,
        "codex": codex_payload,
        "claude": claude_payload,
        "auth_pool_sync": sync_result,
        "replacement": replacement,
    }


def main() -> None:
    args = build_parser().parse_args()
    result = run_guard(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
