import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "../../src/backup/memory-backup-restore-migrations.js";
import {
  allCloudGatewayMigrationNames,
  applyMemoryIngressMigration,
  applyNewestRuntimeMigration,
} from "./migration.js";

/**
 * One migration, five hand-kept lists.
 *
 * `0038` was added to `applyNewestRuntimeMigration` and to nothing else. It
 * passed its own tests and broke `memory-backup-restore.test.ts` nine ways: the
 * restart fixture rebuilt the restore target from `allCloudGatewayMigrations`,
 * which still ended at `0035`, so the target had no `memory_item_pins` and a
 * healthy backup failed as `memory_backup_operation_failed`. The operator's own
 * transcribed list was stale in the same way and reported
 * `memory_backup_restore_migrations_missing`.
 *
 * Two of the five lists already had a guard, and both fired correctly: the
 * `remote-d1-migration-syntax` inventory and the backup's own "classifies every
 * table declared by the migration files". The three that did not are the ones
 * that cost a session. This is the guard for those.
 *
 * It compares against what is actually on disk rather than against another
 * hardcoded list, so it cannot drift the way the thing it checks did.
 */
const onDisk = Object.keys(import.meta.glob("../../src/persistence/migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
})).map((path) => path.split("/").at(-1)!)
  .sort((left, right) => left.localeCompare(right));

describe("every migration on disk is known to every hand-kept list", () => {
  it("finds the migration files at all, so the guard cannot pass vacuously", () => {
    // A glob that stopped matching would make both assertions below trivially
    // true, which is the failure mode this whole file exists to prevent.
    expect(onDisk.length).toBeGreaterThan(30);
    expect(onDisk).toContain("0038_memory_lifetime_and_pins.sql");
  });

  it("lists exactly the migrations on disk for the restore operator", () => {
    const operatorNames = MEMORY_BACKUP_RESTORE_MIGRATIONS.map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));

    expect(operatorNames).toEqual(onDisk);
  });

  it("lists exactly the migrations on disk for the restart fixtures", () => {
    const fixtureNames = [...allCloudGatewayMigrationNames()]
      .sort((left, right) => left.localeCompare(right));

    expect(fixtureNames).toEqual(onDisk);
  });

  /**
   * The third registration place, and the one that hid 0038 twice.
   *
   * The apply chains are code rather than a list, so no textual comparison can
   * see whether one of them actually reaches the newest migration on disk. When
   * the memory fixtures stopped at 0019, an INSERT naming `lifetime` came back as
   * `memory_unavailable` from every commit -- which reads as a database fault,
   * not as a missing migration, and cost an hour of chasing the wrong layer.
   *
   * Asserting the applied SET contains the newest file on disk, rather than that
   * the last receipt equals it, because receipt order depends on which chain ran
   * first in this file and would make the guard order-sensitive for no gain.
   */
  async function appliedNames(): Promise<ReadonlySet<string>> {
    const rows = await env.DB.prepare("SELECT name FROM d1_migrations")
      .all<{ name: string }>();
    return new Set(rows.results.map(({ name }) => name));
  }

  it("applies the newest migration on disk through the terminal chain", async () => {
    await applyNewestRuntimeMigration();
    const applied = await appliedNames();

    expect(applied.has(onDisk.at(-1)!)).toBe(true);
    // And nothing phantom: every receipt names a file that exists.
    expect([...applied].filter((name) => !onDisk.includes(name))).toEqual([]);
  });

  it("applies the newest migration on disk through the memory fixture chain", async () => {
    // This is the chain the memory suites use, and the one that was stale. It is
    // separate from the terminal chain above because they are separate code
    // paths, and it was the memory path that broke.
    await applyMemoryIngressMigration();
    const applied = await appliedNames();

    expect(applied.has(onDisk.at(-1)!)).toBe(true);
  });
});
