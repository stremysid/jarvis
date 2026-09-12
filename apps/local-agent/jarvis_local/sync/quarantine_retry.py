"""Durable owner-command receipts, separate from cloud projection receipts.

Only enqueue uses a second connection, opened and closed on the control thread.
It writes command metadata, never facts. SQLite serializes that short write with
the cycle's transactions. The existing cycle connection atomically clears a
quarantine and records its outcome, so a restart cannot lose the answer.
"""

from __future__ import annotations

import contextlib
import sqlite3
from collections.abc import Callable
from pathlib import Path

RETRY_HISTORY_LIMIT = 20
RETRY_LOCK_TIMEOUT_SECONDS = 0.1


class QuarantineRetryJournal:
    def __init__(self, connection: sqlite3.Connection, path: Path, owner: tuple[str, str, str]) -> None:
        self.connection = connection
        self.path = path
        self.owner = owner

    def enqueue(self, fact_id: str) -> int:
        # mode=rw cannot invent an unmigrated store if the configured file
        # disappeared. Set the lock timeout at connect, before any SQL executes.
        with contextlib.closing(sqlite3.connect(
            self.path.resolve().as_uri() + "?mode=rw", uri=True,
            isolation_level=None, timeout=RETRY_LOCK_TIMEOUT_SECONDS,
        )) as connection:
            connection.execute("PRAGMA synchronous = FULL")
            rows = connection.execute(
                """INSERT INTO memory_projection_retry (gateway_origin, principal_id, device_id, fact_id)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (gateway_origin, principal_id, device_id, fact_id) WHERE outcome = 'queued'
                   DO UPDATE SET fact_id = excluded.fact_id RETURNING retry_id""",
                (*self.owner, fact_id),
            ).fetchall()
            return int(rows[0][0])

    def records(self) -> list[tuple[int, str, str]]:
        pending = self.connection.execute(
            """SELECT retry_id, fact_id, outcome FROM memory_projection_retry
               WHERE gateway_origin = ? AND principal_id = ? AND device_id = ? AND outcome = 'queued'""",
            self.owner,
        ).fetchall()
        recent = self.connection.execute(
            """SELECT retry_id, fact_id, outcome FROM memory_projection_retry
                WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
                AND outcome <> 'queued' ORDER BY completed_order DESC LIMIT ?""",
            (*self.owner, RETRY_HISTORY_LIMIT),
        ).fetchall()
        return [(int(row[0]), str(row[1]), str(row[2])) for row in list(reversed(recent)) + pending]

    def _finish(self, retry_id: int, outcome: str) -> None:
        changed = self.connection.execute(
            """UPDATE memory_projection_retry SET outcome = ?,
               completed_order = (SELECT COALESCE(MAX(completed_order), 0) + 1 FROM memory_projection_retry)
               WHERE retry_id = ?
               AND gateway_origin = ? AND principal_id = ? AND device_id = ? AND outcome = 'queued'""",
            (outcome, retry_id, *self.owner),
        )
        if changed.rowcount != 1:
            raise RuntimeError("the retry command is no longer pending")
        self.connection.execute(
            """DELETE FROM memory_projection_retry
                WHERE gateway_origin = ? AND principal_id = ? AND device_id = ? AND outcome <> 'queued'
                AND retry_id NOT IN (SELECT retry_id FROM memory_projection_retry
                    WHERE gateway_origin = ? AND principal_id = ? AND device_id = ?
                    AND outcome <> 'queued' ORDER BY completed_order DESC LIMIT ?)""",
            (*self.owner, *self.owner, RETRY_HISTORY_LIMIT),
        )

    def _transaction(self, action: Callable[[], bool]) -> bool:
        if self.connection.in_transaction:
            raise RuntimeError("retry work requires a cycle transaction boundary")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            result = action()
            self.connection.execute("COMMIT")
            return result
        except BaseException:
            self._rollback()
            raise

    def _rollback(self) -> None:
        # A method prevents mypy carrying the pre-BEGIN false value into the
        # exception handler as though SQLite never changed the connection.
        if self.connection.in_transaction:
            self.connection.execute("ROLLBACK")

    def apply(self, retry_id: int, fact_id: str, retry: Callable[[str], bool]) -> bool:
        def action() -> bool:
            binding = self.connection.execute(
                """SELECT fact_id FROM memory_projection_retry WHERE retry_id = ?
                   AND gateway_origin = ? AND principal_id = ? AND device_id = ? AND outcome = 'queued'""",
                (retry_id, *self.owner),
            ).fetchone()
            if binding != (fact_id,):
                raise RuntimeError("the retry command binding changed")
            deleted = retry(fact_id)
            self._finish(retry_id, "applied" if deleted else "not_quarantined")
            return deleted

        return self._transaction(action)

    def finish(self, retry_id: int, outcome: str) -> None:
        def action() -> bool:
            self._finish(retry_id, outcome)
            return False

        self._transaction(action)
