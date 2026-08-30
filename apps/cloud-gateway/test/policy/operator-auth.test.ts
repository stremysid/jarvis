import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { OperatorAuthorizer, type OperatorAuthorizationRequest } from "../../src/policy/operator-auth.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const audience = "jarvis-local-agent";
const readinessPath = "/health/readiness";

interface SigningIdentity {
  readonly privateKey: CryptoKey;
  readonly publicKeyBase64: string;
  readonly keyFingerprint: string;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function nonce(seed: number): string {
  return base64Url(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
}

async function signingIdentity(): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeyBase64: base64(publicKeyBytes),
    keyFingerprint: await sha256Hex(publicKeyBytes),
  };
}

async function insertPrincipalDevice(input: {
  readonly principalId: string;
  readonly principalType: "human" | "service";
  readonly deviceId: string;
  readonly keyId: string;
  readonly keyGeneration?: number;
  readonly signing: SigningIdentity;
}): Promise<void> {
  if (input.principalType === "human") {
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'Sid', ?, ?)",
    ).bind(input.principalId, now.toISOString(), now.toISOString()).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'service', 'active', 'Service', ?, ?)",
    ).bind(input.principalId, now.toISOString(), now.toISOString()).run();
  }
  await env.DB.prepare(
    `INSERT INTO device_keys (
       device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
       algorithm, status, device_label, bootstrap_metadata_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'ed25519', 'active', 'test device', ?, ?)`,
  ).bind(
    input.deviceId,
    input.principalId,
    input.keyId,
    input.signing.publicKeyBase64,
    input.signing.keyFingerprint,
    input.keyGeneration ?? 1,
    "0".repeat(64),
    now.toISOString(),
  ).run();
}

async function signReadiness(input: {
  readonly signing: SigningIdentity;
  readonly rawBody: Uint8Array;
  readonly seed: number;
  readonly deviceId?: string;
  readonly principalId?: string;
  readonly requestAudience?: string;
  readonly issuedAt?: string;
  readonly signedMethod?: "GET" | "POST";
  readonly signedPath?: string;
}): Promise<SignedRequestV1> {
  const unsigned = {
    schemaVersion: "1.0" as const,
    deviceId: input.deviceId ?? "device:one",
    principalId: input.principalId ?? "principal:one",
    audience: input.requestAudience ?? audience,
    issuedAt: input.issuedAt ?? now.toISOString(),
    nonce: nonce(input.seed),
    bodyHash: await sha256Hex(input.rawBody),
  };
  const signingText = new TextEncoder().encode([
    input.signedMethod ?? "POST",
    input.signedPath ?? readinessPath,
    unsigned.deviceId,
    unsigned.principalId,
    unsigned.audience,
    unsigned.issuedAt,
    unsigned.nonce,
    unsigned.bodyHash,
  ].join("\n"));
  return {
    ...unsigned,
    signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", input.signing.privateKey, signingText))),
  };
}

describe("OperatorAuthorizer", () => {
  let humanSigning: SigningIdentity;
  let repository: DeviceRepository;
  let authorizer: OperatorAuthorizer;

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_ack_receipts"),
      env.DB.prepare("DELETE FROM sync_snapshots"),
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    humanSigning = await signingIdentity();
    await insertPrincipalDevice({
      principalId: "principal:one",
      principalType: "human",
      deviceId: "device:one",
      keyId: "key:one",
      signing: humanSigning,
    });
    repository = new DeviceRepository(env.DB);
    authorizer = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: repository,
    });
  });

  async function authorizationInput(seed: number, overrides: Partial<Parameters<typeof signReadiness>[0]> = {}): Promise<OperatorAuthorizationRequest> {
    const body = { schemaVersion: "1.0" as const, intent: "readiness" as const };
    const rawBody = canonicalize(body);
    return {
      signedRequest: await signReadiness({ signing: humanSigning, rawBody, seed, ...overrides }),
      body,
      rawBody,
      verificationTime: now,
    };
  }

  async function unauthorizedMessage(input: unknown, target = authorizer): Promise<string> {
    try {
      await target.requireEnrolledOperator(input);
      return "unexpected_success";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("returns only a frozen opaque operator ID for the canonical signed readiness intent", async () => {
    const result = await authorizer.requireEnrolledOperator(await authorizationInput(1));

    expect(result).toEqual({ operatorId: "principal:one" });
    expect(Reflect.ownKeys(result)).toEqual(["operatorId"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(1);
  });

  it("normalizes forged, expired, replayed, foreign, noncanonical, wrong-target, wrong-audience, and malformed requests", async () => {
    const forged = await authorizationInput(2);
    const forgedBytes = Uint8Array.from(atob(forged.signedRequest.signatureBase64), (character) => character.charCodeAt(0));
    forgedBytes[0] ^= 1;
    const expired = await authorizationInput(3, { issuedAt: new Date(now.valueOf() - 300_000).toISOString() });
    const foreign = await authorizationInput(4, { principalId: "principal:foreign" });
    const wrongMethod = await authorizationInput(5, { signedMethod: "GET" });
    const wrongPath = await authorizationInput(6, { signedPath: "/health/liveness" });
    const wrongAudience = await authorizationInput(7, { requestAudience: "other-audience" });
    const noncanonicalBody = { schemaVersion: "1.0" as const, intent: "readiness" as const };
    const noncanonicalRaw = new TextEncoder().encode('{"intent":"readiness", "schemaVersion":"1.0"}');
    const noncanonical: OperatorAuthorizationRequest = {
      signedRequest: await signReadiness({ signing: humanSigning, rawBody: noncanonicalRaw, seed: 8 }),
      body: noncanonicalBody,
      rawBody: noncanonicalRaw,
      verificationTime: now,
    };
    const replay = await authorizationInput(9);
    await authorizer.requireEnrolledOperator(replay);
    const malformedRequest = { ...(await authorizationInput(10)).signedRequest, operator: true };
    const malformed = { ...(await authorizationInput(11)), signedRequest: malformedRequest };

    const failures: unknown[] = [
      { ...forged, signedRequest: { ...forged.signedRequest, signatureBase64: base64(forgedBytes) } },
      expired,
      replay,
      foreign,
      wrongMethod,
      wrongPath,
      wrongAudience,
      noncanonical,
      malformed,
      null,
    ];
    const messages = await Promise.all(failures.map((failure) => unauthorizedMessage(failure)));

    expect(messages).toEqual(Array.from({ length: failures.length }, () => "operator_not_authorized"));
  });

  it.each([
    ["wrong schema version", { schemaVersion: "2.0", intent: "readiness" }],
    ["wrong intent", { schemaVersion: "1.0", intent: "diagnostics" }],
  ])("rejects a canonical signed readiness body with %s", async (_label, body) => {
    const rawBody = canonicalize(body);
    const input: OperatorAuthorizationRequest = {
      signedRequest: await signReadiness({ signing: humanSigning, rawBody, seed: body.schemaVersion === "2.0" ? 21 : 22 }),
      body,
      rawBody,
      verificationTime: now,
    };

    await expect(authorizer.requireEnrolledOperator(input)).rejects.toThrow(/^operator_not_authorized$/u);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects an active service-principal device even after its signature and nonce are valid", async () => {
    const serviceSigning = await signingIdentity();
    await insertPrincipalDevice({
      principalId: "service:one",
      principalType: "service",
      deviceId: "device:service",
      keyId: "key:service",
      signing: serviceSigning,
    });
    const serviceAuthorizer = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: repository,
    });
    const body = { schemaVersion: "1.0" as const, intent: "readiness" as const };
    const rawBody = canonicalize(body);
    const input: OperatorAuthorizationRequest = {
      signedRequest: await signReadiness({
        signing: serviceSigning,
        rawBody,
        seed: 12,
        deviceId: "device:service",
        principalId: "service:one",
      }),
      body,
      rawBody,
      verificationTime: now,
    };

    await expect(serviceAuthorizer.requireEnrolledOperator(input)).rejects.toThrow(/^operator_not_authorized$/u);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces WHERE device_id = 'device:service'").first<{ count: number }>())?.count).toBe(1);
  });

  it("rejects revoked and stale device keys with the same authorization error", async () => {
    const revokedInput = await authorizationInput(13);
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:one'").bind(now.toISOString()).run();
    const revoked = await unauthorizedMessage(revokedInput);

    await env.DB.prepare("UPDATE device_keys SET status = 'active', revoked_at = NULL WHERE device_id = 'device:one'").run();
    const staleInput = await authorizationInput(14);
    const replacement = await signingIdentity();
    await env.DB.prepare(
      "UPDATE device_keys SET key_id = 'key:two', public_key_base64 = ?, key_fingerprint = ?, key_generation = 2 WHERE device_id = 'device:one'",
    ).bind(replacement.publicKeyBase64, replacement.keyFingerprint).run();
    const stale = await unauthorizedMessage(staleInput);

    expect([revoked, stale]).toEqual(["operator_not_authorized", "operator_not_authorized"]);
  });

  it("rechecks the exact current human device after verification and normalizes false or repository failure", async () => {
    const falseAuthorizer = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: { isCurrentHumanDevice: async () => false },
    });
    const throwingAuthorizer = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: { isCurrentHumanDevice: async () => { throw new Error("database secret detail"); } },
    });

    expect(await unauthorizedMessage(await authorizationInput(15), falseAuthorizer)).toBe("operator_not_authorized");
    expect(await unauthorizedMessage(await authorizationInput(16), throwingAuthorizer)).toBe("operator_not_authorized");
  });

  it("rejects revocation, key rotation, or principal-type change between verification and the final human-device proof", async () => {
    const revoking = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: {
        isCurrentHumanDevice: async (verified) => {
          await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
            .bind(now.toISOString(), verified.deviceId).run();
          return repository.isCurrentHumanDevice(verified);
        },
      },
    });

    expect(await unauthorizedMessage(await authorizationInput(17), revoking)).toBe("operator_not_authorized");

    await env.DB.prepare("UPDATE device_keys SET status = 'active', revoked_at = NULL WHERE device_id = 'device:one'").run();
    const replacement = await signingIdentity();
    const rotating = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: {
        isCurrentHumanDevice: async (verified) => {
          await env.DB.prepare(
            "UPDATE device_keys SET key_id = 'key:rotated', public_key_base64 = ?, key_fingerprint = ?, key_generation = 2 WHERE device_id = ?",
          ).bind(replacement.publicKeyBase64, replacement.keyFingerprint, verified.deviceId).run();
          return repository.isCurrentHumanDevice(verified);
        },
      },
    });
    expect(await unauthorizedMessage(await authorizationInput(23), rotating)).toBe("operator_not_authorized");

    await env.DB.prepare(
      "UPDATE device_keys SET key_id = 'key:one', public_key_base64 = ?, key_fingerprint = ?, key_generation = 1 WHERE device_id = 'device:one'",
    ).bind(humanSigning.publicKeyBase64, humanSigning.keyFingerprint).run();
    const changingPrincipalType = new OperatorAuthorizer({
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      devices: {
        isCurrentHumanDevice: async (verified) => {
          await env.DB.prepare("UPDATE principals SET principal_type = 'service' WHERE principal_id = ?").bind(verified.principalId).run();
          return repository.isCurrentHumanDevice(verified);
        },
      },
    });
    expect(await unauthorizedMessage(await authorizationInput(24), changingPrincipalType)).toBe("operator_not_authorized");
  });

  it("rejects an accessor-bearing outer request and body without invoking either accessor", async () => {
    const valid = await authorizationInput(18);
    let getterCalls = 0;
    const outer = { ...valid } as Record<string, unknown>;
    Object.defineProperty(outer, "rawBody", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return valid.rawBody;
      },
    });
    const body = { schemaVersion: "1.0" } as Record<string, unknown>;
    Object.defineProperty(body, "intent", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "readiness";
      },
    });
    const outerExtra = { ...valid, role: "admin" };
    const { rawBody: _omittedRawBody, ...outerMissing } = valid;
    const outerSymbol = { ...valid } as Record<PropertyKey, unknown>;
    outerSymbol[Symbol("operator")] = true;
    const outerHidden = { ...valid } as Record<string, unknown>;
    Object.defineProperty(outerHidden, "operator", { value: true, enumerable: false });
    const bodyExtra = { schemaVersion: "1.0", intent: "readiness", role: "admin" };
    const bodyMissing = { schemaVersion: "1.0" };
    const bodySymbol = { schemaVersion: "1.0", intent: "readiness" } as Record<PropertyKey, unknown>;
    bodySymbol[Symbol("operator")] = true;
    const bodyHidden = { schemaVersion: "1.0", intent: "readiness" } as Record<string, unknown>;
    Object.defineProperty(bodyHidden, "operator", { value: true, enumerable: false });

    expect(await unauthorizedMessage(outer)).toBe("operator_not_authorized");
    expect(await unauthorizedMessage({ ...(await authorizationInput(19)), body })).toBe("operator_not_authorized");
    for (const malformedOuter of [outerExtra, outerMissing, outerSymbol, outerHidden]) {
      expect(await unauthorizedMessage(malformedOuter)).toBe("operator_not_authorized");
    }
    for (const malformedBody of [bodyExtra, bodyMissing, bodySymbol, bodyHidden]) {
      expect(await unauthorizedMessage({ ...(await authorizationInput(20)), body: malformedBody })).toBe("operator_not_authorized");
    }
    expect(getterCalls).toBe(0);
  });
});
