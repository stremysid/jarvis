import { env } from "cloudflare:test";
import { expect } from "vitest";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";
import { applyNewestRuntimeMigration, clearGuestGrantNoticeDrainStateForTest } from "../persistence/migration.js";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";

export { NOW, argumentTurn };
export const clock = { now: () => new Date(NOW) };
export const reminderCall = (name: string, args: unknown = {}) => ({ id: "reminder-call", name, arguments: JSON.stringify(args) });
export async function resetReminders() {
  await applyNewestRuntimeMigration();
  await env.DB.prepare("DELETE FROM owner_reminders").run();
  await env.DB.prepare("DELETE FROM quiet_windows").run();
  await clearGuestGrantNoticeDrainStateForTest();
}
export async function seedReminder(at = NOW.toISOString(), text = "Open your chemistry notes.") {
  const turn = await argumentTurn("Help me start my chemistry review.", reminderCall("reminder_schedule", { at, text }));
  expect(turn.result.outcome).toBe("telegram_delivered");
  const rows = await new OwnerReminderRepository(env.DB).list(turn.principalId);
  expect(rows).toHaveLength(1);
  return { ...turn, reminder: rows[0]! };
}
