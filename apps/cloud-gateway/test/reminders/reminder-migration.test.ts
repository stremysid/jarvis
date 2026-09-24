import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { MEMORY_BACKUP_RESTORE_MIGRATIONS } from "../../src/backup/memory-backup-restore-migrations.js";
import { MEMORY_BACKUP_TABLES } from "../../src/backup/memory-backup.js";
import { resetReminders, seedReminder } from "./reminder-fixture.js";

describe("owner reminder migration", () => {
  beforeEach(resetReminders);

  it.each([
    ["an invalid due timestamp", "due_at = 'tomorrow'"],
    ["empty message text", "text = ''"],
    ["message text beyond Telegram's limit", "text = replace(hex(zeroblob(2049)), '0', 'a')"],
    ["an unknown status", "status = 'delivering'"],
    ["an invalid sent timestamp", "status = 'sent', sent_at = 'yesterday', attempts = 1"],
    ["negative attempts", "attempts = -1"],
    ["fractional attempts", "attempts = 1.5"],
    ["sent without its receipt timestamp", "status = 'sent', attempts = 1"],
    ["a pending row with a receipt timestamp", "sent_at = '2026-09-23T14:00:00.000Z'"],
    ["a dispatch fence with no attempt", "status = 'failed'"],
  ])("rejects %s at the database boundary", async (_label, update) => {
    const seeded = await seedReminder();
    await expect(env.DB.prepare(`UPDATE owner_reminders SET ${update} WHERE id = ?`).bind(seeded.reminder.id).run())
      .rejects.toThrow("CHECK constraint failed");
  });

  it("rejects a duplicate reminder with the same owner turn and exact arguments", async () => {
    const seeded = await seedReminder();
    await expect(env.DB.prepare(`INSERT INTO owner_reminders SELECT ?, principal, due_at, text, status,
      created_turn_id, sent_at, attempts FROM owner_reminders WHERE id = ?`)
      .bind(newUlid(), seeded.reminder.id).run()).rejects.toThrow("UNIQUE constraint failed");
  });

  it("rejects a real conversation turn belonging to another principal", async () => {
    const seeded = await seedReminder();
    const other = await seedReminder();
    await expect(env.DB.prepare(`INSERT INTO owner_reminders SELECT ?, ?, due_at, text, status,
      created_turn_id, sent_at, attempts FROM owner_reminders WHERE id = ?`)
      .bind(newUlid(), other.principalId, seeded.reminder.id).run()).rejects.toThrow("owner_reminder_turn_mismatch");
  });

  it("includes reminders in the backup inventory after their conversation turns", () => {
    expect(MEMORY_BACKUP_TABLES).toContain("owner_reminders");
    expect(MEMORY_BACKUP_TABLES.indexOf("owner_reminders")).toBeGreaterThan(MEMORY_BACKUP_TABLES.indexOf("conversation_turns"));
    expect(MEMORY_BACKUP_RESTORE_MIGRATIONS.find((migration) => migration.name === "0041_owner_reminders.sql")?.sql)
      .toContain("CREATE TABLE owner_reminders");
  });
});
