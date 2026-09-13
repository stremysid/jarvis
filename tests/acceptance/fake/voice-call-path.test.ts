import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { ArchivalService } from "../../../apps/cloud-gateway/src/archive/archival-service.js";
import { resetArchiveFixture } from "../../../apps/cloud-gateway/test/archive/archive-fixture.js";
import { createFakeCallingSystem, createFakeOutboundCallingSystem } from "./voice-call-system.js";

describe("fake voice call path", () => {
  it.each(["inbound", "outbound"] as const)("requests bounded 5xx retries for %s cleanup and verifies fragment-free signatures", async (direction) => {
    let fail = true;
    const system = await createFakeCallingSystem({ beforeTermination: async () => {
      if (fail) { fail = false; throw new Error("fixture_cleanup_unavailable"); }
    } });
    try {
      let response: Response;
      if (direction === "outbound") {
        await system.dispatch();
        expect((system.twilioRequests()[0] as { statusCallbackUrl: URL }).statusCallbackUrl.href)
          .toBe(`https://jarvis.example/voice/status/${system.attemptId}#rc=2&rp=ct,rt,5xx`);
        response = await system.claimOutboundTwiML(system.acceptedCallSid());
      } else response = await system.inbound();
      expect(await response.text()).toContain('action="https://jarvis.example/voice/relay-ended#rc=2&amp;rp=ct,rt,5xx"');
      const call = await system.openRelay();
      await call.setup();
      const send = direction === "outbound"
        ? () => system.sendStatus(call.callSid, "completed", 1)
        : () => system.sendRelayEnded(call.callSid, "ended");
      expect((await send()).status).toBe(503);
      expect((await send()).status).toBe(204);
      await expect(call.phase()).resolves.toBe("completed");
      expect(system.terminations()).toHaveLength(2);
    } finally { await system.cleanup(); }
  });

  it("admits the owner without a PIN and preserves two turns across an interruption", async () => {
    const system = await createFakeCallingSystem({ manualModel: true });
    try {
      const inbound = await system.inbound();
      expect(inbound.status).toBe(200);
      const twiml = await inbound.text();
      expect(twiml).toContain("<ConversationRelay");
      expect(twiml).not.toContain("principal:owner");
      expect(twiml).not.toContain(system.destination);

      const call = await system.openRelay();
      expect(call.upgradeStatus).toBe(101);
      await call.setup();
      await expect(call.phase()).resolves.toBe("active");
      await expect(system.pinAttempts()).resolves.toBe(0);
      expect(call.frames()).toEqual([]);

      const interrupted = call.prompt("Remember the jasmine tea preference.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
      // The real streaming redactor releases complete lines, not an open tail.
      await call.emitToken("This response must stop when the caller interrupts.\n");
      await vi.waitFor(() => expect(call.frames().some((frame) => frame.last === false)).toBe(true));
      const started = performance.now();
      await call.interrupt();
      await interrupted;
      expect(performance.now() - started).toBeLessThanOrEqual(1_500);
      await expect(call.turns()).resolves.toEqual([
        { state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null },
      ]);
      const countAfterInterrupt = call.frames().length;
      await expect(call.emitToken("Late output must not resume.")).rejects.toThrow("fake_model_manual_stream_inactive");
      expect(call.frames()).toHaveLength(countAfterInterrupt);

      const next = call.prompt("Recall the jasmine tea preference.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(2));
      await call.emitToken("The preference is jasmine tea.");
      await call.completeModel();
      await next;
      expect((await call.modelRequests()).map((request) => request.principalId)).toEqual([
        "principal:owner", "principal:owner",
      ]);
      await expect(call.turns()).resolves.toEqual([
        { state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null },
        { state: "voice_sent", sent_assistant_event_id: expect.any(String), delivered_assistant_event_id: null },
      ]);
      expect(call.frames().at(-1)).toEqual({ type: "text", token: "", last: true });
      await call.close();
      await expect(call.phase()).resolves.toBe("completed");
      await expect(system.pinAttempts()).resolves.toBe(0);
    } finally {
      await system.cleanup();
    }
  });

  it("answers an owner outbound call without a PIN and ends the active session on a signed terminal callback", async () => {
    const system = await createFakeCallingSystem();
    try {
      await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched", attemptId: system.attemptId });
      const callSid = system.acceptedCallSid();
      expect((await system.claimOutboundTwiML(callSid)).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await expect(call.phase()).resolves.toBe("active");
      await expect(system.pinAttempts()).resolves.toBe(0);
      expect(call.frames().map((frame) => frame.token).join("")).toBe("Jarvis called for Sid. No private message was left.");
      await call.prompt("Please give a brief answer.");
      expect((await call.modelRequests()).map((request) => request.principalId)).toEqual(["principal:owner"]);
      await expect(call.turns()).resolves.toEqual([
        { state: "voice_sent", sent_assistant_event_id: expect.any(String), delivered_assistant_event_id: null },
      ]);
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(204);
      await expect(call.phase()).resolves.toBe("completed");
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1000));
      expect(system.twilioRequests()).toHaveLength(1);
    } finally {
      await system.cleanup();
    }
  });

  it("does not redial an unanswered outbound call or issue its late TwiML", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      await system.dispatch();
      expect(system.twilioRequests()).toHaveLength(1);
      const response = await system.claimOutboundTwiML(callSid);
      expect(response.status).toBe(403);
      await expect(env.DB.prepare("SELECT relay_call_sid FROM outbound_call_attempts WHERE attempt_id = ?")
        .bind(system.attemptId).first()).resolves.toEqual({ relay_call_sid: null });
      expect(await response.text()).not.toContain("ConversationRelay");
      expect(system.initializations()).toHaveLength(0);
      await expect(system.pinAttempts()).resolves.toBe(0);
      await expect(system.conversationTurnCount()).resolves.toBe(0);
    } finally {
      await system.cleanup();
    }
  });

  it("records nonterminal callbacks without invalidating an active call", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      await system.claimOutboundTwiML(callSid);
      const call = await system.openRelay();
      await call.setup();
      for (const [sequence, status] of ["initiated", "ringing", "in-progress"].entries()) {
        expect((await system.sendStatus(callSid, status, sequence)).status).toBe(204);
        await expect(call.phase()).resolves.toBe("active");
      }
      expect(system.terminations()).toHaveLength(0);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 3 });
    } finally { await system.cleanup(); }
  });

  it("refuses session creation when a terminal callback wins after relay claim", async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const system = await createFakeCallingSystem({ beforeOutboundSessionCreate: async () => { reached(); await blocked; } });
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      const pending = system.claimOutboundTwiML(callSid);
      await entered;
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      release();
      expect((await pending).status).toBe(403);
      expect(system.initializations()).toHaveLength(0);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM call_sessions").first()).resolves.toEqual({ count: 0 });
    } finally { release(); await system.cleanup(); }
  });

  it("keeps an ended call fenced after its terminal event is sealed and purged from live D1", async () => {
    await resetArchiveFixture();
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const system = await createFakeCallingSystem({ beforeOutboundSessionCreate: async () => { reached(); await blocked; } });
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      const pending = system.claimOutboundTwiML(callSid);
      await entered;
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      await env.DB.batch([
        env.DB.prepare("UPDATE events SET created_at = '2026-09-02T00:00:00.000Z'"),
        env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = '2026-09-02T00:00:00.000Z'"),
      ]);
      const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
      await expect(archive.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 1000))
        .resolves.toMatchObject({ eventCount: 1 });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM events").first()).resolves.toEqual({ count: 0 });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 1 });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM archive_purge_receipts").first()).resolves.toEqual({ count: 1 });
      release();
      expect((await pending).status).toBe(403);
      expect((await system.claimOutboundTwiML(callSid)).status).toBe(403);
      expect(system.initializations()).toHaveLength(0);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM call_sessions").first()).resolves.toEqual({ count: 0 });
    } finally { release(); await system.cleanup(); await resetArchiveFixture(); }
  });

  it("rolls back terminal call state when the callback event cannot commit", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      await system.claimOutboundTwiML(callSid);
      const call = await system.openRelay();
      await call.setup();
      await env.DB.prepare(`CREATE TRIGGER fixture_reject_callback BEFORE INSERT ON events
        WHEN NEW.event_type = 'provider.call_status'
        BEGIN SELECT RAISE(ABORT, 'fixture_callback_storage_failed'); END`).run();
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(503);
      await expect(call.phase()).resolves.toBe("active");
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 0 });
      expect(system.terminations()).toHaveLength(0);
      await env.DB.prepare("DROP TRIGGER fixture_reject_callback").run();
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(204);
      await expect(call.phase()).resolves.toBe("completed");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fixture_reject_callback").run();
      await system.cleanup();
    }
  });

  it("refuses ended outbound TwiML after delayed initialization and resumes the incomplete callback cleanup", async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const system = await createFakeCallingSystem({ beforeSessionInitialize: async () => { reached(); await blocked; } });
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      const pending = system.claimOutboundTwiML(callSid);
      await entered;
      // The real uninitialized DO RPC rejects here and workerd logs
      // call_session_termination_uninitialized. This expected diagnostic is
      // deliberately not suppressed; the 503 and successful replay pin it.
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(503);
      await expect(env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
        .bind(system.attemptId).first()).resolves.toEqual({ phase: "failed" });
      await expect(system.terminationRecord(system.attemptId)).resolves.toBeUndefined();
      release();
      expect((await pending).status).toBe(403);
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      await expect(system.terminationRecord(system.attemptId)).resolves.toEqual({
        sessionId: system.attemptId, callSid, providerSessionId: null,
        phase: "failed", durablePhase: "failed", reason: "provider_callback", cleanupState: "complete",
      });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 1 });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM call_session_authorities").first()).resolves.toEqual({ count: 0 });
      await expect(system.conversationTurnCount()).resolves.toBe(0);
    } finally { release(); await system.cleanup(); }
  });

  it("ends only the exact inbound provider session and refuses a mismatched relay-ended callback", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.inbound();
      const call = await system.openRelay();
      await call.setup();
      expect((await system.sendRelayEnded(call.callSid, "ended", `VX${"7".repeat(32)}`)).status).toBe(503);
      expect(system.terminations()).toHaveLength(0);
      await expect(call.phase()).resolves.toBe("active");
      expect((await system.sendRelayEnded(call.callSid, "ended")).status).toBe(204);
      await expect(call.phase()).resolves.toBe("completed");
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1000));
      expect(system.terminations()).toEqual([{ sessionId: call.sessionId, phase: "completed", reason: "provider_callback" }]);
    } finally { await system.cleanup(); }
  });

  it("retries failed live cleanup after the callback has committed without recording or publishing twice", async () => {
    let failCleanup = true;
    const system = await createFakeCallingSystem({ manualModel: true, beforeTermination: async ({ sessionId }) => {
      await expect(env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?").bind(sessionId).first())
        .resolves.toEqual({ phase: "completed" });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 1 });
      if (failCleanup) { failCleanup = false; throw new Error("fixture_cleanup_unavailable"); }
    } });
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      await system.claimOutboundTwiML(callSid);
      const call = await system.openRelay();
      await call.setup();
      const turn = call.prompt("Please answer briefly.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(503);
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(204);
      await turn;
      await expect(call.turns()).resolves.toEqual([
        { state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null },
      ]);
      await expect(call.emitToken("This must never be sent.")).rejects.toThrow("fake_model_manual_stream_inactive");
      expect(system.terminations()).toHaveLength(2);
      expect((await system.sendStatus(callSid, "completed", 1)).status).toBe(204);
      await expect(env.DB.prepare("SELECT count(*) AS count FROM provider_events").first()).resolves.toEqual({ count: 1 });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM events WHERE event_type = 'provider.call_status'")
        .first()).resolves.toEqual({ count: 1 });
      await expect(env.DB.prepare(`SELECT count(*) AS count FROM outbox o JOIN events e ON e.sequence = o.event_sequence
        WHERE e.event_type = 'provider.call_status'`).first()).resolves.toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  });

  it("preserves the first terminal phase across differently classified provider callbacks", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      await system.claimOutboundTwiML(callSid);
      const call = await system.openRelay();
      await call.setup();
      expect((await system.sendStatus(callSid, "failed", 1)).status).toBe(204);
      expect((await system.sendStatus(callSid, "completed", 2)).status).toBe(204);
      expect((await system.sendRelayEnded(callSid, "ended")).status).toBe(204);
      await expect(call.phase()).resolves.toBe("failed");
      expect(system.terminations().map((input) => input.phase)).toEqual(["failed", "failed", "failed"]);
    } finally { await system.cleanup(); }
  });

  it("cleans an initialized outbound session that ends before relay setup and keeps its provider binding empty", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      const callSid = system.acceptedCallSid();
      await system.claimOutboundTwiML(callSid);
      const call = await system.openRelay();
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      await expect(call.phase()).resolves.toBe("failed");
      await expect(env.DB.prepare("SELECT provider_session_id, provider_connected_at FROM call_sessions WHERE session_id = ?")
        .bind(call.sessionId).first()).resolves.toEqual({ provider_session_id: null, provider_connected_at: null });
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1000));
      expect((await system.sendStatus(callSid, "no-answer", 1)).status).toBe(204);
      expect((await system.claimOutboundTwiML(callSid)).status).toBe(403);
      const initialization = system.initializations()[0];
      if (initialization === undefined) throw new Error("fixture_initialization_missing");
      await expect(new CallRepository(env.DB, new EventRepository(env.DB)).getOrCreateOutboundSession({
        attemptId: system.attemptId, binding: initialization.binding, now: new Date("2026-08-30T12:00:00.000Z"),
      })).rejects.toThrow("call_session_conflict");
      await expect(system.pinAttempts()).resolves.toBe(0);
    } finally { await system.cleanup(); }
  });

  it("refuses unbound live-session cleanup until a callback has terminalized its durable state", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.dispatch();
      await system.claimOutboundTwiML(system.acceptedCallSid());
      const call = await system.openRelay();
      await expect(call.terminate("failed")).rejects.toThrow("call_session_termination_binding_mismatch");
      await expect(call.phase()).resolves.toBe("created");
      expect(call.closeCodes()).toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it("fails one stalled model turn at the real thirty-second limit and permits the caller's next turn", async () => {
    const system = await createFakeCallingSystem({ manualModel: true });
    try {
      await system.inbound();
      const call = await system.openRelay();
      await call.setup();
      const started = performance.now();
      const stalled = call.prompt("Please answer within the call's model budget.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
      expect((await call.modelRequests())[0]?.timeoutMs).toBe(30_000);
      // Clear the first-token deadline, then keep the same stream open until
      // the independent total deadline fires. No shortened fixture budget.
      await call.emitToken("The response has started.\n");
      await vi.waitFor(async () => expect((await call.turns())[0]?.state).toBe("failed"), { timeout: 35_000, interval: 100 });
      await stalled;
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(29_000);
      expect(elapsed).toBeLessThan(35_000);
      await expect(env.DB.prepare(`SELECT state, failure_code, failure_category,
        sent_assistant_event_id, delivered_assistant_event_id FROM conversation_turns WHERE session_id = ?`)
        .bind(call.sessionId).all()).resolves.toMatchObject({ results: [{
          state: "failed", failure_code: "model_failed", failure_category: "provider",
          sent_assistant_event_id: null, delivered_assistant_event_id: null,
        }] });
      await expect(call.emitToken("This late tail must not be sent.")).rejects.toThrow("fake_model_manual_stream_inactive");
      await expect(call.phase()).resolves.toBe("active");
      const next = call.prompt("Please try a short answer now.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(2));
      await call.emitToken("A short answer.");
      await call.completeModel();
      await next;
      expect((await call.turns()).map((turn) => turn.state)).toEqual(["failed", "voice_sent"]);
    } finally { await system.cleanup(); }
  }, 40_000);

  it("accepts exactly 64 KiB of valid JSON and closes the next byte with 1009 before a turn", async () => {
    const system = await createFakeCallingSystem();
    try {
      await system.inbound();
      const call = await system.openRelay();
      await call.setup();
      const json = JSON.stringify({ type: "prompt", voicePrompt: "A partial café prompt", lang: "en-US", last: false });
      const boundary = json + " ".repeat(65_536 - new TextEncoder().encode(json).byteLength);
      expect(new TextEncoder().encode(boundary).byteLength).toBe(65_536);
      await call.sendFrame(boundary);
      // A real subsequent turn proves the exact-limit frame left the socket
      // and core usable, rather than merely observing a delayed close event.
      await call.prompt("A short permitted answer.");
      await vi.waitFor(() => expect(call.frames().some((frame) => frame.last)).toBe(true));
      expect(call.closeCodes()).toEqual([]);
      await expect(call.modelRequests()).resolves.toHaveLength(1);
      await call.sendFrame(boundary + " ");
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1009));
      await expect(call.modelRequests()).resolves.toHaveLength(1);
      await expect(call.turns()).resolves.toHaveLength(1);
      await expect(system.pinAttempts()).resolves.toBe(0);
    } finally {
      await system.cleanup();
    }
  });

  it("reconciles an accepted-but-lost dispatch and claims signed outbound TwiML without Task 6 activation", async () => {
    const system = await createFakeOutboundCallingSystem({ loseDispatchResponse: true });
    try {
      const dispatch = await system.dispatch();
      expect(dispatch).toEqual({ status: "provider_dispatch_unknown", attemptId: system.attemptId });
      expect(system.twilioRequests()).toHaveLength(1);

      const callSid = system.acceptedCallSid();
      const status = await system.sendStatus(callSid, "ringing", 0);
      expect(status.status).toBe(204);
      await expect(system.dispatchIntent()).resolves.toMatchObject({
        kind: "existing",
        state: "dispatched",
        callSid,
      });

      const twiml = await system.claimOutboundTwiML(callSid);
      expect(twiml.status).toBe(200);
      expect(twiml.headers.get("cache-control")).toBe("no-store");
      const body = await twiml.text();
      expect(body).toContain(`url="wss://jarvis.example/voice/relay/${system.attemptId}"`);
      expect(body).toContain("action=\"https://jarvis.example/voice/relay-ended#rc=2&amp;rp=ct,rt,5xx\"");
      expect(body).not.toContain("user_requested");
      expect(body).not.toContain("principal:owner");
      expect(body).not.toContain(system.destination);
      expect(system.initializations()).toHaveLength(1);
      expect(system.initializations()[0]).toMatchObject({
        sessionId: system.attemptId,
        relaySetupExpiresAt: null,
        preAuthentication: { voicemailMessage: "Jarvis called for Sid. No private message was left." },
      });
    } finally {
      await system.cleanup();
    }
  });
});
