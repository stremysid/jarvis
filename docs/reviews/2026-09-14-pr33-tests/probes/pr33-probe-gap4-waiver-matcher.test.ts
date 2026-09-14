import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. The research plan (docs/research/2026-09-14-callerid-spoofing-options.md:90, :278, :293)
// names these values and the startsWith/includes mutants; the contract tests four other values.
describe("PR33 probe gap 4: a non-exact attestation satisfies the enabled waiver", () => {
  it.each([
    ["TN-Validation-Passed-A-Passthrough"],
    ["TN-Validation-Passed-A-Diverted"],
    [" TN-Validation-Passed-A"],
    [["TN-Validation-Failed-A", "TN-Validation-Passed-A"]],
  ] as const)("waives the owner phrase for StirVerstat %j", async (stirVerstat) => {
    const system = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      expect((await system.inbound(undefined, stirVerstat as string | readonly string[])).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      const authorities = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
      ).bind(call.sessionId).first<{ count: number }>();
      expect({ phase: await call.phase(), ownerAuthorities: authorities?.count })
        .toEqual({ phase: "active", ownerAuthorities: 1 });
    } finally {
      await system.cleanup();
    }
  });
});
