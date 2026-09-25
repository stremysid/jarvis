import { createExecutionContext, env, evictDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../../apps/cloud-gateway/src/index.js";
import type { Env } from "../../../apps/cloud-gateway/src/env.js";
import { FakeTwilioProvider } from "../../../apps/cloud-gateway/src/providers/fake-twilio-provider.js";
import { applyNewestRuntimeMigration, clearOutboundCallAttemptsForTest, clearConversationDataForTest,
  clearOwnerCallStepUpDataForTest, clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest } from "../../../apps/cloud-gateway/test/persistence/migration.js";
import {
  clearFakeCanonicalMemory,
  seedFakeCanonicalMemory,
  seedFakeOwnerPassphrase,
} from "./voice-access-system.js";

const ACCOUNT = `AC${"6".repeat(32)}`;
const CALL = `CA${"4".repeat(32)}`;
const ORIGIN = "https://jarvis.example";
const signer = new FakeTwilioProvider();

describe("production Worker voice and Telegram composition", () => {
  let requests: string[];
  let sends: string[];
  let dials: URLSearchParams[];
  let clients: WebSocket[];
  let now: Date;
  let creditFails: boolean;
  let modelBodies: Record<string, unknown>[];
  beforeEach(async () => {
    await applyNewestRuntimeMigration();
    const clock = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").first<{ now: string }>();
    now = new Date(clock!.now); requests = []; sends = []; dials = []; clients = []; creditFails = false;
    modelBodies = [];
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); requests.push(url);
      if (url === "https://api.deepseek.com/user/balance") {
        if (creditFails) throw new Error("synthetic credit failure");
        return Response.json({ is_available: true, balance_infos: [
          { currency: "USD", total_balance: "15", granted_balance: "0", topped_up_balance: "15" }] });
      }
      if (url === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Usage/Records/Today.json?Category=totalprice`) {
        return Response.json({ next_page_uri: null, usage_records: [{ account_sid: ACCOUNT, category: "totalprice", price: "1",
          price_unit: "usd", start_date: now.toISOString().slice(0, 10), end_date: now.toISOString().slice(0, 10),
          as_of: now.toISOString().replace(".000Z", "+00:00").replace(/\.\d{3}Z$/u, "+00:00") }] });
      }
      if (url === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls.json`) {
        dials.push(new URLSearchParams(String(init?.body)));
        return Response.json({ sid: CALL, account_sid: ACCOUNT, status: "queued" }, { status: 201 });
      }
      if (url.startsWith("https://api.telegram.org/bot") && url.endsWith("/sendMessage")) {
        sends.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
        return Response.json({ ok: true, result: { message_id: 901 } });
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        modelBodies.push(body);
        // Keep both response shapes available so a failed composition produces
        // an assertion below rather than an unrelated synthetic fetch failure.
        if (body.stream === true) {
          return new Response('data: {"choices":[{"index":0,"delta":{"content":"Worker socket reply."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ reply: "Worker socket reply.", claimedActions: [] }),
            },
          }],
        });
      }
      throw new Error("unexpected synthetic provider request");
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`).bind(now.toISOString(), now.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)`).bind(now.toISOString(), now.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES ('identity:telegram', 'principal:owner', 'telegram', '12345', 'active', ?, ?)`).bind(now.toISOString(), now.toISOString()),
      env.DB.prepare(`INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at)
        VALUES (1, 'principal:owner', 'identity:voice', ?)`).bind(now.toISOString()),
      env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1, quiet_starts_at = NULL, quiet_ends_at = NULL"),
    ]);
    await seedFakeOwnerPassphrase("principal:owner", "identity:voice", now.toISOString());
  });
  afterEach(async () => {
    for (const client of clients) client.close();
    for (const row of (await env.DB.prepare("SELECT session_id FROM call_sessions").all<{ session_id: string }>()).results) {
      await evictDurableObject(env.CALL_SESSION.get(env.CALL_SESSION.idFromName(row.session_id)), { webSockets: "close" });
    }
    await env.DB.prepare("DELETE FROM provider_events").run();
    await clearOwnerCallStepUpDataForTest(); await clearOutboundCallAttemptsForTest();
    await clearConversationDataForTest(); await clearOwnerPassphraseDataForTest(); await clearVoiceAccessDataForTest();
    await clearFakeCanonicalMemory("principal:owner");
    await env.DB.batch([env.DB.prepare("DELETE FROM capacity_alert_crossings"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM device_keys"), env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM policy_decisions"), env.DB.prepare("DELETE FROM principals")]);
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  async function deliver(request: Request, bindings: Env = env) {
    const ctx = createExecutionContext();
    // Synthetic Requests have no Cloudflare edge metadata; this route never reads cf.
    const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function form(path: string, pairs: Record<string, string>, bindings: Env = env, signature = true) {
    const body = new URLSearchParams(pairs).toString();
    return deliver(new Request(`${ORIGIN}${path}`, { method: "POST", body,
      headers: { "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature ? await signer.signWebhook(`${ORIGIN}${path}`, new TextEncoder().encode(body)) : "invalid" } }), bindings);
  }
  async function telegram(text = "/call check in --confirm", bindings: Env = env, updateId = 1) {
    return deliver(new Request(`${ORIGIN}/telegram/webhook`, { method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "synthetic-webhook-secret" },
      body: JSON.stringify({ update_id: updateId, message: { message_id: 900 + updateId,
        from: { id: 12345 }, chat: { id: 44 }, text } }) }), bindings);
  }
  const inbound = () => form("/voice/inbound", { CallSid: CALL, From: "+14165550123", To: "+14165550100" });

  it("authenticates ingress and forwards an actual upgraded socket to default composition", async () => {
    const canonicalFact = "The canonical Worker voice marker is heliotrope.";
    await seedFakeCanonicalMemory("principal:owner", canonicalFact, now.toISOString());
    const response = await inbound();
    expect(response.status).toBe(200);
    const xml = await response.text();
    const session = await env.DB.prepare("SELECT session_id, relay_nonce FROM call_sessions").first<{ session_id: string; relay_nonce: string }>();
    expect(session).not.toBeNull(); expect(xml).toContain(`/voice/relay/${session!.session_id}`);
    const relayUrl = `wss://jarvis.example/voice/relay/${session!.session_id}`;
    const upgraded = await deliver(new Request(relayUrl.replace("wss:", "https:"), { headers: {
      Upgrade: "websocket", "x-twilio-signature": await signer.signWebSocket(relayUrl) } }));
    expect(upgraded.status).toBe(101);
    const socket = upgraded.webSocket!; clients.push(socket); socket.accept();
    const frames: unknown[] = []; socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data))); });
    socket.send(JSON.stringify({ type: "setup", sessionId: `VX${"5".repeat(32)}`, accountSid: ACCOUNT,
      callSid: CALL, direction: "inbound", customParameters: { relayNonce: session!.relay_nonce } }));
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT phase FROM call_sessions").first())?.phase).toBe("active"));
    socket.send(JSON.stringify({
      type: "prompt", voicePrompt: "What is my canonical Worker voice marker?", lang: "en-US", last: true,
    }));
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "text", token: "Worker socket reply.", last: false }));
    expect(requests.filter((url) => url.endsWith("/chat/completions"))).toHaveLength(1);
    expect(modelBodies[0]).toMatchObject({
      stream: true, tool_choice: "auto", thinking: { type: "disabled" },
    });
    expect(JSON.stringify(modelBodies[0])).toContain(canonicalFact);
    const closes: number[] = []; socket.addEventListener("close", (event) => { closes.push(event.code); });
    const count = requests.length;
    const terminal = { CallSid: CALL, SessionId: `VX${"5".repeat(32)}`, SessionStatus: "completed", SessionDuration: "1" };
    expect((await form("/voice/relay-ended", terminal, env, false)).status).toBe(403);
    expect(closes).toEqual([]);
    expect((await form("/voice/relay-ended", terminal, { ...env, DEEPSEEK_API_KEY: undefined })).status).toBe(204);
    await vi.waitFor(() => expect(closes).toEqual([1000])); expect(requests).toHaveLength(count);
  }, 15_000);

  it("refuses an unsigned inbound request before provider telemetry or session allocation", async () => {
    const response = await form("/voice/inbound", { CallSid: CALL, From: "+14165550123", To: "+14165550100" }, env, false);
    expect(response.status).toBe(403); expect(requests).toEqual([]);
    await expect(env.DB.prepare("SELECT count(*) AS count FROM call_sessions").first()).resolves.toEqual({ count: 0 });
  });

  it("refuses inbound admission when authoritative credit cannot be read", async () => {
    creditFails = true;
    expect((await inbound()).status).toBe(503);
    expect(requests).toContain("https://api.deepseek.com/user/balance");
    await expect(env.DB.prepare("SELECT count(*) AS count FROM call_sessions").first()).resolves.toEqual({ count: 0 });
  });

  it("cancels the original open wrong-type stream before finishing rejection", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; } });
    const request = new Request(`${ORIGIN}/voice/inbound`, { method: "POST", body,
      headers: { "content-type": "application/json" } });
    const pending = deliver(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending.then((response) => response.status),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 100); })]);
      expect(result).toBe(403); expect(cancelled).toBe(true); expect(requests).toEqual([]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await request.body?.cancel(); await pending;
    }
  });

  it("refuses an unsigned relay upgrade before forwarding to the real session", async () => {
    expect((await inbound()).status).toBe(200);
    const row = await env.DB.prepare("SELECT session_id FROM call_sessions").first<{ session_id: string }>();
    const count = requests.length;
    const response = await deliver(new Request(`${ORIGIN}/voice/relay/${row!.session_id}`, { headers: {
      Upgrade: "websocket", "x-twilio-signature": "invalid" } }));
    expect(response.status).toBe(403); expect(requests).toHaveLength(count);
  });

  it.each(["PUBLIC_ORIGIN", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SECRET", "DEEPSEEK_API_KEY",
    "OWNER_VOICE_IDENTITY_ID", "GUEST_PIN_PEPPER_V1", "CAPACITY_MODEL_ALLOCATION_USD"] as const)(
    "refuses a configured owner command before any dial when %s is missing", async (field) => {
      expect((await telegram(undefined, { ...env, [field]: undefined })).status).toBe(200);
      expect(sends).toEqual(["Calling is not configured on this deployment."]); expect(dials).toHaveLength(0);
      expect(requests.every((url) => url.startsWith("https://api.telegram.org/"))).toBe(true);
    });

  it("dispatches an explicitly confirmed owner command once through the real REST adapter", async () => {
    expect((await telegram()).status).toBe(200);
    expect(sends).toEqual(["Call request accepted for your verified phone."]);
    expect(dials).toHaveLength(1); expect(dials[0]!.get("To")).toBe("+14165550123");
    expect(dials[0]!.get("StatusCallback")).toContain("#rc=2&rp=ct,rt,5xx");
    expect(requests.indexOf("https://api.deepseek.com/user/balance")).toBeLessThan(requests.findIndex((url) => url.endsWith("/Calls.json")));
    expect((await telegram()).status).toBe(200); expect(dials).toHaveLength(1);
  });

  it.each(["disabled", "credit", "confirmation"] as const)("refuses dispatch with %s and makes no call request", async (failure) => {
    if (failure === "disabled") await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 0").run();
    if (failure === "credit") creditFails = true;
    expect((await telegram(failure === "confirmation" ? "/call check in" : undefined)).status).toBe(200);
    expect(dials).toHaveLength(0);
    expect(sends[0]).toContain(failure === "credit" ? "capacity or spending telemetry" : failure === "disabled" ? "refused by the calling policy" : "To confirm");
  });

  it("initializes outbound TwiML and performs terminal cleanup without model or capacity configuration", async () => {
    await telegram(); expect(dials).toHaveLength(1);
    const path = new URL(dials[0]!.get("Url")!).pathname;
    const missingModel = { ...env, DEEPSEEK_API_KEY: undefined, CAPACITY_MODEL_ALLOCATION_USD: undefined };
    expect((await form(path, { CallSid: CALL, To: "+14165550123", From: "+14165550100" }, missingModel)).status).toBe(200);
    const session = await env.DB.prepare("SELECT session_id FROM call_sessions").first<{ session_id: string }>();
    const relayUrl = `wss://jarvis.example/voice/relay/${session!.session_id}`;
    const upgrade = await deliver(new Request(relayUrl.replace("wss:", "https:"), { headers: {
      Upgrade: "websocket", "x-twilio-signature": await signer.signWebSocket(relayUrl) } }), missingModel);
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket!; clients.push(socket); socket.accept();
    const closes: number[] = []; socket.addEventListener("close", (event) => { closes.push(event.code); });
    const count = requests.length;
    expect((await form(path.replace("/outbound/", "/status/"), { CallSid: CALL, CallStatus: "completed", SequenceNumber: "1",
      CallbackSource: "call-progress-events" }, missingModel, false)).status).toBe(403);
    expect(closes).toEqual([]);
    expect((await form(path.replace("/outbound/", "/status/"), { CallSid: CALL, CallStatus: "completed", SequenceNumber: "1", CallbackSource: "call-progress-events" }, missingModel)).status).toBe(204);
    await vi.waitFor(() => expect(closes).toEqual([1000]));
    expect(requests).toHaveLength(count);
    // It ended before authentication, so the terminal D1 phase is rejected.
    await expect(env.DB.prepare("SELECT phase FROM call_sessions").first()).resolves.toEqual({ phase: "rejected" });
    await expect(env.DB.prepare("SELECT provider_terminal_at FROM outbound_call_attempts").first()).resolves.toEqual({ provider_terminal_at: now.toISOString() });
  });
});
