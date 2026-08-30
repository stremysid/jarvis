import { applyD1Migrations, env } from "cloudflare:test";
import foundationSql from "../../src/persistence/migrations/0001_foundation.sql?raw";
import foundationHardeningSql from "../../src/persistence/migrations/0002_foundation_hardening.sql?raw";
import callingSql from "../../src/persistence/migrations/0003_calling.sql?raw";
import callSessionsSql from "../../src/persistence/migrations/0004_call_sessions.sql?raw";

let migrated: Promise<void> | undefined;

function splitMigration(sql: string): string[] {
  const triggers: string[] = [];
  const statements = sql.replace(/CREATE TRIGGER\b[\s\S]*?\nEND;/giu, (trigger) => {
    const marker = `__JARVIS_TRIGGER_${triggers.length}__`;
    triggers.push(trigger.slice(0, -1));
    return `${marker};`;
  });
  return statements.split(";").map((query) => query.trim()).filter(Boolean).map((query) => {
    const marker = /^__JARVIS_TRIGGER_(\d+)__$/u.exec(query);
    return marker === null ? query : (triggers[Number(marker[1])] ?? query);
  });
}

/** Applies the deployable Wrangler migration to the actual D1 test binding once. */
export function applyFoundationMigration(): Promise<void> {
  migrated ??= applyD1Migrations(env.DB, [
    {
      name: "0001_foundation.sql",
      queries: splitMigration(foundationSql),
    },
    {
      name: "0002_foundation_hardening.sql",
      queries: splitMigration(foundationHardeningSql),
    },
    {
      name: "0003_calling.sql",
      queries: splitMigration(callingSql),
    },
    {
      name: "0004_call_sessions.sql",
      queries: splitMigration(callSessionsSql),
    },
  ]);
  return migrated;
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
  await env.DB.prepare("DROP TRIGGER IF EXISTS call_sessions_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM call_sessions").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER call_sessions_reject_delete
      BEFORE DELETE ON call_sessions
      BEGIN
        SELECT RAISE(ABORT, 'call_session_delete_forbidden');
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
