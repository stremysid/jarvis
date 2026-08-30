import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import { applyFoundationMigration, clearVoiceAccessDataForTest } from "../persistence/migration.js";

const audience = "jarvis-local-agent";
const beginPath = "/identity/challenge/begin";
const initialNow = new Date("2026-08-30T12:00:00.000Z");
const keyFingerprintPlaceholder = "0".repeat(64);

type Channel = "phone" | "telegram";
interface BeginBody {
  schemaVersion: "1.0";
  channel: Channel;
  identityId: string;
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

describe("IdentityChallengeService", () => {
  let privateKey: CryptoKey;
  let publicKeyBase64: string;
  let keyFingerprint: string;
  let verifier: DeviceRequestVerifier;
  let observations: VerifiedChannelObservationAuthority;
  let identities: IdentityChallengeService;
  let currentNow: Date;
  let nonceSeed: number;
  let challengeSequence: number;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearVoiceAccessDataForTest();
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
    currentNow = new Date(initialNow);
    nonceSeed = 1;
    challengeSequence = 1;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    publicKeyBase64 = base64(publicKey);
    keyFingerprint = await sha256Hex(publicKey);
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:one', 'human', 'active', 'Sid', ?, ?)",
    ).bind(initialNow.toISOString(), initialNow.toISOString()).run();
    await env.DB.prepare(
      "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:one', 'principal:one', 'key:one', ?, ?, 1, 'ed25519', 'active', 'laptop', ?, ?)",
    ).bind(publicKeyBase64, keyFingerprint, keyFingerprintPlaceholder, initialNow.toISOString()).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:phone', 'principal:one', 'voice', '+14165550123', 'pending', NULL, ?, 'device:one')",
      ).bind(initialNow.toISOString()),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:telegram', 'principal:one', 'telegram', '424242', 'pending', NULL, ?, 'device:one')",
      ).bind(initialNow.toISOString()),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:other-phone', 'principal:one', 'voice', '+14165550124', 'pending', NULL, ?, 'device:one')",
      ).bind(initialNow.toISOString()),
    ]);
    await env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:one', 'identity:phone', ?)")
      .bind(initialNow.toISOString()).run();
    verifier = new DeviceRequestVerifier({ database: env.DB, audience });
    observations = new VerifiedChannelObservationAuthority();
    identities = makeService();
  });

  function makeService(overrides: Partial<ConstructorParameters<typeof IdentityChallengeService>[0]> = {}): IdentityChallengeService {
    return new IdentityChallengeService({
      database: env.DB,
      verifier,
      observations,
      hmacPepper: Uint8Array.from({ length: 32 }, (_, index) => index + 11),
      hmacKeyVersion: "identity-hmac-v1",
      now: () => new Date(currentNow),
      challengeId: () => `challenge:${challengeSequence++}`,
      response: () => "482913",
      ...overrides,
    });
  }

  async function signed(body: BeginBody, signatureKey = privateKey): Promise<{ request: SignedRequestV1; rawBody: Uint8Array }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: "device:one",
      principalId: "principal:one",
      audience,
      issuedAt: currentNow.toISOString(),
      nonce: nonce(nonceSeed++),
      bodyHash: await sha256Hex(rawBody),
    };
    const text = new TextEncoder().encode([
      "POST", beginPath, unsigned.deviceId, unsigned.principalId, unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    const signatureBase64 = base64(new Uint8Array(await crypto.subtle.sign("Ed25519", signatureKey, text)));
    return { request: { ...unsigned, signatureBase64 }, rawBody };
  }

  async function begin(channel: Channel, identityId = channel === "phone" ? "identity:phone" : "identity:telegram") {
    const body: BeginBody = { schemaVersion: "1.0", channel, identityId };
    const signedBody = await signed(body);
    return identities.begin(signedBody.request, body, signedBody.rawBody);
  }

  function observe(
    challenge: Awaited<ReturnType<typeof begin>>,
    channel: Channel,
    overrides: Partial<Parameters<VerifiedChannelObservationAuthority["issue"]>[0]> = {},
  ) {
    return observations.issue({
      challengeId: challenge.challengeId,
      providerRequestId: channel === "phone" ? "call:CA123" : "telegram:update:77",
      channel,
      principalId: "principal:one",
      identityId: channel === "phone" ? "identity:phone" : "identity:telegram",
      response: challenge.response,
      initiatingDeviceId: "device:one",
      initiatingKeyId: "key:one",
      initiatingKeyFingerprint: keyFingerprint,
      initiatingKeyGeneration: 1,
      ...overrides,
    });
  }

  async function identityState(identityId: string): Promise<{ status: string; verified_at: string | null }> {
    const row = await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = ?")
      .bind(identityId).first<{ status: string; verified_at: string | null }>();
    if (row === null) throw new Error("missing identity fixture");
    return row;
  }

  it("begins only from a device-signed canonical body and stores a five-minute HMAC without the plaintext response", async () => {
    const body: BeginBody = { schemaVersion: "1.0", channel: "telegram", identityId: "identity:telegram" };
    const { request, rawBody } = await signed(body);

    const challenge = await identities.begin(request, body, rawBody);

    expect(challenge).toEqual({ challengeId: "challenge:1", response: "482913", expiresAt: "2026-08-30T12:05:00.000Z" });
    const stored = await env.DB.prepare("SELECT * FROM identity_challenges WHERE challenge_id = 'challenge:1'").first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      principal_id: "principal:one", identity_id: "identity:telegram", channel: "telegram", initiating_device_id: "device:one",
      initiating_key_id: "key:one", initiating_key_fingerprint: keyFingerprint, initiating_key_generation: 1,
      hmac_key_version: "identity-hmac-v1", expires_at: "2026-08-30T12:05:00.000Z", consumed_at: null,
    });
    expect(stored?.response_hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("482913");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(1);
  });

  it("replaces an exactly expired challenge without misclassifying the successful insert", async () => {
    const first = await begin("telegram");
    currentNow = new Date(first.expiresAt);

    await expect(begin("telegram")).resolves.toMatchObject({ challengeId: "challenge:2" });
    expect((await env.DB.prepare("SELECT challenge_id FROM identity_challenges").all<{ challenge_id: string }>()).results)
      .toEqual([{ challenge_id: "challenge:2" }]);
  });

  it("rejects a forged signed request before storing a challenge or consuming its nonce", async () => {
    const body: BeginBody = { schemaVersion: "1.0", channel: "telegram", identityId: "identity:telegram" };
    const { request, rawBody } = await signed(body);
    const signature = Uint8Array.from(atob(request.signatureBase64), (character) => character.charCodeAt(0));
    signature[0] ^= 1;

    await expect(identities.begin({ ...request, signatureBase64: base64(signature) }, body, rawBody)).rejects.toThrow("signature_invalid");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM request_nonces").first<{ count: number }>())?.count).toBe(0);
  });

  it("activates a pending Telegram identity only through the injected trusted observation authority", async () => {
    const challenge = await begin("telegram");
    const foreignAuthority = new VerifiedChannelObservationAuthority();
    const foreignProof = foreignAuthority.issue({
      challengeId: challenge.challengeId, providerRequestId: "telegram:update:77", channel: "telegram", principalId: "principal:one",
      identityId: "identity:telegram", response: challenge.response, initiatingDeviceId: "device:one", initiatingKeyId: "key:one",
      initiatingKeyFingerprint: keyFingerprint, initiatingKeyGeneration: 1,
    });

    await expect(identities.confirm({ ...foreignProof })).rejects.toThrow("channel_observation_untrusted");
    await expect(identities.confirm(foreignProof)).rejects.toThrow("channel_observation_untrusted");
    await expect(identities.confirm(observe(challenge, "telegram", { identityId: "identity:phone" }))).rejects.toThrow("identity_challenge_mismatch");
    expect(await identities.confirm(observe(challenge, "telegram"))).toEqual({ identityId: "identity:telegram", state: "active" });
    expect(await identityState("identity:telegram")).toEqual({ status: "active", verified_at: initialNow.toISOString() });
  });

  it("activates only the configured owner phone without a reusable call PIN", async () => {
    const challenge = await begin("phone");
    const proof = observe(challenge, "phone");
    await expect(identities.confirm(proof)).resolves.toEqual({ identityId: "identity:phone", state: "active" });
    await expect(identities.confirm(proof)).rejects.toThrow("identity_challenge_consumed");

    const other = await begin("phone", "identity:other-phone");
    await expect(identities.confirm(observe(other, "phone", { identityId: "identity:other-phone" })))
      .rejects.toThrow("owner_voice_identity_required");
    expect(await identityState("identity:other-phone")).toEqual({ status: "pending", verified_at: null });
  });

  it("rejects wrong-channel, foreign-device, and already-active identities at challenge insertion time", async () => {
    await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = 'identity:telegram'")
      .bind(initialNow.toISOString()).run();
    const cases: BeginBody[] = [
      { schemaVersion: "1.0", channel: "phone", identityId: "identity:telegram" },
      { schemaVersion: "1.0", channel: "telegram", identityId: "identity:telegram" },
      { schemaVersion: "1.0", channel: "telegram", identityId: "identity:missing" },
    ];

    for (const body of cases) {
      const { request, rawBody } = await signed(body);
      await expect(identities.begin(request, body, rawBody)).rejects.toThrow("identity_challenge_not_pending");
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects a challenge at exact expiry without consuming it or activating the identity", async () => {
    const challenge = await begin("telegram");
    currentNow = new Date(challenge.expiresAt);

    await expect(identities.confirm(observe(challenge, "telegram"))).rejects.toThrow("identity_challenge_expired");
    expect(await identityState("identity:telegram")).toEqual({ status: "pending", verified_at: null });
    expect((await env.DB.prepare("SELECT consumed_at FROM identity_challenges WHERE challenge_id = ?").bind(challenge.challengeId).first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("fails closed if the initiating device is revoked after begin", async () => {
    const challenge = await begin("telegram");
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:one'").bind(initialNow.toISOString()).run();

    await expect(identities.confirm(observe(challenge, "telegram"))).rejects.toThrow("identity_challenge_state_changed");
    expect(await identityState("identity:telegram")).toEqual({ status: "pending", verified_at: null });
  });

  it("fails closed if the initiating key rotates after begin", async () => {
    const challenge = await begin("telegram");
    const replacement = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const replacementBytes = new Uint8Array(await crypto.subtle.exportKey("raw", replacement.publicKey));
    await env.DB.prepare("UPDATE device_keys SET key_id = 'key:two', public_key_base64 = ?, key_fingerprint = ?, key_generation = 2 WHERE device_id = 'device:one'")
      .bind(base64(replacementBytes), await sha256Hex(replacementBytes)).run();

    await expect(identities.confirm(observe(challenge, "telegram"))).rejects.toThrow("identity_challenge_state_changed");
    expect(await identityState("identity:telegram")).toEqual({ status: "pending", verified_at: null });
  });

  it("loses a revocation race after signature verification without inserting a challenge", async () => {
    identities = makeService({
      beforeChallengeInsert: async () => {
        await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:one'").bind(initialNow.toISOString()).run();
      },
    });
    const body: BeginBody = { schemaVersion: "1.0", channel: "telegram", identityId: "identity:telegram" };
    const { request, rawBody } = await signed(body);

    await expect(identities.begin(request, body, rawBody)).rejects.toThrow("identity_challenge_not_pending");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
  });

  it("permits exactly one concurrent confirmation", async () => {
    const challenge = await begin("telegram");
    const results = await Promise.allSettled([
      identities.confirm(observe(challenge, "telegram", { providerRequestId: "telegram:update:77" })),
      identities.confirm(observe(challenge, "telegram", { providerRequestId: "telegram:update:78" })),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await identityState("identity:telegram")).toEqual({ status: "active", verified_at: initialNow.toISOString() });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges WHERE consumed_at IS NOT NULL").first<{ count: number }>())?.count).toBe(1);
  });

  it("keeps activation and challenge consumption atomic when the identity changes during confirmation", async () => {
    const challenge = await begin("telegram");
    identities = makeService({
      beforeConfirmation: async () => {
        await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:telegram'").run();
      },
    });

    await expect(identities.confirm(observe(challenge, "telegram"))).rejects.toThrow("identity_challenge_state_changed");
    expect(await identityState("identity:telegram")).toEqual({ status: "disabled", verified_at: null });
    expect((await env.DB.prepare("SELECT consumed_at FROM identity_challenges WHERE challenge_id = ?").bind(challenge.challengeId).first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("binds the HMAC and trusted observation to the exact response, principal, challenge, and key generation", async () => {
    const challenge = await begin("telegram");
    const mismatches: Array<Partial<Parameters<VerifiedChannelObservationAuthority["issue"]>[0]>> = [
      { response: "482914" },
      { principalId: "principal:other" },
      { initiatingDeviceId: "device:other" },
      { initiatingKeyGeneration: 2 },
    ];

    for (const override of mismatches) {
      await expect(identities.confirm(observe(challenge, "telegram", override))).rejects.toThrow("identity_challenge_mismatch");
    }
    expect(await identityState("identity:telegram")).toEqual({ status: "pending", verified_at: null });
  });
});
