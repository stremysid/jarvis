import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { executeReminderTool } from "../../src/reminders/reminder-tools.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { argumentTurn, NOW, reminderCall, resetReminders, seedReminder } from "./reminder-fixture.js";

describe("owner reminder tools", () => {
  beforeEach(resetReminders);

  it("stores the model selected time and exact words through the owner agent", async () => {
    const at = "2026-09-23T21:17:00.000Z";
    const text = "Try three practice problems, then take a break.";
    const seeded = await seedReminder(at, text);
    expect(seeded.reminder).toMatchObject({ principal: seeded.principalId, created_turn_id: seeded.turnId,
      due_at: at, text, status: "pending", attempts: 0, sent_at: null });
    expect(seeded.replies.join(" ")).toContain(text);
    expect(seeded.replies.join(" ")).toContain(at);
  });

  it("deduplicates exact replay while keeping distinct reminders chosen in the same turn", async () => {
    const seeded = await seedReminder();
    const repo = new OwnerReminderRepository(env.DB);
    const replay = await repo.schedule(seeded.principalId, seeded.turnId, seeded.reminder.due_at, seeded.reminder.text);
    expect(replay).toEqual(seeded.reminder);
    expect(await repo.list(seeded.principalId)).toHaveLength(1);
    const second = await repo.schedule(seeded.principalId, seeded.turnId, "2026-09-24T12:00:00.000Z", seeded.reminder.text);
    expect(second).toMatchObject({ due_at: "2026-09-24T12:00:00.000Z", text: seeded.reminder.text });
    const third = await repo.schedule(seeded.principalId, seeded.turnId, seeded.reminder.due_at, "Zebra practice next.");
    expect(third).toMatchObject({ due_at: seeded.reminder.due_at, text: "Zebra practice next." });
    expect(await repo.list(seeded.principalId)).toHaveLength(3);
  });

  it("refuses a scheduling receipt when the committed row cannot be read back", async () => {
    const seeded = await seedReminder();
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => sql.startsWith("SELECT * FROM owner_reminders WHERE principal = ? AND created_turn_id")
          ? { bind: () => ({ first: async () => null }) } : target.prepare(sql);
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(new OwnerReminderRepository(database).schedule(seeded.principalId, seeded.turnId, NOW.toISOString(), "Hello"))
      .rejects.toThrow("owner_reminder_write_unconfirmed");
  });

  it("lists only the current owner's reminders and excludes internal provenance", async () => {
    const other = await seedReminder();
    const result = await argumentTurn("What reminders do I have?", async (input) => {
      await new OwnerReminderRepository(env.DB).schedule(input.principalId, input.correlationId, NOW.toISOString(), "My reminder");
      return reminderCall("reminder_list");
    });
    expect(result.replies.join(" ")).toContain("My reminder");
    expect(result.replies.join(" ")).not.toContain(other.reminder.id);
    expect(result.replies.join(" ")).not.toContain("created_turn_id");
  });

  it("cancels a pending reminder through the argument tool hook", async () => {
    const result = await argumentTurn("Cancel that reminder.", async (input) => {
      const row = await new OwnerReminderRepository(env.DB).schedule(input.principalId, input.correlationId, NOW.toISOString(), "Cancel me");
      return reminderCall("reminder_cancel", { id: row.id });
    });
    expect(result.replies.join(" ")).toContain("Cancelled reminder");
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toMatchObject([{ status: "cancelled" }]);
  });

  it("does not cancel another principal's reminder", async () => {
    const seeded = await seedReminder();
    const result = await argumentTurn("Cancel it.", reminderCall("reminder_cancel", { id: seeded.reminder.id }));
    expect(result.replies.join(" ")).toContain("No pending reminder");
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]?.status).toBe("pending");
  });

  it("does not claim cancellation once dispatch has begun", async () => {
    const seeded = await seedReminder();
    await env.DB.prepare("UPDATE owner_reminders SET status = 'failed', attempts = 1 WHERE id = ?").bind(seeded.reminder.id).run();
    expect(await new OwnerReminderRepository(env.DB).cancel(seeded.principalId, seeded.reminder.id)).toBe(false);
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]?.status).toBe("failed");
  });

  it.each([
    ["an invented argument", { at: NOW.toISOString(), text: "Hello", channel: "email" }],
    ["an invalid instant", { at: "tomorrow", text: "Hello" }],
    ["an invalid calendar date", { at: "2026-02-30T00:00:00.000Z", text: "Hello" }],
    ["empty text", { at: NOW.toISOString(), text: "" }],
  ])("refuses %s without creating a reminder", async (_name, args) => {
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", args));
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toHaveLength(0);
  });

  it("refuses a forwarded scheduling request even with a forged durable direct marker", async () => {
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at: NOW.toISOString(), text: "Hello" }),
      { direct: false, durableDirect: true });
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toHaveLength(0);
  });

  it("refuses an unknown reminder tool rather than choosing an operation", async () => {
    await expect(executeReminderTool(env.DB, { principalId: "test" } as ModelAdapterStreamInput,
      reminderCall("reminder_unknown"), NOW, "America/Toronto")).rejects.toThrow("owner_reminder_tool_unknown");
  });
});
