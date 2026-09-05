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

    def test_heartbeat_without_self_update_state_or_probe_payload_degrades_to_nulls(self):
        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            heartbeat = quota_guard.build_probe_heartbeat("claude", None)
        self.assertIsNone(heartbeat["client_sha"])
        self.assertIsNone(heartbeat["access_token_fingerprint"])
        self.assertEqual(heartbeat["status"], "error")


if __name__ == "__main__":
    unittest.main()
