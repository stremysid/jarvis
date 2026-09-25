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

export interface TelegramChatActionSender {
  sendChatAction(input: Readonly<{ chatId: string; action: "typing" }>): Promise<void>;
}

export const TELEGRAM_TYPING_REPEAT_MS = 4_000;

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
    // Bound to globalThis. The Workers runtime rejects native fetch called
    // with any other `this`, and storing it as a class field then calling
    // this.#fetch(...) supplies the instance -- raising "Illegal
    // invocation" at runtime. Node has no such restriction, so this passes
    // every test and fails only in production.
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
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
    if (input.replyMarkup !== undefined) body.reply_markup = input.replyMarkup;

    // A hung fetch or body read would hold a Worker invocation open until the
    // platform kills it, so keep the deadline through response.json().
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
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
      }

      let parsed: TelegramApiResponse;
      try {
        parsed = (await response.json()) as TelegramApiResponse;
      } catch {
        if (controller.signal.aborted) throw ProviderFailure.transient("timeout");
        // A non-JSON body from a 2xx is still a failed send as far as we are
        // concerned: we cannot confirm delivery without a message id.
        throw response.ok ? ProviderFailure.transient("temporarily_unavailable") : failureFor(response.status);
      }
      if (controller.signal.aborted) throw ProviderFailure.transient("timeout");

      if (!response.ok) throw failureFor(response.status);
      // A malformed 2xx cannot prove non-delivery. Treating it like an explicit
      // 400 would let the reminder sender falsely report that nothing arrived.
      if (parsed.ok !== true) throw ProviderFailure.transient("temporarily_unavailable");

      const providerMessageId = messageIdOf(parsed.result);
      // Telegram reported success but gave us nothing to record. Treated as
      // transient rather than permanent: the send may well have happened, and
      // the outbox must not conclude the message was rejected.
      if (providerMessageId === null) throw ProviderFailure.transient("temporarily_unavailable");

      return { providerMessageId };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendChatAction(input: Readonly<{ chatId: string; action: "typing" }>): Promise<void> {
    if (input.chatId.length === 0 || input.action !== "typing") {
      throw ProviderFailure.permanent("invalid_request");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${API_ORIGIN}/bot${this.#botToken}/sendChatAction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: input.chatId, action: input.action }),
          signal: controller.signal,
        });
      } catch {
        throw ProviderFailure.transient("timeout");
      }

      let parsed: TelegramApiResponse;
      try {
        parsed = (await response.json()) as TelegramApiResponse;
      } catch {
        if (controller.signal.aborted) throw ProviderFailure.transient("timeout");
        throw response.ok ? ProviderFailure.transient("temporarily_unavailable") : failureFor(response.status);
      }
      if (controller.signal.aborted) throw ProviderFailure.transient("timeout");
      if (!response.ok || parsed.ok !== true) throw failureFor(response.status);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps Telegram's short-lived action alive without making it part of turn success. */
export class TelegramTypingIndicator {
  readonly #sender: TelegramChatActionSender;
  readonly #chatId: string;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(sender: TelegramChatActionSender, chatId: string) {
    this.#sender = sender;
    this.#chatId = chatId;
  }

  #send(): void {
    void this.#sender.sendChatAction({ chatId: this.#chatId, action: "typing" }).catch(() => undefined);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#send();
    this.#timer = setInterval(() => this.#send(), TELEGRAM_TYPING_REPEAT_MS);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

export async function withTelegramTyping<T>(
  sender: TelegramChatActionSender,
  chatId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const indicator = new TelegramTypingIndicator(sender, chatId);
  indicator.start();
  try {
    return await operation();
  } finally {
    indicator.stop();
  }
}
