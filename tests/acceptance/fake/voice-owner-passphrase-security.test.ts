import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import vectorsText from "../../../packages/contracts/fixtures/owner-passphrase-known-answer-v1.json?raw";
import {
  canonicalizeOwnerPassphrase,
  decodeOwnerPassphraseVerifierRecord,
  generateOwnerPassphrase,
  OwnerPassphraseVerifier,
} from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import {
  OWNER_PASSPHRASE_WORD_LIST_SHA256,
  OWNER_PASSPHRASE_WORD_LIST_VERSION,
  OWNER_PASSPHRASE_WORDS,
} from "../../../apps/cloud-gateway/src/security/owner-passphrase-word-list.js";
import {
  OWNER_ACTION_AUTHORISED,
  OWNER_ACTION_EXPIRED,
  OWNER_ACTION_PIN_PROMPT,
  OWNER_ACTION_REFUSED,
  OWNER_ACTION_REPROMPT_SPEECH,
} from "../../../apps/cloud-gateway/src/voice/owner-sensitive-action.js";
import { OUTBOUND_VOICEMAIL_MESSAGE } from "../../../apps/cloud-gateway/src/voice/outbound.js";
import {
  createFakeCallingSystem as createBaseFakeCallingSystem,
  type FakeCallingSystem,
} from "./voice-call-system.js";
import {
  FAKE_OWNER_CALL_PIN,
  FAKE_OWNER_CALL_PIN_DIGITS,
  FAKE_OWNER_PASSPHRASE,
} from "./voice-access-system.js";
import type { FakeRelayCall } from "./voice-relay-system.js";

interface KnownAnswerVectors {
  readonly schemaVersion: "1.0";
  readonly canonicalizerVersion: "ascii-v1";
  readonly wordListVersion: string;
  readonly validCanonicalization: readonly { readonly input: string; readonly canonical: string }[];
  readonly invalidCandidates: readonly string[];
  readonly verifier: {
    readonly ownerIdentityId: string;
    readonly verifierVersion: number;
    readonly phrase: string;
    readonly pepperBase64: string;
    readonly saltBase64: string;
    readonly digestBase64: string;
  };
}

const vectors = JSON.parse(vectorsText) as KnownAnswerVectors;
const FUTURE_TEST_NOW = new Date("2099-01-01T00:00:00.000Z");

function createFakeCallingSystem(
  input: NonNullable<Parameters<typeof createBaseFakeCallingSystem>[0]> = {},
): ReturnType<typeof createBaseFakeCallingSystem> {
  return createBaseFakeCallingSystem({ now: FUTURE_TEST_NOW, ...input });
}

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

describe("owner-passphrase verifier and Worker-side generation", () => {
  it("pins the reviewed 2,048-word source and performs three independent unbiased draws with replacement", async () => {
    expect(OWNER_PASSPHRASE_WORDS).toHaveLength(2048);
    expect(new Set(OWNER_PASSPHRASE_WORDS).size).toBe(2048);
    expect(OWNER_PASSPHRASE_WORD_LIST_VERSION).toBe(vectors.wordListVersion);
    expect(OWNER_PASSPHRASE_WORD_LIST_SHA256).toBe("52cfd230e93567f01b90c059f7e400d915f23b558ce1a28f0bfc4dc0c9ba1cc4");
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`${OWNER_PASSPHRASE_WORDS.join("\n")}\n`),
    ));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""))
      .toBe(OWNER_PASSPHRASE_WORD_LIST_SHA256);
    expect(OWNER_PASSPHRASE_WORDS.every((word) => /^[a-z]{4,8}$/u.test(word))).toBe(true);
    for (const excluded of [
      "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
      "okay", "alright", "awhile", "online", "hangup", "maybe", "twice",
      "colour", "centre", "grey", "theatre",
      "abide", "able", "acclaim", "alarm",
    ]) expect(OWNER_PASSPHRASE_WORDS).not.toContain(excluded);
    for (const variants of [
      ["color", "colour"], ["center", "centre"], ["gray", "grey"], ["theater", "theatre"],
    ]) expect(variants.filter((word) => OWNER_PASSPHRASE_WORDS.includes(word)).length).toBeLessThanOrEqual(1);

    const supplied = [0, 0, 2047];
    const observed: number[] = [];
    const phrase = generateOwnerPassphrase(() => {
      const value = supplied.shift();
      if (value === undefined) throw new Error("unexpected fourth draw");
      observed.push(value);
      return value;
    });
    expect(observed).toEqual([0, 0, 2047]);
    expect(phrase).toBe("ablaze ablaze zoom");
  });

  it("uses one fresh 16-bit CSPRNG sample per default draw and refuses out-of-range injected indexes", () => {
    const samples = [0, 2048, 65535];
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (!(array instanceof Uint16Array) || array.length !== 1) throw new Error("unexpected_random_shape");
      const sample = samples.shift();
      if (sample === undefined) throw new Error("unexpected_fourth_sample");
      array[0] = sample;
      return array;
    });
    try {
      expect(generateOwnerPassphrase()).toBe("ablaze ablaze zoom");
      expect(samples).toEqual([]);
    } finally {
      random.mockRestore();
    }
    for (const index of [-1, 2048, 1.5]) {
      expect(() => generateOwnerPassphrase(() => index)).toThrow("owner_passphrase_generation_failed");
    }
  });

  it("runs every shared ASCII canonicalization vector and rejects every noncanonical class", () => {
    expect(vectors.schemaVersion).toBe("1.0");
    expect(vectors.canonicalizerVersion).toBe("ascii-v1");
    for (const vector of vectors.validCanonicalization) {
      const canonical = canonicalizeOwnerPassphrase(vector.input);
      try {
        expect(new TextDecoder().decode(canonical)).toBe(vector.canonical);
      } finally {
        canonical.fill(0);
      }
    }
    for (const candidate of vectors.invalidCandidates) {
      expect(() => canonicalizeOwnerPassphrase(candidate)).toThrow("owner_passphrase_candidate_invalid");
    }
    const overLimitButOtherwiseValid = `ablaze${"!".repeat(110)} abrasion abrasive`;
    expect(overLimitButOtherwiseValid.length).toBeGreaterThan(128);
    expect(() => canonicalizeOwnerPassphrase(overLimitButOtherwiseValid))
      .toThrow("owner_passphrase_candidate_invalid");
  });

  it("constructs the six-pass chained PBKDF2 known answer, verifies its phrase, and rejects a wrong one", async () => {
    const vector = vectors.verifier;
    const verifier = new OwnerPassphraseVerifier(bytes(vector.pepperBase64), "v1", () => bytes(vector.saltBase64));
    const record = await verifier.create(vector.ownerIdentityId, vector.verifierVersion, vector.phrase);
    expect(record).toEqual({
      schemaVersion: "1.0",
      algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
      domainVersion: "v1",
      wordListVersion: vectors.wordListVersion,
      pepperVersion: "v1",
      iterations: 600_000,
      verifierVersion: vector.verifierVersion,
      saltBase64: vector.saltBase64,
      digestBase64: vector.digestBase64,
    });
    await expect(verifier.verify(vector.ownerIdentityId, vector.phrase, record)).resolves.toBe(true);
    await expect(verifier.verify(vector.ownerIdentityId, "ablaze abrasion active", record)).resolves.toBe(false);
    await expect(verifier.verify(vector.ownerIdentityId, "ablaze abrasion okay", record)).resolves.toBe(false);
    await expect(verifier.verify("identity:other:voice", vector.phrase, record)).resolves.toBe(false);
    await expect(verifier.verify(vector.ownerIdentityId, vector.phrase, { ...record }))
      .rejects.toThrow("owner_passphrase_verifier_invalid");
    await expect(verifier.verify(vector.ownerIdentityId, vector.phrase, Object.freeze({ ...record })))
      .rejects.toThrow("owner_passphrase_verifier_invalid");
  }, 15_000);

  it("binds the digest to both identity and monotonic version and clears supplied salt copies", async () => {
    const supplied: Uint8Array[] = [];
    const verifier = new OwnerPassphraseVerifier(bytes(vectors.verifier.pepperBase64), "v1", () => {
      const salt = new Uint8Array(16).fill(17);
      supplied.push(salt);
      return salt;
    });
    const first = await verifier.create("identity:owner:voice", 1, "ablaze abrasion abrasive");
    const second = await verifier.create("identity:owner:voice", 2, "ablaze abrasion abrasive");
    const other = await verifier.create("identity:other:voice", 1, "ablaze abrasion abrasive");
    expect(new Set([first.digestBase64, second.digestBase64, other.digestBase64]).size).toBe(3);
    expect(supplied.every((salt) => salt.every((byte) => byte === 0))).toBe(true);
  });

  it("fails closed on every versioned verifier field instead of accepting a nearby record", async () => {
    const vector = vectors.verifier;
    const verifier = new OwnerPassphraseVerifier(bytes(vector.pepperBase64), "v1", () => bytes(vector.saltBase64));
    const issued = await verifier.create(vector.ownerIdentityId, vector.verifierVersion, vector.phrase);
    for (const [field, value] of [
      ["schemaVersion", "1.1"],
      ["algorithm", "PBKDF2-HMAC-SHA-256"],
      ["domainVersion", "v2"],
      ["wordListVersion", "unknown"],
      ["pepperVersion", "v2"],
      ["iterations", 599_999],
      ["verifierVersion", 0],
      ["saltBase64", "AAAA"],
      ["digestBase64", "AAAA"],
    ] as const) {
      expect(() => decodeOwnerPassphraseVerifierRecord({ ...issued, [field]: value }))
        .toThrow("owner_passphrase_verifier_invalid");
    }
    expect(() => decodeOwnerPassphraseVerifierRecord({ ...issued, extra: true }))
      .toThrow("owner_passphrase_verifier_invalid");
    expect(() => new OwnerPassphraseVerifier(new Uint8Array(31), "v1"))
      .toThrow("owner_passphrase_pepper_invalid");
    expect(() => new OwnerPassphraseVerifier(new Uint8Array(32), "v2"))
      .toThrow("owner_passphrase_pepper_invalid");
  });
});

async function ownerAuthorityCount(sessionId: string): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
  ).bind(sessionId).first<{ count: number }>())?.count ?? 0;
}

async function openOwnerCall(
  system: FakeCallingSystem,
  direction: "inbound" | "outbound",
  stirVerstat?: string | readonly string[],
): Promise<FakeRelayCall> {
  if (direction === "inbound") expect((await system.inbound(undefined, stirVerstat)).status).toBe(200);
  else {
    const dispatched = await system.dispatch();
    expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
    expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
  }
  const call = await system.openRelay();
  expect(call.upgradeStatus).toBe(101);
  await call.setup();
  return call;
}

const CONSOLE_METHODS = [
  "assert", "clear", "count", "countReset", "debug", "dir", "dirxml", "error",
  "group", "groupCollapsed", "groupEnd", "info", "log", "table", "time", "timeEnd",
  "timeLog", "trace", "warn",
] as const;

function spyOnEveryConsoleMethod(logs: unknown[]): readonly ReturnType<typeof vi.spyOn>[] {
  const target = console as unknown as Record<string, (...args: unknown[]) => unknown>;
  return CONSOLE_METHODS.map((method) => vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
    logs.push([method, ...args]);
  }));
}

function evidenceText(value: unknown): string {
  const seen = new WeakSet<object>();
  const evidence: string[] = [];
  const recordBytes = (bytesValue: Uint8Array): void => {
    const bytes = Uint8Array.from(bytesValue);
    evidence.push(new TextDecoder().decode(bytes));
    evidence.push(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    evidence.push(btoa(String.fromCharCode(...bytes)));
    evidence.push(Array.from(bytes).join(","));
  };
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      evidence.push(item);
      return;
    }
    if (item instanceof ArrayBuffer) {
      recordBytes(new Uint8Array(item));
      return;
    }
    if (ArrayBuffer.isView(item)) {
      recordBytes(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 0 && item.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
        recordBytes(Uint8Array.from(item as number[]));
      }
      for (const entry of item) visit(entry);
      return;
    }
    if (item instanceof Map) {
      for (const [key, entry] of item) {
        visit(key);
        visit(entry);
      }
      return;
    }
    if (item instanceof Set) {
      for (const entry of item) visit(entry);
      return;
    }
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return;
      seen.add(item);
      for (const key of Reflect.ownKeys(item)) {
        visit(String(key));
        visit((item as Record<PropertyKey, unknown>)[key]);
      }
      return;
    }
    if (item !== undefined && item !== null) evidence.push(String(item));
  };
  visit(value);
  return evidence.join("\n").toLowerCase();
}

async function digestForms(...values: readonly string[]): Promise<readonly string[]> {
  const forms: string[] = [];
  for (const value of values) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    forms.push(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    forms.push(btoa(String.fromCharCode(...digest)));
  }
  return forms.map((value) => value.toLowerCase());
}

function plaintextForms(...values: readonly string[]): readonly string[] {
  // Individual fixture words are deliberately distinctive, so a fragment leak
  // cannot hide behind the full-candidate comparison. String encodings do not
  // pass through evidenceText's binary decoder and must also be searched.
  return [...new Set(values.flatMap((value) => [value, ...(value.match(/[a-z]+/giu) ?? [])]))]
    .flatMap((value) => {
      const bytes = new TextEncoder().encode(value);
      return [value, btoa(String.fromCharCode(...bytes)),
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")];
    }).map((value) => value.toLowerCase());
}

async function d1Evidence(): Promise<readonly unknown[]> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' ORDER BY name",
  ).all<{ name: string }>();
  const rows: unknown[] = [];
  for (const { name } of tables.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("unsafe_fixture_table");
    rows.push({ table: name, rows: (await env.DB.prepare(`SELECT * FROM ${name}`).all()).results });
  }
  return rows;
}

describe("owner-call sensitive-action credential contract", () => {
  it.each([
    OUTBOUND_VOICEMAIL_MESSAGE,
    OWNER_ACTION_PIN_PROMPT,
    OWNER_ACTION_AUTHORISED,
    OWNER_ACTION_REFUSED,
    OWNER_ACTION_EXPIRED,
    ...Object.values(OWNER_ACTION_REPROMPT_SPEECH),
  ])("keeps fixed speech outside the complete-candidate language: %j", (speech) => {
    expect(() => canonicalizeOwnerPassphrase(speech)).toThrow("owner_passphrase_candidate_invalid");
  });

  it.each([undefined, "", "passphrase_always", "waive_on_passed_a", "unknown_policy"])(
    "admits an inbound owner with caller-ID policy %j and asks for no credential",
    async (policy) => {
      const system = await createFakeCallingSystem({ ownerCallerIdPolicy: policy });
      try {
        const call = await openOwnerCall(system, "inbound", "TN-Validation-Passed-A");
        expect(await call.phase()).toBe("active");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(1);
        // Nothing was verified at admission, so no step-up success was written.
        await expect(env.DB.prepare(
          "SELECT count(*) AS count FROM owner_call_step_up_successes WHERE session_id = ?",
        ).bind(call.sessionId).first()).resolves.toEqual({ count: 0 });
        const speech = call.frames().map((frame) => frame.token).join("\n");
        expect(speech).not.toMatch(/passphrase|four digit/iu);
      } finally { await system.cleanup(); }
    },
    20_000,
  );

  it.each(["inbound", "outbound"] as const)(
    "answers an ordinary %s owner question with no credential and no action question",
    async (direction) => {
      const system = await createFakeCallingSystem();
      try {
        const call = await openOwnerCall(system, direction);
        expect(await call.phase()).toBe("active");
        await call.prompt("What is on my calendar?");
        await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
        expect((await call.modelRequests())[0]?.userText).toBe("What is on my calendar?");
        await expect(env.DB.prepare("SELECT count(*) AS count FROM owner_action_requests").first())
          .resolves.toEqual({ count: 0 });
        await expect(env.DB.prepare("SELECT count(*) AS count FROM owner_action_attempts").first())
          .resolves.toEqual({ count: 0 });
      } finally { await system.cleanup(); }
    },
    20_000,
  );

  it("does not let an admission keypad code change anything or start a turn", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.pin(new TextEncoder().encode("4827"));
      expect(await call.phase()).toBe("active");
      expect(await ownerAuthorityCount(call.sessionId)).toBe(1);
      expect(await system.ownerActionAttempts(call.sessionId)).toBe(0);
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(await call.modelRequests()).toEqual([]);
      expect(await call.turns()).toEqual([]);
    } finally { await system.cleanup(); }
  }, 20_000);

  it("opens one action question, takes the keypad PIN, and keeps every digit out of every sink", async () => {
    const system = await createFakeCallingSystem();
    const logs: unknown[] = [];
    const spies = spyOnEveryConsoleMethod(logs);
    try {
      const call = await openOwnerCall(system, "inbound");
      const beforeCandidate = logs.length;
      await call.prompt("allow +14165550111 with conversation");
      expect(await call.phase()).toBe("active");
      expect(call.frames().map((frame) => frame.token)).toContainEqual(
        expect.stringContaining(OWNER_ACTION_PIN_PROMPT),
      );
      await expect(env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
        .resolves.toEqual({ count: 0 });

      await call.pin(FAKE_OWNER_CALL_PIN_DIGITS());
      await call.pin(new TextEncoder().encode("2468"));
      await call.prompt("confirm");

      const grant = await env.DB.prepare(`SELECT grant_row.status, identity.provider_subject
        FROM voice_access_grants grant_row
        JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id`)
        .first<{ status: string; provider_subject: string }>();
      expect(grant).toEqual({ status: "pending", provider_subject: "+14165550111" });

      // The receipt names what was authorised, by which credential, and is spent.
      const receipt = await env.DB.prepare(`SELECT capability, credential, consumed_at
        FROM owner_action_authorisations WHERE session_id = ?`).bind(call.sessionId)
        .first<{ capability: string; credential: string; consumed_at: string | null }>();
      expect(receipt).toEqual({
        capability: "access.manage", credential: "call_pin", consumed_at: expect.any(String),
      });

      expect(logs.slice(beforeCandidate)).toEqual([]);
      const surfaces = evidenceText([
        logs.slice(beforeCandidate),
        call.frames(),
        call.closeEvents(),
        await call.modelRequests(),
        await call.turns(),
        await call.durableStorage(),
        await call.durableSqlStorage(),
        await d1Evidence(),
      ]);
      for (const secret of [
        ...plaintextForms(FAKE_OWNER_CALL_PIN()),
        ...plaintextForms("2468"),
        ...await digestForms(FAKE_OWNER_CALL_PIN(), "2468"),
      ]) expect(surfaces).not.toContain(secret.toLowerCase());
    } finally {
      for (const spy of spies) spy.mockRestore();
      await system.cleanup();
    }
  }, 30_000);

  it("accepts the three-word phrase at the action and keeps every word out of every sink", async () => {
    const system = await createFakeCallingSystem();
    const logs: unknown[] = [];
    const spies = spyOnEveryConsoleMethod(logs);
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt("allow +14165550111 with conversation");
      const beforeCandidate = logs.length;
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      await call.pin(new TextEncoder().encode("2468"));
      await call.prompt("confirm");

      await expect(env.DB.prepare("SELECT status FROM voice_access_grants").first())
        .resolves.toEqual({ status: "pending" });
      await expect(env.DB.prepare(
        "SELECT credential FROM owner_action_authorisations WHERE session_id = ?",
      ).bind(call.sessionId).first()).resolves.toEqual({ credential: "owner_passphrase" });

      expect(logs.slice(beforeCandidate)).toEqual([]);
      const surfaces = evidenceText([
        logs.slice(beforeCandidate),
        call.frames(),
        call.closeEvents(),
        await call.modelRequests(),
        await call.turns(),
        await call.durableStorage(),
        await call.durableSqlStorage(),
        await d1Evidence(),
      ]);
      for (const secret of [
        ...plaintextForms(FAKE_OWNER_PASSPHRASE),
        ...await digestForms(FAKE_OWNER_PASSPHRASE),
      ]) expect(surfaces).not.toContain(secret.toLowerCase());
    } finally {
      for (const spy of spies) spy.mockRestore();
      await system.cleanup();
    }
  }, 30_000);

  it("refuses after five wrong PINs, keeps the call open, and lets the caller keep talking", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt("allow +14165550111 with conversation");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await call.pin(new TextEncoder().encode("0000"));
      }

      expect(call.frames().map((frame) => frame.token)).toContainEqual(
        expect.stringContaining(OWNER_ACTION_REFUSED),
      );
      expect(call.closeCodes()).toEqual([]);
      expect(await call.phase()).toBe("active");
      expect(await system.ownerActionAttempts(call.sessionId)).toBe(5);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
        .resolves.toEqual({ count: 0 });

      // A mis-heard digit is likelier than an attacker, so a spent budget
      // refuses the action and nothing else.
      await call.prompt("What is on my calendar?");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
    } finally { await system.cleanup(); }
  }, 30_000);

  it("asks again for a second action instead of reusing the first authorisation", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt("allow +14165550111 with conversation");
      await call.pin(FAKE_OWNER_CALL_PIN_DIGITS());
      await call.pin(new TextEncoder().encode("2468"));
      await call.prompt("confirm");
      await expect(env.DB.prepare("SELECT status FROM voice_access_grants").first())
        .resolves.toEqual({ status: "pending" });

      await call.prompt("allow +14165550112 with conversation");
      const questions = call.frames().filter((frame) => frame.token.includes(OWNER_ACTION_PIN_PROMPT));
      expect(questions).toHaveLength(2);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
        .resolves.toEqual({ count: 1 });

      await call.pin(FAKE_OWNER_CALL_PIN_DIGITS());
      await call.pin(new TextEncoder().encode("1357"));
      await call.prompt("confirm");
      await expect(env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
        .resolves.toEqual({ count: 2 });
    } finally { await system.cleanup(); }
  }, 30_000);
});
