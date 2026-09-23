"""Real migrated retry journals for control-thread regression tests."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jarvis_local.archive import store_permissions
from jarvis_local.memory.facts import FactRepository
from jarvis_local.node import _QuarantineRetryCoordinator
from jarvis_local.service import ServiceState
from jarvis_local.sync.quarantine_retry import QuarantineRetryJournal


@pytest.fixture(autouse=True)
def no_real_store_permissions(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test in this suite may change a real Windows permission.

    On 2026-09-22 the ordinary act of running this suite on Sid's PC rewrote
    his entire user profile. `store_permissions.apply_owner_only_dacl` writes a
    DACL through `SetNamedSecurityInfoW`, which propagates to everything below
    the object it names, and the first version applied it to every *parent* of
    the store as well -- the walk reached `C:\\Users\\Sid`, Windows recomputed
    the whole profile from a folder that no longer passed anything down, and the
    PC broke twice. `C:\\` went with it on the second run.

    **This is a test-only mock and it is deliberately not gated on an
    environment variable.** Setting one would let CI -- which runs a
    `windows-latest` job precisely to exercise this code -- believe it had
    tested something it had not, and would let anyone re-arm the hazard by
    exporting it. Monkeypatching cannot be inherited by a subprocess, so the
    production path is unaffected.

    Hundreds of tests legitimately open a store and would otherwise reach the
    real call, so this is a no-op rather than a raise; failing them all would
    only teach the next person to switch the fixture off. The path is still
    validated, so a test that computed a wrong path still finds out.

    `tests/archive/test_store_permissions.py` overrides this to run the real
    bodies against a stubbed Win32 seam -- which is why the seam exists.
    """

    def record(path: Path, user_sid: str, *, store_root: Path) -> None:
        store_permissions._refuse_unsafe_path(path, store_root)

    def record_tree(root: Path, user_sid: str) -> tuple[Path, ...]:
        store_permissions._refuse_unsafe_path(root, root)
        return ()

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", record)
    monkeypatch.setattr(store_permissions, "repair_store_tree", record_tree)


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
