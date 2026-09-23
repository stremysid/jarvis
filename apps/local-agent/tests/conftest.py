"""Real migrated retry journals for control-thread regression tests."""

from collections.abc import Callable, Iterator
import os
from pathlib import Path

import pytest

from jarvis_local.archive import store_permissions
from jarvis_local.memory.facts import FactRepository
from jarvis_local.node import _QuarantineRetryCoordinator
from jarvis_local.service import ServiceState
from jarvis_local.sync.quarantine_retry import QuarantineRetryJournal


@pytest.fixture(autouse=True)
def no_real_store_permissions(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No test in this suite may change a real Windows permission.

    On 2026-09-22 the ordinary act of running this suite on Sid's PC rewrote
    his entire user profile. `store_permissions.apply_owner_only_dacl` writes a
    DACL through `SetNamedSecurityInfoW`, which propagates to everything below
    the object it names, and the first version applied it to every *parent* of
    the store as well -- the walk reached `C:\\Users\\Sid`, Windows recomputed
    the whole profile from a folder that no longer passed anything down, and the
    PC broke twice. `C:\\` went with it on the second run.

    Three things, and they are separate on purpose:

    1. **The configured store root is moved into the test's own temp tree.**
       The guard checks the target against `JARVIS_ARCHIVE_PATH` and
       `JARVIS_MEMORY_PATH`, so a test operating on `tmp_path` would otherwise
       be refused -- correctly, because it *is* outside the real store. Pointing
       the configuration at the test tree keeps the guard live instead of
       exempting the suite from it, which is the difference between testing the
       boundary and switching it off.
    2. **The two functions that reach Win32 are replaced with path-validating
       no-ops.** This is a test-only monkeypatch and deliberately not an
       environment variable: a variable would let CI's `windows-latest` job
       believe it had exercised the DACL path when it had not, and would let
       anyone re-arm the hazard by exporting it. Monkeypatch cannot be inherited
       by a subprocess, so the production path is untouched.
    3. **The path is still validated**, so a test that computes a wrong path
       still finds out.

    `tests/archive/test_store_permissions.py` and the integration test override
    this to run the real bodies against a stubbed Win32 seam. That is what the
    seam in `store_permissions._windows_apis` exists for.
    """
    # The whole of this test's temp directory is the configured store root, so
    # every path a test might legitimately use is inside it and the guard is
    # still doing real work: anything a test should *not* touch is outside.
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(tmp_path / "memory.sqlite3"))
    def record(path: Path, user_sid: str, *, store_root: Path) -> None:
        store_permissions._refuse_unsafe_path(path, store_root)

    def record_tree(root: Path, user_sid: str, *, store_root: Path | None = None) -> tuple[Path, ...]:
        store_permissions._refuse_unsafe_path(root, store_root or root)
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
