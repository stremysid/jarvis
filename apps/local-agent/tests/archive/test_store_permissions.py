"""The store-permission module, tested without ever changing a real permission.

Nothing in this file may call `SetNamedSecurityInfoW`. The module under test
rewrote Sid's entire user profile twice on 2026-09-22 by being exercised against
the real filesystem, so every test here either checks a pure string, or replaces
`_windows_apis` with a stub and asserts on what *would* have been passed. The
one real integration test lives in `tests/integration` and runs only inside
`C:\\jarvis-test-scratch`.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import pytest

from jarvis_local.archive import store_permissions
from jarvis_local.archive import database as archive_database
from jarvis_local.archive.store_permissions import (
    UnsafeStorePathError,
    _refuse_unsafe_path,
    apply_owner_only_dacl,
    ensure_private_directory,
    folder_only_sddl,
    repair_store_tree,
    store_root_summary,
    tree_owner_sddl,
)

SID = "S-1-5-21-724611481-2579320955-54207251-1001"

_DACL = 0x00000004
_OWNER = 0x00000001
_PROTECTED_DACL = 0x80000000


class StubWin32:
    """A stand-in for the two DLL modules, recording every call.

    `_windows_apis` is the single seam: replacing it means no real Win32 call
    can happen, because the module reaches Windows only through what it returns.
    """

    def __init__(self, *, set_result: int = 0, get_result: int = 0, owner_sid: str | None = None) -> None:
        self.set_result = set_result
        self.get_result = get_result
        #: What `GetNamedSecurityInfoW` + `GetSecurityDescriptorOwner` report as
        #: the current owner. Defaults to the user's own SID, the healthy case.
        self.owner_sid = owner_sid if owner_sid is not None else SID
        self.security_information: list[int] = []
        #: One entry per `SetNamedSecurityInfoW` call, so a test can assert the
        #: call *order* and not only the set of masks used.
        self.set_results: list[int] | None = None
        self.owners: list[Any] = []
        self.acls: list[Any] = []
        self.paths: list[str] = []
        self.freed: list[Any] = []
        self.sddls: list[str] = []

    def next_set_result(self) -> int:
        if self.set_results:
            return self.set_results.pop(0)
        return self.set_result

    def __call__(self) -> tuple[Any, Any]:
        return self._advapi32(), self._kernel32()

    def _advapi32(self) -> Any:
        stub = self

        class _Advapi32:
            @staticmethod
            def ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl: str, _revision: int, descriptor: Any, _length: Any,
            ) -> int:
                stub.sddls.append(sddl)
                descriptor._obj.value = 0x1234
                return 1

            @staticmethod
            def ConvertStringSidToSidW(_sid: str, owner: Any) -> int:
                owner._obj.value = 0x5678
                return 1

            @staticmethod
            def ConvertSidToStringSidW(_owner: Any, text: Any) -> int:
                text._obj.value = stub.owner_sid
                return 1

            @staticmethod
            def GetSecurityDescriptorOwner(_descriptor: Any, owner: Any, defaulted: Any) -> int:
                owner._obj.value = 0x1111
                defaulted._obj.value = 0
                return 1

            @staticmethod
            def GetSecurityDescriptorDacl(
                _descriptor: Any, present: Any, acl: Any, defaulted: Any,
            ) -> int:
                present._obj.value = 1
                defaulted._obj.value = 0
                acl._obj.value = 0x9ABC
                return 1

            @staticmethod
            def SetNamedSecurityInfoW(
                path: str,
                _object_type: int,
                security_information: int,
                owner: Any,
                _group: Any,
                acl: Any,
                _sacl: Any,
            ) -> int:
                stub.paths.append(path)
                stub.security_information.append(security_information)
                stub.owners.append(owner)
                stub.acls.append(acl)
                return stub.next_set_result()

            @staticmethod
            def GetNamedSecurityInfoW(*_args: Any) -> int:
                if stub.get_result == 0 and len(_args) >= 8:
                    _args[7]._obj.value = 0x1111 if hasattr(_args[7], "_obj") else None
                return stub.get_result

            @staticmethod
            def ConvertSecurityDescriptorToStringSecurityDescriptorW(
                _descriptor: Any, _revision: int, _information: int, text: Any, _length: Any,
            ) -> int:
                text._obj.value = f"O:{SID}D:PAI(A;OICI;FA;;;SY)"
                return 1

        return _Advapi32()

    def _kernel32(self) -> Any:
        stub = self

        class _Kernel32:
            @staticmethod
            def LocalFree(pointer: Any) -> None:
                stub.freed.append(pointer)

        return _Kernel32()


# Captured before any fixture runs. `tests/archive/conftest.py` replaces both
# of these with no-ops for the whole package, which is what keeps every other
# test from writing a real DACL; these tests need the real bodies, and the
# Win32 seam stays stubbed so "real" still means "no Win32 call".
_REAL_APPLY = store_permissions.apply_owner_only_dacl
_REAL_REPAIR = store_permissions.repair_store_tree


@pytest.fixture(autouse=True)
def real_bodies(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt this module *out* of the package-wide no-op seam.

    `tests/archive/conftest.py` replaces both functions for the whole package so
    no other test writes a real DACL. This module is where the real bodies are
    supposed to run -- with `_windows_apis` stubbed, so "real" still means no
    Win32 call. The two tests that assert on conftest's own no-op behaviour
    override this by naming the no-op fixtures as parameters.
    """
    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", _REAL_APPLY)
    monkeypatch.setattr(store_permissions, "repair_store_tree", _REAL_REPAIR)


@pytest.fixture(autouse=True)
def no_real_win32_by_omission(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed: reaching real Win32 raises unless a test stubbed it first.

    A test that forgot its `stub` fixture used to silently talk to the Windows
    API. This makes that a failure instead, so the safety of this file does not
    depend on every future author remembering.
    """

    def refuse() -> Any:
        raise AssertionError("a test reached the real Win32 API; stub _windows_apis")

    monkeypatch.setattr(store_permissions, "_windows_apis", refuse)


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> StubWin32:
    stub = StubWin32()
    monkeypatch.setattr(store_permissions, "_windows_apis", stub)
    # The real-permission opt-in is part of the sealed environment: the tests
    # here exercise the write path, and would otherwise stop at the gate that
    # exists to stop a *test run* from writing a DACL. Nothing real is reached
    # because `_windows_apis` above cannot call Windows.
    return stub


# --- the descriptor itself ---------------------------------------------------


def test_the_store_dacl_inherits_and_names_the_user_system_and_administrators() -> None:
    """The ACEs must pass down. The pipe SDDL's do not, and that is what broke
    this PC: applied to a folder, a non-inheriting ACE grants access to that
    folder and nothing inside it, so everything beneath lost its access."""
    sddl = folder_only_sddl(SID)
    assert sddl == f"O:{SID}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{SID})"
    # Every entry inherits to objects and containers alike.
    assert sddl.count("(A;OICI;FA;;;") == 3
    # No world or authenticated-users entry sneaks in.
    assert ";;;WD" not in sddl
    assert ";;;AU" not in sddl
    assert ";;;BU" not in sddl


def test_the_store_dacl_is_not_the_pipe_sddl() -> None:
    """The regression in one assertion. Reusing the pipe helper is the defect."""
    from jarvis_local.transport.pipe_server import owner_only_sddl

    pipe = owner_only_sddl(SID)
    assert "OI" not in pipe and "CI" not in pipe
    assert folder_only_sddl(SID) != pipe
    assert f"O:{SID}D:" in folder_only_sddl(SID)
    assert not pipe.startswith(f"O:{SID}")


def test_the_store_dacl_pins_the_owner() -> None:
    """Without `O:`, an elevated creator leaves the object owned by
    Administrators and `OW` in the inherited DACL stops naming the user."""
    assert folder_only_sddl(SID).startswith(f"O:{SID}D:")


@pytest.mark.parametrize("candidate", ["", "everyone", "S-1", "S-1-5-21-1-2-3-1001)(A;;GA;;;WD", "D:P(A;;GA;;;WD)"])
def test_a_sid_that_could_rewrite_the_descriptor_is_refused(candidate: str) -> None:
    with pytest.raises(ValueError, match="well-formed SID"):
        folder_only_sddl(candidate)


# --- what reaches SetNamedSecurityInfoW --------------------------------------


def test_the_dacl_is_written_before_the_owner_and_in_two_separate_calls(
    tmp_path: Path, stub: StubWin32,
) -> None:
    """The call order is the fix, so it is asserted directly.

    Windows checks whether the caller may set the owner against the DACL *as
    that same call receives it*, before applying the new one, so a single call
    carrying `OWNER | DACL | PROTECTED` is refused even when the new DACL would
    grant the caller everything. Measured 20/20 against a plain inherited folder,
    and as two calls it succeeded 20/20. Asserting only the combined effect would
    let the order regress silently.
    """
    root = tmp_path / "store"
    root.mkdir()
    stub.owner_sid = "S-1-5-21-9-9-9-1002"  # a different owner, so both calls run
    apply_owner_only_dacl(root, SID, store_root=tmp_path)

    assert stub.security_information == [_DACL | _PROTECTED_DACL, _OWNER], stub.security_information
    # The DACL call carries no owner, the owner call carries a real SID pointer.
    assert stub.owners[0] is None, "the DACL call must not also set the owner"
    assert stub.owners[1] is not None, "the owner call must carry a real SID pointer"
    assert stub.acls[0] is not None and stub.acls[1] is not None
    # Both calls hand Windows the same descriptor: the owner call carries the
    # DACL too (a security-information write always carries the whole ACL), it
    # simply does not ask for the DACL to be changed.
    assert stub.sddls == [folder_only_sddl(SID)] * 2, stub.sddls
    assert f";;;{SID})" in stub.sddls[0]


def test_the_owner_call_is_skipped_when_the_owner_already_matches(tmp_path: Path, stub: StubWin32) -> None:
    """The healthy case: a store already owned by its user gets one write, not two."""
    root = tmp_path / "store"
    root.mkdir()
    stub.owner_sid = SID
    apply_owner_only_dacl(root, SID, store_root=tmp_path)

    assert stub.security_information == [_DACL | _PROTECTED_DACL], "a matching owner must not be rewritten"


def test_an_owner_failure_after_a_successful_dacl_write_raises(tmp_path: Path, stub: StubWin32) -> None:
    """Unexpected, so it raises rather than degrading.

    The DACL has already been applied at that point, so the store stays
    reachable -- but the owner is half the original defect, and a silently
    unchanged owner is how that half comes back.
    """
    root = tmp_path / "store"
    root.mkdir()
    stub.owner_sid = "S-1-5-21-9-9-9-1002"
    stub.set_results = [0, 5]  # DACL succeeds, then the owner write is refused

    with pytest.raises(OSError, match="Access is denied"):
        apply_owner_only_dacl(root, SID, store_root=tmp_path)
    assert stub.security_information == [_DACL | _PROTECTED_DACL, _OWNER]


def test_a_refused_dacl_write_names_the_one_time_fix_and_changes_nothing(
    tmp_path: Path, stub: StubWin32,
) -> None:
    """The case that actually happens: an Administrators-owned store, non-elevated.

    Nothing this process can do will change it, so the message has to carry the
    fix -- and because the DACL is the first call, a failure leaves the store
    exactly as it was rather than half-changed.
    """
    root = tmp_path / "store"
    root.mkdir()
    stub.set_results = [5]

    with pytest.raises(store_permissions.StoreDaclRefusedError) as raised:
        apply_owner_only_dacl(root, SID, store_root=tmp_path)

    message = str(raised.value)
    assert "jarvis serve" in message and "elevated" in message, message
    assert "icacls" in message and os.fspath(root) in message, message
    # Only the DACL was attempted; the owner call never ran.
    assert stub.security_information == [_DACL | _PROTECTED_DACL], stub.security_information


def test_a_failed_call_never_leaves_a_folder_without_an_entry_for_the_user(
    tmp_path: Path, stub: StubWin32,
) -> None:
    """The `ownertest` folder was left with no ACE for Sid at all.

    That happened because `mkdir(mode=0o700)` had already created a protected
    DACL and the module's single combined call then failed, so the intended
    entries were never written -- and Sid could not even delete the folder. With
    the DACL first, the only failure that can leave a folder unreadable is the
    DACL write itself, and that one happens before anything changed. This asserts
    that whichever call fails, every descriptor handed to Windows names the user.
    """
    root = tmp_path / "store"
    root.mkdir()

    for set_results, label in ([[5], "DACL refused"], [[0, 5], "owner refused after DACL"]):
        stub.set_results = list(set_results)
        stub.security_information.clear()
        stub.sddls.clear()
        stub.owner_sid = "S-1-5-21-9-9-9-1002"
        with pytest.raises((store_permissions.StoreDaclRefusedError, OSError)):
            apply_owner_only_dacl(root, SID, store_root=tmp_path)
        assert stub.sddls, f"{label}: no descriptor was built"
        assert all(f";;;{SID})" in sddl for sddl in stub.sddls), (label, stub.sddls)
        assert all("(A;OICI;FA;;;" in sddl for sddl in stub.sddls), (label, stub.sddls)


def test_a_refused_path_is_never_handed_to_windows(tmp_path: Path, stub: StubWin32) -> None:
    """The guard runs before the call, not after. If this ever inverted, the
    rewrite would already have happened by the time the check fired."""
    root = tmp_path / "store"
    root.mkdir()
    with pytest.raises(UnsafeStorePathError):
        apply_owner_only_dacl(tmp_path, SID, store_root=root)
    assert stub.paths == []


def test_a_failed_set_reports_the_result_code_not_the_last_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stub: StubWin32,
) -> None:
    """`SetNamedSecurityInfoW` returns the error; it does not set last-error."""
    import ctypes

    monkeypatch.setattr(ctypes, "WinError", lambda code: OSError(f"code={code}"))
    stub.set_results = [87]  # the DACL call is the first one, and it fails
    root = tmp_path / "store"
    data = root / "data"
    data.mkdir(parents=True)
    with pytest.raises(store_permissions.StoreDaclRefusedError, match="code=87"):
        apply_owner_only_dacl(data, SID, store_root=root)


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    "candidate",
    ["C:\\", "C:\\Users", "C:\\Users\\Public", "C:\\Program Files", "C:\\ProgramData", "C:\\Windows"],
)
def test_the_guard_refuses_drive_roots_and_windows_owned_locations(candidate: str) -> None:
    with pytest.raises(UnsafeStorePathError):
        _refuse_unsafe_path(Path(candidate), Path(r"C:\store"))


def test_the_guard_refuses_anything_above_the_store_root() -> None:
    """The exact walk that emptied a profile. `C:\\Users\\Sid` must never be an
    argument, whatever the caller computed."""
    store_root = Path(r"C:\Users\Sid\AppData\Local\Jarvis\data")
    for above in (
        Path(r"C:\Users\Sid"),
        Path(r"C:\Users"),
        Path(r"C:\Users\Sid\AppData"),
        Path(r"C:\Users\Sid\AppData\Local"),
        Path(r"C:\Users\Sid\AppData\Local\Jarvis"),
    ):
        with pytest.raises(UnsafeStorePathError):
            _refuse_unsafe_path(above, store_root)


def test_the_guard_allows_the_real_store_and_its_children(tmp_path: Path) -> None:
    """The other direction, and the reason ancestor matching is by relationship
    rather than by name: the real store has `Users` in its ancestry."""
    root = tmp_path / "AppData" / "Local" / "Jarvis"
    root.mkdir(parents=True)
    data = root / "data"
    data.mkdir()
    assert _refuse_unsafe_path(root, root) == root.resolve()
    assert _refuse_unsafe_path(data, root) == data.resolve()


def test_the_guard_refuses_a_path_outside_the_store_root(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    other = tmp_path / "elsewhere"
    other.mkdir()
    with pytest.raises(UnsafeStorePathError, match="not at or inside the store root"):
        _refuse_unsafe_path(other, root)


# --- descend-only repair -----------------------------------------------------


def test_repair_never_touches_a_parent_of_the_store_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The regression test. The first version looped over `path.parents` up to
    the drive root; `C:\\Users\\Sid` was one of them."""
    root = tmp_path / "profile" / "AppData" / "Local" / "Jarvis" / "data"
    root.mkdir(parents=True)
    touched: list[Path] = []

    def record(path: Path, user_sid: str, *, store_root: Path) -> None:
        touched.append(Path(path))

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", record)
    repair_store_tree(root, SID)

    assert touched, "the walk visited nothing at all"
    assert all(path == root or root in path.parents for path in touched)
    for above in (tmp_path / "profile" / "AppData" / "Local" / "Jarvis", tmp_path / "profile"):
        assert above not in touched


def test_repair_calls_the_guard_for_every_path_it_visits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stub: StubWin32,
) -> None:
    """Every write is checked at the moment of writing, so a bug in the walk
    itself is caught by the guard rather than by the next incident."""
    root = tmp_path / "store"
    (root / "nested").mkdir(parents=True)
    checked: list[Path] = []
    original = store_permissions._refuse_unsafe_path

    def spy(path: Path, store_root: Path) -> Path:
        checked.append(Path(path))
        return original(path, store_root)

    monkeypatch.setattr(store_permissions, "_refuse_unsafe_path", spy)
    repair_store_tree(root, SID)
    assert {root, root / "nested"} <= set(checked)


def test_repair_reports_and_logs_a_walk_error_instead_of_discarding_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, stub: StubWin32,
) -> None:
    """The first version swallowed refusals into a return value nobody read."""
    root = tmp_path / "store"
    (root / "denied").mkdir(parents=True)

    def walk(_root: str, *, followlinks: bool, onerror: Any) -> Any:
        yield str(root), ["denied"], []
        onerror(OSError(13, "Permission denied", str(root / "denied")))

    monkeypatch.setattr(os, "walk", walk)
    with caplog.at_level(logging.WARNING):
        failures = repair_store_tree(root, SID)

    assert root / "denied" in failures
    assert any("denied" in record.getMessage() for record in caplog.records)


def test_repair_logs_a_directory_it_could_not_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    root = tmp_path / "store"
    root.mkdir()

    def refuse(path: Path, user_sid: str, *, store_root: Path) -> None:
        raise OSError(5, "Access is denied", str(path))

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", refuse)
    with caplog.at_level(logging.WARNING):
        failures = repair_store_tree(root, SID)

    assert failures == (root,)
    assert any("Access is denied" in record.getMessage() for record in caplog.records)


# --- where the boundary comes from ------------------------------------------


def test_the_store_root_comes_from_the_configured_data_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The boundary is the configured store, not the path being changed.

    An earlier version took `store_root = path.parent`, which made every
    containment check vacuously true: the code choosing a target also chose the
    boundary, so any path passed. This pins the derivation to configuration.
    """
    configured = tmp_path / "Jarvis" / "data"
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(configured / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(configured / "memory.sqlite3"))

    roots = store_permissions.configured_store_roots()
    assert roots == (configured.resolve(),), roots
    # The boundary is the store's directory, and deliberately not the store's
    # parent's parent or anything else that would widen it.
    assert configured.parent not in roots


def test_a_path_outside_the_configured_root_is_refused_and_windows_is_never_reached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case that matters: an opted-in caller naming something it should not.

    `C:\\Users\\Sid\\Documents` is not a store, and with the gate open and the
    configured root set the call must still raise -- and must raise *before*
    Win32, so nothing was written by the attempt.
    """
    configured = tmp_path / "Jarvis" / "data"
    configured.mkdir(parents=True)
    (tmp_path / "Documents").mkdir()
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(configured / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(configured / "memory.sqlite3"))
    stub = StubWin32()
    monkeypatch.setattr(store_permissions, "_windows_apis", stub)

    outside = tmp_path / "Documents"
    # `store_root=outside.parent` is the shape the old code used, and it is
    # exactly what must no longer be sufficient: it satisfies the containment
    # check, so only the configured-root boundary can refuse this.
    monkeypatch.setattr(
        store_permissions, "configured_store_roots", lambda: (configured.resolve(),)
    )
    assert outside.parent not in store_permissions.configured_store_roots()
    with pytest.raises(UnsafeStorePathError, match="outside every configured store root"):
        _REAL_APPLY(outside, SID, store_root=outside.parent)
    assert stub.paths == [], "Win32 was reached for a path outside the configured root"


def test_a_store_directory_outside_the_configured_root_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same rule through the open path, not just a direct DACL call.

    A store path pointing outside the configured root must fail while the
    directory is being made private, rather than being accepted because the
    caller derived a boundary that happened to contain it.
    """
    configured = tmp_path / "Jarvis" / "data"
    configured.mkdir(parents=True)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(configured / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(configured / "memory.sqlite3"))

    elsewhere = tmp_path / "elsewhere" / "store"
    with pytest.raises(archive_database.SQLiteDirectoryError, match="outside every configured store root"):
        archive_database._ensure_sqlite_directory(elsewhere)


def test_creating_a_store_directory_uses_the_configured_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every created component is bounded by the configured root."""
    seen: list[tuple[Path, Path]] = []

    def record(path: Path, user_sid: str, *, store_root: Path) -> None:
        seen.append((Path(path), Path(store_root)))
        Path(path).mkdir(parents=True, exist_ok=True)

    store = tmp_path / "outer" / "inner"
    monkeypatch.setattr(store_permissions, "ensure_private_directory", record)
    # The directory now exists, so the helper takes the repair branch. Stubbed
    # too: this test is about which boundary is *passed*, and without it a real
    # DACL would be written onto a pytest temp directory.
    monkeypatch.setattr(archive_database, "repair_store_permissions", lambda _path, **_kw: ())
    monkeypatch.setattr(archive_database, "_is_posix", lambda: False)
    archive_database._ensure_sqlite_directory(store)

    # Both missing components are created, each bounded by the *configured*
    # root rather than by the directory being created -- which is the property
    # that makes the guard meaningful.
    assert seen == [(tmp_path / "outer", tmp_path), (store, tmp_path)]


def test_the_store_directory_helper_refuses_a_database_file_path(tmp_path: Path) -> None:
    """The test bug that started the incident: the helper was handed
    `archive.sqlite3` and created a *directory* of that name."""
    with pytest.raises(archive_database.SQLiteDirectoryError, match="not the store directory"):
        archive_database._ensure_sqlite_directory(tmp_path / "archive.sqlite3")


def test_repair_validates_against_the_boundary_it_is_given_not_the_walk_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`store_root` must reach the guard, not be quietly replaced by `root`.

    `repair_store_tree` takes both because the walk chooses directories and a
    walk that also chose the boundary would be free to reach anything. Every
    other test here passes them as the same value, so an implementation that
    dropped the parameter and used `root` would look identical -- which is
    exactly the shape of the defect this module came from.
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    seen: list[Path] = []
    original = store_permissions._refuse_unsafe_path

    def spy(path: Path, store_root: Path) -> Path:
        seen.append(store_root)
        return original(path, store_root)

    monkeypatch.setattr(store_permissions, "_refuse_unsafe_path", spy)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(outside / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(outside / "memory.sqlite3"))
    monkeypatch.setattr(store_permissions, "_windows_apis", StubWin32())

    # The walk root is not inside the boundary handed in, so every directory is
    # refused and collected -- a repair is best-effort and does not raise.
    failures = _REAL_REPAIR(outside, SID, store_root=tmp_path / "elsewhere")
    assert failures == (outside,), failures
    # And the boundary the guard actually received was the one passed, never the
    # walk root it would have defaulted to. This is the assertion the mutation
    # trips: dropping the parameter makes the two identical.
    assert seen, "the guard was never called"
    assert all(boundary != outside for boundary in seen), seen


def test_the_real_functions_accept_the_keywords_the_open_path_passes() -> None:
    """A signature mismatch that the seam stub hid, and that nothing caught.

    The suite replaces `apply_owner_only_dacl` and `repair_store_tree` with
    stubs. A stub written with `**_kwargs` silently swallows a call the real
    function cannot accept, so a keyword added on one side and not the other
    passes every test and fails only in production -- which is exactly what
    happened with `repair_store_tree(..., store_root=...)`. This asserts the
    real signatures, not the stubs.
    """
    import inspect

    for function, expected in (
        (store_permissions.apply_owner_only_dacl, {"store_root"}),
        (store_permissions.repair_store_tree, {"store_root"}),
        (store_permissions.ensure_private_directory, {"store_root"}),
    ):
        parameters = inspect.signature(function).parameters
        assert expected <= set(parameters), f"{function.__name__} lost {expected - set(parameters)}"
        for name in expected:
            assert parameters[name].kind is inspect.Parameter.KEYWORD_ONLY, (
                f"{function.__name__}: {name} must stay keyword-only so callers cannot pass it positionally"
            )


def test_no_gate_environment_variable_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    """The opt-in gate was removed, and this keeps it removed.

    `JARVIS_ALLOW_REAL_DACL` gated every real DACL write, and it broke `jarvis
    vault` and the compatibility gate -- commands that worked before. The safety
    it was supposed to add is the boundary check, which is unconditional, and
    the suite's own seam replacement. A gate that silently disables a legitimate
    command is worse than no gate, so it must not come back by accident.
    """
    assert "JARVIS_ALLOW_REAL_DACL" not in os.environ
    assert not hasattr(store_permissions, "real_dacl_permitted")
    assert not hasattr(store_permissions, "permit_real_dacl")
    assert not hasattr(store_permissions, "RealDaclNotPermittedError")


def test_unset_store_paths_fall_back_to_the_jarvis_data_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Unset must never mean "no boundary" -- it means the fixed default.

    This is the second version of the same mistake: the roots used to come back
    empty, and the guard skipped its check on an empty result, so a missing
    configuration removed the guard on the one call that changes permissions.
    """
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_MEMORY_PATH", raising=False)
    local_app_data = tmp_path / "AppData" / "Local"
    local_app_data.mkdir(parents=True)
    monkeypatch.setenv("LOCALAPPDATA", os.fspath(local_app_data))

    roots = store_permissions.configured_store_roots()
    assert roots == (local_app_data / "Jarvis",), roots
    assert roots, "an empty result would disable the guard"


def test_a_path_outside_the_default_root_is_refused_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The default is a boundary, so the check still refuses."""
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_MEMORY_PATH", raising=False)
    local_app_data = tmp_path / "AppData" / "Local"
    (local_app_data / "Jarvis").mkdir(parents=True)
    documents = tmp_path / "Documents"
    documents.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", os.fspath(local_app_data))
    stub = StubWin32()
    monkeypatch.setattr(store_permissions, "_windows_apis", stub)

    # `store_root=documents` is the shape that isolates this check: it satisfies
    # the containment test, so only the default-root boundary can refuse it.
    with pytest.raises(UnsafeStorePathError, match="outside every configured store root"):
        _REAL_APPLY(documents / "notes.txt", SID, store_root=documents)
    assert stub.paths == [], "Win32 was reached for a path outside the default root"


def test_an_empty_store_path_is_refused_rather_than_falling_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Set-but-empty is a misconfiguration, not an invitation to fall back.

    Falling back from a blank value would hide a broken configuration and widen
    the boundary an administrator believed they had set, so it fails loudly.
    """
    monkeypatch.setenv("LOCALAPPDATA", os.fspath(tmp_path / "AppData" / "Local"))
    for variable in ("JARVIS_ARCHIVE_PATH", "JARVIS_MEMORY_PATH"):
        monkeypatch.setenv(variable, "   ")
        with pytest.raises(store_permissions.StoreRootUnresolvedError, match="set but empty"):
            store_permissions.configured_store_roots()


def test_a_broad_store_root_is_refused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A boundary that wide is barely a boundary, so it is refused where set."""
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("TEMP", os.fspath(tmp_path))
    with pytest.raises(store_permissions.StoreRootUnresolvedError, match="is not a store root"):
        store_permissions.configured_store_roots()


def test_the_startup_summary_names_the_default_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stub: StubWin32,
) -> None:
    """The log must distinguish the fallback from a configured choice.

    `store_root_summary` now also reports ownership, so it reads the owner of any
    root that exists -- which is why this needs the Win32 seam stubbed too.
    """
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_MEMORY_PATH", raising=False)
    local_app_data = tmp_path / "AppData" / "Local"
    (local_app_data / "Jarvis").mkdir(parents=True)
    monkeypatch.setenv("LOCALAPPDATA", os.fspath(local_app_data))
    stub.owner_sid = SID

    assert store_root_summary() == f"{local_app_data / 'Jarvis'} (default; no store path configured)"

    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    assert store_root_summary() == os.fspath(tmp_path)


def test_the_startup_summary_reports_an_unresolvable_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    """A service that is going to refuse should say why in the log first."""
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", "")
    assert store_root_summary().startswith("unresolved (")


def test_tree_owner_sddl_reports_the_returned_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """`GetNamedSecurityInfoW` returns the error rather than setting last-error,
    so the old `WinError(get_last_error())` named an unrelated earlier failure."""
    import ctypes

    monkeypatch.setattr(ctypes, "WinError", lambda code: OSError(f"code={code}"))
    monkeypatch.setattr(store_permissions, "_windows_apis", StubWin32(get_result=5))
    with pytest.raises(OSError, match="code=5"):
        tree_owner_sddl(Path(r"C:\store"))
