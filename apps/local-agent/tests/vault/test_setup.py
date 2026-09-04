"""A vault root is refused far more often than it is accepted.

The seed vault is the case that matters most, so it is tested twice: once
against the real `C:\\javis\\Jarvis` path with a probe that refuses to touch
anything, and once against a tmp_path directory that is *not* inside a Git
repository -- so the refusal cannot be an accident of the Git check.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis_local.vault.repository import VaultRepository
from jarvis_local.vault.setup import (
    APPROVED_LAYOUT,
    SEED_VAULT_PATHS,
    VaultRootCode,
    VaultRootPolicy,
    VaultSetupService,
    VolumeFacts,
    fallback_vault_root,
    preferred_vault_root,
)
from tests.vault.conftest import PRINCIPAL, RefusingProbe, StubKnownFolders, make_reparse_point


class AcceptingProbe:
    """A probe that answers every question in the way that permits a root.

    Used so a test about one rule cannot pass because a different rule fired.
    Individual tests override single answers.
    """

    def __init__(self, *, reparse: bool = False, drive_type: int = 3, file_system: str | None = "NTFS") -> None:
        self.reparse = reparse
        self.drive_type = drive_type
        self.file_system = file_system

    def exists(self, path: Path) -> bool:
        return path.exists()

    def is_directory(self, path: Path) -> bool:
        return path.is_dir()

    def any_reparse_point(self, path: Path) -> bool:
        return self.reparse

    def volume_facts(self, path: Path) -> VolumeFacts:
        return VolumeFacts(drive_type=self.drive_type, file_system=self.file_system, volume_serial=7)

    def canonical_parts(self, path: Path) -> tuple[str, ...]:
        from jarvis_local.vault import paths

        return paths.canonical_parts(path)

    def has_child(self, path: Path, name: str) -> bool:
        return (path / name).exists()

    def file_identity(self, path: Path) -> str | None:
        return "vol:1"


def policy_for(tmp_path: Path, **kwargs: object) -> VaultRootPolicy:
    """A policy with no denied trees or cloud roots unless a test adds them."""
    return VaultRootPolicy(
        seed_vaults=kwargs.pop("seed_vaults", SEED_VAULT_PATHS),  # type: ignore[arg-type]
        denied_trees=kwargs.pop("denied_trees", ()),  # type: ignore[arg-type]
        cloud_roots=kwargs.pop("cloud_roots", ()),  # type: ignore[arg-type]
        probe=kwargs.pop("probe", AcceptingProbe()),  # type: ignore[arg-type]
    )


def test_the_repository_seed_vault_is_refused_by_name_without_being_touched() -> None:
    """`C:\\javis\\Jarvis` is the owner's own vault and is never adopted.

    The probe raises on every filesystem question, so this also proves the
    refusal happens before anything reads, stats, or resolves the path.
    """
    probe = RefusingProbe()
    policy = VaultRootPolicy(probe=probe)

    verdict = policy.inspect(Path(r"C:\javis\Jarvis"))

    assert verdict.code is VaultRootCode.SEED_VAULT
    assert probe.calls == []


def test_a_path_inside_the_seed_vault_is_refused_too() -> None:
    probe = RefusingProbe()
    verdict = VaultRootPolicy(probe=probe).inspect(Path(r"C:\javis\Jarvis") / "00 Inbox" / "deeper")
    assert verdict.code is VaultRootCode.SEED_VAULT
    assert probe.calls == []


def test_a_seed_vault_outside_any_git_repository_is_still_refused(tmp_path: Path) -> None:
    """The refusal must not be a side effect of the Git check.

    This seed directory has no `.git` anywhere above it, sits on the same
    ordinary drive as every other tmp_path, and is accepted by a probe that
    permits everything. If the seed rule were removed, the verdict would be
    OK -- which is exactly what would happen if someone deleted the seed check
    believing the Git check covered it.
    """
    seed = tmp_path / "some-repo" / "Jarvis"
    seed.mkdir(parents=True)
    assert not any((parent / ".git").exists() for parent in (seed, *seed.parents))

    policy = policy_for(tmp_path, seed_vaults=(seed,))

    assert policy.inspect(seed).code is VaultRootCode.SEED_VAULT
    # The control: the identical directory next door, differing only in not
    # being on the seed list, is accepted.
    sibling = tmp_path / "some-repo" / "Elsewhere"
    sibling.mkdir()
    assert policy.inspect(sibling).code is VaultRootCode.OK


def test_a_root_inside_a_git_worktree_is_refused(tmp_path: Path) -> None:
    """`.git` as a *file* is a worktree or submodule, and disqualifies too."""
    worktree = tmp_path / "checkout"
    (worktree / "notes").mkdir(parents=True)
    (worktree / ".git").write_text("gitdir: /elsewhere/.git/worktrees/checkout", encoding="utf-8")

    assert policy_for(tmp_path).inspect(worktree / "notes").code is VaultRootCode.INSIDE_GIT


def test_a_root_inside_an_ordinary_git_clone_is_refused(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    (clone / ".git" / "objects").mkdir(parents=True)
    (clone / "notes").mkdir()

    assert policy_for(tmp_path).inspect(clone / "notes").code is VaultRootCode.INSIDE_GIT


def test_a_root_on_a_reparse_point_is_refused(tmp_path: Path) -> None:
    """A real junction, not a mocked one, so the detection is exercised."""
    target = tmp_path / "real"
    target.mkdir()
    link = tmp_path / "link"
    make_reparse_point(link, target)

    # The probe answers everything else permissively and delegates the reparse
    # question to the real implementation, so only this rule can fire.
    policy = VaultRootPolicy(seed_vaults=(), denied_trees=(), cloud_roots=())
    assert policy.inspect(link).code is VaultRootCode.REPARSE_POINT
    # Control: the directory the junction points at is fine.
    assert policy.inspect(target).code is VaultRootCode.OK


def test_a_root_inside_a_cloud_sync_root_is_refused(tmp_path: Path) -> None:
    onedrive = tmp_path / "OneDrive"
    (onedrive / "Notes").mkdir(parents=True)
    assert policy_for(tmp_path).inspect(onedrive / "Notes").code is VaultRootCode.CLOUD_SYNC


def test_a_business_onedrive_folder_is_refused_by_its_prefix(tmp_path: Path) -> None:
    """`OneDrive - Contoso` cannot be enumerated in advance, only matched."""
    tenant = tmp_path / "OneDrive - Contoso"
    (tenant / "Notes").mkdir(parents=True)
    assert policy_for(tmp_path).inspect(tenant / "Notes").code is VaultRootCode.CLOUD_SYNC


def test_a_dropbox_marker_refuses_a_tree_whose_name_says_nothing(tmp_path: Path) -> None:
    tree = tmp_path / "Personal"
    (tree / "Notes").mkdir(parents=True)
    (tree / ".dropbox").write_text("{}", encoding="utf-8")
    assert policy_for(tmp_path).inspect(tree / "Notes").code is VaultRootCode.CLOUD_SYNC


def test_a_root_inside_a_credential_tree_is_refused(tmp_path: Path) -> None:
    protected = tmp_path / "AppData" / "Roaming" / "Microsoft" / "Protect"
    (protected / "notes").mkdir(parents=True)
    policy = policy_for(tmp_path, denied_trees=(protected,))
    assert policy.inspect(protected / "notes").code is VaultRootCode.PROTECTED_TREE


def test_a_unc_path_is_refused_without_any_network_access() -> None:
    """Settled from the string alone: the probe would raise if it were asked."""
    probe = RefusingProbe()
    verdict = VaultRootPolicy(probe=probe).inspect(Path(r"\\fileserver\share\vault"))
    assert verdict.code is VaultRootCode.NOT_LOCAL_FIXED
    assert probe.calls == []


def test_a_removable_drive_is_refused(tmp_path: Path) -> None:
    removable = policy_for(tmp_path, probe=AcceptingProbe(drive_type=2))
    assert removable.inspect(tmp_path).code is VaultRootCode.NOT_LOCAL_FIXED


def test_a_non_ntfs_volume_is_refused(tmp_path: Path) -> None:
    fat = policy_for(tmp_path, probe=AcceptingProbe(file_system="FAT32"))
    assert fat.inspect(tmp_path).code is VaultRootCode.NOT_NTFS


def test_a_host_that_cannot_name_its_filesystem_is_accepted_and_that_is_a_weakening(tmp_path: Path) -> None:
    """`None` means "this host has no opinion", which the policy accepts.

    Recorded as a test rather than left implicit: on a non-Windows machine the
    local-NTFS rule is not enforced at all, and a future reader needs to see
    that stated somewhere that fails if it changes.
    """
    unknown = policy_for(tmp_path, probe=AcceptingProbe(file_system=None))
    assert unknown.inspect(tmp_path).code is VaultRootCode.OK
    # An *empty* string is a volume that refused to describe itself, which is
    # a different thing and is refused.
    silent = policy_for(tmp_path, probe=AcceptingProbe(file_system=""))
    assert silent.inspect(tmp_path).code is VaultRootCode.NOT_NTFS


def test_the_preferred_root_is_the_profile_known_folder(tmp_path: Path) -> None:
    folders = StubKnownFolders(tmp_path / "profile", tmp_path / "localappdata")
    assert preferred_vault_root(folders) == tmp_path / "profile" / "Jarvis Vault"
    assert fallback_vault_root(folders) == tmp_path / "localappdata" / "Jarvis" / "Vault"


def test_setup_creates_the_approved_layout_and_binds_the_root(
    repository: VaultRepository, tmp_path: Path
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(profile, tmp_path / "localappdata"),
        policy=policy_for(tmp_path),
    )

    result = service.setup(PRINCIPAL)

    assert result.ok
    assert result.created_layout == APPROVED_LAYOUT
    assert result.binding is not None
    assert Path(result.binding.root_path) == profile / "Jarvis Vault"
    for name in APPROVED_LAYOUT:
        assert (profile / "Jarvis Vault" / name).is_dir()


def test_setup_falls_back_to_local_app_data_when_the_profile_is_refused(
    repository: VaultRepository, tmp_path: Path
) -> None:
    profile = tmp_path / "OneDrive" / "profile"
    profile.mkdir(parents=True)
    fallback_parent = tmp_path / "localappdata"
    fallback_parent.mkdir()

    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(profile, fallback_parent),
        policy=policy_for(tmp_path),
    )
    result = service.setup(PRINCIPAL)

    assert result.ok
    assert result.binding is not None
    assert Path(result.binding.root_path) == fallback_parent / "Jarvis" / "Vault"


def test_setup_creates_nothing_when_every_candidate_is_refused(
    repository: VaultRepository, tmp_path: Path
) -> None:
    """A refusal must leave the filesystem exactly as it was."""
    profile = tmp_path / "OneDrive" / "profile"
    profile.mkdir(parents=True)
    fallback_parent = tmp_path / "OneDrive" / "localappdata"
    fallback_parent.mkdir(parents=True)
    before = sorted(str(item.relative_to(tmp_path)) for item in tmp_path.rglob("*"))

    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(profile, fallback_parent),
        policy=policy_for(tmp_path),
    )
    result = service.setup(PRINCIPAL)

    assert result.code is VaultRootCode.CLOUD_SYNC
    assert result.binding is None
    assert sorted(str(item.relative_to(tmp_path)) for item in tmp_path.rglob("*")) == before
    assert repository.binding_for(PRINCIPAL) is None


def test_setup_is_idempotent_and_returns_the_existing_binding(
    repository: VaultRepository, tmp_path: Path
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(profile, tmp_path / "localappdata"),
        policy=policy_for(tmp_path),
    )

    first = service.setup(PRINCIPAL)
    second = service.setup(PRINCIPAL)

    assert first.binding is not None
    assert second.binding is not None
    assert second.binding.vault_id == first.binding.vault_id
    assert second.created_layout == ()


def test_an_explicitly_configured_root_replaces_both_defaults(
    repository: VaultRepository, tmp_path: Path
) -> None:
    chosen = tmp_path / "somewhere else" / "My Vault"
    chosen.mkdir(parents=True)
    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(tmp_path / "profile", tmp_path / "localappdata"),
        policy=policy_for(tmp_path),
        environment={"JARVIS_VAULT_ROOT": str(chosen)},
    )

    assert service.candidate_roots() == (chosen,)
    result = service.setup(PRINCIPAL)

    assert result.ok
    assert result.binding is not None
    assert Path(result.binding.root_path) == chosen
    # The defaults were not tried, so nothing was created at either of them.
    assert not (tmp_path / "profile").exists()


def test_an_explicitly_configured_root_is_still_subject_to_every_rule(
    repository: VaultRepository, tmp_path: Path
) -> None:
    """Naming a root is a preference, not an exemption.

    The seed vault named explicitly must be refused exactly as it is when it
    turns up as a default candidate.
    """
    service = VaultSetupService(
        repository,
        known_folders=StubKnownFolders(tmp_path / "profile", tmp_path / "localappdata"),
        policy=VaultRootPolicy(probe=RefusingProbe()),
        environment={"JARVIS_VAULT_ROOT": SEED_VAULT_PATHS[0]},
    )

    result = service.setup(PRINCIPAL)

    assert result.code is VaultRootCode.SEED_VAULT
    assert result.binding is None


def test_supplying_an_environment_means_those_are_the_known_folders(tmp_path: Path) -> None:
    """A resolver that overrode the caller created a directory in the real profile once.

    `WindowsKnownFolders(mapping)` must answer from the mapping. Asking the
    live shell instead is what put `Jarvis Vault` in the actual user profile
    during the first CLI test run.
    """
    from jarvis_local.vault.setup import WindowsKnownFolders

    folders = WindowsKnownFolders({"USERPROFILE": str(tmp_path / "elsewhere"), "LOCALAPPDATA": str(tmp_path / "l")})

    assert folders.profile() == tmp_path / "elsewhere"
    assert folders.local_app_data() == tmp_path / "l"


@pytest.mark.parametrize("seed", SEED_VAULT_PATHS)
def test_every_declared_seed_vault_is_refused(seed: str) -> None:
    probe = RefusingProbe()
    assert VaultRootPolicy(probe=probe).inspect(Path(seed)).code is VaultRootCode.SEED_VAULT
    assert probe.calls == []
