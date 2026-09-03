"""Fixtures for the vault suite.

Nothing here touches `C:\\javis\\Jarvis`, the real user profile, or the
network. The one test that names the real seed vault path proves its refusal
without any filesystem access at all, using `RefusingProbe` below.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis_local.vault.repository import VaultBinding, VaultRepository
from jarvis_local.vault.setup import VolumeFacts

PRINCIPAL = "principal-a"
VAULT_ID = "01k5d8s0m00000000000000001"

#: The two locations a vault test must never create, because they are where
#: the real adapter would put a real vault on this machine.
_FORBIDDEN_REAL_ROOTS = ("USERPROFILE", "LOCALAPPDATA")


@pytest.fixture(autouse=True)
def the_real_profile_is_left_alone() -> Iterator[None]:
    """Fail any test that creates a vault in the live profile.

    Not paranoia. The first version of the CLI fixture set `USERPROFILE` and
    believed that redirected setup; the known-folder resolver asked Windows
    instead and created `C:\\Users\\<user>\\Jarvis Vault` for real. Setting an
    environment variable is an intention, and this is the measurement -- the
    two disagreed once and nothing in the suite noticed.
    """
    real_roots = _real_vault_locations()
    existed = {root for root in real_roots if root.exists()}
    yield
    created = sorted(str(root.name) for root in real_roots if root.exists() and root not in existed)
    assert created == [], f"a vault test created a real vault outside tmp_path: {created}"


def _real_vault_locations() -> tuple[Path, ...]:
    found: list[Path] = []
    profile = os.environ.get(_FORBIDDEN_REAL_ROOTS[0], "").strip()
    local = os.environ.get(_FORBIDDEN_REAL_ROOTS[1], "").strip()
    if profile:
        found.append(Path(profile) / "Jarvis Vault")
    if local:
        found.append(Path(local) / "Jarvis" / "Vault")
    return tuple(found)


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[VaultRepository]:
    vault_repository = VaultRepository.open(tmp_path / "archive.sqlite3")
    yield vault_repository
    vault_repository.close()


@pytest.fixture
def vault_root(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    root.mkdir()
    return root


@pytest.fixture
def binding(repository: VaultRepository, vault_root: Path) -> VaultBinding:
    return repository.record_binding(
        VaultBinding(
            vault_id=VAULT_ID,
            principal_id=PRINCIPAL,
            root_path=str(vault_root),
            volume_serial=12345,
            root_file_id="ff:01",
        )
    )


def write_note(root: Path, relative: str, text: str) -> Path:
    """Write a note the way Obsidian would: UTF-8, no BOM, LF."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    return path


def make_reparse_point(link: Path, target: Path) -> None:
    """Create a directory symlink or junction, or skip the test.

    A junction is used on Windows because `mklink /J` needs no privilege while
    `os.symlink` needs Developer Mode or elevation, and a junction is also the
    reparse point a vault root is most likely to be by accident.
    """
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError):
        if sys.platform != "win32":
            pytest.skip("this platform cannot create a directory reparse point without privileges")
        completed = subprocess.run(  # noqa: S603 - fixed argument vector, no shell
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],  # noqa: S607 - cmd is resolved from PATH by design
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0 or not link.exists():
            pytest.skip("could not create a junction on this machine")


class RefusingProbe:
    """A root probe that answers nothing.

    Every method raises, so any check that reaches the filesystem fails the
    test loudly instead of quietly passing. This is the instrument that makes
    "the seed vault is refused without being touched" a measurement rather
    than an assertion about code nobody read.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    def _refuse(self, name: str) -> None:
        self.calls.append(name)
        raise AssertionError(f"the seed vault must not be touched, but {name} was called")

    def exists(self, path: Path) -> bool:
        self._refuse("exists")
        raise AssertionError("unreachable")

    def is_directory(self, path: Path) -> bool:
        self._refuse("is_directory")
        raise AssertionError("unreachable")

    def any_reparse_point(self, path: Path) -> bool:
        self._refuse("any_reparse_point")
        raise AssertionError("unreachable")

    def volume_facts(self, path: Path) -> VolumeFacts:
        self._refuse("volume_facts")
        raise AssertionError("unreachable")

    def canonical_parts(self, path: Path) -> tuple[str, ...]:
        self._refuse("canonical_parts")
        raise AssertionError("unreachable")

    def has_child(self, path: Path, name: str) -> bool:
        self._refuse("has_child")
        raise AssertionError("unreachable")

    def file_identity(self, path: Path) -> str | None:
        self._refuse("file_identity")
        raise AssertionError("unreachable")


class StubKnownFolders:
    """Known folders that are wherever the test says, never the real profile."""

    def __init__(self, profile: Path, local_app_data: Path) -> None:
        self._profile = profile
        self._local_app_data = local_app_data

    def profile(self) -> Path:
        return self._profile

    def local_app_data(self) -> Path:
        return self._local_app_data
