"""The heartbeat names the commit the guard runs and the token it measured through."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "skills" / "quota-reporter" / "scripts"))

import quota_guard  # noqa: E402
import quota_reporters  # noqa: E402


class HeartbeatCarriesProvenance(unittest.TestCase):
    def test_heartbeat_names_the_applied_commit_and_the_token_it_ran(self):
        payload = {
            "account_id": "claude-x@example.com",
            "status": "ok",
            "reporter_name": "shawn@192.168.1.2",
            "hostname": "192.168.1.2",
            "access_token_fingerprint": "f" * 64,
        }
        with mock.patch("quota_guard.read_self_update_state", return_value={"last_applied_sha": "454064344cae7ae3d91322b1cc02746a902a36dc"}):
            heartbeat = quota_guard.build_probe_heartbeat("claude", payload)
        self.assertEqual(heartbeat["client_version"], quota_guard.CLIENT_VERSION)
        self.assertEqual(heartbeat["client_sha"], "454064344cae7ae3d91322b1cc02746a902a36dc")
        self.assertEqual(heartbeat["access_token_fingerprint"], "f" * 64)
        self.assertEqual(heartbeat["account_id"], "claude-x@example.com")

    def test_heartbeat_carries_the_quota_bucket_the_probe_read(self):
        # A reading from any bucket but the plan's carries no windows, so the ingest gate refuses it
        # and the event log never sees it. Without this field the machines whose readings are being
        # discarded would be exactly the machines we cannot see -- and a newly introduced metered id
        # would arrive silently.
        payload = {
            "account_id": "algorithm@stardust.ai",
            "status": "ok",
            "reporter_name": "shawn@192.168.1.6",
            "hostname": "192.168.1.6",
            "usage_summary": {"meter": {"limit_id": "codex_bengalfox", "limit_name": "GPT-5.3-Codex-Spark"}},
        }
        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            heartbeat = quota_guard.build_probe_heartbeat("codex", payload)
        self.assertEqual(heartbeat["meter_limit_id"], "codex_bengalfox")

        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            no_meter = quota_guard.build_probe_heartbeat("codex", {"status": "ok", "usage_summary": None})
        self.assertIsNone(no_meter["meter_limit_id"], "claude and legacy codex responses have no bucket")

    def test_heartbeat_carries_identity_diagnostics_and_the_quota_report_does_not(self):
        payload = {
            "account_id": "claude-email-missing",
            "status": "error",
            "error": "claude auth email unavailable",
            "reporter_name": "xienxu@Mac",
            "hostname": "Mac",
            "diagnostics": {"installed_fp": "ab12cd34"},
        }
        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            heartbeat = quota_guard.build_probe_heartbeat("claude", payload)
        self.assertEqual(heartbeat["diagnostics"], {"installed_fp": "ab12cd34"})

        posted = {}
        with mock.patch("quota_guard.post_auth_pool_quota", side_effect=lambda *a, **k: posted.update(k) or {"ok": True}), \
                mock.patch("quota_guard.read_self_update_state", return_value={}), \
                mock.patch("quota_guard.quota_payload_is_reportable", return_value=True):
            quota_guard.report_current_quota_to_auth_pool(
                {"auth_pool_url": "https://hub", "auth_pool_user_token": "t"}, "claude", payload
            )
        self.assertNotIn("diagnostics", posted["quota_payload"])
        self.assertEqual(posted["heartbeat"]["diagnostics"], {"installed_fp": "ab12cd34"})

    def test_heartbeat_without_self_update_state_or_probe_payload_degrades_to_nulls(self):
        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            heartbeat = quota_guard.build_probe_heartbeat("claude", None)
        self.assertIsNone(heartbeat["client_sha"])
        self.assertIsNone(heartbeat["access_token_fingerprint"])
        self.assertEqual(heartbeat["status"], "error")


class IdentityDiagnostics(unittest.TestCase):
    def test_diagnostics_compare_the_stores_without_carrying_a_token_or_an_address(self):
        token = "sk-ant-oat01-SECRET-TOKEN-VALUE"
        fingerprint = hashlib.sha256(token.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / ".claude"
            home.mkdir()
            (home / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": token, "refreshToken": "rt"}}))
            known = Path(temp) / "known_auth.json"
            known.write_text(json.dumps({"sources": {"claude": {
                "email": "owner@example.com", "access_token_fingerprint": "0" * 64, "state_source": "fetched_from_auth_pool",
            }}}))
            with mock.patch.object(quota_reporters.sys, "platform", "linux"):
                result = quota_reporters.claude_identity_diagnostics(
                    executable=str(Path.home() / ".local" / "bin" / "claude"),
                    auth_status={"loggedIn": True, "authMethod": "claude.ai", "email": "owner@example.com", "orgId": 7},
                    cli_state={"numStartups": 3},
                    claude_home=home,
                    known_auth_path=known,
                )
        self.assertEqual(result["executable"], "~/.local/bin/claude")
        self.assertEqual(result["stores"]["credentials_file"]["token_fp"], fingerprint[:8])
        self.assertEqual(result["installed_fp"], fingerprint[:8])
        # The install record names a different token than the one now in place: the case to detect.
        self.assertFalse(result["known_auth"]["matches_installed"])
        self.assertTrue(result["known_auth"]["email_set"])
        self.assertFalse(result["cli_state"]["has_oauth_account"])
        self.assertEqual(result["status_json"], {"loggedIn": True, "authMethod": "claude.ai"})
        self.assertIn("email", result["status_json_keys"])
        serialized = json.dumps(result)
        self.assertNotIn(token, serialized)
        self.assertNotIn("owner@example.com", serialized)


if __name__ == "__main__":
    unittest.main()
