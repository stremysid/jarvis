import { describe, expect, it } from "vitest";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "../../src/backup/memory-backup-restore-migrations.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: true; readonly import: "default"; readonly query: "?raw" },
    ): Record<string, string>;
  }
}

const migrationFiles = Object.keys(import.meta.glob(
  "../../src/persistence/migrations/*.sql",
  { eager: true, import: "default", query: "?raw" },
)).map((path) => {
  const name = path.split("/").at(-1);
  if (name === undefined) throw new Error(`migration name missing: ${path}`);
  return name;
}).sort((left, right) => Number.parseInt(left.slice(0, 4), 10) - Number.parseInt(right.slice(0, 4), 10));

describe("memory backup restore inventory", () => {
  it("registers every migration in order, so a restore can reach the newest schema", () => {
    // A migration that exists on disk but not here is the failure that only
    // shows up on the day someone needs the backup: the restore target stops
    // one schema short and every set taken after it is unrestorable.
    expect(MEMORY_BACKUP_RESTORE_MIGRATIONS.map((entry) => entry.name)).toEqual(migrationFiles);
  });
});
