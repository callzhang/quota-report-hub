"""The suite must not change the scheduled jobs of the machine it runs on (tests/conftest.py).

Nothing here can reach the machine even with the guard missing: the command that would run is
replaced by a recorder first.
"""
import subprocess
import sys
from pathlib import Path

import conftest
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "quota-reporter" / "scripts"))

import install_quota_guard  # noqa: E402
import quota_guard  # noqa: E402


@pytest.fixture
def reached(monkeypatch):
    calls = []
    monkeypatch.setattr(conftest, "_real_run", lambda cmd, *args, **kwargs: calls.append(cmd))
    return calls


@pytest.mark.parametrize(
    "cmd",
    [
        ["launchctl", "bootstrap", "gui/501", "job.plist"],
        ["/bin/launchctl", "bootout", "gui/501", "job.plist"],
        ["launchctl", "kickstart", "-k", "gui/501/com.openai.quota-guard"],
        ["crontab", "-"],
        ["crontab", "-r"],
    ],
)
def test_a_scheduler_change_never_reaches_the_machine(cmd, reached):
    with pytest.raises(AssertionError):
        subprocess.run(cmd)

    assert reached == []


@pytest.mark.parametrize(
    "cmd",
    [
        ["launchctl", "print", "gui/501/com.openai.quota-guard"],
        ["launchctl", "print-disabled", "gui/501"],
        ["crontab", "-l"],
    ],
)
def test_reading_the_scheduler_is_left_alone(cmd, reached):
    subprocess.run(cmd)

    assert reached == [cmd]


def test_the_launch_agent_file_is_not_the_installed_one():
    installed = Path.home() / "Library" / "LaunchAgents"

    assert install_quota_guard.PLIST_PATH.parent != installed
    assert quota_guard.LAUNCH_AGENT_PLIST_PATH == install_quota_guard.PLIST_PATH
