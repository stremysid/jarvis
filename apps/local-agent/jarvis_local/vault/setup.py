"""Choosing and owning a vault root.

Almost everything in this module is a refusal. A vault root is a directory
Jarvis will crawl on a schedule and publish files into, so the wrong root is
not a misconfiguration -- it is Jarvis reading a Git working tree into its
archive, or writing notes into a folder that syncs them to somebody else's
cloud, or crawling a credential store. Each refused location is a separate
named code so `jarvis doctor` can say which rule was hit without printing the
path that hit it.

The seed vault is the sharpest of these. `C:\\javis\\Jarvis` is the owner's own
Obsidian vault, which happens to sit inside the repository, and it is never
adopted, imported, moved, overwritten, or deleted. It is refused *first* and by
name, before any probe touches the filesystem, so the refusal does not depend
on it also being inside a Git repository -- which it is, today, and might not
be tomorrow.

What stage one cannot do
------------------------
The native bridge would open the root and its ancestors without
FILE_SHARE_DELETE and hold those handles across every subsequent operation, so
"the directory I validated is the directory I am reading" would be a property
of the handle. There is no handle here. Every check below describes the
filesystem at the instant it ran:

* the reparse-point, drive-type and Git-ancestor checks are
  time-of-check-to-time-of-use. A junction can be swapped in, a `.git`
  directory created, or the whole root renamed and replaced immediately after
  `inspect` returns and before the caller reads a single file.
* the volume serial and root file id are recorded so a *later* substitution can
  be noticed after the fact by `jarvis vault doctor`. Noticing is not
  preventing.

These are the honest limits of a pure-Python adapter and they are why the
DECISIONS entry says this ships as stage one.
"""

from __future__ import annotations

import ctypes
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from jarvis_local.clock import utc_now_iso
from jarvis_local.vault import paths
from jarvis_local.vault.identifiers import derive_ulid
from jarvis_local.vault.repository import VaultBinding, VaultRepository

#: The owner's own vault. Named, not inferred. Never a source, never a target.
SEED_VAULT_PATHS: tuple[str, ...] = (r"C:\javis\Jarvis",)

#: Directories the adapter creates under a new root. Deliberately short: every
#: extra directory is one more thing to reconcile against a vault the owner
#: also edits by hand.
APPROVED_LAYOUT: tuple[str, ...] = ("00 Inbox", "90 Jarvis")

#: A directory name anywhere in the chain that means a third-party client is
#: replicating this tree somewhere else.
CLOUD_SYNC_DIRECTORY_NAMES: frozenset[str] = frozenset(
    {"onedrive", "dropbox", "google drive", "googledrive", "my drive", "icloud drive", "iclouddrive", "box sync"}
)

#: A marker file or directory a sync client leaves at the root of the tree it
#: owns. Checked as well as the name because "OneDrive - Contoso" is a
#: directory name nobody can enumerate in advance.
CLOUD_SYNC_MARKERS: frozenset[str] = frozenset({".dropbox", ".dropbox.cache", ".onedrive", "desktop.ini.onedrive"})

CLOUD_SYNC_ENVIRONMENT_NAMES: tuple[str, ...] = ("OneDrive", "OneDriveConsumer", "OneDriveCommercial")

#: Trees that hold credentials, protected data, or the operating system. Given
#: relative to environment roots so the list is meaningful on any profile.
PROTECTED_RELATIVE_TREES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("APPDATA", ("Microsoft", "Crypto")),
    ("APPDATA", ("Microsoft", "Protect")),
    ("APPDATA", ("Microsoft", "Credentials")),
    ("LOCALAPPDATA", ("Microsoft", "Credentials")),
    ("LOCALAPPDATA", ("Microsoft", "Vault")),
    ("USERPROFILE", (".ssh",)),
    ("USERPROFILE", (".aws",)),
    ("USERPROFILE", (".gnupg",)),
    ("USERPROFILE", (".config", "gcloud")),
    ("SystemRoot", ()),
    ("ProgramFiles", ()),
    ("ProgramFiles(x86)", ()),
    ("ProgramData", ("Microsoft", "Crypto")),
)

DRIVE_FIXED = 3


class VaultRootCode(StrEnum):
    """Closed refusal codes. A diagnostic prints one of these and nothing else."""

    OK = "vault_root_ok"
    SEED_VAULT = "vault_seed_vault_refused"
    INSIDE_GIT = "vault_inside_git_repository"
    CLOUD_SYNC = "vault_inside_cloud_sync_root"
    REPARSE_POINT = "vault_reparse_point"
    PROTECTED_TREE = "vault_inside_protected_tree"
    NOT_LOCAL_FIXED = "vault_not_local_fixed_drive"
    NOT_NTFS = "vault_not_ntfs"
    NOT_A_DIRECTORY = "vault_root_not_a_directory"


@dataclass(frozen=True, slots=True)
class VolumeFacts:
    """What the OS reports about the volume a path sits on.

    `file_system` is `None` when the host cannot answer -- a non-Windows
    machine running the test suite. That is distinguished from a wrong answer
    so the policy can accept "this host has no opinion" without also accepting
    a volume that reported FAT32.
    """

    drive_type: int
    file_system: str | None
    volume_serial: int | None


@dataclass(frozen=True, slots=True)
class RootInspection:
    """The verdict on a candidate root. Carries no path, by construction."""

    code: VaultRootCode
    volume_serial: int | None = None
    root_file_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.code is VaultRootCode.OK


class RootProbe(Protocol):
    """Every filesystem question `inspect` asks, behind one seam.

    One protocol rather than several so a test can supply a probe that refuses
    to answer anything, and prove that inspecting the seed vault path reaches
    no probe at all.
    """

    def exists(self, path: Path) -> bool: ...

    def is_directory(self, path: Path) -> bool: ...

    def any_reparse_point(self, path: Path) -> bool: ...

    def volume_facts(self, path: Path) -> VolumeFacts: ...

    def canonical_parts(self, path: Path) -> tuple[str, ...]: ...

    def has_child(self, path: Path, name: str) -> bool: ...

    def file_identity(self, path: Path) -> str | None: ...


class LocalRootProbe:
    """The real answers, from the real filesystem."""

    def exists(self, path: Path) -> bool:
        return path.exists()

    def is_directory(self, path: Path) -> bool:
        return path.is_dir()

    def any_reparse_point(self, path: Path) -> bool:
        return paths.any_reparse_point(path)

    def volume_facts(self, path: Path) -> VolumeFacts:
        return local_volume_facts(path)

    def canonical_parts(self, path: Path) -> tuple[str, ...]:
        return paths.canonical_parts(path)

    def has_child(self, path: Path, name: str) -> bool:
        return (path / name).exists()

    def file_identity(self, path: Path) -> str | None:
        try:
            status = os.stat(path)
        except OSError:
            return None
        return f"{status.st_dev:x}:{status.st_ino:x}"


def local_volume_facts(path: Path) -> VolumeFacts:
    """Drive type, filesystem name and volume serial, on Windows.

    Off Windows there is no equivalent question, so the filesystem name is
    reported as unknown rather than guessed. The policy then accepts it, which
    is exactly the weakening that makes the local-NTFS rule unenforced when the
    suite runs anywhere but the reference machine.
    """
    if sys.platform != "win32":
        return VolumeFacts(drive_type=DRIVE_FIXED, file_system=None, volume_serial=None)

    anchor = Path(os.path.abspath(os.fspath(path))).anchor
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    drive_type = int(kernel32.GetDriveTypeW(ctypes.c_wchar_p(anchor)))

    name_buffer = ctypes.create_unicode_buffer(261)
    filesystem_buffer = ctypes.create_unicode_buffer(261)
    serial = ctypes.c_uint32(0)
    max_component = ctypes.c_uint32(0)
    flags = ctypes.c_uint32(0)
    ok = kernel32.GetVolumeInformationW(
        ctypes.c_wchar_p(anchor),
        name_buffer,
        ctypes.sizeof(name_buffer) // ctypes.sizeof(ctypes.c_wchar),
        ctypes.byref(serial),
        ctypes.byref(max_component),
        ctypes.byref(flags),
        filesystem_buffer,
        ctypes.sizeof(filesystem_buffer) // ctypes.sizeof(ctypes.c_wchar),
    )
    if not ok:
        # A volume that will not describe itself is not one to put a vault on.
        return VolumeFacts(drive_type=drive_type, file_system="", volume_serial=None)
    return VolumeFacts(drive_type=drive_type, file_system=filesystem_buffer.value, volume_serial=serial.value)


class KnownFolders(Protocol):
    def profile(self) -> Path: ...

    def local_app_data(self) -> Path: ...


class WindowsKnownFolders:
    """Known Folder lookup, or the environment when the caller supplies one.

    `SHGetKnownFolderPath` is the authority by default, because the profile is
    not required to sit at `%USERPROFILE%` and a redirected profile would
    otherwise put the vault somewhere the owner never chose.

    But it is asked *only* when no environment was supplied. Handing this class
    a mapping is a caller saying "these are the folders", and a resolver that
    consulted the live shell anyway would ignore the instruction -- which is
    not a theoretical concern: the first run of the CLI test did exactly that
    and created a directory in the real profile that the test believed it had
    redirected into a temporary one.
    """

    _FOLDERID_PROFILE = "{5E6C858F-0E22-4760-9AFE-EA3317B67173}"
    _FOLDERID_LOCAL_APP_DATA = "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}"

    def __init__(self, environment: Mapping[str, str] | None = None) -> None:
        self._supplied = environment is not None
        self._environment = dict(os.environ if environment is None else environment)

    def profile(self) -> Path:
        return self._known_folder(self._FOLDERID_PROFILE, "USERPROFILE")

    def local_app_data(self) -> Path:
        return self._known_folder(self._FOLDERID_LOCAL_APP_DATA, "LOCALAPPDATA")

    def _known_folder(self, folder_id: str, environment_name: str) -> Path:
        if not self._supplied:
            resolved = self._shell_known_folder(folder_id)
            if resolved is not None:
                return resolved
        value = self._environment.get(environment_name, "").strip()
        if not value:
            raise VaultSetupError(f"cannot locate the {environment_name} known folder")
        return Path(value)

    def _shell_known_folder(self, folder_id: str) -> Path | None:
        if sys.platform != "win32":
            return None
        try:
            shell32 = ctypes.WinDLL("shell32", use_last_error=True)
            ole32 = ctypes.WinDLL("ole32", use_last_error=True)
        except OSError:  # pragma: no cover - a Windows without shell32 is not a thing we model
            return None

        class _Guid(ctypes.Structure):
            _fields_ = (
                ("data1", ctypes.c_uint32),
                ("data2", ctypes.c_uint16),
                ("data3", ctypes.c_uint16),
                ("data4", ctypes.c_ubyte * 8),
            )

        guid = _Guid()
        if ole32.CLSIDFromString(ctypes.c_wchar_p(folder_id), ctypes.byref(guid)) != 0:
            return None
        buffer = ctypes.c_wchar_p()
        if shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(buffer)) != 0:
            return None
        try:
            value = buffer.value
        finally:
            ole32.CoTaskMemFree(buffer)
        return None if not value else Path(value)


class VaultSetupError(RuntimeError):
    """Setup cannot proceed, for a reason that is not a refused root."""


def preferred_vault_root(known_folders: KnownFolders) -> Path:
    """`<profile>\\Jarvis Vault` -- the reference machine's `C:\\Users\\Ksid1\\Jarvis Vault`."""
    return known_folders.profile() / "Jarvis Vault"


def fallback_vault_root(known_folders: KnownFolders) -> Path:
    """`%LOCALAPPDATA%\\Jarvis\\Vault` -- fixed, and used only when the profile is refused."""
    return known_folders.local_app_data() / "Jarvis" / "Vault"


def protected_trees(environment: dict[str, str]) -> tuple[Path, ...]:
    """The credential and system trees present on this machine."""
    found: list[Path] = []
    for variable, relative in PROTECTED_RELATIVE_TREES:
        base = environment.get(variable, "").strip()
        if not base:
            continue
        found.append(Path(base).joinpath(*relative))
    return tuple(found)


def cloud_sync_roots(environment: dict[str, str]) -> tuple[Path, ...]:
    found: list[Path] = []
    for variable in CLOUD_SYNC_ENVIRONMENT_NAMES:
        value = environment.get(variable, "").strip()
        if value:
            found.append(Path(value))
    return tuple(found)


class VaultRootPolicy:
    """Decides whether a directory may be owned as a vault root."""

    def __init__(
        self,
        *,
        seed_vaults: Sequence[str | Path] = SEED_VAULT_PATHS,
        denied_trees: Sequence[str | Path] = (),
        cloud_roots: Sequence[str | Path] = (),
        probe: RootProbe | None = None,
        require_existing: bool = True,
    ) -> None:
        self._seed_vaults = tuple(Path(value) for value in seed_vaults)
        self._denied_trees = tuple(Path(value) for value in denied_trees)
        self._cloud_roots = tuple(Path(value) for value in cloud_roots)
        self._probe: RootProbe = probe or LocalRootProbe()
        self._require_existing = require_existing

    @classmethod
    def from_environment(
        cls,
        environment: dict[str, str] | None = None,
        *,
        seed_vaults: Sequence[str | Path] = SEED_VAULT_PATHS,
        probe: RootProbe | None = None,
        require_existing: bool = True,
    ) -> VaultRootPolicy:
        """Build the policy from this machine's protected and sync roots."""
        env = dict(os.environ if environment is None else environment)
        return cls(
            seed_vaults=seed_vaults,
            denied_trees=protected_trees(env),
            cloud_roots=cloud_sync_roots(env),
            probe=probe,
            require_existing=require_existing,
        )

    def inspect_lexical_only(self, candidate: Path | str) -> RootInspection:
        """The checks that need no filesystem at all.

        Separated so a root that does not exist yet can still be refused by
        name, and so the seed-vault refusal can be shown to reach no probe.
        """
        path = Path(candidate)
        # A UNC path is not a local volume and no amount of probing will make
        # it one, so it is settled without asking anything.
        if paths.is_unc(path) or not Path(os.path.abspath(os.fspath(path))).is_absolute():
            return RootInspection(VaultRootCode.NOT_LOCAL_FIXED)
        # The seed vault, before any probe runs. Refusing it must not depend on
        # it also being inside a Git repository, on a particular drive, or on
        # existing at all.
        if self._is_seed_vault_lexically(path):
            return RootInspection(VaultRootCode.SEED_VAULT)
        return RootInspection(VaultRootCode.OK)

    def inspect(self, candidate: Path | str) -> RootInspection:
        """Judge a candidate root, cheapest and most absolute checks first."""
        path = Path(candidate)

        lexical = self.inspect_lexical_only(path)
        if not lexical.ok:
            return lexical

        if self._require_existing and not self._probe.exists(path):
            return RootInspection(VaultRootCode.NOT_A_DIRECTORY)
        if self._probe.exists(path) and not self._probe.is_directory(path):
            return RootInspection(VaultRootCode.NOT_A_DIRECTORY)

        # Checked before anything that resolves the path, because resolving
        # through a junction is precisely what a reparse point would make the
        # rest of these checks answer about the wrong directory.
        if self._probe.any_reparse_point(path):
            return RootInspection(VaultRootCode.REPARSE_POINT)

        facts = self._probe.volume_facts(path)
        if facts.drive_type != DRIVE_FIXED:
            return RootInspection(VaultRootCode.NOT_LOCAL_FIXED)
        if facts.file_system is not None and facts.file_system.upper() != "NTFS":
            return RootInspection(VaultRootCode.NOT_NTFS)

        resolved = self._probe.canonical_parts(path)

        # The seed vault again, this time through the resolved path, so a
        # junction or an 8.3 alias pointing into it is caught as well.
        for seed in self._seed_vaults:
            if _is_prefix(self._probe.canonical_parts(seed), resolved):
                return RootInspection(VaultRootCode.SEED_VAULT)

        if self._inside_git(path):
            return RootInspection(VaultRootCode.INSIDE_GIT)
        if self._inside_cloud_sync(path, resolved):
            return RootInspection(VaultRootCode.CLOUD_SYNC)
        for denied in self._denied_trees:
            if _is_prefix(self._probe.canonical_parts(denied), resolved):
                return RootInspection(VaultRootCode.PROTECTED_TREE)

        return RootInspection(
            VaultRootCode.OK,
            volume_serial=facts.volume_serial,
            root_file_id=self._probe.file_identity(path),
        )

    def _is_seed_vault_lexically(self, path: Path) -> bool:
        return any(paths.is_within_lexical(seed, path) for seed in self._seed_vaults)

    def _inside_git(self, path: Path) -> bool:
        """A `.git` at any level above the candidate.

        Checked by walking rather than by shelling out to `git`: a `.git` file
        (a worktree or submodule) and a `.git` directory (an ordinary clone)
        are both disqualifying, both are visible from here, and neither needs
        a subprocess whose absence would silently turn the check off.
        """
        return any(self._probe.has_child(ancestor, ".git") for ancestor in paths.ancestors(path))

    def _inside_cloud_sync(self, path: Path, resolved: tuple[str, ...]) -> bool:
        for root in self._cloud_roots:
            if _is_prefix(self._probe.canonical_parts(root), resolved):
                return True
        for ancestor in paths.ancestors(path):
            name = ancestor.name.casefold()
            if name in CLOUD_SYNC_DIRECTORY_NAMES or name.startswith("onedrive -"):
                return True
            if any(self._probe.has_child(ancestor, marker) for marker in CLOUD_SYNC_MARKERS):
                return True
        return False


def _is_prefix(root: tuple[str, ...], candidate: tuple[str, ...]) -> bool:
    return len(candidate) >= len(root) and candidate[: len(root)] == root


@dataclass(frozen=True, slots=True)
class VaultSetupResult:
    code: VaultRootCode
    binding: VaultBinding | None = None
    created_layout: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.code is VaultRootCode.OK


class VaultSetupService:
    """Creates and binds the owned root, or refuses and creates nothing."""

    def __init__(
        self,
        repository: VaultRepository,
        *,
        known_folders: KnownFolders,
        policy: VaultRootPolicy | None = None,
        environment: Mapping[str, str] | None = None,
        now: str | None = None,
    ) -> None:
        self._repository = repository
        self._known_folders = known_folders
        self._policy = policy or VaultRootPolicy.from_environment()
        self._environment = environment
        self._now = now

    def candidate_roots(self) -> tuple[Path, ...]:
        """Where a root may go, in preference order.

        An explicitly configured root replaces both defaults rather than being
        appended to them: an owner who names a location does not want the
        profile silently used when their choice is refused.
        """
        explicit = configured_root(self._environment)
        if explicit is not None:
            return (explicit,)
        return (preferred_vault_root(self._known_folders), fallback_vault_root(self._known_folders))

    def setup(self, principal_id: str, *, root: Path | None = None) -> VaultSetupResult:
        """Own a root, creating it if it is absent and permitted.

        Nothing is created before the location is judged. The judgement is
        repeated after creation, because between the two the directory could
        have been replaced -- and without a retained handle, repeating the
        check is the only thing available.
        """
        existing = self._repository.binding_for(principal_id)
        if existing is not None:
            return VaultSetupResult(VaultRootCode.OK, binding=existing)

        for candidate in (root,) if root is not None else self.candidate_roots():
            verdict = self._inspect_for_creation(candidate)
            if not verdict.ok:
                continue
            created = self._create_layout(candidate)
            confirmed = self._policy.inspect(candidate)
            if not confirmed.ok:
                return VaultSetupResult(confirmed.code)
            binding = self._repository.record_binding(
                VaultBinding(
                    vault_id=derive_ulid("jarvis.vault.binding", principal_id, paths.normalize_case(str(candidate))),
                    principal_id=principal_id,
                    root_path=str(candidate),
                    volume_serial=confirmed.volume_serial,
                    root_file_id=confirmed.root_file_id,
                ),
                now=self._now,
            )
            return VaultSetupResult(VaultRootCode.OK, binding=binding, created_layout=created)

        # Report the first candidate's actual refusal rather than a generic one,
        # so the operator learns which rule stopped the preferred location.
        first = (root,) if root is not None else self.candidate_roots()
        return VaultSetupResult(self._inspect_for_creation(first[0]).code)

    def _inspect_for_creation(self, candidate: Path) -> RootInspection:
        """Judge a root that may not exist yet, by judging its parent.

        A directory that does not exist has no drive type, no reparse tag and
        no identity, so inspecting it directly would answer about nothing. The
        parent is the thing that decides whether creating a child there is
        allowed -- and the candidate itself is still checked against the seed
        vault list, which needs no filesystem at all.
        """
        seed_verdict = self._policy.inspect_lexical_only(candidate)
        if not seed_verdict.ok:
            return seed_verdict
        if candidate.exists():
            return self._policy.inspect(candidate)
        # `<localappdata>\Jarvis\Vault` has two levels that do not exist yet,
        # so the nearest existing ancestor is what has a drive type, a reparse
        # tag and a `.git` above it to judge.
        for ancestor in paths.ancestors(candidate)[1:]:
            if ancestor.exists():
                return self._policy.inspect(ancestor)
        return RootInspection(VaultRootCode.NOT_A_DIRECTORY)

    def _create_layout(self, root: Path) -> tuple[str, ...]:
        """Create the root and its approved subdirectories.

        `exist_ok` is deliberate and safe: creating a directory that is already
        there changes nothing about its contents. No file is created, moved or
        replaced here -- that is `projection.py`'s job and it is create-new
        only.
        """
        created: list[str] = []
        root.mkdir(parents=True, exist_ok=True)
        for name in APPROVED_LAYOUT:
            child = root / paths.validate_component(name)
            if not child.exists():
                child.mkdir()
                created.append(name)
        return tuple(created)


#: An explicit root, for an owner who keeps their vault somewhere other than
#: the profile -- and the only way a test can exercise the CLI without the
#: live known folder deciding where the directory goes. It is a *candidate*,
#: not an exemption: it goes through the same policy as any other root and is
#: refused by the same rules, the seed vault included.
VAULT_ROOT_ENVIRONMENT_NAME = "JARVIS_VAULT_ROOT"


def configured_root(environment: Mapping[str, str] | None = None) -> Path | None:
    env = os.environ if environment is None else environment
    value = env.get(VAULT_ROOT_ENVIRONMENT_NAME, "").strip()
    return Path(value) if value else None


def default_setup_service(
    repository: VaultRepository,
    *,
    environment: Mapping[str, str] | None = None,
) -> VaultSetupService:
    """The service the CLI uses.

    `environment` is passed through rather than flattened into `os.environ`:
    supplying one has to mean the known folders come from it, or a caller
    trying to redirect the vault silently gets the live profile instead.
    """
    env = dict(os.environ if environment is None else environment)
    return VaultSetupService(
        repository,
        known_folders=WindowsKnownFolders(environment),
        policy=VaultRootPolicy.from_environment(env),
        now=utc_now_iso(),
    )
