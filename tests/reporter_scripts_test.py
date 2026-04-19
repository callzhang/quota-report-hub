import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import json


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from quota_reporters import (
    archive_current_codex_auth,
    discover_claude_executable,
    latest_codex_snapshots_by_account,
    probe_claude,
    run_claude_status,
    summarize_claude_stats,
)  # noqa: E402


class ReporterScriptsTest(unittest.TestCase):
    def test_summarize_claude_stats_aggregates_totals(self):
        summary = summarize_claude_stats(
            {
                "lastComputedDate": "2026-04-19",
                "totalSessions": 4,
                "totalMessages": 18,
                "dailyActivity": [{"date": "2026-04-19", "messageCount": 7, "sessionCount": 2, "toolCallCount": 3}],
                "modelUsage": {
                    "claude-sonnet-4-6": {
                        "inputTokens": 1200,
                        "outputTokens": 300,
                        "cacheReadInputTokens": 800,
                        "cacheCreationInputTokens": 200,
                        "costUSD": 1.2,
                    },
                    "claude-opus-4-6": {
                        "inputTokens": 50,
                        "outputTokens": 25,
                        "cacheReadInputTokens": 10,
                        "cacheCreationInputTokens": 5,
                        "costUSD": 0.4,
                    },
                },
            }
        )

        self.assertEqual(summary["total_sessions"], 4)
        self.assertEqual(summary["total_messages"], 18)
        self.assertEqual(summary["latest_activity_date"], "2026-04-19")
        self.assertEqual(summary["total_input_tokens"], 1250)
        self.assertEqual(summary["total_output_tokens"], 325)
        self.assertEqual(summary["total_cache_read_tokens"], 810)
        self.assertEqual(summary["total_cache_write_tokens"], 205)
        self.assertEqual(len(summary["models"]), 2)

    def test_probe_claude_reports_missing_binary_cleanly(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = probe_claude(Path(temp_dir), claude_bin="/nonexistent/claude")

        self.assertEqual(payload["source"], "claude")
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["error"], "claude command not found")
        self.assertIsNone(payload["windows"]["5h"])
        self.assertIsNone(payload["windows"]["1week"])

    def test_discover_claude_executable_rejects_missing_explicit_path(self):
        self.assertIsNone(discover_claude_executable("/nonexistent/claude"))

    def test_run_claude_status_marks_unavailable_environment(self):
        completed = mock.Mock(returncode=0, stdout="/status isn't available in this environment.\n", stderr="")
        with mock.patch("quota_reporters.subprocess.run", return_value=completed):
            status = run_claude_status("claude")

        self.assertFalse(status["available"])
        self.assertEqual(status["text"], "/status isn't available in this environment.")

    def test_archive_current_codex_auth_creates_stable_snapshot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "auth.json"
            archive_dir = base / "archive"
            source.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T21:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "id_token": "x.eyJlbWFpbCI6ICJhQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiQSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogInRlYW0ifX0.y",
                        },
                    }
                ),
                encoding="utf-8",
            )

            snapshot_path = archive_current_codex_auth(source, archive_dir)

            self.assertIsNotNone(snapshot_path)
            self.assertTrue(snapshot_path.exists())
            self.assertTrue(snapshot_path.name.startswith("auth-acct-1-"))

    def test_latest_codex_snapshots_by_account_prefers_latest_refresh(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            archive_dir = Path(temp_dir)

            old = archive_dir / "auth-acct-1-old.json"
            old.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T20:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "id_token": "x.eyJlbWFpbCI6ICJhQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiQSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogInRlYW0ifX0.y",
                        },
                    }
                ),
                encoding="utf-8",
            )
            new = archive_dir / "auth-acct-1-new.json"
            new.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T21:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "id_token": "x.eyJlbWFpbCI6ICJhQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiQSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogInRlYW0ifX0.y",
                        },
                    }
                ),
                encoding="utf-8",
            )
            other = archive_dir / "auth-acct-2.json"
            other.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T19:00:00Z",
                        "tokens": {
                            "account_id": "acct-2",
                            "id_token": "x.eyJlbWFpbCI6ICJiQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiQiIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogInBybyJ9fQ.y",
                        },
                    }
                ),
                encoding="utf-8",
            )

            snapshots = latest_codex_snapshots_by_account(archive_dir)

            self.assertEqual(snapshots, [new, other])


if __name__ == "__main__":
    unittest.main()
