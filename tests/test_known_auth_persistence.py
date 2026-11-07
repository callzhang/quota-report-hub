"""known_auth.json is rewritten whole by rename, and a file an older client left torn does not stop the
guard from running."""
import errno
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "skills" / "quota-reporter" / "scripts"))

import quota_reporters  # noqa: E402


def _seed(path: Path) -> dict:
    state = {"sources": {"codex": {"account_id": "acct-1", "state_source": "uploaded_to_auth_pool"}}}
    path.write_text(json.dumps(state), encoding="utf-8")
    return state


class KnownAuthPersistence(unittest.TestCase):
    def test_an_empty_file_reads_as_no_known_auth(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "known_auth.json"
            path.write_text("", encoding="utf-8")
            self.assertIsNone(quota_reporters.known_codex_refresh_handoff(path))
            self.assertEqual(quota_reporters.read_known_auth_state(path), {"sources": {}})

    def test_a_write_that_fails_midway_leaves_the_previous_file_intact(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "known_auth.json"
            before = _seed(path)
            with mock.patch("os.fsync", side_effect=OSError(errno.ENOSPC, "No space left on device")):
                with self.assertRaises(OSError):
                    quota_reporters.set_known_codex_refresh_handoff(path, True, "acct-1")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), before)
            self.assertEqual(sorted(os.listdir(d)), ["known_auth.json"])

    def test_a_completed_write_is_owner_only_and_leaves_no_temp_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "known_auth.json"
            _seed(path)
            self.assertTrue(quota_reporters.set_known_codex_refresh_handoff(path, True, "acct-1"))
            self.assertTrue(quota_reporters.known_codex_refresh_handoff(path)["refresh_handoff_pending"])
            self.assertEqual(sorted(os.listdir(d)), ["known_auth.json"])
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
