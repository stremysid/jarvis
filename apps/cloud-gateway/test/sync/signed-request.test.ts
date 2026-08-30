import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const audience = "jarvis-local-agent";
const method = "POST" as const;
const path = "/sync/pull";

interface TestBody { schemaVersion: "1.0"; message: string; }

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function nonce(seed = 1): string {
  return base64Url(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
}

function validateBody(value: unknown): TestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("test_body_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("schemaVersion") || !keys.includes("message")) throw new TypeError("test_body_invalid");
  const body = value as Record<string, unknown>;
  if (body.schemaVersion !== "1.0" || typeof body.message !== "string") throw new TypeError("test_body_invalid");
  return body as unknown as TestBody;
}

async function signingText(request: Omit<SignedRequestV1, "signatureBase64">, signedMethod = method, signedPath = path): Promise<Uint8Array> {
  return new TextEncoder().encode([
    signedMethod, signedPath, request.deviceId, request.principalId, request.audience, request.issuedAt, request.nonce, request.bodyHash,
  ].join("\n"));
}

describe("DeviceRequestVerifier", () => {
  let privateKey: CryptoKey;
  let publicKeyBase64: string;
  let keyFingerprint: string;
  let verifier: DeviceRequestVerifier;

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    publicKeyBase64 = base64(rawPublicKey);
    keyFingerprint = await sha256Hex(rawPublicKey);
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:one', 'human', 'active', 'Sid', '1.0', 'PIN_VERIFIER_JSON', ?, ?)",
    ).bind(now.toISOString(), now.toISOString()).run();
    await env.DB.prepare(
      "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:one', 'principal:one', 'key:one', ?, ?, 1, 'ed25519', 'active', 'laptop', ?, ?)",
    ).bind(publicKeyBase64, keyFingerprint, "0".repeat(64), now.toISOString()).run();
    verifier = new DeviceRequestVerifier({ database: env.DB, audience });
  });

  async function signed(rawBody: Uint8Array, overrides: Partial<Omit<SignedRequestV1, "signatureBase64">> = {}, signedMethod = method, signedPath = path): Promise<SignedRequestV1> {
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: "device:one",
      principalId: "principal:one",
      audience,
      issuedAt: now.toISOString(),
      nonce: nonce(),
      bodyHash: await sha256Hex(rawBody),
      ...overrides,
    };
    return { ...unsigned, signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, await signingText(unsigned, signedMethod, signedPath)))) };
  }

  function canonicalBody(message = "hello") {
    const body: TestBody = { schemaVersion: "1.0", message };
    return { body, rawBody: canonicalize(body) };
  }

  async function nonceCount(): Promise<number> {
    return (await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count ?? -1;
  }

  it("returns an immutable proof bound to the authoritative canonical body, audience, and exact current key tuple", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);

    const proof = await verifier.verify(request, method, path, body, rawBody, now, validateBody);

    expect(proof).toMatchObject({
      deviceId: "device:one", principalId: "principal:one", audience, bodyHash: request.bodyHash,
      keyId: "key:one", keyFingerprint, keyGeneration: 1, body,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.body)).toBe(true);
    expect(await nonceCount()).toBe(1);
  });

  it("rejects a sequential replayed nonce", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    await verifier.verify(request, method, path, body, rawBody, now, validateBody);

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("replayed_nonce");
    expect(await nonceCount()).toBe(1);
  });

  it("atomically accepts only one concurrent use of a nonce", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);

    const results = await Promise.allSettled([
      verifier.verify(request, method, path, body, rawBody, now, validateBody),
      verifier.verify(request, method, path, body, rawBody, now, validateBody),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await nonceCount()).toBe(1);
  });

  it.each([
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28])],
    ["UTF-8 BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...canonicalize({ message: "hello", schemaVersion: "1.0" })])],
    ["malformed JSON", new TextEncoder().encode("{")],
    ["noncanonical whitespace", new TextEncoder().encode('{"message": "hello","schemaVersion":"1.0"}')],
    ["duplicate keys", new TextEncoder().encode('{"message":"first","message":"hello","schemaVersion":"1.0"}')],
    ["non-NFC text", new TextEncoder().encode('{"message":"e\\u0301","schemaVersion":"1.0"}')],
  ])("rejects %s before consuming a nonce", async (_label, rawBody) => {
    const request = await signed(rawBody);
    await expect(verifier.verify(request, method, path, { schemaVersion: "1.0", message: "hello" }, rawBody, now, validateBody)).rejects.toThrow();
    expect(await nonceCount()).toBe(0);
  });

  it("rejects a signed raw-body and supplied-object split before nonce insertion", async () => {
    const { rawBody } = canonicalBody("authoritative");
    const request = await signed(rawBody);

    await expect(verifier.verify(request, method, path, { schemaVersion: "1.0", message: "different" }, rawBody, now, validateBody)).rejects.toThrow("signed_body_mismatch");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects unknown body fields before nonce insertion", async () => {
    const body = { schemaVersion: "1.0", message: "hello", admin: true };
    const rawBody = canonicalize(body);
    const request = await signed(rawBody);

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("test_body_invalid");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects supplied accessors and inherited fields without invoking them", async () => {
    const { rawBody } = canonicalBody();
    const request = await signed(rawBody);
    let getterCalls = 0;
    const accessor = { schemaVersion: "1.0" } as Record<string, unknown>;
    Object.defineProperty(accessor, "message", { enumerable: true, get: () => { getterCalls += 1; return "hello"; } });
    const inherited = Object.create({ admin: true }) as TestBody;
    Object.assign(inherited, { schemaVersion: "1.0", message: "hello" });

    await expect(verifier.verify(request, method, path, accessor, rawBody, now, validateBody)).rejects.toThrow("signed_body_invalid");
    await expect(verifier.verify(request, method, path, inherited, rawBody, now, validateBody)).rejects.toThrow("signed_body_invalid");
    expect(getterCalls).toBe(0);
    expect(await nonceCount()).toBe(0);
  });

  it("rejects malformed request objects, accessors, and unknown fields before nonce insertion", async () => {
    const { body, rawBody } = canonicalBody();
    const valid = await signed(rawBody);
    const unknown = { ...valid, role: "admin" };
    const inherited = Object.assign(Object.create({ role: "admin" }), valid) as SignedRequestV1;
    let getterCalls = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "signatureBase64", { enumerable: true, get: () => { getterCalls += 1; return valid.signatureBase64; } });

    for (const malformed of [unknown, inherited, accessor]) {
      await expect(verifier.verify(malformed as SignedRequestV1, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signed_request_invalid");
    }
    expect(getterCalls).toBe(0);
    expect(await nonceCount()).toBe(0);
  });

  it.each([
    ["short nonce", { nonce: "short" }],
    ["padded nonce", { nonce: `${nonce()}=` }],
    ["malformed timestamp", { issuedAt: "2026-08-30T12:00:00Z" }],
    ["wrong audience", { audience: "other-audience" }],
    ["uppercase body hash", { bodyHash: "A".repeat(64) }],
  ])("rejects %s before nonce insertion", async (_label, override) => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    await expect(verifier.verify({ ...request, ...override } as SignedRequestV1, method, path, body, rawBody, now, validateBody)).rejects.toThrow();
    expect(await nonceCount()).toBe(0);
  });

  it.each([
    ["past equality", new Date(now.valueOf() - 300_000).toISOString()],
    ["future equality", new Date(now.valueOf() + 300_000).toISOString()],
  ])("rejects the five-minute clock-window %s", async (_label, issuedAt) => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody, { issuedAt });
    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signed_request_expired");
    expect(await nonceCount()).toBe(0);
  });

  it("binds the signature to the configured method and path", async () => {
    const { body, rawBody } = canonicalBody();
    const wrongMethod = await signed(rawBody, { nonce: nonce(2) }, "GET" as never, path);
    const wrongPath = await signed(rawBody, { nonce: nonce(3) }, method, "/sync/other");

    await expect(verifier.verify(wrongMethod, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signature_invalid");
    await expect(verifier.verify(wrongPath, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signature_invalid");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects an attacker request validly signed for a different audience", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody, { audience: "attacker-audience" });

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("audience_mismatch");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects valid signatures whose device or principal subject binding is not enrolled", async () => {
    const { body, rawBody } = canonicalBody();
    const wrongDevice = await signed(rawBody, { deviceId: "device:other", nonce: nonce(6) });
    const wrongPrincipal = await signed(rawBody, { principalId: "principal:other", nonce: nonce(7) });

    await expect(verifier.verify(wrongDevice, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_not_active");
    await expect(verifier.verify(wrongPrincipal, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_not_active");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects a valid signature over a body hash that does not match rawBody", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody, { bodyHash: "0".repeat(64) as never, nonce: nonce(8) });

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("body_hash_mismatch");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects CR/LF delimiter injection in every signature preimage atom", async () => {
    const { body, rawBody } = canonicalBody();
    for (const override of [{ deviceId: "device:one\nadmin" }, { principalId: "principal:one\radmin" }, { audience: `${audience}\nother` }]) {
      const request = await signed(rawBody, { ...override, nonce: nonce(9) });
      await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signed_request_invalid");
    }
    const valid = await signed(rawBody, { nonce: nonce(10) });
    await expect(verifier.verify(valid, "POST\nGET" as never, path, body, rawBody, now, validateBody)).rejects.toThrow("signed_request_target_invalid");
    await expect(verifier.verify(valid, method, "/sync/pull\n/admin", body, rawBody, now, validateBody)).rejects.toThrow("signed_request_target_invalid");
    expect(() => new DeviceRequestVerifier({ database: env.DB, audience: `${audience}\nother` })).toThrow("audience_invalid");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects a malformed or wrong raw Ed25519 signature without consuming a nonce", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    const wrongBytes = Uint8Array.from(atob(request.signatureBase64), (character) => character.charCodeAt(0));
    wrongBytes[0] ^= 1;
    const shortSignature = base64(wrongBytes.slice(0, 63));

    await expect(verifier.verify({ ...request, signatureBase64: "not-base64" }, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signature_invalid");
    await expect(verifier.verify({ ...request, signatureBase64: shortSignature }, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signature_invalid");
    await expect(verifier.verify({ ...request, signatureBase64: base64(wrongBytes) }, method, path, body, rawBody, now, validateBody)).rejects.toThrow("signature_invalid");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects a noncanonical stored 32-byte public key before nonce insertion", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    await env.DB.prepare("UPDATE device_keys SET public_key_base64 = ? WHERE device_id = 'device:one'").bind(`!${"A".repeat(42)}=`).run();

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_key_invalid");
    expect(await nonceCount()).toBe(0);
  });

  it("rejects a disabled principal or revoked device", async () => {
    const { body, rawBody } = canonicalBody();
    const principalRequest = await signed(rawBody, { nonce: nonce(4) });
    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:one'").run();
    await expect(verifier.verify(principalRequest, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_not_active");
    await env.DB.prepare("UPDATE principals SET status = 'active' WHERE principal_id = 'principal:one'").run();
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:one'").bind(now.toISOString()).run();
    const deviceRequest = await signed(rawBody, { nonce: nonce(5) });
    await expect(verifier.verify(deviceRequest, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_not_active");
    expect(await nonceCount()).toBe(0);
  });

  it("fails an atomic nonce insertion if the device is revoked after signature verification", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    verifier = new DeviceRequestVerifier({
      database: env.DB, audience,
      beforeNonceInsert: async () => { await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:one'").bind(now.toISOString()).run(); },
    });

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_key_changed");
    expect(await nonceCount()).toBe(0);
  });

  it("fails an atomic nonce insertion if the exact current key tuple rotates after signature verification", async () => {
    const { body, rawBody } = canonicalBody();
    const request = await signed(rawBody);
    const replacement = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const replacementRaw = new Uint8Array(await crypto.subtle.exportKey("raw", replacement.publicKey));
    verifier = new DeviceRequestVerifier({
      database: env.DB, audience,
      beforeNonceInsert: async () => {
        await env.DB.prepare("UPDATE device_keys SET key_id = 'key:two', public_key_base64 = ?, key_fingerprint = ?, key_generation = 2 WHERE device_id = 'device:one'")
          .bind(base64(replacementRaw), await sha256Hex(replacementRaw)).run();
      },
    });

    await expect(verifier.verify(request, method, path, body, rawBody, now, validateBody)).rejects.toThrow("device_key_changed");
    expect(await nonceCount()).toBe(0);
  });
});
