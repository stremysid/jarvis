import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../../apps/cloud-gateway/src/index.js";
import { createFakeTelegramCallingSystem } from "./voice-telegram-system.js";

describe("Telegram owner call step-up disable", () => {
  it("executes the accepted disable command through the production Worker route", async () => {
    const system = await createFakeTelegramCallingSystem();
    const sent: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), { status: 200 });
    });
    try {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://worker.internal/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret-value",
        },
        body: JSON.stringify({ update_id: 80, message: {
           message_id: 980, from: { id: 12345 }, chat: { id: 12345 }, text: "/disable-owner-step-up --confirm",
        } }),
      }), {
        ...env,
        OWNER_PRINCIPAL_ID: "principal:owner",
        OWNER_VOICE_IDENTITY_ID: "identity:voice",
        TELEGRAM_BOT_TOKEN: "8123456789:AAHrandomlookingsecretvaluethatislongenough",
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
      }, ctx);
      expect(response.status).toBe(200);
      await waitOnExecutionContext(ctx);
      expect(sent).toEqual([expect.objectContaining({
        chat_id: "12345",
        text: "Owner call step-up disabled. A new device-signed CLI generate is required to re-enable it.",
      })]);
      expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "disabled" });
    } finally { fetch.mockRestore(); await system.cleanup(); }
  });

  it("binds the exact accepted owner event and commits the disable once", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/disable-owner-step-up --confirm", { chatId: 12345 });
      expect(system.replies).toEqual([
        "Owner call step-up disabled. A new device-signed CLI generate is required to re-enable it.",
      ]);
      expect(await env.DB.prepare(
        "SELECT verifier_version, status FROM owner_passphrase_heads WHERE singleton_id = 1",
      ).first()).toEqual({ verifier_version: 1, status: "disabled" });
      expect(await env.DB.prepare(
        "SELECT authorization_event_id FROM owner_passphrase_disable_commits",
      ).first()).toEqual({ authorization_event_id: system.accepted[0]?.eventId });

      await system.ingest("/disable-owner-step-up --confirm", { updateId: 2, messageId: 901, chatId: 12345 });
      expect(system.replies.at(-1)).toBe(
        "Owner call step-up is already disabled. A new device-signed CLI generate is required to re-enable it.",
      );
      expect(await env.DB.prepare("SELECT count(*) AS count FROM owner_passphrase_disable_commits").first())
        .toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  });

  it.each(["", "--confirm later", "--confirm\ndo not disable"])(
    "refuses ambiguous confirmation %j without changing the passphrase head",
    async (argument) => {
      const system = await createFakeTelegramCallingSystem();
      try {
        await system.ingest(`/disable-owner-step-up ${argument}`);
        expect(system.replies).toEqual([
          "Use /disable-owner-step-up --confirm exactly to disable spoken owner-call step-up.",
        ]);
        expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "active" });
        expect(await env.DB.prepare("SELECT count(*) AS count FROM owner_passphrase_disable_commits").first())
          .toEqual({ count: 0 });
      } finally { await system.cleanup(); }
    },
  );

  it.each([
    "/Disable-Owner-Step-Up --confirm",
    "/disable-owner-step-up@jarvis_sid_bot --confirm",
    "/DISABLE-OWNER-STEP-UP@Jarvis_Sid_Bot --confirm",
    "/disable-owner-step-up@OtherBot --confirm",
    "/disable-owner-step-up--confirm",
    "/disable-owner-stepup --confirm",
    "/disable\u2011owner\u2011step\u2011up --confirm",
  ])("returns fixed usage for %s without invoking a model", async (text) => {
    const system = await createFakeTelegramCallingSystem();
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 904 } }), { status: 200 });
    });
    try {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://worker.internal/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret-value",
        },
        body: JSON.stringify({ update_id: 81, message: {
          message_id: 981, from: { id: 12345 }, chat: { id: 12345 }, text,
        } }),
      }), {
        ...env,
        OWNER_PRINCIPAL_ID: "principal:owner",
        OWNER_VOICE_IDENTITY_ID: "identity:voice",
        TELEGRAM_BOT_TOKEN: "8123456789:AAHrandomlookingsecretvaluethatislongenough",
        TELEGRAM_BOT_USERNAME: "jarvis_sid_bot",
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
      }, ctx);
      expect(response.status).toBe(200);
      await waitOnExecutionContext(ctx);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("api.telegram.org");
      expect(bodies).toEqual([expect.objectContaining({
        chat_id: "12345",
        text: "Use /disable-owner-step-up --confirm exactly to disable spoken owner-call step-up.",
      })]);
      expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "active" });
    } finally { fetch.mockRestore(); await system.cleanup(); }
  });

  it("refuses an exact disable command outside the owner's private chat", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/disable-owner-step-up --confirm", { chatId: -10012345 });
      expect(system.replies).toEqual([
        "Use /disable-owner-step-up --confirm in your private chat with Jarvis.",
      ]);
      expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "active" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM owner_passphrase_disable_commits").first())
        .toEqual({ count: 0 });
    } finally { await system.cleanup(); }
  });

  it("sends a group disable refusal only to the owner's private chat", async () => {
    const system = await createFakeTelegramCallingSystem();
    const sent: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 905 } }), { status: 200 });
    });
    try {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://worker.internal/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret-value",
        },
        body: JSON.stringify({ update_id: 82, message: {
          message_id: 982, from: { id: 12345 }, chat: { id: -10012345 },
          text: "/disable-owner-step-up --confirm",
        } }),
      }), {
        ...env,
        OWNER_PRINCIPAL_ID: "principal:owner",
        OWNER_VOICE_IDENTITY_ID: "identity:voice",
        TELEGRAM_BOT_TOKEN: "8123456789:AAHrandomlookingsecretvaluethatislongenough",
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
      }, ctx);
      expect(response.status).toBe(200);
      await waitOnExecutionContext(ctx);
      expect(sent).toEqual([expect.objectContaining({
        chat_id: "12345",
        text: "Use /disable-owner-step-up --confirm in your private chat with Jarvis.",
      })]);
      expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "active" });
    } finally { fetch.mockRestore(); await system.cleanup(); }
  });

  it("refuses an authenticated guest through the migration-backed owner binding", async () => {
    const system = await createFakeTelegramCallingSystem();
    try {
      await system.ingest("/disable-owner-step-up --confirm", { callerId: 54321, chatId: 54321 });
      expect(system.replies).toEqual([
        "Owner call step-up could not be disabled. Its current state is unchanged or could not be confirmed.",
      ]);
      expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first()).toEqual({ status: "active" });
    } finally { await system.cleanup(); }
  });
});
