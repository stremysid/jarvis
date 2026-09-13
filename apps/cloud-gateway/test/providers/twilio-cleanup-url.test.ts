import { describe, expect, it } from "vitest";
import { isTrustedCleanupUrl, twilioCleanupUrl } from "../../src/providers/twilio-cleanup-url.js";
import { snapshotTrustedPublicOrigin, snapshotUrl } from "../../src/security/trusted-public-origin.js";

describe("Twilio cleanup retry URL boundary", () => {
  const trusted = snapshotTrustedPublicOrigin(new URL("https://jarvis.example/"))!;
  const path = "/voice/relay-ended";
  it("keeps the fixed override separate from the HTTP callback route", () => {
    const url = twilioCleanupUrl(path, trusted.origin);
    expect(url.href).toBe("https://jarvis.example/voice/relay-ended#rc=2&rp=ct,rt,5xx");
    expect(isTrustedCleanupUrl(snapshotUrl(url), trusted, path)).toBe(true);
    url.hash = "";
    expect(url.href).toBe("https://jarvis.example/voice/relay-ended");
  });
  it.each([
    "https://attacker.invalid/voice/relay-ended#rc=2&rp=ct,rt,5xx",
    "https://jarvis.example:8443/voice/relay-ended#rc=2&rp=ct,rt,5xx",
    "https://user@jarvis.example/voice/relay-ended#rc=2&rp=ct,rt,5xx",
    "https://jarvis.example/voice/inbound#rc=2&rp=ct,rt,5xx",
    "https://jarvis.example/voice/relay-ended?secret=value#rc=2&rp=ct,rt,5xx",
    "http://jarvis.example/voice/relay-ended#rc=2&rp=ct,rt,5xx",
    "https://jarvis.example/voice/relay-ended#rc=5&rp=all",
    "https://jarvis.example/voice/relay-ended#",
  ])("refuses an override that changes the trusted callback contract: %s", (url) => {
    expect(isTrustedCleanupUrl(snapshotUrl(new URL(url)), trusted, path)).toBe(false);
  });
});
