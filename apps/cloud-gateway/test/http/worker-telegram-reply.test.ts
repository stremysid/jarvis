import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import worker, {
  TelegramReplyFailure,
  telegramReplyFailureReason,
} from "../../src/index.js";
import {
  applyFoundationMigration,
  clearConversationDataForTest,
} from "../persistence/migration.js";

const SECRET = "webhook-secret-value";
const BOT_TOKEN = "8123456789:AAHrandomlookingsecretvaluethatislongenough";

async function clearData(): Promise<void> {
  await clearConversationDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM principals"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
  ]);
}

async function seedOwner(): Promise<void> {
  const timestamp = "2026-09-16T16:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'owner', ?1, ?2)`).bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES ('identity:telegram', 'principal:owner', 'telegram', '44112233', 'active', ?1, ?2)`).bind(timestamp, timestamp),
  ]);
}

function modelResponse(text = "Hello."): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
      ));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function request(): Request {
  return new Request("https://worker.internal/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify({
      update_id: 72001,
      message: {
        message_id: 17,
        from: { id: 44112233 },
        chat: { id: 44112233 },
        text: "hi",
      },
    }),
  });
}

describe("live Telegram reply composition", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seedOwner();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await clearData();
  });

  it("constructs the live DeepSeek adapter with Telegram thinking disabled by default", async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(Object.freeze({ url, init }));
      if (url.endsWith("/chat/completions")) return modelResponse();
      if (url.endsWith("/sendChatAction")) return Response.json({ ok: true, result: true });
      if (url.endsWith("/sendMessage")) {
        return Response.json({ ok: true, result: { message_id: 99 } });
      }
      throw new Error("unexpected_fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcomeLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const waits: Promise<unknown>[] = [];
    const response = await (worker.fetch as unknown as (
      candidate: Request,
      environment: Partial<Env>,
      context: { waitUntil(promise: Promise<unknown>): void },
    ) => Promise<Response>)(request(), {
      DB: env.DB,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      DEEPSEEK_API_KEY: "synthetic-model-key",
    }, {
      waitUntil(promise) { waits.push(promise); },
    });
    expect(response.status).toBe(200);
    await Promise.all(waits);

    const modelRequests = requests.filter(({ url }) => url.endsWith("/chat/completions"));
    expect(modelRequests).toHaveLength(1);
    expect(JSON.parse(modelRequests[0]!.init?.body as string)).toMatchObject({
      thinking: { type: "disabled" },
    });
    const outcome = outcomeLog.mock.calls.find(([event]) => event === "telegram_turn_outcome")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(outcome).toMatchObject({
      stagingMs: expect.any(Number),
      telegramSendMs: expect.any(Number),
      settlementMs: expect.any(Number),
    });
    expect(Number.isInteger(outcome?.stagingMs)).toBe(true);
    expect(Number.isInteger(outcome?.telegramSendMs)).toBe(true);
    expect(Number.isInteger(outcome?.settlementMs)).toBe(true);
  });

  it("applies the final action-claim gate to an owner's ordinary Telegram reply", async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(Object.freeze({ url, init }));
      if (url.endsWith("/chat/completions")) {
        return modelResponse("Pai's phone number is 416-555-0100. Booked a table there for 7pm.");
      }
      if (url.endsWith("/sendChatAction")) return Response.json({ ok: true, result: true });
      if (url.endsWith("/sendMessage")) return Response.json({ ok: true, result: { message_id: 99 } });
      throw new Error("unexpected_fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const waits: Promise<unknown>[] = [];
    const response = await (worker.fetch as unknown as (
      candidate: Request,
      environment: Partial<Env>,
      context: { waitUntil(promise: Promise<unknown>): void },
    ) => Promise<Response>)(request(), {
      DB: env.DB,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      DEEPSEEK_API_KEY: "synthetic-model-key",
      OWNER_PRINCIPAL_ID: "principal:owner",
    }, {
      waitUntil(promise) { waits.push(promise); },
    });
    expect(response.status).toBe(200);
    await Promise.all(waits);

    const sent = requests.find(({ url }) => url.endsWith("/sendMessage"));
    const body = JSON.parse(sent?.init?.body as string) as Record<string, unknown>;
    expect(body.text).toContain("Pai's phone number is 416-555-0100.");
    expect(body.text).toContain("I can't send messages");
    expect(body.text).not.toContain("Booked a table");
  });

  it("logs only fixed outer reply failure reasons without exception text", async () => {
    for (const reason of ["identity_lookup", "d1", "dispatcher"] as const) {
      expect(telegramReplyFailureReason(new TelegramReplyFailure(reason))).toBe(reason);
    }
    expect(telegramReplyFailureReason(new Error("private database response"))).toBe("other");

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];
    const response = await (worker.fetch as unknown as (
      candidate: Request,
      environment: Partial<Env>,
      context: { waitUntil(promise: Promise<unknown>): void },
    ) => Promise<Response>)(request(), {
      DB: env.DB,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "private-invalid-token",
      DEEPSEEK_API_KEY: "synthetic-model-key",
    }, {
      waitUntil(promise) { waits.push(promise); },
    });
    expect(response.status).toBe(200);
    await Promise.all(waits);

    expect(errorLog).toHaveBeenCalledWith("telegram_reply_failed", {
      eventId: expect.any(String),
      reason: "other",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-invalid-token");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("database response");
  });
});
