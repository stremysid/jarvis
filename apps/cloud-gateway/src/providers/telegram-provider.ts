import {
  ProviderFailure,
  type TelegramProvider,
  type TelegramSendMessageInput,
  type TelegramSendMessageResult,
} from "./provider-types.js";

/**
 * Real Telegram Bot API sender.
 *
 * Telegram has no idempotency mechanism: an identical sendMessage twice
 * delivers two messages. `idempotencyKey` therefore cannot be enforced here
 * and is deliberately not sent -- deduplication belongs to the outbox
 * dispatcher, which decides whether a send is attempted at all. Silently
 * accepting the key while ignoring it would imply a guarantee this transport
 * cannot make.
 */

const API_ORIGIN = "https://api.telegram.org";

/** Telegram rejects anything longer; splitting is the caller's decision. */
export const MAX_MESSAGE_CHARACTERS = 4096;

export interface TelegramRestProviderOptions {
  readonly botToken: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

interface TelegramApiResponse {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error_code?: unknown;
  readonly description?: unknown;
}

// A bot token is `<numeric id>:<secret>`. Validated so a malformed value fails
// at construction rather than as a puzzling 404 from the API.
const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/u;

function messageIdOf(result: unknown): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const messageId = (result as Record<string, unknown>).message_id;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return String(messageId);
}

/**
 * Map an HTTP status onto the retry semantics the outbox depends on.
 *
 * The distinction is load-bearing: a transient failure is retried, a permanent
 * one is not. Classifying a 400 as transient would retry a malformed message
 * forever; classifying a 429 as permanent would drop a message that would have
 * succeeded a second later.
 */
function failureFor(status: number): ProviderFailure {
  if (status === 401 || status === 403) return ProviderFailure.authentication();
  if (status === 429) return ProviderFailure.transient("rate_limited");
  if (status >= 500) return ProviderFailure.transient("temporarily_unavailable");
  return ProviderFailure.permanent("invalid_request");
}

export class TelegramRestProvider implements TelegramProvider {
  readonly #botToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: TelegramRestProviderOptions) {
    if (!BOT_TOKEN.test(options.botToken)) throw new TypeError("telegram_bot_token_invalid");
    this.#botToken = options.botToken;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    const text = input.text.normalize("NFC");
    if (text.length === 0) throw ProviderFailure.permanent("invalid_request");
    if (text.length > MAX_MESSAGE_CHARACTERS) throw ProviderFailure.permanent("output_limit");
    if (input.chatId.length === 0) throw ProviderFailure.permanent("invalid_request");

    const body: Record<string, unknown> = { chat_id: input.chatId, text };
    if (input.replyToMessageId !== undefined) {
      if (!Number.isSafeInteger(input.replyToMessageId) || input.replyToMessageId <= 0) {
        throw ProviderFailure.permanent("invalid_request");
      }
      body.reply_to_message_id = input.replyToMessageId;
    }

    // A hung request would hold a Worker invocation open until the platform
    // kills it, so the timeout is enforced here rather than relied upon.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/bot${this.#botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw ProviderFailure.transient("timeout");
    } finally {
      clearTimeout(timer);
    }

    let parsed: TelegramApiResponse;
    try {
      parsed = (await response.json()) as TelegramApiResponse;
    } catch {
      // A non-JSON body from a 2xx is still a failed send as far as we are
      // concerned: we cannot confirm delivery without a message id.
      throw response.ok ? ProviderFailure.transient("temporarily_unavailable") : failureFor(response.status);
    }

    if (!response.ok || parsed.ok !== true) throw failureFor(response.status);

    const providerMessageId = messageIdOf(parsed.result);
    // Telegram reported success but gave us nothing to record. Treated as
    // transient rather than permanent: the send may well have happened, and
    // the outbox must not conclude the message was rejected.
    if (providerMessageId === null) throw ProviderFailure.transient("temporarily_unavailable");

    return { providerMessageId };
  }
}
