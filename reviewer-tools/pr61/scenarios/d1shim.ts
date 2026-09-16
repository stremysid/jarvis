import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const BASE = "C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-handoff-documentation-c01991/1b142017-0838-4dd9-9f2b-b76bb0eba596/scratchpad";

function split(sql: string): string[] {
  const out: string[] = []; let cur = ""; let trig = false;
  for (const line of sql.split("\n")) {
    const s = line.trim();
    if (s.startsWith("--")) continue;
    cur += line + "\n";
    if (/^CREATE\s+TRIGGER/i.test(s)) trig = true;
    if (trig) { if (/^END;/i.test(s)) { out.push(cur.trim()); cur = ""; trig = false; } continue; }
    if (s.endsWith(";")) { out.push(cur.trim()); cur = ""; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export type FaultHook = (sql: string) => void;

export function makeD1(fault?: { hook: FaultHook | null }) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of ["work/0001_foundation.sql", "work/0011_deadlines.sql", "pr61/0027.sql"]) {
    for (const st of split(readFileSync(`${BASE}/${f}`, "utf8"))) db.exec(st);
  }
  const plain = (r: any) => r == null ? r : Object.fromEntries(Object.entries(r));
  class Stmt {
    constructor(readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Stmt(this.sql, args); }
    exec() {
      fault?.hook?.(this.sql);
      const p = db.prepare(this.sql);
      if (/^\s*SELECT/i.test(this.sql)) return { results: p.all(...(this.args as any[])).map(plain), success: true, meta: { changes: 0 } };
      const r = p.run(...(this.args as any[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    }
    async first<T>() { const r = this.exec().results; return (r[0] ?? null) as T | null; }
    async all<T>() { return this.exec() as any; }
    async run() { return this.exec() as any; }
  }
  const d1: any = {
    prepare: (sql: string) => new Stmt(sql),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s.exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  return { db, d1 };
}

export function seedBase(db: DatabaseSync) {
  db.exec(`INSERT INTO principals VALUES ('principal-sid','human','active','Sid','v1','PIN_VERIFIER_JSON','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO deadline_sources (source_id,kind,label,active,created_at) VALUES ('google-classroom','classroom','Google Classroom',1,'2026-09-01T00:00:00.000Z')`);
}
let dl = 0;
export function addDeadline(db: DatabaseSync, externalId: string, title: string, dueAt: string, id?: string) {
  const deadlineId = id ?? `01k${String(++dl).padStart(23, "0")}`;
  db.prepare(`INSERT INTO deadlines (deadline_id,source_id,external_id,course,title,due_at,effort,lead_minutes,status,content_hash,first_seen_at,last_seen_at)
   VALUES (?,?,?,?,?,?,'other',60,'open',?,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`)
   .run(deadlineId, "google-classroom", externalId, "Calculus", title, dueAt, "a".repeat(64));
  return deadlineId;
}

export const DIGEST_MISSING_SQL_NOTE = "readDigestSnapshot is called directly from the real repository";
