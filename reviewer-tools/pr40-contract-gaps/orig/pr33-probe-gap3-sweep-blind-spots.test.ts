import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. Same candidate and same flow as the contract's leak case.
const CANDIDATE = "synthetic meadow lantern";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("PR33 probe gap 3: candidates survive in channels the contract cannot see", () => {
  afterEach(() => vi.restoreAllMocks());

  it("one candidate: structured logs, console.info, relay frames and non-string Durable Object storage", async () => {
    const contractStyle: string[] = [];
    const raw: unknown[][] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        raw.push([method, ...values]);
        // Exactly the contract's capture: three methods, String() per argument.
        if (method === "error" || method === "warn" || method === "log") {
          contractStyle.push(values.map((value) => String(value)).join(" "));
        }
      });
    }
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(CANDIDATE);
      const storage = await call.durableStorage();
      const stepUp = storage["call-session.step-up.v1"] as {
        readonly lastCandidateBytes: Uint8Array;
        readonly canonicalWords: readonly string[];
        readonly upper: string;
        readonly digest: string;
        readonly heard: Map<string, string>;
      };
      let journal: readonly Record<string, unknown>[];
      try {
        journal = await call.durableSql("SELECT text FROM relay_prompt_journal");
      } catch (error) {
        journal = [{ text: `sql_unavailable:${String(error)}` }];
      }
      expect({
        contractStyleLogCapture: JSON.stringify(contractStyle).includes(CANDIDATE),
        contractStyleStorageSweep: JSON.stringify(storage).includes(CANDIDATE),
        phase: await call.phase(),
        structuredLogArguments: JSON.stringify(raw).includes(CANDIDATE),
        relayFramesEchoCandidate: JSON.stringify(call.frames()).includes(CANDIDATE),
        decodedStorageBytes: new TextDecoder().decode(stepUp.lastCandidateBytes),
        storageWordArray: stepUp.canonicalWords.join(" "),
        storageUppercase: stepUp.upper.toLowerCase(),
        storageMapValue: stepUp.heard.get("last"),
        unpepperedSha256Matches: stepUp.digest === await sha256Hex(CANDIDATE),
        sqliteJournal: journal.map((row) => row.text),
      }).toEqual({
        contractStyleLogCapture: false,
        contractStyleStorageSweep: false,
        phase: "pre_auth",
        structuredLogArguments: true,
        relayFramesEchoCandidate: true,
        decodedStorageBytes: CANDIDATE,
        storageWordArray: CANDIDATE,
        storageUppercase: CANDIDATE,
        storageMapValue: CANDIDATE,
        unpepperedSha256Matches: true,
        sqliteJournal: [CANDIDATE],
      });
    } finally {
      await system.cleanup();
    }
  });

  it("three candidates: the rejection path logs every candidate, and the contract's rejection case captures nothing", async () => {
    const raw: unknown[][] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { raw.push([method, ...values]); });
    }
    const system = await createFakeCallingSystem();
    try {
      await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
      expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      const candidates = ["synthetic wrong alpha", "synthetic wrong bravo", "synthetic wrong charlie"];
      for (const candidate of candidates) await call.prompt(candidate);
      const errorLines = raw.filter(([method]) => method === "error")
        .map((entry) => entry.slice(1).map((value) => String(value)).join(" "));
      expect({
        phase: await call.phase(),
        closeCodes: call.closeCodes(),
        rejectionLogCarriesAllCandidates: errorLines.some((line) => candidates.every((candidate) => line.includes(candidate))),
      }).toEqual({ phase: "rejected", closeCodes: [1008], rejectionLogCarriesAllCandidates: true });
    } finally {
      await system.cleanup();
    }
  });
});
