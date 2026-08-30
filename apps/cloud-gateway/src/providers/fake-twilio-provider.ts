import {
  ProviderDispatchUnknownError,
  ProviderFailure,
  TWILIO_STATUS_CALLBACK_EVENTS,
  type TwilioCreateCallInput,
  type TwilioCreateCallResult,
  type TwilioProvider,
  type TwilioRequestVerifier,
  type TwilioStatusCallbackEvents,
} from "./provider-types.js";
import {
  TwilioSignatureVerifier,
  type VerifiedTwilioForm,
} from "./twilio-verifier.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;

const FAKE_AUTH_TOKEN = "public-fake-twilio-auth-token";

async function fakeSignature(exactUrl: string, pairs: readonly (readonly [string, string])[]): Promise<string> {
  const grouped = new Map<string, Set<string>>();
  for (const [name, value] of pairs) {
    const values = grouped.get(name) ?? new Set<string>();
    values.add(value);
    grouped.set(name, values);
  }
  const payload = exactUrl + [...grouped]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, values]) => [...values]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((value) => `${name}${value}`))
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(FAKE_AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function cloneInput(input: TwilioCreateCallInput): TwilioCreateCallInput {
  const events = Object.freeze([...input.statusCallbackEvents]) as unknown as TwilioStatusCallbackEvents;
  const snapshot = {
    commandId: input.commandId.normalize("NFC"),
    toE164: input.toE164.normalize("NFC"),
    twimlUrl: Object.freeze(new URL(input.twimlUrl.toString())),
    statusCallbackUrl: Object.freeze(new URL(input.statusCallbackUrl.toString())),
    statusCallbackEvents: events,
    idempotencyKey: input.idempotencyKey.normalize("NFC"),
  };
  return Object.freeze(snapshot);
}

function validateInput(input: TwilioCreateCallInput): void {
  const exactEvents = input.statusCallbackEvents.length === TWILIO_STATUS_CALLBACK_EVENTS.length
    && input.statusCallbackEvents.every((event, index) => event === TWILIO_STATUS_CALLBACK_EVENTS[index]);
  if (!ULID.test(input.commandId) || !E164.test(input.toE164) || input.idempotencyKey.length === 0 || !exactEvents) {
    throw ProviderFailure.permanent("invalid_request");
  }
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FakeTwilioProvider implements TwilioProvider, TwilioRequestVerifier {
  private readonly requestLog: TwilioCreateCallInput[] = [];
  private readonly acceptedCallLog: { readonly callSid: string; readonly request: TwilioCreateCallInput }[] = [];
  private readonly failures: Error[] = [];
  private readonly delays: number[] = [];
  private readonly signatureVerifier = new TwilioSignatureVerifier({ authToken: FAKE_AUTH_TOKEN });
  private lostResponses = 0;
  signatureValid = true;

  get requests(): readonly Readonly<TwilioCreateCallInput>[] {
    return Object.freeze(this.requestLog.map((input) => cloneInput(input)));
  }

  get acceptedCalls(): readonly { readonly callSid: string; readonly request: Readonly<TwilioCreateCallInput> }[] {
    return Object.freeze(this.acceptedCallLog.map(({ callSid, request }) => Object.freeze({
      callSid,
      request: cloneInput(request),
    })));
  }

  failNext(error: Error): void {
    this.failures.push(error);
  }

  delayNext(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("provider_delay_invalid");
    this.delays.push(milliseconds);
  }

  acceptAndLoseNextResponse(): void {
    this.lostResponses += 1;
  }

  async signWebhook(exactUrl: string, rawBody: Uint8Array): Promise<string> {
    if (rawBody.byteLength > 65_536) throw new RangeError("fake_twilio_form_too_large");
    const decoded = new TextDecoder().decode(rawBody);
    return fakeSignature(exactUrl, [...new URLSearchParams(decoded).entries()]);
  }

  signWebSocket(exactUrl: string): Promise<string> {
    return fakeSignature(exactUrl, []);
  }

  async verifyWebhook(input: Parameters<TwilioRequestVerifier["verifyWebhook"]>[0]): Promise<VerifiedTwilioForm | null> {
    if (!this.signatureValid) {
      try {
        await input.request.body?.cancel();
      } catch {
        // A forced fake rejection still owns and closes its request body.
      }
      return null;
    }
    return this.signatureVerifier.verifyWebhook(input);
  }

  async verifyWebSocket(input: Parameters<TwilioRequestVerifier["verifyWebSocket"]>[0]): Promise<boolean> {
    if (!this.signatureValid) return false;
    return this.signatureVerifier.verifyWebSocket(input);
  }

  async createCall(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult> {
    const snapshot = cloneInput(input);
    validateInput(snapshot);
    return this.performAttempt(snapshot);
  }

  private async performAttempt(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult> {
    const delay = this.delays.shift() ?? 0;
    const failure = this.failures.shift();
    const loseResponse = this.lostResponses > 0;
    if (loseResponse) this.lostResponses -= 1;
    this.requestLog.push(cloneInput(input));
    const attemptNumber = this.requestLog.length;

    await wait(delay);
    if (failure !== undefined) throw failure;
    const result = Object.freeze({ callSid: `CA${String(attemptNumber).padStart(32, "0")}` });
    this.acceptedCallLog.push(Object.freeze({ callSid: result.callSid, request: cloneInput(input) }));
    if (loseResponse) throw new ProviderDispatchUnknownError();

    return result;
  }
}
