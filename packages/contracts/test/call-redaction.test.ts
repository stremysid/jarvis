import { describe, expect, it } from "vitest";
import { sanitizeRedaction } from "../src/calls.js";

describe("quoted credential escape boundaries", () => {
  it.each([["double", '"'], ["single", "'"]])(
    "redacts an unfinished %s-quoted credential when it ends on an escape",
    (_name, quote) => {
      // These are public fixtures. A quoted value can contain spaces and
      // periods, so falling back to one unquoted word would expose the tail.
      const prefix = `password = ${quote}alpha. bravo charlie. trailing` + "\\";
      expect(sanitizeRedaction(prefix)).toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL]" });
      expect(sanitizeRedaction(prefix + "\r\nNext.")).toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL]\r\nNext." });
      expect(sanitizeRedaction(prefix + `escape${quote} stays private.`))
        .toMatchObject({ ok: true, text: "[REDACTED_CREDENTIAL] stays private." });
    },
  );
});
