import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import quota_guard  # noqa: E402
from reporter_version import CLIENT_VERSION  # noqa: E402


def notice(code="premium_ratio_cooldown", message="占比过高"):
    return {"code": code, "title": "额度守护", "message": message}


class NotifyHubNoticesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp.name) / "notices.json"
        self.addCleanup(self.temp.cleanup)

    def test_shows_each_notice_once_per_repeat_window(self):
        result = {"notices": [notice()]}
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as shown:
            first = quota_guard.notify_hub_notices(result, now=1000.0, state_path=self.state_path)
            # The guard runs every 15 minutes; a toast on every run trains people to ignore it.
            second = quota_guard.notify_hub_notices(result, now=1000.0 + 900, state_path=self.state_path)
        self.assertEqual(first["shown"], ["premium_ratio_cooldown"])
        self.assertEqual(second["shown"], [])
        self.assertEqual(shown.call_count, 1)

    def test_shows_again_after_the_repeat_window(self):
        result = {"notices": [notice()]}
        later = 1000.0 + quota_guard.HUB_NOTICE_REPEAT_SECONDS + 1
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True):
            quota_guard.notify_hub_notices(result, now=1000.0, state_path=self.state_path)
            again = quota_guard.notify_hub_notices(result, now=later, state_path=self.state_path)
        self.assertEqual(again["shown"], ["premium_ratio_cooldown"])

    def test_distinct_codes_are_throttled_independently(self):
        result = {"notices": [notice(), notice(code="reporter_upgrade_required", message="请升级")]}
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True):
            shown = quota_guard.notify_hub_notices(result, now=1000.0, state_path=self.state_path)
        self.assertEqual(sorted(shown["shown"]), ["premium_ratio_cooldown", "reporter_upgrade_required"])

    def test_a_platform_without_a_notifier_does_not_retry_every_run(self):
        result = {"notices": [notice()]}
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=False) as shown:
            quota_guard.notify_hub_notices(result, now=1000.0, state_path=self.state_path)
            quota_guard.notify_hub_notices(result, now=1000.0 + 900, state_path=self.state_path)
        self.assertEqual(shown.call_count, 1)

    def test_ignores_responses_without_notices(self):
        for result in ({}, {"notices": []}, {"notices": "nope"}, {"notices": [{"code": ""}]}):
            with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as shown:
                quota_guard.notify_hub_notices(result, now=1000.0, state_path=self.state_path)
            self.assertEqual(shown.call_count, 0, result)

    def test_state_file_is_readable_json(self):
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True):
            quota_guard.notify_hub_notices({"notices": [notice()]}, now=1000.0, state_path=self.state_path)
        self.assertEqual(json.loads(self.state_path.read_text())["premium_ratio_cooldown"], 1000.0)


class ClientVersionTest(unittest.TestCase):
    def test_client_version_matches_the_server_floor(self):
        # The hub refuses clients below MIN_REPORTER_CLIENT_VERSION. Shipping a client that cannot
        # satisfy its own server's floor would lock every user out on the reporter-gate date.
        source = (Path(__file__).resolve().parent.parent / "lib" / "premium-ratio.js").read_text()
        marker = 'export const MIN_REPORTER_CLIENT_VERSION = "'
        start = source.index(marker) + len(marker)
        minimum = source[start:source.index('"', start)]
        self.assertEqual(
            [int(part) for part in CLIENT_VERSION.split(".")],
            [int(part) for part in minimum.split(".")],
        )


if __name__ == "__main__":
    unittest.main()


class RepeatIntervalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp.name) / "notices.json"
        self.addCleanup(self.temp.cleanup)

    def test_honours_the_interval_the_hub_chose(self):
        # Urgency is the hub's judgement. A client that picks its own cadence cannot be re-tuned
        # without shipping a release.
        hourly = {"notices": [dict(notice(code="usage_reporting_required"), repeat_seconds=3600)]}
        with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as shown:
            quota_guard.notify_hub_notices(hourly, now=0.0, state_path=self.state_path)
            quota_guard.notify_hub_notices(hourly, now=1800.0, state_path=self.state_path)   # 30 min
            quota_guard.notify_hub_notices(hourly, now=3601.0, state_path=self.state_path)   # 60 min
        self.assertEqual(shown.call_count, 2, "shown at 0 and 3601, suppressed at 1800")

    def test_falls_back_to_the_default_when_the_hub_sends_none(self):
        for bad in (None, 0, -5, "soon"):
            state_path = Path(self.temp.name) / f"n-{bad}.json"
            payload = {"notices": [dict(notice(), repeat_seconds=bad)]}
            with mock.patch.object(quota_guard, "show_desktop_notification", return_value=True) as shown:
                quota_guard.notify_hub_notices(payload, now=0.0, state_path=state_path)
                quota_guard.notify_hub_notices(payload, now=3601.0, state_path=state_path)
            self.assertEqual(shown.call_count, 1, f"repeat_seconds={bad!r} should fall back to the default")
