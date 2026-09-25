import { env } from "cloudflare:test";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type GuestCapabilityId,
  type Sha256Hex,
  type Ulid,
} from "../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../../apps/cloud-gateway/src/memory/memory-repository.js";
import { OwnerPassphraseRepository } from "../../../apps/cloud-gateway/src/persistence/owner-passphrase-repository.js";
import { GuestPinVerifier } from "../../../apps/cloud-gateway/src/security/guest-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import { CapabilityRegistry } from "../../../apps/cloud-gateway/src/voice/capability-registry.js";

// Public synthetic material shared by fixture enrollment and the fake runtime.
export const FAKE_GUEST_PEPPER = () => new Uint8Array(32).fill(12);
export const FAKE_BUDGET_PEPPER = () => new Uint8Array(32).fill(13);
export const FAKE_OWNER_PASSPHRASE = "ablaze abrasion abrasive";
export const FAKE_OWNER_PASSPHRASE_PEPPER = () => new Uint8Array(32).fill(29);
/**
 * The obviously-fake four digit PIN the acceptance fixtures authorize a
 * sensitive action with. Never a real value: the real one is a Worker secret
 * only Sid sets.
 */
export const FAKE_SENSITIVE_ACTION_PIN = "0000";

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

/** Seeds one real canonical item without adding a conversation turn to socket assertions. */
export async function seedFakeCanonicalMemory(
  principalId: string,
  text: string,
  occurredAt: string,
): Promise<Ulid> {
  const eventId = newUlid();
  const payload = Object.freeze({
    schemaCode: 1,
    channelCode: 1,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  });
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = Object.freeze({
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: Object.freeze({ status: "none", markers: Object.freeze([]) }),
    producerVersion: "conversation-v1",
  });
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?1, 'conversation.user_committed', 'conversation', ?2, ?3, ?3, ?4, ?5, ?3)`)
    .bind(eventId, principalId, occurredAt, contentHash, canonicalJson(envelope)).run();
  const event = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?1")
    .bind(eventId).first<{ sequence: number }>();
  if (event === null) throw new Error("fake_canonical_memory_source_missing");
  const repository = new MemoryRepository(env.DB);
  const topics = await repository.bootstrapTopics(principalId);
  const itemId = newUlid();
  await repository.commitInitialItem({
    principalId,
    itemId,
    kind: "fact",
    lifetime: "durable",
    creationEventId: eventId,
    creationEventSequence: event.sequence,
    version: {
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "voice-acceptance-fixture-v1",
      extractorModelId: null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId,
      eventSequence: event.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "voice",
      occurredAt,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: "active",
      reason: "voice acceptance fixture",
      policyVersion: "voice-acceptance-fixture-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.9,
      reason: "voice acceptance fixture",
    },
  });
  return itemId;
}

const CANONICAL_MEMORY_DELETE_GUARDS = Object.freeze([
  "memory_item_placement_state_delete_guard",
  "memory_item_placement_events_immutable_delete",
  "memory_item_state_delete_guard",
  "memory_item_sources_immutable_delete",
  "memory_item_transitions_immutable_delete",
  "memory_item_versions_immutable_delete",
  "memory_items_immutable_delete",
  "memory_topic_aliases_immutable_delete",
  "memory_topic_events_immutable_delete",
  "memory_topics_delete_guard",
]);

/** Removes only the acceptance fixture's principal rows, then restores every production guard verbatim. */
export async function clearFakeCanonicalMemory(principalId: string): Promise<void> {
  const placeholders = CANONICAL_MEMORY_DELETE_GUARDS.map(() => "?").join(", ");
  const result = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`)
    .bind(...CANONICAL_MEMORY_DELETE_GUARDS).all<{ name: string; sql: string }>();
  if (result.results.length !== CANONICAL_MEMORY_DELETE_GUARDS.length
    || result.results.some((row) => !CANONICAL_MEMORY_DELETE_GUARDS.includes(
      row.name as typeof CANONICAL_MEMORY_DELETE_GUARDS[number],
    ) || typeof row.sql !== "string" || row.sql.length === 0)) {
    throw new Error("fake_canonical_memory_delete_guard_missing");
  }
  const versions = await env.DB.prepare(`SELECT version_rowid, text FROM memory_item_versions
    WHERE principal_id = ?1 ORDER BY version_rowid`).bind(principalId)
    .all<{ version_rowid: number; text: string }>();
  if (versions.results.some((row) => !Number.isSafeInteger(row.version_rowid)
    || row.version_rowid < 1 || typeof row.text !== "string")) {
    throw new Error("fake_canonical_memory_version_invalid");
  }
  for (const name of CANONICAL_MEMORY_DELETE_GUARDS) {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  }
  try {
    await env.DB.batch([
      ...versions.results.map((row) => env.DB.prepare(
        "INSERT INTO memory_item_fts(memory_item_fts, rowid, text) VALUES ('delete', ?1, ?2)",
      ).bind(row.version_rowid, row.text)),
      env.DB.prepare("DELETE FROM memory_item_placement_state WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_item_placement_events WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_item_state WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_item_sources WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_item_transitions WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_item_versions WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_items WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_topic_aliases WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare("DELETE FROM memory_topic_events WHERE principal_id = ?1").bind(principalId),
      env.DB.prepare(`DELETE FROM memory_topics
        WHERE principal_id = ?1 AND parent_topic_id IS NOT NULL`).bind(principalId),
      env.DB.prepare("DELETE FROM memory_topics WHERE principal_id = ?1").bind(principalId),
    ]);
  } finally {
    for (const row of result.results) await env.DB.prepare(row.sql).run();
  }
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
