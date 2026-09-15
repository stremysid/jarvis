import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { createFakeCallingSystem, type FakeCallingSystem } from "../../../../tests/acceptance/fake/voice-call-system.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { clearOwnerPassphraseDataForTest } from "./migration.js";

// Reviewer probe for PR #40, finding B3 (adv40.md B3, pr40-adversarial F4).
//
// The dormant caller-ID waiver branch of call_session_authorities_require_current_lineage
// (0018:495-498) admits an owner with NO head/verifier check. So even when the owner
// passphrase head is disabled (0017 kill switch) or was never configured, a
// waived_passed_a inbound owner binding still mints full owner authority. The disable
// kill switch therefore does not stop waived calls.
//
// This probe ASSERTS THE BUG on head 6b63d08: with the passphrase head removed
// entirely (unconfigured verifier), inserting owner authority under the waiver
// succeeds.
//
// Expected on a fix (waiver branch requires head.status='active' AND
// verifier.status='active'): the authority INSERT RAISEs
// call_session_authority_requires_current_lineage, so `.resolves` fails with that
// guard — NOT a "no such table/column" error.

const NOW = "2026-08-30T12:00:00.000Z";
const EXPIRES_1800 = "2026-08-30T12:30:00.000Z";

let system: FakeCallingSystem | null = null;
afterEach(async () => { await system?.cleanup(); system = null; });

async function waivedPreAuthOwnerSession(): Promise<StoredCallSession> {
  const calls = new CallRepository(env.DB, new EventRepository(env.DB));
  const session = await calls.getOrCreateInboundSession({
    callSid: `CA${"9".repeat(32)}`,
    callerE164: "+14165550123",
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion: "hmac-v1",
    now: new Date(NOW),
  });
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

describe("reviewer probe PR #40 B3 — dormant waiver mints owner authority with no configured verifier", () => {
  it("admits a waived inbound owner even after the passphrase head is gone", async () => {
    system = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    const session = await waivedPreAuthOwnerSession();

    // The dormant waiver binding (as bind() would write it for an inbound Passed-A call).
    await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, 'inbound', 1, 'waived_passed_a', 'passed_a', 'waive_on_passed_a', ?)`)
      .bind(session.sessionId, session.callSid, session.binding.principalId,
        session.binding.identityId, session.createdAt).run();

    // Disable / unconfigure the verifier: remove the passphrase head and verifier
    // rows entirely (models a disabled head or one that never existed).
    await clearOwnerPassphraseDataForTest();
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM owner_passphrase_heads WHERE status = 'active'",
    ).first()).toEqual({ count: 0 });

    // THE BUG: owner authority is minted under the waiver despite no active verifier.
    await expect(env.DB.prepare(`INSERT INTO call_session_authorities (
      session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
      access_document_hash, authenticated_at, expires_at
    ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
      .bind(session.sessionId, session.binding.principalId, session.binding.identityId, NOW, EXPIRES_1800)
      .run()).resolves.toBeDefined();

    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
    ).bind(session.sessionId).first()).toEqual({ count: 1 });
  });
});
