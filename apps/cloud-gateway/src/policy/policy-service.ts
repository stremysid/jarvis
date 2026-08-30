import type { ActiveTelegramIdentity, DeviceRepository } from "../persistence/device-repository.js";

export interface TelegramAuthenticationInput {
  readonly telegramUserId: string;
  readonly webhookSecretValid: boolean;
}

export type TelegramAuthenticationResult = Readonly<{
  principalId: string;
  identityState: "active" | "blocked";
}>;

const INPUT_FIELDS = ["telegramUserId", "webhookSecretValid"] as const;
const IDENTITY_FIELDS = ["identityId", "principalId", "principalType"] as const;
const BLOCKED: TelegramAuthenticationResult = Object.freeze({ principalId: "", identityState: "blocked" });
const TELEGRAM_PROVIDER_SUBJECT = /^[1-9]\d{0,19}$/u;
const encoder = new TextEncoder();

function hasExactOwnFields(value: object, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === "string" && fields.includes(key));
}

function dataDescriptor(value: object, field: string): PropertyDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor : null;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC")
    && !value.includes("\n") && !value.includes("\r") && encoder.encode(value).byteLength <= 256;
}

function exactIdentity(value: unknown): ActiveTelegramIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (!hasExactOwnFields(value, IDENTITY_FIELDS)) return null;
  const identityId = dataDescriptor(value, "identityId");
  const principalId = dataDescriptor(value, "principalId");
  const principalType = dataDescriptor(value, "principalType");
  if (identityId === null || principalId === null || principalType === null) return null;
  if (!isOpaqueId(identityId.value) || !isOpaqueId(principalId.value) || principalType.value !== "human") return null;
  return Object.freeze({ identityId: identityId.value, principalId: principalId.value, principalType: "human" });
}

/** Authenticates a Telegram channel identity without granting action capabilities. */
export class PolicyService {
  constructor(private readonly identities: Pick<DeviceRepository, "findActiveVerifiedTelegramIdentity">) {}

  async authenticateTelegram(input: unknown): Promise<TelegramAuthenticationResult> {
    try {
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return BLOCKED;
      if (!hasExactOwnFields(input, INPUT_FIELDS)) return BLOCKED;

      const secret = dataDescriptor(input, "webhookSecretValid");
      if (secret === null || secret.value !== true) return BLOCKED;

      const telegramUserId = dataDescriptor(input, "telegramUserId");
      if (telegramUserId === null || typeof telegramUserId.value !== "string" || !TELEGRAM_PROVIDER_SUBJECT.test(telegramUserId.value)) return BLOCKED;

      const identity = exactIdentity(await this.identities.findActiveVerifiedTelegramIdentity(telegramUserId.value));
      if (identity === null) return BLOCKED;
      return Object.freeze({ principalId: identity.principalId, identityState: "active" });
    } catch {
      return BLOCKED;
    }
  }
}
