"""Vault state on the archive database.

The single method that matters is `append_observation`. It writes the
immutable observation and moves the document head inside one transaction,
because the two are one fact and a crash between them is not recoverable by
re-running: a head pointing at a missing observation fails every read, and an
observation nothing points at is a version that silently never became current.

The other load-bearing rule is what makes a head a head. An observation
declares the content hash it believes is current; if that is not what the head
holds, the observation is refused rather than applied. Without that, "current"
would only ever mean "written most recently", and two crawls racing -- or one
replaying an old slice -- would resurrect text the owner has already replaced.

Relative paths live here and only here. `document_location` is named to be
conspicuous at the call site: it is the one method that hands back something
that must not be logged, uploaded, or put in a diagnostic.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from jarvis_local.archive.database import ArchiveDatabase
from jarvis_local.clock import utc_now_iso
from jarvis_local.vault.models import (
    RedactionV1,
    SensitivityV1,
    VaultNoteLocalObservationV1,
    VaultNoteOperationV1,
    VaultNoteOriginV1,
    redaction_from_row,
)
from jarvis_local.vault.schema import open_vault_schema


class VaultHeadConflictError(RuntimeError):
    """An observation was built against a head that has since moved."""


class VaultBindingConflictError(RuntimeError):
    """This principal is already bound to a different vault root."""


class VaultNotBoundError(RuntimeError):
    """An operation needs a bound vault and there is not one."""


@dataclass(frozen=True, slots=True)
class VaultBinding:
    """The owned root. `root_path` is local-only and never leaves the machine."""

    vault_id: str
    principal_id: str
    root_path: str
    volume_serial: int | None = None
    root_file_id: str | None = None
    bound_at: str = ""

    @property
    def root(self) -> Path:
        return Path(self.root_path)


@dataclass(frozen=True, slots=True)
class VaultDocumentHead:
    document_id: str
    observation_id: str
    document_version: int
    content_hash: str
    operation: VaultNoteOperationV1


@dataclass(frozen=True, slots=True)
class VaultDocument:
    document_id: str
    vault_id: str
    display_label: str


@dataclass(frozen=True, slots=True)
class ProjectionOperation:
    operation_id: str
    vault_id: str
    intended_directory: str
    intended_name: str
    content_hash: str
    content_bytes: int
    prepared_at: str


@dataclass(frozen=True, slots=True)
class ProjectionReceipt:
    receipt_id: str
    operation_id: str
    final_name: str
    content_hash: str
    disposition: str
    committed_at: str


class VaultRepository:
    """Vault reads and writes, sharing the archive's connection and transactions."""

    def __init__(self, database: ArchiveDatabase, *, now: str | None = None) -> None:
        self._database = open_vault_schema(database, now=now or utc_now_iso())

    @classmethod
    def open(
        cls,
        path: Path,
        *,
        now: str | None = None,
        store_root: Path | None = None,
        repair_permissions: bool = True,
    ) -> VaultRepository:
        moment = now or utc_now_iso()
        return cls(
            ArchiveDatabase.open(
                Path(path), now=moment, store_root=store_root, repair_permissions=repair_permissions
            ),
            now=moment,
        )

    @property
    def connection(self) -> sqlite3.Connection:
        return self._database.connection

    @property
    def database(self) -> ArchiveDatabase:
        return self._database

    def close(self) -> None:
        self._database.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        self.connection.execute("BEGIN")
        try:
            yield self.connection
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise
        self.connection.execute("COMMIT")

    # -- binding ----------------------------------------------------------

    def record_binding(self, binding: VaultBinding, *, now: str | None = None) -> VaultBinding:
        """Bind this principal to one root, or confirm the binding it has.

        Re-binding is refused rather than supported. Stage one has no way to
        migrate document identities from one root to another, so silently
        accepting a new root would leave every existing head pointing at notes
        that no longer exist while new observations accumulate beside them.
        """
        existing = self.binding_for(binding.principal_id)
        if existing is not None:
            if existing.root_path != binding.root_path or existing.vault_id != binding.vault_id:
                raise VaultBindingConflictError("this principal is already bound to a different vault root")
            return existing
        bound_at = now or utc_now_iso()
        self.connection.execute(
            """
            INSERT INTO vault_binding (vault_id, principal_id, root_path, volume_serial, root_file_id, bound_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                binding.vault_id,
                binding.principal_id,
                binding.root_path,
                binding.volume_serial,
                binding.root_file_id,
                bound_at,
            ),
        )
        return VaultBinding(
            vault_id=binding.vault_id,
            principal_id=binding.principal_id,
            root_path=binding.root_path,
            volume_serial=binding.volume_serial,
            root_file_id=binding.root_file_id,
            bound_at=bound_at,
        )

    def binding_for(self, principal_id: str) -> VaultBinding | None:
        row = self.connection.execute(
            """
            SELECT vault_id, principal_id, root_path, volume_serial, root_file_id, bound_at
            FROM vault_binding WHERE principal_id = ?
            """,
            (principal_id,),
        ).fetchone()
        if row is None:
            return None
        return VaultBinding(
            vault_id=row[0],
            principal_id=row[1],
            root_path=row[2],
            volume_serial=row[3],
            root_file_id=row[4],
            bound_at=row[5],
        )

    def require_binding(self, principal_id: str) -> VaultBinding:
        binding = self.binding_for(principal_id)
        if binding is None:
            raise VaultNotBoundError("no vault is bound for this principal")
        return binding

    # -- documents --------------------------------------------------------

    def upsert_document(
        self,
        *,
        vault_id: str,
        document_id: str,
        relative_path: str,
        display_label: str,
        now: str | None = None,
    ) -> None:
        """Record the note's existence, or refresh only its label."""
        existing = self.connection.execute(
            "SELECT relative_path, display_label FROM vault_document WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        if existing is None:
            self.connection.execute(
                """
                INSERT INTO vault_document (document_id, vault_id, relative_path, display_label, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (document_id, vault_id, relative_path, display_label, now or utc_now_iso()),
            )
            return
        if existing[1] != display_label:
            self.connection.execute(
                "UPDATE vault_document SET display_label = ? WHERE document_id = ?",
                (display_label, document_id),
            )

    def document(self, document_id: str) -> VaultDocument | None:
        row = self.connection.execute(
            "SELECT document_id, vault_id, display_label FROM vault_document WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        return None if row is None else VaultDocument(row[0], row[1], row[2])

    def document_location(self, document_id: str) -> str | None:
        """The note's path relative to the root. Local use only -- never a payload."""
        row = self.connection.execute(
            "SELECT relative_path FROM vault_document WHERE document_id = ?", (document_id,)
        ).fetchone()
        return None if row is None else str(row[0])

    def document_ids(self, vault_id: str) -> tuple[str, ...]:
        rows = self.connection.execute(
            "SELECT document_id FROM vault_document WHERE vault_id = ? ORDER BY document_id ASC",
            (vault_id,),
        ).fetchall()
        return tuple(str(row[0]) for row in rows)

    # -- observations -----------------------------------------------------

    def append_observation(
        self,
        observation: VaultNoteLocalObservationV1,
        *,
        now: str | None = None,
    ) -> VaultDocumentHead:
        """Append the observation and move the head, together or not at all.

        The predecessor check happens inside the transaction, so a second
        writer that commits between a caller reading the head and calling this
        cannot have its version overwritten: the second append is refused.
        """
        with self._transaction() as connection:
            head = self.current_head(observation.document_id)
            expected = None if head is None else head.content_hash
            if observation.previous_content_hash != expected:
                raise VaultHeadConflictError(
                    "observation was built against a head that has moved; refusing to apply it"
                )
            if head is not None and observation.document_version <= head.document_version:
                raise VaultHeadConflictError("observation version is not ahead of the current head")

            connection.execute(
                """
                INSERT INTO vault_observation (
                    observation_id, vault_id, document_id, document_version, operation,
                    previous_observation_id, previous_content_hash, derived_from_observation_id,
                    canonical_text, canonical_content_hash, observed_at, sensitivity,
                    redaction_status, redaction_markers, origin,
                    projection_operation_id, projection_receipt_id, display_label
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    observation.observation_id,
                    observation.vault_id,
                    observation.document_id,
                    observation.document_version,
                    str(observation.operation),
                    observation.previous_observation_id,
                    observation.previous_content_hash,
                    observation.derived_from_observation_id,
                    observation.canonical_text,
                    observation.canonical_content_hash,
                    observation.observed_at,
                    str(observation.sensitivity),
                    str(observation.redaction.status),
                    json.dumps(list(observation.redaction.markers), separators=(",", ":")),
                    str(observation.origin),
                    observation.projection_operation_id,
                    observation.projection_receipt_id,
                    observation.display_label,
                ),
            )
            updated_at = now or utc_now_iso()
            if head is None:
                connection.execute(
                    """
                    INSERT INTO vault_document_head (
                        document_id, observation_id, document_version, content_hash, operation, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        observation.document_id,
                        observation.observation_id,
                        observation.document_version,
                        observation.canonical_content_hash,
                        str(observation.operation),
                        updated_at,
                    ),
                )
            else:
                connection.execute(
                    """
                    UPDATE vault_document_head
                    SET observation_id = ?, document_version = ?, content_hash = ?,
                        operation = ?, updated_at = ?
                    WHERE document_id = ? AND document_version = ?
                    """,
                    (
                        observation.observation_id,
                        observation.document_version,
                        observation.canonical_content_hash,
                        str(observation.operation),
                        updated_at,
                        observation.document_id,
                        head.document_version,
                    ),
                )
        moved = self.current_head(observation.document_id)
        if moved is None:  # pragma: no cover - the transaction above committed one
            raise VaultHeadConflictError("head did not move despite a committed observation")
        return moved

    def current_head(self, document_id: str) -> VaultDocumentHead | None:
        row = self.connection.execute(
            """
            SELECT document_id, observation_id, document_version, content_hash, operation
            FROM vault_document_head WHERE document_id = ?
            """,
            (document_id,),
        ).fetchone()
        if row is None:
            return None
        return VaultDocumentHead(row[0], row[1], int(row[2]), row[3], VaultNoteOperationV1(row[4]))

    def current_heads(self, vault_id: str) -> tuple[VaultDocumentHead, ...]:
        rows = self.connection.execute(
            """
            SELECT head.document_id, head.observation_id, head.document_version,
                   head.content_hash, head.operation
            FROM vault_document_head AS head
            JOIN vault_document AS document ON document.document_id = head.document_id
            WHERE document.vault_id = ?
            ORDER BY head.document_id ASC
            """,
            (vault_id,),
        ).fetchall()
        return tuple(
            VaultDocumentHead(row[0], row[1], int(row[2]), row[3], VaultNoteOperationV1(row[4])) for row in rows
        )

    def observation(self, observation_id: str) -> VaultNoteLocalObservationV1 | None:
        row = self.connection.execute(
            """
            SELECT observation_id, vault_id, document_id, document_version, operation,
                   previous_observation_id, previous_content_hash, derived_from_observation_id,
                   canonical_text, canonical_content_hash, observed_at, sensitivity,
                   redaction_status, redaction_markers, origin,
                   projection_operation_id, projection_receipt_id, display_label
            FROM vault_observation WHERE observation_id = ?
            """,
            (observation_id,),
        ).fetchone()
        return None if row is None else _observation_from_row(row)

    def observations_for(self, document_id: str) -> tuple[VaultNoteLocalObservationV1, ...]:
        rows = self.connection.execute(
            """
            SELECT observation_id, vault_id, document_id, document_version, operation,
                   previous_observation_id, previous_content_hash, derived_from_observation_id,
                   canonical_text, canonical_content_hash, observed_at, sensitivity,
                   redaction_status, redaction_markers, origin,
                   projection_operation_id, projection_receipt_id, display_label
            FROM vault_observation WHERE document_id = ? ORDER BY document_version ASC
            """,
            (document_id,),
        ).fetchall()
        return tuple(_observation_from_row(row) for row in rows)

    def count_observations(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM vault_observation").fetchone()[0])

    # -- projection journal -----------------------------------------------

    def prepare_projection(self, operation: ProjectionOperation) -> ProjectionOperation:
        self.connection.execute(
            """
            INSERT INTO vault_projection_operation (
                operation_id, vault_id, intended_directory, intended_name,
                content_hash, content_bytes, prepared_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                operation.operation_id,
                operation.vault_id,
                operation.intended_directory,
                operation.intended_name,
                operation.content_hash,
                operation.content_bytes,
                operation.prepared_at,
            ),
        )
        return operation

    def record_projection_receipt(self, receipt: ProjectionReceipt) -> ProjectionReceipt:
        self.connection.execute(
            """
            INSERT INTO vault_projection_receipt (
                receipt_id, operation_id, final_name, content_hash, disposition, committed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                receipt.receipt_id,
                receipt.operation_id,
                receipt.final_name,
                receipt.content_hash,
                receipt.disposition,
                receipt.committed_at,
            ),
        )
        return receipt

    def record_projection_abandonment(self, operation_id: str, code: str, *, now: str | None = None) -> None:
        self.connection.execute(
            "INSERT INTO vault_projection_abandonment (operation_id, code, recorded_at) VALUES (?, ?, ?)",
            (operation_id, code, now or utc_now_iso()),
        )

    def projection_operation(self, operation_id: str) -> ProjectionOperation | None:
        row = self.connection.execute(
            """
            SELECT operation_id, vault_id, intended_directory, intended_name,
                   content_hash, content_bytes, prepared_at
            FROM vault_projection_operation WHERE operation_id = ?
            """,
            (operation_id,),
        ).fetchone()
        if row is None:
            return None
        return ProjectionOperation(row[0], row[1], row[2], row[3], row[4], int(row[5]), row[6])

    def receipt_for(self, operation_id: str) -> ProjectionReceipt | None:
        row = self.connection.execute(
            """
            SELECT receipt_id, operation_id, final_name, content_hash, disposition, committed_at
            FROM vault_projection_receipt WHERE operation_id = ?
            """,
            (operation_id,),
        ).fetchone()
        if row is None:
            return None
        return ProjectionReceipt(row[0], row[1], row[2], row[3], row[4], row[5])

    def unfinished_projections(self, vault_id: str) -> tuple[ProjectionOperation, ...]:
        """Prepared operations with neither a receipt nor an abandonment.

        This is what makes a crashed projection recognisable: the journal row
        is durable before the file is created, so anything left in this set on
        restart is a write that may or may not have landed.
        """
        rows = self.connection.execute(
            """
            SELECT operation.operation_id, operation.vault_id, operation.intended_directory,
                   operation.intended_name, operation.content_hash, operation.content_bytes,
                   operation.prepared_at
            FROM vault_projection_operation AS operation
            LEFT JOIN vault_projection_receipt AS receipt
                   ON receipt.operation_id = operation.operation_id
            LEFT JOIN vault_projection_abandonment AS abandonment
                   ON abandonment.operation_id = operation.operation_id
            WHERE operation.vault_id = ?
              AND receipt.operation_id IS NULL
              AND abandonment.operation_id IS NULL
            ORDER BY operation.prepared_at ASC, operation.operation_id ASC
            """,
            (vault_id,),
        ).fetchall()
        return tuple(
            ProjectionOperation(row[0], row[1], row[2], row[3], row[4], int(row[5]), row[6]) for row in rows
        )


def _observation_from_row(row: tuple[object, ...]) -> VaultNoteLocalObservationV1:
    markers = json.loads(str(row[13]))
    redaction: RedactionV1 = redaction_from_row(str(row[12]), markers)
    return VaultNoteLocalObservationV1(
        observation_id=str(row[0]),
        vault_id=str(row[1]),
        document_id=str(row[2]),
        document_version=int(str(row[3])),
        operation=VaultNoteOperationV1(str(row[4])),
        previous_observation_id=None if row[5] is None else str(row[5]),
        previous_content_hash=None if row[6] is None else str(row[6]),
        derived_from_observation_id=None if row[7] is None else str(row[7]),
        canonical_text=str(row[8]),
        canonical_content_hash=str(row[9]),
        observed_at=str(row[10]),
        sensitivity=SensitivityV1(str(row[11])),
        redaction=redaction,
        origin=VaultNoteOriginV1(str(row[14])),
        projection_operation_id=None if row[15] is None else str(row[15]),
        projection_receipt_id=None if row[16] is None else str(row[16]),
        display_label=str(row[17]),
    )
