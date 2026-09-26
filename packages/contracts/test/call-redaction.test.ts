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
    expect(sanitizeRedaction(text, undefined, false, "owner")).toMatchObject({ ok: true, text, markers: [] });
  });

  it("redacts as for someone who is not Sid when a caller names no reader, so a forgotten call site hides rather than leaks", () => {
    expect(sanitizeRedaction("my pin is 4821")).toMatchObject({ ok: true, text: "my pin is [REDACTED_AUTH_DIGITS]" });
    expect(sanitizeRedaction("my pin is 4821", undefined, false, "external"))
      .toMatchObject({ ok: true, text: "my pin is [REDACTED_AUTH_DIGITS]" });
  });

  // An opaque value behind a label is not a known machine-credential shape, so
  // on Sid's path it is his own text. This pins the comment above the remember
  // tool in owner-agent-core.ts: only KNOWN_CREDENTIAL shapes are refused there.
  it.each([
    "api_key=q7Rz0opaqueValue4821",
    "client_secret=q7Rz0opaqueValue4821",
    "access_token=q7Rz0opaqueValue4821",
  ])("shows Sid a labelled value of no known machine shape as it is, and hides it from anyone else: %s", (text) => {
    expect(sanitizeRedaction(text, undefined, false, "owner")).toMatchObject({ ok: true, text, markers: [] });
    expect(sanitizeRedaction(text, undefined, false, "external")).toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL]" });
  });

  it("still removes a known API-key shape from Sid's path, because that is what Jarvis's own secrets look like", () => {
    const key = `sk-${"a1".repeat(12)}`;
    expect(sanitizeRedaction(`api_key=${key}`, undefined, false, "owner"))
      .toMatchObject({ ok: true, text: "api_key=[REDACTED_CREDENTIAL]", markers: ["credential"] });
  });

  it("refuses an unknown reader instead of guessing one", () => {
    expect(sanitizeRedaction("my pin is 4821", undefined, false, "guest" as never))
      .toEqual({ ok: false, category: "ingest_redaction_failed" });
  });
});
