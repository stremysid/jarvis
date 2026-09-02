"""Device enrollment material.

Before the agent can sync, the cloud must hold its public key. The private key
never leaves this machine -- it is generated here, sealed with DPAPI, and only
the public half is ever printed.

This produces the values an operator registers in `device_keys`. The designed
flow issues a bootstrap token and consumes it atomically with device creation,
so enrollment proves possession of a one-time secret. That flow exists in the
schema (`bootstrap_tokens`) but has no route yet, so first-device enrollment is
a deliberate manual step. It is the same shortcut used to enroll the owner's
Telegram identity, and it carries the same caveat: acceptable for bootstrapping
yourself, not acceptable as the way a second device is ever added.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

ALGORITHM = "ed25519"
FIRST_GENERATION = 1


@dataclass(frozen=True, slots=True)
class EnrollmentMaterial:
    """Everything the cloud needs, and nothing it must not have.

    Contains no private material by construction: the private key is not a
    field here, so it cannot reach a log or a console by accident.
    """

    public_key_base64: str
    key_fingerprint: str
    algorithm: str = ALGORITHM
    key_generation: int = FIRST_GENERATION


def public_key_material(public_key: Ed25519PublicKey) -> EnrollmentMaterial:
    """Derive the registration values from a public key.

    The fingerprint is SHA-256 over the raw 32 key bytes, matching what the
    gateway recomputes and compares before trusting a stored key. Hashing the
    base64 text instead would produce a value that never matches, and the only
    symptom would be `device_key_invalid`.
    """
    raw = public_key.public_bytes_raw()
    if len(raw) != 32:
        raise ValueError(f"expected a 32-byte Ed25519 public key, got {len(raw)}")

    encoded = base64.b64encode(raw).decode("ascii")
    # The column is CHECK (length = 44); an unpadded encoding is rejected at
    # insert time rather than at first use.
    if len(encoded) != 44:
        raise ValueError(f"expected 44 base64 characters, got {len(encoded)}")

    return EnrollmentMaterial(
        public_key_base64=encoded,
        key_fingerprint=hashlib.sha256(raw).hexdigest(),
    )


def enrollment_material(key: Ed25519PrivateKey) -> EnrollmentMaterial:
    return public_key_material(key.public_key())


def bootstrap_metadata_hash(device_label: str, device_id: str) -> str:
    """A stable hash binding the device record to the label it was created with.

    The column requires a 64-character hex value. Deriving it from the label
    and id means the same device re-registered produces the same hash, so a
    duplicate registration is visibly a duplicate rather than a new device.
    """
    return hashlib.sha256(f"{device_label}\n{device_id}".encode()).hexdigest()
