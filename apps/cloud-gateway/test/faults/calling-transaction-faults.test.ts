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
import { applyFoundationMigration } from "../persistence/migration.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_0 = "01k3s6k8000000000000000001" as Ulid;
const CALL_SID_1 = `CA${"1".repeat(32)}`;
const CALL_SID_2 = `CA${"2".repeat(32)}`;
const NONCE = `${"A".repeat(42)}A`;
const REQUEST_HASH = "1".repeat(64) as Sha256Hex;

async function clearData(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS test_fail_calling_outbox").run();
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
      now: NOW,
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
      now: NOW,
    });
    if (setup !== "ready") {
      const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_0, now: NOW });
      if (claim.kind !== "claimed") throw new Error("test_claim_failed");
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
});
