"""Pick a local semantic strategy by testing it, not by trusting it.

Every candidate strategy has to survive the same five checks on the machine it
will actually run on -- install, index, query, rebuild, offline -- and the
first one that does is the one that gets used. Candidates are tried in order,
and the SQLite BLOB + cosine strategy is appended unconditionally at the end,
because that is the one that must work when nothing else is available.

Offline is enforced rather than declared. A candidate that promises not to
touch the network is not evidence of anything: an embedding library that
quietly fetches a model on first use looks identical to one that does not,
right up to the first flight without wifi. So verification runs with the
socket constructors replaced by traps, and a candidate that reaches for one
fails the whole gate instead of being skipped -- a strategy that tried to
phone home is a finding a human needs to see, not a fallback to paper over.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import NoReturn, Protocol

from jarvis_local.memory.embeddings import EmbeddingProvider, default_embedding_provider
from jarvis_local.memory.vector_index import IndexedDocument, VectorIndex

STRATEGY_SQLITE_BLOB_COSINE = "sqlite_blob_cosine"

# Replaced wholesale for the duration of a candidate's verification. Both
# entry points matter: `socket.socket` is what a hand-rolled client builds,
# and `create_connection` is what `http.client` (and therefore every HTTP
# library above it) actually calls. The name resolvers are included so a
# candidate cannot even establish that it has connectivity.
_GUARDED_SOCKET_NAMES = (
    "socket",
    "create_connection",
    "create_server",
    "getaddrinfo",
    "gethostbyname",
)


# N818 wants an `Error` suffix. The release plan names this exception in the
# interface callers are written against, so the convention loses to the
# contract.
class CompatibilityFailure(RuntimeError):  # noqa: N818
    """No strategy may be selected: nothing passed, or something went online."""


class NetworkAccessAttempted(BaseException):
    """A candidate touched the network while it was supposed to be offline.

    Deliberately a `BaseException`: this is raised from inside candidate code,
    and a candidate with a broad `except Exception` around its own setup would
    otherwise swallow the one signal the gate exists to catch. The attempt is
    counted as well, so swallowing it by any means still fails the gate.
    """


@dataclass(frozen=True, slots=True)
class GateFixture:
    """The fixed corpus and query every candidate must reproduce.

    Small and hand-picked rather than sampled from the archive: the gate has
    to give the same verdict on a fresh machine with an empty archive as it
    does on Sid's, and a verdict that depended on real data could not be
    compared across runs.
    """

    documents: tuple[IndexedDocument, ...]
    query: str
    limit: int = 2


DEFAULT_FIXTURE = GateFixture(
    documents=(
        IndexedDocument("event-1", "Sid drinks coffee"),
        IndexedDocument("event-2", "Sid ordered coffee and toast at the cafe on Tuesday morning"),
        IndexedDocument("event-3", "The quarterly tax filing deadline falls in March"),
    ),
    query="coffee",
)


@dataclass(frozen=True, slots=True)
class CompatibilityReport:
    """What a candidate did, and whether it earned the right to be used."""

    selected_strategy: str
    passed: bool
    offline: bool
    query_result_ids: tuple[str, ...]
    rebuild_result_ids: tuple[str, ...]
    model_id: str
    dimensions: int
    rejected_strategies: tuple[str, ...] = field(default_factory=tuple)
    failure_reason: str | None = None


class SemanticCandidate(Protocol):
    """One strategy the gate may select, if it can prove itself."""

    @property
    def strategy(self) -> str:
        """Stable identifier recorded in the report and in the ADR."""
        ...

    def verify_install_index_query_rebuild_offline(self, workdir: Path) -> CompatibilityReport:
        """Run the five checks in `workdir` and report what happened.

        Raising is a legitimate outcome -- a missing extension or an
        unloadable model is exactly what the gate is looking for -- and is
        recorded as a failed report so the next candidate gets its turn. The
        one exception is network access, which fails the gate outright.
        """
        ...


class NetworkGuard:
    """Counts and blocks socket use for the duration of a verification."""

    def __init__(self) -> None:
        self.attempts = 0

    @property
    def attempted(self) -> bool:
        return self.attempts > 0

    @contextmanager
    def enforced(self) -> Iterator[None]:
        originals = {name: getattr(socket, name) for name in _GUARDED_SOCKET_NAMES}

        def refuse(*_args: object, **_kwargs: object) -> NoReturn:
            self.attempts += 1
            raise NetworkAccessAttempted("network access attempted while the compatibility gate required offline")

        for name in _GUARDED_SOCKET_NAMES:
            setattr(socket, name, refuse)
        try:
            yield
        finally:
            # Restored in a `finally` because the traps are process-global:
            # leaving them installed after a failure would break every later
            # test and every later caller in the same process.
            for name, original in originals.items():
                setattr(socket, name, original)


@dataclass(frozen=True, slots=True)
class SqliteBlobCosineCandidate:
    """The mandatory strategy: float32 BLOBs in SQLite, scored in process.

    It depends on nothing beyond the standard library and the chosen embedding
    provider, which is why it can be the floor: if this cannot pass, the
    machine cannot run local retrieval at all.
    """

    provider: EmbeddingProvider
    fixture: GateFixture = DEFAULT_FIXTURE

    @property
    def strategy(self) -> str:
        return STRATEGY_SQLITE_BLOB_COSINE

    def verify_install_index_query_rebuild_offline(self, workdir: Path) -> CompatibilityReport:
        self._verify_install()
        # Two independent databases rather than one reused file: rebuilding
        # into a fresh file proves the ranking comes from the inputs, not from
        # state that happened to survive in the first one.
        query_ids = self._index_and_query(workdir / "index.sqlite3")
        rebuild_ids = self._index_and_query(workdir / "rebuild.sqlite3")

        reproduced = query_ids == rebuild_ids
        found = len(query_ids) > 0
        return CompatibilityReport(
            selected_strategy=self.strategy,
            passed=reproduced and found,
            # Only the gate may claim this; see `_verify_offline`.
            offline=False,
            query_result_ids=query_ids,
            rebuild_result_ids=rebuild_ids,
            model_id=self.provider.model_id,
            dimensions=self.provider.dimensions,
            failure_reason=None if reproduced and found else _describe(query_ids, rebuild_ids),
        )

    def _verify_install(self) -> None:
        """Check the provider is usable before blaming SQLite for its output."""
        probe = self.provider.embed(["compatibility gate install probe"])
        if len(probe) != 1 or len(probe[0]) != self.provider.dimensions:
            raise RuntimeError(
                f"provider {self.provider.model_id} did not return one vector of width {self.provider.dimensions}"
            )

    def _index_and_query(self, path: Path) -> tuple[str, ...]:
        index = VectorIndex.open(path, self.provider)
        try:
            index.rebuild(self.fixture.documents)
            matches = index.search_text(self.fixture.query, self.fixture.limit)
        finally:
            index.close()
        return tuple(match.event_id for match in matches)


def _describe(query_ids: tuple[str, ...], rebuild_ids: tuple[str, ...]) -> str:
    if not query_ids:
        return "query returned no matches for the fixture corpus"
    return f"rebuild changed the ranking: {query_ids} then {rebuild_ids}"


def default_candidates() -> tuple[SemanticCandidate, ...]:
    """Strategies to try before falling back, in preference order.

    Empty today. A native vector extension and the pinned ONNX embedder are
    each added here once they exist, ahead of the fallback -- which is the
    whole reason the gate takes an ordered list rather than a flag.
    """
    return ()


def mandatory_fallback() -> SemanticCandidate:
    """The strategy that is always tried last and may never be omitted."""
    return SqliteBlobCosineCandidate(default_embedding_provider())


def run_compatibility_gate(
    workdir: Path,
    candidates: Sequence[SemanticCandidate] | None = None,
) -> CompatibilityReport:
    """Select the first strategy that passes every check on this machine.

    Raises `CompatibilityFailure` if a candidate attempts network access, or
    if nothing -- including the mandatory fallback -- passes.
    """
    ordered = list(default_candidates() if candidates is None else candidates)
    # Appended rather than left to the caller: a caller that supplied its own
    # list must not be able to leave the machine with no working strategy.
    ordered.append(mandatory_fallback())

    rejected: list[str] = []
    for position, candidate in enumerate(ordered):
        # One directory per position, so a candidate can never pass on files
        # an earlier candidate left behind, and so a failed run can be read
        # off disk afterwards.
        report = _verify_offline(candidate, workdir / f"{position:02d}-{candidate.strategy}")
        if report.passed:
            return replace(report, rejected_strategies=tuple(rejected))
        rejected.append(candidate.strategy)

    raise CompatibilityFailure("no local semantic strategy passed deterministic offline checks: " + ", ".join(rejected))


def _verify_offline(candidate: SemanticCandidate, workdir: Path) -> CompatibilityReport:
    workdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    guard = NetworkGuard()
    try:
        with guard.enforced():
            report = candidate.verify_install_index_query_rebuild_offline(workdir)
    except NetworkAccessAttempted as error:
        raise CompatibilityFailure(
            f"candidate {candidate.strategy!r} attempted network access; the gate requires offline operation"
        ) from error
    except Exception as error:
        # A missing extension, an unreadable model file, a broken install: all
        # ordinary candidate failures, which is what the ordered list is for.
        return CompatibilityReport(
            selected_strategy=candidate.strategy,
            passed=False,
            offline=not guard.attempted,
            query_result_ids=(),
            rebuild_result_ids=(),
            model_id="",
            dimensions=0,
            failure_reason=f"{type(error).__name__}: {error}",
        )

    if guard.attempted:
        # Reached when the candidate caught the trap and carried on. The
        # counter, not the candidate's own report, is the evidence.
        raise CompatibilityFailure(
            f"candidate {candidate.strategy!r} attempted network access and suppressed the error;"
            " the gate requires offline operation"
        )
    # Stamped here and nowhere else: passing through the guard untouched is
    # the only thing that makes `offline` mean anything.
    return replace(report, offline=True)
