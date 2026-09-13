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
import {
  applyFoundationMigration,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "./migration.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const AT_EXPIRY = new Date("2026-08-29T12:05:00.000Z");
const AFTER_EXPIRY = new Date("2026-08-29T12:06:00.000Z");
const AUTHORIZATION_EXPIRY = "2026-08-29T12:10:00.000Z";
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
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
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
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "a".repeat(64), timestamp),
  ]);
}

function expectedAttempt(attemptId: Ulid, attemptOrdinal: 0 | 1 = 0) {
  return {
    attemptId,
    attemptOrdinal,
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    destinationIdentityId: "identity:voice",
    idempotencyKey: "call:test",
    authorizationExpiresAt: AUTHORIZATION_EXPIRY,
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
      ownerIdentityId: "identity:voice",
      now: NOW,
    });
    const replay = await repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: "identity:voice",
      now: AFTER_EXPIRY,
    });

    expect(first).toMatchObject({ callSid: CALL_SID_1, principalId: expected.principalId, relayNonce: NONCE_0 });
    expect(replay).toEqual(first);
    await expect(repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_2,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: "identity:voice",
      now: NOW,
    })).resolves.toBeNull();
  });

  it.each([
    ["at exact expiry", AT_EXPIRY],
    ["past expiry", AFTER_EXPIRY],
  ] as const)("does not mint a provider capability %s", async (_label, observedAt) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));

    await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: observedAt }))
      .resolves.toEqual({ kind: "relay_nonce_expired" });
    await expect(env.DB.prepare(`SELECT provider_dispatch_state, provider_dispatch_claimed_at
      FROM outbound_call_attempts WHERE attempt_id = ?`).bind(ATTEMPT_0).first())
      .resolves.toEqual({ provider_dispatch_state: "ready", provider_dispatch_claimed_at: null });
  });

  it("does not mint a provider capability at the exact stored authorization expiry", async () => {
    await repository.getOrCreateExpectedCall({
      ...expectedAttempt(ATTEMPT_0),
      authorizationExpiresAt: AT_EXPIRY.toISOString(),
    });

    await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: AT_EXPIRY }))
      .resolves.toEqual({ kind: "authorization_expired" });
    await expect(env.DB.prepare(`SELECT provider_dispatch_state, provider_dispatch_claimed_at
      FROM outbound_call_attempts WHERE attempt_id = ?`).bind(ATTEMPT_0).first())
      .resolves.toEqual({ provider_dispatch_state: "ready", provider_dispatch_claimed_at: null });
  });

  it("converges an expired claim observer when a valid observer claims before its read", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    let signalReadBlocked: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const readBlocked = new Promise<void>((resolve) => { signalReadBlocked = resolve; });
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    let shouldBlock = true;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (!/^\s*SELECT\s+attempt_id,[\s\S]*FROM outbound_call_attempts WHERE attempt_id/iu.test(query)) return statement;
            const wrap = (real: D1PreparedStatement): D1PreparedStatement => new Proxy(real, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => wrap(statementTarget.bind(...values));
                }
                if (statementProperty === "first") {
                  return async (...values: unknown[]) => {
                    if (shouldBlock) {
                      shouldBlock = false;
                      signalReadBlocked?.();
                      await readRelease;
                    }
                    return statementTarget.first(...values as []);
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
            return wrap(statement);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const expiredObserver = new CallRepository(database, new EventRepository(database), () => NONCE_1);

    const pending = expiredObserver.claimProviderDispatch({ attemptId: ATTEMPT_0, now: AT_EXPIRY });
    await readBlocked;
    await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW })).resolves.toMatchObject({ kind: "claimed" });
    releaseRead?.();

    await expect(pending).resolves.toEqual({ kind: "provider_dispatch_unknown" });
    await expect(env.DB.prepare("SELECT provider_dispatch_state FROM outbound_call_attempts WHERE attempt_id = ?").bind(ATTEMPT_0).first())
      .resolves.toEqual({ provider_dispatch_state: "provider_dispatch_unknown" });
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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
    await expect(repository.recordProviderDispatchUnknown({ claim: { attemptId: ATTEMPT_0 } as ProviderDispatchClaimCapability, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
  });

  it("rejects settlement before a provider dispatch capability has begun", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");

    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .rejects.toThrow("provider_dispatch_claim_invalid");
  });

  it("never settles a begun provider dispatch capability as not started", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");

    await expect(repository.recordProviderDispatchNotStarted({
      claim: claim.capability,
      expectedAttemptId: ATTEMPT_0,
      now: NOW,
    })).rejects.toThrow("provider_dispatch_claim_invalid");
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "claimed",
    });
    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .resolves.toBeUndefined();
  });

  it("rejects a coercion-shaped CallSid at the repository boundary", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    let coercions = 0;
    const callSid = {
      toString() {
        coercions += 1;
        return CALL_SID_1;
      },
    };

    await expect(repository.recordProviderDispatchSuccess({
      claim: claim.capability,
      callSid: callSid as never,
      now: NOW,
    })).rejects.toThrow("provider_call_sid_invalid");
    expect(coercions).toBe(0);
  });

  it("begins only a genuine provider dispatch capability and only once", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    const forged = { attemptId: ATTEMPT_0 } as ProviderDispatchClaimCapability;

    expect(() => repository.beginProviderDispatch(forged, ATTEMPT_0, NOW, "+14165550123")).toThrow("provider_dispatch_claim_invalid");
    expect(() => repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123")).not.toThrow();
    expect(() => repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123")).toThrow("provider_dispatch_claim_invalid");
    await expect(repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW }))
      .resolves.toBeUndefined();
  });

  it("binds a provider claim capability to the snapshotted row identity", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const mutable = { attemptId: ATTEMPT_0, now: NOW };

    const pending = repository.claimProviderDispatch(mutable);
    mutable.attemptId = ATTEMPT_1;
    const claim = await pending;

    expect(claim).toMatchObject({ kind: "claimed", capability: { attemptId: ATTEMPT_0 } });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({ kind: "existing", state: "provider_dispatch_unknown" });
  });

  it("reads a result capability accessor once and keeps it bound to its issued attempt", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
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
      ownerIdentityId: "identity:voice",
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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.transient("rate_limited"), now: NOW });

    const retry = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_1, 1));

    expect([first.attemptOrdinal, retry.attemptOrdinal]).toEqual([0, 1]);
    expect([first.relayNonce, retry.relayNonce]).toEqual([NONCE_0, NONCE_1]);
    await expect(repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_2, 1))).rejects.toMatchObject({
      name: "AttemptAllocationRaceError",
      currentAttemptId: ATTEMPT_1,
      attemptOrdinal: 1,
    });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts").first())
      .resolves.toEqual({ count: 2 });
  });

  it.each([
    ["principal", { principalId: "principal:other" }],
    ["destination", { destinationIdentityId: "identity:other" }],
    ["idempotency key", { idempotencyKey: "call:drifted" }],
    ["authorization expiry", { authorizationExpiresAt: "2026-08-29T12:11:00.000Z" }],
  ] as const)("rejects ordinal-1 allocation with drifted predecessor %s lineage", async (_label, drift) => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:other', 'service', 'active', 'other', ?, ?)").bind(NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare("INSERT OR IGNORE INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:other', 'principal:owner', 'voice', '+14165550124', 'active', ?, ?)").bind(NOW.toISOString(), NOW.toISOString()),
    ]);
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchRejection({
      claim: claim.capability,
      failure: ProviderFailure.transient("rate_limited"),
      now: NOW,
    });

    await expect(repository.getOrCreateExpectedCall({
      ...expectedAttempt(ATTEMPT_1, 1),
      ...drift,
    })).rejects.toThrow("outbound_attempt_conflict");
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts WHERE attempt_ordinal = 1").first())
      .resolves.toEqual({ count: 0 });
  });

  it("requires an expected ordinal before both allocation and exact stored replay", async () => {
    const { attemptOrdinal: _attemptOrdinal, ...withoutOrdinal } = expectedAttempt(ATTEMPT_0);

    await expect(repository.getOrCreateExpectedCall(withoutOrdinal as never)).rejects.toThrow("outbound_attempt_ordinal_invalid");
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts").first())
      .resolves.toEqual({ count: 0 });

    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await expect(repository.getOrCreateExpectedCall(withoutOrdinal as never)).rejects.toThrow("outbound_attempt_ordinal_invalid");
  });

  it("rejects an existing attempt replay with a mismatched expected ordinal", async () => {
    await repository.getOrCreateExpectedCall({ ...expectedAttempt(ATTEMPT_0), attemptOrdinal: 0 });

    await expect(repository.getOrCreateExpectedCall({
      ...expectedAttempt(ATTEMPT_0),
      attemptOrdinal: 1,
    })).rejects.toThrow("outbound_attempt_conflict");
  });

  it.each(["claimed", "dispatched", "provider_dispatch_unknown"] as const)("never makes %s retry-eligible", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    if (state !== "claimed") repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    if (state === "dispatched") await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
    if (state === "provider_dispatch_unknown") await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });

    await expect(repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_1, 1))).rejects.toThrow("outbound_retry_not_eligible");
  });

  it("never lets a late explicit rejection downgrade callback-proven dispatch", async () => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.claimExpectedCall({ attemptId: ATTEMPT_0, callSid: CALL_SID_1, observedDestinationIdentityId: expected.destinationIdentityId, ownerIdentityId: "identity:voice", now: NOW });

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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
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
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
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
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    const binding = await repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: "identity:voice",
      now: NOW,
    });
    if (binding === null) throw new Error("test_binding_failed");
    const session = await repository.getOrCreateOutboundSession({ attemptId: ATTEMPT_0, binding, now: NOW });
    const providerSessionId = `VX${"3".repeat(32)}`;
    await repository.bindRelaySession({
      sessionId: session.sessionId,
      callSid: CALL_SID_1,
      providerSessionId,
      relayNonce: binding.relayNonce,
      direction: "outbound",
      now: NOW,
    });
    const envelope = await callbackEnvelope();
    await repository.appendProviderEvent({
      endpointKind: "relay_ended",
      callSid: CALL_SID_1,
      sessionId: providerSessionId,
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
      command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    ) VALUES (?, ?, 0, 'principal:owner', 'identity:voice', 'call:test', ?, ?, ?, 'ready', 1, ?)`)
      .bind(ATTEMPT_0, COMMAND_ID, NONCE_0, AFTER_EXPIRY.toISOString(), AUTHORIZATION_EXPIRY, NOW.toISOString()).run())
      .rejects.toThrow();
  });

  it("rejects a non-canonical stored authorization expiry", async () => {
    await expect(env.DB.prepare(`INSERT INTO outbound_call_attempts (
      attempt_id, command_id, attempt_ordinal, principal_id, destination_identity_id,
      command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    ) VALUES (?, ?, 0, 'principal:owner', 'identity:voice', 'call:bad-expiry', ?, ?, ?, 'ready', 0, ?)`)
      .bind(ATTEMPT_0, COMMAND_ID, NONCE_0, AFTER_EXPIRY.toISOString(), "2026-08-29T12:10:00Z", NOW.toISOString()).run())
      .rejects.toThrow();
  });

  it.each([
    ["attempt identity", "UPDATE outbound_call_attempts SET attempt_id = ? WHERE attempt_id = ?", ATTEMPT_1],
    ["command identity", "UPDATE outbound_call_attempts SET command_id = ? WHERE attempt_id = ?", ATTEMPT_1],
    ["ordinal", "UPDATE outbound_call_attempts SET attempt_ordinal = ? WHERE attempt_id = ?", 1],
    ["principal lineage", "UPDATE outbound_call_attempts SET principal_id = ? WHERE attempt_id = ?", "principal:other"],
    ["destination lineage", "UPDATE outbound_call_attempts SET destination_identity_id = ? WHERE attempt_id = ?", "identity:other"],
    ["idempotency lineage", "UPDATE outbound_call_attempts SET command_idempotency_key = ? WHERE attempt_id = ?", "call:other"],
    ["relay nonce", "UPDATE outbound_call_attempts SET relay_nonce = ? WHERE attempt_id = ?", NONCE_1],
    ["nonce expiry", "UPDATE outbound_call_attempts SET nonce_expires_at = ? WHERE attempt_id = ?", AUTHORIZATION_EXPIRY],
    ["authorization expiry", "UPDATE outbound_call_attempts SET authorization_expires_at = ? WHERE attempt_id = ?", "2026-08-29T12:11:00.000Z"],
    ["creation time", "UPDATE outbound_call_attempts SET created_at = ? WHERE attempt_id = ?", AFTER_EXPIRY.toISOString()],
  ] as const)("prevents mutation of immutable attempt %s while permitting state transitions", async (_label, query, changedValue) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));

    await expect(env.DB.prepare(query).bind(changedValue, ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_immutable");
    await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW }))
      .resolves.toMatchObject({ kind: "claimed" });
  });

  it.each(["ready", "claimed", "terminal"] as const)("prevents deletion of a durable %s attempt", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    if (state !== "ready") {
      const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
      if (claim.kind !== "claimed") throw new Error("test_claim_failed");
      if (state === "terminal") {
        repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
        await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
      }
    }

    await expect(env.DB.prepare("DELETE FROM outbound_call_attempts WHERE attempt_id = ?").bind(ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_delete_forbidden");
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts WHERE attempt_id = ?").bind(ATTEMPT_0).first())
      .resolves.toEqual({ count: 1 });
    if (state === "ready") {
      await expect(repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW }))
        .resolves.toMatchObject({ kind: "claimed" });
    }
  });

  it.each(["dispatched", "rejected", "provider_dispatch_unknown"] as const)("prevents terminal %s state from regressing to ready", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    if (state === "dispatched") {
      await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
    } else if (state === "rejected") {
      await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.permanent("invalid_request"), now: NOW });
    } else {
      await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    }

    await expect(env.DB.prepare(`UPDATE outbound_call_attempts
      SET provider_dispatch_state = 'ready', provider_dispatch_claimed_at = NULL,
          provider_dispatch_resolved_at = NULL, provider_failure_code = NULL,
          provider_failure_category = NULL, provider_call_sid = NULL, retry_eligible = 0
      WHERE attempt_id = ?`).bind(ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({ kind: "existing", state });
  });

  it.each(["provider", "relay"] as const)("prevents a bound %s CallSid from changing", async (binding) => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    if (binding === "provider") {
      repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
      await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
    } else {
      await repository.claimExpectedCall({
        attemptId: ATTEMPT_0,
        callSid: CALL_SID_1,
        observedDestinationIdentityId: expected.destinationIdentityId,
        ownerIdentityId: "identity:voice",
        now: NOW,
      });
    }

    const column = binding === "provider" ? "provider_call_sid" : "relay_call_sid";
    await expect(env.DB.prepare(`UPDATE outbound_call_attempts SET ${column} = ? WHERE attempt_id = ?`)
      .bind(CALL_SID_2, ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
  });

  it("prevents a terminal nonretry rejection from being rewritten as retryable", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchRejection({
      claim: claim.capability,
      failure: ProviderFailure.permanent("invalid_request"),
      now: NOW,
    });

    await expect(env.DB.prepare(`UPDATE outbound_call_attempts
      SET provider_failure_code = 'provider_transient_failure',
          provider_failure_category = 'rate_limited', retry_eligible = 1
      WHERE attempt_id = ?`).bind(ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "rejected",
      failureCode: "provider_permanent_failure",
      retryEligible: false,
    });
  });

  it.each(["ready", "claimed", "rejected", "provider_dispatch_unknown"] as const)("prevents non-dispatched %s state from acquiring a CallSid", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    if (state !== "ready") {
      const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
      if (claim.kind !== "claimed") throw new Error("test_claim_failed");
      if (state === "rejected" || state === "provider_dispatch_unknown") {
        repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
        if (state === "rejected") {
          await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.permanent("invalid_request"), now: NOW });
        } else {
          await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
        }
      }
    }

    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_call_sid = ? WHERE attempt_id = ?")
      .bind(CALL_SID_1, ATTEMPT_0).run()).rejects.toThrow();
  });

  it("requires every dispatched attempt to retain its provider CallSid", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });

    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_call_sid = NULL WHERE attempt_id = ?")
      .bind(ATTEMPT_0).run()).rejects.toThrow();
  });

  it.each([
    ["CallSid without claim time", "relay_call_sid", CALL_SID_2],
    ["claim time without CallSid", "relay_claimed_at", NOW.toISOString()],
  ] as const)("rejects relay %s", async (_label, column, value) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });

    await expect(env.DB.prepare(`UPDATE outbound_call_attempts SET ${column} = ? WHERE attempt_id = ?`)
      .bind(value, ATTEMPT_0).run()).rejects.toThrow();
  });

  it("freezes the durable provider claim time once established", async () => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });

    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_dispatch_claimed_at = ? WHERE attempt_id = ?")
      .bind(AFTER_EXPIRY.toISOString(), ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
  });

  it("freezes the relay claim time once a callback binds it", async () => {
    const expected = await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    await repository.claimExpectedCall({
      attemptId: ATTEMPT_0,
      callSid: CALL_SID_1,
      observedDestinationIdentityId: expected.destinationIdentityId,
      ownerIdentityId: "identity:voice",
      now: NOW,
    });

    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET relay_claimed_at = ? WHERE attempt_id = ?")
      .bind(AFTER_EXPIRY.toISOString(), ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
  });

  it.each(["dispatched", "rejected", "provider_dispatch_unknown"] as const)("freezes %s resolution time outside a valid reconciliation edge", async (state) => {
    await repository.getOrCreateExpectedCall(expectedAttempt(ATTEMPT_0));
    const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
    if (state === "dispatched") {
      await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
    } else if (state === "rejected") {
      await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.permanent("invalid_request"), now: NOW });
    } else {
      await repository.recordProviderDispatchUnknown({ claim: claim.capability, now: NOW });
    }

    await expect(env.DB.prepare("UPDATE outbound_call_attempts SET provider_dispatch_resolved_at = ? WHERE attempt_id = ?")
      .bind(AFTER_EXPIRY.toISOString(), ATTEMPT_0).run())
      .rejects.toThrow("outbound_attempt_state_transition_invalid");
  });

  it("rejects NULL primary identities instead of relying on SQLite rowid PRIMARY KEY semantics", async () => {
    await expect(env.DB.prepare(`INSERT INTO outbound_call_attempts (
      attempt_id, command_id, attempt_ordinal, principal_id, destination_identity_id,
      command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    ) VALUES (NULL, ?, 0, 'principal:owner', 'identity:voice', 'call:null-attempt', ?, ?, ?, 'ready', 0, ?)`)
      .bind(COMMAND_ID, NONCE_0, AFTER_EXPIRY.toISOString(), AUTHORIZATION_EXPIRY, NOW.toISOString()).run())
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
