import { env } from "cloudflare:test";
import { newUlid, type GuestCapabilityId, type Sha256Hex } from "../../../packages/contracts/src/index.js";
import { OwnerPassphraseRepository } from "../../../apps/cloud-gateway/src/persistence/owner-passphrase-repository.js";
import { GuestPinVerifier } from "../../../apps/cloud-gateway/src/security/guest-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import { CapabilityRegistry } from "../../../apps/cloud-gateway/src/voice/capability-registry.js";

// Public synthetic material shared by fixture enrollment and the fake runtime.
export const FAKE_GUEST_PEPPER = () => new Uint8Array(32).fill(12);
export const FAKE_BUDGET_PEPPER = () => new Uint8Array(32).fill(13);
export const FAKE_OWNER_PASSPHRASE = "ablaze abrasion abrasive";
export const FAKE_OWNER_PASSPHRASE_PEPPER = () => new Uint8Array(32).fill(29);
export const FAKE_PIN_A = () => Uint8Array.from([52, 56, 50, 55]);
export const FAKE_PIN_B = () => Uint8Array.from([49, 51, 53, 55]);
export const FAKE_VOICE_REGISTRY = () => new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] });
const NOW = "2026-08-30T12:00:00.000Z";

/** Enroll the public fake phrase through the same guarded rotation used by the Worker. */
export async function seedFakeOwnerPassphrase(
  principalId = "principal:owner",
  identityId = "identity:voice",
  committedAt = NOW,
): Promise<void> {
  const deviceId = "device:fake-owner-passphrase";
  const keyId = "key:fake-owner-passphrase";
  const fingerprint = "7".repeat(64) as Sha256Hex;
  await env.DB.prepare(`INSERT INTO device_keys (
    device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
    algorithm, status, device_label, bootstrap_metadata_hash, created_at
  ) VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', 'fake owner passphrase', ?, ?)`)
    .bind(deviceId, principalId, keyId, `${"A".repeat(43)}=`, fingerprint, "8".repeat(64), committedAt).run();
  const record = await new OwnerPassphraseVerifier(
    FAKE_OWNER_PASSPHRASE_PEPPER(), "v1", () => new Uint8Array(16).fill(7),
  ).create(identityId, 1, FAKE_OWNER_PASSPHRASE);
  await new OwnerPassphraseRepository(env.DB).rotate({
    verified: {
      deviceId, principalId, keyId, keyFingerprint: fingerprint, keyGeneration: 1,
      audience: "jarvis-local-agent", issuedAt: committedAt, nonce: "fake",
      bodyHash: "9".repeat(64) as Sha256Hex, body: {},
    },
    ownerPrincipalId: principalId, ownerIdentityId: identityId,
    expectedVerifierVersion: null, record,
    commitId: "01m2eeeeeeeeeeeeeeeeeee001", committedAt,
  });
}

export interface FakeGuest {
  readonly grantId: string;
  readonly principalId: string;
  readonly identityId: string;
  readonly caller: string;
}

/** The fixture owner has already granted access; authentication still uses the real verifier and D1 guards. */
export async function seedFakeGuest(label: "a" | "b", capabilities: readonly GuestCapabilityId[] = ["conversation.basic"]): Promise<FakeGuest> {
  const grantId = newUlid();
  const principalId = `principal:guest-${label}`;
  const identityId = `identity:guest-${label}`;
  const caller = label === "a" ? "+14165550111" : "+14165550112";
  const snapshot = await FAKE_VOICE_REGISTRY().snapshotConfigured(capabilities);
  const record = await new GuestPinVerifier(FAKE_GUEST_PEPPER()).create(grantId, label === "a" ? FAKE_PIN_A() : FAKE_PIN_B());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Fixture guest', ?, ?)`).bind(principalId, NOW, NOW),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'voice', ?, 'pending', NULL, ?)`).bind(identityId, principalId, caller, NOW),
    env.DB.prepare(`INSERT INTO voice_access_grants (
      grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json,
      access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations,
      pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'identity:voice', ?, NULL, ?, NULL)`)
      .bind(grantId, principalId, identityId, JSON.stringify(snapshot.capabilityIds), JSON.stringify(snapshot.resourceScopes),
        snapshot.accessDocumentHash, record.schemaVersion, record.algorithm, record.pepperVersion, record.iterations,
        record.saltBase64, record.digestBase64, NOW, NOW),
    env.DB.prepare(`INSERT INTO voice_access_grant_events
      (event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash, capability_ids_json, access_document_hash, created_at)
      VALUES (?, ?, 1, 'created', 'identity:voice', ?, ?, ?, ?)`)
      .bind(newUlid(), grantId, "e".repeat(64), JSON.stringify(snapshot.capabilityIds), snapshot.accessDocumentHash, NOW),
  ]);
  return { grantId, principalId, identityId, caller };
}
