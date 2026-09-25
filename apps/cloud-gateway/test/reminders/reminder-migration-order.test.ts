import { describe, expect, it } from "vitest";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "../../src/backup/memory-backup-restore-migrations.js";
import { allCloudGatewayMigrationNames } from "../persistence/migration.js";

describe("reminder migration registration order", () => {
  it("keeps the restore operator and restart fixtures in filename order", () => {
    const restore = MEMORY_BACKUP_RESTORE_MIGRATIONS.map(({ name }) => name);
    const fixtures = [...allCloudGatewayMigrationNames()];
    expect(restore).toEqual([...restore].sort());
    expect(fixtures).toEqual([...fixtures].sort());
    expect(restore.indexOf("0039_tool_confirmation_consumptions.sql"))
      .toBeLessThan(restore.indexOf("0050_owner_reminders.sql"));
  });
});
