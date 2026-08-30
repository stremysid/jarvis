import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import type { OperatorAuthorizationRequest, OperatorAuthorizer } from "../policy/operator-auth.js";

export type CoarseAvailability = "available" | "unavailable";

export interface LivenessRateLimiter {
  allow(): boolean | Promise<boolean>;
}

export interface LivenessDependencies {
  rateLimiter: LivenessRateLimiter;
  availability: CoarseAvailability;
}

export type ReadinessComponentState = "ready" | "degraded" | "unavailable";
export type ReadinessCapacityCategory = "normal" | "elevated" | "critical";

export interface ReadinessSnapshotV1 {
  readonly schemaVersion: "1.0";
  readonly components: Readonly<{
    database: ReadinessComponentState;
    archive: ReadinessComponentState;
    sync: ReadinessComponentState;
    policy: ReadinessComponentState;
  }>;
  readonly queueDepth: number;
  readonly syncLagSeconds: number;
  readonly capacityCategory: ReadinessCapacityCategory;
}

export interface ReadinessDependencies {
  readonly authorizer: Pick<OperatorAuthorizer, "requireEnrolledOperator">;
  readonly snapshotReader: {
    read(): unknown | Promise<unknown>;
  };
}

const READINESS_FIELDS = ["schemaVersion", "components", "queueDepth", "syncLagSeconds", "capacityCategory"] as const;
const COMPONENT_FIELDS = ["database", "archive", "sync", "policy"] as const;
const OPERATOR_FIELDS = ["operatorId"] as const;
const COMPONENT_STATES = new Set<unknown>(["ready", "degraded", "unavailable"]);
const CAPACITY_CATEGORIES = new Set<unknown>(["normal", "elevated", "critical"]);
const MAX_QUEUE_DEPTH = 10_000;
const MAX_SYNC_LAG_SECONDS = 2_592_000;
const encoder = new TextEncoder();

function publicResponse(status: 200 | 429 | 503, body: "ok" | "unavailable"): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function privateTextResponse(status: 401 | 503, body: "unauthorized" | "unavailable"): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function exactDataValues(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return null;
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null) as Record<string, PropertyDescriptor>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    descriptors[field] = descriptor;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) result[field] = descriptors[field]?.value;
  return result;
}

function validOperatorProof(value: unknown): boolean {
  const proof = exactDataValues(value, OPERATOR_FIELDS);
  const operatorId = proof?.operatorId;
  return typeof operatorId === "string" && operatorId.length > 0 && operatorId.isWellFormed()
    && operatorId === operatorId.normalize("NFC") && !operatorId.includes("\n") && !operatorId.includes("\r")
    && encoder.encode(operatorId).byteLength <= 256;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= maximum;
}

function copyReadinessSnapshot(value: unknown): ReadinessSnapshotV1 | null {
  const snapshot = exactDataValues(value, READINESS_FIELDS);
  if (snapshot === null || snapshot.schemaVersion !== "1.0") return null;
  const components = exactDataValues(snapshot.components, COMPONENT_FIELDS);
  if (components === null || COMPONENT_FIELDS.some((field) => !COMPONENT_STATES.has(components[field]))) return null;
  if (!boundedInteger(snapshot.queueDepth, MAX_QUEUE_DEPTH) || !boundedInteger(snapshot.syncLagSeconds, MAX_SYNC_LAG_SECONDS)) return null;
  if (!CAPACITY_CATEGORIES.has(snapshot.capacityCategory)) return null;

  const copiedComponents = Object.freeze({
    database: components.database as ReadinessComponentState,
    archive: components.archive as ReadinessComponentState,
    sync: components.sync as ReadinessComponentState,
    policy: components.policy as ReadinessComponentState,
  });
  return Object.freeze({
    schemaVersion: "1.0",
    components: copiedComponents,
    queueDepth: snapshot.queueDepth,
    syncLagSeconds: snapshot.syncLagSeconds,
    capacityCategory: snapshot.capacityCategory as ReadinessCapacityCategory,
  });
}

/** Public, non-diagnostic liveness boundary. Detailed readiness is authenticated separately. */
export async function handleLiveness(deps: LivenessDependencies): Promise<Response> {
  let allowed: unknown;
  try {
    allowed = await deps.rateLimiter.allow();
  } catch {
    return publicResponse(503, "unavailable");
  }
  if (allowed === false) return publicResponse(429, "unavailable");
  if (allowed !== true) return publicResponse(503, "unavailable");

  let availability: unknown;
  try {
    availability = deps.availability;
  } catch {
    return publicResponse(503, "unavailable");
  }
  return availability === "available"
    ? publicResponse(200, "ok")
    : publicResponse(503, "unavailable");
}

/** Authenticated, descriptor-validated diagnostics over an injected cached snapshot only. */
export async function handleReadiness(request: OperatorAuthorizationRequest, deps: ReadinessDependencies): Promise<Response> {
  try {
    if (!validOperatorProof(await deps.authorizer.requireEnrolledOperator(request))) {
      return privateTextResponse(401, "unauthorized");
    }
  } catch {
    return privateTextResponse(401, "unauthorized");
  }

  try {
    const snapshot = copyReadinessSnapshot(await deps.snapshotReader.read());
    if (snapshot === null) return privateTextResponse(503, "unavailable");
    const unavailable = Object.values(snapshot.components).includes("unavailable")
      || snapshot.capacityCategory === "critical";
    return new Response(canonicalJson(snapshot), {
      status: unavailable ? 503 : 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return privateTextResponse(503, "unavailable");
  }
}
