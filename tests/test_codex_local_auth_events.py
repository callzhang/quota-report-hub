import importlib.util
import sqlite3
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "codex_local_auth_events.py"
spec = importlib.util.spec_from_file_location("codex_local_auth_events", SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

SPAN = 'session_loop{thread_id=abc}:turn{model=x}:'


def make_db(path, rows):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE logs (ts INTEGER, target TEXT, feedback_log_body TEXT)")
    connection.executemany("INSERT INTO logs VALUES (?, ?, ?)", rows)
    connection.commit()
    connection.close()


def ts(text):
    return tool.parse_utc(text)


def test_window_selects_only_auth_manager_events_and_classifies_them(tmp_path):
    db = tmp_path / "logs.sqlite"
    make_db(db, [
        (ts("2026-09-21T09:43:03Z"), tool.TARGET, SPAN + "Refreshing token"),
        (ts("2026-09-21T09:43:03Z"), tool.TARGET,
         SPAN + 'Failed to refresh token: 401 Unauthorized: {"message":"Your session has ended."}'),
        (ts("2026-09-22T12:45:45Z"), tool.TARGET,
         SPAN + "Skipping auth reload due to account id mismatch (expected: "
         "8f4d3ad3-67c3-4b69-b378-1f89c95cb0e5, found: 55983ee7-0d5d-462b-a1ad-290bdf8f9e3f)"),
        # A different target inside the window must not be counted.
        (ts("2026-09-21T10:00:00Z"), "codex_core::client", SPAN + "Refreshing token"),
        # An auth-manager event outside the window must not be counted.
        (ts("2026-09-25T00:00:00Z"), tool.TARGET, SPAN + "Refreshing token"),
    ])

    found = tool.events(db, ts("2026-09-21T00:00:00Z"), ts("2026-09-23T00:00:00Z"))

    assert [kind for _, kind, _ in found] == [
        "refresh_attempted", "refresh_failed", "reload_skipped_account_mismatch",
    ]


def test_output_masks_tokens_and_account_ids(tmp_path):
    db = tmp_path / "logs.sqlite"
    jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJlLXNlY3JldC1ieXRlcw"
    make_db(db, [
        (ts("2026-09-22T12:45:45Z"), tool.TARGET,
         SPAN + f"Failed to refresh token: 401 {jwt} account 55983ee7-0d5d-462b-a1ad-290bdf8f9e3f"),
    ])

    (_, _, message), = tool.events(db, 0, ts("2027-01-01T00:00:00Z"))

    assert jwt not in message
    assert "55983ee7" not in message
    assert "<jwt>" in message and "<id>" in message


def test_an_empty_window_reports_no_refresh_attempt(tmp_path, capsys):
    db = tmp_path / "logs.sqlite"
    make_db(db, [
        (ts("2026-09-22T12:45:45Z"), tool.TARGET,
         SPAN + "Skipping auth reload due to account id mismatch (expected: a, found: b)"),
    ])

    code = tool.main(["--db", str(db), "--since", "2026-09-21T00:00:00Z", "--until", "2026-09-23T00:00:00Z"])

    out = capsys.readouterr().out
    assert code == 0
    assert "No refresh attempt by Codex on this machine" in out


def test_the_database_is_opened_read_only(tmp_path):
    db = tmp_path / "logs.sqlite"
    make_db(db, [])
    before = db.stat().st_mtime_ns

    tool.events(db, 0, 1)

    assert db.stat().st_mtime_ns == before
