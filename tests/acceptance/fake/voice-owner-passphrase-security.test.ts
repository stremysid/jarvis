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
import { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../../apps/cloud-gateway/src/persistence/voice-access-repository.js";
import { CapabilityRegistry } from "../../../apps/cloud-gateway/src/voice/capability-registry.js";
import { VoiceAccessAuthorityService } from "../../../apps/cloud-gateway/src/voice/voice-access-authority.js";
import {
  OWNER_STEP_UP_FORMAT_PROMPT,
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_PROMPT,
  OWNER_STEP_UP_REJECTED,
  OWNER_STEP_UP_RETRY_PROMPT,
  OWNER_STEP_UP_VERIFIED,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { OUTBOUND_VOICEMAIL_MESSAGE } from "../../../apps/cloud-gateway/src/voice/outbound.js";
import { createFakeCallingSystem, type FakeCallingSystem } from "./voice-call-system.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";
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

  it("constructs and verifies the shared HMAC plus PBKDF2 known answer", async () => {
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
  });

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

function evidenceText(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof ArrayBuffer) return Array.from(new Uint8Array(item));
    if (ArrayBuffer.isView(item)) {
      return Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    }
    if (item instanceof Map) return Array.from(item.entries());
    if (item instanceof Set) return Array.from(item.values());
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return item;
  });
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

describe("owner-call passphrase security contract", () => {
  it.each([
    OWNER_STEP_UP_PROMPT,
    OWNER_STEP_UP_RETRY_PROMPT,
    OWNER_STEP_UP_FORMAT_PROMPT,
    OWNER_STEP_UP_VERIFIED,
    OWNER_STEP_UP_REJECTED,
    OUTBOUND_VOICEMAIL_MESSAGE,
  ])("keeps fixed speech outside the complete-candidate language: %j", (speech) => {
    expect(() => canonicalizeOwnerPassphrase(speech)).toThrow("owner_passphrase_candidate_invalid");
  });

  it.each(["inbound", "outbound"] as const)(
    "keeps an %s owner in pre-auth with no authority, context, model, or owner command before a match",
    async (direction) => {
      const system = await createFakeCallingSystem();
      try {
        const call = await openOwnerCall(system, direction);
        expect(await call.phase()).toBe("pre_auth");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
        await call.prompt("allow +14165550111 with conversation");
        expect(await call.phase()).toBe("pre_auth");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
        expect(await call.modelRequests()).toEqual([]);
        expect(await call.turns()).toEqual([]);
        expect(await env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
          .toEqual({ count: 0 });
        expect(call.frames().map((frame) => frame.token)).not.toContainEqual(
          expect.stringMatching(/enter four digits|access change/iu),
        );
      } finally { await system.cleanup(); }
    },
  );

  it("refuses a direct owner-authority write before the matching step-up success receipt", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await expect(env.DB.prepare(`INSERT INTO call_session_authorities (
        session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
        access_document_hash, authenticated_at, expires_at
      ) SELECT session_id, 'owner', principal_id, identity_id, NULL, NULL, NULL,
        updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', provider_connected_at, '+1800 seconds')
      FROM call_sessions WHERE session_id = ?`).bind(call.sessionId).run())
        .rejects.toThrow("call_session_authority_requires_current_lineage");
      expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
    } finally { await system.cleanup(); }
  });

  it.each(["inbound", "outbound"] as const)(
    "requires a real successful verifier result and keeps every %s candidate representation out of named sinks",
    async (direction) => {
      const system = await createFakeCallingSystem();
      const logs: unknown[][] = [];
      const spies = (["debug", "info", "log", "warn", "error"] as const)
        .map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); }));
      const spoken = "ABLAZE,  ABRASION!  ABRASIVE.";
      try {
        const call = await openOwnerCall(system, direction);
        const beforeCandidate = logs.length;
        await call.prompt(spoken);
        expect(await call.phase()).toBe("active");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(1);
        await expect(env.DB.prepare(
          "SELECT count(*) AS count FROM owner_call_step_up_successes WHERE session_id = ?",
        ).bind(call.sessionId).first()).resolves.toEqual({ count: 1 });
        expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_VERIFIED)).toHaveLength(1);
        expect(await call.modelRequests()).toEqual([]);
        expect(await call.turns()).toEqual([]);
        expect(logs.slice(beforeCandidate)).toEqual([]);

        const rawHash = Array.from(new Uint8Array(await crypto.subtle.digest(
          "SHA-256", new TextEncoder().encode(spoken),
        )), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const canonicalHash = Array.from(new Uint8Array(await crypto.subtle.digest(
          "SHA-256", new TextEncoder().encode(FAKE_OWNER_PASSPHRASE),
        )), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const surfaces = evidenceText([
          logs,
          call.frames(),
          call.closeEvents(),
          await call.modelRequests(),
          await call.turns(),
          await call.durableStorage(),
          await call.durableSqlStorage(),
          await d1Evidence(),
        ]);
        for (const secret of [
          spoken,
          spoken.toUpperCase(),
          FAKE_OWNER_PASSPHRASE,
          evidenceText(FAKE_OWNER_PASSPHRASE.split(" ")),
          rawHash,
          canonicalHash,
          ...FAKE_OWNER_PASSPHRASE.split(" "),
        ]) expect(surfaces).not.toContain(secret);
      } finally {
        for (const spy of spies) spy.mockRestore();
        await system.cleanup();
      }
    },
    20_000,
  );

  it("does not let keypad input authenticate an owner", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.pin(Uint8Array.from([52, 56, 50, 55]));
      expect(await call.phase()).toBe("pre_auth");
      expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
    } finally { await system.cleanup(); }
  });

  it.each([undefined, "", "passphrase_always", "unknown_policy"])(
    "keeps exact Passed-A behind the phrase when policy is %j",
    async (policy) => {
      const system = await createFakeCallingSystem({ ownerCallerIdPolicy: policy });
      try {
        const call = await openOwnerCall(system, "inbound", "TN-Validation-Passed-A");
        expect(await call.phase()).toBe("pre_auth");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
        expect(call.frames().map((frame) => frame.token)).toContain(OWNER_STEP_UP_PROMPT);
      } finally { await system.cleanup(); }
    },
  );

  it("keeps the dormant waiver exact, explicit, and inbound-only", async () => {
    const exact = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      const call = await openOwnerCall(exact, "inbound", "TN-Validation-Passed-A");
      expect(await call.phase()).toBe("active");
      expect(await ownerAuthorityCount(call.sessionId)).toBe(1);
      expect(call.frames().map((frame) => frame.token)).not.toContain(OWNER_STEP_UP_PROMPT);
    } finally { await exact.cleanup(); }

    const variants: readonly (string | readonly string[] | undefined)[] = [
      undefined,
      "",
      "TN-Validation-Passed-B",
      "TN-Validation-Passed-C",
      "TN-Validation-Failed-A",
      "tn-validation-passed-a",
      " TN-Validation-Passed-A",
      "TN-Validation-Passed-A ",
      "TN-Validation-Passed-A-Diverted",
      "TN-Validation-Passed-A-Passthrough",
    ];
    for (const variant of variants) {
      const system = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
      try {
        const call = await openOwnerCall(system, "inbound", variant);
        expect(await call.phase(), String(variant)).toBe("pre_auth");
        expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
      } finally { await system.cleanup(); }
    }

    const duplicate = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      expect((await duplicate.inbound(undefined, [
        "TN-Validation-Passed-A", "TN-Validation-Passed-A",
      ])).status).toBe(403);
      expect(duplicate.initializations()).toHaveLength(0);
    } finally { await duplicate.cleanup(); }

    const outbound = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      const call = await openOwnerCall(outbound, "outbound");
      expect(await call.phase()).toBe("pre_auth");
      expect(await ownerAuthorityCount(call.sessionId)).toBe(0);
    } finally { await outbound.cleanup(); }
  }, 30_000);

  it("does not let the dormant caller-ID waiver authorize access management without a phrase", async () => {
    const system = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      const call = await openOwnerCall(system, "inbound", "TN-Validation-Passed-A");
      const stored = await new CallRepository(env.DB, new EventRepository(env.DB)).getCallSession(call.sessionId);
      if (stored === null) throw new Error("owner_call_fixture_missing");
      const authorities = new VoiceAccessAuthorityService(
        new VoiceAccessRepository(env.DB),
        new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
      );
      const authority = await authorities.rehydrate({
        sessionId: stored.sessionId,
        binding: stored.binding,
        now: new Date("2026-08-30T12:00:00.000Z"),
      });

      await expect(authorities.authorize(authority, "access.manage", new Date("2026-08-30T12:00:00.000Z")))
        .rejects.toThrow("owner_step_up_required");
      await expect(authorities.authorize(authority, "conversation.basic", new Date("2026-08-30T12:00:00.000Z")))
        .resolves.toBe(authority);
    } finally { await system.cleanup(); }
  });

  it("suppresses the first post-success phrase repeat before any transcript or model call", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      await call.prompt("This final arrives inside the repeat guard.");
      expect(await call.modelRequests()).toEqual([]);
      system.advanceTime(2_001);
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.modelRequests()).toEqual([]);
      expect(await call.turns()).toEqual([]);
      await expect(env.DB.prepare(
        "SELECT outcome FROM owner_call_step_up_repeat_checks WHERE session_id = ?",
      ).bind(call.sessionId).first()).resolves.toEqual({ outcome: "matched" });
      await call.prompt("What is on my calendar?");
      expect(await call.modelRequests()).toHaveLength(1);
    } finally { await system.cleanup(); }
  });

  it("passes a nonmatching first candidate-shaped final through as ordinary owner speech", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      system.advanceTime(2_001);
      const ordinary = "ablaze abrasion active";
      await call.prompt(ordinary);

      expect(await call.modelRequests()).toEqual([
        expect.objectContaining({ userText: ordinary }),
      ]);
      await expect(env.DB.prepare(
        "SELECT outcome FROM owner_call_step_up_repeat_checks WHERE session_id = ?",
      ).bind(call.sessionId).first()).resolves.toEqual({ outcome: "mismatched" });
    } finally { await system.cleanup(); }
  });

  it("assembles split finals, discards fixed echoes, and clears partial fragments on interruption", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      await call.prompt(OWNER_STEP_UP_PROMPT);
      await call.prompt("ablaze");
      await call.interrupt();
      expect(await call.phase()).toBe("pre_auth");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
    } finally { await system.cleanup(); }
  });

  it("uses clean ConversationRelay end plus callback Hangup after exactly three mismatches", async () => {
    const system = await createFakeCallingSystem();
    try {
      const call = await openOwnerCall(system, "inbound");
      for (const wrong of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await call.prompt(wrong);
      expect(await call.phase()).toBe("rejected");
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.closeCodes()).toEqual([]);
      const callback = await system.sendRelayEnded(
        call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA,
      );
      expect(callback.status).toBe(200);
      expect(await callback.text()).toBe("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
    } finally { await system.cleanup(); }
  });
});
