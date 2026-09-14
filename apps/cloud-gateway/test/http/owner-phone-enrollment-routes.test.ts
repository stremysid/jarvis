import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../../src/env.js";
import { SIGNED_REQUEST_HEADER } from "../../src/http/sync-routes.js";
import { OWNER_PHONE_ENROLLMENT_PATH } from "../../src/sync/owner-phone-enrollment.js";
import worker from "../../src/index.js";
import { applyFoundationMigration, clearVoiceAccessDataForTest } from "../persistence/migration.js";

const phone = "+14165550123";
const now = new Date();
const nowIso = now.toISOString();
const challengePepper = Uint8Array.from({ length: 32 }, (_, index) => index + 21);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const requestSalt = base64Url(Uint8Array.from({ length: 32 }, (_, index) => index + 91));

function dispatch(request: Request, environment: Partial<Env>): Promise<Response> {
  const fetch = worker.fetch as unknown as (
    candidate: Request,
    candidateEnv: Partial<Env>,
    context: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<Response>;
  return fetch(request, environment, { waitUntil: () => undefined });
}

describe("owner phone enrollment route", () => {
  let privateKey: CryptoKey;
  let environment: Partial<Env>;
  let nonceSeed: number;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    nonceSeed = 1;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const fingerprint = await sha256Hex(publicBytes);
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)",
    ).bind(nowIso, nowIso).run();
    await env.DB.prepare(
      `INSERT INTO device_keys (
        device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at
      ) VALUES ('device:home', 'principal:owner', 'key:home', ?, ?, 1, 'ed25519', 'active', 'home PC', ?, ?)`,
    ).bind(base64(publicBytes), fingerprint, "0".repeat(64), nowIso).run();
    environment = {
      DB: env.DB,
      OWNER_PRINCIPAL_ID: "principal:owner",
      OWNER_VOICE_IDENTITY_ID: "identity:owner:voice",
      IDENTITY_CHALLENGE_HMAC_PEPPER: base64(challengePepper),
      IDENTITY_CHALLENGE_HMAC_KEY_VERSION: "identity-hmac-v1",
    };
  });

  async function request(
    body: unknown,
    options: {
      key?: CryptoKey;
      method?: string;
      header?: string | null;
      issuedAt?: string;
      rawBody?: Uint8Array;
    } = {},
  ): Promise<Request> {
    const rawBody = options.rawBody ?? canonicalize(body as never);
    const issuedAt = options.issuedAt ?? new Date().toISOString();
    const requestNonce = base64Url(Uint8Array.from({ length: 32 }, (_, index) => (nonceSeed + index) % 256));
    nonceSeed += 1;
    const unsigned = {
      schemaVersion: "1.0",
      deviceId: "device:home",
      principalId: "principal:owner",
      audience: "jarvis-local-agent",
      issuedAt,
      nonce: requestNonce,
      bodyHash: await sha256Hex(rawBody),
    } as const;
    const message = new TextEncoder().encode([
      "POST", OWNER_PHONE_ENROLLMENT_PATH, unsigned.deviceId, unsigned.principalId,
      unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    const signed = {
      ...unsigned,
      signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", options.key ?? privateKey, message))),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.header !== null) headers[SIGNED_REQUEST_HEADER] = options.header ?? JSON.stringify(signed);
    return new Request(`https://worker.internal${OWNER_PHONE_ENROLLMENT_PATH}`, {
      method: options.method ?? "POST",
      headers,
      body: rawBody,
    });
  }

  it("serves the signed preflight without requiring Twilio or model configuration", async () => {
    const response = await dispatch(await request({ schemaVersion: "1.0", operation: "preflight" }), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: "1.0", deviceKeyMatches: true });
  });

  it("fails closed on missing enrollment configuration", async () => {
    const response = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }),
      { DB: env.DB },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "owner_phone_enrollment_not_configured" });
  });

  it("does not reveal missing enrollment configuration before device authentication", async () => {
    const unconfigured = { DB: env.DB };
    const missing = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }, { header: null }),
      unconfigured,
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "device_key_mismatch" });

    const forgedPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const forged = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }, { key: forgedPair.privateKey }),
      unconfigured,
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "device_key_mismatch" });
  });

  it.each([
    ["OWNER_PRINCIPAL_ID", "principal owner"],
    ["OWNER_VOICE_IDENTITY_ID", "identity:owner\nvoice"],
    ["OWNER_VOICE_IDENTITY_ID", "identity:owner voice"],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER", btoa("too-short")],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION", ""],
  ] as const)("fails closed on malformed %s", async (name, value) => {
    const response = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }),
      { ...environment, [name]: value },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "owner_phone_enrollment_not_configured" });
  });

  it("returns only mismatch for a forged key and never reads or logs the submitted phone", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await dispatch(
      await request({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone, requestSalt }, { key: pair.privateKey }),
      environment,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "device_key_mismatch" });
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(phone);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
    consoleSpy.mockRestore();
  });

  it("rejects extra fields only after authenticating and never returns the phone", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await dispatch(await request({
      schemaVersion: "1.0", operation: "begin", phoneNumber: phone, requestSalt, identityId: "identity:attacker",
    }), environment);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "owner_phone_enrollment_rejected" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(1);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(phone);
    consoleSpy.mockRestore();
  });

  it("begins enrollment through the production worker without exposing trusted identifiers", async () => {
    const response = await dispatch(
      await request({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone, requestSalt }),
      environment,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "pending",
    });
    expect(text).not.toContain(phone);
    expect(text).not.toContain("identity:owner:voice");
    expect(text).not.toContain("principal:owner");
    expect(text).not.toContain("device:home");
  });

  it.each(["14165550123", "+1 4165550123", "+0123456789"])(
    "rejects non-canonical E.164 %s without enrollment state",
    async (invalidPhone) => {
      const response = await dispatch(await request({
        schemaVersion: "1.0", operation: "begin", phoneNumber: invalidPhone, requestSalt,
      }), environment);
      expect(response.status).toBe(400);
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_owner_identity").first<{ count: number }>())?.count).toBe(0);
    },
  );

  it.each([
    { schemaVersion: "1.0", operation: "begin", phoneNumber: phone },
    { schemaVersion: "1.0", operation: "begin", phoneNumber: phone, requestSalt: "short" },
  ])("requires a canonical 32-byte request salt on begin", async (body) => {
    const response = await dispatch(await request(body), environment);
    expect(response.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it("returns a distinct fixed clock-skew code for an expired signed request", async () => {
    const response = await dispatch(await request(
      { schemaVersion: "1.0", operation: "preflight" },
      { issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    ), environment);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "signed_request_expired" });
  });

  it("maps an authenticated service principal refusal to the fixed key-mismatch response", async () => {
    await env.DB.prepare("UPDATE principals SET principal_type = 'service' WHERE principal_id = 'principal:owner'").run();
    const response = await dispatch(await request({ schemaVersion: "1.0", operation: "preflight" }), environment);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "device_key_mismatch" });
  });

  it("never logs raw storage text that contains the submitted phone", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER owner_phone_test_failure BEFORE INSERT ON identity_challenges
       BEGIN SELECT RAISE(ABORT, '${phone}'); END`,
    ).run();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await dispatch(await request({
        schemaVersion: "1.0", operation: "begin", phoneNumber: phone, requestSalt,
      }), environment);
      expect(response.status).toBe(500);
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(phone);
    } finally {
      consoleSpy.mockRestore();
      await env.DB.prepare("DROP TRIGGER owner_phone_test_failure").run();
    }
  });

  it.each([
    `{"operation":"begin", "phoneNumber":"${phone}","requestSalt":"${requestSalt}","schemaVersion":"1.0"}`,
    `{"operation":"preflight","operation":"begin","phoneNumber":"${phone}","requestSalt":"${requestSalt}","schemaVersion":"1.0"}`,
  ])("classifies a validly signed non-canonical body as a client rejection", async (text) => {
    const response = await dispatch(await request(null, { rawBody: new TextEncoder().encode(text) }), environment);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "owner_phone_enrollment_rejected" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it.each(["GET", "PUT", "DELETE"])("refuses %s before reading a body", async (method) => {
    const response = await dispatch(new Request(`https://worker.internal${OWNER_PHONE_ENROLLMENT_PATH}`, { method }), environment);
    expect(response.status).toBe(405);
  });

  it("refuses a missing or malformed signed envelope without storage", async () => {
    const missing = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }, { header: null }), environment,
    );
    expect(missing.status).toBe(401);
    const malformed = await dispatch(
      await request({ schemaVersion: "1.0", operation: "preflight" }, { header: "{" }), environment,
    );
    expect(malformed.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(0);
  });

  it("cancels a body above the enrollment limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    });
    const response = await dispatch(new Request(`https://worker.internal${OWNER_PHONE_ENROLLMENT_PATH}`, {
      method: "POST",
      headers: { [SIGNED_REQUEST_HEADER]: "{}" },
      body,
      duplex: "half",
    } as RequestInit), environment);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });
});
