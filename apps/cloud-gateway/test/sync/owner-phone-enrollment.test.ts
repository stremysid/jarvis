import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  sha256Hex,
  type SignedRequestV1,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
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
import {
  applyFoundationMigration,
  clearCallSessionsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

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

const requestSalt = nonce(240);

function beginBody(phoneNumber = phone, salt = requestSalt): OwnerPhoneEnrollmentBodyV1 {
  return { schemaVersion: "1.0", operation: "begin", phoneNumber, requestSalt: salt };
}

describe("OwnerPhoneEnrollmentService", () => {
  let privateKey: CryptoKey;
  let keyFingerprint: string;
  let currentNow: Date;
  let nonceSeed: number;
  let challengeSequence: number;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearCallSessionsForTest();
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
      ownerPrincipalId: "principal:owner",
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
    signer = { deviceId: "device:home", principalId: "principal:owner" },
  ): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: signer.deviceId,
      principalId: signer.principalId,
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
    const body = beginBody();
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
      requestSalt,
      identityId: "identity:attacker",
    } as unknown as OwnerPhoneEnrollmentBodyV1;
    const candidate = await signed(body);
    await expect(service().execute(candidate.request, body, candidate.rawBody)).rejects.toThrow("owner_phone_enrollment_body_invalid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it("creates the pending identity, singleton, and HMAC challenge atomically without persisting plaintext", async () => {
    const result = await execute(beginBody());
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
    const body = beginBody();
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
    await execute(beginBody());
    const retry = await execute(beginBody());
    expect(retry).toMatchObject({ enrollmentState: "pending", challengeId: "challenge:2" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(1);

    const conflict = await execute(beginBody("+14165550999"));
    expect(conflict).toEqual({ schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "conflict" });
    expect((await env.DB.prepare("SELECT provider_subject FROM channel_identities WHERE identity_id = ?")
      .bind(identityId).first<{ provider_subject: string }>())?.provider_subject).toBe(phone);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(1);
  });

  it("loses a revocation race after signature verification without leaving partial state", async () => {
    const body = beginBody();
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

  it("refuses a service principal even when its device signature is valid", async () => {
    await env.DB.prepare("UPDATE principals SET principal_type = 'service' WHERE principal_id = 'principal:owner'").run();
    const body = beginBody();
    const candidate = await signed(body);
    await expect(service().execute(candidate.request, body, candidate.rawBody)).rejects.toThrow("owner_phone_device_mismatch");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not report success when the freshly-read identity no longer matches", async () => {
    const body = beginBody();
    const candidate = await signed(body);
    const raced = service({
      afterBootstrap: async () => {
        await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = ?")
          .bind(identityId).run();
      },
    });
    await expect(raced.execute(candidate.request, body, candidate.rawBody))
      .rejects.toThrow("owner_phone_enrollment_state_changed");
  });

  it("reports absent, pending, expired, active, and conflict without returning the phone", async () => {
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toMatchObject({ enrollmentState: "absent" });
    const begun = await execute(beginBody());
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
    await expect(challenges.confirm(observations.issue({
      challengeId: "challengeId" in begun ? begun.challengeId : "missing",
      providerRequestId: "call:CA123", channel: "phone", principalId: "principal:owner",
      identityId, response: "response" in begun ? begun.response : "000000",
      initiatingDeviceId: "device:home", initiatingKeyId: "key:home",
      initiatingKeyFingerprint: keyFingerprint, initiatingKeyGeneration: 1,
    }))).rejects.toThrow("identity_challenge_consumed");
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

  it("retries the same phone after expiry and returns the newly committed challenge", async () => {
    await execute(beginBody());
    currentNow = new Date("2026-09-14T14:06:00.000Z");

    const retried = await execute(beginBody());

    expect(retried).toMatchObject({
      enrollmentState: "pending",
      challengeId: "challenge:2",
      expiresAt: "2026-09-14T14:11:00.000Z",
    });
    expect(await env.DB.prepare(
      "SELECT challenge_id, expires_at FROM identity_challenges WHERE consumed_at IS NULL",
    ).all()).toMatchObject({
      results: [{ challenge_id: "challenge:2", expires_at: "2026-09-14T14:11:00.000Z" }],
    });
  });

  it("returns a first owner-phone challenge when the device also has an unrelated expired challenge", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
         VALUES ('identity:old-telegram', 'principal:owner', 'telegram', '424242', 'pending', NULL, ?, 'device:home')`,
      ).bind("2026-09-14T13:40:00.000Z"),
      env.DB.prepare(
        `INSERT INTO identity_challenges (
           challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id,
           initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version,
           expires_at, consumed_at, created_at
         ) VALUES ('challenge:old-telegram', 'principal:owner', 'identity:old-telegram', 'telegram',
           'device:home', 'key:home', ?, 1, ?, 'identity-hmac-v1', ?, NULL, ?)`,
      ).bind(keyFingerprint, "b".repeat(64), "2026-09-14T13:50:00.000Z", "2026-09-14T13:40:00.000Z"),
    ]);

    const begun = await execute(beginBody());

    expect(begun).toMatchObject({ enrollmentState: "pending", challengeId: "challenge:1" });
    expect(await env.DB.prepare("SELECT challenge_id, channel FROM identity_challenges").all())
      .toMatchObject({ results: [{ challenge_id: "challenge:1", channel: "voice" }] });
  });

  it("refuses a second human principal even when that principal has an active device", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:other', 'human', 'active', 'Other', ?, ?)",
    ).bind(nowIso, nowIso).run();
    await env.DB.prepare(
      `INSERT INTO device_keys (
         device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at
       ) VALUES ('device:other', 'principal:other', 'key:other', ?, ?, 1, 'ed25519', 'active', 'other PC', ?, ?)`,
    ).bind(base64(publicBytes), await sha256Hex(publicBytes), "1".repeat(64), nowIso).run();
    const body = beginBody();
    const candidate = await signed(body, pair.privateKey, OWNER_PHONE_ENROLLMENT_PATH, {
      deviceId: "device:other", principalId: "principal:other",
    });

    await expect(service().execute(candidate.request, body, candidate.rawBody))
      .rejects.toThrow("owner_phone_device_mismatch");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>())?.count).toBe(0);
  });

  it("reports conflict when the singleton belongs to another identity", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
         VALUES (?, 'principal:owner', 'voice', ?, 'active', ?, ?, 'device:home')`,
      ).bind(identityId, phone, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
         VALUES ('identity:other', 'principal:owner', 'voice', '+14165550999', 'active', ?, ?, 'device:home')`,
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:other', ?)",
      ).bind(nowIso),
    ]);

    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toMatchObject({
      enrollmentState: "conflict",
    });
  });

  it("does not insert a challenge when the identity phone changes during bootstrap", async () => {
    const body = beginBody("+14165550999");
    const candidate = await signed(body);
    const raced = service({
      beforeBootstrap: async () => {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO channel_identities
             (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
             VALUES (?, 'principal:owner', 'voice', ?, 'pending', NULL, ?, 'device:home')`,
          ).bind(identityId, phone, nowIso),
          env.DB.prepare(
            "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', ?, ?)",
          ).bind(identityId, nowIso),
        ]);
      },
    });

    await expect(raced.execute(candidate.request, body, candidate.rawBody))
      .rejects.toThrow("owner_phone_enrollment_state_changed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not leave an orphan configured identity when the owner singleton appears during bootstrap", async () => {
    const body = beginBody();
    const candidate = await signed(body);
    const raced = service({
      beforeBootstrap: async () => {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO channel_identities
             (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
             VALUES ('identity:other', 'principal:owner', 'voice', '+14165550999', 'pending', NULL, ?, 'device:home')`,
          ).bind(nowIso),
          env.DB.prepare(
            "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:other', ?)",
          ).bind(nowIso),
        ]);
      },
    });

    await expect(raced.execute(candidate.request, body, candidate.rawBody)).resolves.toMatchObject({
      enrollmentState: "conflict",
    });
    expect(await env.DB.prepare("SELECT identity_id FROM channel_identities ORDER BY identity_id").all())
      .toMatchObject({ results: [{ identity_id: "identity:other" }] });
  });

  it("does not replace a challenge already bound to an inbound activation session", async () => {
    const first = await execute(beginBody());
    if (!("challengeId" in first)) throw new Error("test challenge missing");
    const calls = new CallRepository(
      env.DB,
      new EventRepository(env.DB),
      () => nonce(180),
      60_000,
      () => "01m1hh9h1yxaeyjgbhfzm4nnth" as Ulid,
    );
    const session = await calls.getOrCreateInboundSession({
      callSid: `CA${"1".repeat(32)}`,
      callerE164: phone,
      ownerIdentityId: identityId,
      currentChallengeHmacKeyVersion: "identity-hmac-v1",
      now: new Date(currentNow),
    });
    expect(session.binding.activationChallengeId).toBe(first.challengeId);

    const second = await execute(beginBody());

    expect(second).toMatchObject({ enrollmentState: "pending", challengeId: "challenge:2" });
    expect(await env.DB.prepare(
      "SELECT challenge_id FROM identity_challenges WHERE challenge_id IN ('challenge:1', 'challenge:2') ORDER BY challenge_id",
    ).all()).toMatchObject({
      results: [{ challenge_id: "challenge:1" }, { challenge_id: "challenge:2" }],
    });
  });

  it("refuses success when a concurrent retry replaces the just-created challenge", async () => {
    const body = beginBody();
    const candidate = await signed(body);
    const raced = service({
      afterBootstrap: async () => {
        const innerBody = beginBody();
        const inner = await signed(innerBody);
        await service().execute(inner.request, innerBody, inner.rawBody);
      },
    });

    await expect(raced.execute(candidate.request, body, candidate.rawBody))
      .rejects.toThrow("owner_phone_enrollment_state_changed");
    expect(await env.DB.prepare("SELECT challenge_id FROM identity_challenges").all())
      .toMatchObject({ results: [{ challenge_id: "challenge:2" }] });
  });

  it("refuses success when the committed challenge expiry changes before the final read", async () => {
    const body = beginBody();
    const candidate = await signed(body);
    const raced = service({
      afterBootstrap: async () => {
        await env.DB.prepare(
          "UPDATE identity_challenges SET expires_at = '2026-09-14T14:04:00.000Z' WHERE challenge_id = 'challenge:1'",
        ).run();
      },
    });

    await expect(raced.execute(candidate.request, body, candidate.rawBody))
      .rejects.toThrow("owner_phone_enrollment_state_changed");
  });

  it("treats a pending challenge under an old HMAC key version as expired", async () => {
    await execute(beginBody());
    const body = { schemaVersion: "1.0", operation: "status" } as const;
    const candidate = await signed(body);

    await expect(service({ hmacKeyVersion: "identity-hmac-v2" }).execute(candidate.request, body, candidate.rawBody))
      .resolves.toMatchObject({ enrollmentState: "expired" });
  });
});
