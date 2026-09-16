import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function splitMigration(sql) {
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

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  exec() {
    const s = this.db.prepare(this.sql);
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) return { rows: s.all(...this.params) };
    const r = s.run(...this.params); return { rows: [], changes: r.changes };
  }
  async all() { return { results: this.exec().rows, success: true, meta: {} }; }
  async run() { const r = this.exec(); return { results: r.rows, success: true, meta: { changes: r.changes ?? 0 } }; }
  async first(col) { const row = this.exec().rows[0] ?? null; return row === null ? null : col ? row[col] : row; }
}

export class D1 {
  constructor(path = ":memory:") { this.db = new DatabaseSync(path); this.db.exec("PRAGMA foreign_keys = ON"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(statements) {
    this.db.exec("SAVEPOINT batch");
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("RELEASE batch");
      return out;
    } catch (e) { this.db.exec("ROLLBACK TO batch"); this.db.exec("RELEASE batch"); throw e; }
  }
  async exec(sql) { this.db.exec(sql); }
}

export function migrate(d1, dir, names) {
  for (const name of names) {
    const sql = readFileSync(join(dir, name), "utf8");
    for (const q of splitMigration(sql)) {
      try { d1.db.exec(q); } catch (e) { throw new Error(`${name}: ${e.message}\n${q.slice(0, 200)}`); }
    }
  }
}

export function allMigrations(dir) {
  return readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
}
