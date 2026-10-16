import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import quota_guard  # noqa: E402
from quota_reporters import CLAUDE_LOGGED_OUT_ERROR  # noqa: E402

CONFIG = {"auth_pool_url": "https://hub.example.com", "auth_pool_user_token": "qrp.test"}
LOGGED_OUT = {
    "status": "error",
    "error": CLAUDE_LOGGED_OUT_ERROR,
    "account_id": "claude-owner@gmail.com",
    "email": "owner@gmail.com",
    "reporter_name": "laptop",
    "windows": {"5h": None, "1week": None},
}


def known_auth(base: Path, state_source: str) -> Path:
    path = base / "known_auth.json"
    path.write_text(json.dumps({"sources": {"claude": {"state_source": state_source}}}), encoding="utf-8")
    return path


class LoggedOutAfterPoolFetchTests(unittest.TestCase):
    # derek@, claude, 2026-10-15: the pool-fetched access token lapsed, the CLI said "logged out", and
    # the guard sent a plain replacement request that excludes the current account -- which was the
    # pool's only one. It must ask for a renewal of the same account instead.
    def test_a_lapsed_pool_credential_asks_for_a_renewal_of_the_same_account(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={"replacement": None}) as fetch:
                quota_guard.maybe_replace_claude_auth(
                    CONFIG, dict(LOGGED_OUT), base / "claude", known_auth(base, "fetched_from_auth_pool"), 20.0, 5.0,
                )
        self.assertTrue(fetch.call_args.kwargs["refresh_current"])
        self.assertEqual(fetch.call_args.kwargs["current_account_id"], "claude-owner@gmail.com")
        self.assertEqual(fetch.call_args.kwargs["exclude_account_ids"], [])

    def test_a_person_who_owns_the_login_and_signed_out_is_still_a_dead_credential(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            with mock.patch.object(quota_guard, "fetch_best_auth", return_value={"replacement": None}) as fetch:
                quota_guard.maybe_replace_claude_auth(
                    CONFIG, dict(LOGGED_OUT), base / "claude", known_auth(base, "owner_local"), 20.0, 5.0,
                )
        self.assertFalse(fetch.call_args.kwargs["refresh_current"])

    def test_a_lapsed_credential_cannot_wait_for_the_hub_to_renew_in_place(self):
        # With no OAuth record left, the local expiry clock reads None and would defer forever when
        # the hub answers a renewal with a different account.
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            quota_guard, "local_access_token_seconds_left", return_value=None
        ):
            base = Path(temp_dir)
            self.assertTrue(quota_guard.current_auth_cannot_wait(
                dict(LOGGED_OUT), known_auth(base, "fetched_from_auth_pool"), claude_home=base / "claude"))
            self.assertFalse(quota_guard.current_auth_cannot_wait(
                dict(LOGGED_OUT), known_auth(base, "owner_local"), claude_home=base / "claude"))

    def test_other_errors_do_not_count_as_a_lapsed_token(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            known = known_auth(Path(temp_dir), "fetched_from_auth_pool")
            self.assertFalse(quota_guard.claude_logged_out_after_pool_fetch(
                {**LOGGED_OUT, "error": "refresh_token_rejected"}, known))
            self.assertFalse(quota_guard.claude_logged_out_after_pool_fetch({**LOGGED_OUT, "status": "ok"}, known))


if __name__ == "__main__":
    unittest.main()
