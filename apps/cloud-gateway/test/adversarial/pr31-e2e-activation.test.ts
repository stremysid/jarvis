// PR #31 adversarial suite, attack 9: enroll through the production route, activate through an inbound
// activation-only CallSessionCore, then use the active owner identity. Also spoofed, guest and unknown callers.
// Tests named "OBSERVATION" document pre-existing inbound behaviour that PR #31 makes reachable.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import type { ModelToken } from "../../src/conversation/conversation-types.js";
import { DefaultModelAdapter } from "../../src/model/model-adapter.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { Redactor } from "../../src/security/redaction.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { CallSessionCore, PhoneActivationChallengeConfirmer } from "../../src/voice/call-session-do.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { AuthenticationAttemptBudget } from "../../src/voice/inbound-auth.js";
import { VoiceAccessAuthorityService } from "../../src/voice/voice-access-authority.js";
import {
  AUDIENCE, b64, BEGIN, count, dumpAllTables, enrollmentEnvironment, KEY_VERSION, PHONE, resetEnrollmentState,
  seedDevice, seedPrincipal, send, STATUS, type Device,
} from "./pr31-helpers.js";

const NOW = new Date("2026-09-14T15:00:00.000Z");
const OWNER_VOICE = "identity:voice";
const ACCOUNT_SID = `AC${"6".repeat(32)}`;
const CHALLENGE_PEPPER = new Uint8Array(32).fill(11);
const BUDGET_PEPPER = new Uint8Array(32).fill(7);
const GUEST_E164 = "+15005550010";
const UNKNOWN_E164 = "+15005550011";
const GUEST_GRANT_ID = "01k3wceg000000000000000905";

type Issued = { challengeId: string; response: string; expiresAt: string };

let callCounter = 0;
let budgets: AuthenticationAttemptBudget;
let provider: FakeModelProvider;

function routeEnvironment() {
  return enrollmentEnvironment({ OWNER_VOICE_IDENTITY_ID: OWNER_VOICE, IDENTITY_CHALLENGE_HMAC_PEPPER: b64(CHALLENGE_PEPPER) });
}

function at(offsetMs: number): void {
  vi.setSystemTime(new Date(NOW.valueOf() + offsetMs));
}

async function begin(device: Device): Promise<Issued> {
  const result = await send(device, BEGIN, routeEnvironment());
  expect(result.status, result.text).toBe(200);
  const json = result.json as Issued & { enrollmentState: string };
  expect(json.enrollmentState).toBe("pending");
  return json;
}

function activation(): PhoneActivationChallengeConfirmer {
  const observations = new VerifiedChannelObservationAuthority();
  const challenges = new IdentityChallengeService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: AUDIENCE }),
    observations,
    hmacPepper: CHALLENGE_PEPPER,
    hmacKeyVersion: KEY_VERSION,
    now: () => new Date(),
  });
  return new PhoneActivationChallengeConfirmer({ database: env.DB, budgets, observations, challenges });
}

function conversation(): DefaultConversationService {
  return new DefaultConversationService({
    repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
    model: new DefaultModelAdapter(provider),
    context: new D1ContextRetriever(env.DB),
    dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); } },
    redactor: new Redactor(),
    now: () => new Date(),
  });
}

async function admit(from: string): Promise<{ repo: CallRepository; session: StoredCallSession; n: number }> {
  callCounter += 1;
  const repo = new CallRepository(env.DB, new EventRepository(env.DB));
  const session = await repo.getOrCreateInboundSession({
    callSid: `CA${callCounter.toString(16).padStart(32, "0")}`,
    callerE164: from,
    ownerIdentityId: OWNER_VOICE,
    currentChallengeHmacKeyVersion: KEY_VERSION,
    now: new Date(),
  });
  return { repo, session, n: callCounter };
}

async function connect(admitted: Awaited<ReturnType<typeof admit>>) {
  const relay = {
    close: vi.fn<(code: number) => void>(),
    sendNeutralText: vi.fn<(text: string) => Promise<void>>(async () => undefined),
    sendToken: vi.fn<(token: ModelToken) => Promise<void>>(async () => undefined),
    finish: vi.fn<(finalText: string) => Promise<void>>(async () => undefined),
    cancelOutput: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const turnIds = [newUlid(), newUlid()];
  const instance = new CallSessionCore({
    capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
    session: admitted.session,
    expectedAccountSid: ACCOUNT_SID,
    repository: admitted.repo,
    authority: new VoiceAccessAuthorityService(
      new VoiceAccessRepository(env.DB),
      new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
    ),
    guestAuthentication: null,
    activation: activation(),
    ownerAccess: null,
    conversation: conversation(),
    relay,
    newTurnId: () => {
      const turnId = turnIds.shift();
      if (turnId === undefined) throw new Error("turn_ids_exhausted");
      return turnId;
    },
    now: () => new Date(),
  });
  await instance.handleRelayEvent({
    type: "setup",
    sessionId: `VX${admitted.n.toString(16).padStart(32, "0")}`,
    accountSid: ACCOUNT_SID,
    callSid: admitted.session.callSid,
    direction: admitted.session.direction,
    relayNonce: admitted.session.binding.relayNonce,
  });
  return { instance, relay };
}

async function dial(from: string, digits: string) {
  const admitted = await admit(from);
  const call = await connect(admitted);
  for (const digit of digits) await call.instance.handleRelayEvent({ type: "dtmf", digit });
  return { ...admitted, ...call };
}

async function ownerIdentity(): Promise<{ status: string; verified: number } | null> {
  return env.DB.prepare(
    "SELECT status, verified_at IS NOT NULL AS verified FROM channel_identities WHERE identity_id = ?",
  ).bind(OWNER_VOICE).first<{ status: string; verified: number }>();
}

function wrongFor(response: string): string {
  return response === "000000" ? "111111" : "000000";
}

async function seedGuestGrant(): Promise<void> {
  const registry = new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] });
  const verifier = new GuestPinVerifier(new Uint8Array(32).fill(12));
  const snapshot = await registry.snapshotConfigured(["conversation.basic"]);
  const record = await verifier.create(GUEST_GRANT_ID, Uint8Array.from([52, 56, 50, 55]));
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES ('principal:guest', 'human', 'active', 'Guest', ?, ?)`).bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities
      (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
      VALUES ('identity:guest', 'principal:guest', 'voice', ?, 'pending', NULL, ?, NULL)`).bind(GUEST_E164, timestamp),
    env.DB.prepare(`INSERT INTO voice_access_grants (
      grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json,
      access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations,
      pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at, activated_at, updated_at, revoked_at
    ) VALUES (?, 'principal:guest', 'identity:guest', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL)`).bind(
      GUEST_GRANT_ID, JSON.stringify(snapshot.capabilityIds), JSON.stringify(snapshot.resourceScopes),
      snapshot.accessDocumentHash, record.schemaVersion, record.algorithm, record.pepperVersion, record.iterations,
      record.saltBase64, record.digestBase64, OWNER_VOICE, timestamp, timestamp,
    ),
    env.DB.prepare(`INSERT INTO voice_access_grant_events (
      event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
      capability_ids_json, access_document_hash, created_at
    ) VALUES ('01k3wceg000000000000000906', ?, 1, 'created', ?, ?, ?, ?, ?)`).bind(
      GUEST_GRANT_ID, OWNER_VOICE, "e".repeat(64), JSON.stringify(snapshot.capabilityIds),
      snapshot.accessDocumentHash, timestamp,
    ),
  ]);
}

describe("PR31 adversarial 9: end to end through inbound activation", () => {
  let home: Device;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:owner", "principal:owner", "key:owner");
    budgets = new AuthenticationAttemptBudget(env.DB, BUDGET_PEPPER);
    provider = new FakeModelProvider({ streamText: "Synthetic owner reply.", streamTokenCount: 2 });
    callCounter = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("9a enroll → activation-only call → active → status → owner conversation, isolated on the way", async () => {
    const issued = await begin(home);

    await expect(admit(UNKNOWN_E164)).rejects.toThrow();

    const admitted = await admit(PHONE);
    expect(admitted.session.binding).toMatchObject({
      activationOnly: true, activationChallengeId: issued.challengeId, accessKind: "owner", identityId: OWNER_VOICE,
    });
    const call = await connect(admitted);
    expect(call.instance.phase).toBe("pre_auth");
    await call.instance.handleRelayEvent({ type: "prompt", text: "read my memory", language: "en-US", final: true });
    expect(provider.requests).toHaveLength(0);
    expect(await count("conversation_turns")).toBe(0);
    for (const digit of issued.response) await call.instance.handleRelayEvent({ type: "dtmf", digit });
    expect(call.instance.phase).toBe("completed");
    expect(await ownerIdentity()).toEqual({ status: "active", verified: 1 });
    expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity").first())
      .toEqual({ principal_id: "principal:owner", identity_id: OWNER_VOICE });

    const challengesBefore = await count("identity_challenges");
    expect((await send(home, STATUS, routeEnvironment())).json).toMatchObject({ enrollmentState: "active" });
    expect((await send(home, BEGIN, routeEnvironment())).json).toMatchObject({ enrollmentState: "active" });
    expect(await count("identity_challenges")).toBe(challengesBefore);

    const owner = await admit(PHONE);
    expect(owner.session.binding).toMatchObject({ activationOnly: false, activationChallengeId: null, accessKind: "owner" });
    const ownerCall = await connect(owner);
    expect(ownerCall.instance.phase).toBe("active");
    await ownerCall.instance.handleRelayEvent({ type: "prompt", text: "What is next?", language: "en-US", final: true });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ principalId: "principal:owner", channel: "voice" });

    for (const [table, rows] of Object.entries(await dumpAllTables())) {
      expect(rows, table).not.toContain(issued.response);
    }
  });

  it("9b a caller spoofing the enrolled number gets three wrong guesses; the owner's right code then needs a resume", async () => {
    const issued = await begin(home);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const spoofed = await dial(PHONE, wrongFor(issued.response));
      expect(spoofed.session.binding.activationChallengeId).toBe(issued.challengeId);
      expect(spoofed.instance.phase).toBe("failed");
    }
    const blocked = await dial(PHONE, issued.response);
    expect(blocked.instance.phase).toBe("failed");
    expect((await ownerIdentity())?.status).toBe("pending");

    at(1_000);
    const resumed = await begin(home);
    expect(resumed.challengeId).not.toBe(issued.challengeId);
    const owner = await dial(PHONE, resumed.response);
    expect(owner.session.binding.activationChallengeId).toBe(resumed.challengeId);
    expect(owner.instance.phase).toBe("completed");
    expect((await ownerIdentity())?.status).toBe("active");
  });

  it("OBSERVATION 9c spoofed calls across two resumes exhaust the composite budget and block the owner for the window", async () => {
    let issued = await begin(home);
    for (let attempt = 0; attempt < 3; attempt += 1) await dial(PHONE, wrongFor(issued.response));
    at(1_000);
    issued = await begin(home);
    for (let attempt = 0; attempt < 3; attempt += 1) await dial(PHONE, wrongFor(issued.response));
    at(2_000);
    issued = await begin(home);
    const blocked = await dial(PHONE, issued.response);
    expect(blocked.session.binding.activationChallengeId).toBe(issued.challengeId);
    expect(blocked.instance.phase).toBe("failed");
    expect((await ownerIdentity())?.status).toBe("pending");

    at(303_000);
    // FINDING 5a reproduced in the call flow: every earlier challenge has expired, so the first retry is a 409.
    expect((await send(home, BEGIN, routeEnvironment())).status).toBe(409);
    issued = await begin(home);
    const owner = await dial(PHONE, issued.response);
    expect(owner.instance.phase).toBe("completed");
    expect((await ownerIdentity())?.status).toBe("active");
  });

  it("9d guest-grant holders and unknown callers cannot use the pending owner identity, before or after activation", async () => {
    const issued = await begin(home);
    await seedGuestGrant();
    await expect(admit(GUEST_E164)).rejects.toThrow();
    await expect(admit(UNKNOWN_E164)).rejects.toThrow();
    expect(await count("call_sessions")).toBe(0);

    const call = await dial(PHONE, issued.response);
    expect(call.instance.phase).toBe("completed");

    const guest = await admit(GUEST_E164);
    expect(guest.session.binding).toMatchObject({
      accessKind: "guest", activationOnly: false, activationChallengeId: null, identityId: "identity:guest",
    });
    await expect(admit(UNKNOWN_E164)).rejects.toThrow();
  });

  it("9e a resume during an in-progress activation call leaves that call bound to its original response", async () => {
    const first = await begin(home);
    const admitted = await admit(PHONE);
    expect(admitted.session.binding.activationChallengeId).toBe(first.challengeId);
    const call = await connect(admitted);

    at(1_000);
    const second = await begin(home);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(await count("identity_challenges")).toBe(2);

    for (const digit of first.response) await call.instance.handleRelayEvent({ type: "dtmf", digit });
    expect(call.instance.phase).toBe("completed");
    expect((await ownerIdentity())?.status).toBe("active");
    const next = await admit(PHONE);
    expect(next.session.binding.activationOnly).toBe(false);
  });

  it("9f revoking the enrolling device after begin closes inbound activation for its challenge", async () => {
    await begin(home);
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(new Date().toISOString(), home.deviceId).run();
    await expect(admit(PHONE)).rejects.toThrow();
    expect((await ownerIdentity())?.status).toBe("pending");
  });

  it("9g an activation-only session cannot be used after its challenge expires", async () => {
    const issued = await begin(home);
    const admitted = await admit(PHONE);
    const call = await connect(admitted);
    at(300_000);
    for (const digit of issued.response) await call.instance.handleRelayEvent({ type: "dtmf", digit });
    expect(call.instance.phase).toBe("failed");
    expect((await ownerIdentity())?.status).toBe("pending");
    await expect(admit(PHONE)).rejects.toThrow();
  });

  // v2 (327ddda). OBSERVATION 9c stops at its embedded FINDING 5a line (409 is now 200). This split keeps the
  // lockout observation and replaces that line with its inversion so the recovery half still runs.
  it("CLASSIFY 9c the spoofing lockout still blocks the owner inside the window; after it, the first begin (200) recovers", async () => {
    let issued = await begin(home);
    for (let attempt = 0; attempt < 3; attempt += 1) await dial(PHONE, wrongFor(issued.response));
    at(1_000);
    issued = await begin(home);
    for (let attempt = 0; attempt < 3; attempt += 1) await dial(PHONE, wrongFor(issued.response));
    at(2_000);
    issued = await begin(home);
    const blocked = await dial(PHONE, issued.response);
    expect(blocked.session.binding.activationChallengeId).toBe(issued.challengeId);
    expect(blocked.instance.phase).toBe("failed");
    expect((await ownerIdentity())?.status).toBe("pending");

    at(303_000);
    const retry = await send(home, BEGIN, routeEnvironment());
    expect(retry.status).toBe(200);
    issued = retry.json as Issued;
    const owner = await dial(PHONE, issued.response);
    expect(owner.session.binding.activationChallengeId).toBe(issued.challengeId);
    expect(owner.instance.phase).toBe("completed");
    expect((await ownerIdentity())?.status).toBe("active");
  });
});
