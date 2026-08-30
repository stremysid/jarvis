import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type CallPhase,
  type PersistableEventEnvelopeV1,
  type RelayBinding,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  CallRepository,
  isCallSessionAdmissionError,
} from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "./migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const FIVE_MINUTES = new Date("2026-08-30T12:05:00.000Z");
const SESSION_1 = "01k3wceg000000000000000001" as Ulid;
const SESSION_2 = "01k3wceg000000000000000002" as Ulid;
const SESSION_3 = "01k3wceg000000000000000003" as Ulid;
const COMMAND_ID = "01k3wceg000000000000000010" as Ulid;
const ATTEMPT_ID = "01k3wceg000000000000000011" as Ulid;
const COMMAND_2 = "01k3wceg000000000000000012" as Ulid;
const ATTEMPT_2 = "01k3wceg000000000000000013" as Ulid;
const COMMAND_3 = "01k3wceg000000000000000014" as Ulid;
const ATTEMPT_3 = "01k3wceg000000000000000015" as Ulid;
const CALL_1 = `CA${"1".repeat(32)}`;
const CALL_2 = `CA${"2".repeat(32)}`;
const CALL_3 = `CA${"3".repeat(32)}`;
const VX_1 = `VX${"1".repeat(32)}`;
const VX_2 = `VX${"2".repeat(32)}`;
const NONCE_1 = `${"A".repeat(42)}A`;
const NONCE_2 = `${"B".repeat(42)}E`;
const NONCE_3 = `${"C".repeat(42)}I`;
const OWNER_IDENTITY_ID = "identity:voice";
const GUEST_PRINCIPAL_ID = "principal:guest";
const GUEST_IDENTITY_ID = "identity:guest";
const GUEST_E164 = "+14165550111";
const UNGRANTED_E164 = "+14165550112";
const GRANT_ID = "01k3wceg000000000000000020";
const DOCUMENT_HASH = "b".repeat(64);
const CALL_PHASES = [
  "created", "connecting", "pre_auth", "authenticated", "active",
  "ending", "completed", "rejected", "failed", "expired",
] as const satisfies readonly CallPhase[];
const LEGAL_PHASE_TARGETS = {
  created: ["connecting", "rejected", "failed", "expired"],
  connecting: ["pre_auth", "rejected", "failed", "expired"],
  pre_auth: ["authenticated", "rejected", "failed", "expired"],
  authenticated: ["active", "ending", "failed", "expired"],
  active: ["ending", "failed", "expired"],
  ending: ["completed", "failed"],
  completed: [],
  rejected: [],
  failed: [],
  expired: [],
} as const satisfies Record<CallPhase, readonly CallPhase[]>;
const PHASE_PATHS = {
  created: [],
  connecting: ["connecting"],
  pre_auth: ["connecting", "pre_auth"],
  authenticated: ["connecting", "pre_auth", "authenticated"],
  active: ["connecting", "pre_auth", "authenticated", "active"],
  ending: ["connecting", "pre_auth", "authenticated", "active", "ending"],
  completed: ["connecting", "pre_auth", "authenticated", "active", "ending", "completed"],
  rejected: ["rejected"],
  failed: ["failed"],
  expired: ["expired"],
} as const satisfies Record<CallPhase, readonly CallPhase[]>;

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM identity_challenges"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM device_keys"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedHuman(input: {
  identityStatus?: "pending" | "active" | "disabled";
  principalStatus?: "active" | "disabled";
  providerSubject?: string;
} = {}): Promise<void> {
  const timestamp = NOW.toISOString();
  const identityStatus = input.identityStatus ?? "active";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', ?, 'Owner', ?, ?)`)
      .bind(input.principalStatus ?? "active", timestamp, timestamp),
    env.DB.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint,
      key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:owner', 'principal:owner', 'key:owner', ?, ?, 1,
      'ed25519', 'active', 'laptop', ?, ?)`)
      .bind("A".repeat(43) + "=", "a".repeat(64), "b".repeat(64), timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at,
      created_at, enrolled_by_device_id
    ) VALUES ('identity:voice', 'principal:owner', 'voice', ?, ?, ?, ?, 'device:owner')`)
      .bind(
        input.providerSubject ?? "+14165550123",
        identityStatus,
        identityStatus === "active" ? timestamp : null,
        timestamp,
      ),
  ]);
  if ((input.principalStatus ?? "active") === "active" && identityStatus !== "disabled") {
    await env.DB.prepare(`INSERT INTO voice_owner_identity (
      singleton_id, principal_id, identity_id, created_at
    ) VALUES (1, 'principal:owner', 'identity:voice', ?)`)
      .bind(timestamp).run();
  }
}

async function seedServiceIdentity(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:service', 'service', 'active', 'Service', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at,
      created_at, enrolled_by_device_id
    ) VALUES ('identity:service', 'principal:service', 'voice', '+14165550999',
      'active', ?, ?, NULL)`)
      .bind(timestamp, timestamp),
  ]);
}

async function seedGuest(input: {
  principalId?: string;
  identityId?: string;
  providerSubject?: string;
  identityStatus?: "pending" | "active";
  grantStatus?: "pending" | "active";
} = {}): Promise<void> {
  const timestamp = NOW.toISOString();
  const principalId = input.principalId ?? GUEST_PRINCIPAL_ID;
  const identityId = input.identityId ?? GUEST_IDENTITY_ID;
  const identityStatus = input.identityStatus ?? "active";
  const grantStatus = input.grantStatus ?? "active";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'Guest', ?, ?)`)
      .bind(principalId, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?, ?, 'voice', ?, ?, ?, ?)`)
      .bind(
        identityId,
        principalId,
        input.providerSubject ?? GUEST_E164,
        identityStatus,
        identityStatus === "active" ? timestamp : null,
        timestamp,
      ),
    env.DB.prepare(`INSERT INTO voice_access_grants (
      grant_id, principal_id, identity_id, grant_version, capability_ids_json,
      resource_scopes_json, access_document_hash, pin_schema_version, pin_algorithm,
      pin_pepper_version, pin_iterations, pin_salt_base64, pin_digest_base64,
      status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, 1, '["conversation.basic"]',
      '{"schemaVersion":"1.0","calendarConnectionIds":[],"fileRootIds":[],"pcActionIds":[]}',
      ?, '2.0', 'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 600000,
      'AAAAAAAAAAAAAAAAAAAAAA==', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ?, 'identity:voice', ?, ?, ?, NULL)`)
      .bind(
        GRANT_ID,
        principalId,
        identityId,
        DOCUMENT_HASH,
        grantStatus,
        timestamp,
        grantStatus === "active" ? timestamp : null,
        timestamp,
      ),
  ]);
}

async function seedUngrantVoiceIdentity(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:ungranted', 'human', 'active', 'Ungrant', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES ('identity:ungranted', 'principal:ungranted', 'voice', ?, 'active', ?, ?)`)
      .bind(UNGRANTED_E164, timestamp, timestamp),
  ]);
}

async function seedChallenge(input: {
  challengeId: string;
  createdAt?: string;
  expiresAt?: string;
  hmacKeyVersion?: string;
  consumedAt?: string | null;
}): Promise<void> {
  await env.DB.prepare(`INSERT INTO identity_challenges (
    challenge_id, principal_id, identity_id, channel, initiating_device_id,
    initiating_key_id, initiating_key_fingerprint, initiating_key_generation,
    response_hmac, hmac_key_version, expires_at, consumed_at, created_at
  ) VALUES (?, 'principal:owner', 'identity:voice', 'voice', 'device:owner',
    'key:owner', ?, 1, ?, ?, ?, ?, ?)`)
    .bind(
      input.challengeId,
      "a".repeat(64),
      "c".repeat(64),
      input.hmacKeyVersion ?? "hmac-v1",
      input.expiresAt ?? FIVE_MINUTES.toISOString(),
      input.consumedAt ?? null,
      input.createdAt ?? NOW.toISOString(),
    ).run();
}

function matrixSessionId(index: number): Ulid {
  return `01k3wceg00${String(index).padStart(16, "0")}` as Ulid;
}

function matrixCallSid(index: number): string {
  return `CA${String(index).padStart(32, "0")}`;
}

function matrixNonce(index: number): string {
  return `${String(index).padStart(42, "A")}A`;
}

async function insertDirectNormalInbound(index: number): Promise<Ulid> {
  const sessionId = matrixSessionId(index);
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id,
    destination_identity_id, direction, activation_only, activation_challenge_id,
    activation_hmac_key_version, relay_nonce, nonce_expires_at,
    relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, 'principal:owner', 'identity:voice', 'identity:voice',
    'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?, 'owner', NULL, NULL, NULL)`)
    .bind(
      sessionId,
      matrixCallSid(index),
      matrixNonce(index),
      FIVE_MINUTES.toISOString(),
      FIVE_MINUTES.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
  return sessionId;
}

function insertDirectInbound(input: {
  principalId?: string;
  identityId?: string;
  destinationIdentityId?: string;
  activationOnly?: 0 | 1;
  activationChallengeId?: string | null;
  activationHmacKeyVersion?: string | null;
  relaySetupExpiresAt?: string | null;
} = {}): Promise<D1Result<unknown>> {
  const identityId = input.identityId ?? "identity:voice";
  const activationOnly = input.activationOnly ?? 0;
  return env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id,
    destination_identity_id, direction, activation_only, activation_challenge_id,
    activation_hmac_key_version, relay_nonce, nonce_expires_at,
    relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, NULL, 'created', ?, ?,
    'owner', NULL, NULL, NULL)`)
    .bind(
      SESSION_1,
      CALL_1,
      input.principalId ?? "principal:owner",
      identityId,
      input.destinationIdentityId ?? identityId,
      activationOnly,
      input.activationChallengeId ?? null,
      input.activationHmacKeyVersion ?? null,
      NONCE_1,
      input.relaySetupExpiresAt ?? FIVE_MINUTES.toISOString(),
      input.relaySetupExpiresAt ?? FIVE_MINUTES.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
}

function repository(): CallRepository {
  const nonces = [NONCE_1, NONCE_2, NONCE_3];
  const sessions = [SESSION_1, SESSION_2, SESSION_3];
  return new CallRepository(
    env.DB,
    new EventRepository(env.DB),
    () => nonces.shift() ?? NONCE_3,
    300_000,
    () => sessions.shift() ?? SESSION_3,
  );
}

async function outboundBinding(input: {
  repo: CallRepository;
  commandId: Ulid;
  attemptId: Ulid;
  callSid: string;
  ordinal: number;
}): Promise<RelayBinding> {
  await env.DB.prepare(`INSERT INTO policy_decisions (
    decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at
  ) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)`)
    .bind(input.commandId, input.ordinal.toString(16).padStart(64, "0"), NOW.toISOString()).run();
  const expected = await input.repo.getOrCreateExpectedCall({
    attemptId: input.attemptId,
    commandId: input.commandId,
    principalId: "principal:owner",
    destinationIdentityId: "identity:voice",
    idempotencyKey: `call:${input.ordinal}`,
    authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
    attemptOrdinal: 0,
    now: NOW,
  });
  await input.repo.claimProviderDispatch({ attemptId: input.attemptId, now: NOW });
  const binding = await input.repo.claimExpectedCall({
    attemptId: input.attemptId,
    callSid: input.callSid,
    observedDestinationIdentityId: expected.destinationIdentityId,
    ownerIdentityId: OWNER_IDENTITY_ID,
    now: NOW,
  });
  if (binding === null) throw new Error("fixture_binding_missing");
  return binding;
}

async function inbound(repo: CallRepository, callSid = CALL_1, now = NOW) {
  return repo.getOrCreateInboundSession({
    callSid,
    callerE164: "+14165550123",
    ownerIdentityId: OWNER_IDENTITY_ID,
    currentChallengeHmacKeyVersion: "hmac-v1",
    now,
  });
}

async function callbackEnvelope(): Promise<PersistableEventEnvelopeV1> {
  const audit = new Redactor().redactText("safe relay callback");
  if (!audit.ok) throw new Error("fixture_redaction_failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId: newUlid(),
    eventType: "provider.relay_ended",
    source: "twilio",
    subjectId: "principal:owner",
    occurredAt: NOW.toISOString(),
    receivedAt: NOW.toISOString(),
    correlationId: SESSION_1,
    contentType: "application/json",
    payload: { audit },
    producerVersion: "test",
  });
}

describe("CallRepository call sessions", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
  });

  afterEach(clearFixture);

  it("rejects relay nonce lifetimes above the five-minute authority ceiling", () => {
    expect(() => new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE_1, 300_001))
      .toThrow("relay_nonce_ttl_invalid");
  });

  it("creates a frozen normal inbound session from the active verified D1 identity", async () => {
    await seedHuman();
    const stored = await inbound(repository());

    expect(stored).toMatchObject({
      sessionId: SESSION_1,
      callSid: CALL_1,
      direction: "inbound",
      phase: "created",
      relaySetupExpiresAt: FIVE_MINUTES.toISOString(),
      binding: {
        callSid: CALL_1,
        principalId: "principal:owner",
        identityId: "identity:voice",
        destinationIdentityId: "identity:voice",
        direction: "inbound",
        activationOnly: false,
        activationChallengeId: null,
        accessKind: "owner",
        guestGrantId: null,
        guestGrantVersion: null,
        accessDocumentHash: null,
      },
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.binding)).toBe(true);
  });

  it("admits the configured owner and an exact pending guest grant but rejects an active ungranted number", async () => {
    await seedHuman();
    await seedGuest({ identityStatus: "pending", grantStatus: "pending" });
    await seedUngrantVoiceIdentity();
    const repo = repository();

    await expect(inbound(repo, CALL_1)).resolves.toMatchObject({
      binding: {
        accessKind: "owner",
        principalId: "principal:owner",
        identityId: OWNER_IDENTITY_ID,
        guestGrantId: null,
        guestGrantVersion: null,
        accessDocumentHash: null,
      },
    });
    await expect(repo.getOrCreateInboundSession({
      callSid: CALL_2,
      callerE164: GUEST_E164,
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    })).resolves.toMatchObject({
      binding: {
        accessKind: "guest",
        principalId: GUEST_PRINCIPAL_ID,
        identityId: GUEST_IDENTITY_ID,
        guestGrantId: GRANT_ID,
        guestGrantVersion: 1,
        accessDocumentHash: DOCUMENT_HASH,
        activationOnly: false,
        activationChallengeId: null,
      },
    });
    await expect(repo.getOrCreateInboundSession({
      callSid: CALL_3,
      callerE164: UNGRANTED_E164,
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    })).rejects.toSatisfy(isCallSessionAdmissionError);
  });

  it("rejects an inbound replay after the exact guest grant lineage changes", async () => {
    await seedHuman();
    await seedGuest();
    const repo = repository();
    const input = {
      callSid: CALL_1,
      callerE164: GUEST_E164,
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    } as const;
    await expect(repo.getOrCreateInboundSession(input)).resolves.toMatchObject({
      binding: { accessKind: "guest", guestGrantVersion: 1 },
    });
    await env.DB.prepare(`UPDATE voice_access_grants
      SET grant_version = 2, capability_ids_json = '["conversation.basic","research.web"]',
          access_document_hash = ?, updated_at = ?
      WHERE grant_id = ?`)
      .bind("c".repeat(64), "2026-08-30T12:00:01.000Z", GRANT_ID).run();
    await expect(repo.getOrCreateInboundSession(input)).rejects.toSatisfy(isCallSessionAdmissionError);
  });

  it("binds an outbound guest session to the destination principal and exact grant lineage", async () => {
    await seedHuman();
    await seedGuest();
    await env.DB.prepare(`INSERT INTO policy_decisions (
      decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at
    ) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)`)
      .bind(COMMAND_ID, "d".repeat(64), NOW.toISOString()).run();
    const repo = repository();
    await repo.getOrCreateExpectedCall({
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
      principalId: "principal:owner",
      destinationIdentityId: GUEST_IDENTITY_ID,
      idempotencyKey: "call:guest",
      authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
      attemptOrdinal: 0,
      now: NOW,
    });
    await repo.claimProviderDispatch({ attemptId: ATTEMPT_ID, now: NOW });
    const binding = await repo.claimExpectedCall({
      attemptId: ATTEMPT_ID,
      callSid: CALL_1,
      observedDestinationIdentityId: GUEST_IDENTITY_ID,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    });
    expect(binding).toMatchObject({
      principalId: GUEST_PRINCIPAL_ID,
      identityId: GUEST_IDENTITY_ID,
      destinationIdentityId: GUEST_IDENTITY_ID,
      accessKind: "guest",
      guestGrantId: GRANT_ID,
      guestGrantVersion: 1,
      accessDocumentHash: DOCUMENT_HASH,
    });
    if (binding === null) throw new Error("fixture_binding_missing");
    await expect(repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: NOW }))
      .resolves.toMatchObject({ binding: { principalId: GUEST_PRINCIPAL_ID, accessKind: "guest" } });
  });

  it("selects the newest eligible activation challenge deterministically and caps setup at challenge expiry", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:a", createdAt: "2026-08-30T11:59:00.000Z" });
    await seedChallenge({ challengeId: "challenge:b", createdAt: NOW.toISOString(), expiresAt: "2026-08-30T12:02:00.000Z" });
    await seedChallenge({ challengeId: "challenge:c", createdAt: NOW.toISOString(), expiresAt: "2026-08-30T12:03:00.000Z" });

    const stored = await inbound(repository());
    expect(stored.relaySetupExpiresAt).toBe("2026-08-30T12:03:00.000Z");
    expect(stored.binding).toMatchObject({
      identityId: "identity:voice",
      destinationIdentityId: "identity:voice",
      activationOnly: true,
      activationChallengeId: "challenge:c",
    });
  });

  it("keeps the inbound activation window independent from a stricter outbound nonce TTL", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:live" });
    const repo = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE_1, 60_000, () => SESSION_1);
    const stored = await inbound(repo);
    expect(stored.relaySetupExpiresAt).toBe(FIVE_MINUTES.toISOString());
  });

  it.each([
    ["disabled principal", async () => env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:owner'").run()],
    ["disabled identity", async () => env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'").run()],
    ["revoked device", async () => env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:owner'").bind(NOW.toISOString()).run()],
    ["rotated key", async () => env.DB.prepare("UPDATE device_keys SET key_id = 'key:rotated', key_generation = 2 WHERE device_id = 'device:owner'").run()],
  ])("rejects a pending caller after the %s eligibility barrier changes", async (_label, mutate) => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:live" });
    await mutate();
    await expect(inbound(repository())).rejects.toThrow("inbound_session_rejected");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions").first<{ count: number }>())?.count).toBe(0);
  });

  it("treats a caller as normal after challenge consumption activates the identity", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:live" });
    await env.DB.prepare("UPDATE identity_challenges SET consumed_at = ? WHERE challenge_id = 'challenge:live'")
      .bind(NOW.toISOString()).run();
    const stored = await inbound(repository());
    expect(stored.binding).toMatchObject({ activationOnly: false, activationChallengeId: null });
  });

  it.each([
    ["expired", { createdAt: "2026-08-30T11:59:00.000Z", expiresAt: NOW.toISOString() }],
    ["stale HMAC key", { hmacKeyVersion: "hmac-v0" }],
  ])("rejects a pending caller whose newest challenge is %s", async (_label, challenge) => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:ineligible", ...challenge });
    await expect(inbound(repository())).rejects.toThrow("inbound_session_rejected");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions").first<{ count: number }>())?.count).toBe(0);
  });

  it("converges equivalent concurrent retries and rejects changed caller lineage", async () => {
    await seedHuman();
    const repo = repository();
    const [first, second] = await Promise.all([inbound(repo), inbound(repo)]);
    expect(second).toEqual(first);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.binding.relayNonce).toBe(first.binding.relayNonce);

    await expect(repo.getOrCreateInboundSession({
      callSid: CALL_1,
      callerE164: "+14165559999",
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    })).rejects.toThrow("call_session_conflict");
  });

  it("freezes the provider-observed identity subject once a call session captures it", async () => {
    await seedHuman();
    const repo = repository();
    await inbound(repo);
    await expect(env.DB.prepare("UPDATE channel_identities SET provider_subject = '+14165559999' WHERE identity_id = 'identity:voice'").run())
      .rejects.toThrow("call_session_identity_subject_immutable");
    await expect(repo.getOrCreateInboundSession({
      callSid: CALL_1,
      callerE164: "+14165559999",
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    })).rejects.toThrow("call_session_conflict");
  });

  it("atomically admits only one of two calls when one active slot remains", async () => {
    await seedHuman();
    const repo = repository();
    await inbound(repo, CALL_1);
    const results = await Promise.allSettled([inbound(repo, CALL_2), inbound(repo, CALL_3)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await repo.countActiveSessions({ principalId: "principal:owner", now: NOW })).toBe(2);
  });

  it("keeps an expired never-bound CallSid as a tombstone without consuming capacity", async () => {
    await seedHuman();
    const repo = repository();
    await inbound(repo, CALL_1);
    await expect(inbound(repo, CALL_1, FIVE_MINUTES)).rejects.toThrow("call_session_expired");
    expect(await repo.countActiveSessions({ principalId: "principal:owner", direction: "inbound", now: FIVE_MINUTES })).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions WHERE call_sid = ?").bind(CALL_1).first<{ count: number }>())?.count).toBe(1);
  });

  it("creates a deterministic outbound session only from the exact dispatched attempt lineage", async () => {
    await seedHuman();
    await env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)")
      .bind(COMMAND_ID, "d".repeat(64), NOW.toISOString()).run();
    const repo = repository();
    const expected = await repo.getOrCreateExpectedCall({
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
      principalId: "principal:owner",
      destinationIdentityId: "identity:voice",
      idempotencyKey: "call:one",
      authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
      attemptOrdinal: 0,
      now: NOW,
    });
    await repo.claimProviderDispatch({ attemptId: ATTEMPT_ID, now: NOW });
    const binding = await repo.claimExpectedCall({
      attemptId: ATTEMPT_ID,
      callSid: CALL_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    });
    if (binding === null) throw new Error("fixture_binding_missing");

    const first = await repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: FIVE_MINUTES });
    const replay = await repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: FIVE_MINUTES });
    expect(first.sessionId).toBe(ATTEMPT_ID);
    expect(first.relaySetupExpiresAt).toBeNull();
    expect(replay).toEqual(first);
    const drift = { ...binding, destinationIdentityId: "identity:other" } as RelayBinding;
    await expect(repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding: drift, now: FIVE_MINUTES })).rejects.toThrow("call_session_conflict");
  });

  it("atomically admits only one of two distinct outbound sessions when one active slot remains", async () => {
    await seedHuman();
    const repo = repository();
    const first = await outboundBinding({ repo, commandId: COMMAND_ID, attemptId: ATTEMPT_ID, callSid: CALL_1, ordinal: 1 });
    const second = await outboundBinding({ repo, commandId: COMMAND_2, attemptId: ATTEMPT_2, callSid: CALL_2, ordinal: 2 });
    const third = await outboundBinding({ repo, commandId: COMMAND_3, attemptId: ATTEMPT_3, callSid: CALL_3, ordinal: 3 });
    await repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding: first, now: NOW });
    const results = await Promise.allSettled([
      repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_2, binding: second, now: NOW }),
      repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_3, binding: third, now: NOW }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await repo.countActiveSessions({ principalId: "principal:owner", direction: "outbound", now: NOW })).toBe(2);
  });

  it("rejects direct SQL outbound rows that drift from the dispatched attempt", async () => {
    await seedHuman();
    const repo = repository();
    const binding = await outboundBinding({ repo, commandId: COMMAND_ID, attemptId: ATTEMPT_ID, callSid: CALL_1, ordinal: 1 });
    const driftedNonce = binding.relayNonce === NONCE_2 ? NONCE_3 : NONCE_2;
    await expect(env.DB.prepare(`INSERT INTO call_sessions (
      session_id, call_sid, expected_attempt_id, principal_id, identity_id,
      destination_identity_id, direction, activation_only, activation_challenge_id,
      activation_hmac_key_version, relay_nonce, nonce_expires_at,
      relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
      access_kind, guest_grant_id, guest_grant_version, access_document_hash
    ) VALUES (?, ?, ?, 'principal:owner', 'identity:voice', 'identity:voice',
      'outbound', 0, NULL, NULL, ?, ?, NULL, NULL, 'created', ?, ?, 'owner', NULL, NULL, NULL)`)
      .bind(
        ATTEMPT_ID,
        CALL_1,
        ATTEMPT_ID,
        driftedNonce,
        FIVE_MINUTES.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ).run()).rejects.toThrow("outbound_session_attempt_mismatch");
  });

  it("requires outbound first VX bind before nonce expiry but keeps a prior exact bind replay-safe", async () => {
    await seedHuman();
    await env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)")
      .bind(COMMAND_ID, "d".repeat(64), NOW.toISOString()).run();
    const repo = repository();
    const expected = await repo.getOrCreateExpectedCall({
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
      principalId: "principal:owner",
      destinationIdentityId: "identity:voice",
      idempotencyKey: "call:one",
      authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
      attemptOrdinal: 0,
      now: NOW,
    });
    await repo.claimProviderDispatch({ attemptId: ATTEMPT_ID, now: NOW });
    const binding = await repo.claimExpectedCall({
      attemptId: ATTEMPT_ID,
      callSid: CALL_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    });
    if (binding === null) throw new Error("fixture_binding_missing");
    const session = await repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: NOW });
    const bind = (now: Date) => repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: binding.relayNonce,
      direction: "outbound",
      now,
    });
    await expect(bind(FIVE_MINUTES)).rejects.toThrow("call_session_bind_conflict");
    await expect(bind(NOW)).resolves.toMatchObject({ providerSessionId: VX_1 });
    await expect(bind(FIVE_MINUTES)).resolves.toMatchObject({ providerSessionId: VX_1 });
  });

  it("binds the first provider VX idempotently and enforces the phase graph", async () => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    const input = {
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound" as const,
      now: NOW,
    };
    expect((await repo.bindRelaySession(input)).providerSessionId).toBe(VX_1);
    expect((await repo.bindRelaySession({ ...input, now: FIVE_MINUTES })).providerSessionId).toBe(VX_1);
    await expect(repo.bindRelaySession({ ...input, providerSessionId: VX_2 })).rejects.toThrow("call_session_bind_conflict");

    const connecting = await repo.transitionCallSession({ sessionId: session.sessionId, expectedPhase: "created", nextPhase: "connecting", now: FIVE_MINUTES });
    expect(connecting.phase).toBe("connecting");
    await expect(repo.transitionCallSession({ sessionId: session.sessionId, expectedPhase: "connecting", nextPhase: "active", now: FIVE_MINUTES })).rejects.toThrow("invalid_call_transition");
  });

  it("enforces the complete 10-by-10 phase graph in direct SQL, including every terminal reversal", async () => {
    await seedHuman();
    let fixtureIndex = 1_000;
    for (const source of CALL_PHASES) {
      for (const target of CALL_PHASES) {
        const sessionId = await insertDirectNormalInbound(fixtureIndex);
        fixtureIndex += 1;
        for (const phase of PHASE_PATHS[source]) {
          await env.DB.prepare("UPDATE call_sessions SET phase = ?, updated_at = ? WHERE session_id = ?")
            .bind(phase, NOW.toISOString(), sessionId).run();
        }
        const mutation = env.DB.prepare("UPDATE call_sessions SET phase = ?, updated_at = ? WHERE session_id = ?")
          .bind(target, NOW.toISOString(), sessionId).run();
        const allowed = target === source || (LEGAL_PHASE_TARGETS[source] as readonly CallPhase[]).includes(target);
        if (allowed) {
          await expect(mutation).resolves.toBeDefined();
        } else {
          await expect(mutation).rejects.toThrow("call_session_phase_transition_invalid");
        }
      }
    }
  });

  it("admits exactly one concurrent provider VX binding", async () => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    const common = {
      sessionId: session.sessionId,
      callSid: session.callSid,
      relayNonce: session.binding.relayNonce,
      direction: "inbound" as const,
      now: NOW,
    };
    const results = await Promise.allSettled([
      repo.bindRelaySession({ ...common, providerSessionId: VX_1 }),
      repo.bindRelaySession({ ...common, providerSessionId: VX_2 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT provider_session_id FROM call_sessions").first<{ provider_session_id: string }>())?.provider_session_id)
      .toMatch(/^VX(?:1{32}|2{32})$/u);
  });

  it.each([
    ["at the exact setup deadline", async (_repo: CallRepository, _session: Awaited<ReturnType<typeof inbound>>) => undefined, FIVE_MINUTES],
    ["after identity disable", async (_repo: CallRepository, _session: Awaited<ReturnType<typeof inbound>>) => {
      await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'").run();
    }, NOW],
    ["after a terminal transition", async (repo: CallRepository, session: Awaited<ReturnType<typeof inbound>>) => {
      await repo.transitionCallSession({ sessionId: session.sessionId, expectedPhase: "created", nextPhase: "rejected", now: NOW });
    }, NOW],
  ])("rejects first provider binding %s", async (_label, mutate, at) => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    await mutate(repo, session);
    await expect(repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound",
      now: at,
    })).rejects.toThrow("call_session_bind_conflict");
  });

  it.each([
    ["after challenge consumption", async () => {
      await env.DB.prepare("UPDATE identity_challenges SET consumed_at = ? WHERE challenge_id = 'challenge:live'")
        .bind(NOW.toISOString()).run();
      return NOW;
    }],
    ["at challenge expiry", async () => new Date("2026-08-30T12:01:00.000Z")],
    ["after initiating device revocation", async () => {
      await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:owner'")
        .bind(NOW.toISOString()).run();
      return NOW;
    }],
    ["after initiating key rotation", async () => {
      await env.DB.prepare("UPDATE device_keys SET key_id = 'key:rotated', key_generation = 2 WHERE device_id = 'device:owner'").run();
      return NOW;
    }],
  ])("rejects activation first binding %s", async (_label, mutate) => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:live", expiresAt: "2026-08-30T12:01:00.000Z" });
    const repo = repository();
    const session = await inbound(repo);
    const at = await mutate();
    await expect(repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound",
      now: at,
    })).rejects.toThrow("call_session_bind_conflict");
  });

  it("keeps an activation session as copied text while foundation challenge reclamation creates a replacement", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:old", expiresAt: "2026-08-30T12:01:00.000Z" });
    const oldSession = await inbound(repository());
    expect(oldSession.binding.activationChallengeId).toBe("challenge:old");
    await seedChallenge({
      challengeId: "challenge:new",
      createdAt: "2026-08-30T12:01:00.000Z",
      expiresAt: "2026-08-30T12:06:00.000Z",
    });
    expect((await env.DB.prepare("SELECT challenge_id FROM identity_challenges").all<{ challenge_id: string }>()).results)
      .toEqual([{ challenge_id: "challenge:new" }]);
    expect((await env.DB.prepare("SELECT activation_challenge_id FROM call_sessions").first<{ activation_challenge_id: string }>())?.activation_challenge_id)
      .toBe("challenge:old");
  });

  it("makes referenced challenge lineage immutable and permanently tombstones a reclaimed challenge id", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:old", expiresAt: "2026-08-30T12:01:00.000Z" });
    const repo = repository();
    const session = await inbound(repo);
    await repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound",
      now: NOW,
    });
    await expect(env.DB.prepare("UPDATE identity_challenges SET expires_at = ? WHERE challenge_id = 'challenge:old'")
      .bind("2026-08-30T12:10:00.000Z").run()).rejects.toThrow("identity_challenge_call_session_immutable");

    await seedChallenge({
      challengeId: "challenge:new",
      createdAt: "2026-08-30T12:01:00.000Z",
      expiresAt: "2026-08-30T12:06:00.000Z",
    });
    expect(await env.DB.prepare("SELECT 1 FROM identity_challenges WHERE challenge_id = 'challenge:old'").first()).toBeNull();
    await expect(seedChallenge({
      challengeId: "challenge:old",
      createdAt: "2026-08-30T12:01:00.000Z",
      expiresAt: "2026-08-30T12:06:00.000Z",
    })).rejects.toThrow("identity_challenge_id_reuse");
    await expect(env.DB.prepare("UPDATE identity_challenges SET challenge_id = 'challenge:old' WHERE challenge_id = 'challenge:new'").run())
      .rejects.toThrow("identity_challenge_id_immutable");
  });

  it.each([
    ["noncanonical expiry", "zzzz", NOW.toISOString()],
    ["noncanonical creation", FIVE_MINUTES.toISOString(), "zzzz"],
    ["nonpositive lifetime", NOW.toISOString(), NOW.toISOString()],
  ])("rejects an identity challenge with %s", async (_label, expiresAt, createdAt) => {
    await seedHuman({ identityStatus: "pending" });
    await expect(seedChallenge({ challengeId: "challenge:invalid-time", expiresAt, createdAt }))
      .rejects.toThrow("identity_challenge_timestamp_invalid");
  });

  it("does not admit a future-issued activation challenge before its creation time", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({
      challengeId: "challenge:future",
      createdAt: "2026-08-30T12:01:00.000Z",
      expiresAt: "2026-08-30T12:06:00.000Z",
    });
    await expect(inbound(repository())).rejects.toThrow("inbound_session_rejected");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions").first<{ count: number }>())?.count).toBe(0);
  });

  it("rolls back every callback dependency when relay-ended CallSid/VX correlation mismatches", async () => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    await repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound",
      now: NOW,
    });
    await expect(repo.appendProviderEvent({
      endpointKind: "relay_ended",
      callSid: session.callSid,
      sessionId: VX_2,
      requestHash: await sha256Hex(canonicalJson({ relay: "mismatch" })),
      envelope: await callbackEnvelope(),
    })).rejects.toThrow("provider_relay_session_mismatch");
    for (const table of ["provider_events", "events", "idempotency_records", "outbox"]) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count).toBe(0);
    }
  });

  it("does not reopen a terminal CallSid tombstone on a signed retry", async () => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    await repo.transitionCallSession({ sessionId: session.sessionId, expectedPhase: "created", nextPhase: "rejected", now: NOW });
    await expect(inbound(repo)).rejects.toThrow("call_session_conflict");
  });

  it("rejects direct SQL lineage NULLs, VX removal/replacement, time regression, illegal transitions, and deletion", async () => {
    await seedHuman();
    const repo = repository();
    const session = await inbound(repo);
    await repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: VX_1,
      relayNonce: session.binding.relayNonce,
      direction: "inbound",
      now: NOW,
    });
    await expect(env.DB.prepare("UPDATE call_sessions SET principal_id = 'principal:other' WHERE session_id = ?").bind(session.sessionId).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE call_sessions SET call_sid = NULL WHERE session_id = ?").bind(session.sessionId).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE call_sessions SET relay_setup_expires_at = NULL WHERE session_id = ?").bind(session.sessionId).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE call_sessions SET provider_session_id = NULL WHERE session_id = ?").bind(session.sessionId).run())
      .rejects.toThrow("call_session_provider_binding_invalid");
    await expect(env.DB.prepare("UPDATE call_sessions SET provider_session_id = ? WHERE session_id = ?").bind(VX_2, session.sessionId).run())
      .rejects.toThrow("call_session_provider_binding_invalid");
    await expect(env.DB.prepare("UPDATE call_sessions SET phase = 'active' WHERE session_id = ?").bind(session.sessionId).run()).rejects.toThrow();
    const advancedAt = "2026-08-30T12:00:01.000Z";
    await repo.transitionCallSession({
      sessionId: session.sessionId,
      expectedPhase: "created",
      nextPhase: "connecting",
      now: new Date(advancedAt),
    });
    await expect(env.DB.prepare("UPDATE call_sessions SET updated_at = ? WHERE session_id = ?")
      .bind(NOW.toISOString(), session.sessionId).run()).rejects.toThrow("call_session_time_regression");
    await expect(env.DB.prepare("DELETE FROM call_sessions WHERE session_id = ?").bind(session.sessionId).run()).rejects.toThrow();
  });

  it.each([
    ["pre-bound provider session", VX_1, "created", NOW.toISOString()],
    ["advanced phase", null, "active", NOW.toISOString()],
    ["advanced updated time", null, "created", "2026-08-30T12:00:00.001Z"],
  ])("rejects direct SQL insertion with %s", async (_label, providerSessionId, phase, updatedAt) => {
    await seedHuman();
    await expect(env.DB.prepare(`INSERT INTO call_sessions (
      session_id, call_sid, expected_attempt_id, principal_id, identity_id,
      destination_identity_id, direction, activation_only, activation_challenge_id,
      activation_hmac_key_version, relay_nonce, nonce_expires_at,
      relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
      access_kind, guest_grant_id, guest_grant_version, access_document_hash
    ) VALUES (?, ?, NULL, 'principal:owner', 'identity:voice', 'identity:voice',
      'inbound', 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'owner', NULL, NULL, NULL)`)
      .bind(
        SESSION_1,
        CALL_1,
        NONCE_1,
        FIVE_MINUTES.toISOString(),
        FIVE_MINUTES.toISOString(),
        providerSessionId,
        phase,
        NOW.toISOString(),
        updatedAt,
      ).run()).rejects.toThrow("call_session_initial_state_invalid");
  });

  it.each([
    ["pending normal identity", async () => {
      await seedHuman({ identityStatus: "pending" });
      return {};
    }],
    ["disabled normal identity", async () => {
      await seedHuman({ identityStatus: "disabled" });
      return {};
    }],
    ["disabled principal", async () => {
      await seedHuman({ principalStatus: "disabled" });
      return {};
    }],
    ["cross-principal identity", async () => {
      await seedHuman();
      await seedServiceIdentity();
      return { identityId: "identity:service", destinationIdentityId: "identity:service" };
    }],
    ["service principal", async () => {
      await seedHuman();
      await seedServiceIdentity();
      return {
        principalId: "principal:service",
        identityId: "identity:service",
        destinationIdentityId: "identity:service",
      };
    }],
  ])("rejects direct SQL inbound lineage for %s", async (_label, arrange) => {
    const input = await arrange();
    await expect(insertDirectInbound(input)).rejects.toThrow(
      /(?:inbound_session_lineage_mismatch|call_session_voice_access_required)/u,
    );
  });

  it.each([
    ["foreign identity challenge", async () => {
      await seedHuman({ identityStatus: "pending" });
      await seedChallenge({ challengeId: "challenge:live" });
      await env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at,
        created_at, enrolled_by_device_id
      ) VALUES ('identity:other', 'principal:owner', 'voice', '+14165550999',
        'pending', NULL, ?, 'device:owner')`).bind(NOW.toISOString()).run();
      return { identityId: "identity:other", destinationIdentityId: "identity:other" };
    }],
    ["consumed challenge", async () => {
      await seedHuman({ identityStatus: "pending" });
      await seedChallenge({ challengeId: "challenge:live" });
      await env.DB.prepare("UPDATE identity_challenges SET consumed_at = ? WHERE challenge_id = 'challenge:live'")
        .bind(NOW.toISOString()).run();
      return {};
    }],
    ["expired challenge", async () => {
      await seedHuman({ identityStatus: "pending" });
      await seedChallenge({
        challengeId: "challenge:live",
        createdAt: "2026-08-30T11:58:00.000Z",
        expiresAt: "2026-08-30T11:59:00.000Z",
      });
      return {};
    }],
    ["wrong-channel challenge", async () => {
      await seedHuman({ identityStatus: "pending" });
      await seedChallenge({ challengeId: "challenge:live" });
      await env.DB.prepare("UPDATE identity_challenges SET channel = 'telegram' WHERE challenge_id = 'challenge:live'").run();
      return {};
    }],
    ["stale initiating device key", async () => {
      await seedHuman({ identityStatus: "pending" });
      await seedChallenge({ challengeId: "challenge:live" });
      await env.DB.prepare("UPDATE device_keys SET key_id = 'key:rotated', key_generation = 2 WHERE device_id = 'device:owner'").run();
      return {};
    }],
  ])("rejects direct SQL activation lineage for a %s", async (_label, arrange) => {
    const input = await arrange();
    await expect(insertDirectInbound({
      activationOnly: 1,
      activationChallengeId: "challenge:live",
      activationHmacKeyVersion: "hmac-v1",
      ...input,
    })).rejects.toThrow(/(?:inbound_session_lineage_mismatch|call_session_voice_access_required)/u);
  });

  it("rejects direct SQL activation insertion against an older eligible challenge", async () => {
    await seedHuman({ identityStatus: "pending" });
    await seedChallenge({ challengeId: "challenge:old", createdAt: "2026-08-30T11:59:00.000Z" });
    await seedChallenge({ challengeId: "challenge:new", createdAt: NOW.toISOString() });
    await expect(env.DB.prepare(`INSERT INTO call_sessions (
      session_id, call_sid, expected_attempt_id, principal_id, identity_id,
      destination_identity_id, direction, activation_only, activation_challenge_id,
      activation_hmac_key_version, relay_nonce, nonce_expires_at,
      relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
      access_kind, guest_grant_id, guest_grant_version, access_document_hash
    ) VALUES (?, ?, NULL, 'principal:owner', 'identity:voice', 'identity:voice',
      'inbound', 1, 'challenge:old', 'hmac-v1', ?, ?, ?, NULL, 'created', ?, ?,
      'owner', NULL, NULL, NULL)`)
      .bind(SESSION_1, CALL_1, NONCE_1, FIVE_MINUTES.toISOString(), FIVE_MINUTES.toISOString(), NOW.toISOString(), NOW.toISOString()).run())
      .rejects.toThrow("inbound_session_lineage_mismatch");
  });
});
