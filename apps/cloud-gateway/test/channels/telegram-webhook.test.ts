import { beforeEach, describe, expect, it } from "vitest";
import type { AppendedEvent, EventAppendInput } from "../../src/persistence/event-repository.js";
import type { TelegramAuthenticationResult } from "../../src/policy/policy-service.js";
import { Redactor } from "../../src/security/redaction.js";
import { TelegramRateLimiter } from "../../src/channels/telegram/telegram-rate-limit.js";
import {
  ACCEPTED_EVENT,
  REJECTED_EVENT,
  SECRET_HEADER,
  handleTelegramWebhook,
  secretsMatch,
  type TelegramWebhookDependencies,
} from "../../src/channels/telegram/telegram-webhook.js";

const SECRET = "webhook-secret-value";
const NOW = new Date("2026-09-02T10:00:00.000Z");

class FakeEventStore {
  readonly events: EventAppendInput[] = [];
  private readonly byKey = new Map<string, AppendedEvent>();

  async append(input: EventAppendInput): Promise<AppendedEvent> {
    const key = `${input.scope}:${input.key}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return { ...existing, replayed: true };
    this.events.push(input);
    const appended: AppendedEvent = {
      eventSequence: this.events.length,
      envelope: input.envelope,
      replayed: false,
    };
    this.byKey.set(key, appended);
    return appended;
  }
}

class FakePolicy {
  result: TelegramAuthenticationResult = { principalId: "principal-1", identityState: "active" };
  readonly calls: unknown[] = [];

  async authenticateTelegram(input: unknown): Promise<TelegramAuthenticationResult> {
    this.calls.push(input);
    return this.result;
  }
}

let events: FakeEventStore;
let policy: FakePolicy;
let limiter: TelegramRateLimiter;
let deps: TelegramWebhookDependencies;

beforeEach(() => {
  events = new FakeEventStore();
  policy = new FakePolicy();
  limiter = new TelegramRateLimiter();
  deps = {
    webhookSecret: SECRET,
    policy,
    // Production's wiring: the configured owner gets Sid's reader, everyone
    // else the external one.
    redactor: new Redactor("external"),
    owner: { principalId: "principal-1", redactor: new Redactor("owner") },
    events,
    limiter,
    now: () => NOW,
  };
});

function requestFor(body: unknown, secret: string = SECRET): Request {
  return new Request("https://worker.internal/telegram/webhook", {
    method: "POST",
    headers: { [SECRET_HEADER]: secret, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function textUpdate(text: string, updateId = 31): unknown {
  return {
    update_id: updateId,
    message: { message_id: 5, from: { id: 12345 }, chat: { id: 12345 }, text },
  };
}

function photoUpdate(updateId = 71): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 9,
      from: { id: 12345 },
      chat: { id: 12345 },
      photo: [{ file_id: "AgACAgQAAx", file_unique_id: "AQADr", width: 90, height: 90 }],
      caption: "my passport photo",
    },
  };
}

describe("Telegram webhook", () => {
  it("persists one redacted text event for an active allowlisted user", async () => {
    const response = await handleTelegramWebhook(requestFor(textUpdate("hello")), deps);

    expect(response.status).toBe(200);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.envelope.eventType).toBe(ACCEPTED_EVENT);
  });

  it("stores exactly what the redactor issued, not the request body", async () => {
    // createEnvelope unwraps an issued token to its sanitized text, so the
    // stored value is a string. The guarantee is not that it looks different
    // -- clean text survives unchanged -- but that it can only have arrived
    // via the redactor, which the next test pins down.
    const redactor = new Redactor("owner");
    await handleTelegramWebhook(requestFor(textUpdate("my plaintext message")), deps);

    const payload = events.events[0]!.envelope.payload as Record<string, unknown>;
    const issued = redactor.redact({ text: "my plaintext message", channel: "telegram", field: "text" });
    expect(payload.text).toBe((issued as { text: string }).text);
  });

  it("cannot persist a payload string that did not come from the redactor", async () => {
    // The structural guarantee: the envelope refuses raw text outright, so no
    // ingress path can persist unredacted content even by mistake.
    const { createEnvelope, newUlid } = await import("../../../../packages/contracts/src/index.js");
    await expect(
      createEnvelope({
        schemaVersion: "1.0",
        eventId: newUlid(NOW),
        eventType: ACCEPTED_EVENT,
        source: "channel:telegram",
        subjectId: "telegram:user:1",
        occurredAt: "2026-09-02T10:00:00.000Z",
        receivedAt: "2026-09-02T10:00:00.000Z",
        correlationId: newUlid(NOW),
        contentType: "application/json",
        payload: { text: "raw unredacted text" } as never,
        producerVersion: "test",
      }),
    ).rejects.toThrow("issued redaction token");
  });

  it("persists only minimal rejection fields for unsupported media", async () => {
    const response = await handleTelegramWebhook(requestFor(photoUpdate()), deps);

    expect(response.status).toBe(200);
    expect(events.events[0]!.envelope.eventType).toBe(REJECTED_EVENT);
    expect(events.events[0]!.envelope.payload).toEqual({ updateId: 71, reason: "unsupported_content" });
    expect(JSON.stringify(events.events[0])).not.toMatch(/file_id|caption|photo|document|passport/);
  });

  it("returns the same rejection for a duplicate update id and stores one event", async () => {
    await handleTelegramWebhook(requestFor(photoUpdate()), deps);
    const duplicate = await handleTelegramWebhook(requestFor(photoUpdate()), deps);

    expect(await duplicate.text()).toBe("Jarvis accepts text messages only.");
    expect(events.events).toHaveLength(1);
  });

  it("rejects a wrong secret with 401 and stores nothing", async () => {
    const response = await handleTelegramWebhook(requestFor(textUpdate("hi"), "x"), deps);

    expect(response.status).toBe(401);
    expect(events.events).toHaveLength(0);
  });

  it("checks the secret before authenticating or parsing", async () => {
    await handleTelegramWebhook(requestFor("not json at all", "wrong"), deps);
    expect(policy.calls).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });

  it("compares secrets in length-safe fashion", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch("", SECRET)).toBe(false);
    expect(secretsMatch(`${SECRET}extra`, SECRET)).toBe(false);
    expect(secretsMatch(SECRET.slice(0, -1), SECRET)).toBe(false);
  });

  it("refuses an unallowlisted sender with the neutral reply", async () => {
    policy.result = { principalId: "", identityState: "blocked" };

    const response = await handleTelegramWebhook(requestFor(textUpdate("hello")), deps);

    // Identical wording to unsupported content: a stranger must not learn that
    // they are specifically not allowlisted.
    expect(await response.text()).toBe("Jarvis accepts text messages only.");
    expect(events.events[0]!.envelope.payload).toEqual({ updateId: 31, reason: "unauthorized" });
  });

  it("enforces 30 accepted messages per minute", async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await handleTelegramWebhook(requestFor(textUpdate("ok", 100 + index)), deps);
      expect(response.status).toBe(200);
    }
    await handleTelegramWebhook(requestFor(textUpdate("31st", 999)), deps);

    expect(events.events.at(-1)!.envelope.payload).toEqual({ updateId: 999, reason: "rate_limited" });
  });

  it("does not spend rate allowance on a rejected update", async () => {
    // Otherwise a sender could exhaust the budget with content never ingested.
    for (let index = 0; index < 40; index += 1) {
      await handleTelegramWebhook(requestFor(photoUpdate(200 + index)), deps);
    }
    const response = await handleTelegramWebhook(requestFor(textUpdate("still allowed", 500)), deps);

    expect(response.status).toBe(200);
    expect(events.events.at(-1)!.envelope.eventType).toBe(ACCEPTED_EVENT);
  });

  it("does not spend rate allowance twice on a redelivered update", async () => {
    const limited: TelegramWebhookDependencies = { ...deps, limiter: new TelegramRateLimiter(2, 100) };
    await handleTelegramWebhook(requestFor(textUpdate("a", 1)), limited);
    await handleTelegramWebhook(requestFor(textUpdate("a", 1)), limited); // redelivery
    const third = await handleTelegramWebhook(requestFor(textUpdate("b", 2)), limited);

    expect(third.status).toBe(200);
    expect(events.events.at(-1)!.envelope.eventType).toBe(ACCEPTED_EVENT);
  });

  it("treats an unparseable body as malformed rather than throwing", async () => {
    const response = await handleTelegramWebhook(requestFor("{not json"), deps);

    expect(response.status).toBe(200);
    expect(events.events[0]!.envelope.payload).toEqual({ updateId: 0, reason: "malformed" });
  });

  it("never answers a refused message with a non-2xx status", async () => {
    // Telegram retries non-2xx, so an error here would loop forever.
    for (const body of [photoUpdate(), textUpdate("x", 2), "{bad"]) {
      const response = await handleTelegramWebhook(requestFor(body), deps);
      expect(response.status).toBe(200);
    }
  });

  it("keys idempotency by update id within the telegram scope", async () => {
    await handleTelegramWebhook(requestFor(textUpdate("hello", 77)), deps);
    expect(events.events[0]!.scope).toBe("telegram.update");
    expect(events.events[0]!.key).toBe("77");
  });
});

describe("who reads a Telegram message, by authenticated principal", () => {
  it("stores the configured owner's PIN as he typed it", async () => {
    await handleTelegramWebhook(requestFor(textUpdate("my pin is 4821")), deps);

    expect((events.events[0]!.envelope.payload as Record<string, unknown>).text).toBe("my pin is 4821");
  });

  it("redacts a verified Telegram identity that is not the configured owner, because the channel alone does not make the sender Sid", async () => {
    policy.result = { principalId: "principal-2", identityState: "active" };
    await handleTelegramWebhook(requestFor(textUpdate("my pin is 4821")), deps);

    expect(events.events[0]!.envelope.eventType).toBe(ACCEPTED_EVENT);
    expect((events.events[0]!.envelope.payload as Record<string, unknown>).text).toBe("my pin is [REDACTED_AUTH_DIGITS]");
  });

  it("redacts every sender when no owner is configured, the owner included", async () => {
    const { owner: _owner, ...withoutOwner } = deps;
    await handleTelegramWebhook(requestFor(textUpdate("my pin is 4821")), withoutOwner);

    expect((events.events[0]!.envelope.payload as Record<string, unknown>).text).toBe("my pin is [REDACTED_AUTH_DIGITS]");
  });
});
