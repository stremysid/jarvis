import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  CallRepository,
  createRelayNonce,
  type ProviderDispatchClaimCapability,
} from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyFoundationMigration } from "./migration.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-08-29T12:06:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_0 = "01k3s6k8000000000000000001" as Ulid;
const ATTEMPT_1 = "01k3s6k8000000000000000002" as Ulid;
const ATTEMPT_2 = "01k3s6k8000000000000000003" as Ulid;
const CALL_SID_1 = `CA${"1".repeat(32)}`;
const CALL_SID_2 = `CA${"2".repeat(32)}`;
const NONCE_0 = `${"A".repeat(42)}A`;
const NONCE_1 = `${"B".repeat(42)}E`;
const HASH_1 = "1".repeat(64) as Sha256Hex;
const HASH_2 = "2".repeat(64) as Sha256Hex;

async function clearCallingData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_events"),
    env.DB.prepare("DELETE FROM outbound_call_attempts"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
  ]);
}

async function seedAuthorizedCommand(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "a".repeat(64), timestamp),
  ]);
}

function expectedAttempt(attemptId: Ulid) {
  return {
    attemptId,
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    destinationIdentityId: "identity:voice",
    idempotencyKey: "call:test",
    now: NOW,
  };
}

async function callbackEnvelope(eventId = newUlid()): Promise<PersistableEventEnvelopeV1> {
  const audit = new Redactor().redactText("safe provider callback metadata");
  if (!audit.ok) throw new Error("fixture_redaction_failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "provider.call_status",
    source: "twilio",
    subjectId: "principal:owner",
    occurredAt: NOW.toISOString(),
    receivedAt: NOW.toISOString(),
    correlationId: COMMAND_ID,
    contentType: "application/json",
    payload: { audit },
    producerVersion: "test",
  });
}

async function statusFixture(overrides: Partial<{
  attemptId: Ulid;
  callSid: string;
  callbackSource: string;
  sequenceNumber: number;
  requestHash: Sha256Hex;
  envelope: PersistableEventEnvelopeV1;
}> = {}) {
  return {
    endpointKind: "status" as const,
    attemptId: ATTEMPT_0,
    callSid: CALL_SID_1,
    callbackSource: "call-progress-events",
    sequenceNumber: 2,
    requestHash: HASH_1,
    envelope: await callbackEnvelope(),
    ...overrides,
  };
}

describe("CallRepository", () => {
  let repository: CallRepository;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearCallingData();
    await seedAuthorizedCommand();
    const nonces = [NONCE_0, NONCE_1];
    repository = new CallRepository(env.DB, new EventRepository(env.DB), () => nonces.shift() ?? NONCE_1);
  });

  afterEach(clearCallingData);

  it("creates canonical independent 32-byte relay nonces", () => {
    const first = createRelayNonce();
    const second = createRelayNonce();

    expect(first).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
    expect(second).not.toBe(first);
  });

  it("claims an expected call once and permits only same-CallSid replay after expiry", async () => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    expect(await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW })).toMatchObject({ kind: "claimed" });

    const first = await repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      now: NOW,
    });
    const replay = await repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      now: AFTER_EXPIRY,
    });

    expect(first).toMatchObject({ callSid: CALL_SID_1, principalId: expected.principalId, relayNonce: NONCE_0 });
    expect(replay).toEqual(first);
    await expect(repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_2,
      observedDestinationIdentityId: expected.destinationIdentityId,
      now: NOW,
    })).resolves.toBeNull();
  });

  it("requires the opaque one-use claim capability for provider result writes", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    const otherRepository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE_1);

    await expect(otherRepository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
    await expect(repository.recordProviderDispatchSuccess({
      claim: { attemptId: ATTEMPT_0 } as ProviderDispatchClaimCapability,
      callSid: "not-a-call-sid",
      now: NOW,
    })).rejects.toThrow("provider_dispatch_claim_invalid");
    await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
    await expect(repository.recordProviderDispatchUnknown({ claim: { attemptId: ATTEMPT_0 } as ProviderDispatchClaimCapability, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
  });

  it("binds a provider claim capability to the snapshotted row identity", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const mutable = { attemptId: ATTEMPT_0, now: NOW };

    const pending = repository.claimProviderDispatch(mutable);
    mutable.attemptId = ATTEMPT_1;
    const claim = await pending;

    expect(claim).toMatchObject({ kind: "claimed", capability: { attemptId: ATTEMPT_0 } });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({ kind: "existing", state: "provider_dispatch_unknown" });
  });

  it("reads a result capability accessor once and keeps it bound to its issued attempt", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    let claimReads = 0;
    const result = {
      get claim(): ProviderDispatchClaimCapability {
        claimReads += 1;
        return claimReads === 1
          ? claim.capability
          : { attemptId: ATTEMPT_1 } as ProviderDispatchClaimCapability;
      },
      now: NOW,
    };

    await repository.recordProviderDispatchUnknown(result);

    expect(claimReads).toBe(1);
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "provider_dispatch_unknown",
    });
  });

  it("returns only the snapshotted CallSid from an expected-call claim", async () => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    const mutable = {
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      now: NOW,
    };

    const pending = repository.claimExpectedCall(mutable);
    mutable.callSid = CALL_SID_2;

    await expect(pending).resolves.toMatchObject({ callSid: CALL_SID_1 });
    await expect(env.DB.prepare("SELECT relay_call_sid FROM outbound_call_attempts WHERE attempt_id = ?").bind(ATTEMPT_0).first())
      .resolves.toEqual({ relay_call_sid: CALL_SID_1 });
  });

  it("keeps the one known rate-limited retry as a distinct immutable attempt", async () => {
    const first = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.transient("rate_limited"), now: NOW });

    const retry = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_1));

    expect([first.attemptOrdinal, retry.attemptOrdinal]).toEqual([0, 1]);
    expect([first.relayNonce, retry.relayNonce]).toEqual([NONCE_0, NONCE_1]);
    await expect(repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_2))).rejects.toThrow("outbound_retry_limit");
  });

  it.each(["claimed", "dispatched", "provider_dispatch_unknown"] as const)("never makes %s retry-eligible", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    if (state === "dispatched") await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
    if (state === "provider_dispatch_unknown") await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });

    await expect(repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_1))).rejects.toThrow("outbound_retry_not_eligible");
  });

  it("never lets a late explicit rejection downgrade callback-proven dispatch", async () => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.claimExpectedCall({ attemptId: ATTEMPT_0, callSid: CALL_SID_1, observedDestinationIdentityId: expected.destinationIdentityId, now: NOW });

    await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.transient("rate_limited"), now: NOW });

    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID_1,
    });
  });

  it("reconciles a signed status callback from provider_dispatch_unknown", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });

    await repository.appendProviderEvent(await statusFixture());

    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID_1,
    });
  });

  it("accepts original-capability success after a callback binds the same CallSid", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.appendProviderEvent(await statusFixture());

    await expect(repository.recordProviderDispatchSuccess({
      claim: claim.capability,
      callSid: CALL_SID_1,
      now: NOW,
    })).resolves.toBeUndefined();
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID_1,
    });
  });

  it("rejects original-capability success after a callback binds a different CallSid", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.appendProviderEvent(await statusFixture());

    await expect(repository.recordProviderDispatchSuccess({
      claim: claim.capability,
      callSid: CALL_SID_2,
      now: NOW,
    })).rejects.toThrow("provider_dispatch_result_conflict");
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID_1,
    });
  });

  it("preserves callback-proven dispatch when the original capability records unknown", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    await repository.appendProviderEvent(await statusFixture());

    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .resolves.toBeUndefined();
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID_1,
    });
  });

  it("deduplicates attempt-scoped status identity and rejects a changed request hash", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    const first = await repository.appendProviderEvent(await statusFixture());
    const replay = await repository.appendProviderEvent(await statusFixture());

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(repository.appendProviderEvent(await statusFixture({ requestHash: HASH_2 }))).rejects.toThrow("idempotency_conflict");
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({ kind: "existing", state: "dispatched", callSid: CALL_SID_1 });
  });

  it("snapshots verified status metadata before its first hash await", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    const mutable = await statusFixture();

    const pending = repository.appendProviderEvent(mutable);
    mutable.attemptId = ATTEMPT_1;
    mutable.callSid = CALL_SID_2;

    await expect(pending).resolves.toMatchObject({ replayed: false });
    await expect(env.DB.prepare("SELECT attempt_id, call_sid FROM provider_events").first())
      .resolves.toEqual({ attempt_id: ATTEMPT_0, call_sid: CALL_SID_1 });
  });

  it("uses CallSid plus SessionId for relay-ended without status sequence fields", async () => {
    const envelope = await callbackEnvelope();
    await repository.appendProviderEvent({
      endpointKind: "relay_ended",
      callSid: CALL_SID_1,
      sessionId: `VX${"3".repeat(32)}`,
      requestHash: await sha256Hex(canonicalJson({ relay: "ended" })),
      envelope,
    });

    await expect(env.DB.prepare("SELECT endpoint_kind, attempt_id, callback_source, sequence_number FROM provider_events").first())
      .resolves.toEqual({ endpoint_kind: "relay_ended", attempt_id: null, callback_source: null, sequence_number: null });
  });

  it("rejects an unknown provider endpoint kind at the runtime boundary", async () => {
    await expect(repository.appendProviderEvent({
      endpointKind: "unknown",
      callSid: CALL_SID_1,
      sessionId: `VX${"3".repeat(32)}`,
      requestHash: HASH_1,
      envelope: await callbackEnvelope(),
    } as never)).rejects.toThrow("provider_event_endpoint_kind_invalid");
  });

  it("rejects retry eligibility when the exact known rate-limit rejection facts are absent", async () => {
    await expect(env.DB.prepare(`INSERT INTO outbound_call_attempts (
      attempt_id, command_id, attempt_ordinal, principal_id, destination_identity_id,
      command_idempotency_key, relay_nonce, nonce_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    ) VALUES (?, ?, 0, 'principal:owner', 'identity:voice', 'call:test', ?, ?, 'ready', 1, ?)`)
      .bind(ATTEMPT_0, COMMAND_ID, NONCE_0, AFTER_EXPIRY.toISOString(), NOW.toISOString()).run())
      .rejects.toThrow();
  });

  it("rejects NULL primary identities instead of relying on SQLite rowid PRIMARY KEY semantics", async () => {
    await expect(env.DB.prepare(`INSERT INTO outbound_call_attempts (
      attempt_id, command_id, attempt_ordinal, principal_id, destination_identity_id,
      command_idempotency_key, relay_nonce, nonce_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    ) VALUES (NULL, ?, 0, 'principal:owner', 'identity:voice', 'call:null-attempt', ?, ?, 'ready', 0, ?)`)
      .bind(COMMAND_ID, NONCE_0, AFTER_EXPIRY.toISOString(), NOW.toISOString()).run())
      .rejects.toThrow();

    await expect(env.DB.prepare(`INSERT INTO provider_events (
      dedupe_key, endpoint_kind, event_id, attempt_id, call_sid, callback_source,
      sequence_number, session_id, received_at
    ) VALUES (NULL, 'relay_ended', ?, NULL, ?, NULL, NULL, ?, ?)`)
      .bind(ATTEMPT_1, CALL_SID_1, `VX${"3".repeat(32)}`, NOW.toISOString()).run())
      .rejects.toThrow();
  });

  it("rejects a status receipt whose callback source is NULL", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });

    await expect(env.DB.prepare(`INSERT INTO provider_events (
      dedupe_key, endpoint_kind, event_id, attempt_id, call_sid, callback_source,
      sequence_number, session_id, received_at
    ) VALUES (?, 'status', ?, ?, ?, NULL, 2, NULL, ?)`)
      .bind("f".repeat(64), ATTEMPT_1, ATTEMPT_0, CALL_SID_1, NOW.toISOString()).run())
      .rejects.toThrow();
  });
});
