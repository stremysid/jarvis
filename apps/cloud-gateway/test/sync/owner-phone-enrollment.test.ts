import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import {
  IdentityChallengeService,
  VerifiedChannelObservationAuthority,
} from "../../src/sync/identity-challenge.js";
import {
  OWNER_PHONE_ENROLLMENT_PATH,
  OwnerPhoneEnrollmentService,
  type OwnerPhoneEnrollmentBodyV1,
} from "../../src/sync/owner-phone-enrollment.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { applyFoundationMigration, clearVoiceAccessDataForTest } from "../persistence/migration.js";

const nowIso = "2026-09-14T14:00:00.000Z";
const audience = "jarvis-local-agent";
const phone = "+14165550123";
const identityId = "identity:owner:voice";
const pepper = Uint8Array.from({ length: 32 }, (_, index) => index + 17);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function nonce(seed: number): string {
  return base64(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("OwnerPhoneEnrollmentService", () => {
  let privateKey: CryptoKey;
  let keyFingerprint: string;
  let currentNow: Date;
  let nonceSeed: number;
  let challengeSequence: number;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM events"),
    ]);
    currentNow = new Date(nowIso);
    nonceSeed = 1;
    challengeSequence = 1;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    keyFingerprint = await sha256Hex(publicBytes);
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)",
    ).bind(nowIso, nowIso).run();
    await env.DB.prepare(
      `INSERT INTO device_keys (
         device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at
       ) VALUES ('device:home', 'principal:owner', 'key:home', ?, ?, 1, 'ed25519', 'active', 'home PC', ?, ?)`,
    ).bind(base64(publicBytes), keyFingerprint, "0".repeat(64), nowIso).run();
  });

  function service(overrides: Partial<ConstructorParameters<typeof OwnerPhoneEnrollmentService>[0]> = {}) {
    return new OwnerPhoneEnrollmentService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      ownerIdentityId: identityId,
      hmacPepper: pepper,
      hmacKeyVersion: "identity-hmac-v1",
      now: () => new Date(currentNow),
      challengeId: () => `challenge:${challengeSequence++}`,
      response: () => "482913",
      ...overrides,
    });
  }

  async function signed(
    body: OwnerPhoneEnrollmentBodyV1,
    key: CryptoKey = privateKey,
    path = OWNER_PHONE_ENROLLMENT_PATH,
  ): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: "device:home",
      principalId: "principal:owner",
      audience,
      issuedAt: currentNow.toISOString(),
      nonce: nonce(nonceSeed++),
      bodyHash: await sha256Hex(rawBody),
    };
    const message = new TextEncoder().encode([
      "POST", path, unsigned.deviceId, unsigned.principalId, unsigned.audience,
      unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    return {
      request: {
        ...unsigned,
        signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, message))),
      },
      rawBody,
    };
  }

  async function execute(body: OwnerPhoneEnrollmentBodyV1) {
    const request = await signed(body);
    return service().execute(request.request, body, request.rawBody);
  }

  it("reports only a key match after an exact active-device signature", async () => {
    await expect(execute({ schemaVersion: "1.0", operation: "preflight" })).resolves.toEqual({
      schemaVersion: "1.0",
      deviceKeyMatches: true,
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(1);
  });

  it("rejects a forged or revoked key without creating any enrollment state", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const body = { schemaVersion: "1.0", operation: "begin", phoneNumber: phone } as const;
    const forged = await signed(body, pair.privateKey);
    await expect(service().execute(forged.request, body, forged.rawBody)).rejects.toThrow("signature_invalid");

    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:home'")
      .bind(nowIso).run();
    const revoked = await signed(body);
    await expect(service().execute(revoked.request, body, revoked.rawBody)).rejects.toThrow("device_not_active");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(0);
  });

  it("derives the principal and configured identity instead of accepting either from the request", async () => {
    const body = {
      schemaVersion: "1.0",
      operation: "begin",
      phoneNumber: phone,
      identityId: "identity:attacker",
    } as unknown as OwnerPhoneEnrollmentBodyV1;
    const candidate = await signed(body);
    await expect(service().execute(candidate.request, body, candidate.rawBody)).rejects.toThrow("owner_phone_enrollment_body_invalid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it("creates the pending identity, singleton, and HMAC challenge atomically without persisting plaintext", async () => {
    const result = await execute({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone });
    expect(result).toEqual({
      schemaVersion: "1.0",
      deviceKeyMatches: true,
      enrollmentState: "pending",
      challengeId: "challenge:1",
      response: "482913",
      expiresAt: "2026-09-14T14:05:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain(phone);
    expect(JSON.stringify(result)).not.toContain(identityId);

    const identity = await env.DB.prepare("SELECT * FROM channel_identities WHERE identity_id = ?")
      .bind(identityId).first<Record<string, unknown>>();
    expect(identity).toMatchObject({
      principal_id: "principal:owner", channel: "voice", provider_subject: phone,
      status: "pending", verified_at: null, enrolled_by_device_id: "device:home",
    });
    expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity WHERE singleton_id = 1")
      .first()).toEqual({ principal_id: "principal:owner", identity_id: identityId });
    const challenge = await env.DB.prepare("SELECT * FROM identity_challenges WHERE challenge_id = 'challenge:1'")
      .first<Record<string, unknown>>();
    expect(challenge).toMatchObject({
      principal_id: "principal:owner", identity_id: identityId, initiating_device_id: "device:home",
      initiating_key_id: "key:home", initiating_key_fingerprint: keyFingerprint,
      initiating_key_generation: 1, hmac_key_version: "identity-hmac-v1",
    });
    expect(challenge?.response_hmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(challenge)).not.toContain("482913");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
  });

  it("rolls back all bootstrap rows when a later statement fails", async () => {
    const body = { schemaVersion: "1.0", operation: "begin", phoneNumber: phone } as const;
    const candidate = await signed(body);
    const broken = service({
      faultStatement: env.DB.prepare("INSERT INTO principals (principal_id) VALUES ('fault')"),
    });
    await expect(broken.execute(candidate.request, body, candidate.rawBody)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_owner_identity").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
  });

  it("exactly resumes the same phone with one live response and refuses a different phone", async () => {
    await execute({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone });
    const retry = await execute({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone });
    expect(retry).toMatchObject({ enrollmentState: "pending", challengeId: "challenge:2" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(1);

    const conflict = await execute({ schemaVersion: "1.0", operation: "begin", phoneNumber: "+14165550999" });
    expect(conflict).toEqual({ schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "conflict" });
    expect((await env.DB.prepare("SELECT provider_subject FROM channel_identities WHERE identity_id = ?")
      .bind(identityId).first<{ provider_subject: string }>())?.provider_subject).toBe(phone);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(1);
  });

  it("loses a revocation race after signature verification without leaving partial state", async () => {
    const body = { schemaVersion: "1.0", operation: "begin", phoneNumber: phone } as const;
    const candidate = await signed(body);
    const raced = service({
      beforeBootstrap: async () => {
        await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:home'")
          .bind(nowIso).run();
      },
    });
    await expect(raced.execute(candidate.request, body, candidate.rawBody)).rejects.toThrow("owner_phone_device_mismatch");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_owner_identity").first<{ count: number }>())?.count).toBe(0);
  });

  it("reports absent, pending, expired, active, and conflict without returning the phone", async () => {
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toMatchObject({ enrollmentState: "absent" });
    const begun = await execute({ schemaVersion: "1.0", operation: "begin", phoneNumber: phone });
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toMatchObject({ enrollmentState: "pending" });

    currentNow = new Date("2026-09-14T14:05:00.000Z");
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toMatchObject({ enrollmentState: "expired" });

    currentNow = new Date("2026-09-14T14:01:00.000Z");
    const observations = new VerifiedChannelObservationAuthority();
    const challenges = new IdentityChallengeService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      observations,
      hmacPepper: pepper,
      hmacKeyVersion: "identity-hmac-v1",
      now: () => new Date(currentNow),
    });
    await challenges.confirm(observations.issue({
      challengeId: "challengeId" in begun ? begun.challengeId : "missing",
      providerRequestId: "call:CA123", channel: "phone", principalId: "principal:owner",
      identityId, response: "response" in begun ? begun.response : "000000",
      initiatingDeviceId: "device:home", initiatingKeyId: "key:home",
      initiatingKeyFingerprint: keyFingerprint, initiatingKeyGeneration: 1,
    }));
    const active = await execute({ schemaVersion: "1.0", operation: "status" });
    expect(active).toEqual({ schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "active" });
    expect(JSON.stringify(active)).not.toContain(phone);

    await clearVoiceAccessDataForTest();
    await env.DB.prepare("DELETE FROM identity_challenges").run();
    await env.DB.prepare("DELETE FROM channel_identities").run();
    await env.DB.prepare(
      `INSERT INTO channel_identities
       (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
       VALUES ('identity:conflict', 'principal:owner', 'voice', ?, 'pending', NULL, ?, 'device:home')`,
    ).bind(phone, nowIso).run();
    await env.DB.prepare(
      "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:conflict', ?)",
    ).bind(nowIso).run();
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "conflict",
    });
  });
});
