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
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  applyFoundationMigration,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_0 = "01k3s6k8000000000000000001" as Ulid;
const CALL_SID_1 = `CA${"1".repeat(32)}`;
const CALL_SID_2 = `CA${"2".repeat(32)}`;
const NONCE = `${"A".repeat(42)}A`;
const REQUEST_HASH = "1".repeat(64) as Sha256Hex;

async function clearData(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS test_fail_calling_outbox").run();
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

async function eventFixture(eventId = newUlid()): Promise<PersistableEventEnvelopeV1> {
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

async function statusFixture(callSid = CALL_SID_1) {
  return {
    endpointKind: "status" as const,
    attemptId: ATTEMPT_0,
    callSid,
    callbackSource: "call-progress-events",
    sequenceNumber: 2,
    requestHash: REQUEST_HASH,
    envelope: await eventFixture(),
  };
}

async function counts(): Promise<{ providerEvents: number; events: number; idempotency: number; outbox: number }> {
  const [providerEvents, events, idempotency, outbox] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM provider_events").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>(),
  ]);
  return {
    providerEvents: providerEvents?.count ?? -1,
    events: events?.count ?? -1,
    idempotency: idempotency?.count ?? -1,
    outbox: outbox?.count ?? -1,
  };
}

describe("calling transaction faults", () => {
  let events: EventRepository;
  let repository: CallRepository;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seedAuthorizedCommand();
    events = new EventRepository(env.DB);
    repository = new CallRepository(env.DB, events, () => NONCE);
  });

  afterEach(clearData);

  it("rolls back receipt, reconciliation, event, idempotency, and outbox when the final statement fails", async () => {
    await repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      principalId: "principal:owner",
      destinationIdentityId: "identity:voice",
      idempotencyKey: "call:test",
      authorizationExpiresAt: "2026-08-29T12:05:00.000Z",
      now: NOW,
      attemptOrdinal: 0,
    });
    await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
    await env.DB.prepare(`CREATE TRIGGER test_fail_calling_outbox
      BEFORE INSERT ON outbox WHEN NEW.topic = 'provider.call_status'
      BEGIN SELECT RAISE(ABORT, 'injected_calling_outbox_failure'); END`).run();

    await expect(repository.appendProviderEvent(await statusFixture())).rejects.toThrow("injected_calling_outbox_failure");

    await expect(counts()).resolves.toEqual({ providerEvents: 0, events: 0, idempotency: 0, outbox: 0 });
    await expect(env.DB.prepare("SELECT provider_dispatch_state, provider_call_sid, provider_dispatch_resolved_at FROM outbound_call_attempts WHERE attempt_id = ?").bind(ATTEMPT_0).first())
      .resolves.toEqual({ provider_dispatch_state: "claimed", provider_call_sid: null, provider_dispatch_resolved_at: null });
  });

  it.each(["ready", "rejected", "mismatched CallSid"] as const)("aborts every callback batch row for a %s attempt", async (setup) => {
    await repository.getOrCreateExpectedCall({
      attemptId: ATTEMPT_0,
      commandId: COMMAND_ID,
      principalId: "principal:owner",
      destinationIdentityId: "identity:voice",
      idempotencyKey: "call:test",
      authorizationExpiresAt: "2026-08-29T12:05:00.000Z",
      now: NOW,
      attemptOrdinal: 0,
    });
    if (setup !== "ready") {
      const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
      if (claim.kind !== "claimed") throw new Error("test_claim_failed");
      repository.beginProviderDispatch(claim.capability, ATTEMPT_0, NOW, "+14165550123");
      if (setup === "rejected") {
        await repository.recordProviderDispatchRejection({ claim: claim.capability, failure: ProviderFailure.permanent("invalid_request"), now: NOW });
      } else {
        await repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: CALL_SID_1, now: NOW });
      }
    }

    await expect(repository.appendProviderEvent(await statusFixture(setup === "mismatched CallSid" ? CALL_SID_2 : CALL_SID_1)))
      .rejects.toThrow("provider_status_attempt_mismatch");
    await expect(counts()).resolves.toEqual({ providerEvents: 0, events: 0, idempotency: 0, outbox: 0 });
  });

  it("builds appendAtomic dependencies only for the genuinely new append", async () => {
    const envelope = await eventFixture();
    const input = {
      envelope,
      scope: "test:atomic-dependency",
      key: "one",
      requestHash: await sha256Hex(canonicalJson({ callback: "one" })),
    };
    let builds = 0;
    const dependencies = () => {
      builds += 1;
      return [];
    };

    const first = await events.appendAtomic(input, dependencies);
    const replay = await events.appendAtomic(input, dependencies);
    await expect(events.appendAtomic({ ...input, requestHash: "2".repeat(64) as Sha256Hex }, dependencies))
      .rejects.toThrow("idempotency_conflict");

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(builds).toBe(1);
  });

  it("snapshots append identity before validation awaits and keeps dependencies on that receipt", async () => {
    const originalEnvelope = await eventFixture();
    const replacementEnvelope = await eventFixture();
    const originalHash = await sha256Hex(canonicalJson({ callback: "original" }));
    const replacementHash = await sha256Hex(canonicalJson({ callback: "replacement" }));
    const input = {
      envelope: originalEnvelope,
      scope: "test:atomic-snapshot",
      key: "original",
      requestHash: originalHash,
    };
    const pending = events.appendAtomic(input, (database, createdAt) => [
      database.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES ('principal:dependency', 'service', 'active', ?, ?, ?)`).bind(originalEnvelope.eventId, createdAt, createdAt),
    ]);
    input.envelope = replacementEnvelope;
    input.scope = "test:atomic-mutated";
    input.key = "replacement";
    input.requestHash = replacementHash;

    await expect(pending).resolves.toMatchObject({ envelope: { eventId: originalEnvelope.eventId }, replayed: false });
    await expect(env.DB.prepare("SELECT scope, key, request_hash FROM idempotency_records").first())
      .resolves.toEqual({ scope: "test:atomic-snapshot", key: "original", request_hash: originalHash });
    await expect(env.DB.prepare("SELECT display_name FROM principals WHERE principal_id = 'principal:dependency'").first())
      .resolves.toEqual({ display_name: originalEnvelope.eventId });
  });

  it("materializes dependency array indices without trusting a custom iterator", async () => {
    const envelope = await eventFixture();
    const indexed = env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:indexed', 'service', 'active', 'indexed', ?, ?)`).bind(NOW.toISOString(), NOW.toISOString());
    const iterated = [0, 1, 2].map((index) => env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'service', 'active', 'iterator', ?, ?)`).bind(`principal:iterator:${index}`, NOW.toISOString(), NOW.toISOString()));
    const dependencies = [indexed];
    Object.defineProperty(dependencies, Symbol.iterator, {
      configurable: true,
      value: function* () { yield* iterated; },
    });

    await events.appendAtomic({
      envelope,
      scope: "test:dependency-materialization",
      key: "one",
      requestHash: await sha256Hex(canonicalJson({ callback: "iterator" })),
    }, () => dependencies);

    await expect(env.DB.prepare("SELECT principal_id FROM principals WHERE principal_id LIKE 'principal:indexed' OR principal_id LIKE 'principal:iterator:%' ORDER BY principal_id").all())
      .resolves.toMatchObject({ results: [{ principal_id: "principal:indexed" }] });
  });

  it("captures the dependency count once before materializing indices", async () => {
    const envelope = await eventFixture();
    const statements = ["indexed", "drifted:1", "drifted:2"].map((suffix) => env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'service', 'active', 'dependency', ?, ?)`).bind(`principal:${suffix}`, NOW.toISOString(), NOW.toISOString()));
    let lengthReads = 0;
    const dependencies = new Proxy(statements, {
      get(target, property, receiver) {
        if (property === "length") return lengthReads++ === 0 ? 1 : 3;
        return Reflect.get(target, property, receiver);
      },
    });

    await events.appendAtomic({
      envelope,
      scope: "test:dependency-count",
      key: "one",
      requestHash: await sha256Hex(canonicalJson({ callback: "length" })),
    }, () => dependencies);

    await expect(env.DB.prepare("SELECT principal_id FROM principals WHERE principal_id LIKE 'principal:indexed' OR principal_id LIKE 'principal:drifted:%' ORDER BY principal_id").all())
      .resolves.toMatchObject({ results: [{ principal_id: "principal:indexed" }] });
    expect(lengthReads).toBe(1);
  });

  it("rejects sparse dependency arrays", async () => {
    const envelope = await eventFixture();
    const sparse = new Array<D1PreparedStatement>(1);

    await expect(events.appendAtomic({
      envelope,
      scope: "test:dependency-sparse",
      key: "one",
      requestHash: await sha256Hex(canonicalJson({ callback: "sparse" })),
    }, () => sparse)).rejects.toThrow("event_append_dependency_invalid");
  });

  it("rejects coercion-shaped append primitives before database or dependency effects", async () => {
    let prepares = 0;
    let builds = 0;
    let coercions = 0;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            prepares += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repository = new EventRepository(database);
    const envelope = await eventFixture();
    const scope = {
      length: 5,
      toString() {
        coercions += 1;
        return "scope";
      },
    };

    await expect(repository.appendAtomic({
      envelope,
      scope: scope as never,
      key: "one",
      requestHash: await sha256Hex(canonicalJson({ callback: "coercion" })),
    }, () => {
      builds += 1;
      return [];
    })).rejects.toThrow("scope must be a string");
    expect({ prepares, builds, coercions }).toEqual({ prepares: 0, builds: 0, coercions: 0 });
  });
});
