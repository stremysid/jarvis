/**
 * The watchdog's alert path, over fetch, to Telegram.
 *
 * Written out here rather than reusing the gateway's Telegram provider. That
 * provider is good and this one repeats a fair amount of it, but importing it
 * would mean the watchdog boots the gateway's module graph: its provider
 * types, its failure taxonomy, whatever those pull in next. A bad deploy or a
 * broken import anywhere in that graph would take the alert path down together
 * with the thing it is supposed to report on, and the failure would look
 * exactly like silence. The duplication is the feature.
 *
 * Nothing here throws. A caller that has to decide whether an alert was
 * delivered before it records it must not be able to forget a catch, so
 * delivery is a value rather than an exception.
 */

const API_ORIGIN = "https://api.telegram.org";

/** Telegram rejects anything longer, and the whole message is lost, not the tail. */
const MAX_MESSAGE_CHARACTERS = 4096;

const DEFAULT_TIMEOUT_MS = 10_000;

export type AlertOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

export interface AlertChannel {
  /** Never rejects. A failure comes back as `delivered: false` with a reason. */
  send(text: string): Promise<AlertOutcome>;
  /** False when the channel is a placeholder that can never deliver. */
  readonly configured: boolean;
}

export interface TelegramAlertChannelOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Trim to what Telegram will accept, saying so in the message.
 *
 * Silently dropping the tail would be the same class of bug as the one this
 * Worker exists to prevent: the message that arrives looks complete, and the
 * components that fell off the end look fine.
 */
export function fitToMessageLimit(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARACTERS) return text;
  const notice = "\n[truncated]";
  return `${text.slice(0, MAX_MESSAGE_CHARACTERS - notice.length)}${notice}`;
}

export class TelegramAlertChannel implements AlertChannel {
  readonly configured = true;
  readonly #botToken: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: TelegramAlertChannelOptions) {
    this.#botToken = options.botToken;
    this.#chatId = options.chatId;
    // Bound to globalThis. The Workers runtime refuses native fetch called
    // with any other `this`, and storing it unbound as a class field then
    // calling this.#fetch(...) supplies the instance, raising "Illegal
    // invocation" -- at runtime only. Node does not care, so an unbound fetch
    // passes every test here and fails the first time it is needed for real.
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(text: string): Promise<AlertOutcome> {
    const body = fitToMessageLimit(text);
    if (body.length === 0) return { delivered: false, reason: "empty_message" };

    // A hung request would hold the scheduled invocation open until the
    // platform kills it, and the cycle would end with nothing recorded and
    // nothing said.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/bot${this.#botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.#chatId, text: body }),
        signal: controller.signal,
      });
    } catch (error) {
      return { delivered: false, reason: `transport:${errorLabel(error)}` };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return { delivered: false, reason: `http_${response.status}` };

    // A 200 is not delivery. Telegram answers 200 with `ok: false` for errors
    // it considers the caller's fault, and treating that as sent would record
    // an alert nobody received -- which suppresses the alert for the rest of
    // the outage, because the next cycle sees it as already open.
    let acknowledged: unknown;
    try {
      acknowledged = await response.json();
    } catch {
      return { delivered: false, reason: "unreadable_response" };
    }
    const ok = (acknowledged as { ok?: unknown } | null)?.ok;
    if (ok !== true) return { delivered: false, reason: "not_acknowledged" };

    return { delivered: true };
  }
}

/**
 * Stands in when no bot token or chat id is configured.
 *
 * It reports every send as undelivered rather than pretending to succeed, so
 * nothing is ever recorded as alerted, and `configured` is false so /health
 * refuses to answer "ok". A watchdog that cannot alert has to be visibly
 * broken; one that quietly no-ops is worse than no watchdog at all, because it
 * is indistinguishable from a system with nothing wrong with it.
 */
export class UnconfiguredAlertChannel implements AlertChannel {
  readonly configured = false;

  async send(): Promise<AlertOutcome> {
    return { delivered: false, reason: "alert_channel_not_configured" };
  }
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" ? "timeout" : error.name;
  return "unknown";
}
