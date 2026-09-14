// PR #31 adversarial suite, attacks 1 (auth bypass), 2 (body trust), 3 (config fail-open), 8 (preflight oracle).
// Tests named "FINDING" assert the demonstrated (undesired) behaviour so they pass as reproductions.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../../src/env.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import {
  b64, b64url, BEGIN, count, dispatch, enrollmentEnvironment, enrollmentRequest, generateKey, KEY_VERSION,
  OTHER_PHONE, OWNER_IDENTITY, PEPPER, PHONE, PREFLIGHT, REQUEST_SALT, resetEnrollmentState, seedDevice,
  seedPrincipal, send, signParts, stateCounts, STATUS, type Device, type SignedParts,
} from "./pr31-helpers.js";

const MISMATCH = { error: "device_key_mismatch" };
const REJECTED = { error: "owner_phone_enrollment_rejected" };
const EMPTY = { identities: 0, owners: 0, challenges: 0, nonces: 0 };
const encoder = new TextEncoder();
const CANONICAL_BEGIN_TEXT = `{"operation":"begin","phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`;

describe("PR31 adversarial 1: authentication bypass on the enrollment route", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  it("1a refuses an unsigned begin with the fixed mismatch body and no state", async () => {
    const response = await dispatch(enrollmentRequest({ header: null, rawBody: canonicalize(BEGIN) }), enrollmentEnvironment());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(MISMATCH);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1b refuses a forged signature for the real device id", async () => {
    const attacker = await generateKey();
    const result = await send(home, BEGIN, enrollmentEnvironment(), { key: attacker.privateKey });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(MISMATCH);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1c refuses a correctly signed begin from a revoked device", async () => {
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(new Date().toISOString(), home.deviceId).run();
    const result = await send(home, BEGIN, enrollmentEnvironment());
    expect(result.status).toBe(401);
    expect(result.json).toEqual(MISMATCH);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1d refuses every cross-principal envelope combination", async () => {
    await seedPrincipal("principal:other");
    const other = await seedDevice("device:other", "principal:other", "key:other");
    const attempts = [
      await send(other, BEGIN, enrollmentEnvironment(), { principalId: "principal:owner" }),
      await send(home, BEGIN, enrollmentEnvironment(), { principalId: "principal:other" }),
      await send(other, BEGIN, enrollmentEnvironment(), { deviceId: "device:home", principalId: "principal:owner" }),
      await send(home, BEGIN, enrollmentEnvironment(), { deviceId: "device:other", principalId: "principal:other" }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(401);
      expect(attempt.json).toEqual(MISMATCH);
    }
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("FINDING 1d' an active device of a second human principal claims the immutable owner singleton first", async () => {
    // Precondition: a second active human principal with an active device key. Migration 0006 dropped
    // principals_one_human_idx and voice guests are inserted as 'human', so only the device key is missing
    // from a reachable state. The route has no owner-principal pin (OWNER_PRINCIPAL_ID is not consulted).
    await seedPrincipal("principal:second-human");
    const intruder = await seedDevice("device:second-human", "principal:second-human", "key:second-human");
    const claimed = await send(intruder, BEGIN, enrollmentEnvironment({ OWNER_PRINCIPAL_ID: "principal:owner" }));
    expect(claimed.status).toBe(200);
    expect(claimed.json).toMatchObject({ enrollmentState: "pending" });
    expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity").first())
      .toEqual({ principal_id: "principal:second-human", identity_id: OWNER_IDENTITY });
    const owner = await send(home, STATUS, enrollmentEnvironment({ OWNER_PRINCIPAL_ID: "principal:owner" }));
    expect(owner.json).toMatchObject({ enrollmentState: "conflict" });
    await expect(env.DB.prepare("DELETE FROM voice_owner_identity").run()).rejects.toThrow(/delete_forbidden/u);
  });

  it("1e refuses a validly signed envelope whose transmitted body was tampered", async () => {
    const parts = await signParts(home, BEGIN, {
      rawBody: canonicalize({ ...BEGIN, phoneNumber: OTHER_PHONE }),
      signedBytes: canonicalize(BEGIN),
    });
    const response = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(REJECTED);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1f refuses a byte-identical replay and leaves the first challenge untouched", async () => {
    const parts = await signParts(home, BEGIN);
    const first = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
    expect(first.status).toBe(200);
    const issued = await first.json() as { challengeId: string };
    const before = await env.DB.prepare("SELECT challenge_id, response_hmac, expires_at FROM identity_challenges").all();
    const replay = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(MISMATCH);
    const after = await env.DB.prepare("SELECT challenge_id, response_hmac, expires_at FROM identity_challenges").all();
    expect(after.results).toEqual(before.results);
    expect(after.results.map((row) => row.challenge_id)).toEqual([issued.challengeId]);
  });

  it.each([
    "/identity/challenge/begin",
    "/sync/pull",
    "/identity/owner-phone-enrollment/",
    "/identity/owner-phone-enrollment?operation=begin",
  ])("1g refuses a signature made for another path: %s", async (path) => {
    const result = await send(home, BEGIN, enrollmentEnvironment(), { path });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(MISMATCH);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1g' does not route a request (signed for its own path) sent to a look-alike path", async () => {
    for (const path of [
      "/identity/owner-phone-enrollment/",
      "//identity/owner-phone-enrollment",
      "/Identity/owner-phone-enrollment",
      "/identity/owner-phone-enrollment%2F",
    ]) {
      const parts = await signParts(home, BEGIN, { path });
      const response = await dispatch(enrollmentRequest(parts, "POST", path), enrollmentEnvironment());
      expect(response.status, path).not.toBe(200);
    }
    expect(await count("channel_identities")).toBe(0);
  });

  it("1h refuses a signature for another audience", async () => {
    const result = await send(home, BEGIN, enrollmentEnvironment(), { audience: "jarvis-cloud-gateway" });
    expect(result.status).toBe(401);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1i refuses stale and future-dated envelopes just outside the five-minute window", async () => {
    const stale = await send(home, BEGIN, enrollmentEnvironment(), { issuedAt: new Date(Date.now() - 301_000).toISOString() });
    const future = await send(home, BEGIN, enrollmentEnvironment(), { issuedAt: new Date(Date.now() + 301_000).toISOString() });
    expect([stale.status, future.status]).toEqual([401, 401]);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1j refuses a POST whose signature covers GET", async () => {
    const result = await send(home, BEGIN, enrollmentEnvironment(), { method: "GET" });
    expect(result.status).toBe(401);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("1k refuses validly signed non-canonical bodies (whitespace, duplicate key, BOM) without state", async () => {
    // v2 harness self-check: the variants below differ from the canonical salted begin only in encoding.
    expect(encoder.encode(CANONICAL_BEGIN_TEXT)).toEqual(canonicalize(BEGIN));
    const variants = [
      `{"operation":"begin", "phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`,
      `{"operation":"preflight","operation":"begin","phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`,
      `﻿${CANONICAL_BEGIN_TEXT}`,
    ];
    const statuses: number[] = [];
    for (const text of variants) {
      const parts = await signParts(home, null, { rawBody: encoder.encode(text) });
      const response = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
      statuses.push(response.status);
    }
    expect(statuses.every((status) => status !== 200)).toBe(true);
    expect(await stateCounts()).toEqual(EMPTY);
    // Classification note for the report: canonicalization failures surface as 500 "internal".
    expect(statuses).toEqual([500, 500, 400]);
  });
});

describe("PR31 adversarial 2: the body cannot supply trusted identity", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  it.each([
    ["principalId", "principal:attacker"],
    ["deviceId", "device:attacker"],
    ["identityId", "identity:attacker"],
    ["ownerIdentityId", "identity:attacker"],
    ["owner", true],
    ["isOwner", true],
    ["channel", "telegram"],
    ["status", "active"],
    ["verifiedAt", "2026-09-14T00:00:00.000Z"],
  ] as const)("2a refuses begin carrying extra field %s and creates nothing", async (field, value) => {
    const result = await send(home, { ...BEGIN, [field]: value }, enrollmentEnvironment());
    expect(result.status).toBe(400);
    expect(result.json).toEqual(REJECTED);
    const counts = await stateCounts();
    expect({ identities: counts.identities, owners: counts.owners, challenges: counts.challenges })
      .toEqual({ identities: 0, owners: 0, challenges: 0 });
  });

  it("2b refuses a phone number smuggled into preflight or status", async () => {
    for (const body of [{ ...PREFLIGHT, phoneNumber: PHONE }, { ...STATUS, phoneNumber: PHONE }]) {
      const result = await send(home, body, enrollmentEnvironment());
      expect(result.status).toBe(400);
    }
    expect(await count("channel_identities")).toBe(0);
  });

  it("2c refuses an own __proto__ member carrying a principal", async () => {
    const raw = encoder.encode(
      `{"__proto__":{"principalId":"principal:attacker"},"operation":"begin","phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`,
    );
    const parts = await signParts(home, null, { rawBody: raw });
    const response = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
    expect(response.status).not.toBe(200);
    expect(await count("channel_identities")).toBe(0);
  });

  it("2d takes the identity only from OWNER_VOICE_IDENTITY_ID and the principal only from the device row", async () => {
    const result = await send(home, BEGIN, enrollmentEnvironment({ OWNER_VOICE_IDENTITY_ID: "identity:configured-by-env" }));
    expect(result.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT identity_id, principal_id, channel, enrolled_by_device_id, provider_subject FROM channel_identities",
    ).all();
    expect(rows.results).toEqual([{
      identity_id: "identity:configured-by-env", principal_id: "principal:owner", channel: "voice",
      enrolled_by_device_id: "device:home", provider_subject: PHONE,
    }]);
    expect(result.text).not.toContain("identity:configured-by-env");
    expect(result.text).not.toContain("principal:owner");
  });

  it.each(["+015005550006", "+1500555", "+1500555000612345", "15005550006", "+1 5005550006", "+1５005550006"])(
    "2e refuses a non-E.164 phone %j without creating state", async (phone) => {
      const result = await send(home, { ...BEGIN, phoneNumber: phone }, enrollmentEnvironment());
      expect(result.status).toBe(400);
      expect(await count("channel_identities")).toBe(0);
    },
  );
});

describe("PR31 adversarial 3: configuration must fail closed", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  function withOverrides(overrides: Record<string, string | undefined>) {
    const environment = enrollmentEnvironment() as Record<string, unknown>;
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
    return environment;
  }

  it.each([
    ["OWNER_VOICE_IDENTITY_ID unset", { OWNER_VOICE_IDENTITY_ID: undefined }],
    ["OWNER_VOICE_IDENTITY_ID empty", { OWNER_VOICE_IDENTITY_ID: "" }],
    ["OWNER_VOICE_IDENTITY_ID tab", { OWNER_VOICE_IDENTITY_ID: "\t" }],
    ["OWNER_VOICE_IDENTITY_ID trailing newline", { OWNER_VOICE_IDENTITY_ID: `${OWNER_IDENTITY}\n` }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION unset", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: undefined }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION empty", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: "" }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION space", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: " " }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER unset", { IDENTITY_CHALLENGE_HMAC_PEPPER: undefined }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER empty", { IDENTITY_CHALLENGE_HMAC_PEPPER: "" }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER 16 bytes", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(16).fill(1)) }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER 33 bytes", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(33).fill(1)) }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER unpadded", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(PEPPER).replace(/=+$/u, "") }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER base64url", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64url(new Uint8Array(32).fill(0xfb)) }],
  ] as const)("3a refuses a signed begin with %s and writes nothing", async (_label, overrides) => {
    const result = await send(home, BEGIN, withOverrides(overrides));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: "owner_phone_enrollment_not_configured" });
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it("3b refuses a non-NFC OWNER_VOICE_IDENTITY_ID without writing (surfaces as 500, not 503)", async () => {
    const decomposed = "identity:ownér";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    const result = await send(home, BEGIN, withOverrides({ OWNER_VOICE_IDENTITY_ID: decomposed }));
    expect(result.status).toBe(500);
    expect(await stateCounts()).toEqual(EMPTY);
  });

  it.each([" ", "identity:owner voice", ":identity:owner", "identité:owner"])(
    "FINDING 3c enrollment accepts OWNER_VOICE_IDENTITY_ID %j that inbound admission rejects, then binds it permanently",
    async (identityId) => {
      const result = await send(home, BEGIN, withOverrides({ OWNER_VOICE_IDENTITY_ID: identityId }));
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ enrollmentState: "pending" });
      expect(await env.DB.prepare("SELECT identity_id FROM voice_owner_identity").first()).toEqual({ identity_id: identityId });

      // The only consumer of the challenge (signed inbound admission) refuses the same configured id.
      await expect(new VoiceAccessRepository(env.DB).resolveInboundCandidate({
        providerE164: PHONE, ownerIdentityId: identityId, challengeHmacKeyVersion: KEY_VERSION, now: new Date(),
      })).rejects.toThrow();
      await expect(new CallRepository(env.DB, new EventRepository(env.DB)).getOrCreateInboundSession({
        callSid: `CA${"1".repeat(32)}`, callerE164: PHONE, ownerIdentityId: identityId,
        currentChallengeHmacKeyVersion: KEY_VERSION, now: new Date(),
      })).rejects.toThrow();
      // And the singleton the route just wrote cannot be removed without dropping a guard trigger.
      await expect(env.DB.prepare("DELETE FROM voice_owner_identity").run()).rejects.toThrow(/delete_forbidden/u);
    },
  );

  it("3c-control the same inbound admission accepts the enrollment when the configured id is well formed", async () => {
    const result = await send(home, BEGIN, enrollmentEnvironment());
    expect(result.status).toBe(200);
    const session = await new CallRepository(env.DB, new EventRepository(env.DB)).getOrCreateInboundSession({
      callSid: `CA${"1".repeat(32)}`, callerE164: PHONE, ownerIdentityId: OWNER_IDENTITY,
      currentChallengeHmacKeyVersion: KEY_VERSION, now: new Date(),
    });
    expect(session.binding.activationOnly).toBe(true);
    expect(session.binding.activationChallengeId).toBe((result.json as { challengeId: string }).challengeId);
  });
});

describe("PR31 adversarial 8: preflight is not an oracle", () => {
  let home: Device;
  let service: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    await seedPrincipal("principal:svc", "service");
    home = await seedDevice("device:home", "principal:owner", "key:home");
    service = await seedDevice("device:svc", "principal:svc", "key:svc");
  });

  it("8a gives byte-identical refusals to every unauthenticated or wrong-device preflight", async () => {
    const attacker = await generateKey();
    const environment = enrollmentEnvironment();
    const observe = async (label: string, request: Request) => {
      const response = await dispatch(request, environment);
      return {
        label,
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        headerNames: [...response.headers.keys()].sort().join(","),
      };
    };
    const observed = [
      await observe("no envelope", enrollmentRequest({ header: null, rawBody: canonicalize(PREFLIGHT) })),
      await observe("forged key, real device", enrollmentRequest(await signParts(home, PREFLIGHT, { key: attacker.privateKey }))),
      await observe("forged key, unknown device", enrollmentRequest(await signParts(home, PREFLIGHT, {
        key: attacker.privateKey, deviceId: "device:does-not-exist",
      }))),
      await observe("real key, wrong principal", enrollmentRequest(await signParts(home, PREFLIGHT, { principalId: "principal:svc" }))),
      await observe("service principal device", enrollmentRequest(await signParts(service, PREFLIGHT))),
      await observe("expired envelope", enrollmentRequest(await signParts(home, PREFLIGHT, {
        issuedAt: new Date(Date.now() - 600_000).toISOString(),
      }))),
      await observe("wrong audience", enrollmentRequest(await signParts(home, PREFLIGHT, { audience: "other" }))),
    ];
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(new Date().toISOString(), home.deviceId).run();
    observed.push(await observe("revoked device", enrollmentRequest(await signParts(home, PREFLIGHT))));

    const distinct = new Set(observed.map(({ label: _label, ...rest }) => JSON.stringify(rest)));
    expect(distinct.size, JSON.stringify(observed, null, 1)).toBe(1);
    expect(observed[0]).toMatchObject({ status: 401, body: JSON.stringify(MISMATCH) });
    expect(JSON.stringify(observed.map(({ label: _label, ...rest }) => rest)))
      .not.toMatch(/fingerprint|principal:|device:|identity:/u);
  });

  it("8b the successful preflight is exactly two fixed fields and does not vary with enrollment state", async () => {
    const environment = enrollmentEnvironment();
    const absent = await send(home, PREFLIGHT, environment);
    await send(home, BEGIN, environment);
    const pending = await send(home, PREFLIGHT, environment);
    expect(absent.text).toBe('{"schemaVersion":"1.0","deviceKeyMatches":true}');
    expect(pending.text).toBe(absent.text);
    expect(pending.headers.get("cache-control")).toBe("no-store");
  });

  it("INFO 8c an unsigned caller can tell whether enrollment is configured (503 vs 401)", async () => {
    const configured = await dispatch(
      enrollmentRequest({ header: null, rawBody: canonicalize(PREFLIGHT) }), enrollmentEnvironment(),
    );
    const unconfigured = await dispatch(
      enrollmentRequest({ header: null, rawBody: canonicalize(PREFLIGHT) }), { DB: env.DB },
    );
    expect([configured.status, unconfigured.status]).toEqual([401, 503]);
  });
});

// v2 (327ddda). INVERTED tests pass on the fix and fail if the finding returns. CLASSIFY tests isolate what a
// failing mixed test still proves once its embedded finding assertion no longer holds.
describe("PR31 v2 inverted findings and classification probes: route", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  function environmentWith(overrides: Record<string, string | undefined>): Partial<Env> {
    const environment = enrollmentEnvironment() as Record<string, unknown>;
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
    return environment as Partial<Env>;
  }

  it("INVERTED 1d' an active device of a second human principal cannot claim the owner singleton", async () => {
    await seedPrincipal("principal:second-human");
    const intruder = await seedDevice("device:second-human", "principal:second-human", "key:second-human");
    for (const body of [BEGIN, STATUS, PREFLIGHT]) {
      const refused = await send(intruder, body, enrollmentEnvironment());
      expect(refused.status).toBe(401);
      expect(refused.json).toEqual(MISMATCH);
    }
    // Leaving the owner pin unset does not reopen the claim: the route fails closed after authentication.
    const unpinned = await send(intruder, BEGIN, environmentWith({ OWNER_PRINCIPAL_ID: undefined }));
    expect(unpinned.status).toBe(503);
    expect(unpinned.json).toEqual({ error: "owner_phone_enrollment_not_configured" });
    const counts = await stateCounts();
    expect({ identities: counts.identities, owners: counts.owners, challenges: counts.challenges })
      .toEqual({ identities: 0, owners: 0, challenges: 0 });

    const owner = await send(home, BEGIN, enrollmentEnvironment());
    expect(owner.status).toBe(200);
    expect(owner.json).toMatchObject({ enrollmentState: "pending" });
    expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity").first())
      .toEqual({ principal_id: "principal:owner", identity_id: OWNER_IDENTITY });
  });

  it.each([" ", "identity:owner voice", ":identity:owner", "identité:owner"])(
    "INVERTED 3c enrollment refuses OWNER_VOICE_IDENTITY_ID %j before writing any enrollment state",
    async (identityId) => {
      const refused = await send(home, BEGIN, enrollmentEnvironment({ OWNER_VOICE_IDENTITY_ID: identityId }));
      expect(refused.status).toBe(503);
      expect(refused.json).toEqual({ error: "owner_phone_enrollment_not_configured" });
      const counts = await stateCounts();
      expect({ identities: counts.identities, owners: counts.owners, challenges: counts.challenges })
        .toEqual({ identities: 0, owners: 0, challenges: 0 });
      // Nothing was bound permanently: the well-formed id still enrolls and inbound admission accepts it.
      const enrolled = await send(home, BEGIN, enrollmentEnvironment());
      expect(enrolled.status).toBe(200);
      expect(await env.DB.prepare("SELECT identity_id FROM voice_owner_identity").first())
        .toEqual({ identity_id: OWNER_IDENTITY });
      const session = await new CallRepository(env.DB, new EventRepository(env.DB)).getOrCreateInboundSession({
        callSid: `CA${"2".repeat(32)}`, callerE164: PHONE, ownerIdentityId: OWNER_IDENTITY,
        currentChallengeHmacKeyVersion: KEY_VERSION, now: new Date(),
      });
      expect(session.binding.activationChallengeId).toBe((enrolled.json as { challengeId: string }).challengeId);
    },
  );

  it("INVERTED 8c an unsigned or forged caller gets the same refusal whether or not enrollment is configured", async () => {
    const attacker = await generateKey();
    const observe = async (environment: Partial<Env>, parts: SignedParts) => {
      const response = await dispatch(enrollmentRequest(parts), environment);
      return { status: response.status, body: await response.text(), headers: [...response.headers].sort() };
    };
    const probes: Array<[string, SignedParts]> = [
      ["unsigned", { header: null, rawBody: canonicalize(PREFLIGHT) }],
      ["forged key, real device", await signParts(home, PREFLIGHT, { key: attacker.privateKey })],
      ["forged key, unknown device", await signParts(home, PREFLIGHT, {
        key: attacker.privateKey, deviceId: "device:does-not-exist",
      })],
    ];
    const unconfigured: Array<Partial<Env>> = [
      { DB: env.DB },
      environmentWith({ OWNER_PRINCIPAL_ID: undefined }),
      environmentWith({ IDENTITY_CHALLENGE_HMAC_PEPPER: undefined }),
    ];
    for (const [label, parts] of probes) {
      const configured = await observe(enrollmentEnvironment(), parts);
      expect(configured, label).toMatchObject({ status: 401, body: JSON.stringify(MISMATCH) });
      for (const environment of unconfigured) expect(await observe(environment, parts), label).toEqual(configured);
    }
    // Only a request that proves possession of the device key learns the configuration state.
    expect((await send(home, PREFLIGHT, { DB: env.DB })).status).toBe(503);
  });

  it("INVERTED 1k (finding 5) validly signed non-canonical bodies are a 400 client rejection, never a 500", async () => {
    const variants = [
      `{"operation":"begin", "phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`,
      `{"operation":"preflight","operation":"begin","phoneNumber":"+15005550006","requestSalt":"${REQUEST_SALT}","schemaVersion":"1.0"}`,
      `﻿${CANONICAL_BEGIN_TEXT}`,
    ];
    const observed: Array<{ status: number; body: string }> = [];
    for (const text of variants) {
      const parts = await signParts(home, null, { rawBody: encoder.encode(text) });
      const response = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
      observed.push({ status: response.status, body: await response.text() });
    }
    expect(observed).toEqual(variants.map(() => ({ status: 400, body: JSON.stringify(REJECTED) })));
    expect(await stateCounts()).toEqual(EMPTY);
  });

  const MISCONFIGURED: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
    ["OWNER_VOICE_IDENTITY_ID unset", { OWNER_VOICE_IDENTITY_ID: undefined }],
    ["OWNER_VOICE_IDENTITY_ID empty", { OWNER_VOICE_IDENTITY_ID: "" }],
    ["OWNER_VOICE_IDENTITY_ID tab", { OWNER_VOICE_IDENTITY_ID: "\t" }],
    ["OWNER_VOICE_IDENTITY_ID trailing newline", { OWNER_VOICE_IDENTITY_ID: `${OWNER_IDENTITY}\n` }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION unset", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: undefined }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION empty", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: "" }],
    ["IDENTITY_CHALLENGE_HMAC_KEY_VERSION space", { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: " " }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER unset", { IDENTITY_CHALLENGE_HMAC_PEPPER: undefined }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER empty", { IDENTITY_CHALLENGE_HMAC_PEPPER: "" }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER 16 bytes", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(16).fill(1)) }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER 33 bytes", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(33).fill(1)) }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER unpadded", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64(PEPPER).replace(/=+$/u, "") }],
    ["IDENTITY_CHALLENGE_HMAC_PEPPER base64url", { IDENTITY_CHALLENGE_HMAC_PEPPER: b64url(new Uint8Array(32).fill(0xfb)) }],
    ["OWNER_PRINCIPAL_ID unset (new required setting)", { OWNER_PRINCIPAL_ID: undefined }],
    ["OWNER_PRINCIPAL_ID malformed (new required setting)", { OWNER_PRINCIPAL_ID: "principal owner" }],
  ];

  it.each(MISCONFIGURED)(
    "CLASSIFY 3a %s: 503 only after authentication; the one row written is the replay nonce",
    async (_label, overrides) => {
      const parts = await signParts(home, BEGIN);
      const misconfigured = await dispatch(enrollmentRequest(parts), environmentWith(overrides));
      expect(misconfigured.status).toBe(503);
      expect(await misconfigured.json()).toEqual({ error: "owner_phone_enrollment_not_configured" });
      expect(await stateCounts()).toEqual({ identities: 0, owners: 0, challenges: 0, nonces: 1 });
      // That nonce is replay protection: the same signed begin cannot be replayed once configuration is fixed.
      const replayed = await dispatch(enrollmentRequest(parts), enrollmentEnvironment());
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toEqual(MISMATCH);
      expect(await stateCounts()).toEqual({ identities: 0, owners: 0, challenges: 0, nonces: 1 });
    },
  );

  it("CLASSIFY 3b a non-NFC OWNER_VOICE_IDENTITY_ID now fails closed as 503 and writes no enrollment state", async () => {
    const decomposed = "identity:ownér";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    const result = await send(home, BEGIN, enrollmentEnvironment({ OWNER_VOICE_IDENTITY_ID: decomposed }));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: "owner_phone_enrollment_not_configured" });
    expect(await stateCounts()).toEqual({ identities: 0, owners: 0, challenges: 0, nonces: 1 });
  });

  it("CLASSIFY 8a the only non-identical refusal (signed_request_expired) is decided by the caller's own timestamp before any device, key or principal lookup", async () => {
    await seedPrincipal("principal:svc", "service");
    const service = await seedDevice("device:svc", "principal:svc", "key:svc");
    const attacker = await generateKey();
    const environment = enrollmentEnvironment();
    const observe = async (parts: SignedParts) => {
      const response = await dispatch(enrollmentRequest(parts), environment);
      return JSON.stringify({ status: response.status, body: await response.text(), headers: [...response.headers].sort() });
    };
    const refusedVariants = (issuedAt: string) => [
      signParts(home, PREFLIGHT, { issuedAt, key: attacker.privateKey }),
      signParts(home, PREFLIGHT, { issuedAt, key: attacker.privateKey, deviceId: "device:does-not-exist" }),
      signParts(home, PREFLIGHT, { issuedAt, principalId: "principal:svc" }),
      signParts(service, PREFLIGHT, { issuedAt }),
    ];
    const stale = new Date(Date.now() - 600_000).toISOString();
    const expired = [await observe(await signParts(home, PREFLIGHT, { issuedAt: stale }))];
    for (const parts of refusedVariants(stale)) expired.push(await observe(await parts));
    const refused = [await observe({ header: null, rawBody: canonicalize(PREFLIGHT) })];
    for (const parts of refusedVariants(new Date().toISOString())) refused.push(await observe(await parts));
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(new Date().toISOString(), home.deviceId).run();
    expired.push(await observe(await signParts(home, PREFLIGHT, { issuedAt: stale })));
    refused.push(await observe(await signParts(home, PREFLIGHT)));

    expect(new Set(expired).size, expired.join("\n")).toBe(1);
    expect(JSON.parse(expired[0] as string)).toMatchObject({
      status: 401, body: JSON.stringify({ error: "signed_request_expired" }),
    });
    expect(new Set(refused).size, refused.join("\n")).toBe(1);
    expect(JSON.parse(refused[0] as string)).toMatchObject({ status: 401, body: JSON.stringify(MISMATCH) });
  });
});
