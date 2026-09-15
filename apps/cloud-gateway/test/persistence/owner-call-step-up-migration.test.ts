import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "../../../../tests/acceptance/fake/voice-call-system.js";
import {
  FAKE_OWNER_PASSPHRASE_PEPPER,
  seedFakeGuest,
} from "../../../../tests/acceptance/fake/voice-access-system.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import { OwnerCallStepUpService } from "../../src/voice/owner-call-step-up.js";
import { applyOwnerCallStepUpMigration } from "./migration.js";

const NOW = "2026-08-30T12:00:00.000Z";
const WRONG = "ablaze abrasion active";
const CORRECT = "ablaze abrasion abrasive";

async function openPreAuth() {
  const system = await createFakeCallingSystem();
  expect((await system.inbound()).status).toBe(200);
  const call = await system.openRelay();
  await call.setup();
  expect(await call.phase()).toBe("pre_auth");
  return { system, call };
}

async function expectUpdateAndDeleteRejected(
  table: string,
  update: string,
  updateError: string,
  deleteError: string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/u.test(table)) throw new Error("unsafe_test_table");
  await expect(env.DB.prepare(update).run()).rejects.toThrow(updateError);
  await expect(env.DB.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(deleteError);
}

describe("owner call step-up migration", () => {
  it("installs durable step-up tables and only remote-safe authority trigger syntax", async () => {
    await applyOwnerCallStepUpMigration();
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'owner_call_step_up_bindings', 'owner_call_step_up_windows',
        'owner_call_step_up_attempts', 'owner_call_step_up_reprompts',
        'owner_call_step_up_successes', 'owner_call_step_up_rejections',
        'owner_call_step_up_repeat_checks', 'guest_call_pin_attempts',
        'owner_call_step_up_alerts'
      ) ORDER BY name`).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "guest_call_pin_attempts",
      "owner_call_step_up_alerts",
      "owner_call_step_up_attempts",
      "owner_call_step_up_bindings",
      "owner_call_step_up_rejections",
      "owner_call_step_up_repeat_checks",
      "owner_call_step_up_reprompts",
      "owner_call_step_up_successes",
      "owner_call_step_up_windows",
    ]);
    for (const { name } of tables.results) {
      const schema = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .bind(name).first<{ sql: string }>();
      expect(schema?.sql, name).toContain("WITHOUT ROWID");
    }
    const authority = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'call_session_authorities_require_current_lineage'`)
      .first<{ sql: string }>();
    expect(authority?.sql).toContain("owner_call_step_up_successes");
    expect(authority?.sql).toContain("binding.requirement = 'waived_passed_a'");
    expect(authority?.sql).not.toMatch(/CASE[\s\S]*RAISE/iu);
  });

  it("pins the immutable owner binding to the exact stored owner-session snapshot", async () => {
    const system = await createFakeCallingSystem();
    try {
      const repository = new CallRepository(env.DB, new EventRepository(env.DB));
      const session = await repository.getOrCreateInboundSession({
        callSid: `CA${"9".repeat(32)}`,
        callerE164: "+14165550123",
        ownerIdentityId: "identity:voice",
        currentChallengeHmacKeyVersion: "hmac-v1",
        now: new Date(NOW),
      });
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
        session_id, call_sid, owner_principal_id, owner_identity_id, direction,
        lifecycle_generation, requirement, attestation_class, policy, created_at
      ) VALUES (?, ?, ?, ?, 'inbound', 1, 'waived_passed_a', 'absent', 'waive_on_passed_a', ?)`)
        .bind(session.sessionId, session.callSid, session.binding.principalId,
          session.binding.identityId, session.createdAt).run())
        .rejects.toThrow("owner_call_step_up_binding_invalid");

      await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
        session_id, call_sid, owner_principal_id, owner_identity_id, direction,
        lifecycle_generation, requirement, attestation_class, policy, created_at
      ) VALUES (?, ?, ?, ?, 'inbound', 1, 'required', 'absent', 'passphrase_always', ?)`)
        .bind(session.sessionId, session.callSid, session.binding.principalId,
          session.binding.identityId, session.createdAt).run();
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_bindings",
        "UPDATE owner_call_step_up_bindings SET policy = 'invalid'",
        "owner_call_step_up_binding_immutable",
        "owner_call_step_up_binding_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("keeps bind, begin, and expiry retries idempotent with guarded inserts", async () => {
    const { system, call } = await openPreAuth();
    try {
      const service = new OwnerCallStepUpService(
        env.DB, new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1"),
      );
      const binding = await service.binding(call.sessionId);
      if (binding === null) throw new Error("owner_step_up_binding_missing");
      await expect(service.bind(binding)).resolves.toEqual(binding);
      await expect(service.bind({ ...binding, policy: "invalid" }))
        .rejects.toThrow("owner_step_up_binding_conflict");

      const first = await service.begin(call.sessionId, new Date("2026-08-30T12:00:30.000Z"));
      const second = await service.begin(call.sessionId, new Date("2026-08-30T12:00:45.000Z"));
      expect(second).toEqual(first);

      const expiredAt = new Date("2026-08-30T12:01:00.001Z");
      await service.expire(call.sessionId, expiredAt);
      await service.expire(call.sessionId, expiredAt);
      await expect(env.DB.prepare(`SELECT count(*) AS count FROM owner_call_step_up_rejections
        WHERE session_id = ?`).bind(call.sessionId).first()).resolves.toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  }, 15_000);

  it("pins the 60-second window guard and window immutability", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const session = (await env.DB.prepare("SELECT session_id FROM call_sessions").first<{ session_id: string }>())!;
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_windows (
        session_id, lifecycle_generation, verifier_version, prompted_at, deadline_at
      ) VALUES (?, 1, 1, ?, ?)`).bind(session.session_id, NOW, "2026-08-30T12:01:01.000Z").run())
        .rejects.toThrow("owner_call_step_up_window_invalid");

      const call = await system.openRelay();
      await call.setup();
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_windows",
        "UPDATE owner_call_step_up_windows SET deadline_at = '2026-08-30T12:01:01.000Z'",
        "owner_call_step_up_window_immutable",
        "owner_call_step_up_window_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins attempt reservation, one-way resolution, and deletion guards", async () => {
    const { system, call } = await openPreAuth();
    try {
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_attempts (
        session_id, lifecycle_generation, attempt_ordinal, verifier_version, attempted_at, outcome, resolved_at
      ) VALUES (?, 1, 1, 1, ?, 'mismatched', ?)`).bind(call.sessionId, NOW, NOW).run())
        .rejects.toThrow("owner_call_step_up_attempt_invalid");
      await call.prompt(WRONG);
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_attempts",
        "UPDATE owner_call_step_up_attempts SET attempted_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_attempt_transition_invalid",
        "owner_call_step_up_attempt_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins success provenance plus immutable success receipts", async () => {
    const { system, call } = await openPreAuth();
    try {
      await call.prompt(WRONG);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_successes (
        session_id, lifecycle_generation, call_sid, direction, owner_principal_id,
        owner_identity_id, verifier_version, attempt_ordinal, verified_at
      ) SELECT binding.session_id, 1, binding.call_sid, binding.direction, binding.owner_principal_id,
        binding.owner_identity_id, 1, 1, ? FROM owner_call_step_up_bindings binding
        WHERE binding.session_id = ?`).bind(NOW, call.sessionId).run())
        .rejects.toThrow("owner_call_step_up_success_invalid");
    } finally { await system.cleanup(); }

    const verified = await openPreAuth();
    try {
      await verified.call.prompt(CORRECT);
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_successes",
        "UPDATE owner_call_step_up_successes SET verified_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_success_immutable",
        "owner_call_step_up_success_delete_forbidden",
      );
    } finally { await verified.system.cleanup(); }
  }, 30_000);

  it("pins reprompt order, exhaustion, immutability, and deletion", async () => {
    const { system, call } = await openPreAuth();
    try {
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_reprompts (
        session_id, lifecycle_generation, reprompt_ordinal, prompted_at
      ) VALUES (?, 1, 2, ?)`).bind(call.sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_reprompt_invalid");
      await call.prompt("ablaze abrasion abrasive absolute");
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_reprompts",
        "UPDATE owner_call_step_up_reprompts SET prompted_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_reprompt_immutable",
        "owner_call_step_up_reprompt_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins rejection provenance, terminalization, immutability, and deletion", async () => {
    const { system, call } = await openPreAuth();
    try {
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_rejections (
        session_id, lifecycle_generation, reason, rejected_at
      ) VALUES (?, 1, 'attempts_exhausted', ?)`).bind(call.sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_rejection_invalid");
      for (let attempt = 0; attempt < 3; attempt += 1) await call.prompt(WRONG);
      await expect(call.phase()).resolves.toBe("rejected");
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_rejections",
        "UPDATE owner_call_step_up_rejections SET rejected_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_rejection_immutable",
        "owner_call_step_up_rejection_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins repeat-check timing, one-way resolution, and deletion", async () => {
    const { system, call } = await openPreAuth();
    try {
      await call.prompt(CORRECT);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(call.sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_repeat_invalid");
      const reservedAt = "2026-08-30T12:00:03.000Z";
      await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(call.sessionId, reservedAt).run();
      await env.DB.prepare(`UPDATE owner_call_step_up_repeat_checks
        SET outcome = 'mismatched', resolved_at = ? WHERE session_id = ?`)
        .bind(reservedAt, call.sessionId).run();
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_repeat_checks",
        "UPDATE owner_call_step_up_repeat_checks SET outcome = 'matched'",
        "owner_call_step_up_repeat_transition_invalid",
        "owner_call_step_up_repeat_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins durable guest PIN attempt order, immutability, and deletion", async () => {
    const system = await createFakeCallingSystem();
    try {
      const guest = await seedFakeGuest("a");
      expect((await system.inbound(guest.caller)).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await expect(env.DB.prepare(`INSERT INTO guest_call_pin_attempts (
        session_id, attempt_ordinal, attempted_at
      ) VALUES (?, 2, ?)`).bind(call.sessionId, NOW).run())
        .rejects.toThrow("guest_call_pin_attempt_invalid");
      await call.pin(new TextEncoder().encode("2468"));
      await expectUpdateAndDeleteRejected(
        "guest_call_pin_attempts",
        "UPDATE guest_call_pin_attempts SET attempted_at = '2026-08-30T12:00:00.001Z'",
        "guest_call_pin_attempt_immutable",
        "guest_call_pin_attempt_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("rejects INSERT OR REPLACE across every 0018 table and pins mutable alert keys", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const successful = await system.openRelay();
      await successful.setup();
      await successful.prompt(CORRECT);
      system.advanceTime(2_001);
      const repeatReservedAt = "2026-08-30T12:00:02.001Z";
      await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(successful.sessionId, repeatReservedAt).run();

      expect((await system.inbound()).status).toBe(200);
      const rejected = await system.openRelay();
      await rejected.setup();
      await rejected.prompt("ablaze abrasion abrasive active");
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await rejected.prompt(candidate);

      expect((await system.inbound()).status).toBe(200);
      const preAuth = await system.openRelay();
      await preAuth.setup();
      expect(await preAuth.phase()).toBe("pre_auth");
      for (const [statement, error] of [
        [`INSERT OR REPLACE INTO owner_call_step_up_bindings
          SELECT * FROM owner_call_step_up_bindings WHERE session_id = ?`, "owner_call_step_up_binding_invalid"],
        [`INSERT OR REPLACE INTO owner_call_step_up_windows
          SELECT * FROM owner_call_step_up_windows WHERE session_id = ?`, "owner_call_step_up_window_invalid"],
      ] as const) {
        await expect(env.DB.prepare(statement).bind(preAuth.sessionId).run()).rejects.toThrow(error);
      }
      await expect(env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_repeat_checks
        SELECT * FROM owner_call_step_up_repeat_checks WHERE session_id = ?`).bind(successful.sessionId).run())
        .rejects.toThrow("owner_call_step_up_repeat_invalid");
      await preAuth.terminate("failed");

      const guest = await seedFakeGuest("a");
      expect((await system.inbound(guest.caller)).status).toBe(200);
      const guestCall = await system.openRelay();
      await guestCall.setup();
      await guestCall.pin(new TextEncoder().encode("1357"));

      await env.DB.prepare(`INSERT INTO owner_call_step_up_alerts (
        owner_principal_id, alert_class, direction, attestation_class,
        first_observed_at, last_observed_at, observation_count, last_sent_at, claim_id, claim_expires_at
      ) VALUES ('principal:owner', 'rejected', 'inbound', 'absent', ?, ?, 1, NULL, NULL, NULL)`)
        .bind(NOW, NOW).run();

      for (const [table, error] of [
        ["owner_call_step_up_attempts", "owner_call_step_up_attempt_invalid"],
        ["owner_call_step_up_reprompts", "owner_call_step_up_reprompt_invalid"],
        ["owner_call_step_up_successes", "owner_call_step_up_success_invalid"],
        ["owner_call_step_up_rejections", "owner_call_step_up_rejection_invalid"],
        ["guest_call_pin_attempts", "guest_call_pin_attempt_invalid"],
        ["owner_call_step_up_alerts", "owner_step_up_alert_insert_invalid"],
      ] as const) {
        await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run())
          .rejects.toThrow(error);
      }
      await expect(env.DB.prepare(`UPDATE owner_call_step_up_alerts SET alert_class = 'configuration'
        WHERE owner_principal_id = 'principal:owner' AND alert_class = 'rejected' AND direction = 'inbound'`).run())
        .rejects.toThrow("owner_step_up_alert_key_immutable");
    } finally { await system.cleanup(); }
  }, 30_000);
});
