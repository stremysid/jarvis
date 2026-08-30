import type { Ulid } from "../../../../packages/contracts/src/index.js";

const ALLOWED_FIELDS = Object.freeze([
  "eventId",
  "correlationId",
  "component",
  "operation",
  "durationMs",
  "outcome",
  "errorCategory",
] as const);
const ALLOWED_FIELD_SET = new Set<string>(ALLOWED_FIELDS);
const REQUIRED_FIELDS = Object.freeze(["eventId", "correlationId", "component", "operation", "outcome"] as const);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export const SAFE_LOG_COMPONENTS = Object.freeze([
  "archive",
  "calls",
  "http",
  "persistence",
  "policy",
  "provider",
  "sync",
] as const);

export const SAFE_LOG_OPERATIONS = Object.freeze([
  "acknowledge",
  "append",
  "archive",
  "dispatch",
  "liveness",
  "pull",
  "read",
] as const);

export const SAFE_ERROR_CATEGORIES = Object.freeze([
  "validation_failed",
  "authorization_denied",
  "rate_limited",
  "dependency_unavailable",
  "integrity_failure",
  "internal_failure",
] as const);

export type SafeErrorCategory = typeof SAFE_ERROR_CATEGORIES[number];
export type SafeLogComponent = typeof SAFE_LOG_COMPONENTS[number];
export type SafeLogOperation = typeof SAFE_LOG_OPERATIONS[number];
export type SafeLogOutcome = "ok" | "denied" | "error" | "unavailable";

export interface SafeLogRecord {
  eventId: Ulid;
  correlationId: Ulid;
  component: SafeLogComponent;
  operation: SafeLogOperation;
  durationMs?: number;
  outcome: SafeLogOutcome;
  errorCategory?: SafeErrorCategory;
}

type ExactSafeLogRecord<T extends SafeLogRecord> = T & Record<Exclude<keyof T, keyof SafeLogRecord>, never>;
type DescriptorMap = Map<string, PropertyDescriptor>;

function unsafeLogField(): never {
  throw new TypeError("unsafe_log_field");
}

function inspectRecord(value: unknown): DescriptorMap {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return unsafeLogField();
    }
    const keys = Reflect.ownKeys(value);
    const descriptors: DescriptorMap = new Map();
    for (const key of keys) {
      if (typeof key !== "string" || !ALLOWED_FIELD_SET.has(key)) return unsafeLogField();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        return unsafeLogField();
      }
      descriptors.set(key, descriptor);
    }
    if (REQUIRED_FIELDS.some((field) => !descriptors.has(field))) return unsafeLogField();
    return descriptors;
  } catch (error) {
    if (error instanceof TypeError && error.message === "unsafe_log_field") throw error;
    return unsafeLogField();
  }
}

function validatedRecord(value: unknown): Readonly<SafeLogRecord> {
  const descriptors = inspectRecord(value);
  const get = (field: string): unknown => descriptors.get(field)?.value;
  const eventId = get("eventId");
  const correlationId = get("correlationId");
  const component = get("component");
  const operation = get("operation");
  const durationMs = get("durationMs");
  const outcome = get("outcome");
  const errorCategory = get("errorCategory");

  if (typeof eventId !== "string" || !ULID.test(eventId)
    || typeof correlationId !== "string" || !ULID.test(correlationId)
    || typeof component !== "string" || !SAFE_LOG_COMPONENTS.includes(component as SafeLogComponent)
    || typeof operation !== "string" || !SAFE_LOG_OPERATIONS.includes(operation as SafeLogOperation)
    || (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0))
    || (outcome !== "ok" && outcome !== "denied" && outcome !== "error" && outcome !== "unavailable")
    || (errorCategory !== undefined && !SAFE_ERROR_CATEGORIES.includes(errorCategory as SafeErrorCategory))) {
    return unsafeLogField();
  }

  const safe: SafeLogRecord = {
    eventId: eventId as Ulid,
    correlationId: correlationId as Ulid,
    component: component as SafeLogComponent,
    operation: operation as SafeLogOperation,
    outcome,
  };
  if (durationMs !== undefined) safe.durationMs = durationMs;
  if (errorCategory !== undefined) safe.errorCategory = errorCategory as SafeErrorCategory;
  return Object.freeze(safe);
}

/** Emits only a copied, descriptor-validated allowlist of non-sensitive fields. */
export class SafeLogger {
  constructor(private readonly sink: (record: Readonly<SafeLogRecord>) => void) {}

  info<T extends SafeLogRecord>(record: ExactSafeLogRecord<T>): void {
    this.sink(validatedRecord(record));
  }
}
