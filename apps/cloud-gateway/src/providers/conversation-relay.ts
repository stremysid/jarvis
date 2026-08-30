const MAX_RELAY_FRAME_BYTES = 64 * 1024;
const SID_PATTERNS = {
  sessionId: /^VX[0-9a-fA-F]{32}$/,
  accountSid: /^AC[0-9a-fA-F]{32}$/,
  callSid: /^CA[0-9a-fA-F]{32}$/,
} as const;
const RELAY_NONCE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const DTMF_PATTERN = /^[0-9*#]$/;

const fieldsByType = {
  setup: new Set([
    "sessionId",
    "accountSid",
    "parentCallSid",
    "callSid",
    "from",
    "to",
    "forwardedFrom",
    "callType",
    "callerName",
    "direction",
    "callStatus",
    "customParameters",
  ]),
  prompt: new Set(["voicePrompt", "lang", "last"]),
  dtmf: new Set(["digit"]),
  interrupt: new Set(["utteranceUntilInterrupt", "durationUntilInterruptMs"]),
  error: new Set(["description"]),
} as const;

type RelayEventType = keyof typeof fieldsByType;

const knownPayloadFields = new Set(
  [...Object.values(fieldsByType).flatMap((fields) => Array.from(fields)), "messageId", "text", "digits"],
);

export type RelayEvent =
  | {
      type: "setup";
      sessionId: string;
      accountSid: string;
      callSid: string;
      direction: "inbound" | "outbound";
      relayNonce: string;
    }
  | { type: "prompt"; text: string; language: string; final: boolean }
  | { type: "dtmf"; digit: string }
  | { type: "interrupt" }
  | { type: "error"; code: "conversation_relay_error" };

function invalidRelayEvent(): never {
  throw new Error("invalid_relay_event");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWellFormedString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRelayEventType(value: unknown): value is RelayEventType {
  return typeof value === "string" && Object.hasOwn(fieldsByType, value);
}

function rejectMixedKnownFields(value: Record<string, unknown>, type: RelayEventType): void {
  const allowedFields = fieldsByType[type] as ReadonlySet<string>;
  for (const field of Object.keys(value)) {
    if (field !== "type" && knownPayloadFields.has(field) && !allowedFields.has(field)) {
      invalidRelayEvent();
    }
  }
}

function hasOptionalStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || isWellFormedString(value[field]));
}

function parseSetup(value: Record<string, unknown>): RelayEvent {
  const customParameters = value.customParameters;
  if (
    typeof value.sessionId !== "string" ||
    !SID_PATTERNS.sessionId.test(value.sessionId) ||
    typeof value.accountSid !== "string" ||
    !SID_PATTERNS.accountSid.test(value.accountSid) ||
    typeof value.callSid !== "string" ||
    !SID_PATTERNS.callSid.test(value.callSid) ||
    !hasOptionalStrings(value, [
      "parentCallSid",
      "from",
      "to",
      "forwardedFrom",
      "callType",
      "callerName",
      "callStatus",
    ]) ||
    !isRecord(customParameters) ||
    Object.keys(customParameters).length !== 1 ||
    !Object.hasOwn(customParameters, "relayNonce") ||
    typeof customParameters.relayNonce !== "string" ||
    !RELAY_NONCE_PATTERN.test(customParameters.relayNonce)
  ) {
    invalidRelayEvent();
  }

  let direction: "inbound" | "outbound";
  if (value.direction === "inbound") {
    direction = "inbound";
  } else if (value.direction === "outbound-api" || value.direction === "outbound-dial") {
    direction = "outbound";
  } else {
    invalidRelayEvent();
  }

  return {
    type: "setup",
    sessionId: value.sessionId,
    accountSid: value.accountSid,
    callSid: value.callSid,
    direction,
    relayNonce: customParameters.relayNonce,
  };
}

function parsePrompt(value: Record<string, unknown>): RelayEvent {
  if (
    !isWellFormedString(value.voicePrompt) ||
    !isWellFormedString(value.lang) ||
    value.lang.length === 0 ||
    typeof value.last !== "boolean"
  ) {
    invalidRelayEvent();
  }

  return {
    type: "prompt",
    text: value.voicePrompt,
    language: value.lang,
    final: value.last,
  };
}

function parseDtmf(value: Record<string, unknown>): RelayEvent {
  if (typeof value.digit !== "string" || !DTMF_PATTERN.test(value.digit)) {
    invalidRelayEvent();
  }
  return { type: "dtmf", digit: value.digit };
}

function parseInterrupt(value: Record<string, unknown>): RelayEvent {
  if (
    !isWellFormedString(value.utteranceUntilInterrupt) ||
    typeof value.durationUntilInterruptMs !== "number" ||
    !Number.isSafeInteger(value.durationUntilInterruptMs) ||
    value.durationUntilInterruptMs < 0
  ) {
    invalidRelayEvent();
  }
  return { type: "interrupt" };
}

function parseError(value: Record<string, unknown>): RelayEvent {
  if (!isWellFormedString(value.description)) {
    invalidRelayEvent();
  }
  return { type: "error", code: "conversation_relay_error" };
}

export function parseRelayEvent(raw: string): RelayEvent {
  if (typeof raw !== "string" || raw.length > MAX_RELAY_FRAME_BYTES) {
    invalidRelayEvent();
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_RELAY_FRAME_BYTES) {
    invalidRelayEvent();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidRelayEvent();
  }
  if (!isRecord(value) || !isRelayEventType(value.type)) {
    invalidRelayEvent();
  }

  rejectMixedKnownFields(value, value.type);

  switch (value.type) {
    case "setup":
      return parseSetup(value);
    case "prompt":
      return parsePrompt(value);
    case "dtmf":
      return parseDtmf(value);
    case "interrupt":
      return parseInterrupt(value);
    case "error":
      return parseError(value);
  }
}
