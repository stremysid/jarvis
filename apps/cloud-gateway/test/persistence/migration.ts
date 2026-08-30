import { applyD1Migrations, env } from "cloudflare:test";
import foundationSql from "../../src/persistence/migrations/0001_foundation.sql?raw";

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
  migrated ??= applyD1Migrations(env.DB, [{
    name: "0001_foundation.sql",
    queries: splitMigration(foundationSql),
  }]);
  return migrated;
}
