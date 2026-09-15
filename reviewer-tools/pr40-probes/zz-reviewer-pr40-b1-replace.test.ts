import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { createFakeCallingSystem, type FakeCallingSystem } from "../../../../tests/acceptance/fake/voice-call-system.js";
import { FAKE_OWNER_PASSPHRASE } from "../../../../tests/acceptance/fake/voice-access-system.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";

// Reviewer probe for PR #40, findings B1a/B1b/B1c (adv40.md B1, pr40-adversarial F1/F2/F3).
//
// These ASSERT THE BUG on head 6b63d08: INSERT OR REPLACE deletes a guarded 0018
// row without firing its BEFORE DELETE guard, because SQLite/D1 run with
// recursive_triggers = 0 (the same mechanism proved for PR #39 NF1). Each probe
// leaves the replaced row as a LEAF (no FK child) so ON DELETE RESTRICT cannot
// mask the missing guard.
//
// Expected behaviour once fixed (each insert guard rejects an already-present
// natural key): the INSERT OR REPLACE itself RAISEs, so the `.resolves`
// expectation fails with the guard message shown per test — NOT with
// "no such table/column".

const NOW = "2026-08-30T12:00:00.000Z";
const EXPIRES_1800 = "2026-08-30T12:30:00.000Z"; // authenticated_at + 1800s, allowed by the CHECK.

let system: FakeCallingSystem | null = null;
afterEach(async () => { await system?.cleanup(); system = null; });

function repo(): CallRepository {
  return new CallRepository(env.DB, new EventRepository(env.DB));
}

async function ownerAuthorityCount(sessionId: Ulid): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
  ).bind(sessionId).first<{ count: number }>())?.count ?? 0;
}

/** Reach pre_auth for a real inbound owner session WITHOUT creating a window row. */
async function preAuthOwnerSession(): Promise<StoredCallSession> {
  const calls = repo();
  const session = await calls.getOrCreateInboundSession({
    callSid: `CA${"9".repeat(32)}`,
    callerE164: "+14165550123",
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion: "hmac-v1",
    now: new Date(NOW),
  });
  // Record a provider connection so call_session_authorities_provider_lifetime is satisfied.
  await calls.bindRelaySession({
    sessionId: session.sessionId,
    callSid: session.callSid,
    providerSessionId: `VX${"5".repeat(32)}`,
    relayNonce: session.binding.relayNonce,
    direction: "inbound",
    now: new Date(NOW),
  });
  await calls.transitionCallSession({
    sessionId: session.sessionId, expectedPhase: "created", nextPhase: "connecting", now: new Date(NOW),
  });
  return calls.transitionCallSession({
    sessionId: session.sessionId, expectedPhase: "connecting", nextPhase: "pre_auth", now: new Date(NOW),
  });
}

describe("reviewer probe PR #40 B1 — INSERT OR REPLACE bypasses 0018 delete guards", () => {
  it("B1a: REPLACE switches a required inbound binding to the waiver and then mints owner authority with no phrase", async () => {
    system = await createFakeCallingSystem();
    const session = await preAuthOwnerSession();

    // A `required` binding exists (the shipped default for an owner inbound call).
    await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, 'inbound', 1, 'required', 'absent', 'passphrase_always', ?)`)
      .bind(session.sessionId, session.callSid, session.binding.principalId,
        session.binding.identityId, session.createdAt).run();

    // A plain DELETE is refused; the row is a leaf (no window child yet).
    await expect(env.DB.prepare("DELETE FROM owner_call_step_up_bindings WHERE session_id = ?")
      .bind(session.sessionId).run()).rejects.toThrow(/owner_call_step_up_binding_delete_forbidden/u);

    // THE BUG: INSERT OR REPLACE deletes the guarded row (delete guard never fires)
    // and installs the dormant waiver snapshot, which the shape guard accepts.
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, 'inbound', 1, 'waived_passed_a', 'passed_a', 'waive_on_passed_a', ?)`)
      .bind(session.sessionId, session.callSid, session.binding.principalId,
        session.binding.identityId, session.createdAt).run()).resolves.toBeDefined();

    expect(await env.DB.prepare("SELECT requirement FROM owner_call_step_up_bindings WHERE session_id = ?")
      .bind(session.sessionId).first()).toEqual({ requirement: "waived_passed_a" });

    // With the binding switched, the authority trigger's waiver branch admits an
    // owner with NO passphrase.
    await expect(env.DB.prepare(`INSERT INTO call_session_authorities (
      session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
      access_document_hash, authenticated_at, expires_at
    ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
      .bind(session.sessionId, session.binding.principalId, session.binding.identityId, NOW, EXPIRES_1800)
      .run()).resolves.toBeDefined();
    expect(await ownerAuthorityCount(session.sessionId)).toBe(1);
    // FIX shape: REPLACE rejects with /owner_call_step_up_binding/ (existing-key guard).
  });

  it("B1b: REPLACE on owner_call_step_up_windows pushes the 60-second deadline out", async () => {
    system = await createFakeCallingSystem();
    expect((await system.inbound()).status).toBe(200);
    const call = await system.openRelay();
    await call.setup();
    expect(await call.phase()).toBe("pre_auth");

    const before = await env.DB.prepare(`SELECT prompted_at, deadline_at, verifier_version
      FROM owner_call_step_up_windows WHERE session_id = ? AND lifecycle_generation = 1`)
      .bind(call.sessionId).first<{ prompted_at: string; deadline_at: string; verifier_version: number }>();
    if (before === null) throw new Error("probe_window_missing");

    // A later prompt, still after provider_connected_at, with deadline = prompted + 60s.
    const laterPrompt = new Date(new Date(before.prompted_at).valueOf() + 5_000).toISOString();
    const laterDeadline = new Date(new Date(laterPrompt).valueOf() + 60_000).toISOString();
    expect(laterDeadline > before.deadline_at).toBe(true);

    await expect(env.DB.prepare("DELETE FROM owner_call_step_up_windows WHERE session_id = ?")
      .bind(call.sessionId).run()).rejects.toThrow(/owner_call_step_up_window_delete_forbidden/u);

    // THE BUG: REPLACE deletes the window (no attempts/reprompts children) and
    // re-installs a later deadline, which the alarm handler then reads and re-arms to.
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_windows (
      session_id, lifecycle_generation, verifier_version, prompted_at, deadline_at
    ) VALUES (?, 1, ?, ?, ?)`)
      .bind(call.sessionId, before.verifier_version, laterPrompt, laterDeadline).run())
      .resolves.toBeDefined();

    expect(await env.DB.prepare("SELECT deadline_at FROM owner_call_step_up_windows WHERE session_id = ?")
      .bind(call.sessionId).first()).toEqual({ deadline_at: laterDeadline });
    // FIX shape: REPLACE rejects with /owner_call_step_up_window/ (existing-key guard).
  });

  it("B1c: REPLACE on owner_call_step_up_repeat_checks resets a used one-time repeat check", async () => {
    system = await createFakeCallingSystem();
    expect((await system.inbound()).status).toBe(200);
    const call = await system.openRelay();
    await call.setup();
    await call.prompt(FAKE_OWNER_PASSPHRASE);
    expect(await call.phase()).toBe("active");

    // Reserve then resolve the one-time repeat check (as the runtime does after "Verified.").
    const reservedAt = "2026-08-30T12:00:03.000Z";
    await env.DB.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
      session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
    ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(call.sessionId, reservedAt).run();
    await env.DB.prepare(`UPDATE owner_call_step_up_repeat_checks
      SET outcome = 'matched', resolved_at = ? WHERE session_id = ?`)
      .bind(reservedAt, call.sessionId).run();
    expect(await env.DB.prepare("SELECT outcome FROM owner_call_step_up_repeat_checks WHERE session_id = ?")
      .bind(call.sessionId).first()).toEqual({ outcome: "matched" });

    await expect(env.DB.prepare("DELETE FROM owner_call_step_up_repeat_checks WHERE session_id = ?")
      .bind(call.sessionId).run()).rejects.toThrow(/owner_call_step_up_repeat_delete_forbidden/u);

    // THE BUG: REPLACE deletes the resolved row and installs a fresh unresolved one,
    // so another KDF-backed repeat compare becomes possible.
    const laterReserved = "2026-08-30T12:00:09.000Z";
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO owner_call_step_up_repeat_checks (
      session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
    ) VALUES (?, 1, 1, ?, NULL, NULL)`).bind(call.sessionId, laterReserved).run())
      .resolves.toBeDefined();

    expect(await env.DB.prepare("SELECT outcome, resolved_at FROM owner_call_step_up_repeat_checks WHERE session_id = ?")
      .bind(call.sessionId).first()).toEqual({ outcome: null, resolved_at: null });
    // FIX shape: REPLACE rejects with /owner_call_step_up_repeat/ (existing-key guard).
  });
});
