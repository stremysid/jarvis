import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { argumentTurn, NOW, reminderCall, resetReminders } from "./reminder-fixture.js";

beforeEach(resetReminders);

it("refuses a reminder when the argument tool tier gate fails after owner proof", async () => {
  const result = await argumentTurn("Remind me to review chemistry.", reminderCall("reminder_schedule", {
    at: NOW.toISOString(), text: "Review chemistry.",
  }), { gate: { async evaluateToolCall() { throw new Error("denied"); } } });
  expect(result.result.outcome).toBe("telegram_delivered");
  expect(await new OwnerReminderRepository(env.DB).list(result.principalId)).toHaveLength(0);
});
