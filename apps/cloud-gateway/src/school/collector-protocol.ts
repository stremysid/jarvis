import { type JsonValue, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { decodeCanonicalBase64, decodeCanonicalRawBody, signatureText, validateRequest } from "../sync/signed-request.js";
import { requireInstant, requireText } from "../deadlines/deadline-types.js";

export const SCHOOL_AUDIENCE = "jarvis-school-collector";
export const SCHOOL_HOST = "ldsb.elearningontario.ca";
export const SCHOOL_BODY_LIMIT = 65_536;
export const SCHOOL_PAIR_ORIGIN = "school-collector-pair";
export const SCHOOL_PAIR_TTL_MS = 10 * 60_000;

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("school_object_invalid");
  return value as Record<string, unknown>;
}

export function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).sort().join(",") !== [...fields].sort().join(",")) throw new Error("school_fields_invalid");
  return result;
}

export function identifier(value: unknown): string {
  const result = requireText(value, "school_id", 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("school_id_invalid");
  return result;
}

export interface RouteEvidence {
  readonly route: string;
  readonly status: number;
  readonly fetchedAt: string;
  readonly complete: boolean;
  readonly body: JsonValue;
}

export interface SchoolBatch {
  readonly schemaVersion: "1.0";
  readonly host: typeof SCHOOL_HOST;
  readonly readId: string;
  readonly startedAt: string;
  readonly courseIds: readonly string[];
  readonly enrollmentComplete: boolean;
  readonly course: { readonly id: string; readonly name: string };
  readonly routes: readonly RouteEvidence[];
}

export function parseSchoolBatch(value: unknown, now: Date): SchoolBatch {
  const root = exact(value, ["schemaVersion", "host", "readId", "startedAt", "courseIds", "enrollmentComplete", "course", "routes"]);
  if (root.schemaVersion !== "1.0" || root.host !== SCHOOL_HOST) throw new Error("school_source_invalid");
  identifier(root.readId);
  const startedAt = requireInstant(root.startedAt as string, "school_started_at");
  if (Date.parse(startedAt) > now.getTime()) throw new Error("school_time_future");
  const course = exact(root.course, ["id", "name"]);
  const courseId = identifier(course.id);
  requireText(course.name, "school_course_name", 512);
  if (!Array.isArray(root.courseIds) || root.courseIds.length === 0 || root.courseIds.length > 128
    || root.courseIds.some((id) => identifier(id) !== id) || new Set(root.courseIds).size !== root.courseIds.length
    || !root.courseIds.includes(courseId) || typeof root.enrollmentComplete !== "boolean") throw new Error("school_manifest_invalid");
  if (!Array.isArray(root.routes) || root.routes.length > 256) throw new Error("school_routes_invalid");
  const prefix = `/d2l/api/le/1.82/${courseId}/`;
  const myItemsRoute = `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${courseId}`;
  const seen = new Set<string>();
  for (const value of root.routes) {
    const route = exact(value, ["route", "status", "fetchedAt", "complete", "body"]);
    if (typeof route.route !== "string" || !(route.route === myItemsRoute || route.route.startsWith(prefix)
      && /^(dropbox\/folders\/|dropbox\/folders\/[a-zA-Z0-9_-]+\/submissions\/(mysubmissions\/)?|content\/toc|grades\/values\/myGradeValues\/)$/.test(route.route.slice(prefix.length)))
      || seen.has(route.route)) throw new Error("school_route_invalid");
    seen.add(route.route);
    if (!Number.isInteger(route.status) || !(route.status === 0 || Number(route.status) >= 100 && Number(route.status) <= 599)
      || typeof route.complete !== "boolean") throw new Error("school_route_status_invalid");
    const at = requireInstant(route.fetchedAt as string, "school_fetched_at");
    if (at < startedAt || Date.parse(at) > now.getTime()) throw new Error("school_time_invalid");
  }
  return value as SchoolBatch;
}

export interface CollectorKey {
  collector_id: string;
  principal_id: string;
  public_key_base64: string;
  device_label: string;
  status: "pending" | "active" | "revoked";
  challenge: string;
  pairing_code: string;
  expires_at: string;
  decision_id: string | null;
}

/** The shared wire parser confers no authority. Only this registry does. */
export async function verifyCollectorRequest(
  database: D1Database, owner: string, header: unknown, path: string, raw: Uint8Array, now: Date,
  status: "pending" | "active",
): Promise<{ key: CollectorKey; body: JsonValue; bodyHash: string }> {
  const envelope = validateRequest(header);
  if (envelope.audience !== SCHOOL_AUDIENCE || envelope.principalId !== owner) throw new Error("school_authority_invalid");
  if (Math.abs(now.getTime() - Date.parse(envelope.issuedAt)) >= 300_000) throw new Error("school_signature_expired");
  const key = await database.prepare(`SELECT k.* FROM school_collector_keys k JOIN principals p ON p.principal_id = k.principal_id
    WHERE k.collector_id = ? AND k.principal_id = ? AND k.status = ? AND p.status = 'active'
      AND (k.status = 'active' OR k.expires_at > ?)`)
    .bind(envelope.deviceId, owner, status, now.toISOString()).first<CollectorKey>();
  if (key === null) throw new Error("school_key_inactive");
  const publicKey = await crypto.subtle.importKey("raw", decodeCanonicalBase64(key.public_key_base64, 32), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", publicKey, decodeCanonicalBase64(envelope.signatureBase64, 64), signatureText(envelope, "POST", path))) {
    throw new Error("school_signature_invalid");
  }
  if (await sha256Hex(raw) !== envelope.bodyHash) throw new Error("school_body_hash_invalid");
  const body = decodeCanonicalRawBody(raw);
  // Recheck status inside the insert so a revoke racing signature verification wins.
  const inserted = await database.prepare(`INSERT INTO school_collector_nonces (collector_id, nonce, used_at)
    SELECT collector_id, ?, ? FROM school_collector_keys WHERE collector_id = ? AND status = ?
    ON CONFLICT DO NOTHING RETURNING collector_id`).bind(envelope.nonce, now.toISOString(), key.collector_id, status)
    .first();
  if (inserted === null) throw new Error("school_nonce_refused");
  return { key, body, bodyHash: envelope.bodyHash };
}
