import json

from quota_reporters import HUB_URL, move_config_off_retired_hub


def write(path, url):
    path.write_text(json.dumps({"auth_pool_url": url, "auth_pool_user_token": "qrp.token"}), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_a_config_pointing_at_the_retired_hub_is_moved_and_keeps_its_token(tmp_path):
    config = tmp_path / "quota-reporter.json"
    write(config, "https://quota-report-hub.vercel.app/")

    assert move_config_off_retired_hub(config) is True
    assert read(config) == {"auth_pool_url": HUB_URL, "auth_pool_user_token": "qrp.token"}
    assert move_config_off_retired_hub(config) is False


def test_somebody_elses_hub_is_left_alone(tmp_path):
    config = tmp_path / "quota-reporter.json"
    write(config, "https://hub.example.com")

    assert move_config_off_retired_hub(config) is False
    assert read(config)["auth_pool_url"] == "https://hub.example.com"


def test_a_machine_without_a_config_is_not_given_one(tmp_path):
    config = tmp_path / "quota-reporter.json"

    assert move_config_off_retired_hub(config) is False
    assert not config.exists()
