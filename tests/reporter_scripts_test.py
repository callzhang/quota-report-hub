import sys
import subprocess
import tempfile
import unittest
import io
import contextlib
import importlib.util
from pathlib import Path
from unittest import mock
import json


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import quota_guard  # noqa: E402
import install_quota_guard  # noqa: E402
from quota_reporters import (
    build_claude_auth_blob,
    discover_claude_executable,
    parse_claude_auth_status_text,
    parse_claude_rate_limit_headers,
    parse_claude_statusline_rate_limits,
    probe_claude,
    read_claude_keychain_credentials,
    run_claude_status,
    summarize_codex_exec_error,
    summarize_claude_stats,
    write_known_auth_state,
)  # noqa: E402

try:
    CLAUDE_CLOUD_PROBE_SPEC = importlib.util.spec_from_file_location(
        "probe_claude_auth_blob",
        REPO_ROOT / "scripts" / "probe_claude_auth_blob.py",
    )
    probe_claude_auth_blob = importlib.util.module_from_spec(CLAUDE_CLOUD_PROBE_SPEC)
    assert CLAUDE_CLOUD_PROBE_SPEC.loader is not None
    CLAUDE_CLOUD_PROBE_SPEC.loader.exec_module(probe_claude_auth_blob)
except ModuleNotFoundError:
    probe_claude_auth_blob = None


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

    def test_summarize_codex_exec_error_compacts_invalidated_auth_noise(self):
        stderr = """
Reading additional input from stdin...
2026-04-21T03:10:40.808565Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again., auth error code: token_invalidated
"""

        summary = summarize_codex_exec_error("", stderr)

        self.assertEqual(summary, "auth invalidated (token_invalidated)")

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

    def test_probe_claude_without_email_uses_single_missing_email_id(self):
        auth_json = mock.Mock(returncode=0, stdout='{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}', stderr="")
        auth_text = mock.Mock(returncode=0, stdout="Login method: Claude Max account\n", stderr="")
        status_result = mock.Mock(returncode=0, stdout="/status isn't available in this environment.\n", stderr="")

        with mock.patch("quota_reporters.discover_claude_executable", return_value="/usr/local/bin/claude"):
            with mock.patch("quota_reporters.subprocess.run", side_effect=[auth_json, auth_text, status_result]):
                with mock.patch("quota_reporters.read_claude_oauth_credentials", return_value=({"claudeAiOauth": {"subscriptionType": "max"}}, "credentials_file")):
                    with mock.patch("quota_reporters.read_claude_statusline_snapshot", return_value=None):
                        with mock.patch("quota_reporters.read_claude_stats", return_value=None):
                            payload = probe_claude(Path("/tmp/claude-home"))

        self.assertEqual(payload["account_id"], "claude-email-missing")

    def test_build_claude_auth_blob_includes_cli_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            claude_home = Path(temp_dir) / ".claude"
            claude_home.mkdir(parents=True, exist_ok=True)
            (claude_home.parent / ".claude.json").write_text(
                json.dumps({"theme": "auto", "oauthAccount": {"emailAddress": "derek@stardust.ai"}}) + "\n",
                encoding="utf-8",
            )
            with mock.patch("quota_reporters.probe_claude", return_value={
                "status": "ok",
                "account_id": "claude-derek@stardust.ai",
                "email": "derek@stardust.ai",
                "name": "Derek Zen",
                "plan_name": "Max",
                "usage_summary": {"oauth_expires_at": "1776933220595"},
            }):
                with mock.patch("quota_reporters.read_claude_oauth_credentials", return_value=({
                    "claudeAiOauth": {"accessToken": "token", "expiresAt": "1776933220595"}
                }, "credentials_file")):
                    blob_text, payload = build_claude_auth_blob(claude_home)
        blob = json.loads(blob_text)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(blob["claude_cli_state"]["theme"], "auto")

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

    def test_write_known_auth_state_records_current_auth_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "auth.json"
            known_auth_path = base / "known_auth.json"
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

            state = write_known_auth_state(
                source="codex",
                metadata=quota_guard.auth_metadata(source),
                known_auth_path=known_auth_path,
                last_uploaded_digest="digest-1",
                state_source="uploaded_to_auth_pool",
            )

            self.assertEqual(state["account_id"], "acct-1")
            self.assertEqual(state["last_uploaded_digest"], "digest-1")
            self.assertIsNone(state["last_uploaded_account_id"])
            self.assertIsNone(state["last_uploaded_auth_last_refresh"])
            self.assertEqual(state["state_source"], "uploaded_to_auth_pool")
            self.assertTrue(known_auth_path.exists())
            saved = json.loads(known_auth_path.read_text(encoding="utf-8"))
            self.assertIn("codex", saved["sources"])

    def test_source_needs_replacement_when_5h_is_low(self):
        codex_payload = {
            "source": "codex",
            "windows": {
                "5h": {"remaining_percent": 12},
                "1week": {"remaining_percent": 70},
            },
        }

        self.assertTrue(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_source_needs_replacement_when_weekly_quota_is_below_threshold(self):
        codex_payload = {
            "source": "codex",
            "windows": {
                "5h": {"remaining_percent": 80},
                "1week": {"remaining_percent": 2},
            },
        }

        self.assertTrue(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_source_does_not_need_replacement_when_quota_is_healthy(self):
        codex_payload = {
            "source": "codex",
            "windows": {
                "5h": {"remaining_percent": 62},
                "1week": {"remaining_percent": 5},
            },
        }

        self.assertFalse(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_maybe_replace_codex_auth_replaces_low_quota_live_auth(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            live_auth = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            live_auth.write_text(json.dumps({"tokens": {"account_id": "current"}}), encoding="utf-8")
            config = {
                "auth_pool_url": "https://quota-report-hub.vercel.app",
                "auth_pool_user_token": "qrp_token",
            }
            codex_payload = {
                "account_id": "current",
                "windows": {"5h": {"remaining_percent": 12}, "1week": {"remaining_percent": 70}},
            }

            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={
                "replacement": {
                    "account_id": "best",
                    "digest": "digest-best",
                    "email": "best@example.com",
                    "plan_name": "Pro",
                    "auth_json": json.dumps({"tokens": {"account_id": "best"}}),
                    "latest_report": {"remaining_5h": 88, "remaining_1week": 50},
                },
            }):
                with mock.patch.object(
                    quota_guard,
                    "auth_metadata",
                    return_value={
                        "digest": "digest-current",
                        "account_id": "best",
                        "auth_last_refresh": "2026-04-19T22:00:00Z",
                    },
                ):
                    with mock.patch.object(quota_guard, "write_known_auth_state", return_value={"digest": "digest-best"}):
                        replacement = quota_guard.maybe_replace_codex_auth(
                            config,
                            codex_payload,
                            live_auth,
                            known_auth_path,
                            threshold_percent=20.0,
                            weekly_threshold_percent=5.0,
                        )

            self.assertTrue(replacement["replaced"])
            self.assertEqual(replacement["to_account_id"], "best")
            self.assertEqual(json.loads(live_auth.read_text(encoding="utf-8"))["tokens"]["account_id"], "best")

    def test_maybe_replace_codex_auth_skips_when_current_quota_is_healthy(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        codex_payload = {
            "account_id": "current",
            "windows": {"5h": {"remaining_percent": 42}, "1week": {"remaining_percent": 70}},
        }

        with mock.patch.object(quota_guard, "fetch_best_auth") as fetch_best_auth:
            replacement = quota_guard.maybe_replace_codex_auth(
                config,
                codex_payload,
                Path("/tmp/auth.json"),
                Path("/tmp/known_auth.json"),
                threshold_percent=20.0,
                weekly_threshold_percent=5.0,
            )

        fetch_best_auth.assert_not_called()
        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "healthy")

    def test_maybe_replace_codex_auth_skips_when_best_auth_already_installed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            live_auth = Path(temp_dir) / "auth.json"
            live_auth.write_text(json.dumps({"tokens": {"account_id": "current"}}), encoding="utf-8")
            config = {
                "auth_pool_url": "https://quota-report-hub.vercel.app",
                "auth_pool_user_token": "qrp_token",
            }
            codex_payload = {
                "account_id": "current",
                "windows": {"5h": {"remaining_percent": 10}, "1week": {"remaining_percent": 70}},
            }

            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={
                "replacement": {
                    "account_id": "current",
                    "digest": "digest-same",
                    "auth_json": live_auth.read_text(encoding="utf-8"),
                },
            }):
                with mock.patch.object(
                    quota_guard,
                    "auth_metadata",
                    return_value={
                        "digest": "digest-same",
                        "account_id": "current",
                        "auth_last_refresh": "2026-04-19T21:00:00Z",
                    },
                ):
                    replacement = quota_guard.maybe_replace_codex_auth(
                        config,
                        codex_payload,
                        live_auth,
                        Path(temp_dir) / "known_auth.json",
                        threshold_percent=20.0,
                        weekly_threshold_percent=5.0,
                    )

        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "best_auth_already_installed")

    def test_maybe_replace_codex_auth_returns_null_replacement_when_server_has_no_better_auth(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        codex_payload = {
            "account_id": "current",
            "windows": {"5h": {"remaining_percent": 10}, "1week": {"remaining_percent": 70}},
        }

        with mock.patch.object(quota_guard, "fetch_best_auth", return_value={"ok": True, "replacement": None, "reason": "no_better_auth_available"}):
            replacement = quota_guard.maybe_replace_codex_auth(
                config,
                codex_payload,
                Path("/tmp/auth.json"),
                Path("/tmp/known_auth.json"),
                threshold_percent=20.0,
                weekly_threshold_percent=5.0,
            )

        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "no_better_auth_available")

    def test_run_guard_syncs_pool_and_fetches_replacement(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            claude_bin=None,
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
        )

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value={"account_id": "current"}):
                with mock.patch.object(quota_guard, "probe_claude", return_value={"account_id": "claude-a", "status": "ok"}) as probe_claude_mock:
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": True}) as sync_codex_auth_pool:
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": True}) as sync_claude_auth_pool:
                            with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}) as replace_codex_auth:
                                with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}) as replace_claude_auth:
                                    result = quota_guard.run_guard(args)
        sync_codex_auth_pool.assert_called_once_with(
            "https://quota-report-hub.vercel.app",
            "qrp_token",
            auth_path=args.codex_auth_path,
            known_auth_path=args.known_auth_path,
        )
        sync_claude_auth_pool.assert_called_once()
        replace_codex_auth.assert_called_once()
        replace_claude_auth.assert_called_once()
        probe_claude_mock.assert_called_once_with(args.claude_home)
        self.assertEqual(result["auth_pool_sync"]["codex"], {"ok": True, "uploaded": True})
        self.assertEqual(result["auth_pool_sync"]["claude"], {"ok": True, "uploaded": True})
        self.assertEqual(result["replacement"]["codex"]["reason"], "healthy")
        self.assertEqual(result["replacement"]["claude"]["reason"], "healthy")
        self.assertIn("claude", result)

    def test_maybe_replace_codex_auth_stays_put_when_codex_is_above_both_thresholds(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        codex_payload = {
            "account_id": "current",
            "windows": {"5h": {"remaining_percent": 42}, "1week": {"remaining_percent": 70}},
        }

        with mock.patch.object(quota_guard, "fetch_best_auth") as fetch_best_auth:
            replacement = quota_guard.maybe_replace_codex_auth(
                config,
                codex_payload,
                Path("/tmp/auth.json"),
                Path("/tmp/known_auth.json"),
                threshold_percent=20.0,
                weekly_threshold_percent=5.0,
            )

        fetch_best_auth.assert_not_called()
        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "healthy")

    def test_sync_current_codex_auth_pool_skips_when_digest_already_uploaded(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            auth_path.write_text(
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
            digest = quota_guard.auth_metadata(auth_path)["digest"]
            known_auth_path.write_text(
                json.dumps(
                    {"sources": {"codex": {
                        "last_uploaded_account_id": "acct-1",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": digest,
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry") as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_not_called()
        self.assertFalse(result["uploaded"])
        self.assertEqual(result["reason"], "already_uploaded")

    def test_sync_current_codex_auth_pool_skips_when_same_auth_is_still_current(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            auth_path.write_text(
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
            digest = quota_guard.auth_metadata(auth_path)["digest"]
            known_auth_path.write_text(
                json.dumps(
                    {"sources": {"codex": {
                        "last_uploaded_account_id": "acct-1",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": digest,
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "acct-1"}}) as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_not_called()
        self.assertFalse(result["uploaded"])
        self.assertEqual(result["reason"], "already_uploaded")

    def test_sync_current_codex_auth_pool_uploads_when_same_account_refreshes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T22:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "id_token": "x.eyJlbWFpbCI6ICJhQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiQSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogInRlYW0ifX0.y",
                        },
                    }
                ),
                encoding="utf-8",
            )
            known_auth_path.write_text(
                json.dumps(
                    {"sources": {"codex": {
                        "last_uploaded_account_id": "acct-1",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": "old-digest",
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "acct-1"}}) as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_called_once()
        self.assertTrue(result["uploaded"])
        self.assertEqual(result["known_auth"]["last_uploaded_account_id"], "acct-1")
        self.assertEqual(result["known_auth"]["last_uploaded_auth_last_refresh"], "2026-04-19T22:00:00Z")

    def test_sync_current_claude_auth_pool_skips_when_same_auth_is_still_current(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            claude_home = base / ".claude"
            credentials_path = claude_home / ".credentials.json"
            known_auth_path = base / "known_auth.json"
            claude_home.mkdir(parents=True, exist_ok=True)
            credentials_path.write_text(
                json.dumps(
                    {
                        "claudeAiOauth": {
                            "accessToken": "token",
                            "refreshToken": "refresh",
                            "expiresAt": "2026-04-23T12:00:00Z",
                            "scopes": ["openid"],
                            "subscriptionType": "max",
                            "rateLimitTier": "default_claude_max_20x",
                        }
                    }
                ),
                encoding="utf-8",
            )

            blob_text = json.dumps(
                {
                    "schema": "claude_credentials_v1",
                    "account_id": "claude-derek@stardust.ai",
                    "email": "derek@stardust.ai",
                    "name": "Derek Zen",
                    "plan_name": "Max",
                    "auth_last_refresh": "1776668828033",
                    "credentials": {
                        "claudeAiOauth": {
                            "accessToken": "token",
                            "refreshToken": "refresh",
                            "expiresAt": "2026-04-23T12:00:00Z",
                            "scopes": ["openid"],
                            "subscriptionType": "max",
                            "rateLimitTier": "default_claude_max_20x",
                        }
                    },
                },
                ensure_ascii=False,
            )
            metadata = quota_guard.claude_auth_blob_metadata(blob_text)
            known_auth_path.write_text(
                json.dumps(
                    {"sources": {"claude": {
                        "last_uploaded_account_id": metadata["account_id"],
                        "last_uploaded_auth_last_refresh": metadata["auth_last_refresh"],
                        "last_uploaded_digest": metadata["digest"],
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            payload = {
                "source": "claude",
                "account_id": metadata["account_id"],
                "email": "derek@stardust.ai",
                "name": "Derek Zen",
                "plan_name": "Max",
                "windows": {"5h": {"remaining_percent": 80}, "1week": {"remaining_percent": 60}},
            }

            with mock.patch("quota_reporters.build_claude_auth_blob", return_value=(blob_text, payload)):
                with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": metadata["account_id"]}}) as post_auth_pool_entry:
                    result = quota_guard.sync_current_claude_auth_pool(
                        "https://quota-report-hub.vercel.app",
                        "qrp_token",
                        claude_home=claude_home,
                        known_auth_path=known_auth_path,
                    )

        post_auth_pool_entry.assert_not_called()
        self.assertFalse(result["uploaded"])
        self.assertEqual(result["reason"], "already_uploaded")

    def test_install_supports_claude_statusline_settings(self):
        self.assertTrue(hasattr(install_quota_guard, "configure_claude_statusline"))
        self.assertTrue(hasattr(install_quota_guard, "CLAUDE_SETTINGS_PATH"))

    def test_install_linux_cron_uses_fifteen_minute_interval(self):
        lines = install_quota_guard.cron_lines("/usr/bin/python3", Path("/tmp/quota_guard.py"))
        self.assertTrue(lines[1].startswith("*/15 * * * * /usr/bin/python3 /tmp/quota_guard.py >> "))
        self.assertTrue(lines[1].endswith(" # quota-guard-managed"))

    def test_windows_scheduler_script_includes_startup_and_repetition_triggers(self):
        script = install_quota_guard.windows_scheduler_script(Path(r"C:\Users\derek\.agents\auth\quota-guard-run.ps1"))
        self.assertIn("New-ScheduledTaskTrigger -Once", script)
        self.assertIn("RepetitionInterval (New-TimeSpan -Minutes 15)", script)
        self.assertIn("New-ScheduledTaskTrigger -AtStartup", script)
        self.assertIn("Register-ScheduledTask -TaskName $TaskName", script)

    def test_write_windows_runner_writes_power_shell_wrapper(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_path = Path(temp_dir) / "quota-guard-run.ps1"

            with mock.patch.object(install_quota_guard, "WINDOWS_RUNNER_PATH", runner_path):
                result = install_quota_guard.write_windows_runner(r"/opt/Python/python.exe", Path(r"C:\repo\quota_guard.py"))
            self.assertEqual(result, runner_path)
            content = runner_path.read_text(encoding="utf-8")
            self.assertIn("$ErrorActionPreference = 'Stop'", content)
            self.assertIn(r"& '/opt/Python/python.exe' 'C:\repo\quota_guard.py' >>", content)
            self.assertIn(str(install_quota_guard.LOG_PATH), content)
            self.assertIn(str(install_quota_guard.ERROR_LOG_PATH), content)

    def test_install_windows_task_scheduler_uses_powershell_and_writes_runner(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_path = Path(temp_dir) / "quota-guard-run.ps1"
            with mock.patch.object(install_quota_guard, "WINDOWS_RUNNER_PATH", runner_path):
                with mock.patch("install_quota_guard.shutil.which", return_value="powershell.exe"):
                    with mock.patch("install_quota_guard.subprocess.run") as run_mock:
                        result = install_quota_guard.install_windows_task_scheduler(
                            r"C:\Python\python.exe",
                            Path(r"C:\repo\quota_guard.py"),
                        )
            self.assertEqual(result["scheduler"], "task_scheduler")
            self.assertEqual(result["task_name"], install_quota_guard.WINDOWS_TASK_NAME)
            self.assertTrue(runner_path.exists())
            runner_content = runner_path.read_text(encoding="utf-8")
            self.assertIn("& 'C:\\Python\\python.exe' 'C:\\repo\\quota_guard.py' >>", runner_content)
            self.assertGreaterEqual(run_mock.call_count, 1)
            first_call = run_mock.call_args_list[0][0][0]
            self.assertIn("powershell.exe", first_call[0])
            self.assertIn("-RunnerScript", first_call)
            self.assertIn(str(runner_path), first_call)

    def test_write_config_persists_auth_pool_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "quota-reporter.json"

            with mock.patch.object(install_quota_guard, "CONFIG_PATH", config_path):
                install_quota_guard.write_config(
                    "https://quota-report-hub.vercel.app",
                    "derek@stardust.ai",
                    "user-token",
                )

            saved = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["auth_pool_url"], "https://quota-report-hub.vercel.app")
            self.assertEqual(saved["auth_pool_user_email"], "derek@stardust.ai")
            self.assertEqual(saved["auth_pool_user_token"], "user-token")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_parses_statusline_snapshot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = Path(temp_dir) / "statusline-rate-limits.json"
            snapshot_path.write_text(
                json.dumps(
                    {
                        "rate_limits": {
                            "five_hour": {"used_percentage": 9, "resets_at": 1776657600},
                            "seven_day": {"used_percentage": 100, "resets_at": 1776970800},
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            windows = probe_claude_auth_blob.parse_statusline_snapshot(snapshot_path)

        self.assertEqual(windows["5h"]["remaining_percent"], 91.0)
        self.assertEqual(windows["1week"]["remaining_percent"], 0.0)

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_report_includes_nullable_fields(self):
        with mock.patch.object(
            probe_claude_auth_blob,
            "warm_statusline_snapshot",
            return_value=({"5h": {"remaining_percent": 80}, "1week": {"remaining_percent": 50}}, None),
        ):
            report = probe_claude_auth_blob.probe_blob(
                {
                    "account_id": "claude-test@example.com",
                    "email": "test@example.com",
                    "name": "Example",
                    "plan_name": "Max",
                    "auth_last_refresh": "1776933220595",
                    "credentials": {"claudeAiOauth": {"accessToken": "token"}},
                },
                claude_bin="claude",
                timeout_seconds=1,
            )
        self.assertIn("auth_path", report)
        self.assertIsNone(report["auth_path"])
        self.assertIn("model_context_window", report)
        self.assertIsNone(report["model_context_window"])

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_materializes_cli_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "home"
            workdir = Path(temp_dir) / "workspace"
            workdir.mkdir(parents=True, exist_ok=True)
            probe_claude_auth_blob.materialize_cli_state(
                home,
                workdir,
                {
                    "claude_cli_state": {
                        "theme": "auto",
                        "projects": {},
                    }
                },
            )
            state = json.loads((home / ".claude.json").read_text(encoding="utf-8"))
        self.assertEqual(state["theme"], "auto")
        self.assertIn(str(workdir), state["projects"])
        self.assertTrue(state["projects"][str(workdir)]["hasTrustDialogAccepted"])


if __name__ == "__main__":
    unittest.main()
