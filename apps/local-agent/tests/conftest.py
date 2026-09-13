"""Real migrated retry journals for control-thread regression tests."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jarvis_local.memory.facts import FactRepository
from jarvis_local.node import _QuarantineRetryCoordinator
from jarvis_local.service import ServiceState
from jarvis_local.sync.quarantine_retry import QuarantineRetryJournal


@pytest.fixture
def retry_factory(tmp_path: Path) -> Iterator[Callable[[ServiceState], _QuarantineRetryCoordinator]]:
    opened: list[tuple[_QuarantineRetryCoordinator, FactRepository]] = []

    def create(state: ServiceState) -> _QuarantineRetryCoordinator:
        path = tmp_path / f"retry-{len(opened)}.sqlite3"
        facts = FactRepository.open(path)
        coordinator = _QuarantineRetryCoordinator(state)
        coordinator.attach(QuarantineRetryJournal(
            facts.connection, path, ("https://gateway.example", "principal-1", "device-1"),
        ))
        opened.append((coordinator, facts))
        return coordinator

    yield create
    for coordinator, facts in opened:
        try:
            coordinator.close()
        finally:
            facts.close()
