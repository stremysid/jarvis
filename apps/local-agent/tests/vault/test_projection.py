"""Publishing must be incapable of destroying the owner's writing.

The overwrite test is the one this module exists for. `O_EXCL` is what makes
it a property rather than a habit: the file it protects has no other copy.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis_local.archive.content_store import canonical_content_hash
from jarvis_local.vault.identifiers import new_ulid
from jarvis_local.vault.paths import UnsafePathComponentError
from jarvis_local.vault.projection import (
    ABANDONED,
    ProjectionRequest,
    VaultProjectionError,
    VaultProjector,
)
from jarvis_local.vault.repository import ProjectionOperation, VaultBinding, VaultRepository
from tests.vault.conftest import make_reparse_point

WHEN = "2026-09-03T00:00:00.000Z"


def a_request(name: str = "fact-01", content: str = "generated body") -> ProjectionRequest:
    return ProjectionRequest(base_name=name, content=content, directory_parts=("90 Jarvis",))


def test_a_projection_creates_a_new_file_and_records_a_receipt(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    projector = VaultProjector(repository, binding, now=WHEN)

    published = projector.project(a_request())

    assert published.final_name == "fact-01.md"
    assert not published.collided
    assert (vault_root / "90 Jarvis" / "fact-01.md").read_text(encoding="utf-8") == "generated body"
    receipt = repository.receipt_for(published.operation_id)
    assert receipt is not None
    assert receipt.disposition == "published"


def test_projection_refuses_to_overwrite_an_existing_file(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """The owner's bytes survive, unchanged, and a different name is used."""
    destination = vault_root / "90 Jarvis"
    destination.mkdir(parents=True)
    (destination / "fact-01.md").write_text("the owner wrote this", encoding="utf-8")

    published = VaultProjector(repository, binding, now=WHEN).project(a_request())

    assert (destination / "fact-01.md").read_text(encoding="utf-8") == "the owner wrote this"
    assert published.final_name != "fact-01.md"
    assert published.collided


def test_a_name_collision_produces_a_different_name(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    projector = VaultProjector(repository, binding, now=WHEN)

    first = projector.project(a_request(content="one"))
    second = projector.project(a_request(content="two"))
    third = projector.project(a_request(content="three"))

    assert [first.final_name, second.final_name, third.final_name] == [
        "fact-01.md",
        "fact-01 (2).md",
        "fact-01 (3).md",
    ]
    destination = vault_root / "90 Jarvis"
    assert (destination / "fact-01.md").read_text(encoding="utf-8") == "one"
    assert (destination / "fact-01 (2).md").read_text(encoding="utf-8") == "two"


def test_the_module_never_replaces_renames_moves_or_deletes(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """Read as an AST, because the rule is about what the code can do at all.

    A behavioural test can only show that the calls it happens to make do not
    destroy anything. This shows the destructive calls are not in the module
    at all, so no untested path can reach one.

    Parsed rather than grepped: this module's own docstring names every
    forbidden call while explaining why it is absent, and a text search would
    read that prose as the thing it forbids.
    """
    import ast

    from jarvis_local.vault import projection

    tree = ast.parse(Path(projection.__file__).read_text(encoding="utf-8"))
    called: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            called.add(node.attr)
        elif isinstance(node, ast.Name):
            called.add(node.id)

    forbidden = {"replace", "rename", "remove", "unlink", "rmdir", "rmtree", "move", "copyfile", "truncate"}
    assert called & forbidden == set()
    # And the mechanism that makes create-new atomic is present, so this test
    # cannot pass by the module having no write at all.
    assert "O_EXCL" in called
    assert "O_CREAT" in called


def test_a_crashed_projection_is_recognised_on_restart_and_not_repeated(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """Journal row durable, file created, process dies before the receipt.

    Reconstructed exactly: the operation row and the file exist, the receipt
    does not. Recovery must close it with one receipt and leave one file.
    """
    destination = vault_root / "90 Jarvis"
    destination.mkdir(parents=True)
    (destination / "fact-01.md").write_text("generated body", encoding="utf-8")
    operation = repository.prepare_projection(
        ProjectionOperation(
            operation_id=new_ulid(),
            vault_id=binding.vault_id,
            intended_directory="90 Jarvis",
            intended_name="fact-01.md",
            content_hash=canonical_content_hash("generated body"),
            content_bytes=len(b"generated body"),
            prepared_at=WHEN,
        )
    )
    assert repository.receipt_for(operation.operation_id) is None

    recovered = VaultProjector(repository, binding, now=WHEN).recover()

    assert [(item.operation_id, item.disposition) for item in recovered] == [
        (operation.operation_id, "recovered")
    ]
    receipt = repository.receipt_for(operation.operation_id)
    assert receipt is not None
    assert receipt.final_name == "fact-01.md"
    assert sorted(path.name for path in destination.iterdir()) == ["fact-01.md"]


def test_recovery_is_idempotent(repository: VaultRepository, binding: VaultBinding, vault_root: Path) -> None:
    """A second restart must not publish a second copy or a second receipt."""
    projector = VaultProjector(repository, binding, now=WHEN)
    destination = vault_root / "90 Jarvis"
    destination.mkdir(parents=True)
    (destination / "fact-01.md").write_text("generated body", encoding="utf-8")
    repository.prepare_projection(
        ProjectionOperation(
            operation_id=new_ulid(),
            vault_id=binding.vault_id,
            intended_directory="90 Jarvis",
            intended_name="fact-01.md",
            content_hash=canonical_content_hash("generated body"),
            content_bytes=14,
            prepared_at=WHEN,
        )
    )

    assert len(projector.recover()) == 1
    assert projector.recover() == ()
    assert sorted(path.name for path in destination.iterdir()) == ["fact-01.md"]


def test_a_projection_whose_file_never_landed_is_recorded_as_abandoned(
    repository: VaultRepository, binding: VaultBinding
) -> None:
    """Recognised, not retried.

    Republishing would risk a second copy of something the owner may already
    have edited, so the journal records that the attempt ended and stops.
    """
    operation = repository.prepare_projection(
        ProjectionOperation(
            operation_id=new_ulid(),
            vault_id=binding.vault_id,
            intended_directory="90 Jarvis",
            intended_name="fact-01.md",
            content_hash=canonical_content_hash("never written"),
            content_bytes=13,
            prepared_at=WHEN,
        )
    )

    recovered = VaultProjector(repository, binding, now=WHEN).recover()

    assert [(item.operation_id, item.disposition) for item in recovered] == [
        (operation.operation_id, ABANDONED)
    ]
    assert repository.receipt_for(operation.operation_id) is None
    assert repository.unfinished_projections(binding.vault_id) == ()


def test_a_file_the_owner_edited_after_the_crash_is_not_claimed(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """Recovery matches on content, so an edited file is not this operation's."""
    destination = vault_root / "90 Jarvis"
    destination.mkdir(parents=True)
    (destination / "fact-01.md").write_text("generated body, then the owner edited it", encoding="utf-8")
    repository.prepare_projection(
        ProjectionOperation(
            operation_id=new_ulid(),
            vault_id=binding.vault_id,
            intended_directory="90 Jarvis",
            intended_name="fact-01.md",
            content_hash=canonical_content_hash("generated body"),
            content_bytes=14,
            prepared_at=WHEN,
        )
    )

    (recovered,) = VaultProjector(repository, binding, now=WHEN).recover()

    assert recovered.disposition == ABANDONED
    assert (destination / "fact-01.md").read_text(encoding="utf-8") == (
        "generated body, then the owner edited it"
    )


def test_the_journal_row_is_durable_before_the_file_exists(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """Ordering, asserted rather than assumed.

    If the file were created first, a crash in between would leave a file that
    nothing knows about and the next run would publish a duplicate. The probe
    reads the journal from the moment the file appears.
    """
    seen_operations: list[int] = []

    class ObservingProjector(VaultProjector):
        def _create_new(self, destination: Path, base_name: str, payload: bytes) -> str:
            seen_operations.append(
                repository.connection.execute("SELECT COUNT(*) FROM vault_projection_operation").fetchone()[0]
            )
            return super()._create_new(destination, base_name, payload)

    ObservingProjector(repository, binding, now=WHEN).project(a_request())

    assert seen_operations == [1]


@pytest.mark.parametrize("hostile", ["../escape", "..", "a/b", "a\\b", "CON", "trailing ", ""])
def test_a_hostile_projection_name_is_refused_before_anything_is_written(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, hostile: str
) -> None:
    with pytest.raises(UnsafePathComponentError):
        VaultProjector(repository, binding, now=WHEN).project(a_request(name=hostile))
    assert repository.unfinished_projections(binding.vault_id) == ()
    assert list(vault_root.rglob("*.md")) == []


def test_a_hostile_directory_component_is_refused(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    request = ProjectionRequest(base_name="fact-01", content="x", directory_parts=("..", "outside"))
    with pytest.raises(UnsafePathComponentError):
        VaultProjector(repository, binding, now=WHEN).project(request)
    assert list(vault_root.rglob("*.md")) == []


def test_a_root_that_is_a_junction_refuses_to_be_published_into(
    repository: VaultRepository, tmp_path: Path
) -> None:
    """The root recorded at binding time is not where this now points.

    A junction as the root means every path derived from it lands somewhere
    the owner did not choose. Stage one can only notice this at publish time --
    a retained handle would have made the substitution impossible -- so
    noticing must at least stop the write.
    """
    real = tmp_path / "real-vault"
    real.mkdir()
    link = tmp_path / "vault-link"
    make_reparse_point(link, real)
    binding = VaultBinding(vault_id="01k5d8s0m00000000000000001", principal_id="p", root_path=str(link))

    with pytest.raises(VaultProjectionError, match="reparse point"):
        VaultProjector(repository, binding, now=WHEN).project(a_request())

    assert list(real.rglob("*.md")) == []


def test_a_destination_that_became_a_junction_refuses_the_write(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path, tmp_path: Path
) -> None:
    """A junction as the destination is a door out of the vault.

    It is caught by containment rather than by the reparse check, because
    resolving the junction already lands outside the root -- which is the
    check that would have to hold even if reparse detection were removed.
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    make_reparse_point(vault_root / "90 Jarvis", outside)

    with pytest.raises(VaultProjectionError, match="outside the vault root"):
        VaultProjector(repository, binding, now=WHEN).project(a_request())

    assert list(outside.rglob("*.md")) == []


def test_text_is_normalised_before_it_is_written_and_hashed(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    published = VaultProjector(repository, binding, now=WHEN).project(a_request(content="café"))
    written = (vault_root / "90 Jarvis" / published.final_name).read_bytes()
    assert written == "café".encode()
    assert published.content_hash == canonical_content_hash("café")
