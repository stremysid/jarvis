import { describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { canonicalJson, sha256Hex } from "../../../packages/contracts/src/index.js";
import { createFakeTelegramCallingSystem } from "./voice-telegram-system.js";
import { D1TelegramCallCommands } from "../../../apps/cloud-gateway/src/channels/telegram/telegram-call-command.js";
import worker from "../../../apps/cloud-gateway/src/index.js";

describe("fake Telegram self-call acceptance", () => {
  it("preserves exact receipt-time attribution for a UUID owner containing a six-digit run", async () => {
    const principalId = "principal:550e8400-e29b-41d4-a716-abc123456def";
    const system = await createFakeTelegramCallingSystem(principalId);
    try {
      await system.ingest("/call check in --confirm");
      expect(system.replies).toEqual(["Call request accepted for your verified phone."]);
      const accepted = system.accepted[0]!;
      const command = await system.commands().commandFor(accepted);
      expect(command.principalId).toBe(principalId);
      const persisted = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_id = ?")
        .bind(accepted.eventId).first<{ envelope_json: string }>();
      expect(JSON.parse(persisted!.envelope_json).payload.principalBinding).toEqual([...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram-principal-v1:${principalId}`)))]);
      expect(await system.commands().authenticatedOrigin(command.commandId)).toMatchObject({ principalId });
      await system.ingest("/call check in --confirm");
      await system.commands().request(accepted, { policy: system.policy, dispatcher: system.dispatcher });
      expect(system.twilio.requests).toHaveLength(1);
    } finally { await system.cleanup(); }
  });

  it.each(["/call", "/call ", "/call@jarvis_sid_bot"].flatMap((command) =>
    ["\n", "\r\n", "\u2028", "\u2029"].map((separator) => `${command}${separator}check in --confirm`)))(
    "refuses a line separator immediately after the command in %j", async (text) => {
      const system = await createFakeTelegramCallingSystem();
      try {
        await system.ingest(text);
        expect(system.replies).toEqual(["Use /call <reason> --confirm on one line to call your verified phone."]);
        expect(system.twilio.requests).toHaveLength(0);
        expect(await system.commands().authenticatedOrigin(system.accepted[0]!.eventId)).toBeNull();
      } finally { await system.cleanup(); }
    },
  );

  it("answers /call through the actual Worker with an explicit unconfigured reply until item one is composed", async () => {
    const system = await createFakeTelegramCallingSystem();
    const sent: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), { status: 200 });
    });
    try {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://worker.internal/telegram/webhook", { method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "webhook-secret-value" },
        body: JSON.stringify({ update_id: 20, message: { message_id: 920, from: { id: 12345 }, chat: { id: 44 },
          text: "/call check in --confirm" } }),
      // Reuse the public synthetic token from the provider's existing tests.
      }), { ...env, TELEGRAM_BOT_TOKEN: "8123456789:AAHrandomlookingsecretvaluethatislongenough",
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value" }, ctx);
      expect(response.status).toBe(200);
      await waitOnExecutionContext(ctx);
      expect(sent).toEqual([expect.objectContaining({ chat_id: "44", text: "Calling is not configured on this deployment." })]);
      expect(system.twilio.requests).toHaveLength(0);
    } finally { fetch.mockRestore(); await system.cleanup(); }
  });

  it("requires confirmation and dispatches one immutable owner call across replay and command reconstruction", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      expect((await system.ingest("/call check in")).status).toBe(200);
      expect(system.replies).toEqual(["To confirm, send the same /call command with --confirm at the end. It will call your verified phone."]);
      expect(system.twilio.requests).toHaveLength(0);
      expect((await system.ingest("/call check in --confirm", { updateId: 2, messageId: 901 })).status).toBe(200);
      const accepted = system.accepted[1];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      const command = await system.commands().commandFor(accepted);
      expect(Object.isFrozen(command)).toBe(true);
      expect(command).toEqual({ commandId: accepted.eventId, principalId: "principal:owner", purposeCode: "user_requested",
        destinationIdentityId: "identity:voice", urgency: "normal", authorizationExpiresAt: "2026-08-30T12:05:00.000Z",
        idempotencyKey: "telegram-call:44:901", issuedBy: "telegram_call_command" });
      expect(system.twilio.requests).toHaveLength(1);
      expect(system.twilio.requests[0]).toMatchObject({ commandId: command.commandId, toE164: system.destination });
      expect(system.replies.at(-1)).toBe("Call request accepted for your verified phone.");
      await system.ingest("/call check in --confirm", { updateId: 2, messageId: 901 });
      expect(system.accepted).toHaveLength(2);
      system.setNow("2026-08-30T12:01:00.000Z");
      expect(await system.commands().commandFor(accepted)).toEqual(command);
      await system.commands().request(accepted, { policy: system.policy, dispatcher: system.dispatcher });
      expect(system.twilio.requests).toHaveLength(1);
      await expect(system.commands().authenticatedOrigin(command.commandId)).resolves.toEqual({ principalId: "principal:owner",
        issuedBy: "telegram_call_command", commandHash: await sha256Hex(canonicalJson(command)) });
    } finally { await system.cleanup(); }
  });

  it.each(["", "--confirm", "--unsafe --confirm", "check in --confirm later", "check in --confirm\ndo not call",
    "check in\nmore --confirm", "check in\u2028more --confirm", `${"a".repeat(246)} --confirm extra`, `${"a".repeat(257)} --confirm`])(
    "refuses an incomplete or ambiguous call argument %j without dialing", async (argument) => {
      const system = await createFakeTelegramCallingSystem();
      try {
        await system.ingest(`/call ${argument}`);
        expect(system.twilio.requests).toHaveLength(0);
        expect(system.replies).toEqual(["Use /call <reason> --confirm on one line to call your verified phone."]);
      } finally { await system.cleanup(); }
    },
  );

  it("refuses an authenticated guest before outbound policy or provider work", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { callerId: 54321 });
      expect(system.accepted[0]?.principalId).toBe("principal:telegram-guest");
      expect(system.replies).toEqual(["Only the owner can request a call."]);
      expect(system.twilio.requests).toHaveLength(0);
      const accepted = system.accepted[0];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      await expect(system.commands().authenticatedOrigin(accepted.eventId)).resolves.toBeNull();
      await expect(env.DB.prepare("SELECT count(*) AS count FROM policy_decisions WHERE decision_id = ?")
        .bind(accepted.eventId).first()).resolves.toEqual({ count: 0 });
    } finally { await system.cleanup(); }
  });

  it("rejects an invalid webhook secret and an unknown sender without producing a call origin", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      expect((await system.ingest("/call check in --confirm", { secret: "wrong-fixture-value" })).status).toBe(401);
      await system.ingest("/call check in --confirm", { callerId: 45678 });
      expect(system.accepted).toHaveLength(0);
      expect(system.replies).toHaveLength(0);
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("rechecks current Telegram ownership without rewriting who authenticated the original event", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { execute: false });
      const owner = system.accepted[0];
      if (owner === undefined) throw new Error("fixture_accepted_missing");
      expect(await system.commands().authenticatedOrigin(owner.eventId)).not.toBeNull();
      await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:telegram-owner'").run();
      await expect(system.commands().authenticatedOrigin(owner.eventId)).resolves.toBeNull();
      await system.ingest("/call check in --confirm", { callerId: 54321, updateId: 2, messageId: 901, execute: false });
      const guest = system.accepted[1];
      if (guest === undefined) throw new Error("fixture_accepted_missing");
      await env.DB.prepare("UPDATE channel_identities SET principal_id = 'principal:owner' WHERE identity_id = 'identity:telegram-guest'").run();
      await expect(system.commands().authenticatedOrigin(guest.eventId)).resolves.toBeNull();
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("denies command-field substitution through the real policy engine", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      for (const [index, replacement] of [{ destinationIdentityId: "identity:other" }, { principalId: "principal:telegram-guest" },
        { authorizationExpiresAt: "2026-08-30T12:10:00.000Z" }].entries()) {
        await system.ingest("/call check in --confirm", { execute: false, updateId: index + 1, messageId: 900 + index });
        const accepted = system.accepted[index];
        if (accepted === undefined) throw new Error("fixture_accepted_missing");
        const command = await system.commands().commandFor(accepted);
        await expect(system.policy.evaluateOutboundCall({ ...command, ...replacement }))
          .resolves.toEqual({ decision: "deny", reason: "invalid_origin" });
      }
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("expires the original confirmation without extending it when the command service is rebuilt", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { execute: false });
      const accepted = system.accepted[0];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      const command = await system.commands().commandFor(accepted);
      system.setNow("2026-08-30T12:05:00.000Z");
      expect(await system.commands().commandFor(accepted)).toEqual(command);
      await expect(system.policy.evaluateOutboundCall(command)).resolves.toEqual({ decision: "deny", reason: "authorization_expired" });
      expect(await system.commands().request(accepted, { policy: system.policy, dispatcher: system.dispatcher }))
        .toBe("The call request was refused by the calling policy.");
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("refuses a configured destination that is not the persisted owner voice identity", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { execute: false });
      const accepted = system.accepted[0];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      const commands = new D1TelegramCallCommands({ database: env.DB, ownerPrincipalId: "principal:owner",
        ownerVoiceIdentityId: "identity:telegram-guest", botUsername: "jarvis_sid_bot" });
      await expect(commands.authenticatedOrigin(accepted.eventId)).resolves.toBeNull();
      expect(await commands.request(accepted, { policy: system.policy, dispatcher: system.dispatcher }))
        .toContain("original call authorization is unavailable");
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("stores Sid's six-digit chat id as it is and uses that stored form for both dispatch and origin", async () => {
    // Toward Sid nothing is redacted, so a six-digit chat id is no longer
    // rewritten; the stored and dispatched representations still agree.
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { chatId: 123456 });
      const accepted = system.accepted[0];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      const command = await system.commands().commandFor(accepted);
      expect(command.idempotencyKey).toContain(String(accepted.chatId));
      expect(system.twilio.requests).toHaveLength(1);
      expect(await system.commands().authenticatedOrigin(command.commandId)).toMatchObject({
        commandHash: await sha256Hex(canonicalJson(command)),
      });
    } finally { await system.cleanup(); }
  });

  it.each([
    ["missing ingress receipt", "DELETE FROM idempotency_records WHERE event_sequence = (SELECT sequence FROM events WHERE event_id = ?)"],
    ["wrong receipt scope", "UPDATE idempotency_records SET scope = 'fixture.not_ingress' WHERE event_sequence = (SELECT sequence FROM events WHERE event_id = ?)"],
    ["wrong update binding", "UPDATE idempotency_records SET key = 'fixture.wrong_update' WHERE event_sequence = (SELECT sequence FROM events WHERE event_id = ?)"],
    ["mismatched content hash", `UPDATE events SET content_hash = '${"e".repeat(64)}' WHERE event_id = ?`],
    ["mismatched source column", "UPDATE events SET source = 'fixture:untrusted' WHERE event_id = ?"],
    ["malformed envelope", "UPDATE events SET envelope_json = '{}' WHERE event_id = ?"],
  ])("refuses a call origin with %s", async (_name, sql) => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/call check in --confirm", { execute: false });
      const accepted = system.accepted[0];
      if (accepted === undefined || sql === undefined) throw new Error("fixture_accepted_missing");
      expect(await system.commands().authenticatedOrigin(accepted.eventId)).not.toBeNull();
      await env.DB.prepare(sql).bind(accepted.eventId).run();
      await expect(system.commands().authenticatedOrigin(accepted.eventId)).resolves.toBeNull();
      expect(system.twilio.requests).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it.each(["event type", "source", "producer", "receipt-time principal", "empty principal binding", "legacy payload"])(
    "refuses a valid envelope with an untrusted %s", async (field) => {
      const system = await createFakeTelegramCallingSystem();
      try {
        await system.ingest("/call check in --confirm", { execute: false });
        const accepted = system.accepted[0];
        if (accepted === undefined) throw new Error("fixture_accepted_missing");
        const row = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_id = ?")
          .bind(accepted.eventId).first<{ envelope_json: string }>();
        if (row === null) throw new Error("fixture_event_missing");
        const envelope = JSON.parse(row.envelope_json);
        if (field === "event type") envelope.eventType = "fixture.unverified";
        if (field === "source") envelope.source = "fixture:unverified";
        if (field === "producer") envelope.producerVersion = "fixture@0.0.0";
        if (field === "receipt-time principal") envelope.payload.principalBinding[0] ^= 1;
        if (field === "empty principal binding") envelope.payload.principalBinding = [];
        if (field === "legacy payload") delete envelope.payload.principalBinding;
        envelope.contentHash = await sha256Hex(canonicalJson(envelope.payload));
        await env.DB.prepare("UPDATE events SET event_type = ?, source = ?, content_hash = ?, envelope_json = ? WHERE event_id = ?")
          .bind(envelope.eventType, envelope.source, envelope.contentHash, canonicalJson(envelope), accepted.eventId).run();
        await expect(system.commands().authenticatedOrigin(accepted.eventId)).resolves.toBeNull();
        expect(system.twilio.requests).toHaveLength(0);
      } finally { await system.cleanup(); }
    },
  );

  it("reports an uncertain provider outcome without dialing twice or exposing private error text", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      system.twilio.acceptAndLoseNextResponse();
      await system.ingest("/call check in --confirm");
      const accepted = system.accepted[0];
      if (accepted === undefined) throw new Error("fixture_accepted_missing");
      expect(system.replies).toEqual(["Call acknowledgement is pending. Check your phone before sending another request."]);
      await system.commands().request(accepted, { policy: system.policy, dispatcher: system.dispatcher });
      expect(system.twilio.requests).toHaveLength(1);
      const reply = await system.commands().request(accepted, { dispatcher: system.dispatcher,
        policy: { evaluateOutboundCall: async () => { throw new Error("private fixture provider body"); } } });
      expect(reply).toBe("Could not confirm whether the call was placed. Check your phone before trying again.");
      expect(reply).not.toContain("private fixture");
    } finally { await system.cleanup(); }
  });
});
