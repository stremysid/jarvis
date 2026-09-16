import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../../src/env.js";
import { SIGNED_REQUEST_HEADER } from "../../src/http/sync-routes.js";
import worker from "../../src/index.js";
import { OWNER_PASSPHRASE_PATH } from "../../src/sync/owner-passphrase.js";
import {
  applyOwnerPassphraseMigration,
  clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function dispatch(request: Request, environment: Partial<Env>): Promise<Response> {
  const fetch = worker.fetch as unknown as (
    candidate: Request,
    candidateEnv: Partial<Env>,
    context: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<Response>;
  return fetch(request, environment, { waitUntil: () => undefined });
}

function expectNoPassphraseWordsStored(
  storage: { results: Array<{ salt: string; digest: string; created_by_key_id: string }> },
  phrase: string,
): void {
  for (const word of phrase.split(" ")) {
    const wordHex = Array.from(new TextEncoder().encode(word), (byte) => (
      byte.toString(16).padStart(2, "0")
    )).join("").toUpperCase();
    for (const { salt, digest, created_by_key_id: createdByKeyId } of storage.results) {
      expect(salt).not.toContain(wordHex);
      expect(digest).not.toContain(wordHex);
      expect(createdByKeyId).not.toContain(word);
    }
  }
}

describe("owner passphrase route", () => {
  let privateKey: CryptoKey;
  let environment: Partial<Env>;
  let nonceSeed: number;
  const now = new Date();
  const nowIso = now.toISOString();

  beforeEach(async () => {
    await applyOwnerPassphraseMigration();
    await clearOwnerPassphraseDataForTest();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    nonceSeed = 1;
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(publicKey instanceof ArrayBuffer)) throw new Error("unexpected_public_key_shape");
    const publicBytes = new Uint8Array(publicKey);
    const fingerprint = await sha256Hex(publicBytes);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)",
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO device_keys (
          device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
          algorithm, status, device_label, bootstrap_metadata_hash, created_at
        ) VALUES ('device:home', 'principal:owner', 'key:home', ?, ?, 1, 'ed25519', 'active', 'home PC', ?, ?)`,
      ).bind(base64(publicBytes), fingerprint, "0".repeat(64), nowIso),
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
        ) VALUES ('identity:owner:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?, 'device:home')`,
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:owner:voice', ?)",
      ).bind(nowIso),
    ]);
    environment = {
      DB: env.DB,
      OWNER_PRINCIPAL_ID: "principal:owner",
      OWNER_VOICE_IDENTITY_ID: "identity:owner:voice",
      OWNER_PASSPHRASE_PEPPER_V1: base64(new Uint8Array(32).fill(41)),
    };
  });

  afterEach(clearOwnerPassphraseDataForTest);

  async function signedRequest(body: unknown, options: { key?: CryptoKey; header?: string | null } = {}): Promise<Request> {
    const rawBody = canonicalize(body as never);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: "device:home",
      principalId: "principal:owner",
      audience: "jarvis-local-agent",
      issuedAt: new Date().toISOString(),
      nonce: base64Url(Uint8Array.from({ length: 32 }, (_, index) => nonceSeed + index)),
      bodyHash: await sha256Hex(rawBody),
    };
    nonceSeed += 1;
    const message = new TextEncoder().encode([
      "POST", OWNER_PASSPHRASE_PATH, unsigned.deviceId, unsigned.principalId,
      unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    const envelope = {
      ...unsigned,
      signatureBase64: base64(new Uint8Array(await crypto.subtle.sign(
        "Ed25519", options.key ?? privateKey, message,
      ))),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.header !== null) headers[SIGNED_REQUEST_HEADER] = options.header ?? JSON.stringify(envelope);
    return new Request(`https://worker.internal${OWNER_PASSPHRASE_PATH}`, {
      method: "POST", headers, body: rawBody,
    });
  }

  it("serves signed status without exposing an existing phrase", async () => {
    const response = await dispatch(await signedRequest({ schemaVersion: "1.0", operation: "status" }), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: null, verifierStatus: null,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("generates inside the Worker and stores no plaintext while returning it once", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await dispatch(await signedRequest({
        schemaVersion: "1.0", operation: "generate", expectedVerifierVersion: null,
        requestSalt: base64Url(new Uint8Array(32).fill(7)),
      }), environment);
      expect(response.status).toBe(200);
      const result = await response.json<{ phrase: string; verifierVersion: number; verifierStatus: string }>();
      expect(result.phrase).toMatch(/^[a-z]{4,8} [a-z]{4,8} [a-z]{4,8}$/u);
      expect(result.verifierVersion).toBe(1);
      expect(result.verifierStatus).toBe("active");
      const storage = await env.DB.prepare(
        "SELECT hex(salt) AS salt, hex(digest) AS digest, created_by_key_id FROM owner_passphrase_verifiers",
      ).all<{ salt: string; digest: string; created_by_key_id: string }>();
      expectNoPassphraseWordsStored(storage, result.phrase);
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(result.phrase);

      const status = await dispatch(await signedRequest({ schemaVersion: "1.0", operation: "status" }), environment);
      expect(await status.json()).toEqual({
        schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: 1, verifierStatus: "active",
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("ignores D1 envelope metadata when checking stored passphrase words", () => {
    const storage = {
      results: [{ salt: "AA", digest: "BB", created_by_key_id: "key:home" }],
      meta: { served_by: "miniflare.db" },
    };
    expect(JSON.stringify(storage)).toContain("serve");
    expect(JSON.stringify(storage.results)).toContain("salt");
    expectNoPassphraseWordsStored(storage, "serve salt bloom");
  });

  it("rejects a digest containing a passphrase word encoded as hex", () => {
    const storage = {
      results: [{ salt: "AA", digest: "AA7365727665BB", created_by_key_id: "key:home" }],
    };
    expect(() => expectNoPassphraseWordsStored(storage, "serve salt bloom")).toThrow();
  });

  it("does not reveal missing configuration before authenticating the device", async () => {
    const missing = await dispatch(
      await signedRequest({ schemaVersion: "1.0", operation: "status" }, { header: null }), { DB: env.DB },
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "device_key_mismatch" });

    const forgedPair = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    const forged = await dispatch(
      await signedRequest({ schemaVersion: "1.0", operation: "status" }, { key: forgedPair.privateKey }),
      { DB: env.DB },
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "device_key_mismatch" });
  });

  it.each([
    ["OWNER_PRINCIPAL_ID", "principal owner"],
    ["OWNER_VOICE_IDENTITY_ID", "identity:owner voice"],
    ["OWNER_PASSPHRASE_PEPPER_V1", btoa("short")],
  ] as const)("fails closed on malformed %s after valid authentication", async (name, value) => {
    const response = await dispatch(
      await signedRequest({ schemaVersion: "1.0", operation: "status" }),
      { ...environment, [name]: value },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "owner_passphrase_not_configured" });
  });

  it.each([
    ["OWNER_PRINCIPAL_ID", "principal:other"],
    ["OWNER_VOICE_IDENTITY_ID", "identity:other:voice"],
  ] as const)("returns a distinct fixed error when configured %s does not match the authenticated device", async (name, value) => {
    const response = await dispatch(
      await signedRequest({ schemaVersion: "1.0", operation: "status" }),
      { ...environment, [name]: value },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "owner_passphrase_owner_mismatch" });
  });

  it("maps a stale compare-and-swap expectation to a fixed conflict", async () => {
    const body = {
      schemaVersion: "1.0", operation: "generate", expectedVerifierVersion: null,
      requestSalt: base64Url(new Uint8Array(32).fill(9)),
    };
    expect((await dispatch(await signedRequest(body), environment)).status).toBe(200);
    const conflict = await dispatch(await signedRequest({ ...body, requestSalt: base64Url(new Uint8Array(32).fill(10)) }), environment);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "owner_passphrase_state_changed" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first())
      .toEqual({ count: 1 });
  });

  it("refuses methods and oversized bodies before generating", async () => {
    const method = await dispatch(new Request(`https://worker.internal${OWNER_PASSPHRASE_PATH}`, { method: "GET" }), environment);
    expect(method.status).toBe(405);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)); },
      cancel() { cancelled = true; },
    });
    const oversized = await dispatch(new Request(`https://worker.internal${OWNER_PASSPHRASE_PATH}`, {
      method: "POST", headers: { [SIGNED_REQUEST_HEADER]: "{}" }, body, duplex: "half",
    } as RequestInit), environment);
    expect(oversized.status).toBe(413);
    expect(cancelled).toBe(true);
  });
});
