import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import token_usage_repair  # noqa: E402
from token_usage_state import TokenUsageState  # noqa: E402


NOW = datetime(2026, 9, 7, 12, 0, 0, tzinfo=timezone.utc)


def codex_session(session: str, events: list[tuple[str, int, int]], model="gpt-5.6-sol") -> str:
    lines = [
        json.dumps({"type": "session_meta", "payload": {"session_id": session}}),
        json.dumps({"type": "turn_context", "payload": {"model": model}}),
    ]
    for event_at, input_tokens, output_tokens in events:
        lines.append(json.dumps({
            "timestamp": event_at,
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cached_input_tokens": input_tokens // 2,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
                "total_tokens": input_tokens + output_tokens,
            }}},
        }))
    return "\n".join(lines) + "\n"


class RecomputeWindowTest(unittest.TestCase):
    """The repair reads every log from its first byte, which is the whole reason it is trustworthy."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.codex_root = root / "codex"
        self.claude_root = root / "claude"
        self.codex_root.mkdir()
        self.claude_root.mkdir()
        self.state = TokenUsageState(root / "state.sqlite3", now=lambda: NOW)
        switch_id = self.state.prepare_account_switch(
            provider="codex", from_account_id="acct-a", to_account_id="acct-a",
            prepared_at="2026-09-01T00:00:00.000Z",
        )
        self.state.finalize_account_switch(switch_id, finalized_at="2026-09-01T00:00:00.000Z")

    def tearDown(self):
        self.state.close()
        self.temp.cleanup()

    def recompute(self, since):
        return token_usage_repair.recompute_window(
            since, state=self.state, codex_roots=(self.codex_root,), claude_root=self.claude_root,
        )

    def test_a_long_session_is_charged_its_turns_not_its_cumulative(self):
        # The bug in one file: a session whose cumulative was already huge before the window opened.
        # Reading from byte zero means the in-window turns are differenced against the turn before
        # them, so what lands is the 300K actually spent, not the 5 billion already accumulated.
        (self.codex_root / "long.jsonl").write_text(codex_session("long", [
            ("2026-09-02T10:00:00.000Z", 5_000_000_000, 10_000_000),
            ("2026-09-05T10:00:00.000Z", 5_000_200_000, 10_000_100),
            ("2026-09-05T10:05:00.000Z", 5_000_400_000, 10_000_200),
        ]))
        rows = self.recompute(datetime(2026, 9, 4, tzinfo=timezone.utc))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["bucket_start"], "2026-09-05T10:00:00.000Z")
        self.assertEqual(rows[0]["total_tokens"], 400_200)
        self.assertEqual(rows[0]["model_account_id"], "acct-a")

    def test_events_before_the_window_are_read_but_never_charged(self):
        (self.codex_root / "early.jsonl").write_text(codex_session("early", [
            ("2026-09-01T10:00:00.000Z", 100_000, 1_000),
            ("2026-09-02T10:00:00.000Z", 200_000, 2_000),
        ]))
        self.assertEqual(self.recompute(datetime(2026, 9, 3, tzinfo=timezone.utc)), [])

    def test_a_forked_session_does_not_pay_for_its_parent_twice(self):
        events = [("2026-09-05T10:00:00.000Z", 100_000, 1_000), ("2026-09-05T10:01:00.000Z", 200_000, 2_000)]
        (self.codex_root / "parent.jsonl").write_text(codex_session("shared", events))
        (self.codex_root / "fork.jsonl").write_text(codex_session("shared", events))
        rows = self.recompute(datetime(2026, 9, 4, tzinfo=timezone.utc))
        self.assertEqual(sum(row["total_tokens"] for row in rows), 202_000)

    def test_a_window_opening_after_the_last_switch_still_has_an_account(self):
        # There is no boundary inside this window -- the only one is days earlier -- so without the
        # opening account every event would be unattributable and silently dropped.
        (self.codex_root / "after.jsonl").write_text(codex_session("after", [
            ("2026-09-05T10:00:00.000Z", 100_000, 1_000),
            ("2026-09-05T10:05:00.000Z", 200_000, 2_000),
        ]))
        rows = self.recompute(datetime(2026, 9, 4, tzinfo=timezone.utc))
        self.assertEqual([row["model_account_id"] for row in rows], ["acct-a"])

    def test_an_event_with_no_recorded_account_at_all_is_dropped_rather_than_misfiled(self):
        # Undercounting is recoverable; putting one account's tokens on another name is not.
        with tempfile.TemporaryDirectory() as bare:
            state = TokenUsageState(Path(bare) / "state.sqlite3", now=lambda: NOW)
            (self.codex_root / "orphan.jsonl").write_text(codex_session("orphan", [
                ("2026-09-05T10:00:00.000Z", 100_000, 1_000),
                ("2026-09-05T10:05:00.000Z", 200_000, 2_000),
            ]))
            rows = token_usage_repair.recompute_window(
                datetime(2026, 9, 4, tzinfo=timezone.utc), state=state,
                codex_roots=(self.codex_root,), claude_root=self.claude_root,
            )
            state.close()
        self.assertEqual(rows, [])


class RunRepairTest(unittest.TestCase):
    """Only the first batch may replace, and the marker is what makes it happen once."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = TokenUsageState(Path(self.temp.name) / "state.sqlite3", now=lambda: NOW)

    def tearDown(self):
        self.state.close()
        self.temp.cleanup()

    def config(self):
        return {"auth_pool_url": "https://hub.example.com", "auth_pool_user_token": "qrp.test"}

    def test_the_first_batch_replaces_and_the_rest_accumulate(self):
        rows = [
            {"bucket_start": f"2026-09-0{1 + index // 300}T10:00:00.000Z", "provider": "codex",
             "model_account_id": "acct-a", "model_id": "gpt-5.6-sol", "input_tokens": 1,
             "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
             "reasoning_tokens": 0, "total_tokens": 1}
            for index in range(500)
        ]
        sent = []
        with mock.patch.object(token_usage_repair, "recompute_window", return_value=rows), \
                mock.patch.object(token_usage_repair, "post_token_usage_batch",
                                  side_effect=lambda _u, _t, payload: sent.append(payload) or {"ok": True}):
            result = token_usage_repair.run_repair(self.config(), state=self.state)

        self.assertTrue(result["repaired"])
        self.assertEqual(result["rows"], 500)
        self.assertEqual(len(sent), 2, "400 rows per batch is the hub's cap")
        self.assertIn("replace_from", sent[0])
        self.assertNotIn("replace_from", sent[1], "a second replace would delete the first chunk")
        self.assertNotEqual(sent[0]["batch_id"], sent[1]["batch_id"])

    def test_a_failed_upload_leaves_the_marker_unset_and_reuses_the_batch_ids(self):
        rows = [{"bucket_start": "2026-09-01T10:00:00.000Z", "provider": "codex",
                 "model_account_id": "acct-a", "model_id": "gpt-5.6-sol", "input_tokens": 1,
                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "reasoning_tokens": 0, "total_tokens": 1}]
        attempts = []
        with mock.patch.object(token_usage_repair, "recompute_window", return_value=rows), \
                mock.patch.object(token_usage_repair, "post_token_usage_batch",
                                  side_effect=lambda _u, _t, payload: attempts.append(payload) or
                                  {"ok": False, "status_code": 503}):
            failed = token_usage_repair.run_repair(self.config(), state=self.state)
        self.assertFalse(failed["ok"])
        self.assertFalse(token_usage_repair.repair_completed(self.state))

        with mock.patch.object(token_usage_repair, "recompute_window", return_value=rows), \
                mock.patch.object(token_usage_repair, "post_token_usage_batch",
                                  side_effect=lambda _u, _t, payload: attempts.append(payload) or {"ok": True}):
            token_usage_repair.run_repair(self.config(), state=self.state)
        # Same id and same payload, so anything the hub already applied is a duplicate, not a
        # second charge.
        self.assertEqual(attempts[0]["batch_id"], attempts[1]["batch_id"])
        self.assertTrue(token_usage_repair.repair_completed(self.state))

    def test_a_completed_repair_never_runs_again(self):
        self.state.set_meta(token_usage_repair.REPAIR_STATE_KEY, token_usage_repair.REPAIR_GENERATION)
        with mock.patch.object(token_usage_repair, "recompute_window") as recompute:
            result = token_usage_repair.run_repair(self.config(), state=self.state)
        recompute.assert_not_called()
        self.assertFalse(result["repaired"])

    def test_the_window_never_reaches_past_this_installation_s_own_history(self):
        # Replacing further back than this machine has ever reported would delete rows that belong
        # to whoever else reports under the same hub user.
        seen = {}
        with mock.patch.object(token_usage_repair, "recompute_window",
                               side_effect=lambda since, **_: seen.setdefault("since", since) and []), \
                mock.patch.object(token_usage_repair, "post_token_usage_batch"):
            token_usage_repair.run_repair(self.config(), state=self.state)
        cutoff = datetime.fromisoformat(self.state.backfill_cutoff.replace("Z", "+00:00"))
        self.assertGreaterEqual(seen["since"], cutoff - timedelta(minutes=15))


class GuardRepairTriggerTest(unittest.TestCase):
    """The guard starts it detached, once, and does not let a failing one run every cycle."""

    def setUp(self):
        import quota_guard
        self.quota_guard = quota_guard
        self.temp = tempfile.TemporaryDirectory()
        self.state = TokenUsageState(Path(self.temp.name) / "state.sqlite3", now=lambda: NOW)

    def tearDown(self):
        self.state.close()
        self.temp.cleanup()

    def test_it_spawns_detached_so_a_multi_gigabyte_parse_cannot_hang_the_guard(self):
        with mock.patch.object(self.quota_guard.subprocess, "Popen") as popen:
            result = self.quota_guard.maybe_start_usage_repair(self.state, now=1000.0)
        self.assertTrue(result["started"])
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertIn("token_usage_repair.py", popen.call_args.args[0][1])

    def test_a_failing_repair_backs_off_instead_of_relaunching_every_fifteen_minutes(self):
        with mock.patch.object(self.quota_guard.subprocess, "Popen") as popen:
            self.quota_guard.maybe_start_usage_repair(self.state, now=1000.0)
            again = self.quota_guard.maybe_start_usage_repair(self.state, now=1000.0 + 900)
            later = self.quota_guard.maybe_start_usage_repair(
                self.state, now=1000.0 + self.quota_guard.USAGE_REPAIR_RETRY_SECONDS + 1
            )
        self.assertEqual(again, {"started": False, "reason": "attempted_recently"})
        self.assertTrue(later["started"])
        self.assertEqual(popen.call_count, 2)

    def test_a_repaired_machine_never_parses_its_logs_again(self):
        self.state.set_meta(token_usage_repair.REPAIR_STATE_KEY, token_usage_repair.REPAIR_GENERATION)
        with mock.patch.object(self.quota_guard.subprocess, "Popen") as popen:
            result = self.quota_guard.maybe_start_usage_repair(self.state, now=1000.0)
        popen.assert_not_called()
        self.assertEqual(result, {"started": False, "reason": "already_repaired"})


if __name__ == "__main__":
    unittest.main()
