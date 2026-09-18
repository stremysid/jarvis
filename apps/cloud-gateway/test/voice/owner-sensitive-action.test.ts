import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { OwnerCallPinRepository } from "../../src/persistence/owner-call-pin-repository.js";
import { OwnerPassphraseRepository } from "../../src/persistence/owner-passphrase-repository.js";
import { OwnerCallPinVerifier } from "../../src/security/owner-call-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import {
  OWNER_ACTION_MAX_ATTEMPTS,
  OwnerSensitiveActionService,
  type OwnerActionSubmit,
} from "../../src/voice/owner-sensitive-action.js";
import { applyOwnerSensitiveActionPinMigration } from "../persistence/migration.js";

const NOW = "2026-09-17T18:00:00.000Z";
const THIRD_PARTY = "contact.third_party";
const PIN_WORDS = "four two seven one";
const WRONG_PIN_WORDS = "one one one one";
const OWNER_PHRASE = "ablaze abrasion abrasive";
const OWNER = "principal:owner-call-pin";
const IDENTITY = "identity:owner-call-pin:voice";
const FINGERPRINT = "1".repeat(64);
const PEPPER = new Uint8Array(32).fill(29);

/** Every capability the one sensitive list holds at tier 3 today. */
const SENSITIVE_CAPABILITIES = [
  "access.manage",
  "book.service",
  "contact.third_party",
  "credentials.manage",
  "delete.data",
  "disclose.sensitive_memory",
  "safety.configure",
  "spend.money",
  "vehicle.unlock",
  "write.production",
] as const;

let clock = new Date(NOW);
let sequence = 0;

function nextSession(): Readonly<{
  sessionId: string;
  callSid: string;
  relayNonce: string;
  providerSessionId: string;
}> {
  sequence += 1;
  const hex = sequence.toString(16).toUpperCase().padStart(8, "0").repeat(4);
  return Object.freeze({
    sessionId: `01m3c${String(sequence).padStart(21, "0")}`,
    callSid: `CA${hex}`,
    relayNonce: `${sequence.toString(36).padStart(2, "0").repeat(21)}A`,
    providerSessionId: `VX${hex}`,
  });
}

function testService(): OwnerSensitiveActionService {
  const repository = new AutonomyRepository(env.DB);
  return new OwnerSensitiveActionService({
    database: env.DB,
    tiers: repository,
    autonomy: new AutonomyService({ repository, now: () => new Date(clock) }),
    pinVerifier: new OwnerCallPinVerifier(PEPPER),
    passphraseVerifier: new OwnerPassphraseVerifier(PEPPER, "v1"),
    now: () => new Date(clock),
  });
}

function verifiedDevice() {
  return {
    deviceId: "device:pin-home", principalId: OWNER, audience: "jarvis-local-agent",
    issuedAt: NOW, nonce: "fixture", bodyHash: "2".repeat(64),
    keyId: "key:pin-home", keyFingerprint: FINGERPRINT, keyGeneration: 1, body: {},
  };
}

async function seedPeople(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Sid', ?, ?)`).bind(OWNER, NOW, NOW),
    env.DB.prepare(`INSERT INTO device_keys (
        device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
        algorithm, status, device_label, bootstrap_metadata_hash, created_at
      ) VALUES ('device:pin-home', ?, 'key:pin-home', ?, ?, 1, 'ed25519', 'active', 'home', ?, ?)`)
      .bind(OWNER, `${"A".repeat(43)}=`, FINGERPRINT, "2".repeat(64), NOW),
    env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
      ) VALUES (?, ?, 'voice', '+14165550123', 'active', ?, ?, 'device:pin-home')`).bind(IDENTITY, OWNER, NOW, NOW),
    env.DB.prepare(`INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at)
      VALUES (1, ?, ?, ?)`).bind(OWNER, IDENTITY, NOW),
  ]);
}

/** Both owner credentials published through the guards production rotates through. */
async function seedCredentials(): Promise<void> {
  const pinVerifier = new OwnerCallPinVerifier(PEPPER, () => new Uint8Array(16).fill(7));
  await new OwnerCallPinRepository(env.DB).rotate({
    verified: verifiedDevice(),
    ownerPrincipalId: OWNER,
    ownerIdentityId: IDENTITY,
    expectedPinVersion: null,
    record: await pinVerifier.create(IDENTITY, 1, Uint8Array.from([52, 50, 55, 49])),
    commitId: "01m3d000000000000000000001",
    committedAt: NOW,
  });
  const passphraseVerifier = new OwnerPassphraseVerifier(PEPPER, "v1", () => new Uint8Array(16).fill(8));
  await new OwnerPassphraseRepository(env.DB).rotate({
    verified: verifiedDevice(),
    ownerPrincipalId: OWNER,
    ownerIdentityId: IDENTITY,
    expectedVerifierVersion: null,
    record: await passphraseVerifier.create(IDENTITY, 1, OWNER_PHRASE),
    commitId: "01m3d000000000000000000002",
    committedAt: NOW,
  });
}

/**
 * A call session walked to pre_auth through the same created, connecting,
 * pre_auth steps the runtime uses. A session inserted straight into pre_auth
 * is refused by the initial state trigger, which is the point of that trigger.
 */
async function seedOwnerSession(ids: ReturnType<typeof nextSession>): Promise<void> {
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?, 'owner', NULL, NULL, NULL)`)
    .bind(
      ids.sessionId, ids.callSid, OWNER, IDENTITY, IDENTITY, ids.relayNonce,
      "2026-09-17T18:05:00.000Z", "2026-09-17T18:05:00.000Z", NOW, NOW,
    ).run();
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
    .bind(ids.providerSessionId, NOW, NOW, ids.sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(NOW, ids.sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(NOW, ids.sessionId).run();
}

async function openQuestion(capability: string, summary = "Change who can reach Jarvis.") {
  const ids = nextSession();
  await seedOwnerSession(ids);
  const service = testService();
  const gate = await service.begin({
    sessionId: ids.sessionId as never, principalId: OWNER, identityId: IDENTITY, capability, summary,
  });
  if (gate.kind !== "prompt") throw new Error(`expected a prompt, got ${gate.kind}`);
  return Object.freeze({ ids, service, gate });
}

/** Every string a stored row in the new tables could hold, joined for one scan. */
async function storedText(): Promise<string> {
  const tables = [
    "owner_action_requests", "owner_action_attempts", "owner_action_reprompts", "owner_action_authorisations",
  ];
  const values: string[] = [];
  for (const table of tables) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
    for (const row of rows.results) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") values.push(value);
        else if (value instanceof ArrayBuffer) values.push(new TextDecoder().decode(value));
      }
    }
  }
  return values.join("\n");
}

describe("owner sensitive action", () => {
  beforeAll(async () => {
    await applyOwnerSensitiveActionPinMigration();
    await seedPeople();
    await seedCredentials();
  });

  afterEach(() => {
    clock = new Date(NOW);
  });

  it("asks for nothing when the tier table does not mark the capability sensitive", async () => {
    const ids = nextSession();
    await seedOwnerSession(ids);

    await expect(testService().begin({
      sessionId: ids.sessionId as never, principalId: OWNER, identityId: IDENTITY,
      capability: "read.archive", summary: "Read the archive.",
    })).resolves.toEqual({ kind: "not_sensitive" });
  });

  it.each(SENSITIVE_CAPABILITIES)("demands the PIN before %s", async (capability) => {
    const question = await openQuestion(capability);
    expect(question.gate.capability).toBe(capability);
    expect(question.gate.explanation).toBe("Change who can reach Jarvis.");
  });

  it("authorises exactly the capability the question named and nothing else", async () => {
    const question = await openQuestion("access.manage");

    const result = await question.service.submitSpoken(question.gate.requestId, PIN_WORDS);

    expect(result.kind).toBe("authorised");
    if (result.kind !== "authorised") throw new Error("unreachable");
    expect(result.credential).toBe("call_pin");
    await expect(question.service.liveReceipt({
      sessionId: question.ids.sessionId as never, capability: "access.manage",
    })).resolves.toEqual(expect.objectContaining({ authorisationId: result.authorisationId }));
    await expect(question.service.liveReceipt({
      sessionId: question.ids.sessionId as never, capability: THIRD_PARTY,
    })).resolves.toBeNull();
    // The receipt is bound to one question, so the answer cannot be replayed.
    await expect(question.service.submitSpoken(question.gate.requestId, PIN_WORDS))
      .resolves.toEqual(expect.objectContaining({ kind: "refused" }));
  });

  it("spends a receipt by the action it authorised and never hands it back", async () => {
    const question = await openQuestion("book.service", "Book the table.");
    const result = await question.service.submitSpoken(question.gate.requestId, PIN_WORDS);
    if (result.kind !== "authorised") throw new Error(`expected an authorisation, got ${result.kind}`);

    await question.service.consume(result.authorisationId);

    await expect(question.service.liveReceipt({
      sessionId: question.ids.sessionId as never, capability: "book.service",
    })).resolves.toBeNull();
  });

  it("expires the question once its two minutes have passed", async () => {
    const question = await openQuestion("delete.data", "Delete the archive.");
    clock = new Date(new Date(NOW).valueOf() + 120_000);

    const result = await question.service.submitSpoken(question.gate.requestId, PIN_WORDS);

    expect(result.kind).toBe("expired");
    if (result.kind !== "expired") throw new Error("unreachable");
    expect(result.speech).toMatch(/ask me again/iu);
    await expect(question.service.liveReceipt({
      sessionId: question.ids.sessionId as never, capability: "delete.data",
    })).resolves.toBeNull();
  });

  it("still accepts the three-word phrase that was already spoken into this system", async () => {
    const question = await openQuestion("credentials.manage", "Change a credential.");

    const result = await question.service.submitSpoken(question.gate.requestId, OWNER_PHRASE);

    expect(result).toEqual(expect.objectContaining({ kind: "authorised", credential: "owner_passphrase" }));
  });

  it("accepts four digits from the keypad and zeroises the array it was handed", async () => {
    const question = await openQuestion("safety.configure", "Change a safety setting.");
    const digits = new Uint8Array([52, 50, 55, 49]);

    const result = await question.service.submitKeypad(question.gate.requestId, digits);

    expect(result).toEqual(expect.objectContaining({ kind: "authorised", credential: "call_pin" }));
    expect([...digits]).toEqual([0, 0, 0, 0]);
  });

  it("re-prompts five distinct ways rather than ending the call on a mis-hearing", async () => {
    const question = await openQuestion("disclose.sensitive_memory", "Read a sensitive memory.");

    const speech: string[] = [];
    for (let attempt = 0; attempt < OWNER_ACTION_MAX_ATTEMPTS - 1; attempt += 1) {
      const result = await question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS);
      expect(result.kind).toBe("reprompt");
      if (result.kind !== "reprompt") throw new Error("unreachable");
      speech.push(result.speech);
    }

    const last = await question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS);
    expect(last.kind).toBe("refused");
    expect(new Set(speech).size).toBe(speech.length);
    expect(speech.join(" ")).toMatch(/keypad/iu);
  });

  it("cannot start a fresh five guesses by opening a second question in the same call", async () => {
    const question = await openQuestion("spend.money", "Pay the invoice.");
    for (let attempt = 0; attempt < OWNER_ACTION_MAX_ATTEMPTS; attempt += 1) {
      await question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS);
    }

    await expect(question.service.begin({
      sessionId: question.ids.sessionId as never, principalId: OWNER, identityId: IDENTITY,
      capability: "book.service", summary: "Book the table.",
    })).resolves.toEqual(expect.objectContaining({ kind: "exhausted" }));
  });

  it("re-prompts without spending a guess when the speech was never four digits", async () => {
    const question = await openQuestion("vehicle.unlock", "Unlock the car.");

    const result = await question.service.submitSpoken(question.gate.requestId, "the weather is fine");

    expect(result).toEqual(expect.objectContaining({ kind: "reprompt", reprompt: "unclear" }));
  });

  it("reserves the attempt before the chained verifier spends any of its six passes", async () => {
    const question = await openQuestion("spend.money", "Pay the invoice.");
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const observed: { iterations: number; reserved: number; settled: number }[] = [];
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (algorithm, baseKey, length) => {
      const counts = await env.DB.prepare(`SELECT
        coalesce(sum(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END), 0) AS reserved,
        coalesce(sum(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END), 0) AS settled
        FROM owner_action_attempts WHERE request_id = ?`)
        .bind(question.gate.requestId).first<{ reserved: number; settled: number }>();
      observed.push({
        iterations: typeof algorithm === "object" && algorithm !== null && "iterations" in algorithm
          ? Number((algorithm as { iterations: unknown }).iterations)
          : -1,
        reserved: counts?.reserved ?? -1,
        settled: counts?.settled ?? -1,
      });
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      await expect(question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS))
        .resolves.toEqual(expect.objectContaining({ kind: "reprompt" }));
      expect(observed.map((entry) => entry.iterations)).toEqual(Array(6).fill(100_000));
      // Every pass of the derivation ran with the ordinal already durable and
      // still unsettled, so work spent by a candidate that arrives in the
      // middle of another one is charged to the same five attempts.
      expect(observed.every((entry) => entry.reserved === 1 && entry.settled === 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("refuses a candidate that arrives while the last attempt is deriving", async () => {
    const question = await openQuestion("safety.configure", "Change who can reach Jarvis.");
    for (let attempt = 0; attempt < OWNER_ACTION_MAX_ATTEMPTS - 1; attempt += 1) {
      await question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS);
    }

    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    let concurrent: Promise<OwnerActionSubmit> | null = null;
    let derivations = 0;
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (algorithm, baseKey, length) => {
      derivations += 1;
      if (concurrent === null) {
        // The next frame arrives while this attempt is still deriving, and is
        // settled here so the ordering does not depend on luck.
        concurrent = question.service.submitKeypad(question.gate.requestId, Uint8Array.from([1, 1, 1, 1]));
        await concurrent;
      }
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      await expect(question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS))
        .resolves.toEqual(expect.objectContaining({ kind: "refused" }));
      await expect(concurrent).resolves.toEqual(expect.objectContaining({ kind: "refused" }));
      // Only the fifth attempt was derived. Reserving after the verifier ran
      // would have let the second candidate derive too, and the call would
      // have spent six attempts' worth of work on one question.
      expect(derivations).toBe(6);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("keeps every four digits out of the question, the attempt, the receipt and the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const question = await openQuestion("write.production", "Restart the live service.");
      await question.service.submitSpoken(question.gate.requestId, WRONG_PIN_WORDS);
      const authorised = await question.service.submitSpoken(question.gate.requestId, "4 2 7 1");
      if (authorised.kind !== "authorised") throw new Error(`expected an authorisation, got ${authorised.kind}`);

      const stored = await storedText();
      for (const surface of ["4271", "4 2 7 1", "4,2,7,1", PIN_WORDS]) {
        expect(stored).not.toContain(surface);
        expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(surface);
      }
      await expect(env.DB.prepare(`SELECT credential, credential_version, capability, authorised_at, expires_at
        FROM owner_action_authorisations WHERE capability = 'write.production'`).first()).resolves.toEqual({
        credential: "call_pin", credential_version: 1, capability: "write.production",
        authorised_at: NOW, expires_at: "2026-09-17T18:02:00.000Z",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
