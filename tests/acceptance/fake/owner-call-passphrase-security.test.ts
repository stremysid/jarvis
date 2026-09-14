import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeCallingSystem, type FakeCallingSystem } from "./voice-call-system.js";
import type { FakeRelayCall } from "./voice-relay-system.js";

const PASSED_A = "TN-Validation-Passed-A";
const SYNTHETIC_CANDIDATE = "synthetic meadow lantern";

async function openOwnerCall(
  direction: "inbound" | "outbound",
  input: { readonly ownerCallerIdPolicy?: string; readonly stirVerstat?: string } = {},
): Promise<{ readonly system: FakeCallingSystem; readonly call: FakeRelayCall }> {
  const system = await createFakeCallingSystem(
    input.ownerCallerIdPolicy === undefined
      ? {}
      : { ownerCallerIdPolicy: input.ownerCallerIdPolicy },
  );
  if (direction === "inbound") {
    const response = await system.inbound(undefined, input.stirVerstat);
    expect(response.status).toBe(200);
  } else {
    await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
    expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
  }
  const call = await system.openRelay();
  await call.setup();
  return { system, call };
}

async function ownerAuthorityCount(sessionId: string): Promise<number> {
  return (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
  ).bind(sessionId).first<{ count: number }>())?.count ?? 0;
}

function contains(text: unknown, candidate: string): boolean {
  return JSON.stringify(text).includes(candidate);
}

describe("owner call passphrase security contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["inbound", "outbound"] as const)(
    "does not mint owner authority for an %s call before a passed step-up",
    async (direction) => {
      const { system, call } = await openOwnerCall(direction);
      try {
        expect({
          phase: await call.phase(),
          ownerAuthorities: await ownerAuthorityCount(call.sessionId),
          modelRequests: await call.modelRequests(),
        }).toEqual({ phase: "pre_auth", ownerAuthorities: 0, modelRequests: [] });
      } finally {
        await system.cleanup();
      }
    },
  );

  it.each(["inbound", "outbound"] as const)(
    "keeps an %s spoken candidate out of transcripts, model input and context, events, logs, call rows and Durable Object storage",
    async (direction) => {
      const observedLogs: string[] = [];
      for (const method of ["error", "warn", "log"] as const) {
        vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
          observedLogs.push(values.map((value) => String(value)).join(" "));
        });
      }
      const { system, call } = await openOwnerCall(direction);
      try {
        await call.prompt(SYNTHETIC_CANDIDATE);
        const modelRequests = await call.modelRequests();
        const transcripts = await env.DB.prepare(`SELECT e.envelope_json
          FROM conversation_turns AS t
          JOIN events AS e ON e.event_id = t.user_event_id
          WHERE t.session_id = ?`).bind(call.sessionId).all<{ envelope_json: string }>();
        const events = await env.DB.prepare(
          "SELECT event_type, envelope_json FROM events ORDER BY sequence",
        ).all<{ event_type: string; envelope_json: string }>();
        const callRows = await env.DB.prepare(
          "SELECT * FROM call_sessions WHERE session_id = ?",
        ).bind(call.sessionId).all<Record<string, unknown>>();
        const providerEvents = await env.DB.prepare(
          "SELECT * FROM provider_events WHERE session_id = ? OR call_sid = ?",
        ).bind(call.providerSessionId, call.callSid).all<Record<string, unknown>>();
        const modelPrompts = modelRequests.map((request) => request.userText);
        const modelContext = modelRequests.flatMap((request) => request.context);

        expect({
          transcriptContainsCandidate: contains(transcripts.results, SYNTHETIC_CANDIDATE),
          modelPromptContainsCandidate: contains(modelPrompts, SYNTHETIC_CANDIDATE),
          modelContextContainsCandidate: contains(modelContext, SYNTHETIC_CANDIDATE),
          modelRequestCount: modelRequests.length,
          eventContainsCandidate: contains(events.results, SYNTHETIC_CANDIDATE),
          logContainsCandidate: contains(observedLogs, SYNTHETIC_CANDIDATE),
          callRowContainsCandidate: contains(callRows.results, SYNTHETIC_CANDIDATE),
          providerEventContainsCandidate: contains(providerEvents.results, SYNTHETIC_CANDIDATE),
          durableStorageContainsCandidate: contains(await call.durableStorage(), SYNTHETIC_CANDIDATE),
        }).toEqual({
          transcriptContainsCandidate: false,
          modelPromptContainsCandidate: false,
          modelContextContainsCandidate: false,
          modelRequestCount: 0,
          eventContainsCandidate: false,
          logContainsCandidate: false,
          callRowContainsCandidate: false,
          providerEventContainsCandidate: false,
          durableStorageContainsCandidate: false,
        });
      } finally {
        await system.cleanup();
      }
    },
  );

  it.each(["inbound", "outbound"] as const)(
    "rejects and hangs up an %s owner call after three complete wrong candidates",
    async (direction) => {
      const { system, call } = await openOwnerCall(direction);
      try {
        const observedPhases: Array<string | undefined> = [];
        for (const candidate of [
          "synthetic wrong alpha",
          "synthetic wrong bravo",
          "synthetic wrong charlie",
        ]) {
          await call.prompt(candidate);
          observedPhases.push(await call.phase());
        }

        expect({
          phases: observedPhases,
          closeCodes: call.closeCodes(),
          ownerAuthorities: await ownerAuthorityCount(call.sessionId),
          modelRequestCount: (await call.modelRequests()).length,
        }).toEqual({
          phases: ["pre_auth", "pre_auth", "rejected"],
          closeCodes: [1008],
          ownerAuthorities: 0,
          modelRequestCount: 0,
        });
      } finally {
        await system.cleanup();
      }
    },
  );

  it.each([undefined, "passphrase_always", "unknown_policy"])(
    "keeps the exact Passed-A waiver off when policy is %s",
    async (ownerCallerIdPolicy) => {
      const { system, call } = await openOwnerCall("inbound", {
        ...(ownerCallerIdPolicy === undefined ? {} : { ownerCallerIdPolicy }),
        stirVerstat: PASSED_A,
      });
      try {
        expect({
          phase: await call.phase(),
          ownerAuthorities: await ownerAuthorityCount(call.sessionId),
        }).toEqual({ phase: "pre_auth", ownerAuthorities: 0 });
      } finally {
        await system.cleanup();
      }
    },
  );

  it("allows only the explicitly enabled exact Passed-A waiver to satisfy owner step-up", async () => {
    const { system, call } = await openOwnerCall("inbound", {
      ownerCallerIdPolicy: "waive_on_passed_a",
      stirVerstat: PASSED_A,
    });
    try {
      expect({
        phase: await call.phase(),
        ownerAuthorities: await ownerAuthorityCount(call.sessionId),
      }).toEqual({ phase: "active", ownerAuthorities: 1 });
    } finally {
      await system.cleanup();
    }
  });

  it.each([undefined, "TN-Validation-Passed-B", "TN-Validation-Failed-A", "tn-validation-passed-a"])(
    "does not apply an enabled waiver to nonqualifying attestation %s",
    async (stirVerstat) => {
      const { system, call } = await openOwnerCall("inbound", {
        ownerCallerIdPolicy: "waive_on_passed_a",
        ...(stirVerstat === undefined ? {} : { stirVerstat }),
      });
      try {
        expect({
          phase: await call.phase(),
          ownerAuthorities: await ownerAuthorityCount(call.sessionId),
        }).toEqual({ phase: "pre_auth", ownerAuthorities: 0 });
      } finally {
        await system.cleanup();
      }
    },
  );
});
