import sys
import subprocess
import tempfile
import unittest
import urllib.error
import io
import contextlib
from pathlib import Path
from unittest import mock
import json


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import report_all_usage  # noqa: E402
import report_codex_quota  # noqa: E402
from quota_reporters import (
    archive_current_codex_auth,
    discover_claude_executable,
    latest_codex_snapshots_by_account,
    parse_claude_auth_status_text,
    parse_claude_rate_limit_headers,
    parse_claude_statusline_rate_limits,
    probe_claude,
    read_claude_keychain_credentials,
    run_claude_status,
    summarize_claude_stats,
)  # noqa: E402


class ReporterScriptsTest(unittest.TestCase):
    def test_parse_claude_auth_status_text_extracts_account_details(self):
        details = parse_claude_auth_status_text(
            "Login method: Claude Max account\nOrganization: Derek Zen\nEmail: leizhang0121@gmail.com\n"
        )

        self.assertEqual(details["login_method"], "Claude Max account")
        self.assertEqual(details["organization"], "Derek Zen")
        self.assertEqual(details["email"], "leizhang0121@gmail.com")
        self.assertEqual(details["subscription_type"], "max")

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

    def test_parse_claude_statusline_rate_limits_returns_windows(self):
        snapshot = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 10,
                    "resets_at": 1776649200,
                },
                "seven_day": {
                    "used_percentage": 100,
                    "resets_at": 1777167600,
                },
            }
        }

        windows = parse_claude_statusline_rate_limits(snapshot)

        self.assertEqual(windows["5h"]["used_percent"], 10.0)
        self.assertEqual(windows["1week"]["used_percent"], 100.0)

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

    def test_run_claude_status_returns_timeout_instead_of_hanging(self):
        with mock.patch(
            "quota_reporters.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["claude", "-p", "/status"], timeout=10),
        ):
            status = run_claude_status("claude")

        self.assertFalse(status["available"])
        self.assertIsNone(status["exit_code"])
        self.assertEqual(status["text"], "/status timed out after 10s")

    def test_read_claude_keychain_credentials_returns_none_off_darwin(self):
        with mock.patch("quota_reporters.sys.platform", "linux"):
            self.assertIsNone(read_claude_keychain_credentials())

    def test_probe_claude_prefers_auth_status_text_account_details(self):
        auth_json = mock.Mock(returncode=0, stdout='{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}', stderr="")
        auth_text = mock.Mock(
            returncode=0,
            stdout="Login method: Claude Max account\nOrganization: Derek Zen\nEmail: leizhang0121@gmail.com\n",
            stderr="",
        )
        status_result = mock.Mock(returncode=0, stdout="/status isn't available in this environment.\n", stderr="")

        with mock.patch(
            "quota_reporters.discover_claude_executable",
            return_value="/usr/local/bin/claude",
        ):
            with mock.patch(
                "quota_reporters.subprocess.run",
                side_effect=[auth_json, auth_text, status_result],
            ):
                with mock.patch(
                    "quota_reporters.read_claude_credentials",
                    return_value={
                        "claudeAiOauth": {
                            "accessToken": "exact-claude-oauth-token",
                            "subscriptionType": "max",
                            "rateLimitTier": "default_claude_max_20x",
                            "expiresAt": 1776668828033,
                        }
                    },
                ):
                    with mock.patch(
                        "quota_reporters.read_claude_statusline_snapshot",
                        return_value={
                            "captured_at": "2026-04-20T04:00:00Z",
                            "rate_limits": {
                                "five_hour": {"used_percentage": 10, "resets_at": 1776649200},
                                "seven_day": {"used_percentage": 100, "resets_at": 1777167600},
                            },
                        },
                    ):
                        with mock.patch("quota_reporters.read_claude_stats", return_value=None):
                            payload = probe_claude(Path("/tmp/claude-home"))

        self.assertEqual(payload["email"], "leizhang0121@gmail.com")
        self.assertEqual(payload["name"], "Derek Zen")
        self.assertEqual(payload["plan_name"], "Max")
        self.assertEqual(payload["account_id"], "claude-leizhang0121@gmail.com")
        self.assertEqual(payload["usage_summary"]["organization"], "Derek Zen")
        self.assertEqual(payload["usage_summary"]["login_method"], "Claude Max account")
        self.assertEqual(payload["windows"]["5h"]["used_percent"], 10.0)
        self.assertEqual(payload["usage_summary"]["rate_limit_probe"]["source"], "statusline_snapshot")
        self.assertEqual(payload["usage_summary"]["statusline_snapshot"]["captured_at"], "2026-04-20T04:00:00Z")

    def test_probe_claude_auth_commands_drop_env_overrides(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(kwargs.get("env", {}))
            if args[-1] == "--text":
                return mock.Mock(returncode=0, stdout="Login method: Claude Max account\nEmail: leizhang0121@gmail.com\n", stderr="")
            if args[:3] == ["/usr/local/bin/claude", "auth", "status"]:
                return mock.Mock(returncode=0, stdout='{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}', stderr="")
            return mock.Mock(returncode=0, stdout="/status isn't available in this environment.\n", stderr="")

        with mock.patch.dict(
            "quota_reporters.os.environ",
            {
                "ANTHROPIC_AUTH_TOKEN": "stale-token",
                "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
            },
            clear=False,
        ):
            with mock.patch("quota_reporters.discover_claude_executable", return_value="/usr/local/bin/claude"):
                with mock.patch("quota_reporters.subprocess.run", side_effect=fake_run):
                    with mock.patch("quota_reporters.read_claude_keychain_credentials", return_value=None):
                        with mock.patch("quota_reporters.probe_claude_rate_limits", return_value={"windows": {"5h": None, "1week": None}, "available": False}):
                            with mock.patch("quota_reporters.read_claude_stats", return_value=None):
                                probe_claude(Path("/tmp/claude-home"))

        self.assertGreaterEqual(len(calls), 3)
        for env in calls[:3]:
            self.assertNotIn("ANTHROPIC_AUTH_TOKEN", env)
            self.assertNotIn("ANTHROPIC_BASE_URL", env)

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

    def test_collect_reports_skips_codex_payloads_without_quota_windows(self):
        args = mock.Mock(
            codex_auth_path=Path("/tmp/auth.json"),
            archive_dir=Path("/tmp/archive"),
            claude_home=Path("/tmp/claude"),
            claude_bin=None,
        )
        with mock.patch.object(
            report_all_usage,
            "probe_archived_codex_accounts",
            return_value=[
                {"source": "codex", "account_id": "skip-me", "windows": {"5h": None, "1week": None}},
                {
                    "source": "codex",
                    "account_id": "keep-me",
                    "windows": {"5h": {"remaining_percent": 20}, "1week": {"remaining_percent": 40}},
                },
            ],
        ):
            with mock.patch.object(report_all_usage, "probe_claude", return_value={"source": "claude", "account_id": "claude-1"}):
                payloads = report_all_usage.collect_reports(args)

        self.assertEqual(
            payloads,
            [
                {
                    "source": "codex",
                    "account_id": "keep-me",
                    "windows": {"5h": {"remaining_percent": 20}, "1week": {"remaining_percent": 40}},
                },
                {"source": "claude", "account_id": "claude-1"},
            ],
        )

    def test_report_codex_quota_skips_post_when_windows_missing(self):
        payload = {
            "source": "codex",
            "account_id": "acct-skip",
            "email": "skip@example.com",
            "windows": {"5h": None, "1week": None},
        }
        with mock.patch.object(report_codex_quota, "probe_codex", return_value=payload):
            with mock.patch.object(report_codex_quota, "post_report") as post_report:
                with mock.patch("sys.argv", ["report_codex_quota.py"]):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        report_codex_quota.main()

        post_report.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "codex quota windows unavailable")
        self.assertEqual(result["account_id"], "acct-skip")


if __name__ == "__main__":
    unittest.main()
