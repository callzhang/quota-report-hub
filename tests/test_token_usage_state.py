import json
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from token_usage_state import TokenUsageState  # noqa: E402


NOW = datetime(2026, 8, 18, 12, 0, 0, tzinfo=timezone.utc)


class TokenUsageStateTests(unittest.TestCase):
    def open_state(self, directory: str, now=NOW) -> TokenUsageState:
        return TokenUsageState(Path(directory) / "token-usage.sqlite3", now=lambda: now)

    def test_first_open_persists_installation_and_72_hour_cutoff_privately(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self.open_state(temp_dir)
            installation_id = state.installation_id
            uuid.UUID(installation_id)
            self.assertEqual(state.backfill_cutoff, "2026-08-15T12:00:00.000Z")
            state.close()

            reopened = self.open_state(temp_dir, datetime(2026, 8, 19, tzinfo=timezone.utc))
            self.assertEqual(reopened.installation_id, installation_id)
            self.assertEqual(reopened.backfill_cutoff, "2026-08-15T12:00:00.000Z")
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(reopened.path.stat().st_mode), 0o600)
            reopened.close()

    def test_pending_batch_does_not_advance_acknowledged_state_until_ack(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self.open_state(temp_dir)
            payload = {
                "installation_id": state.installation_id,
                "batch_id": "batch-1",
                "rows": [{"total_tokens": 100}],
            }
            proposed = {
                "files": [{"file_key": "1:2", "path": "/tmp/a.jsonl", "offset": 80, "size": 80, "mtime_ns": 1}],
                "counters": [{"record_key": "codex:session-1", "value": {"total_tokens": 100}}],
                "fingerprints": [{"digest": "abc", "event_at": "2026-08-18T11:00:00.000Z"}],
            }
            pending = state.stage_batch(payload=payload, proposed=proposed)
            self.assertEqual(pending["payload"], payload)
            self.assertIsNone(state.file_cursor("1:2"))
            self.assertIsNone(state.usage_counter("codex:session-1"))
            self.assertFalse(state.has_fingerprint("abc"))
            state.close()

            restarted = self.open_state(temp_dir)
            self.assertEqual(restarted.pending_upload()["payload"], payload)
            restarted.ack_pending_batch("batch-1")
            self.assertEqual(restarted.file_cursor("1:2")["offset"], 80)
            self.assertEqual(restarted.usage_counter("codex:session-1"), {"total_tokens": 100})
            self.assertTrue(restarted.has_fingerprint("abc"))
            self.assertIsNone(restarted.pending_upload())
            restarted.close()

    def test_reject_advances_proposed_state_once_and_records_safe_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self.open_state(temp_dir)
            state.stage_batch(
                payload={"installation_id": state.installation_id, "batch_id": "batch-invalid", "rows": []},
                proposed={
                    "files": [{"file_key": "file", "path": "/tmp/a.jsonl", "offset": 120, "size": 120, "mtime_ns": 2}],
                    "counters": [],
                    "fingerprints": [],
                },
            )
            state.reject_pending_batch("batch-invalid", status_code=400, error_code="invalid_token_usage")
            self.assertEqual(state.file_cursor("file")["offset"], 120)
            self.assertIsNone(state.pending_upload())
            state.reject_pending_batch("batch-invalid", status_code=400, error_code="invalid_token_usage")
            state.close()

            connection = sqlite3.connect(Path(temp_dir) / "token-usage.sqlite3")
            row = connection.execute(
                "SELECT status, last_error FROM pending_uploads WHERE batch_id = ?",
                ("batch-invalid",),
            ).fetchone()
            connection.close()
            self.assertEqual(row[0], "rejected")
            self.assertEqual(json.loads(row[1]), {"status_code": 400, "error_code": "invalid_token_usage"})

    def test_account_switch_prepare_finalize_cancel_and_reconcile(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self.open_state(temp_dir)
            switch_id = state.prepare_account_switch(
                provider="codex",
                from_account_id="old",
                to_account_id="new",
                prepared_at="2026-08-18T10:00:00.000Z",
            )
            self.assertEqual(state.switches_for_range(
                "codex", "2026-08-18T09:00:00.000Z", "2026-08-18T11:00:00.000Z"
            ), [])
            state.finalize_account_switch(switch_id, finalized_at="2026-08-18T10:00:01.000Z")
            self.assertEqual(state.switches_for_range(
                "codex", "2026-08-18T09:00:00.000Z", "2026-08-18T11:00:00.000Z"
            )[0]["to_account_id"], "new")

            cancelled = state.prepare_account_switch(
                provider="claude", from_account_id="a", to_account_id="b",
                prepared_at="2026-08-18T10:01:00.000Z",
            )
            state.cancel_account_switch(cancelled)
            self.assertEqual(state.switches_for_range(
                "claude", "2026-08-18T09:00:00.000Z", "2026-08-18T11:00:00.000Z"
            ), [])

            to_finalize = state.prepare_account_switch(
                provider="codex", from_account_id="new", to_account_id="next",
                prepared_at="2026-08-18T10:02:00.000Z",
            )
            to_cancel = state.prepare_account_switch(
                provider="claude", from_account_id="b", to_account_id="c",
                prepared_at="2026-08-18T10:03:00.000Z",
            )
            result_codex = state.reconcile_prepared_switches(
                provider="codex", observed_account_id="next", observed_at="2026-08-18T10:04:00.000Z"
            )
            result_claude = state.reconcile_prepared_switches(
                provider="claude", observed_account_id="different", observed_at="2026-08-18T10:04:00.000Z"
            )
            self.assertEqual(result_codex, {"finalized": [to_finalize], "cancelled": []})
            self.assertEqual(result_claude, {"finalized": [], "cancelled": [to_cancel]})
            state.close()

    def test_fingerprint_pruning_keeps_boundary_and_newer_records(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self.open_state(temp_dir)
            state.stage_batch(
                payload={"installation_id": state.installation_id, "batch_id": "fingerprints", "rows": []},
                proposed={
                    "files": [], "counters": [],
                    "fingerprints": [
                        {"digest": "old", "event_at": "2026-05-20T11:59:59.999Z"},
                        {"digest": "boundary", "event_at": "2026-05-20T12:00:00.000Z"},
                        {"digest": "new", "event_at": "2026-08-18T11:00:00.000Z"},
                    ],
                },
            )
            state.ack_pending_batch("fingerprints")
            self.assertEqual(state.prune_fingerprints("2026-05-20T12:00:00.000Z"), 1)
            self.assertFalse(state.has_fingerprint("old"))
            self.assertTrue(state.has_fingerprint("boundary"))
            self.assertTrue(state.has_fingerprint("new"))
            state.close()


if __name__ == "__main__":
    unittest.main()
