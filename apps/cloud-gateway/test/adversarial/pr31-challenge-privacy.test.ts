// PR #31 adversarial suite, attacks 6 (challenge properties) and 7 (privacy of logs, bodies, events, outbox, D1).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { SIGNED_REQUEST_HEADER } from "../../src/http/sync-routes.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import {
  OWNER_PHONE_ENROLLMENT_PATH,
  OwnerPhoneEnrollmentService,
  type OwnerPhoneEnrollmentResult,
} from "../../src/sync/owner-phone-enrollment.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import {
  AUDIENCE, b64, BEGIN, count, dispatch, dumpAllTables, enrollmentEnvironment, enrollmentRequest, generateKey,
  KEY_VERSION, OTHER_PHONE, OWNER_IDENTITY, PEPPER, PHONE, PREFLIGHT, resetEnrollmentState, seedDevice,
  seedPrincipal, send, signParts, STATUS, type Device,
} from "./pr31-helpers.js";

const T0 = "2026-09-14T14:00:00.000Z";
const RESPONSE = "907315";
const decoder = new TextDecoder();
const PHONE_FRAGMENTS = [PHONE, PHONE.slice(1), PHONE.slice(0, -4), "5005550006"];
type Pending = Extract<OwnerPhoneEnrollmentResult, { challengeId: string }>;

function enrollment(now: () => Date, response = RESPONSE): OwnerPhoneEnrollmentService {
  return new OwnerPhoneEnrollmentService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: AUDIENCE }),
    ownerIdentityId: OWNER_IDENTITY,
    hmacPepper: PEPPER,
    hmacKeyVersion: KEY_VERSION,
    now,
    challengeId: () => `challenge:adv:${crypto.randomUUID()}`,
    response: () => response,
  });
}

async function begin(device: Device, at: Date, response = RESPONSE): Promise<Pending> {
  const parts = await signParts(device, BEGIN, { issuedAt: at.toISOString() });
  const result = await enrollment(() => new Date(at), response).execute(
    JSON.parse(parts.header as string) as SignedRequestV1, JSON.parse(decoder.decode(parts.rawBody)), parts.rawBody,
  );
  if (!("challengeId" in result)) throw new Error(`expected pending: ${JSON.stringify(result)}`);
  return result;
}

function challenges(at: Date) {
  const observations = new VerifiedChannelObservationAuthority();
  const service = new IdentityChallengeService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: AUDIENCE }),
    observations,
    hmacPepper: PEPPER,
    hmacKeyVersion: KEY_VERSION,
    now: () => new Date(at),
  });
  return {
    confirm: (issued: Pending, device: Device, overrides: Partial<{ initiatingDeviceId: string; response: string }> = {}) =>
      service.confirm(observations.issue({
        challengeId: issued.challengeId,
        providerRequestId: "call:adversarial",
        channel: "phone",
        principalId: device.principalId,
        identityId: OWNER_IDENTITY,
        response: overrides.response ?? issued.response,
        initiatingDeviceId: overrides.initiatingDeviceId ?? device.deviceId,
        initiatingKeyId: device.keyId,
        initiatingKeyFingerprint: device.fingerprint,
        initiatingKeyGeneration: device.generation,
      })),
  };
}

async function identityStatus(): Promise<string | null> {
  return (await env.DB.prepare("SELECT status FROM channel_identities WHERE identity_id = ?")
    .bind(OWNER_IDENTITY).first<{ status: string }>())?.status ?? null;
}

describe("PR31 adversarial 6: challenge properties", () => {
  let home: Device;

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:home", "principal:owner", "key:home");
  });

  it("6a the response is accepted one millisecond before five minutes", async () => {
    const issued = await begin(home, new Date(T0));
    expect(issued.expiresAt).toBe("2026-09-14T14:05:00.000Z");
    await expect(challenges(new Date(Date.parse(T0) + 299_999)).confirm(issued, home)).resolves.toMatchObject({ state: "active" });
  });

  it("6a' the response is refused at exactly five minutes and the identity stays pending", async () => {
    const issued = await begin(home, new Date(T0));
    await expect(challenges(new Date(Date.parse(T0) + 300_000)).confirm(issued, home)).rejects.toThrow("identity_challenge_expired");
    expect(await identityStatus()).toBe("pending");
  });

  it("6b the response is single use", async () => {
    const issued = await begin(home, new Date(T0));
    const at = new Date(Date.parse(T0) + 1_000);
    await challenges(at).confirm(issued, home);
    await expect(challenges(at).confirm(issued, home)).rejects.toThrow("identity_challenge_consumed");
  });

  it("6c a wrong response is refused without consuming the challenge", async () => {
    const issued = await begin(home, new Date(T0));
    const at = new Date(Date.parse(T0) + 1_000);
    await expect(challenges(at).confirm(issued, home, { response: "000000" })).rejects.toThrow("identity_challenge_mismatch");
    expect(await identityStatus()).toBe("pending");
    await expect(challenges(at).confirm(issued, home)).resolves.toMatchObject({ state: "active" });
  });

  it("6d a challenge issued to device A cannot be confirmed as device B, nor after A is revoked", async () => {
    const laptop = await seedDevice("device:laptop", "principal:owner", "key:laptop");
    const issued = await begin(home, new Date(T0));
    const at = new Date(Date.parse(T0) + 1_000);
    await expect(challenges(at).confirm(issued, laptop)).rejects.toThrow("identity_challenge_mismatch");
    await expect(challenges(at).confirm(issued, home, { initiatingDeviceId: laptop.deviceId }))
      .rejects.toThrow("identity_challenge_mismatch");
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(T0, home.deviceId).run();
    await expect(challenges(at).confirm(issued, home)).rejects.toThrow("identity_challenge_state_changed");
    expect(await identityStatus()).toBe("pending");
  });

  it("6e neither the response nor a bare hash of it is persisted in any table", async () => {
    const issued = await begin(home, new Date(T0));
    const bareHash = await sha256Hex(new TextEncoder().encode(RESPONSE));
    const dump = await dumpAllTables();
    for (const [table, rows] of Object.entries(dump)) {
      expect(rows, table).not.toContain(RESPONSE);
      expect(rows, table).not.toContain(bareHash);
    }
    const challenge = await env.DB.prepare("SELECT response_hmac FROM identity_challenges WHERE challenge_id = ?")
      .bind(issued.challengeId).first<{ response_hmac: string }>();
    expect(challenge?.response_hmac).toMatch(/^[0-9a-f]{64}$/u);
    await challenges(new Date(Date.parse(T0) + 1_000)).confirm(issued, home);
    for (const [table, rows] of Object.entries(await dumpAllTables())) expect(rows, table).not.toContain(RESPONSE);
  });

  it("6f the phone number is stored only in channel_identities.provider_subject", async () => {
    await begin(home, new Date(T0));
    for (const [table, rows] of Object.entries(await dumpAllTables(["channel_identities"]))) {
      for (const fragment of PHONE_FRAGMENTS) expect(rows, `${table}:${fragment}`).not.toContain(fragment);
    }
    const identity = await env.DB.prepare("SELECT * FROM channel_identities").first<Record<string, unknown>>();
    const columnsWithPhone = Object.entries(identity ?? {}).filter(([, value]) => String(value).includes(PHONE.slice(1)));
    expect(columnsWithPhone.map(([column]) => column)).toEqual(["provider_subject"]);
  });
});

describe("PR31 adversarial 7: privacy of logs, HTTP bodies, events and outbox", () => {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  let spies: Array<ReturnType<typeof vi.spyOn>>;
  let home: Device;
  let service: Device;

  function rendered(): string {
    return spies.flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map((argument) => {
      if (argument instanceof Error) return `${argument.name}:${argument.message}:${argument.stack ?? ""}`;
      if (typeof argument === "string") return argument;
      try { return JSON.stringify(argument); } catch { return String(argument); }
    }).join(" "))).join("\n");
  }

  beforeEach(async () => {
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    await seedPrincipal("principal:svc", "service");
    home = await seedDevice("device:home", "principal:owner", "key:home");
    service = await seedDevice("device:svc", "principal:svc", "key:svc");
    spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("7a no console output, error body, event, outbox row or stray table value carries the phone, response or key material", async () => {
    const environment = enrollmentEnvironment();
    const attacker = await generateKey();
    const bodies: Array<{ label: string; status: number; text: string }> = [];
    const signatures: string[] = [];
    const record = async (label: string, request: Request) => {
      const header = request.headers.get(SIGNED_REQUEST_HEADER);
      if (header !== null) {
        try { signatures.push((JSON.parse(header) as { signatureBase64: string }).signatureBase64); } catch { /* malformed on purpose */ }
      }
      const response = await dispatch(request, environment);
      bodies.push({ label, status: response.status, text: await response.text() });
    };

    // Phone registered to another identity first (state absent): opaque internal failure.
    await seedPrincipal("principal:guest");
    await env.DB.prepare(
      `INSERT INTO channel_identities
         (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
       VALUES ('identity:guest', 'principal:guest', 'voice', '+15005550009', 'pending', NULL, ?, NULL)`,
    ).bind(new Date().toISOString()).run();
    await record("bound elsewhere", enrollmentRequest(await signParts(home, { ...BEGIN, phoneNumber: "+15005550009" })));

    await record("preflight", enrollmentRequest(await signParts(home, PREFLIGHT)));
    await record("status absent", enrollmentRequest(await signParts(home, STATUS)));
    await record("begin", enrollmentRequest(await signParts(home, BEGIN)));
    await record("status pending", enrollmentRequest(await signParts(home, STATUS)));
    await record("resume", enrollmentRequest(await signParts(home, BEGIN)));
    await record("different phone", enrollmentRequest(await signParts(home, { ...BEGIN, phoneNumber: OTHER_PHONE })));
    await record("unsigned", enrollmentRequest({ header: null, rawBody: canonicalize(BEGIN) }));
    await record("forged", enrollmentRequest(await signParts(home, BEGIN, { key: attacker.privateKey })));
    await record("tampered", enrollmentRequest(await signParts(home, BEGIN, {
      rawBody: canonicalize({ ...BEGIN, phoneNumber: OTHER_PHONE }), signedBytes: canonicalize(BEGIN),
    })));
    const replayed = await signParts(home, BEGIN);
    await record("replay 1", enrollmentRequest(replayed));
    await record("replay 2", enrollmentRequest(replayed));
    await record("wrong path", enrollmentRequest(await signParts(home, BEGIN, { path: "/sync/pull" })));
    await record("extra field", enrollmentRequest(await signParts(home, { ...BEGIN, note: PHONE })));
    await record("non e164", enrollmentRequest(await signParts(home, { ...BEGIN, phoneNumber: `${PHONE}x` })));
    await record("non canonical", enrollmentRequest(await signParts(home, null, {
      rawBody: new TextEncoder().encode(`{"operation":"begin", "phoneNumber":"${PHONE}","schemaVersion":"1.0"}`),
    })));
    await record("service principal", enrollmentRequest(await signParts(service, BEGIN)));
    await record("oversized", new Request(`https://worker.internal${OWNER_PHONE_ENROLLMENT_PATH}`, {
      method: "POST", headers: { [SIGNED_REQUEST_HEADER]: "{}" }, body: PHONE.repeat(400),
    }));
    await record("get", new Request(`https://worker.internal${OWNER_PHONE_ENROLLMENT_PATH}?phone=${encodeURIComponent(PHONE)}`));
    const unconfigured = await dispatch(enrollmentRequest(await signParts(home, BEGIN)), { DB: env.DB });
    bodies.push({ label: "unconfigured", status: unconfigured.status, text: await unconfigured.text() });
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = ?")
      .bind(new Date().toISOString(), home.deviceId).run();
    await record("revoked", enrollmentRequest(await signParts(home, BEGIN)));

    const issuedResponses = bodies.flatMap(({ text }) => {
      try {
        const parsed = JSON.parse(text) as { response?: string };
        return typeof parsed.response === "string" ? [parsed.response] : [];
      } catch { return []; }
    });
    expect(issuedResponses.length).toBeGreaterThanOrEqual(2);

    const logs = rendered();
    const secrets = [
      ...PHONE_FRAGMENTS, OTHER_PHONE, "+15005550009", ...issuedResponses, b64(PEPPER),
      home.publicBase64, home.fingerprint, attacker.publicBase64, ...signatures,
    ];
    for (const secret of secrets) expect(logs, `console leaked ${secret}`).not.toContain(secret);

    const statuses = Object.fromEntries(bodies.map(({ label, status }) => [label, status]));
    expect(statuses).toMatchObject({
      "bound elsewhere": 500, preflight: 200, "status absent": 200, begin: 200, "status pending": 200, resume: 200,
      "different phone": 200, unsigned: 401, forged: 401, tampered: 400, "replay 1": 200, "replay 2": 401,
      "wrong path": 401, "extra field": 400, "non e164": 400, "non canonical": 500, "service principal": 401,
      oversized: 413, get: 405, unconfigured: 503, revoked: 401,
    });
    for (const { label, text } of bodies) {
      for (const fragment of [...PHONE_FRAGMENTS, OTHER_PHONE, "+15005550009", b64(PEPPER), home.fingerprint]) {
        expect(text, `${label} body leaked ${fragment}`).not.toContain(fragment);
      }
      if (!text.includes('"response"')) {
        for (const response of issuedResponses) expect(text, `${label} body leaked a response`).not.toContain(response);
      }
    }

    expect(await count("events")).toBe(0);
    expect(await count("outbox")).toBe(0);
    for (const [table, rows] of Object.entries(await dumpAllTables(["channel_identities"]))) {
      for (const secret of [...PHONE_FRAGMENTS, OTHER_PHONE, ...issuedResponses]) {
        expect(rows, `${table} stored ${secret}`).not.toContain(secret);
      }
    }
  });
});
