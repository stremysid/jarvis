"""Retrieval must never cross a principal boundary or surface an unpromoted fact."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository, Sensitivity
from jarvis_local.memory.promotion import PromotionEngine
from jarvis_local.memory.retrieval import (
    MAX_LIMIT,
    LocalMemoryRetriever,
    escape_fts_query,
)


@pytest.fixture
def repo(tmp_path: Path) -> Iterator[FactRepository]:
    repository = FactRepository.open(tmp_path / "memory.sqlite3")
    yield repository
    repository.close()


def add_active(
    repo: FactRepository,
    text: str,
    *,
    source_ids: list[str],
    principal_id: str = "principal-a",
    origin: FactOrigin = FactOrigin.AUTHENTICATED_FIRST_PERSON,
    sensitivity: Sensitivity = Sensitivity.NORMAL,
) -> str:
    fact = repo.record_proposal(
        FactProposal(
            principal_id=principal_id,
            text=text,
            origin=origin,
            source_event_ids=tuple(source_ids),
            sensitivity=sensitivity,
        )
    )
    PromotionEngine(repo).promote(fact)
    return fact.fact_id


def test_retrieval_requires_principal_and_returns_source_ids(repo: FactRepository) -> None:
    add_active(repo, "I like coffee", source_ids=["01b"])
    memory = LocalMemoryRetriever(repo)

    found = memory.search("coffee", principal_id="principal-a", purpose="conversation", limit=5)
    assert found[0].source_event_ids == ("01b",)
    assert memory.search("coffee", principal_id="principal-b", purpose="conversation", limit=5) == []


def test_proposed_facts_are_never_retrieved(repo: FactRepository) -> None:
    """A model's guess must not reach a prompt before Sid confirms it."""
    repo.record_proposal(
        FactProposal(
            principal_id="principal-a",
            text="Sid likes coffee",
            origin=FactOrigin.MODEL,
            source_event_ids=("01a",),
        )
    )
    assert LocalMemoryRetriever(repo).search("coffee", principal_id="principal-a", purpose="conversation") == []


def test_superseded_facts_are_not_retrieved(repo: FactRepository) -> None:
    original = add_active(repo, "I like tea", source_ids=["01a"])
    correction = add_active(repo, "I like coffee", source_ids=["01b"])
    repo.supersede(superseding_fact_id=correction, superseded_fact_id=original)

    memory = LocalMemoryRetriever(repo)
    assert memory.search("tea", principal_id="principal-a", purpose="conversation") == []
    assert [r.fact_id for r in memory.search("coffee", principal_id="principal-a", purpose="conversation")] == [
        correction
    ]


def test_diacritics_fold_so_normalized_text_is_findable(repo: FactRepository) -> None:
    add_active(repo, "I like café au lait", source_ids=["01a"])
    memory = LocalMemoryRetriever(repo)
    assert len(memory.search("cafe", principal_id="principal-a", purpose="conversation")) == 1
    assert len(memory.search("café", principal_id="principal-a", purpose="conversation")) == 1


def test_unknown_purpose_is_refused(repo: FactRepository) -> None:
    with pytest.raises(ValueError, match="purpose"):
        LocalMemoryRetriever(repo).search("x", principal_id="principal-a", purpose="exfiltrate")


def test_missing_principal_is_refused(repo: FactRepository) -> None:
    with pytest.raises(ValueError, match="principal"):
        LocalMemoryRetriever(repo).search("x", principal_id="", purpose="conversation")


def test_limit_is_bounded_regardless_of_caller(repo: FactRepository) -> None:
    for index in range(MAX_LIMIT + 10):
        add_active(repo, f"coffee note {index}", source_ids=[f"01{index}"])
    found = LocalMemoryRetriever(repo).search(
        "coffee", principal_id="principal-a", purpose="conversation", limit=10_000
    )
    assert len(found) == MAX_LIMIT


def test_zero_or_negative_limit_is_refused(repo: FactRepository) -> None:
    with pytest.raises(ValueError, match="limit"):
        LocalMemoryRetriever(repo).search("x", principal_id="principal-a", purpose="conversation", limit=0)


def test_blank_query_returns_nothing_rather_than_everything(repo: FactRepository) -> None:
    add_active(repo, "I like coffee", source_ids=["01a"])
    memory = LocalMemoryRetriever(repo)
    assert memory.search("   ", principal_id="principal-a", purpose="conversation") == []


@pytest.mark.parametrize(
    "hostile",
    [
        '" OR text : "',  # escape the phrase and re-open the expression
        "coffee OR tea",  # boolean: unescaped this matches, escaped it must not
        "coffee NEAR tea",  # proximity operator
        "text : coffee",  # column filter
        "cof*",  # prefix wildcard: unescaped this matches "coffee"
        '"',  # lone quote: unescaped this is a syntax error
    ],
)
def test_fts_operators_are_not_executed(repo: FactRepository, hostile: str) -> None:
    """Unescaped, each of these would either match or raise. Escaped, none may.

    These are the discriminating cases: every one behaves differently when the
    input reaches MATCH as expression syntax rather than as a literal phrase.
    """
    add_active(repo, "I like coffee", source_ids=["01a"])
    found = LocalMemoryRetriever(repo).search(hostile, principal_id="principal-a", purpose="conversation")
    assert found == []


@pytest.mark.parametrize("noisy", ["coffee*", "^coffee", "coffee!", "(coffee)"])
def test_punctuation_is_folded_so_the_words_still_match(repo: FactRepository, noisy: str) -> None:
    """The escape must not make ordinary punctuation unsearchable.

    Inside a quoted phrase these characters are token separators, so the query
    reduces to the word itself and still finds the fact. Rejecting them, or
    returning nothing, would make a user typing "coffee!" get no answer.
    """
    add_active(repo, "I like coffee", source_ids=["01a"])
    found = LocalMemoryRetriever(repo).search(noisy, principal_id="principal-a", purpose="conversation")
    assert [result.text for result in found] == ["I like coffee"]


def test_escape_wraps_and_doubles_quotes() -> None:
    assert escape_fts_query("coffee") == '"coffee"'
    assert escape_fts_query('say "hi"') == '"say ""hi"""'


def test_sensitivity_is_carried_through_to_results(repo: FactRepository) -> None:
    add_active(repo, "private coffee habit", source_ids=["01a"], sensitivity=Sensitivity.SENSITIVE)
    (found,) = LocalMemoryRetriever(repo).search("coffee", principal_id="principal-a", purpose="conversation")
    assert found.sensitivity == Sensitivity.SENSITIVE


def test_results_do_not_leak_across_principals_even_with_identical_text(repo: FactRepository) -> None:
    mine = add_active(repo, "I like coffee", source_ids=["01a"])
    add_active(repo, "I like coffee", source_ids=["01b"], principal_id="principal-b")

    found = LocalMemoryRetriever(repo).search("coffee", principal_id="principal-a", purpose="conversation")
    assert [r.fact_id for r in found] == [mine]
