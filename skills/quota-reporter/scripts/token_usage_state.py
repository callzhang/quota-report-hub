#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_TOKEN_USAGE_STATE_PATH = Path.home() / ".agents" / "auth" / "token-usage.sqlite3"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def json_text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class TokenUsageState:
    def __init__(
        self,
        path: Path = DEFAULT_TOKEN_USAGE_STATE_PATH,
        *,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self.path = Path(path).expanduser()
        self._now = now
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(self.path.parent, 0o700)
        self._connection = sqlite3.connect(self.path, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        if os.name != "nt":
            os.chmod(self.path, 0o600)
        self._ensure_schema()
        self._ensure_identity()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "TokenUsageState":
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()

    def _ensure_schema(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS collector_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS file_cursors (
              file_key TEXT PRIMARY KEY,
              path TEXT NOT NULL,
              offset INTEGER NOT NULL,
              size INTEGER NOT NULL,
              mtime_ns INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_counters (
              record_key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seen_usage_records (
              digest TEXT PRIMARY KEY,
              event_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_uploads (
              batch_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              payload_digest TEXT NOT NULL,
              proposed_state_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              status TEXT NOT NULL,
              last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS account_switches (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              provider TEXT NOT NULL,
              prepared_at TEXT NOT NULL,
              from_account_id TEXT,
              to_account_id TEXT,
              status TEXT NOT NULL,
              finalized_at TEXT
            );
            CREATE INDEX IF NOT EXISTS seen_usage_records_event_idx
              ON seen_usage_records (event_at);
            CREATE INDEX IF NOT EXISTS account_switches_provider_prepared_idx
              ON account_switches (provider, prepared_at);
            """
        )

    def _ensure_identity(self) -> None:
        current = self._connection.execute(
            "SELECT key, value FROM collector_meta WHERE key IN ('installation_id', 'backfill_cutoff')"
        ).fetchall()
        values = {row["key"]: row["value"] for row in current}
        if "installation_id" in values and "backfill_cutoff" in values:
            return
        created_at = self._now()
        installation_id = values.get("installation_id", str(uuid.uuid4()))
        cutoff = values.get("backfill_cutoff", iso_timestamp(created_at - timedelta(hours=72)))
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            self._connection.execute(
                "INSERT OR IGNORE INTO collector_meta (key, value) VALUES ('installation_id', ?)",
                (installation_id,),
            )
            self._connection.execute(
                "INSERT OR IGNORE INTO collector_meta (key, value) VALUES ('backfill_cutoff', ?)",
                (cutoff,),
            )
            self._connection.execute("COMMIT")
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise

    def _meta(self, key: str) -> str:
        row = self._connection.execute(
            "SELECT value FROM collector_meta WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            raise RuntimeError(f"missing collector metadata: {key}")
        return str(row["value"])

    @property
    def installation_id(self) -> str:
        return self._meta("installation_id")

    @property
    def backfill_cutoff(self) -> str:
        return self._meta("backfill_cutoff")

    def pending_upload(self) -> dict[str, Any] | None:
        row = self._connection.execute(
            """
            SELECT batch_id, payload_json, payload_digest, proposed_state_json, created_at
            FROM pending_uploads
            WHERE status = 'pending'
            ORDER BY created_at, batch_id
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            return None
        return {
            "batch_id": row["batch_id"],
            "payload": json.loads(row["payload_json"]),
            "payload_digest": row["payload_digest"],
            "proposed": json.loads(row["proposed_state_json"]),
            "created_at": row["created_at"],
        }

    def stage_batch(self, *, payload: dict[str, Any], proposed: dict[str, Any]) -> dict[str, Any]:
        batch_id = str(payload.get("batch_id") or "")
        if not batch_id:
            raise ValueError("payload batch_id is required")
        payload_json = json_text(payload)
        proposed_json = json_text(proposed)
        digest = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        created_at = iso_timestamp(self._now())
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            existing = self._connection.execute(
                "SELECT batch_id FROM pending_uploads WHERE status = 'pending' LIMIT 1"
            ).fetchone()
            if existing is not None:
                raise RuntimeError(f"pending upload already exists: {existing['batch_id']}")
            self._connection.execute(
                """
                INSERT INTO pending_uploads (
                  batch_id, payload_json, payload_digest, proposed_state_json,
                  created_at, status, last_error
                ) VALUES (?, ?, ?, ?, ?, 'pending', NULL)
                """,
                (batch_id, payload_json, digest, proposed_json, created_at),
            )
            self._connection.execute("COMMIT")
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        return self.pending_upload()  # type: ignore[return-value]

    def _apply_proposed(self, proposed: dict[str, Any], updated_at: str) -> None:
        for item in proposed.get("files", []):
            self._connection.execute(
                """
                INSERT INTO file_cursors (file_key, path, offset, size, mtime_ns, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_key) DO UPDATE SET
                  path = excluded.path,
                  offset = excluded.offset,
                  size = excluded.size,
                  mtime_ns = excluded.mtime_ns,
                  updated_at = excluded.updated_at
                """,
                (
                    item["file_key"], item["path"], int(item["offset"]),
                    int(item["size"]), int(item["mtime_ns"]), updated_at,
                ),
            )
        for item in proposed.get("counters", []):
            self._connection.execute(
                """
                INSERT INTO usage_counters (record_key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(record_key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
                """,
                (item["record_key"], json_text(item["value"]), updated_at),
            )
        for item in proposed.get("fingerprints", []):
            self._connection.execute(
                "INSERT OR IGNORE INTO seen_usage_records (digest, event_at) VALUES (?, ?)",
                (item["digest"], item["event_at"]),
            )

    def ack_pending_batch(self, batch_id: str) -> bool:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._connection.execute(
                "SELECT proposed_state_json FROM pending_uploads WHERE batch_id = ? AND status = 'pending'",
                (batch_id,),
            ).fetchone()
            if row is None:
                self._connection.execute("COMMIT")
                return False
            updated_at = iso_timestamp(self._now())
            self._apply_proposed(json.loads(row["proposed_state_json"]), updated_at)
            self._connection.execute(
                "UPDATE pending_uploads SET status = 'acknowledged', last_error = NULL WHERE batch_id = ?",
                (batch_id,),
            )
            self._connection.execute("COMMIT")
            return True
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise

    def reject_pending_batch(self, batch_id: str, *, status_code: int, error_code: str) -> bool:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._connection.execute(
                "SELECT proposed_state_json FROM pending_uploads WHERE batch_id = ? AND status = 'pending'",
                (batch_id,),
            ).fetchone()
            if row is None:
                self._connection.execute("COMMIT")
                return False
            updated_at = iso_timestamp(self._now())
            self._apply_proposed(json.loads(row["proposed_state_json"]), updated_at)
            safe_error = json_text({"status_code": int(status_code), "error_code": str(error_code)})
            self._connection.execute(
                "UPDATE pending_uploads SET status = 'rejected', last_error = ? WHERE batch_id = ?",
                (safe_error, batch_id),
            )
            self._connection.execute("COMMIT")
            return True
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise

    def apply_checkpoint(self, proposed: dict[str, Any]) -> None:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            self._apply_proposed(proposed, iso_timestamp(self._now()))
            self._connection.execute("COMMIT")
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise

    def file_cursor(self, file_key: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT file_key, path, offset, size, mtime_ns, updated_at FROM file_cursors WHERE file_key = ?",
            (file_key,),
        ).fetchone()
        return dict(row) if row is not None else None

    def file_cursor_for_path(self, path: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            """
            SELECT file_key, path, offset, size, mtime_ns, updated_at
            FROM file_cursors
            WHERE path = ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
            """,
            (path,),
        ).fetchone()
        return dict(row) if row is not None else None

    def usage_counter(self, record_key: str) -> dict[str, int] | None:
        row = self._connection.execute(
            "SELECT value_json FROM usage_counters WHERE record_key = ?", (record_key,)
        ).fetchone()
        return json.loads(row["value_json"]) if row is not None else None

    def has_fingerprint(self, digest: str) -> bool:
        row = self._connection.execute(
            "SELECT 1 FROM seen_usage_records WHERE digest = ?", (digest,)
        ).fetchone()
        return row is not None

    def prune_fingerprints(self, before: str) -> int:
        result = self._connection.execute(
            "DELETE FROM seen_usage_records WHERE event_at < ?", (before,)
        )
        return int(result.rowcount)

    def prepare_account_switch(
        self,
        *,
        provider: str,
        from_account_id: str | None,
        to_account_id: str | None,
        prepared_at: str,
    ) -> int:
        result = self._connection.execute(
            """
            INSERT INTO account_switches (
              provider, prepared_at, from_account_id, to_account_id, status, finalized_at
            ) VALUES (?, ?, ?, ?, 'prepared', NULL)
            """,
            (provider, prepared_at, from_account_id, to_account_id),
        )
        return int(result.lastrowid)

    def finalize_account_switch(self, switch_id: int, *, finalized_at: str) -> bool:
        result = self._connection.execute(
            """
            UPDATE account_switches
            SET status = 'finalized', finalized_at = ?
            WHERE id = ? AND status = 'prepared'
            """,
            (finalized_at, switch_id),
        )
        return result.rowcount > 0

    def cancel_account_switch(self, switch_id: int, *, cancelled_at: str | None = None) -> bool:
        result = self._connection.execute(
            """
            UPDATE account_switches
            SET status = 'cancelled', finalized_at = ?
            WHERE id = ? AND status = 'prepared'
            """,
            (cancelled_at or iso_timestamp(self._now()), switch_id),
        )
        return result.rowcount > 0

    def reconcile_prepared_switches(
        self,
        *,
        provider: str,
        observed_account_id: str | None,
        observed_at: str,
    ) -> dict[str, list[int]]:
        rows = self._connection.execute(
            """
            SELECT id, to_account_id FROM account_switches
            WHERE provider = ? AND status = 'prepared'
            ORDER BY id
            """,
            (provider,),
        ).fetchall()
        finalized: list[int] = []
        cancelled: list[int] = []
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            for row in rows:
                switch_id = int(row["id"])
                if row["to_account_id"] == observed_account_id:
                    self._connection.execute(
                        "UPDATE account_switches SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'prepared'",
                        (observed_at, switch_id),
                    )
                    finalized.append(switch_id)
                else:
                    self._connection.execute(
                        "UPDATE account_switches SET status = 'cancelled', finalized_at = ? WHERE id = ? AND status = 'prepared'",
                        (observed_at, switch_id),
                    )
                    cancelled.append(switch_id)
            self._connection.execute("COMMIT")
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        return {"finalized": finalized, "cancelled": cancelled}

    def switches_for_range(self, provider: str, start: str, end: str) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """
            SELECT id, provider, prepared_at, from_account_id, to_account_id, finalized_at
            FROM account_switches
            WHERE provider = ? AND status = 'finalized'
              AND prepared_at >= ? AND prepared_at < ?
            ORDER BY prepared_at, id
            """,
            (provider, start, end),
        ).fetchall()
        return [dict(row) for row in rows]
