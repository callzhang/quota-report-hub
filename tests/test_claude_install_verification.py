import json
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/quota-reporter/scripts"))
import quota_guard


@pytest.mark.parametrize("response_key", ["replacement", "repair_auth"])
@pytest.mark.parametrize("same_account", [False, True])
@pytest.mark.parametrize("track_usage", [False, True])
def test_failed_claude_install_never_records_a_success(
    tmp_path, response_key, same_account, track_usage
):
    current_id = "claude-current@example.com"
    target_id = current_id if same_account else "claude-target@example.com"
    credentials = {"claudeAiOauth": {"accessToken": "fixture-new", "refreshToken": "fixture-rt"}}
    response = {response_key: {
        "account_id": target_id,
        "auth_json": json.dumps({
            "schema": "claude_credentials_v1", "account_id": target_id, "credentials": credentials,
        }),
    }}
    payload = {
        "account_id": current_id,
        "email": "current@example.com",
        "status": "ok",
        "windows": {"5h": {"remaining_percent": 1}},
    }
    usage = mock.Mock() if track_usage else None
    with (
        mock.patch.object(quota_guard, "detect_claude_custom_provider_env", return_value=None),
        mock.patch.object(quota_guard, "fetch_best_auth", return_value=response),
        mock.patch.object(quota_guard, "notify_hub_notices"),
        mock.patch.object(quota_guard, "enforce_hub_upgrade_demand"),
        mock.patch.object(quota_guard, "install_claude_credentials", return_value={
            "installed": False, "reason": "shadowed_by_token_cache_v2",
        }),
        mock.patch.object(quota_guard, "read_claude_oauth_credentials", return_value=(
            {"claudeAiOauth": {"accessToken": "fixture-old"}}, "token_cache_v2",
        )),
        mock.patch.object(quota_guard, "write_known_auth_state") as write_known,
    ):
        with pytest.raises(RuntimeError, match="Claude Code credential installation failed"):
            quota_guard.maybe_replace_claude_auth(
                {"auth_pool_url": "https://hub.example", "auth_pool_user_token": "fixture-token"},
                payload, tmp_path / ".claude", tmp_path / "known_auth.json",
                threshold_percent=20, weekly_threshold_percent=5, usage_state=usage,
            )

    write_known.assert_not_called()
    if usage is not None:
        usage.finalize_account_switch.assert_not_called()
        if same_account:
            usage.prepare_account_switch.assert_not_called()
        else:
            usage.cancel_account_switch.assert_called_once()


def test_claude_notification_names_cli_scope_and_desktop_limit():
    message = quota_guard.replacement_toast_message("claude", {
        "to_email": "target@example.com", "to_plan_name": "Max",
    })
    assert "Claude Code" in message
    assert "target@example.com (Max)" in message
    assert "Claude App" in message
    assert "不会同步切换" in message
