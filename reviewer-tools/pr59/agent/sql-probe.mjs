// Applies 0001..0026 at 7fd25ff to node:sqlite with the repo's splitMigration
// shape, then probes M3, M4, M5 and L3 guards. Scratch only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

function splitMigration(sql) {
  const triggers = [];
  const statements = sql.replace(/(?:^[^\S\n]*--[^\n]*\n)*CREATE TRIGGER\b[\s\S]*?\nEND;/gimu, (trigger) => {
    const marker = `__JARVIS_TRIGGER_${triggers.length}__`;
    triggers.push(trigger.slice(0, -1));
    return `${marker};`;
  });
  return statements.split(";").map((q) => q.trim()).filter(Boolean).map((q) => {
    const m = /^__JARVIS_TRIGGER_(\d+)__$/u.exec(q);
    return m === null ? q : (triggers[Number(m[1])] ?? q);
  });
}

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("./migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    for (const q of splitMigration(readFileSync(new URL(file, dir), "utf8"))) {
      try { db.exec(q); } catch (e) { throw new Error(`${file}: ${e.message}\n${q.slice(0, 200)}`); }
    }
  }
  return db;
}

const results = [];
function attempt(label, db, sql, params = []) {
  try {
    const r = db.prepare(sql).run(...params);
    results.push(`${label}: OK (changes=${r.changes})`);
    return true;
  } catch (e) {
    results.push(`${label}: ABORT ${e.message}`);
    return false;
  }
}

const P = "owner-principal";
const H = (c) => c.repeat(64);
const ulid = (n) => `01h${String(n).padStart(23, "0")}`;
const now = () => new Date().toISOString();

function seed(db) {
  const t = now();
  db.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?, 'service', 'active', 'owner', ?, ?)`).run(P, t, t);
  for (let i = 1; i <= 6; i += 1) {
    db.prepare(`INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
      VALUES (?, 'conversation.user_committed', 'conversation', ?, ?, ?, ?, '{}', ?)`)
      .run(ulid(i), i === 6 ? "someone-else" : P, t, t, H(String(i % 10)), t);
  }
}

function startRun(db, runId, key, start, end) {
  return attempt(`startRun ${key} [${start}..${end}]`, db, `INSERT INTO memory_runs (
    run_id, principal_id, run_key, job, reprocess_job_id, start_event_sequence, end_event_sequence,
    provider_model_id, price_id, outcome, started_at) VALUES (?, ?, ?, 'distillation', NULL, ?, ?, 'openai:fake', NULL, 'running', ?)`,
  [runId, P, key, start, end, now()]);
}

function receipt(db, label, runId, seq, disposition, reason, location = "live", segment = null, eventId = ulid(seq), hash = H(String(seq % 10))) {
  return attempt(label, db, `INSERT INTO memory_distillation_event_receipts (
    receipt_id, principal_id, run_id, event_sequence, event_id, content_hash, disposition, skip_reason,
    source_location, r2_segment_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [ulid(9000 + Math.floor(Math.random() * 90000)), P, runId, seq, eventId, hash, disposition, reason, location, segment, now()]);
}

function finalize(db, label, runId, count, outcome, failure = null) {
  return attempt(label, db, `UPDATE memory_runs SET input_event_count = ?, created_item_count = 0, outcome = ?,
    completed_at = ?, failure_code = ? WHERE principal_id = ? AND run_id = ? AND outcome = 'running'`,
  [count, outcome, now(), failure, P, runId]);
}

function failRunning(db, label, runId) {
  return attempt(label, db, `UPDATE memory_runs
    SET input_event_count = (SELECT count(*) FROM memory_distillation_event_receipts r WHERE r.principal_id = memory_runs.principal_id AND r.run_id = memory_runs.run_id),
      created_item_count = (SELECT COALESCE(sum(r.created_in_run), 0) FROM memory_distillation_item_receipts r WHERE r.principal_id = memory_runs.principal_id AND r.run_id = memory_runs.run_id),
      outcome = 'failed', completed_at = ?, failure_code = 'distillation_finalization_failed'
    WHERE principal_id = ? AND run_id = ? AND outcome = 'running'`, [now(), P, runId]);
}

// ---------- M4: terminal immutability, both guards together and each alone ----------
for (const variant of ["both", "only0026", "only0016"]) {
  const db = fresh();
  seed(db);
  if (variant === "only0026") db.exec("DROP TRIGGER memory_runs_update_guard");
  if (variant === "only0016") db.exec("DROP TRIGGER memory_distillation_runs_reconcile_guard");
  const run = ulid(100);
  startRun(db, run, `m4:${variant}`, 1, 2);
  finalize(db, `M4[${variant}] running->failed (0 receipts)`, run, 0, "failed", "distillation_provider_failed");
  attempt(`M4[${variant}] failed->nothing_new (raw update, no outcome filter)`, db,
    `UPDATE memory_runs SET outcome = 'nothing_new', failure_code = NULL WHERE run_id = ?`, [run]);
  attempt(`M4[${variant}] failed->failed touch completed_at`, db,
    `UPDATE memory_runs SET completed_at = ? WHERE run_id = ?`, [now(), run]);
}

// ---------- L3: cursor backwards, each guard alone ----------
for (const variant of ["both", "only0026", "only0016"]) {
  const db = fresh();
  seed(db);
  db.exec("DROP TRIGGER memory_distillation_cursor_insert_guard");
  if (variant === "only0026") db.exec("DROP TRIGGER memory_cursors_monotonic_update");
  if (variant === "only0016") db.exec("DROP TRIGGER memory_distillation_cursor_update_guard");
  attempt(`L3[${variant}] seed cursor at 5 (insert guard dropped)`, db,
    `INSERT INTO memory_cursors (principal_id, cursor_name, current_event_sequence, updated_at) VALUES (?, 'distillation', 5, ?)`, [P, now()]);
  attempt(`L3[${variant}] cursor 5 -> 3`, db,
    `UPDATE memory_cursors SET current_event_sequence = 3, updated_at = ? WHERE principal_id = ? AND cursor_name = 'distillation'`, ["2099-01-01T00:00:00.000Z", P]);
  attempt(`L3[${variant}] cursor 5 -> 6 with no run`, db,
    `UPDATE memory_cursors SET current_event_sequence = 6, updated_at = ? WHERE principal_id = ? AND cursor_name = 'distillation'`, ["2099-01-01T00:00:00.000Z", P]);
  attempt(`L3[${variant}] delete cursor`, db, `DELETE FROM memory_cursors WHERE principal_id = ?`, [P]);
  attempt(`L3[${variant}] INSERT OR REPLACE cursor to 0`, db,
    `INSERT OR REPLACE INTO memory_cursors (principal_id, cursor_name, current_event_sequence, updated_at) VALUES (?, 'distillation', 0, ?)`, [P, "2099-01-02T00:00:00.000Z"]);
  attempt(`L3[${variant}] rename cursor away then insert fresh 0`, db,
    `UPDATE memory_cursors SET cursor_name = 'export' WHERE principal_id = ? AND cursor_name = 'distillation'`, [P]);
}

// ---------- M3: failed finalization -> reachable terminal failure -> :r1 key ----------
{
  const db = fresh();
  seed(db);
  const run = ulid(200);
  startRun(db, run, "memory-distill:2026-09-16T15:0", 1, 2);
  db.exec("BEGIN");
  receipt(db, "M3 batch receipt 1", run, 1, "eligible", null);
  receipt(db, "M3 batch receipt 2", run, 2, "eligible", null);
  db.exec("ROLLBACK"); // the batch failed atomically (e.g. item-receipt guard)
  failRunning(db, "M3 failRunningRun after rolled-back batch", run);
  results.push(`M3 stored: ${JSON.stringify(db.prepare("SELECT outcome, failure_code, input_event_count FROM memory_runs WHERE run_id = ?").get(run))}`);
  startRun(db, ulid(201), "memory-distill:2026-09-16T15:0", 1, 2);
  startRun(db, ulid(202), "memory-distill:2026-09-16T15:0:r1", 1, 2);
  // Terminal failed with receipts partially present? Not possible via batch; check failRunning when receipts exist.
  const run2 = ulid(203);
  startRun(db, run2, "m3-partial", 1, 2);
  receipt(db, "M3 partial receipt 1 (non-batched)", run2, 1, "eligible", null);
  failRunning(db, "M3 failRunningRun with 1 receipt present", run2);
}

// ---------- M5: archive subject binding ----------
{
  const db = fresh();
  seed(db);
  db.exec("DROP TRIGGER archive_segment_events_require_manifest_range");
  db.exec("PRAGMA foreign_keys = OFF");
  const seg = H("a");
  const t = now();
  // archived-only events (live row absent): sequences 50, 51
  for (const [seq, subj] of [[50, null], [51, null], [52, null]]) {
    attempt(`M5 seed archive row ${seq}`, db, `INSERT INTO archive_segment_events (event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [seq, ulid(seq), seg, H("b"), H("c"), t]);
  }
  db.exec("PRAGMA foreign_keys = ON");
  attempt("M5 set subject_id NULL->owner (row 50)", db, `UPDATE archive_segment_events SET subject_id = ? WHERE event_sequence = 50 AND subject_id IS NULL`, [P]);
  attempt("M5 rewrite subject_id owner->other (row 50)", db, `UPDATE archive_segment_events SET subject_id = 'someone-else' WHERE event_sequence = 50`);
  attempt("M5 set subject_id NULL->other (row 51)", db, `UPDATE archive_segment_events SET subject_id = 'someone-else' WHERE event_sequence = 51`);
  attempt("M5 change segment_id while subject NULL (row 52)", db, `UPDATE archive_segment_events SET segment_id = ?, subject_id = ? WHERE event_sequence = 52`, [H("d"), P]);
  attempt("M5 change created_at while setting subject (row 52)", db, `UPDATE archive_segment_events SET created_at = '2000-01-01', subject_id = ? WHERE event_sequence = 52`, [P]);
  const run = ulid(300);
  startRun(db, run, "m5", 50, 52);
  receipt(db, "M5 eligible archived receipt, subject=owner (50)", run, 50, "eligible", null, "archived", seg, ulid(50), H("c"));
  receipt(db, "M5 eligible archived receipt, subject=other (51)", run, 51, "eligible", null, "archived", seg, ulid(51), H("c"));
  receipt(db, "M5 eligible archived receipt, subject=NULL (52)", run, 52, "eligible", null, "archived", seg, ulid(52), H("c"));
  receipt(db, "M5 skipped archived receipt, subject=other (51)", run, 51, "skipped", "owner_scope_ineligible", "archived", seg, ulid(51), H("c"));
  receipt(db, "M5 skipped receipt with NULL reason", run, 52, "skipped", null, "archived", seg, ulid(52), H("c"));
  receipt(db, "M5 eligible receipt with a reason", run, 52, "eligible", "text_budget_exceeded", "archived", seg, ulid(52), H("c"));
  receipt(db, "M5 live eligible receipt for other-subject event (seq 6)", run, 6, "eligible", null);
}

// ---------- backfill in migration: archive row whose live event exists ----------
{
  results.push("migration backfill check: see memory-distillation-migration.test.ts (not re-run here)");
}

console.log(results.join("\n"));
