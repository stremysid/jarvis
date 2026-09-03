"""An observation and its head move together, or neither moves.

The stale-head test is the one that matters most. A head that accepted any
arriving observation would not be a head -- a replayed slice or a second
crawler would silently overwrite the current version with an older one.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jarvis_local.archive.content_store import canonical_content_hash
from jarvis_local.vault.identifiers import new_ulid
from jarvis_local.vault.models import VaultNoteOperationV1, observed, tombstoned
from jarvis_local.vault.repository import (
    VaultBinding,
    VaultBindingConflictError,
    VaultDocumentHead,
    VaultHeadConflictError,
    VaultNotBoundError,
    VaultRepository,
)
from jarvis_local.vault.schema import REQUIRED_VAULT_TRIGGERS, VaultGuardError, assert_vault_guards
from tests.vault.conftest import PRINCIPAL, VAULT_ID

WHEN = "2026-09-03T00:00:00.000Z"
DOCUMENT = "01k5d8s0m00000000000000002"


def add_document(repository: VaultRepository, document_id: str = DOCUMENT) -> None:
    repository.upsert_document(
        vault_id=VAULT_ID,
        document_id=document_id,
        relative_path="notes/coffee.md",
        display_label="Coffee",
        now=WHEN,
    )


def append(repository: VaultRepository, text: str, version: int, head: VaultDocumentHead | None) -> VaultDocumentHead:
    return repository.append_observation(
        observed(
            observation_id=new_ulid(),
            vault_id=VAULT_ID,
            document_id=DOCUMENT,
            document_version=version,
            text=text,
            observed_at=WHEN,
            display_label="Coffee",
            previous_observation_id=None if head is None else head.observation_id,
            previous_content_hash=None if head is None else head.content_hash,
        ),
        now=WHEN,
    )


def test_the_vault_schema_uses_its_own_ledger_so_the_archive_does_not_shadow_it(tmp_path: Path) -> None:
    """Both schemas have a migration numbered 3 and both must actually apply.

    Sharing `schema_migration` would make the vault migration look already
    applied, and the vault tables would silently not exist.
    """
    repository = VaultRepository.open(tmp_path / "archive.sqlite3")
    try:
        archive_versions = {
            row[0] for row in repository.connection.execute("SELECT version FROM schema_migration")
        }
        vault_versions = {
            row[0] for row in repository.connection.execute("SELECT version FROM vault_schema_migration")
        }
        assert 3 in archive_versions
        assert vault_versions == {3}
        assert repository.connection.execute("SELECT COUNT(*) FROM vault_observation").fetchone()[0] == 0
    finally:
        repository.close()


def test_every_declared_guard_is_actually_installed(repository: VaultRepository) -> None:
    from jarvis_local.vault.schema import installed_triggers

    assert installed_triggers(repository.connection) >= REQUIRED_VAULT_TRIGGERS


def test_opening_a_vault_whose_guards_are_missing_is_refused(repository: VaultRepository) -> None:
    """The check is real: drop one trigger and the assertion fires.

    Without this, `assert_vault_guards` could be asserting a set it builds from
    the database it is checking, and would pass on an unprotected file.
    """
    repository.connection.execute("DROP TRIGGER vault_observation_no_delete")
    with pytest.raises(VaultGuardError, match="vault_observation_no_delete"):
        assert_vault_guards(repository.connection)


def test_an_observation_cannot_be_updated_or_deleted(repository: VaultRepository, binding: VaultBinding) -> None:
    add_document(repository)
    head = append(repository, "v1", 1, None)

    with pytest.raises(sqlite3.IntegrityError, match="vault_immutable_violation"):
        repository.connection.execute(
            "UPDATE vault_observation SET canonical_text = 'tampered' WHERE observation_id = ?",
            (head.observation_id,),
        )
    with pytest.raises(sqlite3.IntegrityError, match="vault_immutable_violation"):
        repository.connection.execute(
            "DELETE FROM vault_observation WHERE observation_id = ?", (head.observation_id,)
        )
    assert repository.count_observations() == 1


def test_appending_moves_the_head_in_the_same_transaction(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    add_document(repository)
    first = append(repository, "v1", 1, None)
    second = append(repository, "v2", 2, first)

    assert second.document_version == 2
    assert second.content_hash == canonical_content_hash("v2")
    assert repository.count_observations() == 2
    assert [o.document_version for o in repository.observations_for(DOCUMENT)] == [1, 2]


def test_a_failure_while_moving_the_head_leaves_no_observation(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """The transaction is real, not two writes that usually both succeed.

    The fault is injected inside SQLite by a temporary trigger rather than by
    patching the repository, so the code under test runs exactly as it ships.
    The observation insert has already succeeded when the head insert aborts,
    so if these were separate commitments the archive would keep a version
    nothing points at.
    """
    add_document(repository)
    repository.connection.execute(
        "CREATE TEMP TRIGGER simulated_head_crash BEFORE INSERT ON vault_document_head "
        "BEGIN SELECT RAISE(ABORT, 'simulated_crash_between_the_two_writes'); END"
    )
    try:
        with pytest.raises(sqlite3.IntegrityError, match="simulated_crash_between_the_two_writes"):
            append(repository, "v1", 1, None)
    finally:
        repository.connection.execute("DROP TRIGGER temp.simulated_head_crash")

    assert repository.count_observations() == 0
    assert repository.current_head(DOCUMENT) is None
    # And the rollback did not leave the connection wedged: the same append
    # succeeds once the fault is removed.
    assert append(repository, "v1", 1, None).document_version == 1


def test_an_observation_against_a_stale_head_is_refused(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """Two crawlers race; the loser is refused rather than applied."""
    add_document(repository)
    first = append(repository, "v1", 1, None)
    append(repository, "v2", 2, first)

    # Built against v1, which is no longer the head.
    with pytest.raises(VaultHeadConflictError, match="head that has moved"):
        append(repository, "v2-from-a-stale-reader", 2, first)

    head = repository.current_head(DOCUMENT)
    assert head is not None
    assert head.content_hash == canonical_content_hash("v2")
    assert repository.count_observations() == 2


def test_a_first_observation_claiming_a_predecessor_is_refused(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """No head means the observation must claim no predecessor."""
    add_document(repository)
    with pytest.raises(VaultHeadConflictError):
        repository.append_observation(
            observed(
                observation_id=new_ulid(),
                vault_id=VAULT_ID,
                document_id=DOCUMENT,
                document_version=1,
                text="v1",
                observed_at=WHEN,
                display_label="Coffee",
                previous_content_hash=canonical_content_hash("invented"),
            )
        )
    assert repository.count_observations() == 0


def test_a_head_cannot_be_rewound_even_by_a_direct_write(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    add_document(repository)
    first = append(repository, "v1", 1, None)
    append(repository, "v2", 2, first)

    with pytest.raises(sqlite3.IntegrityError, match="vault_head_rewind"):
        repository.connection.execute(
            "UPDATE vault_document_head SET document_version = 1 WHERE document_id = ?", (DOCUMENT,)
        )


def test_a_tombstone_becomes_the_head_without_removing_any_history(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    add_document(repository)
    first = append(repository, "v1", 1, None)
    repository.append_observation(
        tombstoned(
            observation_id=new_ulid(),
            vault_id=VAULT_ID,
            document_id=DOCUMENT,
            document_version=2,
            observed_at=WHEN,
            display_label="Coffee",
            previous_observation_id=first.observation_id,
            previous_content_hash=first.content_hash,
        )
    )

    head = repository.current_head(DOCUMENT)
    assert head is not None
    assert head.operation is VaultNoteOperationV1.TOMBSTONED
    # The text that was there is still readable, which is the point.
    assert repository.observations_for(DOCUMENT)[0].canonical_text == "v1"


def test_a_second_root_for_the_same_principal_is_refused(repository: VaultRepository, tmp_path: Path) -> None:
    repository.record_binding(
        VaultBinding(vault_id=VAULT_ID, principal_id=PRINCIPAL, root_path=str(tmp_path / "one"))
    )
    with pytest.raises(VaultBindingConflictError):
        repository.record_binding(
            VaultBinding(
                vault_id="01k5d8s0m0000000000000000a", principal_id=PRINCIPAL, root_path=str(tmp_path / "two")
            )
        )


def test_rebinding_the_same_root_is_a_no_op(repository: VaultRepository, tmp_path: Path) -> None:
    original = repository.record_binding(
        VaultBinding(vault_id=VAULT_ID, principal_id=PRINCIPAL, root_path=str(tmp_path / "one"))
    )
    again = repository.record_binding(
        VaultBinding(vault_id=VAULT_ID, principal_id=PRINCIPAL, root_path=str(tmp_path / "one"))
    )
    assert again.bound_at == original.bound_at


def test_requiring_a_binding_that_does_not_exist_raises(repository: VaultRepository) -> None:
    with pytest.raises(VaultNotBoundError):
        repository.require_binding(PRINCIPAL)


def test_a_documents_location_can_never_be_moved(repository: VaultRepository, binding: VaultBinding) -> None:
    """The document id is derived from the path, so the path is its identity."""
    add_document(repository)
    with pytest.raises(sqlite3.IntegrityError, match="vault_immutable_violation"):
        repository.connection.execute(
            "UPDATE vault_document SET relative_path = 'notes/moved.md' WHERE document_id = ?", (DOCUMENT,)
        )
    # A retitled note is a legitimate update and is allowed.
    repository.upsert_document(
        vault_id=VAULT_ID,
        document_id=DOCUMENT,
        relative_path="notes/coffee.md",
        display_label="Coffee, revisited",
        now=WHEN,
    )
    document = repository.document(DOCUMENT)
    assert document is not None
    assert document.display_label == "Coffee, revisited"


def test_the_relative_path_is_reachable_only_through_the_conspicuously_named_method(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """`document()` returns no path; `document_location()` is the only door."""
    add_document(repository)
    document = repository.document(DOCUMENT)
    assert document is not None
    assert "coffee.md" not in str(document)
    assert repository.document_location(DOCUMENT) == "notes/coffee.md"
