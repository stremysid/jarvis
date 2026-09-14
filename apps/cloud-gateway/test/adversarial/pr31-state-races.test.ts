// PR #31 adversarial suite, attacks 4 (races and mid-batch failure) and 5 (resume and conflict).
// Tests named "FINDING" assert the demonstrated (undesired) behaviour so they pass as reproductions.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import {
  OwnerPhoneEnrollmentService,
  type OwnerPhoneEnrollmentResult,
} from "../../src/sync/owner-phone-enrollment.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import {
  AUDIENCE, BEGIN, count, enrollmentEnvironment, KEY_VERSION, OTHER_PHONE, OWNER_IDENTITY, PEPPER, PHONE,
  resetEnrollmentState, rotateDeviceKey, seedDevice, seedPrincipal, send, signParts, stateCounts, STATUS, type Device,
} from "./pr31-helpers.js";

const T0 = "2026-09-14T14:00:00.000Z";
const decoder = new TextDecoder();
type Pending = Extract<OwnerPhoneEnrollmentResult, { challengeId: string }>;
type ServiceDeps = ConstructorParameters<typeof OwnerPhoneEnrollmentService>[0];

let clock: Date;
let sequence: number;

function enrollment(overrides: Partial<ServiceDeps> = {}): OwnerPhoneEnrollmentService {
  return new OwnerPhoneEnrollmentService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: AUDIENCE }),
    ownerIdentityId: OWNER_IDENTITY,
    hmacPepper: PEPPER,
    hmacKeyVersion: KEY_VERSION,
    now: () => new Date(clock),
    challengeId: () => `challenge:adv:${String(sequence).padStart(3, "0")}`,
    response: () => String(310000 + sequence++),
    ...overrides,
  });
}

async function execute(device: Device, body: unknown, service = enrollment()): Promise<OwnerPhoneEnrollmentResult> {
  const parts = await signParts(device, body, { issuedAt: clock.toISOString() });
  return service.execute(
    JSON.parse(parts.header as string) as SignedRequestV1,
    JSON.parse(decoder.decode(parts.rawBody)),
    parts.rawBody,
  );
}

async function confirm(device: Device, issued: Pending, at: Date = clock) {
  const observations = new VerifiedChannelObservationAuthority();
  const challenges = new IdentityChallengeService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: AUDIENCE }),
    observations,
    hmacPepper: PEPPER,
    hmacKeyVersion: KEY_VERSION,
    now: () => new Date(at),
  });
  return challenges.confirm(observations.issue({
    challengeId: issued.challengeId,
    providerRequestId: "call:adversarial",
    channel: "phone",
    principalId: device.principalId,
    identityId: OWNER_IDENTITY,
    response: issued.response,
    initiatingDeviceId: device.deviceId,
    initiatingKeyId: device.keyId,
    initiatingKeyFingerprint: device.fingerprint,
    initiatingKeyGeneration: device.generation,
  }));
}

async function challengeIds(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT challenge_id FROM identity_challenges ORDER BY challenge_id")
    .all<{ challenge_id: string }>();
  return rows.results.map((row) => row.challenge_id);
}

function asPending(result: OwnerPhoneEnrollmentResult): Pending {
  if (!("challengeId" in result)) throw new Error(`expected pending, got ${JSON.stringify(result)}`);
  return result;
}

describe("PR31 adversarial 4: concurrent and failing begins", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
    clock = new Date(T0);
    sequence = 1;
  });

  it("4a three concurrent same-phone begins leave one identity, one singleton and one live challenge", async () => {
    const results = await Promise.allSettled([execute(home, BEGIN), execute(home, BEGIN), execute(home, BEGIN)]);
    const counts = await stateCounts();
    expect({ identities: counts.identities, owners: counts.owners, challenges: counts.challenges })
      .toEqual({ identities: 1, owners: 1, challenges: 1 });
    const [live] = await challengeIds();
    const issued = results.flatMap((result) => result.status === "fulfilled" && "challengeId" in result.value
      ? [result.value.challengeId] : []);
    expect(issued).toContain(live);
  });

  it("FINDING 4b a begin overtaken between its batch and its final read reports a response that no longer exists", async () => {
    let overtaking: Promise<OwnerPhoneEnrollmentResult> | undefined;
    const slow = enrollment({
      afterBootstrap: async () => {
        overtaking = execute(home, BEGIN);
        await overtaking;
      },
    });

    const first = asPending(await execute(home, BEGIN, slow));
    const second = asPending(await (overtaking as Promise<OwnerPhoneEnrollmentResult>));

    // Both callers are told "pending" with different challenges and responses.
    expect(first.challengeId).not.toBe(second.challengeId);
    expect(first.response).not.toBe(second.response);
    expect(first.expiresAt).toBe(second.expiresAt);
    // Only the second challenge exists; the first caller's displayed response is already dead.
    expect(await challengeIds()).toEqual([second.challengeId]);
    await expect(confirm(home, first)).rejects.toThrow("identity_challenge_not_found");
    await expect(confirm(home, second)).resolves.toMatchObject({ state: "active" });
  });

  it("4c different-phone begins racing inside the batch window bind one phone and give the loser no response", async () => {
    let raced: Promise<OwnerPhoneEnrollmentResult> | undefined;
    const loser = enrollment({
      beforeBootstrap: async () => {
        raced = execute(home, { ...BEGIN, phoneNumber: OTHER_PHONE });
        await raced;
      },
    });
    await expect(execute(home, BEGIN, loser)).rejects.toThrow("owner_phone_enrollment_state_changed");
    expect(await (raced as Promise<OwnerPhoneEnrollmentResult>)).toMatchObject({ enrollmentState: "pending" });
    expect((await env.DB.prepare("SELECT provider_subject FROM channel_identities").all()).results)
      .toEqual([{ provider_subject: OTHER_PHONE }]);
    expect(await count("voice_owner_identity")).toBe(1);
    expect(await count("identity_challenges")).toBe(1);
  });

  it("4c' unsynchronised different-phone begins through the production route keep the invariants", async () => {
    const environment = enrollmentEnvironment();
    const results = await Promise.all([
      send(home, BEGIN, environment),
      send(home, { ...BEGIN, phoneNumber: OTHER_PHONE }, environment),
    ]);
    const identities = await env.DB.prepare("SELECT provider_subject FROM channel_identities").all<{ provider_subject: string }>();
    expect(identities.results).toHaveLength(1);
    expect(await count("voice_owner_identity")).toBe(1);
    expect(await count("identity_challenges")).toBe(1);
    const pendingIndexes = results.flatMap((result, index) =>
      (result.json as { enrollmentState?: string } | null)?.enrollmentState === "pending" ? [index] : []);
    const boundIndex = identities.results[0]?.provider_subject === PHONE ? 0 : 1;
    expect(pendingIndexes).toEqual([boundIndex]);
    for (const result of results) {
      expect(result.text).not.toContain(PHONE);
      expect(result.text).not.toContain(OTHER_PHONE);
    }
  });

  it("4d a failure injected into a resume batch keeps the live challenge and its response usable", async () => {
    const first = asPending(await execute(home, BEGIN));
    const before = (await env.DB.prepare("SELECT * FROM identity_challenges").all()).results;
    const broken = enrollment({ faultStatement: env.DB.prepare("INSERT INTO principals (principal_id) VALUES ('fault')") });
    await expect(execute(home, BEGIN, broken)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT * FROM identity_challenges").all()).results).toEqual(before);
    expect(await stateCounts()).toMatchObject({ identities: 1, owners: 1, challenges: 1 });
    await expect(confirm(home, first)).resolves.toMatchObject({ state: "active" });
  });

  it("4e a crash after commit leaves a complete resumable pending state, not a partial one", async () => {
    const crashing = enrollment({ afterBootstrap: () => { throw new Error("synthetic_post_commit_crash"); } });
    await expect(execute(home, BEGIN, crashing)).rejects.toThrow("synthetic_post_commit_crash");
    expect(await stateCounts()).toMatchObject({ identities: 1, owners: 1, challenges: 1 });
    await expect(execute(home, STATUS)).resolves.toMatchObject({ enrollmentState: "pending" });
    const resumed = asPending(await execute(home, BEGIN));
    expect(await challengeIds()).toEqual([resumed.challengeId]);
    await expect(confirm(home, resumed)).resolves.toMatchObject({ state: "active" });
  });
});

describe("PR31 adversarial 5: resume and conflict", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
    clock = new Date(T0);
    sequence = 1;
  });

  it("5a an expired pending enrollment resumes only for the same phone (first retry trips FINDING 5a)", async () => {
    const first = asPending(await execute(home, BEGIN));
    clock = new Date(Date.parse(T0) + 300_000);
    await expect(execute(home, STATUS)).resolves.toMatchObject({ enrollmentState: "expired" });
    await expect(execute(home, { ...BEGIN, phoneNumber: OTHER_PHONE })).resolves.toEqual({
      schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "conflict",
    });
    // FINDING 5a (see pr31-expired-resume.test.ts): the first same-phone retry commits but reports state_changed.
    await expect(execute(home, BEGIN)).rejects.toThrow("owner_phone_enrollment_state_changed");
    const resumed = asPending(await execute(home, BEGIN));
    expect(resumed.challengeId).not.toBe(first.challengeId);
    expect(await challengeIds()).toEqual([resumed.challengeId]);
    await expect(confirm(home, first)).rejects.toThrow();
    await expect(confirm(home, resumed)).resolves.toMatchObject({ state: "active" });
  });

  it.each([
    ["another human principal", "principal:guest", null],
    ["the same principal's other voice identity", "principal:owner", "device:home"],
  ] as const)("5b a phone already bound to %s is refused atomically and opaquely", async (_label, principalId, enrolledBy) => {
    if (principalId !== "principal:owner") await seedPrincipal(principalId);
    await env.DB.prepare(
      `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
       VALUES ('identity:already-bound', ?, 'voice', ?, 'pending', NULL, ?, ?)`,
    ).bind(principalId, PHONE, T0, enrolledBy).run();

    await expect(execute(home, BEGIN)).rejects.toThrow();
    expect(await stateCounts()).toMatchObject({ identities: 1, owners: 0, challenges: 0 });

    const viaRoute = await send(home, BEGIN, enrollmentEnvironment());
    expect(viaRoute.status).toBe(500);
    expect(viaRoute.json).toEqual({ error: "owner_phone_enrollment_rejected" });
    expect(await stateCounts()).toMatchObject({ identities: 1, owners: 0, challenges: 0 });
  });

  it("5c after activation, begin reports active without issuing or rotating any challenge", async () => {
    const first = asPending(await execute(home, BEGIN));
    await confirm(home, first);
    const before = (await env.DB.prepare("SELECT * FROM identity_challenges ORDER BY challenge_id").all()).results;
    await expect(execute(home, BEGIN)).resolves.toEqual({ schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "active" });
    await expect(execute(home, STATUS)).resolves.toEqual({ schemaVersion: "1.0", deviceKeyMatches: true, enrollmentState: "active" });
    expect((await env.DB.prepare("SELECT * FROM identity_challenges ORDER BY challenge_id").all()).results).toEqual(before);
    await expect(confirm(home, first)).rejects.toThrow("identity_challenge_consumed");
  });

  it("FINDING 5d begin answers differently for the enrolled number, so the device-key holder can test guesses", async () => {
    // Absent: a number already held by another identity fails differently (throws/500) from a fresh one.
    await seedPrincipal("principal:guest");
    await env.DB.prepare(
      `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
       VALUES ('identity:guest', 'principal:guest', 'voice', '+15005550009', 'pending', NULL, ?, NULL)`,
    ).bind(T0).run();
    await expect(execute(home, { ...BEGIN, phoneNumber: "+15005550009" })).rejects.toThrow();

    // Pending: a wrong guess says "conflict"; the right guess says "pending" and silently replaces the live response.
    const live = asPending(await execute(home, BEGIN));
    await expect(execute(home, { ...BEGIN, phoneNumber: OTHER_PHONE })).resolves.toMatchObject({ enrollmentState: "conflict" });
    const rightGuess = asPending(await execute(home, BEGIN));
    await expect(confirm(home, live)).rejects.toThrow("identity_challenge_not_found");

    // Active: the right guess says "active", a wrong guess says "conflict".
    await confirm(home, rightGuess);
    await expect(execute(home, BEGIN)).resolves.toMatchObject({ enrollmentState: "active" });
    await expect(execute(home, { ...BEGIN, phoneNumber: OTHER_PHONE })).resolves.toMatchObject({ enrollmentState: "conflict" });
  });

  it("5e a second active device of the same principal cannot see, resume or rotate another device's enrollment", async () => {
    const laptop = await seedDevice("device:laptop", "principal:owner", "key:laptop");
    const issued = asPending(await execute(home, BEGIN));
    const before = (await env.DB.prepare("SELECT * FROM identity_challenges").all()).results;
    await expect(execute(laptop, STATUS)).resolves.toMatchObject({ enrollmentState: "conflict" });
    await expect(execute(laptop, BEGIN)).resolves.toMatchObject({ enrollmentState: "conflict" });
    await expect(execute(laptop, { ...BEGIN, phoneNumber: OTHER_PHONE })).resolves.toMatchObject({ enrollmentState: "conflict" });
    expect((await env.DB.prepare("SELECT * FROM identity_challenges").all()).results).toEqual(before);
    await expect(confirm(home, issued)).resolves.toMatchObject({ state: "active" });
  });

  it("5f a key rotation on the enrolling device strands the old response until an explicit same-phone resume", async () => {
    const issued = asPending(await execute(home, BEGIN));
    const rotated = await rotateDeviceKey(home, "key:home:2");
    await expect(confirm(home, issued)).rejects.toThrow("identity_challenge_state_changed");
    await expect(execute(rotated, STATUS)).resolves.toMatchObject({ enrollmentState: "expired" });
    const resumed = asPending(await execute(rotated, BEGIN));
    await expect(confirm(rotated, resumed)).resolves.toMatchObject({ state: "active" });
  });

  it("5g replacing the enrolling device with a new device row leaves a conflict that begin cannot repair", async () => {
    await execute(home, BEGIN);
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(T0, home.deviceId).run();
    const replacement = await seedDevice("device:home-replacement", "principal:owner", "key:home-replacement");
    await expect(execute(replacement, STATUS)).resolves.toMatchObject({ enrollmentState: "conflict" });
    await expect(execute(replacement, BEGIN)).resolves.toMatchObject({ enrollmentState: "conflict" });
    expect(await count("identity_challenges")).toBe(1);
  });
});
