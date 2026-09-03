/**
 * Telegram webhook ingress.
 *
 * Order is the security design and is not interchangeable:
 *
 * 1. Verify the webhook secret from the header, before the body is read.
 * 2. Classify the update. Text and button taps only; everything else is
 *    refused, and no attachment is accepted even alongside text.
 * 3. Authenticate the sender against the allowlist.
 * 4. Apply admission limits.
 * 5. Redact, then persist.
 *
 * Steps 3 and 4 are shared by both accepted kinds deliberately. A tap causes
 * the same work as a message and must not be a way around the allowance, and
 * giving each kind its own copy of those checks is how the two paths drift
 * apart later.
 *
 * Step 1 precedes parsing so an unauthenticated caller cannot make the worker
 * do work proportional to a body it supplied. Steps 3 and 4 follow
 * classification because a rejected update must consume neither an
 * authentication lookup nor rate allowance.
 *
 * Every path returns 200 with a fixed reply except a failed secret. Telegram
 * retries non-2xx responses, so returning an error for a message we have
 * deliberately refused would produce an unbounded retry loop.
 */

import { isIssuedRedaction, type RedactionResult } from "../../../../../packages/contracts/src/calls.js";
import {
  createEnvelope,
  newUlid,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../../packages/contracts/src/index.js";
import type { AppendedEvent, EventAppendInput } from "../../persistence/event-repository.js";
import type { TelegramAuthenticationResult } from "../../policy/policy-service.js";
import type { TelegramRateLimiter } from "./telegram-rate-limit.js";
import { buildRejectionPayload, rejectionReply } from "./telegram-rejection.js";
import { classifyTelegramUpdate, type TelegramRejectionReason } from "./telegram-types.js";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const ACCEPTED_EVENT = "telegram.update.received";
export const CALLBACK_EVENT = "telegram.callback.received";
export const REJECTED_EVENT = "telegram.message.rejected";
export const REDACTION_FAILED_EVENT = "ingest.redaction.failed";
export const IDEMPOTENCY_SCOPE = "telegram.update";
export const PRODUCER_VERSION = "cloud-gateway@0.1.0";

export interface TelegramWebhookDependencies {
  readonly webhookSecret: string;
  readonly policy: {
    authenticateTelegram(input: unknown): Promise<TelegramAuthenticationResult>;
  };
  readonly redactor: {
    redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult;
  };
  readonly events: { append(input: EventAppendInput): Promise<AppendedEvent> };
  readonly limiter: TelegramRateLimiter;
  readonly now?: () => Date;
  readonly ulid?: (now: Date) => Ulid;

  /**
   * Called once an update has been accepted AND durably stored.
   *
   * Deliberately not awaited. Answering means calling a model and then
   * Telegram, which can take tens of seconds; holding the webhook response
   * open that long invites Telegram to time out and redeliver, producing a
   * second reply to one message. The caller schedules the work instead --
   * under Workers, with ctx.waitUntil.
   *
   * Not called for a replayed update, so a redelivery never answers twice.
   */
  readonly onAccepted?: (accepted: AcceptedTelegramUpdate) => void;

  /**
   * Called once a button tap has been accepted AND durably stored.
   *
   * Separate from `onAccepted` for the same reason the classifier keeps the
   * two apart: a tap resolves a decision rather than asking a question, and a
   * handler that received both through one channel would have to re-derive
   * which it was holding.
   *
   * Same contract otherwise -- not awaited, and not called for a replay.
   */
  readonly onCallback?: (accepted: AcceptedTelegramButtonTap) => void;
}

export interface AcceptedTelegramUpdate {
  readonly eventId: string;
  readonly principalId: string;
  /** Needed to resolve the delivery identity; chatId is not the same thing. */
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string;
}

export interface AcceptedTelegramButtonTap {
  readonly eventId: string;
  readonly principalId: string;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly callbackQueryId: string;
  readonly messageId: number;
  /** Still unparsed. Only the decision parser decides whether it means anything. */
  readonly data: string;
}

const encoder = new TextEncoder();

/**
 * Compare in time independent of where the first difference falls.
 *
 * Length is folded into the same accumulator rather than checked by an early
 * return, so a wrong-length secret is not distinguishable by timing either.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = encoder.encode(presented);
  const b = encoder.encode(expected);
  let difference = a.byteLength ^ b.byteLength;
  const span = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < span; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function reply(reason: TelegramRejectionReason): Response {
  return new Response(rejectionReply(reason), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function isoMilliseconds(moment: Date): string {
  return moment.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

/**
 * Every string in an event payload must be an issued redaction token -- the
 * envelope refuses raw text outright, including values we produced ourselves
 * like a chat id or a rejection reason. That rule is what makes "no
 * unredacted text was ever persisted" checkable rather than a convention, so
 * our own literals go through the redactor too. createEnvelope unwraps the
 * token back to its text when it materializes the payload, so the stored
 * shape is unchanged.
 */
function token(
  dependencies: TelegramWebhookDependencies,
  value: string,
): RedactionResult {
  return dependencies.redactor.redact({ text: value, channel: "telegram", field: "metadata" });
}

async function persist(
  dependencies: TelegramWebhookDependencies,
  options: {
    eventType: string;
    subjectId: string;
    updateId: number;
    payload: Record<string, unknown>;
    requestHash: Sha256Hex;
    now: Date;
  },
): Promise<AppendedEvent> {
  const identifier = (dependencies.ulid ?? newUlid)(options.now);
  const timestamp = isoMilliseconds(options.now);
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: identifier,
    eventType: options.eventType,
    source: "channel:telegram",
    subjectId: options.subjectId,
    occurredAt: timestamp,
    receivedAt: timestamp,
    correlationId: identifier,
    contentType: "application/json",
    payload: options.payload as never,
    producerVersion: PRODUCER_VERSION,
  });
  // Keyed by update id: Telegram redelivers on any non-2xx or timeout, and a
  // redelivery must reuse the stored event rather than create a second one.
  return dependencies.events.append({
    envelope,
    scope: IDEMPOTENCY_SCOPE,
    key: String(options.updateId),
    requestHash: options.requestHash,
  });
}

async function refuse(
  dependencies: TelegramWebhookDependencies,
  updateId: number,
  reason: TelegramRejectionReason,
  requestHash: Sha256Hex,
  now: Date,
  subjectId: string,
): Promise<Response> {
  const minimal = buildRejectionPayload(updateId, reason);
  await persist(dependencies, {
    eventType: REJECTED_EVENT,
    subjectId,
    updateId,
    // Built from the minimal payload's two fields only; the update itself is
    // not in scope here, so nothing else can reach the event.
    payload: { updateId: minimal.updateId, reason: token(dependencies, minimal.reason) },
    requestHash,
    now,
  });
  return reply(reason);
}

export async function handleTelegramWebhook(
  request: Request,
  dependencies: TelegramWebhookDependencies,
): Promise<Response> {
  // Header before body. An unauthenticated caller must not be able to make the
  // worker parse a payload it chose.
  const presented = request.headers.get(SECRET_HEADER) ?? "";
  if (!secretsMatch(presented, dependencies.webhookSecret)) {
    return new Response("unauthorized", { status: 401 });
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const rawBody = await request.text();
  const requestHash = await sha256Hex(rawBody);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  const classification = classifyTelegramUpdate(parsed);
  if (classification.kind === "rejected") {
    // A malformed body has no trustworthy subject, so key it by update id.
    const subject = `telegram:update:${classification.updateId}`;
    return refuse(dependencies, classification.updateId, classification.reason, requestHash, now, subject);
  }

  const update = classification.value;
  const subject = `telegram:user:${update.telegramUserId}`;

  const authenticated = await dependencies.policy.authenticateTelegram({
    telegramUserId: update.telegramUserId,
    webhookSecretValid: true,
  });
  if (authenticated.identityState !== "active" || authenticated.principalId.length === 0) {
    return refuse(dependencies, update.updateId, "unauthorized", requestHash, now, subject);
  }

  const admission = dependencies.limiter.check(authenticated.principalId, now.getTime());
  if (!admission.allowed) {
    return refuse(dependencies, update.updateId, "rate_limited", requestHash, now, subject);
  }

  // A tap takes the same authentication and the same allowance as a message,
  // because it causes the same kind of work, and then diverges: it carries no
  // free text to redact, and it resolves a question rather than asking one.
  if (classification.kind === "callback") {
    const tap = classification.value;
    const appendedTap = await persist(dependencies, {
      eventType: CALLBACK_EVENT,
      subjectId: subject,
      updateId: tap.updateId,
      payload: {
        updateId: tap.updateId,
        chatId: token(dependencies, tap.chatId),
        messageId: tap.messageId,
        // Bounded, structural, and produced by a keyboard this Worker built.
        // It goes through the redactor anyway: the envelope refuses every raw
        // string, and the value of that rule is that it has no exceptions.
        data: token(dependencies, tap.data) as unknown as Record<string, unknown>,
      },
      requestHash,
      now,
    });

    if (!appendedTap.replayed) {
      dependencies.limiter.record(authenticated.principalId, now.getTime());
      dependencies.onCallback?.({
        eventId: appendedTap.envelope.eventId,
        principalId: authenticated.principalId,
        telegramUserId: tap.telegramUserId,
        chatId: tap.chatId,
        callbackQueryId: tap.callbackQueryId,
        messageId: tap.messageId,
        data: tap.data,
      });
    }
    return new Response("", { status: 200 });
  }

  // Re-read after the callback branch returned, so this is the text variant
  // rather than the union. `update` above is deliberately the union: the
  // authentication and admission steps apply identically to both, and giving
  // each its own copy of them is how the two paths drift apart.
  const message = classification.value;

  const redacted = dependencies.redactor.redact({
    text: message.text,
    channel: "telegram",
    field: "text",
  });
  if (!isIssuedRedaction(redacted)) {
    // The design is explicit: on redactor failure store only safe metadata and
    // ask the sender to retry. Never persist or forward the original content.
    await persist(dependencies, {
      eventType: REDACTION_FAILED_EVENT,
      subjectId: subject,
      updateId: update.updateId,
      payload: { updateId: update.updateId },
      requestHash,
      now,
    });
    return new Response("Jarvis could not process that message. Please try again.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const appended = await persist(dependencies, {
    eventType: ACCEPTED_EVENT,
    subjectId: subject,
    updateId: update.updateId,
    payload: {
      updateId: update.updateId,
      chatId: token(dependencies, update.chatId),
      messageId: update.messageId,
      text: redacted as unknown as Record<string, unknown>,
    },
    requestHash,
    now,
  });

  // Recorded only for an update that was genuinely admitted and stored, so a
  // refused or replayed message never consumes allowance.
  if (!appended.replayed) {
    dependencies.limiter.record(authenticated.principalId, now.getTime());
    dependencies.onAccepted?.({
      eventId: appended.envelope.eventId,
      principalId: authenticated.principalId,
      telegramUserId: update.telegramUserId,
      chatId: update.chatId,
      messageId: update.messageId,
      // The original text, not the stored token: the model needs what was
      // actually said. It has already passed the redactor, so nothing
      // sensitive survives into this path either.
      text: message.text,
    });
  }

  return new Response("", { status: 200 });
}
