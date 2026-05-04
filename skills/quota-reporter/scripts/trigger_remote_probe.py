#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_REPO = "callzhang/quota-report-hub"
DEFAULT_WORKFLOW = "probe-auth-pool.yml"
DEFAULT_REF = "main"
DEFAULT_CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_to_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def run_json_command(args: list[str]) -> object:
    completed = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout or "null")


def trigger_workflow(repo: str, workflow: str, ref: str) -> None:
    subprocess.run(
        ["gh", "workflow", "run", workflow, "--repo", repo, "--ref", ref],
        check=True,
    )


def list_runs(repo: str, workflow: str, limit: int) -> list[dict]:
    payload = run_json_command(
        [
            "gh",
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            workflow,
            "--limit",
            str(limit),
            "--json",
            "databaseId,event,status,conclusion,headBranch,createdAt,updatedAt,displayTitle",
        ]
    )
    return payload if isinstance(payload, list) else []


def select_triggered_run(runs: list[dict], ref: str, started_after: datetime) -> dict | None:
    candidates = []
    for run in runs:
        if run.get("event") != "workflow_dispatch":
            continue
        if run.get("headBranch") != ref:
            continue
        created_at = iso_to_datetime(run.get("createdAt"))
        if created_at is None or created_at < started_after:
            continue
        candidates.append((created_at, run))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def wait_for_triggered_run(repo: str, workflow: str, ref: str, started_after: datetime, timeout_seconds: int) -> dict:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        run = select_triggered_run(list_runs(repo, workflow, limit=10), ref, started_after)
        if run is not None:
            return run
        time.sleep(2)
    raise RuntimeError(
        f"Timed out after {timeout_seconds}s waiting for workflow_dispatch run of {workflow} on {ref}"
    )


def watch_run(repo: str, run_id: int, exit_status: bool) -> int:
    args = ["gh", "run", "watch", str(run_id), "--repo", repo]
    if exit_status:
        args.append("--exit-status")
    completed = subprocess.run(args, check=False)
    return completed.returncode


def load_local_config(config_path: Path) -> dict:
    return json.loads(config_path.read_text(encoding="utf-8"))


def fetch_status(auth_pool_url: str, auth_pool_user_token: str) -> dict:
    request = Request(
        auth_pool_url.rstrip("/") + "/api/status",
        headers={"Authorization": f"Bearer {auth_pool_user_token}"},
        method="GET",
    )
    with urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def summarize_status_items(items: list[dict]) -> list[dict]:
    summaries = []
    for item in items:
        windows = item.get("windows") or {}
        five_hour = windows.get("5h") or {}
        one_week = windows.get("1week") or {}
        summaries.append(
            {
                "source": item.get("source"),
                "account_id": item.get("account_id"),
                "email": item.get("email"),
                "plan_name": item.get("plan_name"),
                "status": item.get("status"),
                "error": item.get("error"),
                "five_h_remaining_percent": five_hour.get("remaining_percent"),
                "one_week_remaining_percent": one_week.get("remaining_percent"),
                "windows_stale": bool(item.get("windows_stale")),
                "reported_at": item.get("reported_at"),
            }
        )
    return summaries


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Trigger the remote GitHub Actions auth-pool probe workflow, optionally watch the run, "
            "and optionally fetch the latest compact per-auth results from the hub afterwards."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repository that hosts the probe workflow.")
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW, help="GitHub Actions workflow filename to trigger.")
    parser.add_argument("--ref", default=DEFAULT_REF, help="Git ref or branch name for the triggered workflow run.")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=60,
        help="Maximum time to wait for GitHub to create the workflow_dispatch run after triggering it.",
    )
    parser.add_argument(
        "--config-path",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="Local quota-reporter config used to read the hub URL and personal token when fetching post-run results.",
    )
    parser.add_argument("--no-watch", action="store_true", help="Trigger the workflow but do not attach to the live GitHub Actions log.")
    parser.add_argument(
        "--no-exit-status",
        action="store_true",
        help="When watching, do not propagate the workflow conclusion as the script exit code.",
    )
    parser.add_argument(
        "--no-results",
        action="store_true",
        help="Do not query the hub for compact per-auth results after the workflow is triggered or watched.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    started_after = utc_now()
    trigger_workflow(args.repo, args.workflow, args.ref)
    run = wait_for_triggered_run(
        repo=args.repo,
        workflow=args.workflow,
        ref=args.ref,
        started_after=started_after,
        timeout_seconds=args.timeout_seconds,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "repo": args.repo,
                "workflow": args.workflow,
                "ref": args.ref,
                "run_id": run["databaseId"],
                "status": run.get("status"),
                "conclusion": run.get("conclusion"),
                "created_at": run.get("createdAt"),
                "watching": not args.no_watch,
            },
            ensure_ascii=False,
        )
    )
    if args.no_watch:
        watch_code = 0
    else:
        watch_code = watch_run(
            repo=args.repo,
            run_id=int(run["databaseId"]),
            exit_status=not args.no_exit_status,
        )

    if not args.no_results:
        config = load_local_config(args.config_path)
        try:
            status = fetch_status(config["auth_pool_url"], config["auth_pool_user_token"])
        except HTTPError as exc:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "run_id": run["databaseId"],
                        "results_error": f"status fetch failed ({exc.code})",
                    },
                    ensure_ascii=False,
                )
            )
            return watch_code or 1
        print(
            json.dumps(
                {
                    "ok": True,
                    "run_id": run["databaseId"],
                    "results": summarize_status_items(status.get("items") or []),
                },
                ensure_ascii=False,
            )
        )

    return watch_code


if __name__ == "__main__":
    raise SystemExit(main())
