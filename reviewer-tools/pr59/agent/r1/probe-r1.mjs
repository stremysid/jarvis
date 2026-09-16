import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
function splitMigration(sql) {
  const triggers = [];
  const statements = sql.replace(/(?:^[^\S\n]*--[^\n]*\n)*CREATE TRIGGER\b[\s\S]*?\nEND;/gimu, (t) => { const m = `__JARVIS_TRIGGER_${triggers.length}__`; triggers.push(t.slice(0, -1)); return `${m};`; });
  return statements.split(";").map((q) => q.trim()).filter(Boolean).map((q) => { const m = /^__JARVIS_TRIGGER_(\d+)__$/u.exec(q); return m === null ? q : triggers[Number(m[1])]; });
}
const db = new DatabaseSync(":memory:");
const dir = new URL("./migrations/", import.meta.url);
for (const f of readdirSync(dir).sort()) for (const q of splitMigration(readFileSync(new URL(f, dir), "utf8"))) db.exec(q);
const P = "owner", t = new Date().toISOString(), run = "01h" + "0".repeat(20) + "100";
db.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'service', 'active', 'o', ?, ?)").run(P, t, t);
const tryRun = (label, sql, p = []) => { try { const r = db.prepare(sql).run(...p); console.log(label, "OK", r.changes); } catch (e) { console.log(label, "ABORT", e.message); } };
tryRun("start", "INSERT INTO memory_runs (run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence, provider_model_id, outcome, started_at) VALUES (?, ?, 'k', 'distillation', 1, 2, 'openai:x', 'running', ?)", [run, P, t]);
tryRun("->failed", "UPDATE memory_runs SET outcome='failed', completed_at=?, failure_code='x' WHERE run_id=?", [t, run]);
tryRun("failed->nothing_new (ebd41f9 0026 + 0016)", "UPDATE memory_runs SET outcome='nothing_new', failure_code=NULL WHERE run_id=?", [run]);
db.exec("DROP TRIGGER IF EXISTS memory_distillation_cursor_insert_guard");
tryRun("seed cursor 5", "INSERT INTO memory_cursors VALUES (?, 'distillation', 5, ?)", [P, t]);
tryRun("cursor 5->3 (ebd41f9 0026 + 0016)", "UPDATE memory_cursors SET current_event_sequence=3 WHERE principal_id=?", [P]);
