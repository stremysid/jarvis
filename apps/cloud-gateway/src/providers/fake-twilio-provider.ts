import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import {
  ProviderFailure,
  ProviderIdempotencyConflictError,
  TWILIO_STATUS_CALLBACK_EVENTS,
  type TwilioCreateCallInput,
  type TwilioCreateCallResult,
  type TwilioProvider,
  type TwilioStatusCallbackEvents,
} from "./provider-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;

interface IdempotentAttempt {
  readonly material: string;
  readonly promise: Promise<TwilioCreateCallResult>;
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

function materialOf(input: TwilioCreateCallInput): string {
  return canonicalJson({
    commandId: input.commandId,
    toE164: input.toE164,
    twimlUrl: input.twimlUrl.toString(),
    statusCallbackUrl: input.statusCallbackUrl.toString(),
    statusCallbackEvents: [...input.statusCallbackEvents],
  });
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

export class FakeTwilioProvider implements TwilioProvider {
  private readonly requestLog: TwilioCreateCallInput[] = [];
  private readonly attempts = new Map<string, IdempotentAttempt>();
  private readonly failures: Error[] = [];
  private readonly delays: number[] = [];

  get requests(): readonly Readonly<TwilioCreateCallInput>[] {
    return Object.freeze(this.requestLog.map((input) => cloneInput(input)));
  }

  failNext(error: Error): void {
    this.failures.push(error);
  }

  delayNext(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("provider_delay_invalid");
    this.delays.push(milliseconds);
  }

  async createCall(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult> {
    const snapshot = cloneInput(input);
    const material = materialOf(snapshot);
    const existing = this.attempts.get(snapshot.idempotencyKey);
    if (existing !== undefined) {
      if (existing.material !== material) throw new ProviderIdempotencyConflictError();
      return existing.promise;
    }

    validateInput(snapshot);
    const promise = this.performAttempt(snapshot);
    const attempt = { material, promise };
    this.attempts.set(snapshot.idempotencyKey, attempt);

    try {
      return await promise;
    } catch (error) {
      if (this.attempts.get(snapshot.idempotencyKey) === attempt) this.attempts.delete(snapshot.idempotencyKey);
      throw error;
    }
  }

  private async performAttempt(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult> {
    const delay = this.delays.shift() ?? 0;
    const failure = this.failures.shift();
    this.requestLog.push(cloneInput(input));
    const attemptNumber = this.requestLog.length;

    await wait(delay);
    if (failure !== undefined) throw failure;

    return Object.freeze({ callSid: `CA${String(attemptNumber).padStart(32, "0")}` });
  }
}
