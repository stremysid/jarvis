"""The store-permission module, tested without ever changing a real permission.

Nothing in this file may call `SetNamedSecurityInfoW`. The module under test
rewrote Sid's entire user profile twice on 2026-09-22 by being exercised against
the real filesystem, so every test here either checks a pure string, or replaces
`_windows_apis` with a stub and asserts on what *would* have been passed. The
one real integration test lives in `tests/integration` and runs only inside
`C:\\jarvis-test-scratch`.
"""

from __future__ import annotations

import ctypes
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from jarvis_local.archive import database as archive_database
from jarvis_local.archive import store_permissions
from jarvis_local.archive.store_permissions import (
    UnsafeStorePathError,
    _refuse_unsafe_path,
    apply_owner_only_dacl,
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
            def ConvertStringSecurityDescriptorToSecurityDescriptorW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name

                sddl: str, _revision: int, descriptor: Any, _length: Any,
            ) -> int:
                stub.sddls.append(sddl)
                descriptor._obj.value = 0x1234
                return 1

            @staticmethod
            def ConvertStringSidToSidW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name
_sid: str, owner: Any) -> int:
                owner._obj.value = 0x5678
                return 1

            @staticmethod
            def ConvertSidToStringSidW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name
_owner: Any, text: Any) -> int:
                text._obj.value = stub.owner_sid
                return 1

            @staticmethod
            def GetSecurityDescriptorOwner(  # noqa: N802  # noqa: N802 - stands in for the Win32 name
_descriptor: Any, owner: Any, defaulted: Any) -> int:
                owner._obj.value = 0x1111
                defaulted._obj.value = 0
                return 1

            @staticmethod
            def GetSecurityDescriptorDacl(  # noqa: N802  # noqa: N802 - stands in for the Win32 name

                _descriptor: Any, present: Any, acl: Any, defaulted: Any,
            ) -> int:
                present._obj.value = 1
                defaulted._obj.value = 0
                acl._obj.value = 0x9ABC
                return 1

            @staticmethod
            def SetNamedSecurityInfoW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name

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
            def GetNamedSecurityInfoW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name
*_args: Any) -> int:
                if stub.get_result == 0 and len(_args) >= 8:
                    _args[7]._obj.value = 0x1111 if hasattr(_args[7], "_obj") else None
                return stub.get_result

            @staticmethod
            def ConvertSecurityDescriptorToStringSecurityDescriptorW(  # noqa: N802  # noqa: N802 - stands in for the Win32 name

                _descriptor: Any, _revision: int, _information: int, text: Any, _length: Any,
            ) -> int:
                text._obj.value = f"O:{SID}D:PAI(A;OICI;FA;;;SY)"
                return 1

        return _Advapi32()

    def _kernel32(self) -> Any:
        stub = self

        class _Kernel32:
            @staticmethod
            def LocalFree(  # noqa: N802  # noqa: N802 - stands in for the Win32 name
pointer: Any) -> None:
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


#: The Win32 error text for the two codes these tests make the module raise, so
#: the fake `ctypes.WinError` below produces a message a real one would.
_WIN32_MESSAGES = {5: "Access is denied", 87: "The parameter is incorrect"}


@pytest.fixture
def windows_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Supply `ctypes.WinError` on a host that has no such attribute.

    `ctypes.WinError` is Windows-only. On POSIX `ctypes` has no `WinError` at
    all, so every error path in `store_permissions` raised `AttributeError`
    instead of the `OSError` it means to raise -- and six tests in this file
    failed on the Ubuntu job for a reason unrelated to what they assert.

    `raising=False` is required, and is the whole point: on POSIX the attribute
    does not exist to be replaced, and a plain `setattr` refuses to add it. On a
    Windows job the same line replaces the real one, so the fake has to produce
    a message good enough to match -- hence the table above rather than a code
    echoed back.
    """
    def win_error(code: int) -> OSError:
        return OSError(0, _WIN32_MESSAGES.get(code, f"error {code}"), None, code)

    monkeypatch.setattr(ctypes, "WinError", win_error, raising=False)


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


def test_an_owner_failure_after_a_successful_dacl_write_raises(
    tmp_path: Path, stub: StubWin32, windows_error: None,
) -> None:
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
    tmp_path: Path, stub: StubWin32, windows_error: None,
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
    tmp_path: Path, stub: StubWin32, windows_error: None,
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

    for set_results, label in (([5], "DACL refused"), ([0, 5], "owner refused after DACL")):
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
    monkeypatch.setattr(ctypes, "WinError", lambda code: OSError(f"code={code}"), raising=False)
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


def test_an_unreadable_directory_does_not_abandon_the_siblings_that_could_be_repaired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """A walk error is one unlucky subtree, not a wrong boundary.

    `record` used to set `aborted`, which stopped the whole walk at the first
    `os.walk` error -- so a single directory the process could not list abandoned
    every sibling that could still have been repaired, on the tree that needs
    repairing most. Only a *guard* refusal aborts: that one means the boundary or
    the caller is wrong, and every directory below would be refused identically.

    The generator yields the first sibling, calls `onerror` for it, then yields
    the second -- exactly the order `os.walk` uses, so a walk that aborted stays
    visible as the second sibling never being written.
    """
    root = tmp_path / "Jarvis" / "data"
    root.mkdir(parents=True)
    for name in ("a", "b"):
        (root / name).mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path / "Jarvis")
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(root / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(root / "memory.sqlite3"))

    written: list[Path] = []

    def record(path: Path, user_sid: str, *, store_root: Path) -> None:
        written.append(Path(path).resolve())

    def walk(_top: str, *, followlinks: bool, onerror: Any) -> Any:
        yield str(root), ["a", "b"], []
        onerror(OSError(13, "Permission denied", str(root / "a")))
        yield str(root / "b"), [], []

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", record)
    monkeypatch.setattr(os, "walk", walk)
    with caplog.at_level(logging.WARNING):
        failures = repair_store_tree(root, SID, store_root=root)

    assert failures == (root / "a",), failures
    assert (root / "b").resolve() in written, "the sibling after the unreadable directory was abandoned"
    assert any("Permission denied" in record.getMessage() for record in caplog.records)
    assert (root).resolve() in written, "the root itself was abandoned"


def test_a_refused_dacl_write_does_not_abort_the_walk_either(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """The Administrators-owned folder is recoverable, so it is not an abort.

    `StoreDaclRefusedError` is a `RuntimeError`, not an `OSError`, so it is
    caught explicitly -- without that arm it propagates out of `repair_store_tree`
    and the whole repair ends in a traceback on the one folder an elevated run
    can still fix. `UnsafeStorePathError` is the *only* abort.
    """
    root = tmp_path / "Jarvis" / "data"
    root.mkdir(parents=True)
    for name in ("a", "b"):
        (root / name).mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path / "Jarvis")
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(root / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(root / "memory.sqlite3"))

    written: list[Path] = []

    def refuse_a(path: Path, user_sid: str, *, store_root: Path) -> None:
        resolved = Path(path).resolve()
        if resolved == (root / "a").resolve():
            raise store_permissions.StoreDaclRefusedError("cannot set the permissions of the store")
        written.append(resolved)

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", refuse_a)
    with caplog.at_level(logging.WARNING):
        failures = repair_store_tree(root, SID, store_root=root)

    assert (root / "a") in failures, failures
    assert (root / "b").resolve() in written, "the sibling after the refused DACL write was abandoned"
    assert any("cannot set the permissions" in record.getMessage() for record in caplog.records)


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
    # `_make_directory_private` evaluates `current_user_sid()` as an argument,
    # before it calls whatever `ensure_private_directory` is -- so replacing the
    # function does not stop the real one from being reached, and on Linux that
    # is `ctypes.WinDLL`, which does not exist. Stubbed here rather than faking
    # `ctypes.WinDLL`: `pipe_server._win32` also does `from ctypes import
    # wintypes`, which raises on a host with no Win32 types whatever `WinDLL` is
    # bound to, so a fake DLL name would only move the failure.
    monkeypatch.setattr("jarvis_local.transport.pipe_server.current_user_sid", lambda: SID)
    # The directory now exists, so the helper takes the repair branch. Stubbed
    # too: this test is about which boundary is *passed*, and without it a real
    # DACL would be written onto a pytest temp directory.
    monkeypatch.setattr(archive_database, "repair_store_permissions", lambda _path, **_kw: ())
    monkeypatch.setattr(archive_database, "_is_posix", lambda: False)
    # `repair_permissions=True` is the creating open. The default is now the
    # read-only opener, which refuses a store that is not there -- so a test
    # about *creating* the components has to ask for the creating behaviour.
    archive_database._ensure_sqlite_directory(store, repair_permissions=True)

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
    # The resolver is patched rather than LOCALAPPDATA being set: the real one
    # branches on os.name, so setting the Windows variable made this test pass on
    # Windows and fail on Ubuntu for identical code. What is under test is that an
    # unset configuration falls back to a real root, not which root Windows picks.
    jarvis_dir = tmp_path / "Jarvis"
    jarvis_dir.mkdir(parents=True)
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: jarvis_dir)

    roots = store_permissions.configured_store_roots()
    assert roots == (jarvis_dir.resolve(),), roots
    assert roots, "an empty result would disable the guard"


def test_a_path_outside_the_default_root_is_refused_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The default is a boundary, so the check still refuses."""
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_MEMORY_PATH", raising=False)
    jarvis_dir = tmp_path / "Jarvis"
    jarvis_dir.mkdir(parents=True)
    documents = tmp_path / "Documents"
    documents.mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: jarvis_dir)
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

    `current_user_sid` is stubbed as well, because it is a *different* seam from
    `_windows_apis`: it lives in the pipe server and reaches real Win32 on a
    Windows runner, so the runner's true SID was being compared against the
    stub's owner and the summary came back with a warning appended. The stub
    owner and the stub user have to be the same SID for "all is well" to be the
    case under test.
    """
    monkeypatch.delenv("JARVIS_ARCHIVE_PATH", raising=False)
    monkeypatch.delenv("JARVIS_MEMORY_PATH", raising=False)
    jarvis_dir = tmp_path / "Jarvis"
    jarvis_dir.mkdir(parents=True)
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: jarvis_dir)
    monkeypatch.setattr(store_permissions, "current_user_sid", lambda: SID)
    stub.owner_sid = SID

    assert store_root_summary() == f"{jarvis_dir} (default; no store path configured)"

    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    assert store_root_summary() == os.fspath(tmp_path)


def test_the_startup_summary_reports_an_unresolvable_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    """A service that is going to refuse should say why in the log first."""
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", "")
    assert store_root_summary().startswith("unresolved (")


def test_tree_owner_sddl_reports_the_returned_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """`GetNamedSecurityInfoW` returns the error rather than setting last-error,
    so the old `WinError(get_last_error())` named an unrelated earlier failure."""
    monkeypatch.setattr(ctypes, "WinError", lambda code: OSError(f"code={code}"), raising=False)
    monkeypatch.setattr(store_permissions, "_windows_apis", StubWin32(get_result=5))
    with pytest.raises(OSError, match="code=5"):
        tree_owner_sddl(Path(r"C:\store"))


@pytest.mark.skipif(os.name != "nt", reason="these are the machine's own Windows paths")
@pytest.mark.parametrize(
    ("variable", "pattern"),
    [
        ("LOCALAPPDATA", r"refusing LOCALAPPDATA"),
        ("APPDATA", r"refusing APPDATA"),
        ("TEMP", r"refusing TEMP"),
    ],
)
def test_each_named_environment_root_is_refused_on_its_own(
    monkeypatch: pytest.MonkeyPatch, variable: str, pattern: str,
) -> None:
    r"""Each refusal has to be reachable on its own, or it is decoration.

    The shape is what makes this a test of the *named* arm rather than of
    whichever check fires first: `_refuse_unsafe_path` is handed the root **as
    its own store root**, so containment passes trivially, and the
    configured-roots check is answered by pointing `configured_store_roots` at
    the same path. `_refuse_broad_root` is neutered for the same reason and only
    here: otherwise it answers first (`LOCALAPPDATA is not a store root`) and the
    test skips, which is how the previous version of this test could not tell
    this arm from decoration.

    **The message is matched, unlike before.** With every other arm satisfied or
    disabled, the sentence that comes back can only have come from this one, and
    asserting it is what makes a *different* arm answering show up as a failure
    rather than as a pass.
    """
    root = Path(os.environ[variable]).resolve(strict=False)
    if root.parent == root:
        pytest.skip(f"{root} has no parent to use as a boundary")
    monkeypatch.setattr(store_permissions, "configured_store_roots", lambda: (root,))
    monkeypatch.setattr(store_permissions, "_refuse_broad_root", lambda _root: None)

    with pytest.raises(UnsafeStorePathError, match=pattern):
        _refuse_unsafe_path(root, root)


@pytest.mark.skipif(os.name != "nt", reason="these are the machine's own Windows paths")
def test_appdata_itself_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    r"""`AppData` sits above both roaming and local, and is named by neither.

    It has no environment variable of its own, so the environment-root arm cannot
    see it and it needs an arm derived from `USERPROFILE`. Called directly, with
    the root as its own store root and the configured-roots check pointed at it,
    so only this arm can answer -- `%USERPROFILE%` itself is a different refusal
    one directory up, and matching `refusing USERPROFILE` alone would not tell
    the two apart.
    """
    app_data = Path(os.environ["USERPROFILE"]) / "AppData"
    if not app_data.is_dir():
        pytest.skip(f"{app_data} does not exist on this machine")
    monkeypatch.setattr(store_permissions, "configured_store_roots", lambda: (app_data.resolve(strict=False),))
    monkeypatch.setattr(store_permissions, "_refuse_broad_root", lambda _root: None)

    with pytest.raises(UnsafeStorePathError, match=r"refusing USERPROFILE\\AppData"):
        _refuse_unsafe_path(app_data, app_data)


def test_each_named_absolute_root_is_refused_by_that_arm() -> None:
    """The literal list, each entry rejected **by its own arm**.

    Asserts the message, unlike the test above, because here the arm is the point:
    each path is handed in with a store root that contains it, so containment and
    the configured-roots check both pass and the literal-match arm is what must
    reject it. The Windows-owned names are excluded deliberately -- they have their
    own arm, and it fires first for `Program Files`.
    """
    for entry in (r"C:\Users", r"C:\Users\Public", r"C:\ProgramData"):
        with pytest.raises(UnsafeStorePathError, match="refusing a system or account root"):
            _refuse_unsafe_path(Path(entry), Path(entry))


def test_a_drive_root_is_refused_by_that_arm() -> None:
    """A drive root is refused by the drive/filesystem-root arm, not by luck.

    Called directly so the arm under test is the one that answers: `_REAL_APPLY`
    would reach the "no name" check first for `C:\\`, which is a different
    refusal entirely.
    """
    if os.name != "nt":
        pytest.skip("a drive root is a Windows shape")
    drive = Path(os.environ.get("SYSTEMDRIVE", "C:") + "\\")
    with pytest.raises(UnsafeStorePathError) as raised:
        _refuse_unsafe_path(drive, drive)
    assert "drive or filesystem root" in str(raised.value), raised.value


def test_the_broad_root_refusal_names_its_own_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured root that is a filesystem root is refused, and says why.

    Its own test because this arm is one a mutation survives: removing
    `_refuse_broad_root` leaves the rest of the suite green.
    """
    drive = Path(os.environ.get("SYSTEMDRIVE", "C:") + "\\") if os.name == "nt" else Path("/")
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(drive / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(drive / "memory.sqlite3"))
    with pytest.raises(store_permissions.StoreRootUnresolvedError, match="filesystem root is not a store root"):
        store_permissions.configured_store_roots()


@pytest.mark.skipif(os.name != "nt", reason="a Windows path only has these parts on Windows")
def test_the_windows_owned_name_arm_refuses_on_its_own() -> None:
    r"""The name-based arm, called directly so nothing else can answer first.

    `C:\Program Files` is refused by this arm and by no other: it is not in the
    literal list, and its parent is not a configured root here. Asserting through
    `_REAL_APPLY` would still pass if this arm were deleted, because the literal
    list would eventually catch it -- which is how this mutation survived.

    Windows-only, because the arm matches a **path part** and POSIX `pathlib`
    does not split on a backslash: on Ubuntu `Path(r"C:\Program Files")` is one
    part, `C:\Program Files`, so the arm cannot fire and the containment check
    answers instead -- a different refusal with a different sentence, which is
    what `match=` turned into a red Ubuntu job. There is no POSIX spelling of
    this input, so the test is skipped rather than rewritten.
    """
    for entry in (r"C:\Program Files", r"C:\Program Files (x86)", r"C:\Windows"):
        refused = Path(entry)
        with pytest.raises(UnsafeStorePathError, match="directory Windows owns"):
            _refuse_unsafe_path(refused / "store", Path(entry))


@pytest.mark.skipif(os.name != "nt", reason="these are the machine's own Windows paths")
def test_the_environment_root_arm_refuses_on_its_own() -> None:
    """The `%USERPROFILE%` arm, called directly, with the env var set for real.

    Through `_REAL_APPLY` this cannot be pinned: the broad-root arm refuses the
    profile first, so the test skips whatever the environment-root arm does, and
    deleting that arm changes nothing observable. Called directly, with the
    variable actually set to the path, only this arm can answer.
    """
    profile = Path(os.environ["USERPROFILE"]).resolve(strict=False)
    assert os.environ.get("USERPROFILE", "").strip(), "USERPROFILE must be set for this to mean anything"
    with pytest.raises(UnsafeStorePathError, match=r"refusing USERPROFILE"):
        _refuse_unsafe_path(profile, profile.parent)


# --- the allowlist, and the read-only opener ---------------------------------


def test_a_store_root_outside_the_permitted_location_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The allowlist refuses by default rather than listing known-bad places.

    A denylist answers "is this one of the bad ones" and is wrong for every bad
    place nobody thought of. The question that matters before a process starts
    changing ACLs is "is this one of the good ones", so a directory that is
    merely *unlisted* -- not a drive root, not the profile, not Temp -- must
    still be refused.
    """
    permitted = tmp_path / "Jarvis"
    permitted.mkdir()
    elsewhere = tmp_path / "Documents" / "notes"
    elsewhere.mkdir(parents=True)
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: permitted)

    with pytest.raises(store_permissions.StoreRootUnresolvedError, match="outside the only permitted store location"):
        store_permissions.permit_store_roots((elsewhere,))
    # And the permitted location itself, and anything beneath it, is allowed.
    assert store_permissions.permit_store_roots((permitted,)) == (permitted.resolve(),)
    assert store_permissions.permit_store_roots((permitted / "data",)) == ((permitted / "data").resolve(),)


def test_the_allowlist_refuses_rather_than_returning_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """An empty permitted set must be a refusal, not a silently open boundary.

    `configured_store_roots` once returned an empty tuple on a missing
    configuration and the guard treated empty as "no boundary", which removed
    the check on the one call that changes permissions. The same shape must not
    reappear here.
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path / "Jarvis")
    with pytest.raises(store_permissions.StoreRootUnresolvedError, match="no store root to allow"):
        store_permissions.permit_store_roots(())


def test_a_relative_configured_store_path_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """A relative path would resolve against the process's working directory.

    For a service started by a logon task that is a directory nobody chose, so
    the same configuration would name different stores on different runs. That
    is the one property a boundary may not have, so it is refused instead of
    being resolved.
    """
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.path.join("relative", "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(tmp_path / "memory.sqlite3"))
    with pytest.raises(store_permissions.StoreRootUnresolvedError, match="is not an absolute path"):
        store_permissions.configured_store_roots()


def test_a_default_open_writes_no_acl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stub: StubWin32) -> None:
    """Writing nothing is the default, so a caller cannot opt in by omission.

    A DACL write propagates to everything below the object it names, and the last
    accidental one emptied this account's profile. That makes the default the
    guard: `agent.open_stores` is the only production caller that passes
    `repair_permissions=True`, and this pins the other side of it -- an open with
    no arguments reaches Win32 zero times, on the branch that *does* write a DACL.

    The Windows branch is forced because it is the one that writes a DACL; on
    POSIX the same open only inspects modes, and the assertion would then be
    about the host rather than about the default.
    """
    root = tmp_path / "Jarvis"
    store = root / "data"
    store.mkdir(parents=True)
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: root)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(root / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(root / "memory.sqlite3"))
    monkeypatch.setattr(archive_database, "_is_posix", lambda: False)

    connection = archive_database.connect(store / "archive.sqlite3")
    connection.close()

    assert stub.paths == [], f"a default open wrote a DACL to {stub.paths}"


def test_the_walk_skips_a_reparse_point_instead_of_granting_it_access(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stub: StubWin32,
) -> None:
    """A junction is a door, and only this guard knows a door is not a room.

    The junction points back at the store root itself, which is the case where
    nothing else can be the deciding factor. `_refuse_unsafe_path` resolves a
    junction and checks the *target*, so a door whose target is the store passes
    it -- correctly, that is the store. Only the reparse check stops the walk
    writing the store's DACL onto the door as well.

    Getting here took three attempts, and the two failures are the reason the
    comment is long. A junction pointing outside the store is refused by the
    containment check first, and a junction pointing inside it resolves to the
    directory the walk visits anyway; both make the test pass with this guard
    deleted, which is how the first two versions survived their own mutation.
    """
    outer = tmp_path / "outer"
    store = outer / "store"
    store.mkdir(parents=True)
    (store / "notes").mkdir()
    door = store / "door"
    # `os.symlink` cannot make a real directory junction, and the difference
    # matters: `os.walk` does not descend a symlink, so a symlinked door would
    # never be handed to the DACL at all. A junction is created explicitly; it
    # needs no privilege on Windows.
    if os.name == "nt":
        completed = subprocess.run(  # noqa: S603 - fixed argument vector, no shell
            ["cmd", "/c", "mklink", "/J", str(door), str(store)],  # noqa: S607 - cmd from PATH by design
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            pytest.skip("could not create a junction on this machine")
    else:
        try:
            os.symlink(store, door, target_is_directory=True)
        except (OSError, NotImplementedError):
            pytest.skip("this platform cannot create a directory reparse point without privileges")
    assert store_permissions.is_reparse_point(door), "the fixture did not produce a reparse point"

    # The configured roots are read from the environment once these are set, so
    # the store is inside the permitted boundary and only the reparse check
    # stands between the walk and the door.
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(store / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(store / "memory.sqlite3"))

    _REAL_REPAIR(store, SID, store_root=store)

    # Resolved, because every one of these paths goes through
    # `_refuse_unsafe_path`, which resolves: the door is written as its target
    # and carries a trailing separator from `os.walk`. With the guard deleted,
    # `door` therefore appears in this list as the store itself.
    written = [Path(path).resolve() for path in stub.paths]
    assert written.count(store.resolve()) == 1, (
        f"the store root was repaired {written.count(store.resolve())} times, so the walk went through "
        f"the door as well: {written}"
    )
    assert (store / "notes").resolve() in written, "a real directory under the store is still repaired"
    assert store.resolve() in written, "the store root itself must still be repaired"


def test_a_directory_reported_as_a_reparse_point_is_not_written_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stub: StubWin32,
) -> None:
    """The reparse guard, pinned on a host that cannot make a junction.

    The test above needs `mklink /J` and is therefore Windows-only, so on the
    Ubuntu job the guard it covers was unpinned entirely -- deleting it there
    changed nothing. This one reports a real subdirectory as a reparse point
    instead, which is the same input `os.walk` would have handed the walk for a
    junction, and asserts both halves: the reported directory is not written to,
    and the directories beside it still are.

    Painting the report rather than creating a real junction is the point. What
    is under test is not whether `os.lstat` can see a reparse tag -- that is the
    helper's own business and the test above covers it where the platform can --
    it is that the walk *acts on* the answer.
    """
    root = tmp_path / "Jarvis" / "data"
    (root / "door").mkdir(parents=True)
    (root / "real").mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path / "Jarvis")
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(root / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(root / "memory.sqlite3"))
    monkeypatch.setattr(store_permissions, "is_reparse_point", lambda path: Path(path).name == "door")

    _REAL_REPAIR(root, SID, store_root=root)

    written = {Path(path).resolve() for path in stub.paths}
    assert (root / "door").resolve() not in written, "the walk wrote to a directory it reported as a reparse point"
    assert (root / "real").resolve() in written, "a real directory beside it was skipped as well"
    assert root.resolve() in written, "the root itself must still be repaired"


def test_the_walk_aborts_at_the_first_refused_directory_rather_than_walking_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The whole point is to stop, not to collect one copy of the error per directory.

    A guard refusal does not mean "this subtree is unlucky" -- it means the
    boundary or the caller is wrong, so every directory below refuses
    identically. Walking on is what made the first version's failures unreadable.
    """
    roots = tmp_path / "Jarvis"
    store = roots / "data"
    store.mkdir(parents=True)
    # A few sibling branches and a nested one, so a walk that failed to abort
    # would have several directories to visit and the assertion below can tell
    # "stopped at the first" from "had nothing else to do".
    for name in ("a", "b", "c"):
        (store / name / "child").mkdir(parents=True)
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: roots)

    seen: list[Path] = []

    def always_refuse(path: Path, _sid: str, *, store_root: Path) -> None:
        seen.append(path)
        raise UnsafeStorePathError(f"refusing {path}")

    monkeypatch.setattr(store_permissions, "apply_owner_only_dacl", always_refuse)

    failures = _REAL_REPAIR(store, SID, store_root=store)

    assert len(seen) == 1, f"the walk did not abort: it visited {seen}"
    assert failures == (store,)

