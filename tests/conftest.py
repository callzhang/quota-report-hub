"""Keep the suite off this machine's real credentials and scheduled jobs.

Several reporter paths (strip_local_claude_refresh_token, install_claude_credentials,
write_claude_keychain_credentials) write EVERY local Claude credential store by design. A test that
reaches one of them without mocking it does not fail — it silently overwrites the developer's live
macOS keychain entry with a fixture, and `claude auth status` then reports loggedIn=false until
someone notices. That happened once; this makes it impossible rather than a review item.

The scheduler is the same hazard. A test that reaches installation without mocking it replaces the
developer's running quota-guard job; one run under a temporary HOME did (2026-11-25), because HOME
moves files but not launchd or cron.

Reads are left alone: they cannot damage anything, and some tests exercise the read ordering.
"""
import subprocess
import sys
from pathlib import Path

import pytest

_real_run = subprocess.run
_WRITE_VERBS = ("add-generic-password", "delete-generic-password")
# Listed by what only reads, so a subcommand nobody thought of is refused rather than run.
_SCHEDULER_READS = {"launchctl": ("print", "print-disabled"), "crontab": ("-l",)}


def _is_keychain_write(cmd):
    return (
        isinstance(cmd, (list, tuple))
        and cmd
        and cmd[0] == "security"
        and any(verb in cmd for verb in _WRITE_VERBS)
    )


def _is_scheduler_write(cmd):
    if not (isinstance(cmd, (list, tuple)) and cmd):
        return False
    reads = _SCHEDULER_READS.get(Path(str(cmd[0])).name)
    return reads is not None and (len(cmd) < 2 or cmd[1] not in reads)


@pytest.fixture(autouse=True)
def _block_real_machine_writes(monkeypatch, request):
    def guarded(cmd, *args, **kwargs):
        if _is_keychain_write(cmd):
            raise AssertionError(
                f"{request.node.nodeid} tried to WRITE the real macOS keychain "
                f"({' '.join(str(c) for c in cmd[:5])}). Mock the credential-writing helper "
                "(e.g. strip_local_claude_refresh_token / install_claude_credentials / "
                "write_claude_keychain_credentials) instead of letting it reach the machine."
            )
        if _is_scheduler_write(cmd):
            raise AssertionError(
                f"{request.node.nodeid} tried to CHANGE this machine's scheduled jobs "
                f"({' '.join(str(c) for c in cmd[:5])}). Mock load_launch_agent / "
                "install_linux_crontab instead of letting it reach the machine."
            )
        return _real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", guarded)
    yield


@pytest.fixture(autouse=True)
def _keep_the_hub_move_off_the_real_config(monkeypatch):
    """quota_guard.main() rewrites a retired hub address in ~/.agents/auth/quota-reporter.json before
    anything else. A test that runs main() did exactly that to the developer's real install
    (2026-11-25). tests/test_hub_move.py exercises the function itself, on temporary files."""
    guard = sys.modules.get("quota_guard")
    if guard is not None:
        monkeypatch.setattr(guard, "move_config_off_retired_hub", lambda: False)
    yield


@pytest.fixture(autouse=True)
def _keep_the_installation_id_off_the_real_config(monkeypatch):
    """build_probe_heartbeat names this installation, and the first call writes the id into
    ~/.agents/auth/quota-reporter.json. A suite that builds heartbeats must not mint one for the
    developer's real install."""
    guard = sys.modules.get("quota_guard")
    if guard is not None:
        monkeypatch.setattr(guard, "reporter_installation_id", lambda: "test-installation")
    yield


@pytest.fixture(autouse=True)
def _keep_the_launch_agent_file_off_the_real_one(monkeypatch, tmp_path):
    """Installation writes the plist before it calls launchctl, and launchd loads whatever is in that
    file at the next login, so blocking the command alone would not protect the job."""
    for module, name in (("install_quota_guard", "PLIST_PATH"), ("quota_guard", "LAUNCH_AGENT_PLIST_PATH")):
        loaded = sys.modules.get(module)
        if loaded is not None:
            monkeypatch.setattr(loaded, name, tmp_path / "com.openai.quota-guard.plist")
    yield
