"""An access-token-only claude credential is uploaded (the hub decides whether it is supply) and the
machine stays a participant afterwards."""
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


class AccessTokenOnlySupply(unittest.TestCase):
    def _stripped_blob(self):
        return json.dumps({
            "schema": "claude_credentials_v1",
            "account_id": "claude-owner@example.com",
            "session_id": "s1",
            "email": "owner@example.com",
            "name": "Owner Org",
            "plan_name": "Max",
            "auth_last_refresh": "1790708346219",
            "credentials": {"claudeAiOauth": {"accessToken": "FRESH_30D_AT", "refreshToken": quota_reporters.STRIPPED_CLAUDE_REFRESH_TOKEN, "expiresAt": 1790708346219}},
        })

    def test_an_at_only_credential_is_uploaded_and_the_machine_stays_a_participant(self):
        blob_text = self._stripped_blob()
        payload = {"source": "claude", "account_id": "claude-owner@example.com", "email": "owner@example.com", "status": "ok"}
        with tempfile.TemporaryDirectory() as d:
            known_auth_path = Path(d) / "known_auth.json"
            claude_home = Path(d) / ".claude"
            claude_home.mkdir()
            with mock.patch("quota_reporters.build_claude_auth_blob", return_value=(blob_text, payload)), \
                 mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {"account_id": "claude-owner@example.com"}}) as post, \
                 mock.patch("quota_reporters.strip_local_claude_refresh_token", return_value={"stripped": False, "reason": "already_stripped"}) as strip:
                result = quota_reporters.sync_current_claude_auth_pool(
                    "https://hub.example", "qrp_token", claude_home=claude_home, known_auth_path=known_auth_path,
                )
            post.assert_called_once()
            self.assertEqual(post.call_args.kwargs["auth_json_text"], blob_text, "the AT-only blob itself is what goes up; the hub merges it")
            self.assertTrue(result["uploaded"])
            self.assertTrue(result["local_auth_is_at_only"])
            strip.assert_called_once()
            state = quota_reporters.read_known_auth_state(known_auth_path)["sources"]["claude"]
            self.assertEqual(state["state_source"], "fetched_from_auth_pool",
                             "a machine that never held the pooled RT is not the owner, whatever the upload path wrote")
            self.assertFalse(quota_reporters.claude_client_owns_the_pooled_credential(known_auth_path))

    def test_the_fingerprint_in_the_probe_matches_the_installed_token(self):
        # sanity: the fingerprint the hub matches against is sha256 of the raw access token
        creds = json.loads(self._stripped_blob())["credentials"]
        self.assertEqual(quota_reporters.claude_access_token_fingerprint(creds), hashlib.sha256(b"FRESH_30D_AT").hexdigest())


if __name__ == "__main__":
    unittest.main()
