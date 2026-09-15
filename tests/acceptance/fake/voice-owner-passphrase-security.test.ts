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
