import { applyD1Migrations, env } from "cloudflare:test";
import foundationSql from "../../src/persistence/migrations/0001_foundation.sql?raw";

let migrated: Promise<void> | undefined;

/** Applies the deployable Wrangler migration to the actual D1 test binding once. */
export function applyFoundationMigration(): Promise<void> {
  migrated ??= applyD1Migrations(env.DB, [{
    name: "0001_foundation.sql",
    queries: foundationSql.split(";").map((query) => query.trim()).filter(Boolean),
  }]);
  return migrated;
}
