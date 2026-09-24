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
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import { OWNER_PASSPHRASE_WORDS } from "../../src/security/owner-passphrase-word-list.js";
import { Redactor } from "../../src/security/redaction.js";
import { CallSession, CallSessionCore, GuestCallAuthentication } from "../../src/voice/call-session-do.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { AuthenticationAttemptBudget } from "../../src/voice/inbound-auth.js";
import { OwnerCallStepUpService } from "../../src/voice/owner-call-step-up.js";
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
// seedOwnerAuthority uses these public word-list entries and this synthetic pepper.
const SYNTHETIC_PHRASE = OWNER_PASSPHRASE_WORDS.slice(0, 3).join(" ");
const SYNTHETIC_OWNER_PEPPER = new Uint8Array(32).fill(19);

function prompt(text: string) {
  return { type: "prompt", voicePrompt: text, lang: "en-US", last: true };
}

async function relayHarness(kind: "owner" | "guest", options: {
  capacity?: Pick<CapacityGuard, "assertAcceptingNewTurn">;
  callSidLimit?: number;
} = {}) {
  const repository = new CallRepository(env.DB, new EventRepository(env.DB));
  const access = new VoiceAccessRepository(env.DB);
  const owner = await seedOwnerAuthority(env.DB, access, { stepUpVerified: true });
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
  const ownerStepUp = new OwnerCallStepUpService(
    env.DB, new OwnerPassphraseVerifier(SYNTHETIC_OWNER_PEPPER, "v1"),
  );
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
  const handleTurn = vi.spyOn(conversation, "handleTurn");
  const send = vi.fn<(message: string) => void>();
  const close = vi.fn<(code?: number, reason?: string) => void>();
  const socket = { send, close, deserializeAttachment: () => ({ sessionId: stored.sessionId }) } as unknown as WebSocket;
  return {
    stored, provider, handleTurn, send, close, ownerStepUp,
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
          authority, guestAuthentication, ownerStepUp, conversation,
          ownerStepUpAlarm: input.ownerStepUpAlarm,
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
    // Step-up begin reads 0021's disabled-rejection table even for an active owner.
    // Teardown also installs it, which otherwise hides its absence after test one.
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

  it("drops an overlapping prompt without closing the relay or starting another model turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => { await gate; }) };
    const harness = await relayHarness("owner", { capacity });
    await harness.run(async message => {
      const first = message(prompt("Tell me what is next."));
      try {
        await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
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
      expect(harness.provider.requests).toHaveLength(1);
      expect(harness.provider.requests[0]).toMatchObject({ userText: "Tell me what is next." });
      await expect(message(prompt("Thanks."))).resolves.toBeUndefined();
      expect(harness.close).not.toHaveBeenCalled();
      expect(harness.provider.requests).toHaveLength(2);
      expect(harness.provider.requests[1]).toMatchObject({ userText: "Thanks." });
    });
  });

  it.each(["unexpected_capacity_failure", "turn_in_progress"])(
    "closes the relay for an unexpected error even when its message is %s",
    async errorMessage => {
      const harness = await relayHarness("owner", {
        capacity: { async assertAcceptingNewTurn() { throw new Error(errorMessage); } },
      });
      await harness.run(async message => {
        await expect(message(prompt("Tell me what is next."))).resolves.toBeUndefined();
        expect(harness.close).toHaveBeenCalledExactlyOnceWith(1011, "relay processing failed");
        expect(harness.provider.requests).toHaveLength(0);
      });
    },
  );

  it("sends a final rejection frame and closes after the third bad guest candidate", async () => {
    const harness = await relayHarness("guest");
    await harness.run(async message => {
      // Synthetic all-zero spoken input cannot match the shared synthetic verifier.
      const badCandidate = () => message(prompt(String(0).repeat(4)));
      await badCandidate();
      await badCandidate();
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.close).not.toHaveBeenCalled();
      await expect(badCandidate()).resolves.toBeUndefined();
      expect(harness.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: "text", token: "I couldn't verify access. Goodbye.", last: true,
      }));
      expect(harness.close).toHaveBeenCalledExactlyOnceWith(1008, "relay policy violation");
      expect(harness.send.mock.invocationCallOrder[0]).toBeLessThan(harness.close.mock.invocationCallOrder[0]!);
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

  it.each(["Stop", "What comes next?"])("passes ordinary owner speech %s to the model within the guard window", async text => {
    const harness = await relayHarness("owner");
    await expect(harness.ownerStepUp.repeatStatus(harness.stored.sessionId, new Date(NOW.valueOf() + 1_000)))
      .resolves.toBe("guard");
    await harness.run(async message => {
      await expect(message(prompt(text))).resolves.toBeUndefined();
      expect(harness.handleTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
      expect(harness.provider.requests).toHaveLength(1);
      expect(harness.provider.requests[0]).toMatchObject({ userText: text });
      expect(harness.close).not.toHaveBeenCalled();
    });
  });

  it("keeps a passphrase repeat out of the model within the guard window and speaks a neutral reply", async () => {
    const harness = await relayHarness("owner");
    await harness.run(async message => {
      await expect(message(prompt(SYNTHETIC_PHRASE))).resolves.toBeUndefined();
      expect(harness.handleTurn).not.toHaveBeenCalled();
      expect(harness.provider.requests).toHaveLength(0);
      expect(harness.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: "text", token: "I'm ready for your request.", last: true,
      }));
      expect(harness.close).not.toHaveBeenCalled();
      await message(prompt("Stop"));
      expect(harness.provider.requests).toHaveLength(1);
      expect(harness.provider.requests[0]).toMatchObject({ userText: "Stop" });
    });
  });

  it("passes the ordinary utterance formerly dropped by the guard to the conversation", async () => {
    const harness = await relayHarness("owner");
    const text = "This final arrives inside the repeat guard.";
    harness.atOffset(1_000);
    await expect(harness.ownerStepUp.repeatStatus(harness.stored.sessionId, new Date(NOW.valueOf() + 1_000)))
      .resolves.toBe("guard");
    await harness.run(async message => {
      await expect(message(prompt(text))).resolves.toBeUndefined();
      expect(harness.handleTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
      expect(harness.provider.requests).toHaveLength(1);
      expect(harness.provider.requests[0]).toMatchObject({ userText: text });
      expect(harness.close).not.toHaveBeenCalled();
    });
  });

  it.each([1, 2])("suppresses a passphrase split after word %i across two finals inside the guard window", async splitAfter => {
    const harness = await relayHarness("owner");
    const words = SYNTHETIC_PHRASE.split(" ");
    const fragments = [words.slice(0, splitAfter).join(" "), words.slice(splitAfter).join(" ")];
    await harness.run(async message => {
      for (const [index, fragment] of fragments.entries()) {
        const offset = 500 + index * 1_000;
        harness.atOffset(offset);
        await expect(harness.ownerStepUp.repeatStatus(harness.stored.sessionId, new Date(NOW.valueOf() + offset)))
          .resolves.toBe("guard");
        await expect(message(prompt(fragment))).resolves.toBeUndefined();
        expect(harness.handleTurn).not.toHaveBeenCalled();
        expect(harness.provider.requests).toHaveLength(0);
      }
      expect(harness.send.mock.calls).toEqual(Array.from({ length: 2 }, () => [JSON.stringify({
        type: "text", token: "I'm ready for your request.", last: true,
      })]));
      expect(harness.close).not.toHaveBeenCalled();
    });
  });

  it.each([1_000, 2_500])("speaks a neutral reply for each suppressed passphrase fragment at %i milliseconds", async offset => {
    const harness = await relayHarness("owner");
    harness.atOffset(offset);
    await harness.run(async message => {
      for (const word of SYNTHETIC_PHRASE.split(" ")) {
        await expect(message(prompt(word))).resolves.toBeUndefined();
      }
      expect(harness.handleTurn).not.toHaveBeenCalled();
      expect(harness.provider.requests).toHaveLength(0);
      expect(harness.send.mock.calls).toEqual(Array.from({ length: 3 }, () => [JSON.stringify({
        type: "text", token: "I'm ready for your request.", last: true,
      })]));
      expect(harness.close).not.toHaveBeenCalled();
    });
  });
});
