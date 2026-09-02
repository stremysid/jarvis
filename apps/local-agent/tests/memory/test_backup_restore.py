"""A backup that restores corrupt data is worse than no backup.

The archive is the permanent record and the only copy on this machine, so
integrity is verified for every file before any file is replaced. These tests
tamper with backups in each way that matters and assert the original survives.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis_local.memory.backup import (
    ENCRYPTION,
    KEY_PROTECTION,
    MANIFEST_NAME,
    BackupIntegrityError,
    BackupService,
)


class FakeDpapi:
    def protect(self, plaintext: bytes) -> bytes:
        return b"sealed:" + plaintext[::-1]

    def unprotect(self, ciphertext: bytes) -> bytes:
        if not ciphertext.startswith(b"sealed:"):
            raise ValueError("not sealed by this protector")
        return ciphertext[len(b"sealed:") :][::-1]


class RecordingLock:
    """Records the phases during which it was held."""

    def __init__(self) -> None:
        self.depth = 0
        self.phases: list[str] = []
        self.current_phase = "idle"

    def __enter__(self) -> RecordingLock:
        self.depth += 1
        self.phases.append(self.current_phase)
        return self

    def __exit__(self, *exc: object) -> None:
        self.depth -= 1

    def was_held_during(self, phase: str) -> bool:
        return phase in self.phases


def configured_backup(tmp_path: Path) -> tuple[BackupService, RecordingLock, dict[str, Path]]:
    archive = tmp_path / "archive.sqlite3"
    memory = tmp_path / "memory.sqlite3"
    archive.write_bytes(b"ARCHIVE-CONTENT-original")
    memory.write_bytes(b"MEMORY-CONTENT-original")
    sources = {"archive": archive, "memory": memory}
    lock = RecordingLock()
    return BackupService(sources, FakeDpapi(), lock), lock, sources


def test_backup_uses_authenticated_encryption_and_protected_key(tmp_path: Path) -> None:
    backup, lock, _ = configured_backup(tmp_path)
    lock.current_phase = "create"

    manifest = backup.create(tmp_path / "backup")

    assert manifest.encryption == ENCRYPTION == "AES-256-GCM"
    assert manifest.key_protection == KEY_PROTECTION == "DPAPI"
    assert lock.was_held_during("create")


def test_backup_does_not_write_plaintext_to_disk(tmp_path: Path) -> None:
    backup, _, _ = configured_backup(tmp_path)
    output = tmp_path / "backup"
    backup.create(output)

    for path in output.iterdir():
        assert b"ARCHIVE-CONTENT-original" not in path.read_bytes()
        assert b"MEMORY-CONTENT-original" not in path.read_bytes()


def test_round_trip_restores_exact_bytes(tmp_path: Path) -> None:
    backup, lock, sources = configured_backup(tmp_path)
    backup.create(tmp_path / "backup")
    sources["archive"].write_bytes(b"ARCHIVE-CONTENT-damaged")
    sources["memory"].write_bytes(b"MEMORY-CONTENT-damaged")

    lock.current_phase = "restore"
    restored = backup.restore(tmp_path / "backup")

    assert restored == 2
    assert sources["archive"].read_bytes() == b"ARCHIVE-CONTENT-original"
    assert sources["memory"].read_bytes() == b"MEMORY-CONTENT-original"
    assert lock.was_held_during("restore")


def test_restore_rejects_hash_mismatch_without_replacing_archive(tmp_path: Path) -> None:
    backup, _, sources = configured_backup(tmp_path)
    output = tmp_path / "backup"
    backup.create(output)
    sources["archive"].write_bytes(b"ARCHIVE-CONTENT-current")
    (output / "archive.enc").write_bytes(b"tampered")

    with pytest.raises(BackupIntegrityError, match="ciphertext hash"):
        backup.restore(output)

    assert sources["archive"].read_bytes() == b"ARCHIVE-CONTENT-current"


def test_a_mismatch_in_the_last_file_leaves_the_first_untouched(tmp_path: Path) -> None:
    """Verify-all-then-write. Restoring file by file would leave the archive
    replaced and memory not, with the originals already gone."""
    backup, _, sources = configured_backup(tmp_path)
    output = tmp_path / "backup"
    backup.create(output)
    sources["archive"].write_bytes(b"ARCHIVE-CONTENT-current")
    sources["memory"].write_bytes(b"MEMORY-CONTENT-current")
    (output / "memory.enc").write_bytes(b"tampered")

    with pytest.raises(BackupIntegrityError):
        backup.restore(output)

    assert sources["archive"].read_bytes() == b"ARCHIVE-CONTENT-current"
    assert sources["memory"].read_bytes() == b"MEMORY-CONTENT-current"


def test_ciphertext_edited_to_keep_its_hash_still_fails_authentication(tmp_path: Path) -> None:
    """GCM is authenticated, so a forger who also fixes the manifest hash is
    still refused. Hashes alone would not catch this."""
    backup, _, sources = configured_backup(tmp_path)
    output = tmp_path / "backup"
    manifest = backup.create(output)
    sources["archive"].write_bytes(b"ARCHIVE-CONTENT-current")

    forged = bytearray((output / "archive.enc").read_bytes())
    forged[0] ^= 0xFF
    (output / "archive.enc").write_bytes(bytes(forged))

    import hashlib
    import json

    data = json.loads((output / MANIFEST_NAME).read_text(encoding="utf-8"))
    for entry in data["files"]:
        if entry["name"] == "archive":
            entry["ciphertextSha256"] = hashlib.sha256(bytes(forged)).hexdigest()
    (output / MANIFEST_NAME).write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(BackupIntegrityError, match="authentication failed"):
        backup.restore(output)

    assert sources["archive"].read_bytes() == b"ARCHIVE-CONTENT-current"
    assert manifest.encryption == "AES-256-GCM"


def test_missing_file_is_reported_rather_than_partially_restored(tmp_path: Path) -> None:
    backup, _, sources = configured_backup(tmp_path)
    output = tmp_path / "backup"
    backup.create(output)
    sources["archive"].write_bytes(b"ARCHIVE-CONTENT-current")
    (output / "memory.enc").unlink()

    with pytest.raises(BackupIntegrityError, match="missing"):
        backup.restore(output)

    assert sources["archive"].read_bytes() == b"ARCHIVE-CONTENT-current"


def test_each_file_gets_its_own_nonce(tmp_path: Path) -> None:
    """Reusing a nonce across files under one key breaks GCM entirely."""
    backup, _, _ = configured_backup(tmp_path)
    manifest = backup.create(tmp_path / "backup")
    nonces = [item.nonce_hex for item in manifest.files]
    assert len(set(nonces)) == len(nonces)


def test_two_backups_of_identical_data_differ(tmp_path: Path) -> None:
    """Fresh key and nonces each time, so ciphertext is not a fingerprint of
    the plaintext."""
    backup, _, _ = configured_backup(tmp_path)
    first = backup.create(tmp_path / "b1")
    second = backup.create(tmp_path / "b2")
    assert first.sealed_key_hex != second.sealed_key_hex
    assert (tmp_path / "b1" / "archive.enc").read_bytes() != (tmp_path / "b2" / "archive.enc").read_bytes()


def test_unsupported_schema_version_is_refused(tmp_path: Path) -> None:
    backup, _, _ = configured_backup(tmp_path)
    output = tmp_path / "backup"
    backup.create(output)
    import json

    data = json.loads((output / MANIFEST_NAME).read_text(encoding="utf-8"))
    data["schemaVersion"] = "99.0"
    (output / MANIFEST_NAME).write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(BackupIntegrityError, match="schema"):
        backup.restore(output)
