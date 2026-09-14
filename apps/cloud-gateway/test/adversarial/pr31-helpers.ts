// Adversarial helpers for PR #31 (owner phone enrollment). Test-only; synthetic data.
// v2 (re-run against 327ddda): the route now requires OWNER_PRINCIPAL_ID and a begin body carries a
// canonical base64url 32-byte requestSalt. Only construction changed here; every attack is unchanged.
import { env } from "cloudflare:test";
import { canonicalize, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../../src/env.js";
import { SIGNED_REQUEST_HEADER } from "../../src/http/sync-routes.js";
import { OWNER_PHONE_ENROLLMENT_PATH } from "../../src/sync/owner-phone-enrollment.js";
import worker from "../../src/index.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

/** Twilio magic test number; never a real subscriber. */
export const PHONE = "+15005550006";
export const OTHER_PHONE = "+15005550007";
export const OWNER_PRINCIPAL = "principal:owner";
export const OWNER_IDENTITY = "identity:owner:voice";
export const KEY_VERSION = "identity-hmac-v1";
export const PEPPER = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256);
export const AUDIENCE = "jarvis-local-agent";
const encoder = new TextEncoder();

/** Fixed synthetic salt: canonical base64url of 32 bytes, as `requestSalt` requires since 327ddda. */
export const REQUEST_SALT = b64url(Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) % 256));
export const BEGIN = Object.freeze({
  schemaVersion: "1.0", operation: "begin", phoneNumber: PHONE, requestSalt: REQUEST_SALT,
} as const);
export const PREFLIGHT = Object.freeze({ schemaVersion: "1.0", operation: "preflight" } as const);
export const STATUS = Object.freeze({ schemaVersion: "1.0", operation: "status" } as const);

export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function freshNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface Device {
  readonly deviceId: string;
  readonly principalId: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly fingerprint: string;
  readonly publicBase64: string;
  readonly generation: number;
}

export async function resetEnrollmentState(): Promise<void> {
  await applyFoundationMigration();
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearConversationDataForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM request_nonces"),
    env.DB.prepare("DELETE FROM identity_challenges"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM consumer_cursors"),
    env.DB.prepare("DELETE FROM bootstrap_tokens"),
    env.DB.prepare("DELETE FROM device_keys"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

export async function seedPrincipal(principalId: string, type: "human" | "service" = "human"): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, ?, 'active', 'synthetic', ?, ?)",
  ).bind(principalId, type, now, now).run();
}

export async function generateKey(): Promise<{ privateKey: CryptoKey; publicBase64: string; fingerprint: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicBase64: b64(publicBytes), fingerprint: await sha256Hex(publicBytes) };
}

export async function seedDevice(deviceId: string, principalId: string, keyId: string, generation = 1): Promise<Device> {
  const key = await generateKey();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO device_keys (
       device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
       algorithm, status, device_label, bootstrap_metadata_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'ed25519', 'active', 'adversarial', ?, ?)`,
  ).bind(deviceId, principalId, keyId, key.publicBase64, key.fingerprint, generation, "0".repeat(64), now).run();
  return { deviceId, principalId, keyId, generation, ...key };
}

/** Replace a device's key in place, the way a key rotation bumps the generation. */
export async function rotateDeviceKey(device: Device, newKeyId: string): Promise<Device> {
  const key = await generateKey();
  const generation = device.generation + 1;
  await env.DB.prepare(
    "UPDATE device_keys SET key_id = ?, public_key_base64 = ?, key_fingerprint = ?, key_generation = ? WHERE device_id = ?",
  ).bind(newKeyId, key.publicBase64, key.fingerprint, generation, device.deviceId).run();
  return { ...device, keyId: newKeyId, generation, ...key };
}

export interface SignOptions {
  readonly key?: CryptoKey;
  readonly deviceId?: string;
  readonly principalId?: string;
  readonly audience?: string;
  readonly path?: string;
  readonly method?: string;
  readonly issuedAt?: string;
  readonly nonce?: string;
  /** Bytes actually transmitted. Defaults to the canonical body. */
  readonly rawBody?: Uint8Array;
  /** Bytes whose hash is signed. Defaults to the transmitted bytes. */
  readonly signedBytes?: Uint8Array;
}

export interface SignedParts {
  readonly header: string | null;
  readonly rawBody: Uint8Array;
}

export async function signParts(device: Device, body: unknown, options: SignOptions = {}): Promise<SignedParts> {
  const rawBody = options.rawBody ?? canonicalize(body as never);
  const unsigned = {
    schemaVersion: "1.0",
    deviceId: options.deviceId ?? device.deviceId,
    principalId: options.principalId ?? device.principalId,
    audience: options.audience ?? AUDIENCE,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    nonce: options.nonce ?? freshNonce(),
    bodyHash: await sha256Hex(options.signedBytes ?? rawBody),
  };
  const message = encoder.encode([
    options.method ?? "POST", options.path ?? OWNER_PHONE_ENROLLMENT_PATH, unsigned.deviceId, unsigned.principalId,
    unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
  ].join("\n"));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", options.key ?? device.privateKey, message));
  return { header: JSON.stringify({ ...unsigned, signatureBase64: b64(signature) }), rawBody };
}

export function enrollmentRequest(parts: SignedParts, method = "POST", path = OWNER_PHONE_ENROLLMENT_PATH): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (parts.header !== null) headers[SIGNED_REQUEST_HEADER] = parts.header;
  return new Request(`https://worker.internal${path}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: parts.rawBody }),
  });
}

export function enrollmentEnvironment(overrides: Partial<Env> = {}): Partial<Env> {
  return {
    DB: env.DB,
    OWNER_PRINCIPAL_ID: OWNER_PRINCIPAL,
    OWNER_VOICE_IDENTITY_ID: OWNER_IDENTITY,
    IDENTITY_CHALLENGE_HMAC_PEPPER: b64(PEPPER),
    IDENTITY_CHALLENGE_HMAC_KEY_VERSION: KEY_VERSION,
    ...overrides,
  };
}

export function dispatch(request: Request, environment: Partial<Env>): Promise<Response> {
  const fetch = worker.fetch as unknown as (
    candidate: Request,
    candidateEnv: Partial<Env>,
    context: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<Response>;
  return fetch(request, environment, { waitUntil: () => undefined });
}

export async function send(
  device: Device,
  body: unknown,
  environment: Partial<Env>,
  options: SignOptions = {},
): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
  const response = await dispatch(enrollmentRequest(await signParts(device, body, options)), environment);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json, headers: response.headers };
}

export async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count ?? -1;
}

export async function stateCounts(): Promise<{ identities: number; owners: number; challenges: number; nonces: number }> {
  return {
    identities: await count("channel_identities"),
    owners: await count("voice_owner_identity"),
    challenges: await count("identity_challenges"),
    nonces: await count("request_nonces"),
  };
}

/** Every user table's rows as JSON text, for plaintext scans. */
export async function dumpAllTables(except: readonly string[] = []): Promise<Record<string, string>> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  ).all<{ name: string }>();
  const dump: Record<string, string> = {};
  for (const { name } of tables.results) {
    if (except.includes(name)) continue;
    try {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      dump[name] = JSON.stringify(rows.results);
    } catch (error) {
      dump[name] = `unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return dump;
}
