import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import trigger_remote_probe  # noqa: E402


class TriggerRemoteProbeTests(unittest.TestCase):
    def test_summarize_status_items_returns_per_auth_results(self) -> None:
        summaries = trigger_remote_probe.summarize_status_items(
            [
                {
                    "source": "codex",
                    "account_id": "acct-1",
                    "email": "a@example.com",
                    "plan_name": "Pro",
                    "status": "ok",
                    "error": None,
                    "windows_stale": False,
                    "reported_at": "2026-04-30T18:10:00Z",
                    "windows": {
                        "5h": {"remaining_percent": 82},
                        "1week": {"remaining_percent": 65},
                    },
                }
            ]
        )

        self.assertEqual(
            summaries,
            [
                {
                    "source": "codex",
                    "account_id": "acct-1",
                    "email": "a@example.com",
                    "plan_name": "Pro",
                    "status": "ok",
                    "error": None,
                    "five_h_remaining_percent": 82,
                    "one_week_remaining_percent": 65,
                    "windows_stale": False,
                    "reported_at": "2026-04-30T18:10:00Z",
                }
            ],
        )

    def test_select_triggered_run_chooses_latest_matching_dispatch(self) -> None:
        started_after = datetime(2026, 4, 30, 18, 0, tzinfo=timezone.utc)
        runs = [
            {
                "databaseId": 1,
                "event": "schedule",
                "headBranch": "main",
                "createdAt": "2026-04-30T18:05:00Z",
            },
            {
                "databaseId": 2,
                "event": "workflow_dispatch",
                "headBranch": "dev",
                "createdAt": "2026-04-30T18:06:00Z",
            },
            {
                "databaseId": 3,
                "event": "workflow_dispatch",
                "headBranch": "main",
                "createdAt": "2026-04-30T18:07:00Z",
            },
            {
                "databaseId": 4,
                "event": "workflow_dispatch",
                "headBranch": "main",
                "createdAt": "2026-04-30T18:08:00Z",
            },
        ]

        selected = trigger_remote_probe.select_triggered_run(runs, "main", started_after)

        self.assertIsNotNone(selected)
        self.assertEqual(selected["databaseId"], 4)

    def test_select_triggered_run_returns_none_when_no_matching_dispatch(self) -> None:
        started_after = datetime(2026, 4, 30, 18, 0, tzinfo=timezone.utc)
        runs = [
            {
                "databaseId": 1,
                "event": "schedule",
                "headBranch": "main",
                "createdAt": "2026-04-30T18:05:00Z",
            }
        ]

        selected = trigger_remote_probe.select_triggered_run(runs, "main", started_after)

        self.assertIsNone(selected)

    def test_parser_defaults_to_local_quota_reporter_config(self) -> None:
        parser = trigger_remote_probe.build_parser()
        args = parser.parse_args([])

        self.assertEqual(args.config_path, trigger_remote_probe.DEFAULT_CONFIG_PATH)
        self.assertFalse(args.no_results)


if __name__ == "__main__":
    unittest.main()
