import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CallRepository } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import {
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_REJECTED,
  OWNER_STEP_UP_VERIFIED,
  OwnerCallStepUpService,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";
import { createFakeCallingSystem as createBaseFakeCallingSystem } from "./voice-call-system.js";

const FUTURE_TEST_NOW = new Date("2099-01-01T00:00:00.000Z");

function createFakeCallingSystem(
  input: NonNullable<Parameters<typeof createBaseFakeCallingSystem>[0]> = {},
): ReturnType<typeof createBaseFakeCallingSystem> {
  return createBaseFakeCallingSystem({ now: FUTURE_TEST_NOW, ...input });
}

async function authorityCount(sessionId: string): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
  ).bind(sessionId).first<{ count: number }>())?.count ?? 0;
}

async function disableOwnerStepUp(now = FUTURE_TEST_NOW): Promise<void> {
  const at = now.toISOString();
  const eventId = "01m2eeeeeeeeeeeeeeeeeee901";
  const subjectId = "telegram:user:12345";
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    correlationId: eventId,
    causationId: null,
    eventType: "telegram.update.received",
    source: "channel:telegram",
    producerVersion: "cloud-gateway@0.1.0",
    subjectId,
    occurredAt: at,
    receivedAt: at,
    contentHash: "5".repeat(64),
    payload: {
      updateId: 901,
      principalBinding: [1],
      chatId: "12345",
      messageId: 901,
      text: "/disable-owner-step-up --confirm",
    },
  };
  await env.DB.prepare(`INSERT INTO channel_identities (
    identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
  ) VALUES ('identity:telegram-owner', 'principal:owner', 'telegram', '12345', 'active', ?, ?)`)
    .bind(at, at).run();
  const event = await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'telegram.update.received', 'channel:telegram', ?, ?, ?, ?, ?, ?) RETURNING sequence`)
    .bind(eventId, subjectId, at, at, "5".repeat(64), JSON.stringify(envelope), at)
    .first<{ sequence: number }>();
  if (event === null) throw new Error("disable_event_insert_failed");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) VALUES ('telegram.update', ?, ?, ?, ?)",
    ).bind(eventId, "6".repeat(64), event.sequence, at),
    env.DB.prepare(`INSERT INTO owner_passphrase_disable_commits (
      commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
      authorization_event_id, committed_at
    ) VALUES ('01m2eeeeeeeeeeeeeeeeeee902', 'principal:owner', 'identity:voice', 1, ?, ?)`)
      .bind(eventId, at),
  ]);
}

describe("owner call passphrase step-up", () => {
  it("rejects with the fixed refusal when step-up is disabled before the relay begins", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      await disableOwnerStepUp();
      const call = await system.openRelay();
      await call.setup();

      expect(await call.phase()).toBe("rejected");
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.closeCodes()).not.toContain(1011);
      expect(call.stepUpAlerts()).toHaveLength(1);
      await expect(env.DB.prepare(
        "SELECT session_id FROM owner_call_step_up_disabled_rejections WHERE session_id = ?",
      ).bind(call.sessionId).first()).resolves.not.toBeNull();
      await expect(env.DB.prepare(
        "SELECT session_id FROM owner_call_step_up_rejection_deliveries WHERE session_id = ?",
      ).bind(call.sessionId).first()).resolves.not.toBeNull();
    } finally { await system.cleanup(); }
  });

  it("rejects an open step-up window when the passphrase is disabled mid-call", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await disableOwnerStepUp();

      await call.prompt(FAKE_OWNER_PASSPHRASE);

      expect(await call.phase()).toBe("rejected");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.closeCodes()).not.toContain(1011);
      expect(call.stepUpAlerts()).toHaveLength(1);
    } finally { await system.cleanup(); }
  });

  it.each(["inbound", "outbound"] as const)("commits the exact success receipt before admitting an %s owner", async (direction) => {
    const system = await createFakeCallingSystem();
    try {
      if (direction === "inbound") expect((await system.inbound()).status).toBe(200);
      else {
        const dispatched = await system.dispatch();
        expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
        expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      }
      const call = await system.openRelay();
      await call.setup();
      expect(await call.phase()).toBe("pre_auth");
      expect(await authorityCount(call.sessionId)).toBe(0);
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      expect(await authorityCount(call.sessionId)).toBe(1);
      expect(await env.DB.prepare(
        "SELECT verified_at FROM owner_call_step_up_successes WHERE session_id = ?",
      ).bind(call.sessionId).first()).not.toBeNull();
      expect(call.frames().some((frame) => frame.token === OWNER_STEP_UP_VERIFIED)).toBe(true);
      expect(call.authorityCountsAtVerified()).toEqual([1]);
      expect(await call.modelRequests()).toEqual([]);
    } finally { await system.cleanup(); }
  }, 20_000);

  it("writes every mismatch ordinal durably before rejecting the third candidate and ends with handoff data", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await call.prompt(candidate);
      expect(await call.phase()).toBe("rejected");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(3);
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(call.frames().some((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toBe(true);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toEqual([{
        ownerPrincipalId: "principal:owner",
        alertClass: "rejected",
        direction: "inbound",
        attestationClass: "absent",
      }]);
      expect(JSON.stringify(call.stepUpAlerts())).not.toMatch(/ablaze|abrasion|active|activist|activity/iu);
      const callback = await system.sendRelayEnded(call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("<Hangup/>");
    } finally { await system.cleanup(); }
  }, 20_000);

  it("preserves mismatch ordinals across a Durable Object hibernation boundary", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze abrasion active");
      await call.prompt("ablaze abrasion activist");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(2);

      await call.hibernate();
      await call.prompt("ablaze abrasion activity");

      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(3);
      expect(await call.phase()).toBe("rejected");
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toEqual([{
        ownerPrincipalId: "principal:owner",
        alertClass: "rejected",
        direction: "inbound",
        attestationClass: "absent",
      }]);
      const callback = await system.sendRelayEnded(
        call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA,
      );
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("<Hangup/>");
    } finally { await system.cleanup(); }
  }, 20_000);

  it("does not repeat a delivered refusal or alert after eviction", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await call.prompt(candidate);
      expect(await call.phase()).toBe("rejected");
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.stepUpAlerts()).toHaveLength(1);

      await call.hibernate();
      await call.prompt("hello after rejection");

      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames().filter((frame) => frame.type === "end")).toHaveLength(1);
      expect(call.stepUpAlerts()).toHaveLength(1);
      expect(await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_rejection_deliveries WHERE session_id = ?",
      ).bind(call.sessionId).first()).toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  }, 20_000);

  it("does not carry a rejected call's three attempts into a later owner call", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const attacked = await system.openRelay();
      await attacked.setup();
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await attacked.prompt(candidate);
      expect(await attacked.phase()).toBe("rejected");

      expect((await system.inbound()).status).toBe(200);
      const later = await system.openRelay();
      await later.setup();
      await later.prompt(FAKE_OWNER_PASSPHRASE);

      expect(await later.phase()).toBe("active");
      expect(await authorityCount(later.sessionId)).toBe(1);
      expect(await system.ownerStepUpAttempts(later.sessionId)).toBe(1);
    } finally { await system.cleanup(); }
  }, 30_000);

  it("reserves one outbound-owner slot when two inbound owner relays are waiting in pre-auth", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const first = await system.openRelay();
      await first.setup();
      expect((await system.inbound()).status).toBe(200);
      const second = await system.openRelay();
      await second.setup();
      expect(await first.phase()).toBe("pre_auth");
      expect(await second.phase()).toBe("pre_auth");

      const dispatched = await system.dispatch();
      expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
      expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM call_sessions
        WHERE phase NOT IN ('completed', 'rejected', 'failed', 'expired')`).first())
        .toEqual({ count: 3 });
    } finally { await system.cleanup(); }
  });

  it("expires through the persisted 60-second alarm after hibernation", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      system.advanceTime(60_001);
      await call.fireAlarm();

      expect(await call.phase()).toBe("rejected");
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
    } finally { await system.cleanup(); }
  });

  it("restores the persisted deadline before accepting a post-hibernation fragment", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      system.advanceTime(60_001);

      await call.prompt("ablaze");

      expect(await call.phase()).toBe("rejected");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
      ).bind(call.sessionId).first<{ count: number }>())?.count).toBe(0);
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
    } finally { await system.cleanup(); }
  }, 20_000);

  it.each([false, true])(
    "keeps the original deadline after an assembly alarm and rejects silence (hibernate=%s)",
    async (hibernate) => {
      const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
      try {
        expect((await system.inbound()).status).toBe(200);
        const call = await system.openRelay();
        await call.setup();
        await call.prompt("ablaze");
        if (hibernate) await call.hibernate();

        system.advanceTime(1_501);
        await call.fireAlarm();
        expect(await call.phase()).toBe("pre_auth");
        expect((await env.DB.prepare(
          "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
        ).bind(call.sessionId).first<{ count: number }>())?.count).toBe(1);
        expect(await call.durableStorage()).toMatchObject({
          "call-session.owner-step-up-alarm.v1": expect.objectContaining({ kind: "window" }),
        });

        system.advanceTime(58_500);
        await call.fireAlarm();
        expect(await call.phase()).toBe("rejected");
        expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
        expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
        expect(call.stepUpAlerts()).toHaveLength(1);
        const callback = await system.sendRelayEnded(
          call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA,
        );
        expect(callback.status).toBe(200);
        expect(await callback.text()).toContain("<Hangup/>");
      } finally { await system.cleanup(); }
    },
    30_000,
  );

  it("retains the durable deadline alarm when the first handler attempt throws", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    let renamed = false;
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await env.DB.prepare(`ALTER TABLE owner_call_step_up_rejections
        RENAME TO owner_call_step_up_rejections_unavailable`).run();
      renamed = true;

      await expect(call.fireAlarm()).rejects.toThrow("owner_call_step_up_rejections");
      expect(await call.durableStorage()).toHaveProperty("call-session.owner-step-up-alarm.v1");

      await env.DB.prepare(`ALTER TABLE owner_call_step_up_rejections_unavailable
        RENAME TO owner_call_step_up_rejections`).run();
      renamed = false;
      await call.fireAlarm();

      expect(await call.phase()).toBe("rejected");
      expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
    } finally {
      if (renamed) await env.DB.prepare(`ALTER TABLE owner_call_step_up_rejections_unavailable
        RENAME TO owner_call_step_up_rejections`).run();
      await system.cleanup();
    }
  }, 15_000);

  it("retains the deadline when an evicted alarm cannot reconstruct its core", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    let renamed = false;
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      system.advanceTime(60_001);
      await env.DB.prepare("ALTER TABLE call_sessions RENAME TO call_sessions_unavailable").run();
      renamed = true;

      await expect(call.fireAlarm()).rejects.toThrow("owner_step_up_alarm_runtime_unavailable");
      expect(await call.durableStorage()).toHaveProperty("call-session.owner-step-up-alarm.v1");

      await env.DB.prepare("ALTER TABLE call_sessions_unavailable RENAME TO call_sessions").run();
      renamed = false;
      await call.fireAlarm();
      expect(await call.phase()).toBe("rejected");
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toHaveLength(1);
    } finally {
      if (renamed) await env.DB.prepare("ALTER TABLE call_sessions_unavailable RENAME TO call_sessions").run();
      await system.cleanup();
    }
  }, 30_000);

  it.each([false, true])("finishes a committed deadline rejection after a failed alarm (hibernate=%s)", async (hibernate) => {
    const system = await createFakeCallingSystem();
    const expire = OwnerCallStepUpService.prototype.expire;
    const fault = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementationOnce(async function (this: OwnerCallStepUpService, sessionId, now) {
      await expire.call(this, sessionId, now);
      throw new Error("fixture_after_expire_commit");
    });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await expect(call.fireAlarm()).rejects.toThrow("fixture_after_expire_commit");
      expect(await call.phase()).toBe("rejected");
      expect(await call.durableStorage()).toHaveProperty("call-session.owner-step-up-alarm.v1");
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(0);
      if (hibernate) await call.hibernate();
      await call.fireAlarm({ retryCount: 1, isRetry: true, scheduledTime: FUTURE_TEST_NOW.valueOf() + 60_000 });
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toHaveLength(1);
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
      await call.fireAlarm();
      expect(call.stepUpAlerts()).toHaveLength(1);
      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect((await env.DB.prepare("SELECT count(*) AS count FROM owner_call_step_up_rejections WHERE session_id = ?")
        .bind(call.sessionId).first<{ count: number }>())?.count).toBe(1);
      const callback = await system.sendRelayEnded(call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("<Hangup/>");
    } finally { fault.mockRestore(); await system.cleanup(); }
  }, 30_000);

  it("alerts the owner when a closed socket resumes a committed rejection after eviction", async () => {
    const system = await createFakeCallingSystem();
    const expire = OwnerCallStepUpService.prototype.expire;
    const fault = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementationOnce(
      async function (this: OwnerCallStepUpService, sessionId, now) {
        await expire.call(this, sessionId, now);
        throw new Error("fixture_after_expire_commit");
      },
    );
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await expect(call.fireAlarm()).rejects.toThrow("fixture_after_expire_commit");
      await call.hibernate();

      await call.close();

      expect(call.stepUpAlerts()).toHaveLength(1);
      expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
      expect(await authorityCount(call.sessionId)).toBe(0);
    } finally { fault.mockRestore(); await system.cleanup(); }
  }, 30_000);

  it("finishes and alerts when a live frame resumes a committed rejection after eviction", async () => {
    const system = await createFakeCallingSystem();
    const expire = OwnerCallStepUpService.prototype.expire;
    const fault = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementationOnce(
      async function (this: OwnerCallStepUpService, sessionId, now) {
        await expire.call(this, sessionId, now);
        throw new Error("fixture_after_expire_commit");
      },
    );
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await expect(call.fireAlarm()).rejects.toThrow("fixture_after_expire_commit");
      await call.hibernate();

      await call.prompt("hello there");

      expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(1);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toHaveLength(1);
      expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
      expect(await authorityCount(call.sessionId)).toBe(0);
    } finally { fault.mockRestore(); await system.cleanup(); }
  }, 30_000);

  it("closes a live socket when an evicted alarm can no longer match its durable session", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      const missing = vi.spyOn(CallRepository.prototype, "getCallSession").mockResolvedValueOnce(null);
      try {
        await call.fireAlarm();
        await vi.waitFor(() => expect(call.closeCodes()).toContain(1008));
        expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
        expect(await authorityCount(call.sessionId)).toBe(0);
      } finally { missing.mockRestore(); }
    } finally { await system.cleanup(); }
  }, 20_000);

  it("closes the relay before repeated alarm failures exhaust the runtime retry budget", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      const fault = vi.spyOn(OwnerCallStepUpService.prototype, "state").mockRejectedValue(new Error("fixture_storage_outage"));
      try {
        await expect(call.fireAlarm({ retryCount: 4, isRetry: true, scheduledTime: FUTURE_TEST_NOW.valueOf() + 60_000 }))
          .rejects.toThrow("fixture_storage_outage");
        expect(call.closeCodes()).toEqual([]);
        expect(await call.durableStorage()).toHaveProperty("call-session.owner-step-up-alarm.v1");
        await expect(call.fireAlarm({ retryCount: 5, isRetry: true, scheduledTime: FUTURE_TEST_NOW.valueOf() + 60_000 }))
          .resolves.toBeUndefined();
        await vi.waitFor(() => expect(call.closeCodes()).toContain(1011));
        expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
        expect(await authorityCount(call.sessionId)).toBe(0);
      } finally { fault.mockRestore(); }
    } finally { await system.cleanup(); }
  }, 30_000);

  it.each([false, true])("clears a pre-auth hang-up's alarm without waiting for a retry (hibernate=%s)", async (hibernate) => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      if (hibernate) await call.hibernate();
      await call.close();
      expect(await call.phase()).toBe("failed");
      expect(await call.durableStorage()).not.toHaveProperty("call-session.owner-step-up-alarm.v1");
      await expect(call.fireAlarm()).resolves.toBeUndefined();
    } finally { await system.cleanup(); }
  }, 20_000);

  it("re-arms the deadline after a late fragment so the old assembly alarm cannot spend another re-prompt", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze");
      system.advanceTime(1_501);
      await call.prompt("abrasion");
      expect(await call.durableStorage()).toMatchObject({
        "call-session.owner-step-up-alarm.v1": expect.objectContaining({ kind: "window" }),
      });
      await call.fireAlarm();
      expect((await env.DB.prepare("SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?")
        .bind(call.sessionId).first<{ count: number }>())?.count).toBe(1);
      expect(await call.phase()).toBe("pre_auth");
    } finally { await system.cleanup(); }
  }, 20_000);

  it("caps non-candidate assembly re-prompts durably without spending mismatch attempts", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        await call.prompt("ablaze");
        await call.hibernate();
        system.advanceTime(1_501);
        await call.fireAlarm();
      }

      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(await call.phase()).toBe("rejected");
      expect((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
      ).bind(call.sessionId).first<{ count: number }>())?.count).toBe(3);
    } finally { await system.cleanup(); }
  });

  it.each([
    "ablaze abrasion",
    "please ablaze abrasion abrasive",
    "ablaze abrasion 123",
    "ablaze abrasion abrasive active",
  ])("treats %j as a non-candidate without spending a mismatch attempt", async (candidate) => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(candidate);
      if (candidate === "ablaze abrasion") {
        system.advanceTime(1_501);
        await call.fireAlarm();
      }

      expect(await call.phase()).toBe("pre_auth");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM owner_call_step_up_reprompts
        WHERE session_id = ?`).bind(call.sessionId).first()).toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  });

  it("commits the durable attempt ordinal before starting the 600,000-round verifier", async () => {
    const system = await createFakeCallingSystem();
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const reservationsAtKdf: number[] = [];
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (algorithm, baseKey, length) => {
      reservationsAtKdf.push((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_attempts",
      ).first<{ count: number }>())?.count ?? -1);
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      const call = await (async () => {
        expect((await system.inbound()).status).toBe(200);
        const opened = await system.openRelay();
        await opened.setup();
        return opened;
      })();
      await call.prompt("ablaze abrasion active");
      expect(reservationsAtKdf).toEqual([1]);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "PBKDF2", iterations: 600_000 });
    } finally {
      spy.mockRestore();
      await system.cleanup();
    }
  }, 30_000);

  it("measures both 600,000-round admission and repeat-suppression KDF paths", async () => {
    const system = await createFakeCallingSystem();
    const iterations: number[] = [];
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation((algorithm, baseKey, length) => {
      if (typeof algorithm === "object" && "iterations" in algorithm
        && typeof algorithm.iterations === "number") iterations.push(algorithm.iterations);
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      const admissionStart = performance.now();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      const admissionMs = performance.now() - admissionStart;
      system.advanceTime(2_001);
      const repeatStart = performance.now();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      const repeatMs = performance.now() - repeatStart;

      expect(iterations).toEqual([600_000, 600_000]);
      expect(admissionMs).toBeGreaterThan(0);
      expect(repeatMs).toBeGreaterThan(0);
      console.info("owner_step_up_kdf_latency_evidence", JSON.stringify({
        admissionMs: Math.round(admissionMs), repeatMs: Math.round(repeatMs), iterations,
      }));
    } finally {
      spy.mockRestore();
      await system.cleanup();
    }
  });
});
