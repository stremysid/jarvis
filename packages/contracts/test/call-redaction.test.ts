import { describe, expect, it } from "vitest";
import { sanitizeRedaction } from "../src/calls.js";

// These rules protect Sid's data from someone who is not Sid. Toward Sid the
// same text is his own and stays as it is.
describe("quoted credential escape boundaries toward someone who is not Sid", () => {
  it.each([["double", '"'], ["single", "'"]])(
    "redacts an unfinished %s-quoted credential when it ends on an escape",
    (_name, quote) => {
      // These are public fixtures. A quoted value can contain spaces and
      // periods, so falling back to one unquoted word would expose the tail.
      const prefix = `password = ${quote}alpha. bravo charlie. trailing` + "\\";
      expect(sanitizeRedaction(prefix, undefined, false, "external")).toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL]" });
      expect(sanitizeRedaction(prefix + "\r\nNext.", undefined, false, "external")).toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL]\r\nNext." });
      expect(sanitizeRedaction(prefix + `escape${quote} stays private.`, undefined, false, "external"))
        .toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL] stays private." });
    },
  );
});

describe("the reader decides", () => {
  it("shows Sid his own quoted password as it is", () => {
    const text = 'password = "alpha. bravo charlie"';
    expect(sanitizeRedaction(text)).toMatchObject({ ok: true, text, markers: [] });
  });

  it("refuses an unknown reader instead of guessing one", () => {
    expect(sanitizeRedaction("my pin is 4821", undefined, false, "guest" as never))
      .toEqual({ ok: false, category: "ingest_redaction_failed" });
  });
});