import {
  ProviderDispatchUnknownError,
  ProviderFailure,
  TWILIO_STATUS_CALLBACK_EVENTS,
  type TwilioCreateCallInput,
  type TwilioCreateCallResult,
  type TwilioProvider,
} from "./provider-types.js";

const ACCOUNT_SID = /^AC[0-9A-Fa-f]{32}$/;
const API_KEY_SID = /^SK[0-9A-Fa-f]{32}$/;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RING_TIMEOUT_SECONDS = 600;

export interface TwilioRestProviderOptions {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  fromE164: string;
  requestTimeoutMs: number;
  ringTimeoutSeconds: number;
  fetch: typeof fetch;
}

function invalidRequest(): ProviderFailure {
  return ProviderFailure.permanent("invalid_request");
}

function validHttpsUrl(url: URL): boolean {
  return url.protocol === "https:"
    && url.username.length === 0
    && url.password.length === 0
    && url.hash.length === 0;
}

function validateCallInput(input: TwilioCreateCallInput): void {
  const exactEvents = input.statusCallbackEvents.length === TWILIO_STATUS_CALLBACK_EVENTS.length
    && input.statusCallbackEvents.every((event, index) => event === TWILIO_STATUS_CALLBACK_EVENTS[index]);
  if (
    !E164.test(input.toE164)
    || !validHttpsUrl(input.twimlUrl)
    || !validHttpsUrl(input.statusCallbackUrl)
    || !exactEvents
    || input.idempotencyKey.length === 0
  ) {
    throw invalidRequest();
  }
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function requestBody(input: TwilioCreateCallInput, fromE164: string, ringTimeoutSeconds: number): string {
  const form = new URLSearchParams();
  form.append("To", input.toE164);
  form.append("From", fromE164);
  form.append("Url", input.twimlUrl.toString());
  form.append("Method", "POST");
  form.append("StatusCallback", input.statusCallbackUrl.toString());
  form.append("StatusCallbackMethod", "POST");
  for (const event of input.statusCallbackEvents) form.append("StatusCallbackEvent", event);
  form.append("TimeLimit", "1800");
  form.append("Timeout", String(ringTimeoutSeconds));
  return form.toString();
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The response is already classified as indeterminate; cancellation detail must not escape.
      }
      throw new ProviderDispatchUnknownError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseSuccess(body: Uint8Array, accountSid: string): TwilioCreateCallResult {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    parsed = JSON.parse(decoded);
  } catch {
    throw new ProviderDispatchUnknownError();
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !("account_sid" in parsed)
    || !("sid" in parsed)
    || parsed.account_sid !== accountSid
    || typeof parsed.sid !== "string"
    || !CALL_SID.test(parsed.sid)
  ) {
    throw new ProviderDispatchUnknownError();
  }
  return Object.freeze({ callSid: parsed.sid });
}

export class TwilioRestProvider implements TwilioProvider {
  readonly #accountSid: string;
  readonly #apiKeySid: string;
  readonly #apiKeySecret: string;
  readonly #fromE164: string;
  readonly #requestTimeoutMs: number;
  readonly #ringTimeoutSeconds: number;
  readonly #fetch: typeof fetch;

  constructor(options: TwilioRestProviderOptions) {
    if (
      !ACCOUNT_SID.test(options.accountSid)
      || !API_KEY_SID.test(options.apiKeySid)
      || options.apiKeySecret.length === 0
      || !E164.test(options.fromE164)
      || !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs < 1
      || options.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
      || !Number.isSafeInteger(options.ringTimeoutSeconds)
      || options.ringTimeoutSeconds < 1
      || options.ringTimeoutSeconds > MAX_RING_TIMEOUT_SECONDS
      || typeof options.fetch !== "function"
    ) {
      throw invalidRequest();
    }
    this.#accountSid = options.accountSid;
    this.#apiKeySid = options.apiKeySid;
    this.#apiKeySecret = options.apiKeySecret;
    this.#fromE164 = options.fromE164;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#ringTimeoutSeconds = options.ringTimeoutSeconds;
    this.#fetch = options.fetch;
  }

  async createCall(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult> {
    validateCallInput(input);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#requestTimeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${this.#accountSid}/Calls.json`,
          {
            method: "POST",
            headers: {
              authorization: basicAuthorization(this.#apiKeySid, this.#apiKeySecret),
              "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: requestBody(input, this.#fromE164, this.#ringTimeoutSeconds),
            signal: abort.signal,
            redirect: "manual",
          },
        );
      } catch {
        throw new ProviderDispatchUnknownError();
      }

      if (response.status === 401 || response.status === 403) throw ProviderFailure.authentication();
      if (response.status === 429) throw ProviderFailure.transient("rate_limited");
      if (response.status >= 400 && response.status < 500) throw invalidRequest();
      if (response.status !== 201) throw new ProviderDispatchUnknownError();

      return parseSuccess(await readBoundedBody(response), this.#accountSid);
    } catch (error) {
      if (error instanceof ProviderFailure || error instanceof ProviderDispatchUnknownError) throw error;
      throw new ProviderDispatchUnknownError();
    } finally {
      clearTimeout(timeout);
    }
  }
}
