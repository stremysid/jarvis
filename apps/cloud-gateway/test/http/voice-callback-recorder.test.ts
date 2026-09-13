import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSessionTermination } from "../../src/voice/call-session-do.js";
import type { Sha256Hex, Ulid } from "../../../../packages/contracts/src/index.js";
import { D1TwilioCallbackRecorder } from "../../src/http/voice-callback-recorder.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import {
  applyFoundationMigration,
  clearCallSessionsForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_ID = "01k3s6k8000000000000000001" as Ulid;
const EVENT_ID = "01k3s6k8000000000000000002" as Ulid;
const CALL_SID = `CA${"1".repeat(32)}`;
const OTHER_CALL_SID = `CA${"2".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"3".repeat(32)}`;
const REQUEST_HASH = "a".repeat(64) as Sha256Hex;
const NONCE = `${"A".repeat(42)}A`;

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedClaimedAttempt(repository: CallRepository): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "b".repeat(64), timestamp),
  ]);
  await repository.getOrCreateExpectedCall({
    attemptId: ATTEMPT_ID,
    attemptOrdinal: 0,
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    destinationIdentityId: "identity:voice",
    idempotencyKey: "call:callback-recorder",
    authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
    now: NOW,
  });
  await repository.claimProviderDispatch({ attemptId: ATTEMPT_ID, now: NOW });
}

describe("D1TwilioCallbackRecorder", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
  });

  afterEach(clearFixture);

  it("refuses cleanup when an append adapter returns without terminalizing the durable session", async () => {
    const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
    await seedClaimedAttempt(repository);
    const binding = await repository.claimExpectedCall({ attemptId: ATTEMPT_ID, callSid: CALL_SID,
      observedDestinationIdentityId: "identity:voice", ownerIdentityId: "identity:voice", now: NOW });
    if (binding === null) throw new Error("fixture_expected_call_missing");
    await repository.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: NOW });
    const terminateSession = vi.fn(async (input: CallSessionTermination) => ({
      sessionId: input.sessionId, terminalPhase: input.phase, invalidated: true, outcome: "applied" as const,
    }));
    // Integration fault injection at the existing append port. A real atomic
    // CallRepository cannot return this inconsistent state.
    const recorder = new D1TwilioCallbackRecorder({ database: env.DB, now: () => NOW, newEventId: () => EVENT_ID,
      calls: { appendProviderEvent: async ({ envelope }) => ({ envelope, eventSequence: 1, replayed: false }) },
      terminateSession });
    await expect(recorder.record({ endpointKind: "status", attemptId: ATTEMPT_ID, callSid: CALL_SID,
      callbackSource: "call-progress-events", sequenceNumber: 2, callStatus: "completed", requestHash: REQUEST_HASH }))
      .rejects.toThrow("callback_terminal_state_missing");
    expect(terminateSession).not.toHaveBeenCalled();
    await expect(env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?").bind(ATTEMPT_ID).first())
      .resolves.toEqual({ phase: "created" });
  });

  it("atomically records safe status lifecycle metadata and reconciles the compatible attempt", async () => {
    const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
    await seedClaimedAttempt(repository);
    const recorder = new D1TwilioCallbackRecorder({
      database: env.DB,
      calls: repository,
      now: () => NOW,
      newEventId: () => EVENT_ID,
    });

    await recorder.record(Object.freeze({
      endpointKind: "status",
      attemptId: ATTEMPT_ID,
      callSid: CALL_SID,
      callbackSource: "call-progress-events",
      sequenceNumber: 2,
      callStatus: "initiated",
      requestHash: REQUEST_HASH,
    }));

    await expect(env.DB.prepare("SELECT endpoint_kind, attempt_id, call_sid, callback_source, sequence_number FROM provider_events").first())
      .resolves.toEqual({
        endpoint_kind: "status",
        attempt_id: ATTEMPT_ID,
        call_sid: CALL_SID,
        callback_source: "call-progress-events",
        sequence_number: 2,
      });
    const stored = await env.DB.prepare("SELECT event_type, subject_id, envelope_json FROM events").first<{
      event_type: string;
      subject_id: string;
      envelope_json: string;
    }>();
    expect(stored?.event_type).toBe("provider.call_status");
    expect(stored?.subject_id).toBe("principal:owner");
    expect(JSON.parse(stored?.envelope_json ?? "null")).toMatchObject({
      correlationId: COMMAND_ID,
      payload: { callStatus: "initiated", sequenceNumber: 2 },
    });
    await expect(repository.resolveDispatchIntent(COMMAND_ID)).resolves.toMatchObject({
      kind: "existing",
      state: "dispatched",
      callSid: CALL_SID,
    });
    for (const table of ["provider_events", "events", "idempotency_records", "outbox"]) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count).toBe(1);
    }
  });

  it("snapshots relay-ended facts before context lookup and atomically appends the correlated event", async () => {
    const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
    await seedClaimedAttempt(repository);
    const expected = await repository.claimExpectedCall({
    attemptId: ATTEMPT_ID,
    callSid: CALL_SID,
    observedDestinationIdentityId: "identity:voice",
    ownerIdentityId: "identity:voice",
    now: NOW,
  });
    if (expected === null) throw new Error("fixture_expected_call_missing");
    const session = await repository.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding: expected, now: NOW });
    await repository.bindRelaySession({
      sessionId: session.sessionId,
      callSid: CALL_SID,
      providerSessionId: PROVIDER_SESSION_ID,
      relayNonce: expected.relayNonce,
      direction: "outbound",
      now: NOW,
    });
    const terminateSession = vi.fn(async (input: CallSessionTermination) => ({
      sessionId: input.sessionId, terminalPhase: input.phase, invalidated: true, outcome: "applied" as const,
    }));
    const recorder = new D1TwilioCallbackRecorder({
      database: env.DB,
      calls: repository,
      now: () => NOW,
      newEventId: () => EVENT_ID,
      terminateSession,
    });
    const mutable = {
      endpointKind: "relay_ended" as const,
      callSid: CALL_SID,
      sessionId: PROVIDER_SESSION_ID,
      sessionStatus: "completed",
      sessionDurationSeconds: 17,
      requestHash: REQUEST_HASH,
    };

    const pending = recorder.record(mutable);
    mutable.callSid = OTHER_CALL_SID;
    mutable.sessionStatus = "failed";
    mutable.sessionDurationSeconds = 999;
    mutable.requestHash = "c".repeat(64) as Sha256Hex;

    await expect(pending).resolves.toBeUndefined();
    expect(terminateSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: ATTEMPT_ID, phase: "completed", reason: "provider_callback",
    });
    const stored = await env.DB.prepare("SELECT endpoint_kind, call_sid, session_id FROM provider_events").first();
    expect(stored).toEqual({ endpoint_kind: "relay_ended", call_sid: CALL_SID, session_id: PROVIDER_SESSION_ID });
    const event = await env.DB.prepare("SELECT event_type, envelope_json FROM events").first<{
      event_type: string;
      envelope_json: string;
    }>();
    expect(event?.event_type).toBe("provider.relay_ended");
    expect(JSON.parse(event?.envelope_json ?? "null")).toMatchObject({
      correlationId: ATTEMPT_ID,
      payload: { sessionStatus: "completed", sessionDurationSeconds: 17 },
    });
  });

  it("captures repository append authority at construction before any callback await", async () => {
    const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
    await seedClaimedAttempt(repository);
    const dependencies = {
      database: env.DB,
      calls: repository as Pick<CallRepository, "appendProviderEvent">,
      now: () => NOW,
      newEventId: () => EVENT_ID,
    };
    const recorder = new D1TwilioCallbackRecorder(dependencies);

    const pending = recorder.record(Object.freeze({
      endpointKind: "status",
      attemptId: ATTEMPT_ID,
      callSid: CALL_SID,
      callbackSource: "call-progress-events",
      sequenceNumber: 1,
      callStatus: "ringing",
      requestHash: REQUEST_HASH,
    }));
    dependencies.calls = {
      appendProviderEvent: async () => { throw new Error("mutated repository authority"); },
    };

    await expect(pending).resolves.toBeUndefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM provider_events").first<{ count: number }>())?.count).toBe(1);
  });
});
