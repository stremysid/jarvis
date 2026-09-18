import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
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

type FakeCallingSystem = Awaited<ReturnType<typeof createFakeCallingSystem>>;

function stepUpService(): OwnerCallStepUpService {
  return new OwnerCallStepUpService(
    env.DB, new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1"),
  );
}

/** A provider session id is 32 hex digits and is unique per call. */
function providerSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `VX${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A real inbound owner call parked in `pre_auth` with its provider connect
 * time set -- the state the 0018 triggers read.
 *
 * Owner admission moved to the sensitive action on 2026-09-17, so the relay
 * now walks an owner straight to active and nothing prompts for the phrase.
 * The 0018 tables and their guards are still written into backups and still
 * enforced on restore, so the fixture reproduces the old parking spot by hand
 * rather than dropping the coverage.
 */
async function openPreAuthOwnerCall(system: FakeCallingSystem): Promise<Ulid> {
  expect((await system.inbound()).status).toBe(200);
  const created = await env.DB.prepare(
    "SELECT session_id FROM call_sessions ORDER BY rowid DESC LIMIT 1",
  ).first<{ session_id: string }>();
  if (created === null) throw new Error("call_session_missing");
  const sessionId = created.session_id as Ulid;
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ?
    WHERE session_id = ?`).bind(providerSessionId(), NOW, NOW, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting' WHERE session_id = ?")
    .bind(sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth' WHERE session_id = ?")
    .bind(sessionId).run();
  return sessionId;
}

/** The same call with the 60-second window the relay used to open at setup. */
async function openPreAuthStepUp(system: FakeCallingSystem): Promise<Ulid> {
  const sessionId = await openPreAuthOwnerCall(system);
  await stepUpService().begin(sessionId, new Date(NOW));
  return sessionId;
}

async function phaseOf(sessionId: Ulid): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
    .bind(sessionId).first<{ phase: string }>())?.phase;
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
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      const service = stepUpService();
      const binding = await service.binding(sessionId);
      if (binding === null) throw new Error("owner_step_up_binding_missing");
      await expect(service.bind(binding)).resolves.toEqual(binding);
      await expect(service.bind({ ...binding, policy: "invalid" }))
        .rejects.toThrow("owner_step_up_binding_conflict");

      const first = await service.begin(sessionId, new Date("2026-08-30T12:00:30.000Z"));
      const second = await service.begin(sessionId, new Date("2026-08-30T12:00:45.000Z"));
      expect(second).toEqual(first);

      const expiredAt = new Date("2026-08-30T12:01:00.001Z");
      await service.expire(sessionId, expiredAt);
      await service.expire(sessionId, expiredAt);
      await expect(env.DB.prepare(`SELECT count(*) AS count FROM owner_call_step_up_rejections
        WHERE session_id = ?`).bind(sessionId).first()).resolves.toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  }, 15_000);

  it("pins the 60-second window guard and window immutability", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_windows (
        session_id, lifecycle_generation, verifier_version, prompted_at, deadline_at
      ) VALUES (?, 1, 1, ?, ?)`).bind(sessionId, NOW, "2026-08-30T12:01:01.000Z").run())
        .rejects.toThrow("owner_call_step_up_window_invalid");

      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_windows",
        "UPDATE owner_call_step_up_windows SET deadline_at = '2026-08-30T12:01:01.000Z'",
        "owner_call_step_up_window_immutable",
        "owner_call_step_up_window_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins attempt reservation, one-way resolution, and deletion guards", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_attempts (
        session_id, lifecycle_generation, attempt_ordinal, verifier_version, attempted_at, outcome, resolved_at
      ) VALUES (?, 1, 1, 1, ?, 'mismatched', ?)`).bind(sessionId, NOW, NOW).run())
        .rejects.toThrow("owner_call_step_up_attempt_invalid");
      await expect(stepUpService().verifyCandidate(sessionId, WRONG, new Date(NOW)))
        .resolves.toBe("mismatched");
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_attempts",
        "UPDATE owner_call_step_up_attempts SET attempted_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_attempt_transition_invalid",
        "owner_call_step_up_attempt_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins success provenance plus immutable success receipts", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(stepUpService().verifyCandidate(sessionId, WRONG, new Date(NOW)))
        .resolves.toBe("mismatched");
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_successes (
        session_id, lifecycle_generation, call_sid, direction, owner_principal_id,
        owner_identity_id, verifier_version, attempt_ordinal, verified_at
      ) SELECT binding.session_id, 1, binding.call_sid, binding.direction, binding.owner_principal_id,
        binding.owner_identity_id, 1, 1, ? FROM owner_call_step_up_bindings binding
        WHERE binding.session_id = ?`).bind(NOW, sessionId).run())
        .rejects.toThrow("owner_call_step_up_success_invalid");
    } finally { await system.cleanup(); }

    const verifiedSystem = await createFakeCallingSystem();
    try {
      const verifiedId = await openPreAuthStepUp(verifiedSystem);
      await expect(stepUpService().verifyCandidate(verifiedId, CORRECT, new Date(NOW)))
        .resolves.toBe("matched");
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_successes",
        "UPDATE owner_call_step_up_successes SET verified_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_success_immutable",
        "owner_call_step_up_success_delete_forbidden",
      );
    } finally { await verifiedSystem.cleanup(); }
  }, 30_000);

  it("pins reprompt order, exhaustion, immutability, and deletion", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_reprompts (
        session_id, lifecycle_generation, reprompt_ordinal, prompted_at
      ) VALUES (?, 1, 2, ?)`).bind(sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_reprompt_invalid");
      const stepUp = stepUpService();
      await expect(stepUp.recordReprompt(sessionId, new Date(NOW))).resolves.toBe("reprompt");
      await expect(stepUp.recordReprompt(sessionId, new Date(NOW))).resolves.toBe("reprompt");
      await expect(stepUp.recordReprompt(sessionId, new Date(NOW))).resolves.toBe("rejected");
      await expect(env.DB.prepare(`SELECT count(*) AS count FROM owner_call_step_up_reprompts
        WHERE session_id = ?`).bind(sessionId).first()).resolves.toEqual({ count: 3 });
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_reprompts",
        "UPDATE owner_call_step_up_reprompts SET prompted_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_reprompt_immutable",
        "owner_call_step_up_reprompt_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins rejection provenance, terminalization, immutability, and deletion", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_rejections (
        session_id, lifecycle_generation, reason, rejected_at
      ) VALUES (?, 1, 'attempts_exhausted', ?)`).bind(sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_rejection_invalid");
      const stepUp = stepUpService();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(stepUp.verifyCandidate(sessionId, WRONG, new Date(NOW)))
          .resolves.toBe(attempt === 2 ? "rejected" : "mismatched");
      }
      await expect(phaseOf(sessionId)).resolves.toBe("rejected");
      await expectUpdateAndDeleteRejected(
        "owner_call_step_up_rejections",
        "UPDATE owner_call_step_up_rejections SET rejected_at = '2026-08-30T12:00:00.001Z'",
        "owner_call_step_up_rejection_immutable",
        "owner_call_step_up_rejection_delete_forbidden",
      );
    } finally { await system.cleanup(); }
  });

  it("pins repeat-check timing, one-way resolution, and deletion", async () => {
    const system = await createFakeCallingSystem();
    try {
      const sessionId = await openPreAuthStepUp(system);
      await expect(stepUpService().verifyCandidate(sessionId, CORRECT, new Date(NOW)))
        .resolves.toBe("matched");
      // The repeat guard reads `active`, which the old admission left behind.
      await env.DB.prepare("UPDATE call_sessions SET phase = 'active' WHERE session_id = ?")
        .bind(sessionId).run();
      await expect(env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(sessionId, NOW).run())
        .rejects.toThrow("owner_call_step_up_repeat_invalid");
      const reservedAt = "2026-08-30T12:00:03.000Z";
      await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(sessionId, reservedAt).run();
      await env.DB.prepare(`UPDATE owner_call_step_up_repeat_checks
        SET outcome = 'mismatched', resolved_at = ? WHERE session_id = ?`)
        .bind(reservedAt, sessionId).run();
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
      const successful = await openPreAuthStepUp(system);
      await expect(stepUpService().verifyCandidate(successful, CORRECT, new Date(NOW)))
        .resolves.toBe("matched");
      // The repeat guard reads `active`, which the old admission left behind.
      await env.DB.prepare("UPDATE call_sessions SET phase = 'active' WHERE session_id = ?")
        .bind(successful).run();
      await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
        session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
      ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(successful, "2026-08-30T12:00:02.001Z").run();

      const reprompted = await openPreAuthStepUp(system);
      await expect(stepUpService().recordReprompt(reprompted, new Date(NOW))).resolves.toBe("reprompt");
      // The inbound route refuses a third live call for one principal, so this
      // one is retired before the next is opened. Its rows stay behind for the
      // replace guards below, which read rows rather than live calls.
      await env.DB.prepare("UPDATE call_sessions SET phase = 'failed' WHERE session_id = ?")
        .bind(reprompted).run();

      const rejected = await openPreAuthStepUp(system);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await stepUpService().verifyCandidate(rejected, WRONG, new Date(NOW));
      }

      // The reprompted call still holds its own binding and window, so it is the one
      // these two guards are asked about: three live owner calls is the per-principal
      // ceiling the inbound route enforces.
      for (const [statement, error] of [
        [`INSERT OR REPLACE INTO owner_call_step_up_bindings
          SELECT * FROM owner_call_step_up_bindings WHERE session_id = ?`, "owner_call_step_up_binding_invalid"],
        [`INSERT OR REPLACE INTO owner_call_step_up_windows
          SELECT * FROM owner_call_step_up_windows WHERE session_id = ?`, "owner_call_step_up_window_invalid"],
      ] as const) {
        await expect(env.DB.prepare(statement).bind(reprompted).run()).rejects.toThrow(error);
      }
      await expect(env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_repeat_checks
        SELECT * FROM owner_call_step_up_repeat_checks WHERE session_id = ?`).bind(successful).run())
        .rejects.toThrow("owner_call_step_up_repeat_invalid");

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