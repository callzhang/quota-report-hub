#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
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
PROMPT = "reply with ok"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def decode_jwt_payload(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))


def human_plan_name(plan_type: str | None) -> str | None:
    if plan_type is None:
        return None
    return {
        "free": "Free",
        "plus": "Plus",
        "pro": "Pro",
        "prolite": "Pro Lite",
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
        reset_at = datetime.fromtimestamp(now_ts + reset_in_seconds, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    used_percent = float(window["used_percent"])
    return {
        "used_percent": used_percent,
        "remaining_percent": round(100.0 - used_percent, 1),
        "window_minutes": window["window_minutes"],
        "reset_in_seconds": reset_in_seconds,
        "reset_at": reset_at,
    }


def probe_quota(auth_path: Path) -> dict:
    metadata = auth_metadata(auth_path)
    checked_at = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix="quota-report-") as temp_dir:
        codex_home = Path(temp_dir)
        shutil.copy2(auth_path, codex_home / "auth.json")
        env = dict(os.environ)
        env["CODEX_HOME"] = str(codex_home)
        result = subprocess.run(
            ["codex", "exec", "--skip-git-repo-check", "-C", "/tmp", PROMPT],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        token_event = latest_token_count_event(codex_home)

    if token_event is None:
        return {
            "source": "codex",
            "hostname": socket.gethostname(),
            "reporter_name": f"{os.environ.get('USER', 'unknown')}@{socket.gethostname()}",
            "reported_at": checked_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "account_id": metadata["account_id"],
            "email": metadata["email"],
            "name": metadata["name"],
            "plan_name": metadata["plan_name"],
            "auth_last_refresh": metadata["auth_last_refresh"],
            "auth_path": metadata["auth_path"],
            "status": "error",
            "error": (result.stderr.strip() or result.stdout.strip() or "codex exec failed")[:1200],
            "windows": {},
        }

    token_payload = token_event.get("payload", {})
    info = token_payload.get("info")
    rate_limits = token_payload.get("rate_limits")
    if not info or not rate_limits or "primary" not in rate_limits or "secondary" not in rate_limits:
        return {
            "source": "codex",
            "hostname": socket.gethostname(),
            "reporter_name": f"{os.environ.get('USER', 'unknown')}@{socket.gethostname()}",
            "reported_at": checked_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "account_id": metadata["account_id"],
            "email": metadata["email"],
            "name": metadata["name"],
            "plan_name": metadata["plan_name"],
            "auth_last_refresh": metadata["auth_last_refresh"],
            "auth_path": metadata["auth_path"],
            "status": "error",
            "error": "token_count event was present but missing quota details",
            "windows": {},
        }

    now_ts = checked_at.timestamp()
    return {
        "source": "codex",
        "hostname": socket.gethostname(),
        "reporter_name": f"{os.environ.get('USER', 'unknown')}@{socket.gethostname()}",
        "reported_at": checked_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "account_id": metadata["account_id"],
        "email": metadata["email"],
        "name": metadata["name"],
        "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
        "auth_last_refresh": metadata["auth_last_refresh"],
        "auth_path": metadata["auth_path"],
        "model_context_window": info.get("model_context_window"),
        "status": "ok",
        "windows": {
          "5h": normalize_window(rate_limits["primary"], now_ts),
          "1week": normalize_window(rate_limits["secondary"], now_ts),
        },
    }


def load_config(args: argparse.Namespace) -> dict:
    if args.server_url and args.ingest_token:
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Report local Codex quota to a shared dashboard.")
    parser.add_argument("--server-url")
    parser.add_argument("--ingest-token")
    parser.add_argument("--auth-path", type=Path, default=SOURCE_AUTH_PATH)
    parser.add_argument("--print-payload", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = probe_quota(args.auth_path)
    if args.print_payload:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    config = load_config(args)
    result = post_report(config["server_url"], config["ingest_token"], payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
