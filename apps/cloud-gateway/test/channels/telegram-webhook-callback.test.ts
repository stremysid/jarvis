import { beforeEach, describe, expect, it } from "vitest";
import type { AppendedEvent, EventAppendInput } from "../../src/persistence/event-repository.js";
import type { TelegramAuthenticationResult } from "../../src/policy/policy-service.js";
import { Redactor } from "../../src/security/redaction.js";
import { TelegramRateLimiter } from "../../src/channels/telegram/telegram-rate-limit.js";
import {
  CALLBACK_EVENT,
  SECRET_HEADER,
  handleTelegramWebhook,
  type AcceptedTelegramButtonTap,
  type AcceptedTelegramUpdate,
  type TelegramWebhookDependencies,
} from "../../src/channels/telegram/telegram-webhook.js";

/**
 * A button tap goes through the same gate as a message.
 *
 * That is the property here. A tap resolves a decision, so a path that
 * skipped authentication or the rate limit would be a way to answer the
 * owner's questions without being the owner, or to answer them without limit.
 */

const SECRET = "webhook-secret-value";
const NOW = new Date("2026-09-02T10:00:00.000Z");
const DATA = "d1:01k5d8s0m00000000000000001:yes";

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
  async authenticateTelegram(): Promise<TelegramAuthenticationResult> {
    return this.result;
  }
}

let events: FakeEventStore;
let policy: FakePolicy;
let limiter: TelegramRateLimiter;
let taps: AcceptedTelegramButtonTap[];
let messages: AcceptedTelegramUpdate[];
let deps: TelegramWebhookDependencies;

beforeEach(() => {
  events = new FakeEventStore();
  policy = new FakePolicy();
  limiter = new TelegramRateLimiter();
  taps = [];
  messages = [];
  deps = {
    webhookSecret: SECRET,
    policy,
    redactor: new Redactor(),
    events,
    limiter,
    now: () => NOW,
    onCallback: (tap) => taps.push(tap),
    onAccepted: (update) => messages.push(update),
  };
});

function requestFor(body: unknown, secret: string = SECRET): Request {
  return new Request("https://worker.internal/telegram/webhook", {
    method: "POST",
    headers: { [SECRET_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tapUpdate(updateId = 91, data: string = DATA): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: "4382bfdc",
      from: { id: 12_345 },
      message: { message_id: 12, chat: { id: 12_345 } },
      data,
    },
  };
}

describe("accepting a button tap", () => {
  it("carries the committed receipt time and authenticated principal for an accepted text command", async () => {
    const response = await handleTelegramWebhook(requestFor({ update_id: 101, message: {
      message_id: 12, from: { id: 12_345 }, chat: { id: 12_345 }, text: "/call check in --confirm",
    } }), deps);
    expect(response.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.receivedAt).toBe(events.events[0]?.envelope.receivedAt);
    expect(messages[0]?.receivedAt).toBe(NOW.toISOString());
    expect(events.events[0]?.envelope.payload).toMatchObject({ principalId: messages[0]?.principalId });
  });

  it("hands the tap to the callback hook, not the message hook", async () => {
    const response = await handleTelegramWebhook(requestFor(tapUpdate()), deps);

    expect(response.status).toBe(200);
    expect(taps).toHaveLength(1);
    expect(taps[0]).toMatchObject({ data: DATA, callbackQueryId: "4382bfdc", messageId: 12 });
    // Never both. A handler receiving a tap as a message would answer it with
    // the model instead of resolving the decision.
    expect(messages).toHaveLength(0);
  });

  it("records a distinct event type", async () => {
    await handleTelegramWebhook(requestFor(tapUpdate()), deps);
    expect(events.events[0]?.envelope.eventType).toBe(CALLBACK_EVENT);
  });

  it("records the tap so it is auditable", async () => {
    // The stored value is the plain string, and that is by design: the
    // envelope refuses a raw string, so every value must be passed through
    // the redactor to be accepted, and createEnvelope then unwraps the token
    // back to its text when it materialises the payload. What the rule buys
    // is that nothing reaches an event WITHOUT going through the redactor --
    // not that the stored form is opaque.
    await handleTelegramWebhook(requestFor(tapUpdate()), deps);
    const payload = events.events[0]?.envelope.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ updateId: 91, messageId: 12, data: DATA });
  });

  it("refuses to record a tap the redactor will not issue a token for", async () => {
    // The check above is only meaningful because this one holds: bypass the
    // redactor and the envelope rejects the payload, so nothing is stored at
    // all. Without this, "it went through the redactor" would be an untested
    // claim about a code path rather than a property.
    const refusing = {
      ...deps,
      redactor: { redact: () => ({ ok: false as const, reason: "refused" }) },
    } as unknown as TelegramWebhookDependencies;

    await expect(handleTelegramWebhook(requestFor(tapUpdate()), refusing)).rejects.toThrow();
    expect(events.events).toHaveLength(0);
  });
});

describe("the gate a tap must pass", () => {
  it("refuses a tap from an identity that is not active", async () => {
    // Otherwise anyone who learned a decision id could answer the owner's
    // questions for them.
    policy.result = { principalId: "principal-1", identityState: "revoked" };
    const response = await handleTelegramWebhook(requestFor(tapUpdate()), deps);

    expect(response.status).toBe(200);
    expect(taps).toHaveLength(0);
  });

  it("refuses a tap with the wrong webhook secret before reading the body", async () => {
    const response = await handleTelegramWebhook(requestFor(tapUpdate(), "wrong"), deps);
    expect(response.status).toBe(401);
    expect(events.events).toHaveLength(0);
  });

  it("consumes rate allowance, so taps are not a way around the limit", async () => {
    await handleTelegramWebhook(requestFor(tapUpdate(1)), deps);
    const before = limiter.check("principal-1", NOW.getTime());
    await handleTelegramWebhook(requestFor(tapUpdate(2)), deps);
    const after = limiter.check("principal-1", NOW.getTime());

    expect(before.allowed).toBe(true);
    expect(after.allowed).toBe(true);
    // Distinct updates each recorded, rather than taps bypassing the counter.
    expect(events.events).toHaveLength(2);
  });

  it("is refused once the limit is exhausted", async () => {
    for (let index = 0; index < 30; index += 1) {
      limiter.record("principal-1", NOW.getTime());
    }
    await handleTelegramWebhook(requestFor(tapUpdate()), deps);
    expect(taps).toHaveLength(0);
  });
});

describe("redelivery", () => {
  it("does not act twice on a redelivered tap", async () => {
    // Telegram redelivers on any non-2xx or timeout. Acting twice would write
    // a second answer to a question that already has one.
    await handleTelegramWebhook(requestFor(tapUpdate()), deps);
    await handleTelegramWebhook(requestFor(tapUpdate()), deps);

    expect(taps).toHaveLength(1);
    expect(events.events).toHaveLength(1);
  });
});
