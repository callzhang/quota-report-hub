"""A scheduler that will not install says why, and says it to the hub.

xienxu's guard went unscheduled from 2026-10-17 to 2026-11-17. The only trace was
`Bootstrap failed: 5: Input/output error` printed to a Terminal window nobody kept, and the hub saw
nothing but silence.
"""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "skills" / "quota-reporter" / "scripts"))

import install_quota_guard  # noqa: E402
import quota_guard  # noqa: E402

BOOTSTRAP_STDERR = "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n"


def completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)


class LaunchctlFailureCarriesItsReason(unittest.TestCase):
    def test_a_refused_bootstrap_raises_with_what_launchctl_said(self):
        def run(args, **kwargs):
            if args[1] == "print":
                return completed(args, returncode=113, stderr="Could not find service")
            if args[1] == "bootstrap":
                return completed(args, returncode=5, stderr=BOOTSTRAP_STDERR)
            raise AssertionError(f"unexpected launchctl call {args}")

        with mock.patch.object(install_quota_guard.subprocess, "run", side_effect=run):
            with self.assertRaises(RuntimeError) as raised:
                install_quota_guard.load_launch_agent()
        self.assertIn("launchctl bootstrap exited 5", str(raised.exception))
        self.assertIn("Bootstrap failed: 5: Input/output error", str(raised.exception))


class FailedLaunchdInstallNamesTheCandidates(unittest.TestCase):
    def install_failing(self, print_disabled, plutil):
        missing = {"ok": False, "scheduler": "launchd", "reason": "not_registered", "install_command": "python3 install"}

        def run(args, **kwargs):
            if args[:2] == ["launchctl", "print-disabled"]:
                return print_disabled(args)
            if args[0] == "plutil":
                return plutil(args)
            raise AssertionError(f"unexpected call {args}")

        with mock.patch.object(quota_guard.platform, "system", return_value="Darwin"), \
                mock.patch.object(quota_guard, "check_scheduler_registration", return_value=missing), \
                mock.patch.object(quota_guard, "write_plist"), \
                mock.patch.object(quota_guard, "load_launch_agent", side_effect=RuntimeError("launchctl bootstrap exited 5: " + BOOTSTRAP_STDERR.strip())), \
                mock.patch.object(quota_guard.subprocess, "run", side_effect=run):
            return quota_guard.ensure_scheduler_registration({})

    def test_a_disabled_service_is_named(self):
        result = self.install_failing(
            lambda args: completed(args, stdout='disabled services = {\n\t"com.apple.x" => enabled\n\t"com.openai.quota-guard" => disabled\n}\n'),
            lambda args: completed(args, stdout=f"{args[-1]}: OK\n"),
        )
        self.assertEqual(result["reason"], "install_failed")
        self.assertIn("Bootstrap failed: 5", result["error"])
        self.assertEqual(result["launchd"], {"service_disabled": True, "plist_valid": True, "plist_lint": None})

    def test_a_malformed_plist_is_named(self):
        result = self.install_failing(
            lambda args: completed(args, stdout='disabled services = {\n\t"com.apple.x" => enabled\n}\n'),
            lambda args: completed(args, returncode=1, stdout=f"{args[-1]}: Encountered unexpected EOF\n"),
        )
        self.assertFalse(result["launchd"]["service_disabled"], "a label absent from the list is not disabled")
        self.assertFalse(result["launchd"]["plist_valid"])
        self.assertIn("unexpected EOF", result["launchd"]["plist_lint"])

    def test_an_unreadable_disabled_list_is_unknown_not_enabled(self):
        result = self.install_failing(
            lambda args: completed(args, returncode=1, stderr="Bad request"),
            lambda args: completed(args, stdout=f"{args[-1]}: OK\n"),
        )
        self.assertIsNone(result["launchd"]["service_disabled"])


class HeartbeatCarriesTheSchedulerFault(unittest.TestCase):
    WARNING = {
        "ok": False,
        "scheduler": "launchd",
        "reason": "install_failed",
        "error": "launchctl bootstrap exited 5: Bootstrap failed: 5: Input/output error",
        "launchd": {"service_disabled": False, "plist_valid": True, "plist_lint": None},
        "initial_check": {"ok": False, "reason": "not_registered", "install_command": "python3 install"},
        "install_command": "python3 /Users/x/install_quota_guard.py --auth-pool-url https://hub",
    }

    def test_the_heartbeat_names_the_fault_and_leaves_out_the_install_command(self):
        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            heartbeat = quota_guard.build_probe_heartbeat("claude", {"status": "ok"}, self.WARNING)
        self.assertEqual(heartbeat["scheduler"], {
            "scheduler": "launchd",
            "reason": "install_failed",
            "error": "launchctl bootstrap exited 5: Bootstrap failed: 5: Input/output error",
            "detail": None,
            "launchd": {"service_disabled": False, "plist_valid": True, "plist_lint": None},
        })

        with mock.patch("quota_guard.read_self_update_state", return_value={}):
            healthy = quota_guard.build_probe_heartbeat("claude", {"status": "ok"}, None)
        self.assertIsNone(healthy["scheduler"], "a scheduled machine must clear the fault on the hub")

    def test_the_report_posts_it(self):
        posted = {}
        with mock.patch("quota_guard.post_auth_pool_quota", side_effect=lambda *a, **k: posted.update(k) or {"ok": True}), \
                mock.patch("quota_guard.read_self_update_state", return_value={}), \
                mock.patch("quota_guard.quota_payload_is_reportable", return_value=False):
            quota_guard.report_current_quota_to_auth_pool(
                {"auth_pool_url": "https://hub", "auth_pool_user_token": "t"},
                "codex",
                {"status": "ok"},
                scheduler_warning=self.WARNING,
            )
        self.assertEqual(posted["heartbeat"]["scheduler"]["reason"], "install_failed")


if __name__ == "__main__":
    unittest.main()
