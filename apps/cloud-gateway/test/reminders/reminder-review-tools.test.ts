import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { argumentTurn, NOW, reminderCall, resetReminders } from "./reminder-fixture.js";

describe("reviewed reminder scheduling", () => {
  beforeEach(resetReminders);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["a 2020 instant", "2020-01-01T00:00:00.000Z", "owner_reminder_at_past"],
    ["one millisecond beyond the past grace", "2026-09-23T13:54:59.999Z", "owner_reminder_at_past"],
  ])("refuses %s with a specific reason and no stored reminder", async (_label, at, reason) => {
    const result = await argumentTurn("Remind me to study.", reminderCall("reminder_schedule", { at, text: "Study." }));
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toEqual([]);
    expect(JSON.stringify(result.requests[1])).toContain(reason);
  });

  it.each([-5 * 60_000, 400 * 86_400_000 + 1])("accepts the inclusive scheduling boundary at offset %s", async (offset) => {
    const at = new Date(NOW.getTime() + offset).toISOString();
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at, text: "Study." }));
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toMatchObject([{ due_at: at }]);
  });

  it("stores a year 9999 reminder as pending because how far ahead to remind is the model's choice", async () => {
    const at = "9999-01-01T00:00:00.000Z";
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at, text: "Study." }));
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toMatchObject([{ due_at: at, status: "pending" }]);
    expect(JSON.stringify(result.requests[1])).not.toContain("owner_reminder_at_too_far");
  });

  it("uses the processing clock for reminder bounds and tells the model both clocks and the configured zone", async () => {
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at: NOW.toISOString(), text: "Study." }),
      { messageAt: NOW, processingAt: new Date("2026-09-23T15:00:00.000Z"), timeZone: "America/Vancouver" });
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toEqual([]);
    const request = JSON.stringify(result.requests[0]);
    expect(request).toContain("Current instant: 2026-09-23T15:00:00.000Z");
    expect(request).toContain("Message arrival: 2026-09-23T14:00:00.000Z");
    expect(request).toContain("Owner time zone: America/Vancouver");
  });

  it.each([
    ["2026-11-01T05:30:00.000Z", "EDT"],
    ["2026-11-01T06:30:00.000Z", "EST"],
  ])("renders the Toronto repeated hour at %s with its correct offset name and UTC instant", async (at, zoneName) => {
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at, text: "Study." }));
    expect(result.replies.join(" ")).toContain("1:30:00 a.m.");
    expect(result.replies.join(" ")).toContain(zoneName);
    expect(result.replies.join(" ")).toContain("America/Toronto");
    expect(result.replies.join(" ")).toContain(at);
  });

  it("renders the receipt in the adapter's configured owner zone", async () => {
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at: NOW.toISOString(), text: "Study." }),
      { timeZone: "America/Vancouver" });
    expect(result.replies.join(" ")).toContain("7:00:00 a.m. PDT");
    expect(result.replies.join(" ")).toContain("America/Vancouver");
  });

  it.each(["missing", "throwing"])("reports that a reminder may have been saved after a %s read-back", async (mode) => {
    const original = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT * FROM owner_reminders WHERE principal = ? AND created_turn_id")) {
        return { bind: () => ({ first: async () => { if (mode === "throwing") throw new Error("read unavailable"); return null; } }) } as unknown as D1PreparedStatement;
      }
      return original(sql);
    });
    const result = await argumentTurn("Remind me.", reminderCall("reminder_schedule", { at: NOW.toISOString(), text: "Study." }));
    spy.mockRestore();
    expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toHaveLength(1);
    const reply = JSON.stringify(result.requests[1]);
    expect(reply).toContain("may have been saved");
    expect(reply).toContain("reminder_list");
    expect(reply.toLowerCase()).not.toContain("nothing changed");
  });

  it("describes a rejected reminder as not delivered in the list receipt", async () => {
    const result = await argumentTurn("List reminders.", async (input) => {
      const row = await new OwnerReminderRepository(env.DB).schedule(input.principalId, input.correlationId, NOW.toISOString(), "Study.");
      await env.DB.prepare("UPDATE owner_reminders SET status = 'rejected', attempts = 1 WHERE id = ?").bind(row.id).run();
      return reminderCall("reminder_list");
    });
    expect(result.replies.join(" ")).toContain("not delivered");
    expect(result.replies.join(" ")).toContain("rejected");
  });
});
