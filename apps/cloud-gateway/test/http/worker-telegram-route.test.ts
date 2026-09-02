import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";

/**
 * Routing-level behaviour for the Telegram webhook.
 *
 * These cover the branches reachable before any database work: an
 * unconfigured channel, a wrong method, and a bad secret. All three must be
 * decided without touching D1, because each represents a caller who has not
 * yet proven they are Telegram.
 */

const SECRET = "webhook-secret-value";

function dispatch(request: Request, env: Partial<Env> = {}): Promise<Response> {
  const fetch = worker.fetch as unknown as (
    candidate: Request,
    environment: Partial<Env>,
  ) => Promise<Response>;
  return fetch(request, env);
}

function webhookRequest(secret: string | null, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("https://worker.internal/telegram/webhook", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify({ update_id: 1 }) } : {}),
  });
}

describe("Worker Telegram route", () => {
  it("reports the channel unavailable when no webhook secret is configured", async () => {
    const response = await dispatch(webhookRequest(SECRET), {});
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Channel not configured");
  });

  it("treats an empty secret as unconfigured rather than as a match", async () => {
    // A blank configured secret would compare equal to a blank presented one,
    // authenticating anyone who sends no header at all.
    const response = await dispatch(webhookRequest(null), { TELEGRAM_WEBHOOK_SECRET: "" });
    expect(response.status).toBe(503);
  });

  it("rejects a wrong secret with 401 before any database work", async () => {
    // No DB is provided in env, so reaching the handler's storage path at all
    // would throw rather than return 401.
    const response = await dispatch(webhookRequest("wrong"), { TELEGRAM_WEBHOOK_SECRET: SECRET });
    expect(response.status).toBe(401);
  });

  it("rejects a missing secret header with 401", async () => {
    const response = await dispatch(webhookRequest(null), { TELEGRAM_WEBHOOK_SECRET: SECRET });
    expect(response.status).toBe(401);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("refuses %s on the webhook path", async (method) => {
    const response = await dispatch(webhookRequest(SECRET, method), {
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    });
    expect(response.status).toBe(405);
  });

  it("leaves other routes unchanged", async () => {
    expect((await dispatch(new Request("https://worker.internal/health"))).status).toBe(501);
    expect((await dispatch(new Request("https://worker.internal/telegram"))).status).toBe(501);
  });

  it("does not shadow the voice namespace", async () => {
    const response = await dispatch(new Request("https://worker.internal/voice/inbound", { method: "POST" }));
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("unavailable");
  });
});
