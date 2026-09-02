"""Encrypted, integrity-checked backup of the archive and distilled memory.

The archive is the permanent record and the only copy that lives on this
machine. A backup that silently restores corrupt data would be worse than no
backup, so integrity is verified for *every* file before *any* file is
replaced.

Encryption is AES-256-GCM with a randomly generated data key sealed by DPAPI.
GCM is authenticated, so tampering with ciphertext fails decryption rather
than yielding plausible garbage; DPAPI binds the key to this Windows account,
so a copied backup directory is inert elsewhere.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from jarvis_local.clock import utc_now_iso
from jarvis_local.crypto.dpapi import DpapiProtector

SCHEMA_VERSION = "1.0"
ENCRYPTION = "AES-256-GCM"
KEY_PROTECTION = "DPAPI"
MANIFEST_NAME = "manifest.json"
NONCE_BYTES = 12
KEY_BYTES = 32


class BackupIntegrityError(RuntimeError):
    """A backup file does not match the hash recorded in its manifest."""


class ServiceLock(Protocol):
    """Excludes the agent while the databases are being replaced."""

    def __enter__(self) -> object: ...

    def __exit__(self, *exc: object) -> None: ...


@dataclass(frozen=True, slots=True)
class BackupFile:
    name: str
    nonce_hex: str
    ciphertext_sha256: str
    plaintext_sha256: str
    plaintext_bytes: int


@dataclass(frozen=True, slots=True)
class BackupManifest:
    schema_version: str
    created_at: str
    encryption: str
    key_protection: str
    sealed_key_hex: str
    files: tuple[BackupFile, ...]

    def to_json(self) -> str:
        return json.dumps(
            {
                "schemaVersion": self.schema_version,
                "createdAt": self.created_at,
                "encryption": self.encryption,
                "keyProtection": self.key_protection,
                "sealedKey": self.sealed_key_hex,
                "files": [
                    {
                        "name": item.name,
                        "nonce": item.nonce_hex,
                        "ciphertextSha256": item.ciphertext_sha256,
                        "plaintextSha256": item.plaintext_sha256,
                        "plaintextBytes": item.plaintext_bytes,
                    }
                    for item in self.files
                ],
            },
            indent=2,
            sort_keys=True,
        )

    @classmethod
    def from_json(cls, raw: str) -> BackupManifest:
        data = json.loads(raw)
        if data.get("schemaVersion") != SCHEMA_VERSION:
            raise BackupIntegrityError(f"unsupported backup schema: {data.get('schemaVersion')!r}")
        return cls(
            schema_version=data["schemaVersion"],
            created_at=data["createdAt"],
            encryption=data["encryption"],
            key_protection=data["keyProtection"],
            sealed_key_hex=data["sealedKey"],
            files=tuple(
                BackupFile(
                    name=item["name"],
                    nonce_hex=item["nonce"],
                    ciphertext_sha256=item["ciphertextSha256"],
                    plaintext_sha256=item["plaintextSha256"],
                    plaintext_bytes=item["plaintextBytes"],
                )
                for item in data["files"]
            ),
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class BackupService:
    """Creates and restores encrypted backups of the local databases."""

    def __init__(
        self,
        sources: dict[str, Path],
        dpapi: DpapiProtector,
        service_lock: ServiceLock,
    ) -> None:
        self.sources = {name: Path(path) for name, path in sources.items()}
        self.dpapi = dpapi
        self.service_lock = service_lock

    def create(self, output: Path, *, now: str | None = None) -> BackupManifest:
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)

        data_key = secrets.token_bytes(KEY_BYTES)
        cipher = AESGCM(data_key)
        files: list[BackupFile] = []

        # Hold the lock for the whole read: a database copied while the agent
        # is mid-transaction would restore to a torn state.
        with self.service_lock:
            for name, source in self.sources.items():
                plaintext = source.read_bytes()
                # A fresh nonce per file. Reusing one across files under the
                # same key would break GCM's security entirely.
                nonce = os.urandom(NONCE_BYTES)
                ciphertext = cipher.encrypt(nonce, plaintext, name.encode("utf-8"))
                target = output / f"{name}.enc"
                target.write_bytes(ciphertext)
                files.append(
                    BackupFile(
                        name=name,
                        nonce_hex=nonce.hex(),
                        ciphertext_sha256=hashlib.sha256(ciphertext).hexdigest(),
                        plaintext_sha256=hashlib.sha256(plaintext).hexdigest(),
                        plaintext_bytes=len(plaintext),
                    )
                )

        manifest = BackupManifest(
            schema_version=SCHEMA_VERSION,
            created_at=now or utc_now_iso(),
            encryption=ENCRYPTION,
            key_protection=KEY_PROTECTION,
            sealed_key_hex=self.dpapi.protect(data_key).hex(),
            files=tuple(files),
        )
        (output / MANIFEST_NAME).write_text(manifest.to_json(), encoding="utf-8")
        return manifest

    def restore(self, source: Path) -> int:
        """Restore every database. Returns how many files were replaced.

        Verify-all-then-write: a mismatch in the last file must not leave the
        first already overwritten, because the originals are gone by then.
        """
        source = Path(source)
        manifest = BackupManifest.from_json((source / MANIFEST_NAME).read_text(encoding="utf-8"))
        if manifest.encryption != ENCRYPTION or manifest.key_protection != KEY_PROTECTION:
            raise BackupIntegrityError("backup uses an unexpected encryption scheme")

        data_key = self.dpapi.unprotect(bytes.fromhex(manifest.sealed_key_hex))
        cipher = AESGCM(data_key)

        # Phase 1: verify and decrypt everything into memory. Nothing on disk
        # has been touched when this phase raises.
        decrypted: dict[str, bytes] = {}
        for item in manifest.files:
            encrypted_path = source / f"{item.name}.enc"
            if not encrypted_path.exists():
                raise BackupIntegrityError(f"backup is missing {item.name}")
            ciphertext = encrypted_path.read_bytes()
            if hashlib.sha256(ciphertext).hexdigest() != item.ciphertext_sha256:
                raise BackupIntegrityError(f"ciphertext hash mismatch for {item.name}")
            try:
                plaintext = cipher.decrypt(bytes.fromhex(item.nonce_hex), ciphertext, item.name.encode("utf-8"))
            except InvalidTag as error:
                raise BackupIntegrityError(f"authentication failed for {item.name}") from error
            if hashlib.sha256(plaintext).hexdigest() != item.plaintext_sha256:
                raise BackupIntegrityError(f"plaintext hash mismatch for {item.name}")
            if item.name not in self.sources:
                raise BackupIntegrityError(f"backup contains an unknown database: {item.name}")
            decrypted[item.name] = plaintext

        # Phase 2: replace. Written to a sibling temp file and moved into place
        # so a failure mid-write cannot leave a half-written database.
        with self.service_lock:
            for name, plaintext in decrypted.items():
                destination = self.sources[name]
                destination.parent.mkdir(parents=True, exist_ok=True)
                staging = destination.with_suffix(destination.suffix + ".restoring")
                staging.write_bytes(plaintext)
                os.replace(staging, destination)
        return len(decrypted)
