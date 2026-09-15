// Reviewer probe (PR #49): passes when workerd rejects fetch's redirect: "error".
import { describe, expect, it } from "vitest";
import { BrightspaceIcalClient } from "../../src/deadlines/brightspace-ical-client.js";

describe("zz reviewer pr49 redirect", () => {
  it("P1 workerd Request refuses redirect error", () => {
    let message = "no throw";
    try { new Request("https://example.invalid/feed.ics", { redirect: "error" }); } catch (e) { message = String(e); }
    console.log("P1 message:", message);
    expect(message).toMatch(/Invalid redirect value/);
  });
  it("P2 real global fetch rejects before any network with redirect error", async () => {
    let message = "resolved";
    try { await fetch("https://example.invalid/feed.ics", { redirect: "error" }); } catch (e) { message = String(e); }
    console.log("P2 message:", message);
    expect(message).toMatch(/Invalid redirect value/);
  });
  it("P3 the production client with the default fetch always reports unavailable", async () => {
    const client = new BrightspaceIcalClient({ feedUrl: "https://example.invalid/d2l/le/calendar/feed/user/feed.ics?token=synthetic", timeZone: "America/Toronto", timeoutMs: 5000 });
    let code = "resolved";
    try { await client.collectDeadlines(); } catch (e) { code = (e as Error).message; }
    console.log("P3 code:", code);
    expect(code).toBe("brightspace_feed_unavailable");
  });
});
