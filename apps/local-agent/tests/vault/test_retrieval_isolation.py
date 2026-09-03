"""Vault text reaches `jarvis vault search/show` and nothing else.

The plan: *a local-only or unbound vault observation is available only through
deterministic `jarvis vault search/show`; it cannot reach DeepSeek, calls,
Telegram, fact promotion, permissions, policy, identity, or tools.*

The tests below are written so they fail if someone later wires the vault into
the ordinary retrieval path -- by adding a purpose, by pointing the memory
retriever at the vault tables, or by putting vault text into the memory
database.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository
from jarvis_local.memory.promotion import PromotionEngine
from jarvis_local.memory.retrieval import ALLOWED_PURPOSES as MEMORY_PURPOSES
from jarvis_local.memory.retrieval import LocalMemoryRetriever
from jarvis_local.vault.reconciliation import VaultReconciler
from jarvis_local.vault.repository import VaultBinding, VaultRepository
from jarvis_local.vault.retrieval import (
    ALLOWED_PURPOSES,
    PROPOSAL_ONLY,
    RESULT_KIND,
    VAULT_CLI,
    VaultLocalRetriever,
    VaultObservationRetrievalV1,
    VaultRetrievalDeniedError,
)
from tests.vault.conftest import PRINCIPAL, write_note

#: A word that exists in the vault and nowhere else, so finding it anywhere
#: outside the vault CLI is proof text crossed a boundary it must not. Named
#: `MARKER` rather than `TOKEN` because a name ending in TOKEN reads to the
#: linter -- reasonably -- as a credential.
VAULT_ONLY_MARKER = "zarquonberry"


@pytest.fixture
def memory(tmp_path: Path) -> Iterator[FactRepository]:
    facts = FactRepository.open(tmp_path / "memory.sqlite3")
    yield facts
    facts.close()


@pytest.fixture
def populated(repository: VaultRepository, binding: VaultBinding, vault_root: Path) -> VaultBinding:
    write_note(vault_root, "coffee.md", f"# Coffee\n\nI like {VAULT_ONLY_MARKER} in my coffee.")
    write_note(vault_root, "tea.md", "# Tea\n\nSometimes tea.")
    VaultReconciler(repository, binding).run()
    return binding


def test_the_vault_allows_exactly_one_purpose() -> None:
    """Asserted by equality. Membership would pass while a second was added."""
    assert frozenset({"vault_cli"}) == ALLOWED_PURPOSES


def test_the_vault_shares_no_purpose_with_ordinary_memory_retrieval() -> None:
    assert ALLOWED_PURPOSES.isdisjoint(MEMORY_PURPOSES)


@pytest.mark.parametrize("consumer", sorted(MEMORY_PURPOSES))
def test_every_ordinary_retrieval_purpose_is_refused_by_the_vault(
    repository: VaultRepository, populated: VaultBinding, consumer: str
) -> None:
    """Parameterised over the *real* memory purposes, not a hard-coded list.

    If someone adds a purpose to `memory.retrieval` and wires it into the
    vault, this test grows a case for it automatically and that case fails.
    """
    with pytest.raises(VaultRetrievalDeniedError, match="vault_cli_only"):
        VaultLocalRetriever(repository).search(
            VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=consumer, limit=1
        )


@pytest.mark.parametrize(
    "consumer",
    ["conversation", "distillation", "voice", "telegram", "fact_authority", "tool_authorization", "policy", ""],
)
def test_a_named_downstream_consumer_cannot_read_the_vault(
    repository: VaultRepository, populated: VaultBinding, consumer: str
) -> None:
    """The plan names these by name, so they are refused by name here too."""
    with pytest.raises(VaultRetrievalDeniedError, match="vault_cli_only"):
        VaultLocalRetriever(repository).search(
            VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=consumer, limit=1
        )
    with pytest.raises(VaultRetrievalDeniedError, match="vault_cli_only"):
        VaultLocalRetriever(repository).show("anything", principal_id=PRINCIPAL, purpose=consumer)


def test_vault_text_is_not_reachable_through_the_ordinary_memory_retrieval_path(
    repository: VaultRepository, populated: VaultBinding, memory: FactRepository
) -> None:
    """The structural half: the two stores are different databases.

    A note is crawled into the vault, an ordinary fact is promoted into
    memory, and a conversation-purpose search finds the fact and not the note.
    Wiring the vault into conversation would mean opening a second database
    inside `LocalMemoryRetriever`, which this test would catch.
    """
    promoted = memory.record_proposal(
        FactProposal(
            principal_id=PRINCIPAL,
            text="I drink coffee",
            origin=FactOrigin.AUTHENTICATED_FIRST_PERSON,
            source_event_ids=("01a",),
        )
    )
    PromotionEngine(memory).promote(promoted)
    retriever = LocalMemoryRetriever(memory)

    assert retriever.search(VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose="conversation") == []
    assert [r.text for r in retriever.search("coffee", principal_id=PRINCIPAL, purpose="conversation")] == [
        "I drink coffee"
    ]


def test_the_memory_database_holds_no_vault_table(memory: FactRepository) -> None:
    """Structural, and independent of what any query happens to select.

    `LocalMemoryRetriever` can only read what is in the file it opened. If
    there is no vault table there, no query it could be given reaches vault
    text.
    """
    names = {
        str(row[0])
        for row in memory.connection.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    }
    assert {name for name in names if name.startswith("vault")} == set()


def test_the_vault_tables_are_absent_from_the_memory_schema_and_present_in_the_archive(
    repository: VaultRepository, memory: FactRepository
) -> None:
    archive_tables = {
        str(row[0]) for row in repository.connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert "vault_observation" in archive_tables
    assert "fact" not in archive_tables


def test_the_vault_cli_finds_the_note_that_nothing_else_can(
    repository: VaultRepository, populated: VaultBinding
) -> None:
    """The control for every refusal above: the allowed path does work.

    Without this, all the tests above would pass on a retriever that returns
    nothing to anyone.
    """
    (found,) = VaultLocalRetriever(repository).search(
        VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI, limit=5
    )
    assert VAULT_ONLY_MARKER in found.excerpt
    assert found.display_label == "Coffee"
    assert found.kind == RESULT_KIND
    assert found.authority == PROPOSAL_ONLY


def test_a_result_carries_no_path_and_no_filesystem_field() -> None:
    """The field list, by equality. A path could only arrive as a new field."""
    assert tuple(VaultObservationRetrievalV1.__dataclass_fields__) == (
        "document_id",
        "observation_id",
        "document_version",
        "display_label",
        "excerpt",
        "sensitivity",
        "score",
        "kind",
        "authority",
    )


def test_no_result_field_contains_the_notes_location(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "private/inner/plan.md", f"# Plan\n\n{VAULT_ONLY_MARKER}")
    VaultReconciler(repository, binding).run()

    (found,) = VaultLocalRetriever(repository).search(
        VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI
    )

    for value in (found.document_id, found.observation_id, found.display_label, found.kind, found.authority):
        assert "private" not in value
        assert "plan.md" not in value
        assert str(vault_root) not in value


def test_retrieval_calls_no_model(repository: VaultRepository, populated: VaultBinding) -> None:
    """Deterministic means arithmetic over stored rows, not an inference call.

    Asserted by construction: a retriever built with no embedding provider and
    no vector index still answers, so nothing in the path can be reaching for
    one.
    """
    retriever = VaultLocalRetriever(repository)
    first = retriever.search(VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI)
    second = retriever.search(VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI)

    assert [r.observation_id for r in first] == [r.observation_id for r in second]
    assert len(first) == 1


def test_a_tombstoned_note_is_not_returned(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "coffee.md", f"# Coffee\n\n{VAULT_ONLY_MARKER}")
    VaultReconciler(repository, binding).run()
    assert VaultLocalRetriever(repository).search(VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI)

    (vault_root / "coffee.md").unlink()
    VaultReconciler(repository, binding).run()

    assert VaultLocalRetriever(repository).search(VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI) == []


def test_only_the_current_version_is_returned(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    """A superseded version must not keep being quoted after the correction."""
    write_note(vault_root, "coffee.md", "# Coffee\n\nI take it with sugar.")
    VaultReconciler(repository, binding).run()
    write_note(vault_root, "coffee.md", "# Coffee\n\nI take it black.")
    VaultReconciler(repository, binding).run()

    retriever = VaultLocalRetriever(repository)

    assert retriever.search("sugar", principal_id=PRINCIPAL, purpose=VAULT_CLI) == []
    (found,) = retriever.search("black", principal_id=PRINCIPAL, purpose=VAULT_CLI)
    assert found.document_version == 2


def test_another_principals_query_returns_nothing(
    repository: VaultRepository, populated: VaultBinding
) -> None:
    assert (
        VaultLocalRetriever(repository).search(
            VAULT_ONLY_MARKER, principal_id="principal-b", purpose=VAULT_CLI
        )
        == []
    )


def test_an_unbound_vault_returns_nothing_rather_than_text(repository: VaultRepository) -> None:
    assert VaultLocalRetriever(repository).search("anything", principal_id=PRINCIPAL, purpose=VAULT_CLI) == []
    assert VaultLocalRetriever(repository).show("anything", principal_id=PRINCIPAL, purpose=VAULT_CLI) is None


def test_show_returns_one_note_by_its_document_id(
    repository: VaultRepository, populated: VaultBinding
) -> None:
    (found,) = VaultLocalRetriever(repository).search(
        VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI
    )
    shown = VaultLocalRetriever(repository).show(
        found.document_id, principal_id=PRINCIPAL, purpose=VAULT_CLI
    )
    assert shown is not None
    assert shown.observation_id == found.observation_id


def test_a_guessed_identifier_returns_nothing(repository: VaultRepository, populated: VaultBinding) -> None:
    assert (
        VaultLocalRetriever(repository).show(
            "01k5d8s0m0000000000000zzzz", principal_id=PRINCIPAL, purpose=VAULT_CLI
        )
        is None
    )


@pytest.mark.parametrize("hostile", ['" OR text : "', "coffee OR tea", "cof*", '"'])
def test_full_text_operators_are_not_executed(
    repository: VaultRepository, populated: VaultBinding, hostile: str
) -> None:
    """The vault reuses `escape_fts_query`, so it inherits the same defence."""
    assert VaultLocalRetriever(repository).search(hostile, principal_id=PRINCIPAL, purpose=VAULT_CLI) == []


def test_an_excerpt_is_bounded_by_max_chars(
    repository: VaultRepository, binding: VaultBinding, vault_root: Path
) -> None:
    write_note(vault_root, "long.md", f"# Long\n\n{VAULT_ONLY_MARKER} " + "padding " * 500)
    VaultReconciler(repository, binding).run()

    (found,) = VaultLocalRetriever(repository).search(
        VAULT_ONLY_MARKER, principal_id=PRINCIPAL, purpose=VAULT_CLI, max_chars=40
    )
    assert len(found.excerpt) == 40
