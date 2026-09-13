import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../src/providers/conversation-relay.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CallSessionCore } from "../../src/voice/call-session-do.js";
import {
  OUTBOUND_VOICEMAIL_MESSAGE,
  type OutboundPreAuthenticationContract,
} from "../../src/voice/outbound.js";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const NONCE_EXPIRY = new Date("2026-08-30T12:05:00.000Z");
const SESSION_ID = "01k3wceg000000000000000001" as Ulid;
const COMMAND_ID = "01k3wceg000000000000000010" as Ulid;
const ATTEMPT_ID = "01k3wceg000000000000000011" as Ulid;
const CALL_SID = `CA${"1".repeat(32)}`;
const OTHER_CALL_SID = `CA${"9".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"2".repeat(32)}`;
const ACCOUNT_SID = `AC${"3".repeat(32)}`;
const RELAY_NONCE = `${"A".repeat(42)}A`;

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

async function seedActiveVoiceIdentity(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint,
      key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:owner', 'principal:owner', 'key:owner', ?, ?, 1,
      'ed25519', 'active', 'laptop', ?, ?)`)
      .bind("A".repeat(43) + "=", "a".repeat(64), "b".repeat(64), timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at,
      created_at, enrolled_by_device_id
    ) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123',
      'active', ?, ?, 'device:owner')`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO voice_owner_identity (
      singleton_id, principal_id, identity_id, created_at
    ) VALUES (1, 'principal:owner', 'identity:voice', ?)`)
      .bind(timestamp),
  ]);
}

function repository(): CallRepository {
  return new CallRepository(
    env.DB,
    new EventRepository(env.DB),
    () => RELAY_NONCE,
    300_000,
    () => SESSION_ID,
  );
}

async function createInboundSession(repo: CallRepository): Promise<StoredCallSession> {
  return repo.getOrCreateInboundSession({
    callSid: CALL_SID,
    callerE164: "+14165550123",
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion: "hmac-v1",
    now: NOW,
  });
}

async function createOutboundSession(repo: CallRepository): Promise<StoredCallSession> {
  await env.DB.prepare(`INSERT INTO policy_decisions (
    decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at
  ) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)`)
    .bind(COMMAND_ID, "d".repeat(64), NOW.toISOString()).run();
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
    callSid: CALL_SID,
    observedDestinationIdentityId: expected.destinationIdentityId,
    ownerIdentityId: "identity:voice",
    now: NOW,
  });
  if (binding === null) throw new Error("fixture_binding_missing");
  return repo.getOrCreateOutboundSession({ attemptId: ATTEMPT_ID, binding, now: NOW });
}

function setup(session: StoredCallSession, overrides: Partial<Extract<RelayEvent, { type: "setup" }>> = {}): Extract<RelayEvent, { type: "setup" }> {
  return {
    type: "setup",
    sessionId: PROVIDER_SESSION_ID,
    accountSid: ACCOUNT_SID,
    callSid: session.callSid,
    direction: session.direction,
    relayNonce: session.binding.relayNonce,
    ...overrides,
  };
}

function core(
  session: StoredCallSession,
  repo: CallRepository,
  now: Date,
  preAuthentication?: OutboundPreAuthenticationContract,
) {
  const close = vi.fn<(code: number) => void>();
  const sendNeutralText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  return {
    close,
    sendNeutralText,
    instance: new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session,
      expectedAccountSid: ACCOUNT_SID,
      repository: repo,
      activation: null,
      conversation: null,
      preAuthentication,
      relay: {
        close,
        sendNeutralText,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput: async () => undefined,
      },
      now: () => new Date(now),
    }),
  };
}

async function storedRow(sessionId: Ulid): Promise<{ phase: string; provider_session_id: string | null }> {
  const row = await env.DB.prepare("SELECT phase, provider_session_id FROM call_sessions WHERE session_id = ?")
    .bind(sessionId).first<{ phase: string; provider_session_id: string | null }>();
  if (row === null) throw new Error("fixture_session_missing");
  return row;
}

describe("CallSessionCore relay binding", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
    await seedActiveVoiceIdentity();
  });

  afterEach(clearFixture);

  it.each([
    ["AccountSid", { accountSid: `AC${"8".repeat(32)}` }],
    ["CallSid", { callSid: OTHER_CALL_SID }],
    ["relay nonce", { relayNonce: `${"B".repeat(42)}E` }],
    ["direction", { direction: "outbound" as const }],
  ])("rejects mismatched %s before durable bind or phase transition", async (_label, mismatch) => {
    const repo = repository();
    const session = await createInboundSession(repo);
    const { instance, close } = core(session, repo, NOW);

    await expect(instance.handleRelayEvent(setup(session, mismatch))).rejects.toThrow("relay_binding_rejected");

    expect(await storedRow(session.sessionId)).toEqual({ phase: "created", provider_session_id: null });
    expect(close).toHaveBeenCalledExactlyOnceWith(1008);
  });

  it("requires the first outbound provider-session bind strictly before nonce expiry", async () => {
    const repo = repository();
    const session = await createOutboundSession(repo);
    const { instance, close } = core(session, repo, NONCE_EXPIRY);

    await expect(instance.handleRelayEvent(setup(session))).rejects.toThrow("relay_binding_rejected");

    expect(await storedRow(session.sessionId)).toEqual({ phase: "created", provider_session_id: null });
    expect(close).toHaveBeenCalledExactlyOnceWith(1008);
  });

  it("recovers only an identical already-bound outbound setup after expiry in a new object instance", async () => {
    const repo = repository();
    const session = await createOutboundSession(repo);
    const bound = await repo.bindRelaySession({
      sessionId: session.sessionId,
      callSid: session.callSid,
      providerSessionId: PROVIDER_SESSION_ID,
      relayNonce: session.binding.relayNonce,
      direction: "outbound",
      now: new Date(NONCE_EXPIRY.valueOf() - 1),
    });
    expect(bound.phase).toBe("created");

    const afterExpiry = new Date(NONCE_EXPIRY.valueOf() + 1);
    const firstRestart = core(bound, repo, afterExpiry);
    await expect(firstRestart.instance.handleRelayEvent(setup(bound))).resolves.toBeUndefined();
    expect(firstRestart.instance.phase).toBe("pre_auth");
    expect(firstRestart.close).not.toHaveBeenCalled();

    const recovered = await repo.getCallSession(session.sessionId);
    if (recovered === null) throw new Error("fixture_session_missing");
    const secondRestart = core(recovered, repo, afterExpiry);
    await expect(secondRestart.instance.handleRelayEvent(setup(recovered))).resolves.toBeUndefined();
    await expect(secondRestart.instance.handleRelayEvent(setup(recovered)))
      .rejects.toThrow("relay_setup_replayed");
    expect(secondRestart.close).toHaveBeenCalledExactlyOnceWith(1008);
  });

  it("binds an eligible setup and durably enters pre-authentication", async () => {
    const repo = repository();
    const session = await createOutboundSession(repo);
    const { instance, close } = core(session, repo, new Date(NONCE_EXPIRY.valueOf() - 1));

    await instance.handleRelayEvent(setup(session));

    expect(instance.phase).toBe("pre_auth");
    expect(await storedRow(session.sessionId)).toEqual({ phase: "pre_auth", provider_session_id: PROVIDER_SESSION_ID });
    expect(close).not.toHaveBeenCalled();
  });

  it("consumes only Task 7's fixed outbound pre-authentication message after an eligible bind", async () => {
    const repo = repository();
    const session = await createOutboundSession(repo);
    const preAuthentication = Object.freeze({ voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE });
    const { instance, sendNeutralText } = core(
      session,
      repo,
      new Date(NONCE_EXPIRY.valueOf() - 1),
      preAuthentication,
    );

    await instance.handleRelayEvent(setup(session));

    expect(sendNeutralText).toHaveBeenCalledExactlyOnceWith(OUTBOUND_VOICEMAIL_MESSAGE);
    expect(JSON.stringify(sendNeutralText.mock.calls)).not.toMatch(/user_requested|principal:owner|identity:voice/iu);
  });

  it("hydrates the latest authoritative D1 session projection after an object restart", async () => {
    const repo = repository();
    const session = await createInboundSession(repo);
    const { instance } = core(session, repo, NOW);
    await instance.handleRelayEvent(setup(session));

    const restartedRepository = repository();
    await expect(restartedRepository.getCallSession(session.sessionId)).resolves.toMatchObject({
      sessionId: session.sessionId,
      phase: "pre_auth",
      providerSessionId: PROVIDER_SESSION_ID,
      binding: session.binding,
    });
  });

  it("closes and rejects a second setup without another durable transition", async () => {
    const repo = repository();
    const session = await createInboundSession(repo);
    const { instance, close } = core(session, repo, NOW);
    await instance.handleRelayEvent(setup(session));

    await expect(instance.handleRelayEvent(setup(session))).rejects.toThrow("relay_setup_replayed");

    expect(await storedRow(session.sessionId)).toEqual({ phase: "pre_auth", provider_session_id: PROVIDER_SESSION_ID });
    expect(close).toHaveBeenCalledExactlyOnceWith(1008);
  });
});
