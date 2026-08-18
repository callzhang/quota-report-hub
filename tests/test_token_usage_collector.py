import json
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import token_usage_collector  # noqa: E402
from token_usage_state import TokenUsageState  # noqa: E402


NOW = datetime(2026, 8, 18, 12, 0, 0, tzinfo=timezone.utc)


def codex_lines(*, session="session-1", model="gpt-5.6-sol", event_at="2026-08-18T11:45:01.000Z", total=120, input_tokens=100, output_tokens=20):
    return [
        json.dumps({"type": "session_meta", "payload": {"session_id": session}}),
        json.dumps({"type": "turn_context", "payload": {"model": model}}),
        json.dumps({
            "timestamp": event_at,
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cached_input_tokens": min(60, input_tokens),
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": min(5, output_tokens),
                "total_tokens": total,
            }}},
        }),
    ]


def write_lines(path: Path, lines: list[str], *, final_newline=True) -> None:
    text = "\n".join(lines) + ("\n" if final_newline else "")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class TokenUsageCollectorTests(unittest.TestCase):
    def make_state(self, root: Path) -> TokenUsageState:
        return TokenUsageState(root / "state.sqlite3", now=lambda: NOW)

    def config(self):
        return {"auth_pool_url": "https://hub.example.com", "auth_pool_user_token": "qrp.test"}

    def run_collector(self, *, state, codex_root, claude_root, codex_account="ir@stardust.ai", claude_account=None, **kwargs):
        return token_usage_collector.collect_and_report_token_usage(
            config=self.config(),
            codex_account_id=codex_account,
            claude_account_id=claude_account,
            state=state,
            codex_roots=(codex_root,),
            claude_root=claude_root,
            wall_now=lambda: NOW,
            **kwargs,
        )

    def test_incremental_codex_upload_and_unchanged_second_cycle_reads_zero_bytes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            write_lines(codex_root / "session.jsonl", codex_lines())
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "applied": True, "status_code": 200}):
                first = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
                second = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertTrue(first["ok"])
            self.assertEqual(first["rows"], 1)
            self.assertGreater(first["bytes_read"], 0)
            self.assertEqual(second["bytes_read"], 0)
            self.assertEqual(len(uploads), 1)
            self.assertEqual(uploads[0]["rows"], [{
                "bucket_start": "2026-08-18T11:45:00.000Z",
                "provider": "codex",
                "model_account_id": "ir@stardust.ai",
                "model_id": "gpt-5.6-sol",
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_tokens": 60,
                "cache_write_tokens": 0,
                "reasoning_tokens": 5,
                "total_tokens": 120,
            }])
            serialized = json.dumps(uploads[0])
            self.assertNotIn(str(codex_root), serialized)
            self.assertNotIn("session.jsonl", serialized)
            state.close()

    def test_incomplete_line_waits_for_newline_then_resumes_at_acknowledged_offset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            path = codex_root / "session.jsonl"
            lines = codex_lines()
            write_lines(path, lines, final_newline=False)
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                first = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
                with path.open("a", encoding="utf-8") as output:
                    output.write("\n")
                second = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertEqual(first["rows"], 0)
            self.assertEqual(second["rows"], 1)
            self.assertEqual(len(uploads), 1)
            state.close()

    def test_initial_backfill_skips_old_files_and_uses_old_counters_as_baseline(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            inactive = codex_root / "inactive.jsonl"
            write_lines(inactive, codex_lines(event_at="2026-08-10T00:00:00.000Z"))
            old_epoch = datetime(2026, 8, 10, tzinfo=timezone.utc).timestamp()
            os.utime(inactive, (old_epoch, old_epoch))

            active = codex_root / "active.jsonl"
            write_lines(active, [
                *codex_lines(event_at="2026-08-14T00:00:00.000Z", total=120, input_tokens=100, output_tokens=20),
                *codex_lines(event_at="2026-08-18T11:45:00.000Z", total=150, input_tokens=125, output_tokens=25)[1:],
            ])
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                result = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertEqual(result["rows"], 1)
            self.assertEqual(uploads[0]["rows"][0]["total_tokens"], 30)
            self.assertLess(result["bytes_read"], inactive.stat().st_size + active.stat().st_size)
            state.close()

    def test_automatic_switch_boundary_assigns_before_and_after_events(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            write_lines(codex_root / "before.jsonl", codex_lines(session="before", event_at="2026-08-18T11:45:00.000Z"))
            write_lines(codex_root / "after.jsonl", codex_lines(session="after", event_at="2026-08-18T11:55:00.000Z"))
            state = self.make_state(root)
            switch_id = state.prepare_account_switch(
                provider="codex", from_account_id="old@stardust.ai", to_account_id="new@stardust.ai",
                prepared_at="2026-08-18T11:50:00.000Z",
            )
            state.finalize_account_switch(switch_id, finalized_at="2026-08-18T11:50:01.000Z")
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                self.run_collector(
                    state=state, codex_root=codex_root, claude_root=claude_root,
                    codex_account="new@stardust.ai",
                )
            self.assertEqual({row["model_account_id"] for row in uploads[0]["rows"]}, {
                "old@stardust.ai", "new@stardust.ai"
            })
            state.close()

    def test_pending_retry_uploads_same_batch_before_scanning_and_401_keeps_it_pending(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            write_lines(codex_root / "new.jsonl", codex_lines(session="new"))
            state = self.make_state(root)
            pending_payload = {"installation_id": state.installation_id, "batch_id": "pending-batch", "rows": [{"total_tokens": 1}]}
            state.stage_batch(payload=pending_payload, proposed={"files": [], "counters": [], "fingerprints": []})
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", return_value={"ok": False, "status_code": 401, "reason": "token_invalidated"}) as post:
                result = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertTrue(result["retry"])
            self.assertEqual(result["bytes_read"], 0)
            self.assertEqual(post.call_args.args[2]["batch_id"], "pending-batch")
            self.assertEqual(state.pending_upload()["payload"], pending_payload)
            state.close()

    def test_permanent_400_rejects_pending_once_but_timeout_keeps_it(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            state = self.make_state(root)
            state.stage_batch(
                payload={"installation_id": state.installation_id, "batch_id": "bad", "rows": [{"total_tokens": 1}]},
                proposed={"files": [{"file_key": "f", "path": "/tmp/f", "offset": 10, "size": 10, "mtime_ns": 1}], "counters": [], "fingerprints": []},
            )
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", return_value={"ok": False, "status_code": 400, "error": "invalid_token_usage"}):
                result = self.run_collector(state=state, codex_root=root / "none", claude_root=root / "none2")
            self.assertFalse(result["retry"])
            self.assertIsNone(state.pending_upload())
            self.assertEqual(state.file_cursor("f")["offset"], 10)

            state.stage_batch(
                payload={"installation_id": state.installation_id, "batch_id": "timeout", "rows": [{"total_tokens": 1}]},
                proposed={"files": [], "counters": [], "fingerprints": []},
            )
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=TimeoutError("timeout")):
                timeout_result = self.run_collector(state=state, codex_root=root / "none", claude_root=root / "none2")
            self.assertTrue(timeout_result["retry"])
            self.assertEqual(state.pending_upload()["batch_id"], "timeout")
            state.close()

    def test_missing_hub_configuration_does_not_scan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            write_lines(codex_root / "session.jsonl", codex_lines())
            state = self.make_state(root)
            result = token_usage_collector.collect_and_report_token_usage(
                config={}, codex_account_id="account", claude_account_id=None,
                state=state, codex_roots=(codex_root,), claude_root=root / "claude",
                wall_now=lambda: NOW,
            )
            self.assertEqual(result["reason"], "missing_auth_pool_config")
            self.assertEqual(result["bytes_read"], 0)
            state.close()

    def test_truncated_file_restarts_under_a_new_identity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            path = codex_root / "session.jsonl"
            write_lines(path, codex_lines(session="first", model="gpt-5.6-sol"))
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
                write_lines(path, codex_lines(session="x", model="gpt-5.5", total=20, input_tokens=10, output_tokens=10))
                stat_result = path.stat()
                os.utime(path, ns=(stat_result.st_atime_ns, stat_result.st_mtime_ns + 1_000_000))
                self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertEqual(len(uploads), 2)
            self.assertEqual(uploads[1]["rows"][0]["model_id"], "gpt-5.5")
            cursors = sqlite_cursor_count(state.path, str(path))
            self.assertEqual(cursors, 2)
            state.close()

    def test_file_disappearing_after_discovery_warns_without_checkpointing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            missing = root / "gone.jsonl"
            state = self.make_state(root)
            candidate = token_usage_collector.FileCandidate("codex", missing, "1:2", 0, 10, 1)
            with mock.patch.object(token_usage_collector, "discover_changed_files", return_value=([candidate], [], 0)):
                result = self.run_collector(state=state, codex_root=root, claude_root=root)
            self.assertEqual(result["warnings"]["files"], 1)
            self.assertIsNone(state.file_cursor("1:2"))
            state.close()

    def test_same_bucket_rows_aggregate_and_claude_uses_report_time_account(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            write_lines(codex_root / "a.jsonl", codex_lines(session="a"))
            write_lines(codex_root / "b.jsonl", codex_lines(session="b"))
            write_lines(claude_root / "project.jsonl", [json.dumps({
                "type": "assistant",
                "timestamp": "2026-08-18T11:50:00.000Z",
                "message": {
                    "id": "msg-1", "model": "claude-opus-4-8",
                    "usage": {"input_tokens": 2, "output_tokens": 3, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 5},
                },
            })])
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                self.run_collector(
                    state=state, codex_root=codex_root, claude_root=claude_root,
                    claude_account="claude-current@stardust.ai",
                )
            codex = next(row for row in uploads[0]["rows"] if row["provider"] == "codex")
            claude = next(row for row in uploads[0]["rows"] if row["provider"] == "claude")
            self.assertEqual(codex["total_tokens"], 240)
            self.assertEqual(claude["total_tokens"], 14)
            self.assertEqual(claude["model_account_id"], "claude-current@stardust.ai")
            state.close()

    def test_time_budget_checkpoints_complete_lines_and_resumes_next_cycle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            write_lines(codex_root / "session.jsonl", codex_lines())
            state = self.make_state(root)
            values = iter([0.0, 0.0, 0.0, 11.0, 11.0, 11.0])
            clock = lambda: next(values, 11.0)
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", return_value={"ok": True, "status_code": 200}) as post:
                first = self.run_collector(
                    state=state, codex_root=codex_root, claude_root=claude_root,
                    budget_seconds=10.0, monotonic=clock,
                )
                second = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertEqual(first["rows"], 0)
            self.assertFalse(first["backfill_complete"])
            self.assertEqual(second["rows"], 1)
            self.assertEqual(post.call_count, 1)
            state.close()

    def test_aggregate_row_limit_leaves_the_401st_record_for_next_cycle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            codex_root = root / "codex"
            claude_root = root / "claude"
            for index in range(401):
                write_lines(codex_root / f"{index:03d}.jsonl", codex_lines(
                    session=f"session-{index}", model=f"model-{index}"
                ))
            state = self.make_state(root)
            uploads = []
            with mock.patch.object(token_usage_collector, "post_token_usage_batch", side_effect=lambda _url, _token, payload: uploads.append(payload) or {"ok": True, "status_code": 200}):
                first = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
                second = self.run_collector(state=state, codex_root=codex_root, claude_root=claude_root)
            self.assertEqual(first["rows"], 400)
            self.assertEqual(second["rows"], 1)
            self.assertEqual([len(payload["rows"]) for payload in uploads], [400, 1])
            state.close()


class TokenUsageHttpTests(unittest.TestCase):
    def test_post_token_usage_batch_uses_existing_response_and_http_error_handlers(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        with mock.patch("quota_reporters.urllib.request.urlopen", return_value=response) as urlopen, mock.patch(
            "quota_reporters.read_auth_pool_response", return_value={"ok": True}
        ) as read_response:
            result = token_usage_collector.post_token_usage_batch(
                "https://hub.example.com", "secret", {"installation_id": "i", "batch_id": "b", "rows": []}
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status_code"], 200)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://hub.example.com/api/token-usage")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        read_response.assert_called_once_with(response)

    def test_post_token_usage_batch_reuses_token_invalidation_http_handling(self):
        error = urllib.error.HTTPError(
            "https://hub.example.com/api/token-usage", 401, "Unauthorized", {}, None
        )
        with mock.patch("quota_reporters.urllib.request.urlopen", side_effect=error), mock.patch(
            "quota_reporters.read_auth_pool_http_error",
            return_value={"ok": False, "status_code": 401, "reason": "token_invalidated"},
        ) as read_error:
            result = token_usage_collector.post_token_usage_batch(
                "https://hub.example.com", "secret", {"installation_id": "i", "batch_id": "b", "rows": []}
            )
        self.assertEqual(result["status_code"], 401)
        read_error.assert_called_once_with(
            error,
            auth_pool_url="https://hub.example.com",
            auth_pool_user_token="secret",
        )


def sqlite_cursor_count(path: Path, file_path: str) -> int:
    import sqlite3
    connection = sqlite3.connect(path)
    try:
        return int(connection.execute(
            "SELECT COUNT(*) FROM file_cursors WHERE path = ?", (file_path,)
        ).fetchone()[0])
    finally:
        connection.close()


if __name__ == "__main__":
    unittest.main()
