import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import type { CapacityGuard } from "../../src/archive/capacity-guard.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DefaultModelAdapter } from "../../src/model/model-adapter.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  CallSession,
  CallSessionCore,
  GUEST_REJECTED_HANDOFF_DATA,
  GuestCallAuthentication,
} from "../../src/voice/call-session-do.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { AuthenticationAttemptBudget } from "../../src/voice/inbound-auth.js";
import type { SensitiveActionPinPort } from "../../src/voice/sensitive-action-pin.js";
import { GuestPinProofIssuer, VoiceAccessAuthorityService } from "../../src/voice/voice-access-authority.js";
import {
  applyVoiceOwnerDeliveryMigration,
  applyVoiceRuntimeMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearConversationDataForTest,
} from "../persistence/migration.js";
import {
  clearVoiceAccessFixture,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_SESSION_ID,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

const ACCOUNT_SID = `AC${"6".repeat(32)}`;

function prompt(text: string) {
  return { type: "prompt", voicePrompt: text, lang: "en-US", last: true };
}

async function relayHarness(kind: "owner" | "guest", options: {
  capacity?: Pick<CapacityGuard, "assertAcceptingNewTurn">;
  callSidLimit?: number;
  holdFirstTurn?: Promise<void>;
  holdFirstTurnAfterReply?: Promise<void>;
  sensitiveActionPin?: SensitiveActionPinPort;
} = {}) {
  const repository = new CallRepository(env.DB, new EventRepository(env.DB));
  const access = new VoiceAccessRepository(env.DB);
  const owner = await seedOwnerAuthority(env.DB, access);
  let stored;
  if (kind === "owner") {
    stored = await repository.transitionCallSession({
      sessionId: OWNER_SESSION_ID, expectedPhase: "authenticated", nextPhase: "active", now: NOW,
    });
  } else {
    const grant = validCreateInput(owner);
    await access.createGuestGrant(grant);
    stored = await repository.getOrCreateInboundSession({
      callSid: `CA${"7".repeat(32)}`,
      callerE164: grant.providerE164,
      ownerIdentityId: OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "synthetic-v1",
      now: NOW,
    });
  }
  const relaySetupExpiresAt = stored.relaySetupExpiresAt;
  if (relaySetupExpiresAt === null) throw new Error("synthetic_inbound_deadline_missing");
  const proofs = new GuestPinProofIssuer();
  const authority = new VoiceAccessAuthorityService(
    access, new CapabilityRegistry({ installed: ["conversation.basic"] }), proofs,
  );
  const guestAuthentication = new GuestCallAuthentication({
    repository: access,
    budgets: new AuthenticationAttemptBudget(env.DB, new Uint8Array(32).fill(7),
      options.callSidLimit === undefined ? undefined : { callSidLimit: options.callSidLimit }),
    verifier: new GuestPinVerifier(new Uint8Array(32).fill(12)),
    proofs,
  });
  let observedAt = new Date(NOW.valueOf() + 1_000);
  const provider = new FakeModelProvider({ streamText: "Understood." });
  const conversation = new DefaultConversationService({
    repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
    model: new DefaultModelAdapter(provider),
    context: { async retrieve() { return []; } },
    dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); } },
    redactor: new Redactor(),
    now: () => observedAt,
  });
  const realHandleTurn = conversation.handleTurn.bind(conversation);
  const handleTurn = vi.spyOn(conversation, "handleTurn");
  if (options.holdFirstTurn !== undefined) {
    const gate = options.holdFirstTurn;
    let first = true;
    handleTurn.mockImplementation(async (input) => {
      // Deliberately ignores input.signal: the abort must not settle this turn, so
      // the slot stays owned exactly as a slow teardown leaves it.
      if (first) {
        first = false;
        await gate;
      }
      return realHandleTurn(input);
    });
  }
  if (options.holdFirstTurnAfterReply !== undefined) {
    const gate = options.holdFirstTurnAfterReply;
    let first = true;
    handleTurn.mockImplementation(async (input) => {
      // The reply is fully spoken, then the turn waits (as on its durable receipt)
      // while it still owns the slot.
      const result = await realHandleTurn(input);
      if (first) {
        first = false;
        await gate;
      }
      return result;
    });
  }
  const send = vi.fn<(message: string) => void>();
  const close = vi.fn<(code?: number, reason?: string) => void>();
  const socket = { send, close, deserializeAttachment: () => ({ sessionId: stored.sessionId }) } as unknown as WebSocket;
  return {
    stored, provider, handleTurn, send, close, repository,
    atOffset(milliseconds: number) { observedAt = new Date(NOW.valueOf() + milliseconds); },
    async run(action: (message: (frame: Record<string, unknown>) => Promise<void>) => Promise<void>) {
      const stub = env.CALL_SESSION.getByName(stored.sessionId) as DurableObjectStub<CallSession>;
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAll();
        const object = new CallSession(state, env, input => new CallSessionCore({
          session: input.session,
          repository,
          expectedAccountSid: ACCOUNT_SID,
          capacity: options.capacity ?? { async assertAcceptingNewTurn() {} },
          authority, guestAuthentication, conversation,
          sensitiveActionPin: options.sensitiveActionPin ?? null,
          relay: input.relay,
          newTurnId: newUlid,
          now: () => observedAt,
        }));
        await object.initialize({
          sessionId: stored.sessionId, binding: stored.binding, relaySetupExpiresAt,
        });
        const message = (frame: Record<string, unknown>) => object.webSocketMessage(socket, JSON.stringify(frame));
        if (kind === "guest") {
          await message({
            type: "setup", sessionId: `VX${"8".repeat(32)}`, accountSid: ACCOUNT_SID,
            callSid: stored.callSid, direction: "inbound", customParameters: { relayNonce: stored.binding.relayNonce },
          });
          expect(close).not.toHaveBeenCalled();
          send.mockClear();
        }
        await action(message);
      });
    },
  };
}

describe("CallSession relay fixes", () => {
  beforeEach(async () => {
    await applyVoiceRuntimeMigration();
    // Teardown reads 0021's tables, so install it before the first test as well.
    await applyVoiceOwnerDeliveryMigration();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAuthenticationAttemptReservationsForTest();
    await clearConversationDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM provider_events"),
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
    ]);
    await clearVoiceAccessFixture(env.DB);
  });

  it("queues an overlapping prompt without closing the relay or starting a second admission", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => { await gate; }) };
    const harness = await relayHarness("owner", { capacity });
    harness.atOffset(4_000);
    await harness.run(async message => {
      const first = message(prompt("Tell me what is next."));
      try {
        await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
        // The overlap resolves and is held for the next turn rather than dropped.
        await expect(message(prompt("And after that?"))).resolves.toBeUndefined();
        expect(harness.close).not.toHaveBeenCalled();
        expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce();
        expect(harness.handleTurn).not.toHaveBeenCalled();
        expect(harness.provider.requests).toHaveLength(0);
      } finally {
        release();
        await expect(first).resolves.toBeUndefined();
      }
      expect(harness.close).not.toHaveBeenCalled();
      expect(harness.handleTurn).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(2));
      expect(harness.provider.requests[0]).toMatchObject({ userText: "Tell me what is next." });
      // The queued utterance became the next real turn.
      expect(harness.provider.requests[1]).toMatchObject({ userText: "And after that?" });
      await expect(message(prompt("Thanks."))).resolves.toBeUndefined();
      expect(harness.close).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(3));
      expect(harness.provider.requests[2]).toMatchObject({ userText: "Thanks." });
    });
  });

  it.each(["unexpected_capacity_failure", "turn_in_progress"])(
    "closes the relay for an unexpected error even when its message is %s",
    async errorMessage => {
      const harness = await relayHarness("owner", {
        capacity: { async assertAcceptingNewTurn() { throw new Error(errorMessage); } },
      });
        harness.atOffset(4_000);
      await harness.run(async message => {
        await expect(message(prompt("Tell me what is next."))).resolves.toBeUndefined();
        expect(harness.close).toHaveBeenCalledExactlyOnceWith(1011, "relay processing failed");
        expect(harness.provider.requests).toHaveLength(0);
      });
    },
  );

  it("sends the rejection speech, a fixed guest handoff, and closes after the third bad guest candidate", async () => {
    const harness = await relayHarness("guest");
    const transition = vi.spyOn(harness.repository, "transitionCallSession");
    await harness.run(async message => {
      // Synthetic all-zero spoken input cannot match the shared synthetic verifier.
      const badCandidate = () => message(prompt(String(0).repeat(4)));
      await badCandidate();
      await badCandidate();
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.close).not.toHaveBeenCalled();
      await expect(badCandidate()).resolves.toBeUndefined();
      expect(harness.send).toHaveBeenNthCalledWith(1, JSON.stringify({
        type: "text", token: "I couldn't verify access. Goodbye.", last: true,
      }));
      expect(harness.send).toHaveBeenNthCalledWith(2, JSON.stringify({
        type: "end", handoffData: GUEST_REJECTED_HANDOFF_DATA,
      }));
      expect(harness.close).toHaveBeenCalledExactlyOnceWith(1008, "relay policy violation");
      // Every frame precedes the close: the caller hears the rejection and the
      // handoff is offered before the relay is released.
      for (const order of harness.send.mock.invocationCallOrder) {
        expect(order).toBeLessThan(harness.close.mock.invocationCallOrder[0]!);
      }
      // The rejection is recorded before anything is spoken: a close can make the
      // socket handler fail a pre_auth session, which must not win over "rejected".
      const rejected = transition.mock.calls.findIndex(([input]) => input.nextPhase === "rejected");
      expect(rejected).toBeGreaterThanOrEqual(0);
      await expect(transition.mock.results[rejected]!.value).resolves.toMatchObject({ phase: "rejected" });
      expect(transition.mock.invocationCallOrder[rejected]!)
        .toBeLessThan(harness.send.mock.invocationCallOrder[0]!);
      expect(await env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
        .bind(harness.stored.sessionId).first()).toEqual({ phase: "rejected" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM authentication_attempt_reservations").first())
        .toEqual({ count: 3 });
      expect(harness.handleTurn).not.toHaveBeenCalled();
      expect(harness.provider.requests).toHaveLength(0);
    });
  });

  it("closes a rejected guest relay even when sending the rejection fails", async () => {
    const harness = await relayHarness("guest", { callSidLimit: 1 });
    await harness.run(async message => {
      for (let digit = 0; digit < 4; digit += 1) await message({ type: "dtmf", digit: String(0) });
      harness.send.mockImplementationOnce(() => { throw new Error("synthetic_send_failure"); });
      for (let digit = 0; digit < 4; digit += 1) {
        await expect(message({ type: "dtmf", digit: String(0) })).resolves.toBeUndefined();
      }
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.close).toHaveBeenCalledExactlyOnceWith(1008, "relay policy violation");
      expect(await env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
        .bind(harness.stored.sessionId).first()).toEqual({ phase: "rejected" });
      expect(harness.provider.requests).toHaveLength(0);
    });
  });

  it("admits a prompt sent after barge-in once the still-unwinding turn settles", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await relayHarness("owner", { holdFirstTurn: held });
    harness.atOffset(4_000);
    await harness.run(async message => {
      const first = message(prompt("Tell me what is next."));
      await vi.waitFor(() => expect(harness.handleTurn).toHaveBeenCalledTimes(1));
      await expect(message({
        type: "interrupt", utteranceUntilInterrupt: "", durationUntilInterruptMs: 0,
      })).resolves.toBeUndefined();
      const second = message(prompt("And after that?"));
      // Let the replacement reach the overlap check while turn 1 still owns the
      // slot. Without the bounded wait it is dropped here and never reaches the model.
      await new Promise((resolve) => setTimeout(resolve, 250));
      release();
      // Admitted when turn 1 settles, not when the 2 s bound runs out.
      const admitted = await Promise.race([
        second.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
      ]);
      expect(admitted).toBe("settled");
      await expect(second).resolves.toBeUndefined();
      await expect(first).resolves.toBeUndefined();
      expect(harness.close).not.toHaveBeenCalled();
      expect(harness.provider.requests).toHaveLength(1);
      expect(harness.provider.requests[0]).toMatchObject({ userText: "And after that?" });
    });
  });

  it("queues a prompt after barge-in when the aborted turn outlives the bound, and keeps the call open", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await relayHarness("owner", { holdFirstTurn: held });
    harness.atOffset(4_000);
    await harness.run(async message => {
      const first = message(prompt("Tell me what is next."));
      try {
        await vi.waitFor(() => expect(harness.handleTurn).toHaveBeenCalledTimes(1));
        await message({ type: "interrupt", utteranceUntilInterrupt: "", durationUntilInterruptMs: 0 });
        // Turn 1 is still held, so this resolves because it is queued, not admitted.
        await expect(message(prompt("And after that?"))).resolves.toBeUndefined();
        expect(harness.close).not.toHaveBeenCalled();
        expect(harness.provider.requests).toHaveLength(0);
      } finally {
        release();
        await expect(first).resolves.toBeUndefined();
      }
      await expect(message(prompt("Thanks."))).resolves.toBeUndefined();
      expect(harness.close).not.toHaveBeenCalled();
      // The queued utterance ran first, then the later one: neither was dropped.
      await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(2));
      expect(harness.provider.requests[0]).toMatchObject({ userText: "And after that?" });
      expect(harness.provider.requests[1]).toMatchObject({ userText: "Thanks." });
    });
  });

  // On this branch the passphrase repeat check is gone. The one await a prompt
  // makes before the slot check is the late-PIN claim, so that is where a slow
  // D1 read can hold one prompt while another claims the slot.
  it("two owner prompts racing the late-PIN claim never both start a turn at once", async () => {
    let releaseCapacity!: () => void;
    const capacityGate = new Promise<void>((resolve) => { releaseCapacity = resolve; });
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => { await capacityGate; }) };
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let firstClaim = true;
    const claimLateAnswer = vi.fn(async () => {
      // Holds prompt A inside its late-PIN lookup, the way D1 latency would.
      if (firstClaim) {
        firstClaim = false;
        await claimGate;
      }
      return false;
    });
    const sensitiveActionPin: SensitiveActionPinPort = {
      attachSession() {},
      hasPendingPrompt: () => false,
      async submitSpoken() {},
      async submitKeypad() {},
      claimLateAnswer,
    };
    const harness = await relayHarness("owner", { capacity, sensitiveActionPin });
    harness.atOffset(4_000);
    await harness.run(async message => {
      const a = message(prompt("Question A."));
      await vi.waitFor(() => expect(claimLateAnswer).toHaveBeenCalledTimes(1));
      const b = message(prompt("Question B."));
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledTimes(1));
      releaseClaim();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const turnsStarted = capacity.assertAcceptingNewTurn.mock.calls.length;
      releaseCapacity();
      await a;
      await b;
      expect(harness.close).not.toHaveBeenCalled();
      // Only one turn was admitted while the slot was held; the other ran
      // afterwards, as the next turn, so the two never started at once.
      expect(turnsStarted).toBe(1);
      await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(2));
      expect(harness.provider.requests.map((request) => (request as { userText?: string }).userText))
        .toEqual(expect.arrayContaining(["Question A.", "Question B."]));
    });
  });

  it("two prompts after one barge-in never both start a turn at once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await relayHarness("owner", { holdFirstTurn: held });
    harness.atOffset(4_000);
    await harness.run(async message => {
      const first = message(prompt("Tell me what is next."));
      await vi.waitFor(() => expect(harness.handleTurn).toHaveBeenCalledTimes(1));
      await message({ type: "interrupt", utteranceUntilInterrupt: "", durationUntilInterruptMs: 0 });
      const b = message(prompt("Question B."));
      const c = message(prompt("Question C."));
      await new Promise((resolve) => setTimeout(resolve, 250));
      release();
      await b;
      await c;
      await first;
      expect(harness.close).not.toHaveBeenCalled();
      // Both utterances reached the model, one turn at a time: the barge-in
      // aborted the first turn, and neither of the later two was dropped.
      await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(2));
      expect(harness.provider.requests.map((request) => (request as { userText?: string }).userText))
        .toEqual(expect.arrayContaining(["Question B.", "Question C."]));
    });
  });
});
