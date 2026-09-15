import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { OwnerPassphraseService, OWNER_PASSPHRASE_PATH, type OwnerPassphraseBodyV1 } from "../../src/sync/owner-passphrase.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import {
  applyOwnerPassphraseMigration,
  clearCallSessionsForTest,
  clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const nowIso = "2026-09-14T22:30:00.000Z";
const audience = "jarvis-local-agent";
const principalId = "principal:owner";
const identityId = "identity:owner:voice";
const pepper = Uint8Array.from({ length: 32 }, (_, index) => index);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function nonce(seed: number): string {
  return base64(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function requestSalt(seed: number): string {
  return nonce(128 + seed);
}

describe("OwnerPassphraseService", () => {
  let privateKey: CryptoKey;
  let keyFingerprint: string;
  let nonceSeed: number;
  let commitSequence: number;

  beforeEach(async () => {
    await applyOwnerPassphraseMigration();
    await clearOwnerPassphraseDataForTest();
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
    ]);
    nonceSeed = 1;
    commitSequence = 1;
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(publicKey instanceof ArrayBuffer)) throw new Error("unexpected_public_key_shape");
    const publicBytes = new Uint8Array(publicKey);
    keyFingerprint = await sha256Hex(publicBytes);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'Sid', ?, ?)",
      ).bind(principalId, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO device_keys (
           device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
           algorithm, status, device_label, bootstrap_metadata_hash, created_at
         ) VALUES ('device:home', ?, 'key:home', ?, ?, 1, 'ed25519', 'active', 'home PC', ?, ?)`,
      ).bind(principalId, base64(publicBytes), keyFingerprint, "0".repeat(64), nowIso),
      env.DB.prepare(
        `INSERT INTO channel_identities (
           identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
         ) VALUES (?, ?, 'voice', '+14165550123', 'active', ?, ?, 'device:home')`,
      ).bind(identityId, principalId, nowIso, nowIso),
      env.DB.prepare(
        "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, ?, ?)",
      ).bind(principalId, identityId, nowIso),
    ]);
  });

  afterEach(clearOwnerPassphraseDataForTest);

  function service(overrides: Partial<ConstructorParameters<typeof OwnerPassphraseService>[0]> = {}) {
    const draws = [0, 1, 2];
    return new OwnerPassphraseService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience }),
      ownerPrincipalId: principalId,
      ownerIdentityId: identityId,
      pepper,
      now: () => new Date(nowIso),
      randomIndex: () => {
        const value = draws.shift();
        if (value === undefined) throw new Error("draws_exhausted");
        return value;
      },
      randomSalt: () => new Uint8Array(16).fill(commitSequence),
      commitId: () => `01m2aaaaaaaaaaaaaaaaaaa${String(commitSequence++).padStart(3, "0")}`,
      ...overrides,
    });
  }

  async function signed(body: OwnerPassphraseBodyV1, key = privateKey): Promise<{
    request: SignedRequestV1;
    rawBody: Uint8Array;
  }> {
    const rawBody = canonicalize(body);
    const unsigned = {
      schemaVersion: "1.0" as const,
      deviceId: "device:home",
      principalId,
      audience,
      issuedAt: nowIso,
      nonce: nonce(nonceSeed++),
      bodyHash: await sha256Hex(rawBody),
    };
    const message = new TextEncoder().encode([
      "POST", OWNER_PASSPHRASE_PATH, unsigned.deviceId, unsigned.principalId,
      unsigned.audience, unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash,
    ].join("\n"));
    return {
      request: { ...unsigned, signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, message))) },
      rawBody,
    };
  }

  async function execute(body: OwnerPassphraseBodyV1, selected = service()) {
    const envelope = await signed(body);
    return selected.execute(envelope.request, body, envelope.rawBody);
  }

  function generate(expectedVerifierVersion: number | null, seed = 1): OwnerPassphraseBodyV1 {
    return { schemaVersion: "1.0", operation: "generate", expectedVerifierVersion, requestSalt: requestSalt(seed) };
  }

  async function disableActiveVerifier(): Promise<void> {
    const eventId = "01m2aaaaaaaaaaaaaaaaaaa901";
    const subjectId = "telegram:user:44112233";
    const envelope = {
      schemaVersion: "1.0",
      eventId,
      correlationId: eventId,
      causationId: null,
      eventType: "telegram.update.received",
      source: "channel:telegram",
      producerVersion: "cloud-gateway@0.1.0",
      subjectId,
      occurredAt: nowIso,
      receivedAt: nowIso,
      contentHash: "5".repeat(64),
      payload: {
        updateId: 901,
        principalBinding: [1],
        chatId: "44112233",
        messageId: 901,
        text: "/disable-owner-step-up --confirm",
      },
    };
    const inserted = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
        ) VALUES ('identity:owner:telegram', ?, 'telegram', '44112233', 'active', ?, ?)`,
      ).bind(principalId, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO events (
          event_id, event_type, source, subject_id, occurred_at, received_at,
          content_hash, envelope_json, created_at
        ) VALUES (?, 'telegram.update.received', 'channel:telegram', ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      ).bind(eventId, subjectId, nowIso, nowIso, "5".repeat(64), JSON.stringify(envelope), nowIso),
    ]);
    const sequence = (inserted[1].results?.[0] as { sequence?: unknown } | undefined)?.sequence;
    if (!Number.isSafeInteger(sequence)) throw new Error("disable_event_insert_failed");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) VALUES ('telegram.update', ?, ?, ?, ?)",
      ).bind(eventId, "6".repeat(64), sequence, nowIso),
      env.DB.prepare(
        `INSERT INTO owner_passphrase_disable_commits (
          commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
          authorization_event_id, committed_at
        ) VALUES ('01m2aaaaaaaaaaaaaaaaaaa902', ?, ?, 1, ?, ?)`,
      ).bind(principalId, identityId, eventId, nowIso),
    ]);
  }

  it("reports the version without an endpoint that can read an existing phrase", async () => {
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: null, verifierStatus: null,
    });
    const created = await execute(generate(null));
    expect(created).toMatchObject({ verifierVersion: 1, verifierStatus: "active", phrase: "ablaze abrasion abrasive" });
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: 1, verifierStatus: "active",
    });
  });

  it("stores only a peppered verifier and binds its receipt to the active owner and device key", async () => {
    const result = await execute(generate(null));
    expect(result).toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: 1, verifierStatus: "active",
      wordListVersion: "eff-long-cmudict-2026-09-v2", phrase: "ablaze abrasion abrasive",
    });
    const verifier = await env.DB.prepare(
      `SELECT owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version,
        word_list_version, pepper_version, iterations, length(salt) AS salt_bytes,
        length(digest) AS digest_bytes, status, created_by_device_id, created_by_key_id,
        created_by_key_fingerprint, created_by_key_generation
       FROM owner_passphrase_verifiers`,
    ).first<Record<string, unknown>>();
    expect(verifier).toMatchObject({
      owner_principal_id: principalId, owner_identity_id: identityId, verifier_version: 1,
      algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256", domain_version: "v1",
      word_list_version: "eff-long-cmudict-2026-09-v2", pepper_version: "v1", iterations: 600000,
      salt_bytes: 16, digest_bytes: 32, status: "active", created_by_device_id: "device:home",
      created_by_key_id: "key:home", created_by_key_fingerprint: keyFingerprint, created_by_key_generation: 1,
    });
    const dump = JSON.stringify(await env.DB.prepare(
      `SELECT hex(salt) AS salt, hex(digest) AS digest FROM owner_passphrase_verifiers`,
    ).all());
    expect(dump).not.toContain("abide");
    expect(await env.DB.prepare("SELECT expected_verifier_version, new_verifier_version FROM owner_passphrase_rotation_commits")
      .first()).toEqual({ expected_verifier_version: null, new_verifier_version: 1 });
    expect(await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 1, status: "active" });
  });

  it("rotates by compare-and-swap and an older signed expectation cannot roll the head back", async () => {
    await execute(generate(null));
    const rotated = await execute(generate(1, 2));
    expect(rotated).toMatchObject({ verifierVersion: 2, verifierStatus: "active", phrase: "ablaze abrasion abrasive" });
    await expect(execute(generate(1, 3))).rejects.toThrow("owner_passphrase_state_changed");
    expect(await env.DB.prepare("SELECT verifier_version FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 2 });
    expect((await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_verifiers ORDER BY verifier_version")
      .all()).results).toEqual([
      { verifier_version: 1, status: "superseded" },
      { verifier_version: 2, status: "active" },
    ]);
  });

  it("reports disabled state and re-enables only by publishing a new signed-device version", async () => {
    await execute(generate(null));
    await disableActiveVerifier();
    await expect(execute({ schemaVersion: "1.0", operation: "status" })).resolves.toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, verifierVersion: 1, verifierStatus: "disabled",
    });
    await expect(execute(generate(1, 20))).resolves.toMatchObject({
      verifierVersion: 2,
      verifierStatus: "active",
      wordListVersion: "eff-long-cmudict-2026-09-v2",
    });
    expect(await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 2, status: "active" });
  });

  it("rejects a stale expected version before drawing words or spending KDF work", async () => {
    await execute(generate(null));
    const stale = generate(null, 6);
    const envelope = await signed(stale);
    const selected = service({ randomIndex: () => { throw new Error("stale_request_reached_generation"); } });
    await expect(selected.execute(envelope.request, stale, envelope.rawBody))
      .rejects.toThrow("owner_passphrase_state_changed");
  });

  it("loses a concurrent first-generation race atomically", async () => {
    const inner = generate(null, 8);
    const raced = service({ beforeCommit: async () => { await execute(inner); } });
    await expect(execute(generate(null, 7), raced)).rejects.toThrow("owner_passphrase_state_changed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_heads").first())
      .toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first())
      .toEqual({ count: 1 });
  });

  it("rolls back staged verifier, receipt and head when the transaction later fails", async () => {
    const broken = service({ faultStatement: env.DB.prepare("INSERT INTO principals (principal_id) VALUES ('broken')") });
    await expect(execute(generate(null), broken)).rejects.toThrow();
    for (const table of ["owner_passphrase_verifiers", "owner_passphrase_rotation_commits", "owner_passphrase_heads"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({ count: 0 });
    }
  });

  it("authenticates before body interpretation and refuses a different or revoked device", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    const body = { ...generate(null), extra: "attacker" } as unknown as OwnerPassphraseBodyV1;
    const forged = await signed(body, pair.privateKey);
    await expect(service().execute(forged.request, body, forged.rawBody)).rejects.toThrow("signature_invalid");
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:home'")
      .bind(nowIso).run();
    const revoked = await signed(generate(null, 9));
    await expect(service().execute(revoked.request, generate(null, 9), revoked.rawBody)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first())
      .toEqual({ count: 0 });
  });

  it("rejects unknown body fields after authentication without running generation", async () => {
    const body = { ...generate(null), phrase: "ablaze abrasion abrasive" } as unknown as OwnerPassphraseBodyV1;
    const envelope = await signed(body);
    await expect(service({ randomIndex: () => { throw new Error("generation_ran"); } })
      .execute(envelope.request, body, envelope.rawBody)).rejects.toThrow("owner_passphrase_body_invalid");
  });

  it("validates the exact request-salt shape after authentication and before generation", async () => {
    const body = { ...generate(null), requestSalt: "A".repeat(42) };
    const envelope = await signed(body);
    await expect(service({ randomIndex: () => { throw new Error("generation_ran"); } })
      .execute(envelope.request, body, envelope.rawBody)).rejects.toThrow("owner_passphrase_body_invalid");
  });

  it("classifies a valid device bound to a different configured owner separately", async () => {
    const body = { schemaVersion: "1.0", operation: "status" } as const;
    const envelope = await signed(body);
    await expect(service({ ownerPrincipalId: "principal:other" })
      .execute(envelope.request, body, envelope.rawBody)).rejects.toThrow("owner_passphrase_owner_mismatch");
  });
});
