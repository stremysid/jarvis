import { applyD1Migrations, env } from "cloudflare:test";
import foundationSql from "../../src/persistence/migrations/0001_foundation.sql?raw";
import foundationHardeningSql from "../../src/persistence/migrations/0002_foundation_hardening.sql?raw";
import callingSql from "../../src/persistence/migrations/0003_calling.sql?raw";
import callSessionsSql from "../../src/persistence/migrations/0004_call_sessions.sql?raw";
import conversationSql from "../../src/persistence/migrations/0005_conversation.sql?raw";
import voiceAccessSql from "../../src/persistence/migrations/0006_voice_access.sql?raw";
import voiceAccessBoundariesSql from "../../src/persistence/migrations/0007_voice_access_boundaries.sql?raw";
import autonomySql from "../../src/persistence/migrations/0008_autonomy.sql?raw";
import decisionsSql from "../../src/persistence/migrations/0009_decisions.sql?raw";
import projectsSql from "../../src/persistence/migrations/0010_projects.sql?raw";
import deadlinesSql from "../../src/persistence/migrations/0011_deadlines.sql?raw";
import livenessSql from "../../src/persistence/migrations/0012_liveness.sql?raw";
import scheduledRunsSql from "../../src/persistence/migrations/0013_scheduled_runs.sql?raw";
import memoryProjectionSql from "../../src/persistence/migrations/0014_memory_projection.sql?raw";
import voiceRuntimeSql from "../../src/persistence/migrations/0015_voice_runtime.sql?raw";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";

let migrated: Promise<void> | undefined;
let voiceRuntimeMigrated: Promise<void> | undefined;
let cloudMemoryMigrated: Promise<void> | undefined;

/**
 * Split a migration into the statements D1 applies one at a time.
 *
 * Triggers are lifted out first because their bodies contain the semicolons
 * this otherwise splits on. Any comment lines directly above a trigger are
 * lifted with it: left behind, they would be a fragment that no longer
 * resolves to the trigger marker, and the trigger would be applied as its own
 * literal text.
 *
 * Semicolons inside comments elsewhere still cut a statement in half, which
 * surfaces as `incomplete input` from D1. Migrations avoid them.
 */
export function splitMigration(sql: string): string[] {
  const triggers: string[] = [];
  const statements = sql.replace(/(?:^[^\S\n]*--[^\n]*\n)*CREATE TRIGGER\b[\s\S]*?\nEND;/gimu, (trigger) => {
    const marker = `__JARVIS_TRIGGER_${triggers.length}__`;
    triggers.push(trigger.slice(0, -1));
    return `${marker};`;
  });
  return statements.split(";").map((query) => query.trim()).filter(Boolean).map((query) => {
    const marker = /^__JARVIS_TRIGGER_(\d+)__$/u.exec(query);
    return marker === null ? query : (triggers[Number(marker[1])] ?? query);
  });
}

export const voiceAccessBaseMigrations = Object.freeze([
  { name: "0001_foundation.sql", queries: splitMigration(foundationSql) },
  { name: "0002_foundation_hardening.sql", queries: splitMigration(foundationHardeningSql) },
  { name: "0003_calling.sql", queries: splitMigration(callingSql) },
  { name: "0004_call_sessions.sql", queries: splitMigration(callSessionsSql) },
  { name: "0005_conversation.sql", queries: splitMigration(conversationSql) },
  { name: "0006_voice_access.sql", queries: splitMigration(voiceAccessSql) },
]);

export const voiceAccessBoundariesMigration = Object.freeze({
  name: "0007_voice_access_boundaries.sql",
  queries: splitMigration(voiceAccessBoundariesSql),
});

/**
 * Everything after the voice-access boundary. Kept separate from
 * `voiceAccessBaseMigrations` because those two exports name the exact point
 * the voice-access tests reconstruct, and appending here would silently
 * change what they are testing.
 */
export const assistantMigrations = Object.freeze([
  { name: "0008_autonomy.sql", queries: splitMigration(autonomySql) },
  { name: "0009_decisions.sql", queries: splitMigration(decisionsSql) },
  { name: "0010_projects.sql", queries: splitMigration(projectsSql) },
  { name: "0011_deadlines.sql", queries: splitMigration(deadlinesSql) },
  { name: "0012_liveness.sql", queries: splitMigration(livenessSql) },
  { name: "0013_scheduled_runs.sql", queries: splitMigration(scheduledRunsSql) },
  { name: "0014_memory_projection.sql", queries: splitMigration(memoryProjectionSql) },
]);

/** Applies the deployable Wrangler migration to the actual D1 test binding once. */
export function applyFoundationMigration(): Promise<void> {
  migrated ??= applyD1Migrations(env.DB, [
    ...voiceAccessBaseMigrations,
    voiceAccessBoundariesMigration,
    ...assistantMigrations,
  ]);
  return migrated;
}

/** R1 production adapter tests opt into the additive runtime migration. */
export async function applyVoiceRuntimeMigration(): Promise<void> {
  await applyFoundationMigration();
  voiceRuntimeMigrated ??= applyD1Migrations(env.DB, [
    { name: "0015_voice_runtime.sql", queries: splitMigration(voiceRuntimeSql) },
  ]);
  await voiceRuntimeMigrated;
}

/** Applies the reviewed cloud-memory schema only to the isolated D1 test binding. */
export async function applyCloudMemoryMigration(): Promise<void> {
  await applyVoiceRuntimeMigration();
  cloudMemoryMigrated ??= applyD1Migrations(env.DB, [
    { name: "0016_cloud_memory.sql", queries: splitMigration(cloudMemorySql) },
  ]);
  await cloudMemoryMigrated;
}

const MEMORY_PROJECTION_DELETE_GUARDS = Object.freeze([
  "memory_fact_projection_abandoned_no_delete",
  "memory_fact_projection_commits_immutable_delete",
  "memory_fact_projection_heads_delete_guard",
  "memory_fact_projection_versions_delete_guard",
]);

/** Test-only reset that restores exactly the production guards present before cleanup. */
export async function clearMemoryProjectionDataForTest(): Promise<void> {
  const result = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE type = 'trigger' AND name IN (${MEMORY_PROJECTION_DELETE_GUARDS.map(() => "?").join(", ")})`,
  ).bind(...MEMORY_PROJECTION_DELETE_GUARDS).all<{ name: string; sql: string }>();
  const guards = result.results.filter((row) => typeof row.sql === "string");
  for (const name of MEMORY_PROJECTION_DELETE_GUARDS) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
  try {
    await env.DB.prepare("DELETE FROM memory_fact_projection_abandoned").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_commits").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_heads").run();
    await env.DB.prepare("DELETE FROM memory_fact_projection_versions").run();
  } finally {
    for (const guard of guards) await env.DB.prepare(guard.sql).run();
  }
}

/** Test-only reset that restores the production delete guard immediately after clearing isolated D1 state. */
export async function clearOutboundCallAttemptsForTest(): Promise<void> {
  await clearCallSessionsForTest();
  await env.DB.prepare("DROP TRIGGER IF EXISTS outbound_call_attempts_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM outbound_call_attempts").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER outbound_call_attempts_reject_delete
      BEFORE DELETE ON outbound_call_attempts
      BEGIN
        SELECT RAISE(ABORT, 'outbound_attempt_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for immutable session tombstones. */
export async function clearCallSessionsForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_session_authorities_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_sessions_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM call_session_authorities").run();
    await env.DB.prepare("DELETE FROM call_sessions").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER call_sessions_reject_delete
      BEFORE DELETE ON call_sessions
      BEGIN
        SELECT RAISE(ABORT, 'call_session_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER call_session_authorities_delete_forbidden
      BEFORE DELETE ON call_session_authorities
      BEGIN
        SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for append-only owner, grant, event, and call-authority state. */
export async function clearVoiceAccessDataForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_session_authorities_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_access_grant_events_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_access_grants_delete_forbidden").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS voice_owner_identity_delete_forbidden").run();
  try {
    await env.DB.prepare("DELETE FROM call_session_authorities").run();
    await env.DB.prepare("DELETE FROM voice_access_grant_events").run();
    await env.DB.prepare("DELETE FROM voice_access_grants").run();
    await env.DB.prepare("DELETE FROM voice_owner_identity").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER call_session_authorities_delete_forbidden
      BEFORE DELETE ON call_session_authorities
      BEGIN
        SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_access_grant_events_delete_forbidden
      BEFORE DELETE ON voice_access_grant_events
      BEGIN
        SELECT RAISE(ABORT, 'voice_access_grant_event_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_access_grants_delete_forbidden
      BEFORE DELETE ON voice_access_grants
      BEGIN
        SELECT RAISE(ABORT, 'voice_access_grant_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER voice_owner_identity_delete_forbidden
      BEFORE DELETE ON voice_owner_identity
      BEGIN
        SELECT RAISE(ABORT, 'voice_owner_identity_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for append-only transient authentication reservations. */
export async function clearAuthenticationAttemptReservationsForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS authentication_attempt_reservations_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM authentication_attempt_reservations").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER authentication_attempt_reservations_reject_delete
      BEFORE DELETE ON authentication_attempt_reservations
      BEGIN
        SELECT RAISE(ABORT, 'authentication_reservation_delete_forbidden');
      END`).run();
  }
}

/** Test-only reset for immutable conversation turn and delivery replay authority. */
export async function clearConversationDataForTest(): Promise<void> {
  await env.DB.prepare("DROP TRIGGER IF EXISTS conversation_deliveries_reject_delete").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS conversation_turns_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM conversation_deliveries").run();
    await env.DB.prepare("DELETE FROM conversation_turns").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER conversation_turns_reject_delete
      BEFORE DELETE ON conversation_turns
      BEGIN
        SELECT RAISE(ABORT, 'conversation_turn_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER conversation_deliveries_reject_delete
      BEFORE DELETE ON conversation_deliveries
      BEGIN
        SELECT RAISE(ABORT, 'conversation_delivery_delete_forbidden');
      END`).run();
  }
}
