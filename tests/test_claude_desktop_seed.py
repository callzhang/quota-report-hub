import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/quota-reporter/scripts"))
import quota_reporters


@pytest.mark.parametrize("winning_store", ["keychain", "credentials_file"])
def test_seed_preserves_a_populated_desktop_cache_when_another_store_wins(tmp_path, winning_store):
    pool = {"claudeAiOauth": {
        "accessToken": "fixture-pool", "refreshToken": quota_reporters.STRIPPED_CLAUDE_REFRESH_TOKEN,
    }}
    desktop = {"claudeAiOauth": {"accessToken": "fixture-desktop", "refreshToken": "fixture-rt"}}
    with (
        mock.patch.object(quota_reporters, "read_claude_oauth_credentials", return_value=(pool, winning_store)),
        mock.patch.object(quota_reporters, "read_claude_token_cache_credentials", return_value=(desktop, "token_cache_v2")),
        mock.patch.object(quota_reporters, "write_claude_token_cache_credentials", return_value=True) as write,
    ):
        result = quota_reporters.seed_claude_desktop_from_pool_credential(tmp_path / ".claude")

    assert result == {"seeded": False, "reason": "desktop_already_has_entry"}
    write.assert_not_called()
