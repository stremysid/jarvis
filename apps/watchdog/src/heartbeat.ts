/**
 * POST /heartbeat -- how a component says it is still there.
 *
 * Authenticated with a shared secret, compared in constant time, before the
 * body is read. That is not ceremony. The only thing this endpoint can do is
 * make a component look alive, so an unauthenticated one lets anyone silence
 * the watchdog for the component they most want unwatched, and the resulting
 * system reports that everything is fine using exactly the words it uses when
 * everything is fine. That is worse than having no watchdog, because it
 * converts "I would have noticed" into "I was told it was fine."
 */

import type { LivenessStore } from "./liveness-store.js";
import { bearerCredential, secretsMatch } from "./shared-secret.js";
import type { Clock } from "./watchdog-run.js";

export const HEARTBEAT_PATH = "/heartbeat";

/** Matches the CHECK in the gateway's 0012_liveness.sql. Copied, not imported. */
const MAX_COMPONENT_CHARACTERS = 64;
const MAX_DETAIL_CHARACTERS = 256;

/**
 * The longest silence a component may declare normal.
 *
 * The interval is per component precisely so a local agent that sleeps
 * overnight is not held to a cron's schedule, so it has to be generous. It
 * cannot be unbounded: a component that could declare a one-year interval
 * could switch off the alerting for itself, and a compromised or simply buggy
 * component asking never to be checked again is the failure mode this whole
 * Worker exists to refuse.
 */
const MAX_EXPECTED_INTERVAL_SECONDS = 172_800;

/** A heartbeat is a handful of short fields; anything larger is not one. */
const MAX_BODY_BYTES = 1024;

export interface HeartbeatDependencies {
  readonly store: LivenessStore;
  readonly clock: Clock;
  readonly secret: string;
}

export interface HeartbeatReport {
  readonly component: string;
  readonly expectedIntervalSeconds: number;
  readonly detail: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Narrow a decoded body into a heartbeat, or reject it.
 *
 * Unknown keys are refused rather than ignored. The tempting one to send is
 * `suppressedUntil`, and a caller that sends it and gets a 200 would believe
 * it had arranged for a maintenance window that does not exist. Suppression is
 * an operator's decision made against the database directly; a heartbeat can
 * only clear one.
 */
export function parseHeartbeat(value: unknown): HeartbeatReport | null {
  if (!isPlainObject(value)) return null;

  for (const key of Object.keys(value)) {
    if (key !== "component" && key !== "expectedIntervalSeconds" && key !== "detail") return null;
  }

  const { component, expectedIntervalSeconds, detail } = value;
  if (typeof component !== "string") return null;
  if (component.length === 0 || component.length > MAX_COMPONENT_CHARACTERS) return null;

  if (typeof expectedIntervalSeconds !== "number") return null;
  if (!Number.isSafeInteger(expectedIntervalSeconds)) return null;
  if (expectedIntervalSeconds <= 0 || expectedIntervalSeconds > MAX_EXPECTED_INTERVAL_SECONDS) return null;

  if (detail !== undefined && detail !== null) {
    if (typeof detail !== "string" || detail.length > MAX_DETAIL_CHARACTERS) return null;
  }

  return {
    component,
    expectedIntervalSeconds,
    detail: typeof detail === "string" ? detail : null,
  };
}

function refuse(status: number, reason: string): Response {
  return new Response(JSON.stringify({ ok: false, reason }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleHeartbeat(
  request: Request,
  dependencies: HeartbeatDependencies,
): Promise<Response> {
  if (request.method !== "POST") return refuse(405, "method_not_allowed");

  // The credential is checked first, and against a value that is always
  // present: `bearerCredential` returns the empty string for a missing or
  // malformed header, so a request with no credential takes the same path as
  // one with a wrong credential.
  if (!secretsMatch(bearerCredential(request.headers.get("authorization")), dependencies.secret)) {
    return refuse(401, "unauthenticated");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return refuse(413, "body_too_large");
  }

  let decoded: unknown;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return refuse(413, "body_too_large");
    decoded = JSON.parse(body);
  } catch {
    return refuse(400, "unreadable_body");
  }

  const report = parseHeartbeat(decoded);
  if (report === null) return refuse(400, "invalid_heartbeat");

  const seenAt = dependencies.clock.now().toISOString();
  try {
    await dependencies.store.recordHeartbeat({
      component: report.component,
      expectedIntervalSeconds: report.expectedIntervalSeconds,
      detail: report.detail,
      seenAt,
    });
  } catch {
    // 500 rather than a cheerful 200: a component told the watchdog it was
    // alive and the watchdog failed to remember. Answering ok would leave the
    // component believing it had reported in, and it would go on believing
    // that right up until it was alerted about.
    return refuse(500, "not_recorded");
  }

  return new Response(JSON.stringify({ ok: true, component: report.component, seenAt }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
