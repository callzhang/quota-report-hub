import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock
import json


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from quota_reporters import (
    archive_current_codex_auth,
    discover_claude_executable,
    latest_codex_snapshots_by_account,
    parse_claude_rate_limit_headers,
    probe_claude,
    probe_claude_rate_limits,
    read_claude_keychain_credentials,
    run_claude_status,
    summarize_claude_stats,
)  # noqa: E402


class ReporterScriptsTest(unittest.TestCase):
    def test_parse_claude_rate_limit_headers_returns_windows(self):
        headers = {
            "anthropic-ratelimit-unified-5h-utilization": "0.42",
            "anthropic-ratelimit-unified-5h-reset": "1776649200",
            "anthropic-ratelimit-unified-7d-utilization": "0.17",
            "anthropic-ratelimit-unified-7d-reset": "1777167600",
        }

        windows = parse_claude_rate_limit_headers(headers)

        self.assertEqual(windows["5h"]["used_percent"], 42.0)
        self.assertEqual(windows["5h"]["remaining_percent"], 58.0)
        self.assertEqual(windows["1week"]["used_percent"], 17.0)
        self.assertEqual(windows["1week"]["remaining_percent"], 83.0)

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

    def test_read_claude_keychain_credentials_returns_none_off_darwin(self):
        with mock.patch("quota_reporters.sys.platform", "linux"):
            self.assertIsNone(read_claude_keychain_credentials())

    def test_probe_claude_rate_limits_reports_missing_keychain_token(self):
        with mock.patch("quota_reporters.read_claude_keychain_credentials", return_value=None):
            result = probe_claude_rate_limits()

        self.assertFalse(result["available"])
        self.assertEqual(result["windows"]["5h"], None)
        self.assertEqual(result["windows"]["1week"], None)

    def test_probe_claude_rate_limits_reads_exact_claude_keychain(self):
        error = urllib.error.HTTPError(
            url="https://api.anthropic.com/api/oauth/usage",
            code=401,
            msg="Unauthorized",
            hdrs={
                "Content-Type": "application/json",
            },
            fp=mock.Mock(read=mock.Mock(return_value=b'{"type":"error","error":{"message":"OAuth authentication is currently not supported."}}')),
        )

        with mock.patch(
            "quota_reporters.read_claude_keychain_credentials",
            return_value={
                "claudeAiOauth": {
                    "accessToken": "exact-claude-oauth-token",
                    "refreshToken": "exact-claude-refresh-token",
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x",
                    "expiresAt": 1776668828033,
                }
            },
        ):
            with mock.patch("quota_reporters.urllib.request.urlopen", side_effect=error):
                result = probe_claude_rate_limits()

        self.assertFalse(result["available"])
        self.assertEqual(result["source"], "keychain")
        self.assertEqual(result["status_code"], 401)
        self.assertEqual(result["subscription_type"], "max")
        self.assertEqual(result["rate_limit_tier"], "default_claude_max_20x")
        self.assertEqual(result["api_error"], "OAuth authentication is currently not supported.")

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
