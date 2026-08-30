import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import {
  ProviderFailure,
  ProviderIdempotencyConflictError,
  type TelegramProvider,
  type TelegramSendMessageInput,
  type TelegramSendMessageResult,
} from "./provider-types.js";

interface IdempotentAttempt {
  readonly material: string;
  readonly promise: Promise<TelegramSendMessageResult>;
}

function cloneInput(input: TelegramSendMessageInput): TelegramSendMessageInput {
  const snapshot: TelegramSendMessageInput = {
    chatId: input.chatId.normalize("NFC"),
    text: input.text.normalize("NFC"),
    idempotencyKey: input.idempotencyKey.normalize("NFC"),
  };
  if (input.replyToMessageId !== undefined) snapshot.replyToMessageId = input.replyToMessageId;
  return Object.freeze(snapshot);
}

function materialOf(input: TelegramSendMessageInput): string {
  const material: Record<string, string | number> = { chatId: input.chatId, text: input.text };
  if (input.replyToMessageId !== undefined) material.replyToMessageId = input.replyToMessageId;
  return canonicalJson(material);
}

function validateInput(input: TelegramSendMessageInput): void {
  if (input.chatId.length === 0 || input.text.length === 0 || input.idempotencyKey.length === 0
    || input.replyToMessageId !== undefined && (!Number.isSafeInteger(input.replyToMessageId) || input.replyToMessageId <= 0)) {
    throw ProviderFailure.permanent("invalid_request");
  }
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FakeTelegramProvider implements TelegramProvider {
  private readonly requestLog: TelegramSendMessageInput[] = [];
  private readonly attempts = new Map<string, IdempotentAttempt>();
  private readonly failures: Error[] = [];
  private readonly delays: number[] = [];

  get requests(): readonly Readonly<TelegramSendMessageInput>[] {
    return Object.freeze(this.requestLog.map((input) => cloneInput(input)));
  }

  failNext(error: Error): void {
    this.failures.push(error);
  }

  delayNext(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("provider_delay_invalid");
    this.delays.push(milliseconds);
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
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

  private async performAttempt(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    const delay = this.delays.shift() ?? 0;
    const failure = this.failures.shift();
    this.requestLog.push(cloneInput(input));
    const attemptNumber = this.requestLog.length;

    await wait(delay);
    if (failure !== undefined) throw failure;

    return Object.freeze({ providerMessageId: `telegram-message-${String(attemptNumber).padStart(8, "0")}` });
  }
}
