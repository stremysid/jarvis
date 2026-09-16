import type { VerifiedTwilioForm } from "./twilio-verifier.js";

export type { VerifiedTwilioForm } from "./twilio-verifier.js";

export const TWILIO_STATUS_CALLBACK_EVENTS = Object.freeze([
  "initiated",
  "ringing",
  "answered",
  "completed",
] as const);

export type TwilioStatusCallbackEvents = readonly ["initiated", "ringing", "answered", "completed"];

export interface TwilioCreateCallInput {
  commandId: string;
  attemptId: string;
  toE164: string;
  twimlUrl: URL;
  statusCallbackUrl: URL;
  statusCallbackEvents: TwilioStatusCallbackEvents;
  idempotencyKey: string;
}

export interface TwilioCreateCallResult {
  callSid: string;
}

export interface TwilioProvider {
  createCall(input: TwilioCreateCallInput): Promise<TwilioCreateCallResult>;
}

/** A call-creation result that may have been accepted by Twilio and must never be retried automatically. */
export class ProviderDispatchUnknownError extends Error {
  readonly code = "provider_dispatch_unknown" as const;
  readonly operation = "twilio.createCall" as const;

  constructor() {
    super("provider_dispatch_unknown");
    this.name = "ProviderDispatchUnknownError";
  }
}

export interface TwilioRequestVerifier {
  verifyWebhook(input: {
    request: Request;
    exactUrl: string;
  }): Promise<VerifiedTwilioForm | null>;
  verifyWebSocket(input: {
    request: Request;
    exactUrl: string;
  }): Promise<boolean>;
}

export type ModelChunk =
  | { type: "token"; index: number; text: string }
  | { type: "completed" };

export interface ModelContextItem {
  sourceEventId: string;
  text: string;
  sensitivity: "personal" | "restricted";
}

export interface ModelStreamTextInput {
  correlationId: string;
  principalId: string;
  channel: "voice" | "telegram";
  userText: string;
  context: readonly ModelContextItem[];
  timeoutMs: number;
  contextTokenBudget: number;
  reasoningEffort: "none" | "low" | "high" | "max";
  signal: AbortSignal;
}

export interface ModelCompleteJsonInput {
  correlationId: string;
  principalId: string;
  purpose: "memory_distillation";
  prompt: string;
  timeoutMs: number;
  maxOutputTokens: number;
  reasoningEffort: "high";
}

export const MEMORY_EXTRACTION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceEventIds", "sourceExcerpts", "confidence", "sensitivity"],
        properties: {
          text: { type: "string" },
          sourceEventIds: { type: "array", items: { type: "string" } },
          sourceExcerpts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sourceEventId", "excerpt"],
              properties: {
                sourceEventId: { type: "string" },
                excerpt: { type: "string" },
              },
            },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          sensitivity: { enum: ["normal", "sensitive"] },
        },
      },
    },
  },
});

export const MEMORY_EXTRACTION_JSON_EXAMPLE = JSON.stringify({
  proposals: [{
    text: "I play piano.",
    sourceEventIds: ["01m1hh9h1yxaeyjgbhfzm4nnth"],
    sourceExcerpts: [{
      sourceEventId: "01m1hh9h1yxaeyjgbhfzm4nnth",
      excerpt: "I play piano.",
    }],
    confidence: 0.95,
    sensitivity: "normal",
  }],
});

export const MEMORY_EXTRACTION_JSON_CONTRACT =
  `Return one JSON value matching this exact schema: ${MEMORY_EXTRACTION_JSON_SCHEMA} `
  + `Example: ${MEMORY_EXTRACTION_JSON_EXAMPLE}`;

export interface ModelCompleteJsonUsage {
  readonly priceId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reservedCostMicros: number;
  readonly settledCostMicros: number;
  readonly d1Statements: number;
}

export interface ModelCompleteJsonCompletion {
  readonly value: unknown;
  readonly usage: ModelCompleteJsonUsage;
}

const issuedCompleteJsonCompletions = new WeakSet<object>();

/** Mints the only provider completion shape the workflow treats as billable. */
export function issueModelCompleteJsonCompletion(
  value: unknown,
  usage: ModelCompleteJsonUsage,
): ModelCompleteJsonCompletion {
  const completion = Object.freeze({ value, usage: Object.freeze({ ...usage }) });
  issuedCompleteJsonCompletions.add(completion);
  return completion;
}

/** Fake providers may still return raw JSON; only minted production results carry usage. */
export function snapshotModelCompleteJsonCompletion(value: unknown): ModelCompleteJsonCompletion | null {
  if (value === null || typeof value !== "object" || !issuedCompleteJsonCompletions.has(value)
    || !Object.isFrozen(value)) return null;
  const completion = value as ModelCompleteJsonCompletion;
  return Object.isFrozen(completion.usage) ? completion : null;
}

class ModelCompleteJsonSettledFailure extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly usage: ModelCompleteJsonUsage,
  ) {
    super(failure.message);
    this.name = "ModelCompleteJsonSettledFailure";
    Object.freeze(usage);
    Object.freeze(this);
  }
}

const issuedCompleteJsonSettledFailures = new WeakSet<object>();

/** Carries the durable charge receipt when output validation fails after settlement. */
export function issueModelCompleteJsonSettledFailure(
  failure: ProviderFailure,
  usage: ModelCompleteJsonUsage,
): Error {
  const issued = new ModelCompleteJsonSettledFailure(failure, { ...usage });
  issuedCompleteJsonSettledFailures.add(issued);
  return issued;
}

export function snapshotModelCompleteJsonSettledFailure(value: unknown): Readonly<{
  failure: ProviderFailure;
  usage: ModelCompleteJsonUsage;
}> | null {
  if (!(value instanceof ModelCompleteJsonSettledFailure)
    || !issuedCompleteJsonSettledFailures.has(value)
    || !Object.isFrozen(value)
    || !Object.isFrozen(value.usage)
    || snapshotProviderFailure(value.failure) === null) return null;
  return Object.freeze({ failure: value.failure, usage: value.usage });
}

export interface ModelProvider {
  streamText(input: ModelStreamTextInput): AsyncIterable<ModelChunk>;
  completeJson(input: ModelCompleteJsonInput): Promise<unknown>;
}

export interface TelegramSendMessageInput {
  chatId: string;
  text: string;
  replyToMessageId?: number;
  idempotencyKey: string;
}

export interface TelegramSendMessageResult {
  providerMessageId: string;
}

export interface TelegramProvider {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
}

export type TransientProviderFailureCategory = "timeout" | "rate_limited" | "temporarily_unavailable";
export type PermanentProviderFailureCategory = "invalid_request" | "output_limit" | "permanent_failure";
export type ProviderFailureCategory =
  | TransientProviderFailureCategory
  | PermanentProviderFailureCategory
  | "authentication"
  | "policy_denied";

export type ProviderFailureCode =
  | "provider_transient_failure"
  | "provider_authentication_failure"
  | "provider_policy_denied"
  | "provider_permanent_failure";

const providerFailureMint = Symbol("providerFailureMint");
const issuedProviderFailures = new WeakSet<object>();

/** A provider failure whose retry classification is explicit and never inferred from text. */
export class ProviderFailure extends Error {
  private constructor(
    mint: typeof providerFailureMint,
    public readonly code: ProviderFailureCode,
    public readonly category: ProviderFailureCategory,
  ) {
    super(code);
    if (mint !== providerFailureMint) throw new TypeError("provider_failure_invalid");
    this.name = "ProviderFailure";
    Object.freeze(this);
    issuedProviderFailures.add(this);
  }

  static transient(category: TransientProviderFailureCategory): ProviderFailure {
    return new ProviderFailure(providerFailureMint, "provider_transient_failure", category);
  }

  static authentication(): ProviderFailure {
    return new ProviderFailure(providerFailureMint, "provider_authentication_failure", "authentication");
  }

  static policyDenied(): ProviderFailure {
    return new ProviderFailure(providerFailureMint, "provider_policy_denied", "policy_denied");
  }

  static permanent(category: PermanentProviderFailureCategory = "permanent_failure"): ProviderFailure {
    return new ProviderFailure(providerFailureMint, "provider_permanent_failure", category);
  }
}

/** Captures only constructor-issued, frozen nominal failure facts; accessor-shaped lookalikes are rejected. */
export function snapshotProviderFailure(error: unknown): Readonly<{
  code: ProviderFailureCode;
  category: ProviderFailureCategory;
}> | null {
  if (!(error instanceof ProviderFailure) || !issuedProviderFailures.has(error) || !Object.isFrozen(error)) return null;
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(error); }
  catch { return null; }
  const codeDescriptor = descriptors.code;
  const categoryDescriptor = descriptors.category;
  if (
    codeDescriptor === undefined
    || categoryDescriptor === undefined
    || !("value" in codeDescriptor)
    || !("value" in categoryDescriptor)
    || codeDescriptor.writable !== false
    || codeDescriptor.configurable !== false
    || categoryDescriptor.writable !== false
    || categoryDescriptor.configurable !== false
  ) {
    return null;
  }
  const code = codeDescriptor.value;
  const category = categoryDescriptor.value;
  if (
    code !== "provider_transient_failure"
    && code !== "provider_authentication_failure"
    && code !== "provider_policy_denied"
    && code !== "provider_permanent_failure"
  ) {
    return null;
  }
  if (
    category !== "timeout"
    && category !== "rate_limited"
    && category !== "temporarily_unavailable"
    && category !== "invalid_request"
    && category !== "output_limit"
    && category !== "permanent_failure"
    && category !== "authentication"
    && category !== "policy_denied"
  ) {
    return null;
  }
  return Object.freeze({ code, category });
}

export function isTransientProviderFailure(error: unknown): error is ProviderFailure & {
  readonly code: "provider_transient_failure";
  readonly category: TransientProviderFailureCategory;
} {
  const failure = snapshotProviderFailure(error);
  return failure?.code === "provider_transient_failure"
    && (failure.category === "timeout" || failure.category === "rate_limited" || failure.category === "temporarily_unavailable");
}

export class ProviderIdempotencyConflictError extends Error {
  readonly code = "provider_idempotency_conflict" as const;
  readonly category = "idempotency_conflict" as const;

  constructor() {
    super("provider_idempotency_conflict");
    this.name = "ProviderIdempotencyConflictError";
  }
}

export type ProviderOperation =
  | "model.voice.streamText"
  | "model.telegram.streamText"
  | "model.completeJson"
  | "twilio.createCall"
  | "telegram.sendMessage";

declare const providerPermitBrand: unique symbol;

/** Opaque capability proving one breaker-approved provider attempt. */
export interface ProviderPermit {
  readonly operation: ProviderOperation;
  readonly [providerPermitBrand]: true;
}

export type ProviderPermitErrorCode = "provider_permit_invalid" | "provider_permit_consumed";

export class ProviderPermitError extends Error {
  readonly category = "internal_contract" as const;

  constructor(public readonly code: ProviderPermitErrorCode) {
    super(code);
    this.name = "ProviderPermitError";
  }
}

export type ProviderUnavailableCategory =
  | "voice_provider_unavailable"
  | "telegram_provider_unavailable"
  | "background_model_unavailable";

export class ProviderCircuitOpenError extends Error {
  readonly code = "provider_circuit_open" as const;

  constructor(
    public readonly operation: ProviderOperation,
    public readonly category: ProviderUnavailableCategory,
  ) {
    super("provider_circuit_open");
    this.name = "ProviderCircuitOpenError";
  }
}
