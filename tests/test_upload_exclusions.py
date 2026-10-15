import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import quota_guard  # noqa: E402
import quota_reporters  # noqa: E402
import token_usage_collector  # noqa: E402
from token_usage_state import TokenUsageState  # noqa: E402

PRIVATE = "private.person@gmail.com"
EXCLUDED = frozenset({("codex", PRIVATE)})
CONFIG = {"auth_pool_url": "https://hub.example.com", "auth_pool_user_token": "qrp.test"}
NOW = datetime(2026, 8, 18, 12, 0, 0, tzinfo=timezone.utc)


def codex_auth_file(path: Path, email: str) -> None:
    import base64

    claims = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).decode().rstrip("=")
    path.write_text(json.dumps({"tokens": {
        "account_id": "provider-uuid",
        "refresh_token": "rt.1.REALFIXTURETOKEN",
        "id_token": f"x.{claims}.y",
    }}), encoding="utf-8")


class UploadExclusionTests(unittest.TestCase):
    def test_an_unreadable_list_excludes_everything(self):
        self.assertTrue(quota_reporters.account_upload_excluded(None, "codex", "anyone@example.com"))
        self.assertFalse(quota_reporters.account_upload_excluded(frozenset(), "codex", "anyone@example.com"))
        self.assertFalse(quota_reporters.account_upload_excluded(EXCLUDED, "claude", PRIVATE))

    def test_an_excluded_codex_credential_is_never_posted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            codex_auth_file(auth_path, PRIVATE)
            with mock.patch("quota_reporters.post_auth_pool_entry") as post:
                result = quota_reporters.sync_current_codex_auth_pool(
                    CONFIG["auth_pool_url"], CONFIG["auth_pool_user_token"],
                    auth_path=auth_path, known_auth_path=base / "known.json",
                    upload_exclusions=EXCLUDED,
                )
        post.assert_not_called()
        self.assertEqual(result, {"ok": True, "uploaded": False, "reason": "upload_excluded"})
        self.assertFalse(quota_guard.current_account_confirmed_on_hub(result))

    def test_another_codex_credential_is_still_posted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            auth_path = base / "auth.json"
            codex_auth_file(auth_path, "someone@stardust.ai")
            with mock.patch("quota_reporters.post_auth_pool_entry", return_value={"ok": True, "entry": {}}) as post:
                quota_reporters.sync_current_codex_auth_pool(
                    CONFIG["auth_pool_url"], CONFIG["auth_pool_user_token"],
                    auth_path=auth_path, known_auth_path=base / "known.json",
                    upload_exclusions=EXCLUDED,
                )
        post.assert_called_once()

    def test_an_excluded_account_reports_no_quota_and_no_identity(self):
        payload = {
            "status": "ok", "account_id": PRIVATE, "access_token_fingerprint": "fp",
            "windows": {"5h": {"remaining_percent": 40}, "1week": {"remaining_percent": 60}},
        }
        with mock.patch.object(quota_guard, "post_auth_pool_quota", return_value={"ok": True}) as post:
            result = quota_guard.report_current_quota_to_auth_pool(CONFIG, "codex", payload, EXCLUDED)
        sent = post.call_args.kwargs
        self.assertIsNone(sent["quota_payload"])
        self.assertIsNone(sent["heartbeat"]["account_id"])
        self.assertIsNone(sent["heartbeat"]["access_token_fingerprint"])
        self.assertEqual(sent["heartbeat"]["status"], "ok", "the machine is still heard from")
        self.assertFalse(result["reported"])

    def test_borrowing_for_an_excluded_account_does_not_name_it(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            payload = {
                "status": "ok", "account_id": PRIVATE, "reporter_name": "laptop",
                "windows": {"5h": {"remaining_percent": 1}, "1week": {"remaining_percent": 50}},
            }
            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={"replacement": None}) as fetch:
                quota_guard.maybe_replace_codex_auth(
                    CONFIG, payload, base / "auth.json", base / "known.json", 20.0, 5.0,
                    upload_exclusions=EXCLUDED,
                )
        fetch.assert_called_once()
        self.assertIsNone(fetch.call_args.kwargs["current_account_id"])
        self.assertEqual(fetch.call_args.kwargs["current_quota"]["five_h_remaining_percent"], 1)

    def test_usage_on_an_excluded_account_is_read_but_never_uploaded(self):
        lines = [
            json.dumps({"type": "session_meta", "payload": {"session_id": "s1"}}),
            json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
            json.dumps({"timestamp": "2026-08-18T11:45:01.000Z", "type": "event_msg", "payload": {
                "type": "token_count", "info": {"total_token_usage": {
                    "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 60,
                    "cache_write_input_tokens": 0, "reasoning_output_tokens": 5, "total_tokens": 120,
                }}}}),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            session = root / "codex" / "session.jsonl"
            session.parent.mkdir(parents=True)
            session.write_text("\n".join(lines) + "\n", encoding="utf-8")
            state = TokenUsageState(root / "state.sqlite3", now=lambda: NOW)
            with mock.patch.object(token_usage_collector, "post_token_usage_batch") as post:
                summary = token_usage_collector.collect_and_report_token_usage(
                    config=CONFIG, codex_account_id=PRIVATE, claude_account_id=None,
                    upload_exclusions=EXCLUDED, state=state,
                    codex_roots=(root / "codex",), claude_root=root / "claude", wall_now=lambda: NOW,
                )
            state.close()
        post.assert_not_called()
        self.assertEqual(summary["rows"], 0)

    def test_usage_is_not_collected_while_the_list_is_unreadable(self):
        with mock.patch.object(token_usage_collector, "post_token_usage_batch") as post:
            summary = token_usage_collector.collect_and_report_token_usage(
                config=CONFIG, codex_account_id=PRIVATE, claude_account_id=None, upload_exclusions=None,
            )
        post.assert_not_called()
        self.assertEqual(summary["reason"], "upload_exclusions_unavailable")


if __name__ == "__main__":
    unittest.main()
