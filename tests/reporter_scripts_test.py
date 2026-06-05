import sys
import subprocess
import tempfile
import unittest
import io
import contextlib
import importlib.util
import urllib.error
from datetime import datetime, timedelta, timezone
from base64 import urlsafe_b64encode
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
    codex_auth_refresh_delta,
    codex_probe_env,
    codex_usage_limit_exhausted,
    codex_usage_limit_reset_from_rate_limits,
    codex_usage_limit_reset_at,
    detect_claude_custom_provider_env,
    discover_claude_executable,
    parse_claude_auth_status_text,
    parse_claude_rate_limit_headers,
    parse_claude_statusline_rate_limits,
    persist_auth_pool_token_upgrade,
    post_auth_pool_entry,
    probe_codex,
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
    def test_codex_auth_refresh_delta_requires_same_account(self):
        delta = codex_auth_refresh_delta(
            {"account_id": "acct-1", "auth_last_refresh": "2026-04-22T00:00:00Z", "digest": "a"},
            {"account_id": "acct-2", "auth_last_refresh": "2026-04-22T01:00:00Z", "digest": "b"},
        )

        self.assertFalse(delta["same_account"])
        self.assertTrue(delta["account_changed"])
        self.assertFalse(delta["refreshed"])

    def test_probe_codex_can_capture_same_account_refresh_from_temp_auth(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            payload = {
                "last_refresh": "2026-04-22T00:00:00Z",
                "tokens": {
                    "account_id": "acct-1",
                    "access_token": "access",
                    "refresh_token": "refresh",
                    "id_token": self._jwt(
                        {
                            "email": "a@example.com",
                            "name": "A",
                            "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                        }
                    ),
                },
            }
            auth_path.write_text(json.dumps(payload), encoding="utf-8")

            def fake_run(args, env=None, capture_output=None, text=None, check=None):
                temp_auth_path = Path(env["CODEX_HOME"]) / "auth.json"
                refreshed = json.loads(temp_auth_path.read_text(encoding="utf-8"))
                refreshed["last_refresh"] = "2026-04-22T01:00:00Z"
                refreshed["tokens"]["refresh_token"] = "refresh-2"
                temp_auth_path.write_text(json.dumps(refreshed), encoding="utf-8")
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch("quota_reporters.subprocess.run", side_effect=fake_run):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "prolite",
                                "primary": {"used_percent": 5, "window_minutes": 300},
                                "secondary": {"used_percent": 10, "window_minutes": 10080},
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path, capture_refreshed_auth=True)

        self.assertTrue(report["refresh_capture"]["delta"]["refreshed"])
        self.assertEqual(
            report["refresh_capture"]["refreshed_metadata"]["auth_last_refresh"],
            "2026-04-22T01:00:00Z",
        )
        self.assertIn("\"refresh_token\": \"refresh-2\"", report["refresh_capture"]["refreshed_auth_json"])

    def test_persist_auth_pool_token_upgrade_updates_local_config(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "quota-reporter.json"
            config_path.write_text(
                json.dumps(
                    {
                        "auth_pool_url": "https://quota-report-hub.vercel.app",
                        "auth_pool_user_email": "old@stardust.ai",
                        "auth_pool_user_token": "old-token",
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch("quota_reporters.CONFIG_PATH", config_path):
                result = persist_auth_pool_token_upgrade(
                    {
                        "auth_pool_user_token": "new-token",
                        "token_upgrade": {
                            "email": "derek@stardust.ai",
                            "reason": "legacy_token_upgraded",
                        },
                    }
                )

            saved = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertTrue(result["updated"])
            self.assertEqual(saved["auth_pool_user_token"], "new-token")
            self.assertEqual(saved["auth_pool_user_email"], "derek@stardust.ai")

    def test_probe_codex_uses_stable_cache_root_instead_of_tmp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )
            seen = {}

            def fake_run(args, env=None, capture_output=None, text=None, check=None):
                seen["code_home"] = env["CODEX_HOME"]
                seen["workdir"] = args[args.index("-C") + 1]
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch("quota_reporters.subprocess.run", side_effect=fake_run):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "prolite",
                                "primary": {"used_percent": 5, "window_minutes": 300},
                                "secondary": {"used_percent": 10, "window_minutes": 10080},
                            },
                        }
                    },
                ):
                    probe_codex(auth_path)

        self.assertNotIn("/tmp/", seen["code_home"])
        self.assertTrue(seen["workdir"].endswith("/workspace"))

    def test_codex_probe_env_strips_provider_auth_overrides(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            codex_home = Path(temp_dir) / "codex-home"
            with mock.patch.dict(
                "os.environ",
                {
                    "PATH": "/usr/bin",
                    "OPENAI_API_KEY": "sk-wrong",
                    "OPENAI_BASE_URL": "https://wrong.example",
                    "CODEX_ACCESS_TOKEN": "wrong-token",
                    "ANTHROPIC_API_KEY": "anthropic-wrong",
                },
                clear=True,
            ):
                env = codex_probe_env(codex_home)

        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["CODEX_HOME"], str(codex_home))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("OPENAI_BASE_URL", env)
        self.assertNotIn("CODEX_ACCESS_TOKEN", env)
        self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_probe_codex_ignores_user_config_and_rules(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )
            seen = {}

            def fake_run(args, env=None, capture_output=None, text=None, check=None):
                seen["args"] = args
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch("quota_reporters.subprocess.run", side_effect=fake_run):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "prolite",
                                "primary": {"used_percent": 5, "window_minutes": 300},
                                "secondary": {"used_percent": 10, "window_minutes": 10080},
                            },
                        }
                    },
                ):
                    probe_codex(auth_path)

        self.assertIn("--ignore-user-config", seen["args"])
        self.assertIn("--ignore-rules", seen["args"])

    def test_probe_codex_maps_usage_limit_event_to_zero_remaining_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr=(
                    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
                    "or try again at Apr 28th, 2026 7:19 PM."
                ),
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": None,
                            "rate_limits": {
                                "plan_type": None,
                                "primary": None,
                                "secondary": None,
                                "credits": {
                                    "has_credits": False,
                                    "unlimited": False,
                                    "balance": "0",
                                },
                                "rate_limit_reached_type": None,
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["windows"]["5h"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["1week"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["5h"]["used_percent"], 100.0)
        self.assertEqual(report["usage_summary"]["credits"]["balance"], "0")
        self.assertIsNotNone(report["windows"]["5h"]["reset_at"])
        self.assertEqual(report["windows"]["1week"]["reset_at"], report["windows"]["5h"]["reset_at"])
        self.assertIsInstance(report["windows"]["5h"]["reset_in_seconds"], int)
        self.assertGreaterEqual(report["windows"]["5h"]["reset_in_seconds"], 0)
        self.assertEqual(report["usage_summary"]["next_retry_at"], report["windows"]["5h"]["reset_at"])

    def test_probe_codex_does_not_create_zero_windows_without_reset_time(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="ERROR: You've hit your usage limit.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": None,
                            "rate_limits": {
                                "plan_type": None,
                                "primary": None,
                                "secondary": None,
                                "credits": {
                                    "has_credits": False,
                                    "unlimited": False,
                                    "balance": "0",
                                },
                                "rate_limit_reached_type": None,
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "error")
        self.assertEqual(report["error"], "codex usage limit reached but reset time was not found")
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])
        self.assertIsNone(report["usage_summary"]["next_retry_at"])

    def test_probe_codex_maps_structured_reset_to_zero_remaining_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "team"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="ERROR: You've hit your usage limit.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "team",
                                "primary": {
                                    "used_percent": 100,
                                    "window_minutes": 300,
                                    "resets_in_seconds": 900,
                                },
                                "secondary": None,
                                "credits": {"has_credits": False, "unlimited": False, "balance": None},
                                "rate_limit_reached_type": "primary",
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["windows"]["5h"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["1week"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["5h"]["reset_in_seconds"], 900)
        self.assertEqual(report["windows"]["1week"]["reset_at"], report["windows"]["5h"]["reset_at"])
        self.assertEqual(report["usage_summary"]["next_retry_at"], report["windows"]["5h"]["reset_at"])

    def test_probe_codex_maps_rate_limited_exhausted_window_to_zero_remaining_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "team"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="Error: rate limited. Please try again later.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "team",
                                "primary": {
                                    "remaining_percent": 0,
                                    "window_minutes": 300,
                                    "resets_at": "2026-04-22T16:30:00Z",
                                },
                                "secondary": None,
                                "credits": {"has_credits": False, "unlimited": False, "balance": None},
                                "rate_limit_reached_type": "rate_limited",
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["windows"]["5h"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["1week"]["remaining_percent"], 0.0)
        self.assertEqual(report["usage_summary"]["rate_limit_reached_type"], "rate_limited")
        self.assertEqual(report["usage_summary"]["next_retry_at"], "2026-04-22T16:30:00Z")

    def test_probe_codex_does_not_map_transient_rate_limited_to_zero_remaining_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "team"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="Error: rate limited. Please try again later.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": "team",
                                "primary": {
                                    "remaining_percent": 23,
                                    "window_minutes": 300,
                                    "resets_at": "2026-04-22T16:30:00Z",
                                },
                                "secondary": None,
                                "credits": {"has_credits": False, "unlimited": False, "balance": None},
                                "rate_limit_reached_type": "rate_limited",
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "error")
        self.assertEqual(report["error"], "codex rate limited but quota exhaustion was not confirmed")
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])

    def test_probe_codex_maps_partial_missing_window_usage_limit_to_zero_remaining_windows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "a@example.com",
                                    "name": "A",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="ERROR: You've hit your usage limit, or try again at 4:26 PM.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": {"model_context_window": 272000},
                            "rate_limits": {
                                "plan_type": None,
                                "primary": {"used_percent": 100, "window_minutes": 300},
                                "secondary": None,
                                "credits": {
                                    "has_credits": False,
                                    "unlimited": False,
                                    "balance": None,
                                },
                                "rate_limit_reached_type": None,
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "ok")
        self.assertIsNone(report["error"])
        self.assertEqual(report["windows"]["5h"]["remaining_percent"], 0.0)
        self.assertEqual(report["windows"]["1week"]["remaining_percent"], 0.0)
        self.assertIsNotNone(report["windows"]["5h"]["reset_at"])
        self.assertEqual(report["windows"]["1week"]["reset_at"], report["windows"]["5h"]["reset_at"])

    def test_probe_codex_does_not_treat_creditless_team_account_as_zero_remaining_without_usage_limit_signal(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-22T00:00:00Z",
                        "tokens": {
                            "account_id": "acct-1",
                            "access_token": "access",
                            "refresh_token": "refresh",
                            "id_token": self._jwt(
                                {
                                    "email": "team@example.com",
                                    "name": "Team User",
                                    "https://api.openai.com/auth": {"chatgpt_plan_type": "team"},
                                }
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )

            completed = mock.Mock(
                returncode=1,
                stdout="",
                stderr="Visit https://chatgpt.com/codex/settings/usage for up-to-date information.",
            )
            with mock.patch("quota_reporters.subprocess.run", return_value=completed):
                with mock.patch(
                    "quota_reporters.latest_token_count_event",
                    return_value={
                        "payload": {
                            "info": None,
                            "rate_limits": {
                                "plan_type": "team",
                                "primary": None,
                                "secondary": None,
                                "credits": {
                                    "has_credits": False,
                                    "unlimited": False,
                                    "balance": None,
                                },
                                "rate_limit_reached_type": None,
                            },
                        }
                    },
                ):
                    report = probe_codex(auth_path)

        self.assertEqual(report["status"], "error")
        self.assertEqual(report["error"], "token_count event was present but missing quota details")
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])

    def test_codex_usage_limit_reset_at_parses_time_only_cli_message(self):
        reset_at, reset_in_seconds = codex_usage_limit_reset_at(
            "ERROR: You've hit your usage limit, or try again at 4:26 PM.",
            "",
            now=datetime.now(timezone.utc),
        )

        self.assertIsNotNone(reset_at)
        self.assertIsInstance(reset_in_seconds, int)
        self.assertGreater(reset_in_seconds, 0)
        self.assertLessEqual(reset_in_seconds, 24 * 60 * 60)

    def test_codex_usage_limit_reset_from_rate_limits_uses_top_level_next_retry_at(self):
        now = datetime(2026, 4, 22, 15, 0, tzinfo=timezone.utc)

        reset_at, reset_in_seconds = codex_usage_limit_reset_from_rate_limits(
            {"next_retry_at": "2026-04-22T16:30:00Z"},
            now,
        )

        self.assertEqual(reset_at, "2026-04-22T16:30:00Z")
        self.assertEqual(reset_in_seconds, 5400)

    def test_codex_usage_limit_exhausted_uses_structured_window_values(self):
        self.assertTrue(codex_usage_limit_exhausted({"primary": {"remaining_percent": 0}}, "", ""))
        self.assertTrue(codex_usage_limit_exhausted({"secondary": {"used_percent": 100}}, "", ""))
        self.assertFalse(
            codex_usage_limit_exhausted(
                {"primary": {"remaining_percent": 23}, "rate_limit_reached_type": "rate_limited"},
                "Error: rate limited. Please try again later.",
                "",
            )
        )

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
        now = datetime.now(timezone.utc)
        snapshot = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 10,
                    "resets_at": int((now + timedelta(hours=3)).timestamp()),
                },
                "seven_day": {
                    "used_percentage": 100,
                    "resets_at": int((now + timedelta(days=3)).timestamp()),
                },
            }
        }

        windows = parse_claude_statusline_rate_limits(snapshot)

        self.assertEqual(windows["5h"]["used_percent"], 10.0)
        self.assertEqual(windows["1week"]["used_percent"], 100.0)

    def test_parse_claude_statusline_rate_limits_ignores_expired_windows(self):
        now = datetime.now(timezone.utc)
        snapshot = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 10,
                    "resets_at": int((now - timedelta(hours=1)).timestamp()),
                },
                "seven_day": {
                    "used_percentage": 100,
                    "resets_at": int((now - timedelta(days=1)).timestamp()),
                },
            }
        }

        windows = parse_claude_statusline_rate_limits(snapshot)

        self.assertIsNone(windows["5h"])
        self.assertIsNone(windows["1week"])

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
        with mock.patch(
            "quota_reporters.discover_claude_executable",
            return_value="/usr/local/bin/claude",
        ):
            with mock.patch(
                "quota_reporters.subprocess.run",
                side_effect=[auth_json, auth_text],
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
                    now = datetime.now(timezone.utc)
                    with mock.patch(
                        "quota_reporters.read_claude_statusline_snapshot",
                        return_value={
                            "captured_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                            "rate_limits": {
                                "five_hour": {"used_percentage": 10, "resets_at": int((now + timedelta(hours=3)).timestamp())},
                                "seven_day": {"used_percentage": 100, "resets_at": int((now + timedelta(days=3)).timestamp())},
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
        self.assertEqual(payload["usage_summary"]["quota_source"], "statusline_snapshot")
        self.assertEqual(payload["usage_summary"]["snapshot_reported_at"], now.replace(microsecond=0).isoformat().replace("+00:00", "Z"))
        self.assertNotIn("quota_status", payload["usage_summary"])
        self.assertNotIn("rate_limit_probe", payload["usage_summary"])
        self.assertNotIn("statusline_snapshot", payload["usage_summary"])
        self.assertNotIn("stats", payload["usage_summary"])

    def test_probe_claude_without_email_uses_single_missing_email_id(self):
        auth_json = mock.Mock(returncode=0, stdout='{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}', stderr="")
        auth_text = mock.Mock(returncode=0, stdout="Login method: Claude Max account\n", stderr="")
        with mock.patch("quota_reporters.discover_claude_executable", return_value="/usr/local/bin/claude"):
            with mock.patch("quota_reporters.subprocess.run", side_effect=[auth_json, auth_text]):
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

    def test_detect_claude_custom_provider_env_reads_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            claude_home = Path(temp_dir) / ".claude"
            claude_home.mkdir(parents=True, exist_ok=True)
            (claude_home / "settings.json").write_text(
                json.dumps(
                    {
                        "env": {
                            "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
                            "ANTHROPIC_AUTH_TOKEN": "token",
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            detected = detect_claude_custom_provider_env(claude_home)

        self.assertEqual(detected["settings_key"], "env")
        self.assertEqual(detected["env"]["ANTHROPIC_BASE_URL"], "https://api.minimaxi.com/anthropic")
        self.assertIn("ANTHROPIC_AUTH_TOKEN", detected["env"])

    def test_build_claude_auth_blob_skips_custom_provider_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            claude_home = Path(temp_dir) / ".claude"
            claude_home.mkdir(parents=True, exist_ok=True)
            (claude_home / "settings.json").write_text(
                json.dumps(
                    {
                        "env1": {
                            "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
                            "ANTHROPIC_AUTH_TOKEN": "token",
                        }
                    }
                )
                + "\n",
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
                blob_text, payload = build_claude_auth_blob(claude_home)

        self.assertIsNone(blob_text)
        self.assertEqual(payload["status"], "error")
        self.assertIn("custom ANTHROPIC_* settings", payload["error"])
        self.assertEqual(payload["usage_summary"]["custom_provider_env"]["settings_key"], "env1")

    @staticmethod
    def _jwt(payload):
        header = urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).decode().rstrip("=")
        body = urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        return f"{header}.{body}.signature"

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

        self.assertEqual(len(calls), 2)
        for env in calls:
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

            self.assertEqual(state["account_id"], "a@example.com")
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
            "status": "ok",
            "windows": {
                "5h": {"remaining_percent": 12},
                "1week": {"remaining_percent": 70},
            },
        }

        self.assertTrue(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_source_needs_replacement_when_weekly_quota_is_below_threshold(self):
        codex_payload = {
            "source": "codex",
            "status": "ok",
            "windows": {
                "5h": {"remaining_percent": 80},
                "1week": {"remaining_percent": 2},
            },
        }

        self.assertTrue(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_source_does_not_need_replacement_when_quota_is_healthy(self):
        codex_payload = {
            "source": "codex",
            "status": "ok",
            "windows": {
                "5h": {"remaining_percent": 62},
                "1week": {"remaining_percent": 5},
            },
        }

        self.assertFalse(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_source_does_not_need_replacement_when_probe_failed(self):
        codex_payload = {
            "source": "codex",
            "status": "error",
            "error": "Error: No such file or directory (os error 2)",
            "windows": {"5h": None, "1week": None},
        }

        self.assertFalse(quota_guard.source_needs_replacement(codex_payload, 20.0, 5.0))

    def test_quota_payload_should_report_valid_windows_and_hard_invalidations_only(self):
        self.assertTrue(
            quota_guard.quota_payload_should_report(
                {
                    "status": "ok",
                    "account_id": "acct-1",
                    "windows": {"5h": {"remaining_percent": 42}, "1week": None},
                }
            )
        )
        self.assertTrue(
            quota_guard.quota_payload_should_report(
                {
                    "status": "error",
                    "error": "auth invalidated (token_invalidated)",
                    "account_id": "acct-1",
                    "windows": {"5h": None, "1week": None},
                }
            )
        )
        self.assertFalse(
            quota_guard.quota_payload_should_report(
                {
                    "status": "ok",
                    "account_id": "acct-1",
                    "windows": {"5h": None, "1week": None},
                }
            )
        )

    def test_report_current_quota_to_auth_pool_posts_complete_codex_windows(self):
        payload = {
            "source": "codex",
            "status": "ok",
            "account_id": "acct-1",
            "windows": {
                "5h": {"remaining_percent": 42, "reset_at": "2026-04-22T15:00:00Z"},
                "1week": {"remaining_percent": 80, "reset_at": "2026-04-28T15:00:00Z"},
            },
        }
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }

        with mock.patch.object(quota_guard, "post_auth_pool_quota", return_value={"ok": True}) as post_auth_pool_quota:
            result = quota_guard.report_current_quota_to_auth_pool(config, "codex", payload)

        self.assertTrue(result["reported"])
        post_auth_pool_quota.assert_called_once_with(
            "https://quota-report-hub.vercel.app",
            "qrp_token",
            source="codex",
            quota_payload=payload,
        )

    def test_report_current_quota_to_auth_pool_strips_refreshed_auth_secret(self):
        payload = {
            "source": "codex",
            "status": "ok",
            "account_id": "acct-1",
            "windows": {
                "5h": {"remaining_percent": 42, "reset_at": "2026-04-22T15:00:00Z"},
                "1week": {"remaining_percent": 80, "reset_at": "2026-04-28T15:00:00Z"},
            },
            "refresh_capture": {
                "delta": {"refreshed": True},
                "refreshed_metadata": {"account_id": "acct-1"},
                "refreshed_auth_json": "{\"secret\": true}",
            },
        }
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }

        with mock.patch.object(quota_guard, "post_auth_pool_quota", return_value={"ok": True}) as post_auth_pool_quota:
            result = quota_guard.report_current_quota_to_auth_pool(config, "codex", payload)

        self.assertTrue(result["reported"])
        posted_payload = post_auth_pool_quota.call_args.kwargs["quota_payload"]
        self.assertNotIn("refreshed_auth_json", posted_payload["refresh_capture"])
        self.assertIn("refreshed_auth_json", payload["refresh_capture"])

    def test_post_auth_pool_entry_returns_structured_http_error(self):
        error = urllib.error.HTTPError(
            "https://quota-report-hub.vercel.app/api/auth/upload",
            500,
            "Internal Server Error",
            {},
            io.BytesIO(b'{"error":"insert failed"}'),
        )

        with mock.patch("quota_reporters.urllib.request.urlopen", side_effect=error):
            result = post_auth_pool_entry(
                "https://quota-report-hub.vercel.app",
                "token",
                source="claude",
                auth_json_text='{"schema":"claude_credentials_v1"}',
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["status_code"], 500)
        self.assertEqual(result["error"], "insert failed")

    def test_report_current_quota_to_auth_pool_returns_error_when_post_fails(self):
        payload = {
            "source": "claude",
            "status": "ok",
            "account_id": "claude-a@example.com",
            "windows": {"5h": {"remaining_percent": 42}, "1week": None},
        }
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }

        with mock.patch.object(
            quota_guard,
            "post_auth_pool_quota",
            return_value={"ok": False, "status_code": 500, "error": "quota write failed"},
        ):
            result = quota_guard.report_current_quota_to_auth_pool(config, "claude", payload)

        self.assertFalse(result["ok"])
        self.assertFalse(result["reported"])
        self.assertEqual(result["reason"], "post_auth_pool_quota_failed")

    def test_report_current_quota_to_auth_pool_skips_incomplete_codex_windows(self):
        payload = {
            "source": "codex",
            "status": "ok",
            "account_id": "acct-1",
            "windows": {"5h": {"remaining_percent": 42}, "1week": {"remaining_percent": 80}},
        }
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }

        with mock.patch.object(quota_guard, "post_auth_pool_quota", return_value={"ok": True}) as post_auth_pool_quota:
            result = quota_guard.report_current_quota_to_auth_pool(config, "codex", payload)

        self.assertFalse(result["reported"])
        self.assertEqual(result["reason"], "quota_unavailable")
        post_auth_pool_quota.assert_not_called()

    def test_report_current_quota_to_auth_pool_skips_unavailable_quota(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        payload = {
            "source": "claude",
            "status": "ok",
            "account_id": "claude-acct-1",
            "windows": {"5h": None, "1week": None},
        }

        with mock.patch.object(quota_guard, "post_auth_pool_quota") as post_auth_pool_quota:
            result = quota_guard.report_current_quota_to_auth_pool(config, "claude", payload)

        self.assertFalse(result["reported"])
        self.assertEqual(result["reason"], "quota_unavailable")
        post_auth_pool_quota.assert_not_called()

    def test_current_codex_payload_persists_same_account_refresh_and_strips_secret(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            auth_path = Path(temp_dir) / "auth.json"
            old_auth = {
                "last_refresh": "2026-04-22T00:00:00Z",
                "tokens": {
                    "account_id": "acct-1",
                    "access_token": "access-1",
                    "refresh_token": "refresh-1",
                    "id_token": self._jwt({"email": "a@example.com"}),
                },
            }
            refreshed_auth = {
                "last_refresh": "2026-04-22T01:00:00Z",
                "tokens": {
                    "account_id": "acct-1",
                    "access_token": "access-2",
                    "refresh_token": "refresh-2",
                    "id_token": self._jwt({"email": "a@example.com"}),
                },
            }
            auth_path.write_text(json.dumps(old_auth), encoding="utf-8")
            probe_payload = {
                "source": "codex",
                "status": "ok",
                "account_id": "a@example.com",
                "auth_last_refresh": "2026-04-22T00:00:00Z",
                "windows": {
                    "5h": {"remaining_percent": 42, "reset_at": "2026-04-22T15:00:00Z"},
                    "1week": {"remaining_percent": 80, "reset_at": "2026-04-28T15:00:00Z"},
                },
                "refresh_capture": {
                    "delta": {"refreshed": True},
                    "refreshed_metadata": {
                        "account_id": "a@example.com",
                        "auth_last_refresh": "2026-04-22T01:00:00Z",
                        "digest": "digest-2",
                        "email": "a@example.com",
                    },
                    "refreshed_auth_json": json.dumps(refreshed_auth),
                },
            }

            with mock.patch.object(quota_guard, "probe_codex", return_value=probe_payload) as probe_codex:
                payload = quota_guard.current_codex_payload(auth_path)

            probe_codex.assert_called_once_with(auth_path, capture_refreshed_auth=True)
            stored_auth = json.loads(auth_path.read_text(encoding="utf-8"))
            self.assertEqual(stored_auth["last_refresh"], "2026-04-22T01:00:00Z")
            self.assertEqual(stored_auth["tokens"]["refresh_token"], "refresh-2")
            self.assertEqual(payload["auth_last_refresh"], "2026-04-22T01:00:00Z")
            self.assertEqual(payload["local_auth_refresh"]["written"], True)
            self.assertNotIn("refreshed_auth_json", payload["refresh_capture"])

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
                "status": "ok",
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
            }) as fetch_best_auth:
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
            fetch_best_auth.assert_called_once_with(
                "https://quota-report-hub.vercel.app",
                "qrp_token",
                source="codex",
                current_account_id="current",
                current_quota={
                    "five_h_remaining_percent": 12.0,
                    "one_week_remaining_percent": 70.0,
                },
                exclude_account_ids=[],
                requester_id=None,
            )

    def test_maybe_replace_codex_auth_skips_when_current_quota_is_healthy(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        codex_payload = {
            "account_id": "current",
            "status": "ok",
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
                "status": "ok",
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
            "status": "ok",
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

    def test_maybe_replace_codex_auth_ignores_repair_auth_for_different_account(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            live_auth = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            live_auth.write_text(json.dumps({"tokens": {"account_id": "other"}}), encoding="utf-8")
            config = {
                "auth_pool_url": "https://quota-report-hub.vercel.app",
                "auth_pool_user_token": "qrp_token",
            }
            codex_payload = {
                "account_id": "other",
                "status": "ok",
                "windows": {"5h": {"remaining_percent": 0}, "1week": {"remaining_percent": 0}},
            }

            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={
                "ok": True,
                "replacement": None,
                "repair_auth": {
                    "account_id": "junjie.zhou@stardust.ai",
                    "digest": "digest-repair",
                    "email": "junjie.zhou@stardust.ai",
                    "plan_name": "Team",
                    "auth_json": json.dumps({"tokens": {"account_id": "junjie.zhou@stardust.ai"}}),
                    "latest_report": None,
                },
                "reason": "uploaded_auth_requires_reauth",
            }):
                replacement = quota_guard.maybe_replace_codex_auth(
                    config,
                    codex_payload,
                    live_auth,
                    known_auth_path,
                    threshold_percent=20.0,
                    weekly_threshold_percent=5.0,
                )
            installed_account_id = json.loads(live_auth.read_text(encoding="utf-8"))["tokens"]["account_id"]

        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "repair_auth_for_different_account")
        self.assertEqual(replacement["repair_account_id"], "junjie.zhou@stardust.ai")
        self.assertEqual(installed_account_id, "other")

    def test_uploaded_invalidated_auths_filters_by_current_viewer_uploads(self):
        status_payload = {
            "viewer_email": "derek@stardust.ai",
            "items": [
                {
                    "source": "codex",
                    "account_id": "pre-sales@stardust.ai",
                    "email": "pre-sales@stardust.ai",
                    "plan_name": "Team",
                    "uploader_email": "derek@stardust.ai",
                    "reporter_name": "derek@gpu4",
                    "hostname": "gpu4",
                    "status": "error",
                    "error": "auth invalidated (token_invalidated)",
                },
                {
                    "source": "codex",
                    "account_id": "sirui.chen@stardust.ai",
                    "email": "sirui.chen@stardust.ai",
                    "plan_name": "Team",
                    "uploader_email": "derek@stardust.ai",
                    "reporter_name": "sirui@macbook",
                    "hostname": "macbook",
                    "status": "error",
                    "error": "auth invalidated (token_invalidated)",
                },
                {
                    "source": "codex",
                    "account_id": "someone@stardust.ai",
                    "uploader_email": "someone@stardust.ai",
                    "status": "error",
                    "error": "auth invalidated (token_invalidated)",
                },
                {
                    "source": "codex",
                    "account_id": "healthy@stardust.ai",
                    "uploader_email": "derek@stardust.ai",
                    "status": "ok",
                    "error": None,
                },
            ],
            "archived_invalidated_items": [
                {
                    "source": "claude",
                    "account_id": "claude-leizhang0121@gmail.com",
                    "email": "leizhang0121@gmail.com",
                    "plan_name": "Max",
                    "uploader_email": "derek@stardust.ai",
                    "reporter_name": "derek@gpu4",
                    "hostname": "gpu4",
                    "status": "error",
                    "error": "claude auth invalid (authentication_error)",
                }
            ],
        }

        rows = quota_guard.uploaded_invalidated_auths(status_payload)

        self.assertEqual([row["account_id"] for row in rows], [
            "pre-sales@stardust.ai",
            "sirui.chen@stardust.ai",
            "claude-leizhang0121@gmail.com",
        ])

    def test_notify_uploaded_invalidated_auths_shows_one_summary_notification(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        status_payload = {
            "viewer_email": "derek@stardust.ai",
            "items": [
                {
                    "source": "codex",
                    "account_id": "pre-sales@stardust.ai",
                    "email": "pre-sales@stardust.ai",
                    "plan_name": "Team",
                    "uploader_email": "derek@stardust.ai",
                    "reporter_name": "derek@gpu4",
                    "hostname": "gpu4",
                    "status": "error",
                    "error": "auth invalidated (token_invalidated)",
                }
            ],
        }

        with mock.patch.object(quota_guard, "fetch_auth_pool_status", return_value=status_payload):
            with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as notify:
                result = quota_guard.notify_uploaded_invalidated_auths(config)

        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], "额度守护")
        self.assertTrue(result["shown"])
        self.assertEqual(result["count"], 1)
        self.assertIn("pre-sales@stardust.ai", result["message"])
        self.assertIn("你上传的 auth 已失效", result["message"])
        self.assertIn("重新登录这些账号", result["message"])

    def test_maybe_replace_claude_auth_skips_custom_provider_settings(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        claude_payload = {
            "account_id": "claude-derek@stardust.ai",
            "status": "ok",
            "windows": {"5h": {"remaining_percent": 1}, "1week": {"remaining_percent": 1}},
        }

        with mock.patch.object(
            quota_guard,
            "detect_claude_custom_provider_env",
            return_value={"settings_key": "env", "env": {"ANTHROPIC_AUTH_TOKEN": "token"}},
        ):
            with mock.patch.object(quota_guard, "fetch_best_auth") as fetch_best_auth:
                replacement = quota_guard.maybe_replace_claude_auth(
                    config,
                    claude_payload,
                    Path("/tmp/claude"),
                    Path("/tmp/known_auth.json"),
                    threshold_percent=20.0,
                    weekly_threshold_percent=5.0,
                )

        fetch_best_auth.assert_not_called()
        self.assertFalse(replacement["replaced"])
        self.assertEqual(replacement["reason"], "unsupported_custom_provider")

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
            no_toast=True,
            no_restart_codex_app_server=False,
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

    def test_run_guard_keeps_codex_path_when_claude_probe_crashes(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            claude_bin=None,
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=True,
            no_restart_codex_app_server=False,
        )
        codex_payload = {
            "source": "codex",
            "account_id": "codex-a",
            "status": "ok",
            "windows": {
                "5h": {"remaining_percent": 80, "reset_at": "2026-05-30T12:00:00Z"},
                "1week": {"remaining_percent": 70, "reset_at": "2026-06-01T12:00:00Z"},
            },
        }

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value=codex_payload):
                with mock.patch.object(quota_guard, "probe_claude", side_effect=RuntimeError("claude exploded")):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": True}) as sync_codex:
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": False, "reason": "skipped in test"}) as sync_claude:
                            with mock.patch.object(quota_guard, "report_current_quota_to_auth_pool", return_value={"ok": True, "reported": True}) as report_quota:
                                with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}) as replace_codex:
                                    with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "missing_stable_claude_auth"}) as replace_claude:
                                        result = quota_guard.run_guard(args)

        sync_codex.assert_called_once()
        sync_claude.assert_called_once()
        replace_codex.assert_called_once()
        replace_claude.assert_called_once()
        self.assertTrue(result["ok"])
        self.assertEqual(result["codex"], codex_payload)
        self.assertEqual(result["claude"]["status"], "error")
        self.assertIn("claude probe failed", result["claude"]["error"])
        self.assertEqual(result["errors"]["claude_probe"]["reason"], "claude_probe_failed")
        self.assertEqual(report_quota.call_count, 2)

    def test_run_guard_keeps_claude_path_when_codex_sync_crashes(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            claude_bin=None,
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=True,
            no_restart_codex_app_server=False,
        )
        claude_payload = {
            "source": "claude",
            "account_id": "claude-a",
            "status": "ok",
            "windows": {
                "5h": {"remaining_percent": 80},
                "1week": {"remaining_percent": 70},
            },
        }

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value={"account_id": "codex-a", "status": "ok"}):
                with mock.patch.object(quota_guard, "probe_claude", return_value=claude_payload):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", side_effect=RuntimeError("codex sync exploded")):
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": True}) as sync_claude:
                            with mock.patch.object(quota_guard, "report_current_quota_to_auth_pool", return_value={"ok": True, "reported": False}):
                                with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                    with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}) as replace_claude:
                                        result = quota_guard.run_guard(args)

        sync_claude.assert_called_once()
        replace_claude.assert_called_once()
        self.assertTrue(result["ok"])
        self.assertEqual(result["claude"], claude_payload)
        self.assertFalse(result["auth_pool_sync"]["codex"]["ok"])
        self.assertEqual(result["auth_pool_sync"]["codex"]["reason"], "codex_auth_pool_sync_failed")

    def test_run_guard_notifies_after_successful_replacement(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=False,
            no_restart_codex_app_server=False,
        )
        codex_replacement = {
            "ok": True,
            "replaced": True,
            "to_account_id": "acct-best",
            "to_email": "best@example.com",
            "to_plan_name": "Pro",
        }

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value={"account_id": "current"}):
                with mock.patch.object(quota_guard, "probe_claude", return_value={"account_id": "claude-a", "status": "ok"}):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": False}):
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": False}):
                            with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value=codex_replacement):
                                with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                    with mock.patch.object(quota_guard, "notify_uploaded_invalidated_auths", return_value={"shown": False, "reason": "no_uploaded_invalidated_auths"}):
                                        with mock.patch.object(quota_guard, "restart_codex_app_server", return_value={"ok": True, "restarted": True}) as restart:
                                            with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as notify:
                                                result = quota_guard.run_guard(args)

        notify.assert_called_once()
        restart.assert_called_once()
        self.assertEqual(notify.call_args.args[0], "额度守护")
        self.assertTrue(result["codex_app_server"]["restarted"])
        self.assertEqual(result["codex_app_server"]["trigger"], "codex_auth_changed")
        self.assertTrue(result["notifications"]["codex"]["shown"])
        self.assertIn("请退出当前 Codex 会话并重新打开", result["notifications"]["codex"]["message"])
        self.assertEqual(result["notifications"]["claude"]["reason"], "not_replaced")
        self.assertEqual(result["notifications"]["uploaded_invalidated_auths"]["reason"], "no_uploaded_invalidated_auths")

    def test_run_guard_restarts_codex_app_server_after_local_auth_refresh(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=True,
            no_restart_codex_app_server=False,
        )
        codex_payload = {
            "account_id": "current",
            "status": "ok",
            "local_auth_refresh": {"written": True},
        }

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value=codex_payload):
                with mock.patch.object(quota_guard, "probe_claude", return_value={"account_id": "claude-a", "status": "ok"}):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": False}):
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": False}):
                            with mock.patch.object(quota_guard, "report_current_quota_to_auth_pool", return_value={"ok": True, "reported": False}):
                                with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                    with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                        with mock.patch.object(quota_guard, "restart_codex_app_server", return_value={"ok": True, "restarted": True}) as restart:
                                            result = quota_guard.run_guard(args)

        restart.assert_called_once()
        self.assertTrue(result["codex_app_server"]["restarted"])
        self.assertEqual(result["codex_app_server"]["trigger"], "codex_auth_changed")

    def test_run_guard_restarts_stale_codex_app_server_after_manual_login(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=True,
            no_restart_codex_app_server=False,
        )
        stale_check = {
            "stale": True,
            "reason": "app_server_started_before_auth",
            "auth_mtime_epoch": 1779865804.0,
            "processes": [{"pid": 123, "started_at_epoch": 1779600000.0}],
        }

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value={"account_id": "current", "status": "ok"}):
                with mock.patch.object(quota_guard, "probe_claude", return_value={"account_id": "claude-a", "status": "ok"}):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": False}):
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": False}):
                            with mock.patch.object(quota_guard, "report_current_quota_to_auth_pool", return_value={"ok": True, "reported": False}):
                                with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                    with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False, "reason": "healthy"}):
                                        with mock.patch.object(quota_guard, "stale_codex_app_server_for_auth", return_value=stale_check):
                                            with mock.patch.object(quota_guard, "restart_codex_app_server", return_value={"ok": True, "restarted": True}) as restart:
                                                result = quota_guard.run_guard(args)

        restart.assert_called_once()
        self.assertTrue(result["codex_app_server"]["restarted"])
        self.assertEqual(result["codex_app_server"]["trigger"], "app_server_started_before_auth")
        self.assertEqual(result["codex_app_server"]["stale_check"], stale_check)

    def test_run_guard_can_disable_replacement_toasts(self):
        args = mock.Mock(
            auth_pool_url="https://quota-report-hub.vercel.app",
            auth_pool_user_token="qrp_token",
            codex_auth_path=Path("/tmp/auth.json"),
            known_auth_path=Path("/tmp/known_auth.json"),
            claude_home=Path("/tmp/claude"),
            threshold_percent=20.0,
            weekly_threshold_percent=5.0,
            no_toast=True,
            no_restart_codex_app_server=False,
        )

        with mock.patch.object(quota_guard, "load_config", return_value={
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }):
            with mock.patch.object(quota_guard, "current_codex_payload", return_value={"account_id": "current"}):
                with mock.patch.object(quota_guard, "probe_claude", return_value={"account_id": "claude-a", "status": "ok"}):
                    with mock.patch.object(quota_guard, "sync_current_codex_auth_pool", return_value={"ok": True, "uploaded": False}):
                        with mock.patch.object(quota_guard, "sync_current_claude_auth_pool", return_value={"ok": True, "uploaded": False}):
                            with mock.patch.object(quota_guard, "maybe_replace_codex_auth", return_value={"ok": True, "replaced": True}):
                                with mock.patch.object(quota_guard, "maybe_replace_claude_auth", return_value={"ok": True, "replaced": False}):
                                    with mock.patch.object(quota_guard, "restart_codex_app_server", return_value={"ok": True, "restarted": True}) as restart:
                                        with mock.patch.object(quota_guard, "show_desktop_notification") as notify:
                                            result = quota_guard.run_guard(args)

        notify.assert_not_called()
        restart.assert_called_once()
        self.assertTrue(result["codex_app_server"]["restarted"])
        self.assertEqual(result["codex_app_server"]["trigger"], "codex_auth_changed")
        self.assertEqual(result["notifications"], {})

    def test_restart_codex_app_server_stops_unmanaged_ephemeral_server(self):
        daemon_result = mock.Mock(
            returncode=1,
            stdout="",
            stderr="Error: app server is running but is not managed by codex app-server daemon",
        )

        with mock.patch.object(quota_guard, "codex_binary_for_app_server_restart", return_value="/bin/codex"):
            with mock.patch.object(quota_guard.subprocess, "run", return_value=daemon_result) as run:
                with mock.patch.object(quota_guard, "stop_unmanaged_codex_app_server", return_value={
                    "ok": True,
                    "stopped": True,
                    "terminated_pids": [123],
                    "killed_pids": [],
                    "failed": [],
                }) as stop:
                    result = quota_guard.restart_codex_app_server()

        run.assert_called_once()
        stop.assert_called_once()
        self.assertTrue(result["ok"])
        self.assertTrue(result["restarted"])
        self.assertEqual(result["reason"], "unmanaged_app_server_stopped")
        self.assertEqual(result["fallback"]["terminated_pids"], [123])

    def test_restart_codex_app_server_stops_unmanaged_server_when_standalone_install_missing(self):
        daemon_result = mock.Mock(
            returncode=1,
            stdout="",
            stderr="Error: managed standalone Codex install not found at /home/derek/.codex/packages/standalone/current/codex",
        )

        with mock.patch.object(quota_guard, "codex_binary_for_app_server_restart", return_value="/bin/codex"):
            with mock.patch.object(quota_guard.subprocess, "run", return_value=daemon_result):
                with mock.patch.object(quota_guard, "stop_unmanaged_codex_app_server", return_value={
                    "ok": True,
                    "stopped": True,
                    "terminated_pids": [456],
                    "killed_pids": [],
                    "failed": [],
                }) as stop:
                    result = quota_guard.restart_codex_app_server()

        stop.assert_called_once()
        self.assertTrue(result["ok"])
        self.assertTrue(result["restarted"])
        self.assertEqual(result["reason"], "unmanaged_app_server_stopped")
        self.assertEqual(result["fallback"]["terminated_pids"], [456])

    def test_unmanaged_codex_app_server_pids_only_matches_listener_processes(self):
        ps_result = mock.Mock(
            returncode=0,
            stdout=(
                "  101 node /home/derek/.local/bin/codex app-server --listen unix://\n"
                "  102 /path/codex app-server proxy\n"
                "  103 node /home/derek/.local/bin/codex exec prompt\n"
                "  104 grep codex app-server --listen\n"
                "  105 /bin/bash -c ps | grep codex app-server --listen\n"
                "  106 /usr/sbin/tailscaled be-child ssh --cmd=codex app-server --listen\n"
            ),
            stderr="",
        )

        with mock.patch.object(quota_guard.platform, "system", return_value="Linux"):
            with mock.patch.object(quota_guard.subprocess, "run", return_value=ps_result):
                with mock.patch.object(quota_guard.os, "getpid", return_value=999):
                    self.assertEqual(quota_guard.unmanaged_codex_app_server_pids(), [101])

    def test_quota_guard_parser_supports_skip_self_update(self):
        parser = quota_guard.build_parser()
        args = parser.parse_args(["--skip-self-update"])

        self.assertTrue(args.skip_self_update)

    def test_self_update_skill_skips_when_already_current(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "state.json"
            quota_guard.write_self_update_state(
                {"last_applied_sha": "sha-1"},
                state_path=state_path,
            )

            with mock.patch.object(quota_guard, "github_latest_sha", return_value="sha-1"):
                result = quota_guard.self_update_skill(
                    skill_root=Path(temp_dir) / "quota-reporter",
                    state_path=state_path,
                )

        self.assertFalse(result["updated"])
        self.assertEqual(result["reason"], "already_current")

    def test_self_update_skill_copies_downloaded_skill_and_records_sha(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            state_path = base / "state.json"
            skill_root = base / "installed" / "quota-reporter"
            source_skill = base / "downloaded" / "skills" / "quota-reporter"
            (source_skill / "scripts").mkdir(parents=True)
            (source_skill / "SKILL.md").write_text("new skill\n", encoding="utf-8")
            (source_skill / "scripts" / "quota_guard.py").write_text("new guard\n", encoding="utf-8")
            skill_root.mkdir(parents=True)
            (skill_root / "SKILL.md").write_text("old skill\n", encoding="utf-8")

            with mock.patch.object(quota_guard, "github_latest_sha", return_value="sha-2"):
                with mock.patch.object(quota_guard, "download_github_tarball", return_value=base / "archive.tar.gz"):
                    with mock.patch.object(quota_guard, "unpack_skill_from_tarball", return_value=source_skill):
                        result = quota_guard.self_update_skill(
                            skill_root=skill_root,
                            state_path=state_path,
                        )

            state = json.loads(state_path.read_text(encoding="utf-8"))
            skill_text = (skill_root / "SKILL.md").read_text(encoding="utf-8")
            guard_text = (skill_root / "scripts" / "quota_guard.py").read_text(encoding="utf-8")

        self.assertTrue(result["updated"])
        self.assertEqual(result["to_sha"], "sha-2")
        self.assertEqual(skill_text, "new skill\n")
        self.assertEqual(guard_text, "new guard\n")
        self.assertEqual(state["last_applied_sha"], "sha-2")

    def test_maybe_replace_codex_auth_stays_put_when_codex_is_above_both_thresholds(self):
        config = {
            "auth_pool_url": "https://quota-report-hub.vercel.app",
            "auth_pool_user_token": "qrp_token",
        }
        codex_payload = {
            "account_id": "current",
            "status": "ok",
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

    def test_sync_current_codex_auth_pool_reuploads_when_digest_already_uploaded(self):
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
                        "last_uploaded_account_id": "a@example.com",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": digest,
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "a@example.com"}}) as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_called_once()
        self.assertTrue(result["uploaded"])
        self.assertEqual(result["reason"], "reuploaded_existing_auth")

    def test_sync_current_codex_auth_pool_reuploads_when_same_auth_is_still_current(self):
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
                        "last_uploaded_account_id": "a@example.com",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": digest,
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "a@example.com"}}) as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_called_once()
        self.assertTrue(result["uploaded"])
        self.assertEqual(result["reason"], "reuploaded_existing_auth")

    def test_sync_current_codex_auth_pool_skips_free_plan_uploads(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            known_auth_path = base / "known_auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "last_refresh": "2026-04-19T21:00:00Z",
                        "tokens": {
                            "account_id": "acct-free",
                            "id_token": "x.eyJlbWFpbCI6ICJmcmVlQGV4YW1wbGUuY29tIiwgIm5hbWUiOiAiRnJlZSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfcGxhbl90eXBlIjogImZyZWUifX0.y",
                        },
                    }
                ),
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry") as post_auth_pool_entry:
                with mock.patch("quota_reporters.delete_auth_pool_entry", return_value={"ok": True, "deleted": True}) as delete_auth_pool_entry:
                    result = quota_guard.sync_current_codex_auth_pool(
                        "https://quota-report-hub.vercel.app",
                        "qrp_token",
                        auth_path=auth_path,
                        known_auth_path=known_auth_path,
                    )

        post_auth_pool_entry.assert_not_called()
        delete_auth_pool_entry.assert_called_once_with(
            "https://quota-report-hub.vercel.app",
            "qrp_token",
            source="codex",
            account_id="free@example.com",
        )
        self.assertFalse(result["uploaded"])
        self.assertTrue(result["deleted"])
        self.assertEqual(result["reason"], "free_plan_removed_from_auth_pool")
        self.assertEqual(result["known_auth"]["plan_name"], "Free")
        self.assertEqual(result["known_auth"]["state_source"], "free_plan_excluded")

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
                        "last_uploaded_account_id": "a@example.com",
                        "last_uploaded_auth_last_refresh": "2026-04-19T21:00:00Z",
                        "last_uploaded_digest": "old-digest",
                    }}}
                )
                + "\n",
                encoding="utf-8",
            )

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "a@example.com"}}) as post_auth_pool_entry:
                result = quota_guard.sync_current_codex_auth_pool(
                    "https://quota-report-hub.vercel.app",
                    "qrp_token",
                    auth_path=auth_path,
                    known_auth_path=known_auth_path,
                )

        post_auth_pool_entry.assert_called_once()
        self.assertTrue(result["uploaded"])
        self.assertEqual(result["known_auth"]["last_uploaded_account_id"], "a@example.com")
        self.assertEqual(result["known_auth"]["last_uploaded_auth_last_refresh"], "2026-04-19T22:00:00Z")

    def test_sync_current_codex_auth_pool_keeps_previous_uploaded_accounts(self):
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

            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "a@example.com"}}):
                with mock.patch("quota_reporters.delete_auth_pool_entry", return_value={"ok": True, "deleted": True}) as delete_auth_pool_entry:
                    result = quota_guard.sync_current_codex_auth_pool(
                        "https://quota-report-hub.vercel.app",
                        "qrp_token",
                        auth_path=auth_path,
                        known_auth_path=known_auth_path,
                    )

        delete_auth_pool_entry.assert_not_called()
        self.assertTrue(result["uploaded"])
        self.assertNotIn("cleanup_result", result)

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

        post_auth_pool_entry.assert_called_once()
        self.assertTrue(result["uploaded"])
        self.assertEqual(result["reason"], "reuploaded_existing_auth")
        self.assertNotIn("claude", result)

    def test_sync_current_claude_auth_pool_skips_free_plan_uploads(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            claude_home = base / ".claude"
            known_auth_path = base / "known_auth.json"
            claude_home.mkdir(parents=True, exist_ok=True)

            blob_text = json.dumps(
                {
                    "schema": "claude_credentials_v1",
                    "account_id": "claude-free@example.com",
                    "email": "free@example.com",
                    "name": "Free",
                    "plan_name": "Free",
                    "auth_last_refresh": "1776668828033",
                    "credentials": {
                        "claudeAiOauth": {
                            "accessToken": "token",
                            "refreshToken": "refresh",
                            "expiresAt": "2026-04-23T12:00:00Z",
                            "scopes": ["openid"],
                            "subscriptionType": "free",
                            "rateLimitTier": "default_free",
                        }
                    },
                },
                ensure_ascii=False,
            )
            payload = {
                "source": "claude",
                "account_id": "claude-free@example.com",
                "email": "free@example.com",
                "name": "Free",
                "plan_name": "Free",
                "windows": {"5h": {"remaining_percent": 80}, "1week": {"remaining_percent": 60}},
            }

            with mock.patch("quota_reporters.build_claude_auth_blob", return_value=(blob_text, payload)):
                with mock.patch("quota_reporters.post_auth_pool_entry") as post_auth_pool_entry:
                    with mock.patch("quota_reporters.delete_auth_pool_entry", return_value={"ok": True, "deleted": True}) as delete_auth_pool_entry:
                        result = quota_guard.sync_current_claude_auth_pool(
                            "https://quota-report-hub.vercel.app",
                            "qrp_token",
                            claude_home=claude_home,
                            known_auth_path=known_auth_path,
                        )

        post_auth_pool_entry.assert_not_called()
        delete_auth_pool_entry.assert_called_once_with(
            "https://quota-report-hub.vercel.app",
            "qrp_token",
            source="claude",
            account_id="claude-free@example.com",
        )
        self.assertFalse(result["uploaded"])
        self.assertTrue(result["deleted"])
        self.assertEqual(result["reason"], "free_plan_removed_from_auth_pool")
        self.assertEqual(result["known_auth"]["plan_name"], "Free")
        self.assertEqual(result["known_auth"]["state_source"], "free_plan_excluded")

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

    def test_install_quota_guard_defaults_to_hosted_hub(self):
        parser = install_quota_guard.build_parser()
        args = parser.parse_args([])
        self.assertEqual(args.auth_pool_url, "https://quota-report-hub.vercel.app/")

    def test_install_quota_guard_parser_supports_skip_install_verification(self):
        parser = install_quota_guard.build_parser()
        args = parser.parse_args(["--skip-install-verification"])
        self.assertTrue(args.skip_install_verification)

    def test_verify_linux_crontab_requires_managed_entries(self):
        with mock.patch.object(install_quota_guard.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            with self.assertRaises(RuntimeError):
                install_quota_guard.verify_linux_crontab_registered()

    def test_run_install_verification_checks_scheduler_and_guard(self):
        worker_script = Path("/tmp/quota_guard.py")
        scheduler_result = {"ok": True, "scheduler": "cron"}
        guard_process = mock.Mock(returncode=0, stdout='{"ok": true}', stderr="")

        with mock.patch.object(install_quota_guard, "verify_linux_crontab_registered", return_value=scheduler_result) as verify_scheduler:
            with mock.patch.object(install_quota_guard.subprocess, "run", return_value=guard_process) as run:
                result = install_quota_guard.run_install_verification("/usr/bin/python3", worker_script, "Linux")

        verify_scheduler.assert_called_once()
        run.assert_called_once_with(
            ["/usr/bin/python3", str(worker_script), "--skip-self-update", "--no-toast"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result["scheduler"], scheduler_result)
        self.assertTrue(result["guard_run"]["ok"])

    def test_run_install_verification_fails_when_guard_fails(self):
        worker_script = Path("/tmp/quota_guard.py")
        guard_process = mock.Mock(returncode=1, stdout="out", stderr="err")

        with mock.patch.object(install_quota_guard, "verify_linux_crontab_registered", return_value={"ok": True}):
            with mock.patch.object(install_quota_guard.subprocess, "run", return_value=guard_process):
                with self.assertRaises(RuntimeError) as raised:
                    install_quota_guard.run_install_verification("/usr/bin/python3", worker_script, "Linux")

        self.assertIn("verification run failed", str(raised.exception))

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_parses_statusline_snapshot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = Path(temp_dir) / "statusline-rate-limits.json"
            now = datetime.now(timezone.utc)
            snapshot_path.write_text(
                json.dumps(
                    {
                        "rate_limits": {
                            "five_hour": {"used_percentage": 9, "resets_at": int((now + timedelta(hours=3)).timestamp())},
                            "seven_day": {"used_percentage": 100, "resets_at": int((now + timedelta(days=3)).timestamp())},
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
    def test_probe_claude_auth_blob_ignores_expired_statusline_snapshot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = Path(temp_dir) / "statusline-rate-limits.json"
            now = datetime.now(timezone.utc)
            snapshot_path.write_text(
                json.dumps(
                    {
                        "rate_limits": {
                            "five_hour": {"used_percentage": 9, "resets_at": int((now - timedelta(hours=1)).timestamp())},
                            "seven_day": {"used_percentage": 32, "resets_at": int((now - timedelta(days=1)).timestamp())},
                        }
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            windows = probe_claude_auth_blob.parse_statusline_snapshot(snapshot_path)

        self.assertIsNone(windows["5h"])
        self.assertIsNone(windows["1week"])

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_ignores_partial_statusline_snapshot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = Path(temp_dir) / "statusline-rate-limits.json"
            snapshot_path.write_text("", encoding="utf-8")
            windows = probe_claude_auth_blob.parse_statusline_snapshot(snapshot_path)

        self.assertIsNone(windows["5h"])
        self.assertIsNone(windows["1week"])

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_parses_usage_screen_windows(self):
        usage_text = """
        Status   Config   Usage   Stats

        Current session
        █████                                              10% used
        Resets 9pm (America/Los_Angeles)

        Current week (all models)
        ██████████████████████████████████████████████████ 100% used
        Resets Apr 23, 12pm (America/Los_Angeles)
        """
        windows = probe_claude_auth_blob.parse_usage_windows(
            usage_text,
            now=datetime(2026, 4, 20, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(windows["5h"]["remaining_percent"], 90.0)
        self.assertEqual(windows["5h"]["reset_at"], "2026-04-21T04:00:00Z")
        self.assertEqual(windows["1week"]["remaining_percent"], 0.0)
        self.assertEqual(windows["1week"]["reset_at"], "2026-04-23T19:00:00Z")

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

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_uses_fast_statusline_refresh_for_worker(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            claude_home = Path(temp_dir) / ".claude"
            probe_claude_auth_blob.write_settings(claude_home)
            settings = json.loads((claude_home / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(
            settings["statusLine"]["refreshInterval"],
            probe_claude_auth_blob.PROBE_STATUSLINE_REFRESH_SECONDS,
        )
        self.assertLess(
            settings["statusLine"]["refreshInterval"],
            45,
        )

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_summarizes_ui_noise_errors(self):
        noisy_output = (
            "\x1b]0;✳ Claude Code\x07"
            "Welcome back Derek!\n"
            "Tips for getting started\n"
            "Opus 4.7 (1M context) · Claude Max · Derek Zen\n"
        )
        summary = probe_claude_auth_blob.summarize_probe_error(noisy_output)
        self.assertEqual(summary, "claude probe reached ui but no statusline snapshot was produced")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_strips_esc7_esc8_and_osc_noise(self):
        noisy_output = (
            "\x1b7\x1b8\x1b]11;?\x07"
            "\x1b7\x1b8\x1b]11;?\x07"
            "\x1b]0;✳ Claude Code\x07"
            "╭───ClaudeCodev2.1.122────────────────────╮\n"
            "│ Welcome back Derek! │ Tips for getting started │\n"
        )
        summary = probe_claude_auth_blob.summarize_probe_error(noisy_output)
        self.assertEqual(summary, "claude probe reached ui but no statusline snapshot was produced")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_summarizes_flattened_ui_garbage(self):
        noisy_output = "787878╭───ClaudeCodev2.1.122────────────────╮││Tipsforgetting││WelcomebackDerek!│started│"
        summary = probe_claude_auth_blob.summarize_probe_error(noisy_output)
        self.assertEqual(summary, "claude probe reached ui but no statusline snapshot was produced")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_summarizes_stats_page_noise(self):
        noisy_output = (
            "─────── Status Config Usage Stats Session Total cost: $0.0000 "
            "Toal duration(API):0s Total duration (wall): 11s "
            "Totalcodechanges:0lines added, 0insremove Uage:0input, 0 output,0 cachered, 0 cache write"
        )
        summary = probe_claude_auth_blob.summarize_probe_error(noisy_output)
        self.assertEqual(summary, "claude probe reached ui but no statusline snapshot was produced")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_summarizes_authentication_errors(self):
        noisy_output = (
            "Please run /login · API Error: 401 "
            '{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}'
        )
        summary = probe_claude_auth_blob.summarize_probe_error(noisy_output)
        self.assertEqual(summary, "claude auth invalid (authentication_error)")

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_selects_yes_for_trust_prompt(self):
        class FakeChild:
            def __init__(self):
                self.sent = []
                self.before = ""
                self.after = "Do you trust this folder?"

            def expect(self, patterns, timeout=1):
                return 0

            def sendline(self, value):
                self.sent.append(("sendline", value))

            def send(self, value):
                self.sent.append(("send", value))

            def sendcontrol(self, value):
                pass

            def kill(self, sig):
                pass

            def close(self, force=True):
                pass

        fake_child = FakeChild()
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "home"
            workdir = Path(temp_dir) / "workspace"
            workdir.mkdir(parents=True)
            with mock.patch.object(probe_claude_auth_blob.pexpect, "spawn", return_value=fake_child):
                probe_claude_auth_blob.warm_statusline_snapshot(
                    "claude",
                    home,
                    workdir,
                    timeout_seconds=1,
                )
        self.assertIn(("send", "1\r"), fake_child.sent)

    @unittest.skipIf(probe_claude_auth_blob is None, "pexpect not installed")
    def test_probe_claude_auth_blob_prepares_local_claude_binary(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "home"
            binary = Path(temp_dir) / "claude-real"
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o755)

            prepared = probe_claude_auth_blob.prepare_claude_binary(home, str(binary))

        self.assertEqual(Path(prepared), home / ".local" / "bin" / "claude")


if __name__ == "__main__":
    unittest.main()
