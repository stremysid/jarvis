import { env } from "cloudflare:test";
import { applyFoundationMigration } from "../persistence/migration.js";

/**
 * Test-only reset that restores the production append-only guards immediately
 * after clearing isolated D1 state.
 *
 * `deadline_revisions` refuses DELETE by trigger, which is the property the
 * revision history rests on, so the trigger is dropped and recreated in a
 * `finally` -- a reset that leaves the guard off would let every later test in
 * the file pass against a table that no longer enforces the thing under test.
 */
export async function resetDeadlineTables(): Promise<void> {
  await applyFoundationMigration();
  await env.DB.prepare("DROP TRIGGER IF EXISTS deadline_revisions_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM quiet_windows").run();
    await env.DB.prepare("DELETE FROM deadline_revisions").run();
    await env.DB.prepare("DELETE FROM deadlines").run();
    await env.DB.prepare("DELETE FROM deadline_sources").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER deadline_revisions_reject_delete
      BEFORE DELETE ON deadline_revisions
      BEGIN
        SELECT RAISE(ABORT, 'deadline_revision_delete_forbidden');
      END`).run();
  }
}

/** Counts revisions directly rather than through the repository, so a broken read cannot hide a missing write. */
export async function countRevisions(deadlineId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM deadline_revisions WHERE deadline_id = ?")
    .bind(deadlineId).first<{ count: number }>();
  return row?.count ?? 0;
}
