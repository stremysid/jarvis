import { env, evictDurableObject } from "cloudflare:test";
import { newUlid, type Ulid } from "../../../packages/contracts/src/index.js";
import {
  FAKE_OWNER_PASSPHRASE,
  FAKE_OWNER_PASSPHRASE_PEPPER,
  FAKE_PIN_A,
  seedFakeGuest,
  seedFakeOwnerPassphrase,
} from "./voice-access-system.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { applyVoiceRuntimeMigration, clearCallSessionsForTest, clearAuthenticationAttemptReservationsForTest,
  applyOwnerSensitiveActionPinMigration, applyVoiceOwnerDeliveryMigration, clearConversationDataForTest,
  clearOwnerCallStepUpDataForTest, clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest } from "../../../apps/cloud-gateway/test/persistence/migration.js";
import { OwnerPassphraseVerifier } from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import { OwnerCallStepUpService } from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const ACCOUNT_SID = `AC${"6".repeat(32)}`;
const CALL_SID = `CA${"4".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"5".repeat(32)}`;

describe("production voice through the real DO stub and socket", () => {
  let client: WebSocket | undefined;
  let requests: string[];
  let credit: string;
  let creditFails: boolean;
  let sessionId: Ulid;
  let modelBodies: unknown[];
  const stub = () => env.CALL_SESSION.get(env.CALL_SESSION.idFromName(sessionId));

  beforeEach(async () => {
    // 0034 owns the owner-admission boundary. Without it this fixture keeps the
    // 0018 lineage trigger that demanded a step-up success the owner path no longer
    // writes, and admission aborts instead of reaching conversation.
    await applyVoiceRuntimeMigration();
    await applyVoiceOwnerDeliveryMigration();
    await applyOwnerSensitiveActionPinMigration();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    requests = []; credit = "15"; creditFails = false; modelBodies = []; sessionId = newUlid();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://api.deepseek.com/user/balance") {
        if (creditFails) throw new Error("synthetic credit unavailable");
        return Response.json({ is_available: true,
          balance_infos: [{ currency: "USD", total_balance: credit, granted_balance: "0", topped_up_balance: credit }] });
      }
      if (url === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records/Today.json?Category=totalprice`) {
        return Response.json({ next_page_uri: null, usage_records: [{ account_sid: ACCOUNT_SID, category: "totalprice",
          price: "1", price_unit: "usd", start_date: "2026-08-30", end_date: "2026-08-30", as_of: "2026-08-30T12:00:00+00:00" }] });
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        modelBodies.push(JSON.parse(String(init?.body)));
        return new Response('data: {"choices":[{"delta":{"content":"A real socket reply."}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
      }
      // No fallback to the network, including alerts or unexpected providers.
      throw new Error("unexpected synthetic provider request");
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`).bind(NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)`)
        .bind(NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(`INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at)
        VALUES (1, 'principal:owner', 'identity:voice', ?)`).bind(NOW.toISOString()),
    ]);
    await seedFakeOwnerPassphrase();
  });

  afterEach(async () => {
    client?.close(); client = undefined;
    await evictDurableObject(stub(), { webSockets: "close" });
    await clearOwnerCallStepUpDataForTest();
    await clearCallSessionsForTest();
    await clearAuthenticationAttemptReservationsForTest();
    await clearConversationDataForTest();
    await clearOwnerPassphraseDataForTest();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([env.DB.prepare("DELETE FROM capacity_alert_crossings"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM device_keys"), env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM principals")]);
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  async function open(caller = "+14165550123") {
    const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => `${"D".repeat(42)}M`,
      300_000, () => sessionId);
    const stored = await repository.getOrCreateInboundSession({ callSid: CALL_SID, callerE164: caller,
      ownerIdentityId: "identity:voice", currentChallengeHmacKeyVersion: "identity-hmac-v1", now: NOW });
    if (stored.binding.accessKind === "owner") {
      await new OwnerCallStepUpService(
        env.DB, new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1"),
      ).bind({
        sessionId: stored.sessionId, callSid: stored.callSid,
        ownerPrincipalId: stored.binding.principalId, ownerIdentityId: stored.binding.identityId,
        direction: "inbound", lifecycleGeneration: 1, requirement: "required",
        attestationClass: "absent", policy: "passphrase_always", createdAt: stored.createdAt,
      });
    }
    await stub().initialize({ sessionId: stored.sessionId, binding: stored.binding, relaySetupExpiresAt: stored.relaySetupExpiresAt! });
    const response = await stub().fetch(new Request(`https://internal/voice/relay/${stored.sessionId}`,
      { headers: { Upgrade: "websocket" } }));
    expect(response.status).toBe(101);
    client = response.webSocket!;
    const frames: unknown[] = [];
    const closes: number[] = [];
    client.accept();
    client.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data))); });
    client.addEventListener("close", (event) => { closes.push(event.code); });
    client.send(JSON.stringify({ type: "setup", sessionId: PROVIDER_SESSION_ID, accountSid: ACCOUNT_SID,
      callSid: CALL_SID, direction: "inbound", customParameters: { relayNonce: stored.binding.relayNonce } }));
    // Setup alone admits an owner. A guest still waits for their PIN.
    await vi.waitFor(async () => expect((await repository.getCallSession(stored.sessionId))?.phase)
      .toBe(stored.binding.accessKind === "owner" ? "active" : "pre_auth"));
    return { repository, stored, frames, closes,
      prompt: (voicePrompt: string) => client!.send(JSON.stringify({ type: "prompt", voicePrompt, lang: "en-US", last: true })),
      digit: (digit: number) => client!.send(JSON.stringify({ type: "dtmf", digit: String.fromCharCode(digit) })),
    };
  }

  it("uses default composition for two socket turns across real eviction", async () => {
    const call = await open();
    call.prompt("My first socket question about chamomile");
    await vi.waitFor(() => expect(call.frames).toContainEqual({ type: "text", token: "A real socket reply.", last: false }));
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM conversation_turns").all()).results)
      .toEqual([{ state: "voice_sent" }]));
    await evictDurableObject(stub());
    call.prompt("Recall my first socket question");
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM conversation_turns ORDER BY rowid").all()).results)
      .toEqual([{ state: "voice_sent" }, { state: "voice_sent" }]));
    expect(requests.filter((url) => url.endsWith("/chat/completions"))).toHaveLength(2);
    expect(requests.filter((url) => url.endsWith("/user/balance"))).toHaveLength(2);
    expect(JSON.stringify(modelBodies[1])).toContain("My first socket question about chamomile");
    expect(call.closes).toEqual([]);
  }, 15_000);

  it("activates a guest through socket DTMF and retains the correct authority across eviction", async () => {
    const guest = await seedFakeGuest("a");
    const call = await open(guest.caller);
    expect(requests).toEqual([]);
    for (const digit of FAKE_PIN_A()) call.digit(digit);
    await vi.waitFor(async () => expect((await call.repository.getCallSession(sessionId))?.phase).toBe("active"));
    await expect(env.DB.prepare("SELECT count(*) AS count FROM authentication_attempt_reservations").first())
      .resolves.toEqual({ count: 1 });
    await evictDurableObject(stub());
    call.prompt("An authenticated guest question");
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT principal_id, state FROM conversation_turns").all()).results)
      .toEqual([{ principal_id: guest.principalId, state: "voice_sent" }]));
    expect(call.closes).toEqual([]);
    expect(modelBodies).toHaveLength(1);
  }, 15_000);

  it("fails closed on an unreadable balance after a successful real-socket turn", async () => {
    const call = await open();
    call.prompt("A permitted socket question");
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM conversation_turns").all()).results)
      .toEqual([{ state: "voice_sent" }]));
    creditFails = true;
    call.prompt("Do not send this model request");
    await vi.waitFor(() => expect(call.closes).toContain(1011));
    expect(modelBodies).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith("/user/balance"))).toHaveLength(2);
    await expect(env.DB.prepare("SELECT count(*) AS count FROM conversation_turns").first()).resolves.toEqual({ count: 1 });
  }, 15_000);
});
