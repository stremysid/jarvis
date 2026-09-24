import { describe, expect, it } from "vitest";
import { isIssuedRedaction, type Redactor as RedactorContract } from "../../../../packages/contracts/src/calls.js";
import type { ModelToken } from "../../src/model/model-adapter.js";
import { Redactor } from "../../src/security/redaction.js";
import { StreamingOutputRedactor } from "../../src/security/streaming-output-redactor.js";

function token(index: number, text: string): ModelToken {
  return { index, text };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function runSplit(raw: string, split: number) {
  const redactor = new StreamingOutputRedactor(new Redactor());
  const emitted: ModelToken[] = [];
  let index = 0;
  const left = raw.slice(0, split);
  const right = raw.slice(split);
  if (left.length > 0) emitted.push(...redactor.push(token(index++, left)));
  if (right.length > 0) emitted.push(...redactor.push(token(index++, right)));
  const final = redactor.complete();
  emitted.push(...redactor.drain());
  return { emitted, final, text: emitted.map((item) => item.text).join("") };
}

describe("voice sentence release after unsplit redaction", () => {
  it.each([
    ['The file has password = "alpha. bravo charlie" inside. Continue safely.', "bravo charlie"],
    ["The header is Authorization: Digest a1b2c3. d4e5f6g7h8 secret.", "d4e5f6g7h8"],
    ['A safe sentence. password = "alpha. bravo charlie" stays private.', "bravo charlie"],
    ["A safe sentence. Authorization: Digest a1b2c3. d4e5f6g7h8\nContinue safely.", "d4e5f6g7h8"],
    ["Key: -----BEGIN PRIVATE KEY-----\nalpha. bravo charlie\n-----END PRIVATE KEY----- is private.", "bravo charlie"],
  ])("keeps every spoken prefix of %s equal to a prefix of its whole redaction", (raw, secret) => {
    const canonical = new Redactor().redactText(raw);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) throw new Error("synthetic_redaction_failed");
    for (let split = 1; split < raw.length; split += 1) {
      const redactor = new StreamingOutputRedactor(new Redactor(), undefined, true);
      let heard = "";
      for (const [index, text] of [raw.slice(0, split), raw.slice(split)].entries()) {
        heard += redactor.push(token(index, text)).map((part) => part.text).join("");
        expect(canonical.text.startsWith(heard), `split ${split}`).toBe(true);
        expect(heard).not.toContain(secret);
      }
      expect(redactor.complete().text).toBe(canonical.text);
      heard += redactor.drain().map((part) => part.text).join("");
      expect(heard).toBe(canonical.text);
    }
    const redactor = new StreamingOutputRedactor(new Redactor(), undefined, true);
    let heard = "";
    for (const [index, character] of [...raw].entries()) {
      heard += redactor.push(token(index, character)).map((part) => part.text).join("");
      expect(canonical.text.startsWith(heard), `character ${index}`).toBe(true);
      expect(heard).not.toContain(secret);
    }
    redactor.complete();
    expect(heard + redactor.drain().map((part) => part.text).join("")).toBe(canonical.text);
  });

  it("releases a stable sentence with its natural whitespace before EOF", () => {
    const redactor = new StreamingOutputRedactor(new Redactor(), undefined, true);
    expect(redactor.push(token(0, "A sentence."))).toEqual([]);
    expect(redactor.push(token(1, " Next"))).toEqual([{ index: 0, text: "A sentence. " }]);
    expect(redactor.complete().text).toBe("A sentence. Next");
    expect(redactor.drain()).toEqual([{ index: 1, text: "Next" }]);
  });

  it("rejects a changed redacted prefix before releasing any additional text", () => {
    let calls = 0;
    const canonical = new Redactor();
    const redactor = new StreamingOutputRedactor({
      ...canonical,
      redact: (input) => canonical.redact(input),
      redactText: () => canonical.redactText(++calls === 1 ? "First. " : "Changed. Next. "),
    }, undefined, true);
    expect(redactor.push(token(0, "First. "))).toEqual([{ index: 0, text: "First. " }]);
    expect(() => redactor.push(token(1, "Next. "))).toThrow("stream_redaction_failed");
  });

  it("preserves an EOF suffix containing only whitespace in sentence mode", () => {
    const redactor = new StreamingOutputRedactor(new Redactor(), undefined, true);
    expect(redactor.push(token(0, " "))).toEqual([]);
    expect(redactor.complete().text).toBe(" ");
    expect(redactor.drain()).toEqual([{ index: 0, text: " " }]);
  });
});

describe("StreamingOutputRedactor cross-token safety", () => {
  const fixtures = [
    {
      name: "six-digit authentication value",
      raw: "Code 123456 now",
      expected: "Code [REDACTED_AUTH_DIGITS] now",
      marker: "[REDACTED_AUTH_DIGITS]",
      secret: "123456",
    },
    {
      name: "contextual eight-digit authentication value",
      raw: "PIN: 12345678 done",
      expected: "PIN: [REDACTED_AUTH_DIGITS] done",
      marker: "[REDACTED_AUTH_DIGITS]",
      secret: "12345678",
    },
    {
      name: "bearer credential",
      raw: "Bearer abcdefghijklmnop1 done",
      expected: "[REDACTED_AUTHORIZATION] done",
      marker: "[REDACTED_AUTHORIZATION]",
      secret: "abcdefghijklmnop1",
    },
    {
      name: "authorization header",
      raw: "Authorization: Basic dXNlcjpwYXNz\r\nsafe",
      expected: "[REDACTED_AUTHORIZATION]\r\nsafe",
      marker: "[REDACTED_AUTHORIZATION]",
      secret: "dXNlcjpwYXNz",
    },
    {
      name: "quoted credential assignment",
      raw: "api_key = \"super-secret-value\"\nnext",
      expected: "[REDACTED_CREDENTIAL]\nnext",
      marker: "[REDACTED_CREDENTIAL]",
      secret: "super-secret-value",
    },
    {
      name: "known API credential",
      raw: "key sk-abcdefghijklmnopqrstuvwxyz1234 done",
      expected: "key [REDACTED_CREDENTIAL] done",
      marker: "[REDACTED_CREDENTIAL]",
      secret: "sk-abcdefghijklmnopqrstuvwxyz1234",
    },
    {
      name: "JWT credential",
      raw: "jwt eyJabcde.abcdef.abc123 done",
      expected: "jwt [REDACTED_CREDENTIAL] done",
      marker: "[REDACTED_CREDENTIAL]",
      secret: "eyJabcde.abcdef.abc123",
    },
    {
      name: "private key block",
      raw: "before\n-----BEGIN PRIVATE KEY-----\nraw-key-material\n-----END PRIVATE KEY-----\nafter",
      expected: "before\n[REDACTED_CREDENTIAL]\nafter",
      marker: "[REDACTED_CREDENTIAL]",
      secret: "raw-key-material",
    },
  ] as const;

  for (const fixture of fixtures) {
    it(`redacts ${fixture.name} at every provider-token boundary`, () => {
      for (let split = 0; split <= fixture.raw.length; split += 1) {
        const result = runSplit(fixture.raw, split);
        expect(result.text, `split ${split}`).toBe(fixture.expected);
        expect(result.text, `split ${split}`).not.toContain(fixture.secret);
        expect(occurrences(result.text, fixture.marker), `split ${split}`).toBe(1);
        expect(result.final.text, `split ${split}`).toBe(result.text);
        expect(isIssuedRedaction(result.final), `split ${split}`).toBe(true);
        expect(result.emitted.map((item) => item.index), `split ${split}`)
          .toEqual(result.emitted.map((_item, index) => index));
        expect(result.emitted.every(Object.isFrozen), `split ${split}`).toBe(true);
      }
    });
  }

  it("releases a confirmed complete safe line before provider completion", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());

    const immediate = redactor.push(token(0, "safe line\n"));

    expect(immediate).toEqual([{ index: 0, text: "safe line\n" }]);
    expect(Object.isFrozen(immediate)).toBe(true);
    const final = redactor.complete();
    expect(redactor.drain()).toEqual([]);
    expect(final.text).toBe("safe line\n");
  });

  it.each([
    ["authorization line", "Authorization: Bearer raw-open-value", "[REDACTED_AUTHORIZATION]", "raw-open-value"],
    ["quoted assignment", "password=\"raw-open-value", "[REDACTED_CREDENTIAL]", "raw-open-value"],
    ["private-key block", "-----BEGIN PRIVATE KEY-----\nraw-open-value", "[REDACTED_CREDENTIAL]", "raw-open-value"],
  ])("suppresses an open %s until EOF", (_name, raw, marker, secret) => {
    const redactor = new StreamingOutputRedactor(new Redactor());

    expect(redactor.push(token(0, raw))).toEqual([]);
    const final = redactor.complete();
    const drained = redactor.drain();
    const text = drained.map((item) => item.text).join("");

    expect(text).toBe(marker);
    expect(text).not.toContain(secret);
    expect(final.text).toBe(text);
  });

  it("normalizes across provider-token boundaries and issues exactly what was emitted", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());
    const emitted = [
      ...redactor.push(token(0, "caf")),
      ...redactor.push(token(1, "e")),
      ...redactor.push(token(2, "\u0301")),
    ];
    const final = redactor.complete();
    emitted.push(...redactor.drain());

    expect(emitted.map((item) => item.text).join("")).toBe("café");
    expect(final.text).toBe("café");
    expect(final.text.isWellFormed()).toBe(true);
    expect(final.text).toBe(final.text.normalize("NFC"));
  });
});

describe("StreamingOutputRedactor state and capture boundary", () => {
  it("captures each input token as exact own data without invoking accessors", () => {
    let reads = 0;
    const accessor = Object.defineProperty({ index: 0 }, "text", {
      enumerable: true,
      get() {
        reads += 1;
        return "raw secret";
      },
    });
    const redactor = new StreamingOutputRedactor(new Redactor());

    expect(() => redactor.push(accessor as ModelToken))
      .toThrow(expect.objectContaining({ code: "stream_redaction_input_invalid" }));
    expect(reads).toBe(0);
  });

  it("rejects an index gap and extra token fields before forwarding data", () => {
    const gap = new StreamingOutputRedactor(new Redactor());
    expect(() => gap.push(token(1, "safe")))
      .toThrow(expect.objectContaining({ code: "stream_redaction_input_invalid" }));

    const extra = new StreamingOutputRedactor(new Redactor());
    expect(() => extra.push({ index: 0, text: "safe", raw: "secret" } as ModelToken))
      .toThrow(expect.objectContaining({ code: "stream_redaction_input_invalid" }));
  });

  it("clears an ambiguous open value on cancel and permits no later flush", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());
    expect(redactor.push(token(0, "Authorization: Bearer never-forward-this"))).toEqual([]);

    expect(redactor.cancel()).toBeUndefined();
    expect(() => redactor.push(token(1, "later")))
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
    expect(() => redactor.complete())
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
    expect(() => redactor.drain())
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
  });

  it("makes EOF drain one-shot and returns frozen snapshots", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());
    expect(redactor.push(token(0, "last line"))).toEqual([]);
    redactor.complete();

    const drained = redactor.drain();

    expect(drained).toEqual([{ index: 0, text: "last line" }]);
    expect(Object.isFrozen(drained)).toBe(true);
    expect(Object.isFrozen(drained[0])).toBe(true);
    expect(() => redactor.drain())
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
  });

  it("fails closed when the captured redactor does not issue a nominal success", () => {
    const failing: RedactorContract = {
      redact: () => ({ ok: false, category: "ingest_redaction_failed" }),
      redactText: () => ({ ok: false, category: "ingest_redaction_failed" }),
    };
    const redactor = new StreamingOutputRedactor(failing);

    expect(() => redactor.push(token(0, "never forwarded\n")))
      .toThrow(expect.objectContaining({ code: "stream_redaction_failed" }));
    expect(() => redactor.drain())
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
  });
});

describe("StreamingOutputRedactor independent bounds", () => {
  it("aborts raw scalar overflow before the additional token can be forwarded", () => {
    const redactor = new StreamingOutputRedactor(new Redactor(), {
      maxRawCharacters: 4,
      maxSanitizedCharacters: 64,
    });
    expect(redactor.push(token(0, "safe"))).toEqual([]);

    expect(() => redactor.push(token(1, "x")))
      .toThrow(expect.objectContaining({ code: "stream_redaction_raw_limit" }));
    expect(() => redactor.complete())
      .toThrow(expect.objectContaining({ code: "stream_redaction_state_invalid" }));
  });

  it("enforces the independent 64 KiB raw UTF-8 ceiling", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());

    expect(() => redactor.push(token(0, "😀".repeat(16_385))))
      .toThrow(expect.objectContaining({ code: "stream_redaction_raw_limit" }));
  });

  it("aborts sanitized scalar overflow before redacted text is returned", () => {
    const redactor = new StreamingOutputRedactor(new Redactor(), {
      maxRawCharacters: 64,
      maxSanitizedCharacters: 5,
    });

    expect(() => redactor.push(token(0, "hello\n")))
      .toThrow(expect.objectContaining({ code: "stream_redaction_output_limit" }));
  });

  it("enforces the independent 64 KiB sanitized UTF-8 ceiling", () => {
    const redactor = new StreamingOutputRedactor(new Redactor());
    const expanding = `${"123456 ".repeat(3_000)}\n`;

    expect(() => redactor.push(token(0, expanding)))
      .toThrow(expect.objectContaining({ code: "stream_redaction_output_limit" }));
  });
});
