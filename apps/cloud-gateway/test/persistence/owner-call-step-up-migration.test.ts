import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyOwnerCallStepUpMigration,
  clearCallSessionsForTest,
  clearVoiceAccessDataForTest,
} from "./migration.js";

/**
 * The step-up tables remain after the per-call passphrase gate was removed.
 *
 * Sid, 2026-09-24: an ordinary owner call goes straight to Jarvis, so nothing
 * writes these tables any more. They stay because the brief that removed the
 * gate says not to drop them, and a later credential design may want them. What
 * is still worth pinning is the schema's own shape, the fact that `0047`
 * has replaced `0018`'s owner-authority guard, and that the replacement still
 * refuses owner authority to anyone but the enrolled owner identity.
 *
 * The service that used to be tested here -- `OwnerCallStepUpService` and its
 * bind/begin/expire retries -- is deleted with the gate, so those tests are
 * gone rather than rewritten around a code path that no longer exists.
 */
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
  });

  it("replaces the owner-authority guard with one no step-up row can satisfy", async () => {
    await applyOwnerCallStepUpMigration();
    const authority = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'call_session_authorities_require_current_lineage'`)
      .first<{ sql: string }>();
    // The two clauses that could only ever be satisfied by a passphrase match
    // are gone. An owner call mints its authority from relay setup, so a guard
    // that still named them would abort every owner call.
    expect(authority?.sql).not.toContain("owner_call_step_up_successes");
    expect(authority?.sql).not.toContain("owner_call_step_up_bindings");
    expect(authority?.sql).not.toContain("owner_passphrase_");
    // What remains is still the real lineage check, and the guest branch is
    // untouched: a guest authority still needs the exact bound grant.
    expect(authority?.sql).toContain("voice_owner_identity");
    expect(authority?.sql).toContain("voice_access_grants");
    expect(authority?.sql).toContain("session.guest_grant_id = NEW.grant_id");
    expect(authority?.sql).not.toMatch(/CASE[\s\S]*RAISE/iu);
  });

  it("refuses an owner authority for any voice identity that is not the enrolled owner, and admits the enrolled one", async () => {
    await applyOwnerCallStepUpMigration();
    await clearCallSessionsForTest();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES (?, 'human', 'active', 'owner', ?, ?), (?, 'human', 'active', 'stranger', ?, ?)`)
        .bind(OWNER_PRINCIPAL_ID, CONNECTED_AT, CONNECTED_AT, STRANGER_PRINCIPAL_ID, CONNECTED_AT, CONNECTED_AT),
      // Every identity is an active, verified voice identity of a human, so the
      // ONLY thing separating them is the enrolment row below. Anything weaker
      // would let a different clause of the trigger do the refusing.
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES (?, ?, 'voice', '+14165550181', 'active', ?, ?), (?, ?, 'voice', '+14165550182', 'active', ?, ?),
          (?, ?, 'voice', '+14165550183', 'active', ?, ?)`)
        .bind(
          OWNER_IDENTITY_ID, OWNER_PRINCIPAL_ID, CONNECTED_AT, CONNECTED_AT,
          STRANGER_IDENTITY_ID, STRANGER_PRINCIPAL_ID, CONNECTED_AT, CONNECTED_AT,
          OWNER_SECOND_IDENTITY_ID, OWNER_PRINCIPAL_ID, CONNECTED_AT, CONNECTED_AT,
        ),
      env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, ?, ?)")
        .bind(OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID, CONNECTED_AT),
    ]);

    // The session-side guards (0006) already refuse an owner session for a
    // non-enrolled identity, so no real code path can reach 0047 with one. The
    // authority trigger is the last line behind them: this forges the session
    // row past those guards, exactly the state a future bug in them would
    // leave, and restores them byte-for-byte afterwards.
    await withTriggersSuspended(SESSION_OWNER_GUARDS, async () => {
      await seedOwnerAccessSession(STRANGER_SESSION_ID, "e", STRANGER_PRINCIPAL_ID, STRANGER_IDENTITY_ID);
      await seedOwnerAccessSession(OWNER_SECOND_SESSION_ID, "f", OWNER_PRINCIPAL_ID, OWNER_SECOND_IDENTITY_ID);
    });
    await seedOwnerAccessSession(OWNER_SESSION_ID, "d", OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID);

    // Without the enrolment match, any enrolled owner anywhere would satisfy the
    // EXISTS and a stranger's call would be minted Sid's owner authority.
    await expect(insertOwnerAuthority(STRANGER_SESSION_ID, STRANGER_PRINCIPAL_ID, STRANGER_IDENTITY_ID))
      .rejects.toThrow(/call_session_authority_requires_current_lineage/u);
    // Sid's own principal on a second, unenrolled number is refused as well: the
    // enrolment names one identity, not every identity the principal owns.
    await expect(insertOwnerAuthority(OWNER_SECOND_SESSION_ID, OWNER_PRINCIPAL_ID, OWNER_SECOND_IDENTITY_ID))
      .rejects.toThrow(/call_session_authority_requires_current_lineage/u);
    // The control: the same insert for the enrolled owner is admitted, so the
    // refusal above is the enrolment match and not some unrelated clause.
    await expect(insertOwnerAuthority(OWNER_SESSION_ID, OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID))
      .resolves.toMatchObject({ success: true });
  });
});

const CONNECTED_AT = "2026-08-30T00:00:00.000Z";
const AUTHORITY_EXPIRES_AT = "2026-08-30T00:30:00.000Z";
const RELAY_DEADLINE = "2026-08-30T00:05:00.000Z";
const OWNER_PRINCIPAL_ID = "principal:0047-owner";
const OWNER_IDENTITY_ID = "identity:0047-owner";
const STRANGER_PRINCIPAL_ID = "principal:0047-stranger";
const STRANGER_IDENTITY_ID = "identity:0047-stranger";
const OWNER_SECOND_IDENTITY_ID = "identity:0047-owner-second";
const OWNER_SESSION_ID = "01k3w1t4000000000000004700";
const STRANGER_SESSION_ID = "01k3w1t4000000000000004701";
const OWNER_SECOND_SESSION_ID = "01k3w1t4000000000000004702";
/** The three session-side guards that each refuse an owner session for a non-enrolled identity. */
const SESSION_OWNER_GUARDS = [
  "call_sessions_require_inbound_lineage",
  "call_sessions_voice_access_required",
  "call_sessions_provider_binding_eligible",
] as const;

/** Drops the named triggers for `run`, then recreates each from its own stored SQL. */
async function withTriggersSuspended(names: readonly string[], run: () => Promise<void>): Promise<void> {
  const placeholders = names.map(() => "?").join(", ");
  const saved = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (${placeholders})`)
    .bind(...names).all<{ name: string; sql: string }>();
  // If a guard is renamed, this fails loudly; otherwise the rename would leave it
  // in place and the forged session insert would abort for the wrong reason.
  expect(saved.results.map((row) => row.name).sort()).toEqual([...names].sort());
  for (const { name } of saved.results) await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await run();
  } finally {
    for (const { sql } of saved.results) await env.DB.prepare(sql).run();
  }
}

/** Seeds an inbound owner-access session and walks it to `pre_auth`, the phase an authority is minted in. */
async function seedOwnerAccessSession(sessionId: string, callHex: string, principalId: string, identityId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?, 'owner', NULL, NULL, NULL)`)
    .bind(
      sessionId, `CA${callHex.repeat(32)}`, principalId, identityId, identityId, `${callHex.repeat(42)}A`,
      RELAY_DEADLINE, RELAY_DEADLINE, CONNECTED_AT, CONNECTED_AT,
    ).run();
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = 'VX' || substr(call_sid, 3), provider_connected_at = ?, updated_at = ?
    WHERE session_id = ?`).bind(CONNECTED_AT, CONNECTED_AT, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(CONNECTED_AT, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(CONNECTED_AT, sessionId).run();
}

function insertOwnerAuthority(sessionId: string, principalId: string, identityId: string): Promise<D1Result<unknown>> {
  return env.DB.prepare(`INSERT INTO call_session_authorities (
    session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
    access_document_hash, authenticated_at, expires_at
  ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
    .bind(sessionId, principalId, identityId, CONNECTED_AT, AUTHORITY_EXPIRES_AT).run();
}
