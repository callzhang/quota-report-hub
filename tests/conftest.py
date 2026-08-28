"""Keep the suite off this machine's real credentials.

Several reporter paths (strip_local_claude_refresh_token, install_claude_credentials,
write_claude_keychain_credentials) write EVERY local Claude credential store by design. A test that
reaches one of them without mocking it does not fail — it silently overwrites the developer's live
macOS keychain entry with a fixture, and `claude auth status` then reports loggedIn=false until
someone notices. That happened once; this makes it impossible rather than a review item.

Reads are left alone: they cannot damage anything, and some tests exercise the read ordering.
"""
import subprocess

import pytest

_real_run = subprocess.run
_WRITE_VERBS = ("add-generic-password", "delete-generic-password")


def _is_keychain_write(cmd):
    return (
        isinstance(cmd, (list, tuple))
        and cmd
        and cmd[0] == "security"
        and any(verb in cmd for verb in _WRITE_VERBS)
    )


@pytest.fixture(autouse=True)
def _block_real_keychain_writes(monkeypatch, request):
    def guarded(cmd, *args, **kwargs):
        if _is_keychain_write(cmd):
            raise AssertionError(
                f"{request.node.nodeid} tried to WRITE the real macOS keychain "
                f"({' '.join(str(c) for c in cmd[:5])}). Mock the credential-writing helper "
                "(e.g. strip_local_claude_refresh_token / install_claude_credentials / "
                "write_claude_keychain_credentials) instead of letting it reach the machine."
            )
        return _real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", guarded)
    yield
