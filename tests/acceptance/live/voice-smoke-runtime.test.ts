import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceSmokeDriver } from "./voice-smoke-driver.js";
import { createFileEvidenceStore } from "./voice-smoke-store.mjs";

const COMMIT_SHA = "a".repeat(40);
const CORRELATION_ID = "01j00000000000000000000000";

const inboundEvidence = Object.freeze({
  schemaVersion: "1.2",
  generatorVersion: "0.1.0",
  status: "passed",
  scenario: "inbound",
  manifestKey: "inbound_call",
  commitSha: COMMIT_SHA,
  correlationId: CORRELATION_ID,
  startedAt: "2026-08-29T12:00:00.000Z",
  endedAt: "2026-08-29T12:01:00.000Z",
  terminalState: "completed",
  eventIds: ["01j00000000000000000000001", "01j00000000000000000000004"],
  authenticatedTurns: 20,
  authenticationMode: "owner_identity_pin_free",
  pinPromptCount: 0,
  pinAttemptCount: 0,
  interruptions: 1,
  firstAudibleMs: Array<number>(20).fill(3_000),
  interruptionStopMs: [900],
  persistenceVerified: true,
  recallVerified: true,
  cleanHangup: true,
  sttProvider: "Deepgram",
  sttModel: "nova-3-general",
  ttsProvider: "Google",
  ttsVoice: "en-US-Journey-O",
  signedWssHandshake: "exact-configured-url",
  dtmfDelivery: "verified",
  statusCallbackSchema: "verified",
  relayEndedCallbackSchema: "verified",
  assistantOutputEvidence: "sent_to_provider_only",
  assistantHistoryCommitted: false,
  conversationTurnResult: {
    outcome: "voice_sent",
    committedUserEventId: "01j00000000000000000000001",
    sentAssistantEventId: "01j00000000000000000000004",
    deliveryId: null,
    deliveredAssistantEventId: null,
  },
});

const completePreflight = Object.freeze({
  schemaVersion: "1.0",
  operatorAuthorized: true,
  readiness: "ready",
  fakeGatePassed: true,
  deployedCommitSha: COMMIT_SHA,
});

describe("injected live voice-smoke driver", () => {
  it("runs preflight, one scenario, and the aggregate query in that order with one bound identity", async () => {
    const observed: unknown[] = [];
    const driver = createVoiceSmokeDriver({
      preflight: async (scenario) => {
        observed.push(["preflight", scenario]);
        return completePreflight;
      },
      execute: async (request) => {
        observed.push(["execute", request, Object.isFrozen(request)]);
        return { schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID };
      },
      queryEvidence: async (request) => {
        observed.push(["query", request, Object.isFrozen(request)]);
        return inboundEvidence;
      },
    });

    await expect(driver.run("inbound")).resolves.toEqual(inboundEvidence);
    expect(observed).toEqual([
      ["preflight", "inbound"],
      ["execute", { scenario: "inbound", deployedCommitSha: COMMIT_SHA }, true],
      ["query", { scenario: "inbound", deployedCommitSha: COMMIT_SHA, correlationId: CORRELATION_ID }, true],
    ]);
  });

  it("never starts a paid scenario without exact operator, readiness, fake-gate, and revision proof", async () => {
    const invalidProofs = [
      { ...completePreflight, operatorAuthorized: false },
      { ...completePreflight, readiness: "degraded" },
      { ...completePreflight, fakeGatePassed: false },
      { ...completePreflight, deployedCommitSha: "A".repeat(40) },
      { ...completePreflight, extra: true },
    ];

    for (const proof of invalidProofs) {
      let executions = 0;
      const driver = createVoiceSmokeDriver({
        preflight: async () => proof,
        execute: async () => {
          executions += 1;
          return { schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID };
        },
        queryEvidence: async () => inboundEvidence,
      });

      await expect(driver.run("inbound")).rejects.toThrow(/^live_smoke_preflight_failed$/u);
      expect(executions).toBe(0);
    }
  });

  it("refuses a scenario receipt or aggregate record that is not bound to the requested run", async () => {
    const invalidReceipts = [
      { schemaVersion: "1.0", scenario: "outbound-answer", correlationId: CORRELATION_ID },
      { schemaVersion: "1.0", scenario: "inbound", correlationId: "not-a-ulid" },
      { schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID, extra: true },
    ];
    for (const receipt of invalidReceipts) {
      let queries = 0;
      const driver = createVoiceSmokeDriver({
        preflight: async () => completePreflight,
        execute: async () => receipt,
        queryEvidence: async () => {
          queries += 1;
          return inboundEvidence;
        },
      });
      await expect(driver.run("inbound")).rejects.toThrow(/^live_smoke_execution_failed$/u);
      expect(queries).toBe(0);
    }

    const driver = createVoiceSmokeDriver({
      preflight: async () => completePreflight,
      execute: async () => ({ schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID }),
      queryEvidence: async () => ({ ...inboundEvidence, commitSha: "b".repeat(40) }),
    });
    await expect(driver.run("inbound")).rejects.toThrow(/^live_smoke_evidence_failed$/u);
  });

  it("normalizes private adapter failures at the stage where they occur", async () => {
    const privateMessage = "private provider response and account identifier";
    const stages = [
      ["live_smoke_preflight_failed", {
        preflight: async () => { throw new Error(privateMessage); },
        execute: async () => ({ schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID }),
        queryEvidence: async () => inboundEvidence,
      }],
      ["live_smoke_execution_failed", {
        preflight: async () => completePreflight,
        execute: async () => { throw new Error(privateMessage); },
        queryEvidence: async () => inboundEvidence,
      }],
      ["live_smoke_evidence_failed", {
        preflight: async () => completePreflight,
        execute: async () => ({ schemaVersion: "1.0", scenario: "inbound", correlationId: CORRELATION_ID }),
        queryEvidence: async () => { throw new Error(privateMessage); },
      }],
    ] as const;

    for (const [expected, dependencies] of stages) {
      const driver = createVoiceSmokeDriver(dependencies);
      let message = "";
      try {
        await driver.run("inbound");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(expected);
      expect(message).not.toContain(privateMessage);
    }
  });
});

const temporaryDirectories: string[] = [];

async function temporaryEvidenceDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jarvis-voice-smoke-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local voice-smoke evidence store", () => {
  it("publishes a completed temporary record atomically under its fixed scenario name", async () => {
    const directory = await temporaryEvidenceDirectory();
    const store = createFileEvidenceStore(pathToFileURL(`${directory}/`));
    const temporaryName = `.inbound.${CORRELATION_ID}.tmp`;
    const contents = `${JSON.stringify(inboundEvidence)}\n`;

    await store.writeTemporary(temporaryName, contents);
    await store.commitTemporary(temporaryName, "inbound.json");

    await expect(readFile(join(directory, "inbound.json"), "utf8")).resolves.toBe(contents);
    await expect(stat(join(directory, temporaryName))).rejects.toThrow();
  });

  it("never replaces retained evidence without the explicit cleanup command", async () => {
    const directory = await temporaryEvidenceDirectory();
    const store = createFileEvidenceStore(pathToFileURL(`${directory}/`));
    const temporaryName = `.inbound.${CORRELATION_ID}.tmp`;
    await writeFile(join(directory, "inbound.json"), "retained\n", "utf8");
    await store.writeTemporary(temporaryName, "replacement\n");

    await expect(store.commitTemporary(temporaryName, "inbound.json")).rejects.toThrow(/^evidence_destination_exists$/u);
    await expect(readFile(join(directory, "inbound.json"), "utf8")).resolves.toBe("retained\n");
    await expect(readFile(join(directory, temporaryName), "utf8")).resolves.toBe("replacement\n");
  });

  it("refuses traversal, unrelated files, and pre-existing temporary paths", async () => {
    const directory = await temporaryEvidenceDirectory();
    const store = createFileEvidenceStore(pathToFileURL(`${directory}/`));
    const temporaryName = `.inbound.${CORRELATION_ID}.tmp`;
    await writeFile(join(directory, temporaryName), "occupied\n", "utf8");

    await expect(store.writeTemporary(temporaryName, "new\n")).rejects.toThrow(/^evidence_temporary_exists$/u);
    await expect(store.remove("../operator-notes.txt")).rejects.toThrow(/^unsafe_evidence_path$/u);
    await expect(store.remove("operator-notes.txt")).rejects.toThrow(/^unsafe_evidence_path$/u);
    await expect(readFile(join(directory, temporaryName), "utf8")).resolves.toBe("occupied\n");
  });
});
