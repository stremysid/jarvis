import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { OwnerReminderSender } from "../../src/reminders/reminder-sender.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { VOICE_NOW, voiceArgumentTurn } from "../channels/voice-argument-fixture.js";
import { reminderCall, resetReminders } from "./reminder-fixture.js";

// Sid's rule: a call and Telegram differ only in the medium. Scheduling, listing
// and cancelling reminders therefore work from a call exactly as from Telegram;
// only delivery is a Telegram message, which the receipt says out loud.
const reminders = (principalId: string) => new OwnerReminderRepository(env.DB).list(principalId);

async function addVerifiedTelegramChat(principalId: string, subject: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO channel_identities
    (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
    VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`)
    .bind(`identity:voice-reminder:${subject}`, principalId, subject, VOICE_NOW.toISOString(), VOICE_NOW.toISOString()).run();
}

describe("reminder voice parity", () => {
  beforeEach(resetReminders);

  it("offers the same reminder tools on a call as the shared owner catalogue", async () => {
    const turn = await voiceArgumentTurn("What reminders do I have?", reminderCall("reminder_list"));
    for (const name of ["reminder_schedule", "reminder_list", "reminder_cancel"]) {
      expect(turn.requests[0]?.tools.find(tool => tool.name === name))
        .toEqual(OWNER_TOOL_DEFINITIONS.find(tool => tool.name === name));
    }
  });

  it("schedules a reminder from a verified owner call, speaks a Telegram delivery receipt, and the drain sends it once", async () => {
    const at = "2026-09-23T23:00:00.000Z";
    const turn = await voiceArgumentTurn("Remind me at seven tonight to start chemistry.",
      reminderCall("reminder_schedule", { at, text: "Start chemistry." }));
    expect(turn.result.outcome).toBe("voice_sent");
    expect(await reminders(turn.principalId)).toMatchObject([{ due_at: at, text: "Start chemistry.", status: "pending" }]);
    const receipt = JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}") as { status?: string; receipt?: string };
    expect(receipt.status).toBe("completed");
    expect(receipt.receipt).toContain("7:00:00 p.m. EDT");
    expect(receipt.receipt).toContain("America/Toronto");
    expect(receipt.receipt).toContain("Telegram message");

    await addVerifiedTelegramChat(turn.principalId, "7123456789");
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    const later = { now: () => new Date("2026-09-23T23:05:00.000Z") };
    const sender = new OwnerReminderSender(env.DB, { sendMessage }, turn.principalId, later);
    expect(await sender.run()).toBe(1);
    expect(await sender.run()).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "7123456789", text: "Start chemistry." }));
    expect(await reminders(turn.principalId)).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("lists and cancels a pending reminder from a verified owner call", async () => {
    let reminderId = "";
    const listed = await voiceArgumentTurn("What reminders do I have?", async (input) => {
      reminderId = (await new OwnerReminderRepository(env.DB)
        .schedule(input.principalId, input.correlationId, "2026-09-24T12:00:00.000Z", "Review derivatives.")).id;
      return reminderCall("reminder_list");
    });
    const listing = JSON.parse(listed.requests[1]?.toolResults?.[0]?.content ?? "{}") as { receipt?: string };
    expect(listing.receipt).toContain(reminderId);
    expect(listing.receipt).toContain("Review derivatives.");

    const cancelled = await voiceArgumentTurn("Cancel the derivatives reminder.", async (input) => {
      reminderId = (await new OwnerReminderRepository(env.DB)
        .schedule(input.principalId, input.correlationId, "2026-09-24T12:00:00.000Z", "Review derivatives.")).id;
      return reminderCall("reminder_cancel", { id: reminderId });
    });
    const cancellation = JSON.parse(cancelled.requests[1]?.toolResults?.[0]?.content ?? "{}") as { receipt?: string };
    expect(cancellation.receipt).toContain(`Cancelled reminder ${reminderId}.`);
    expect(await reminders(cancelled.principalId)).toMatchObject([{ id: reminderId, status: "cancelled" }]);
  });

  it.each([{ direct: false }, { wrongOwner: true }])("refuses a voice reminder without owner authority %j and writes no row", async (change) => {
    const turn = await voiceArgumentTurn("Remind me to study.",
      reminderCall("reminder_schedule", { at: VOICE_NOW.toISOString(), text: "Study." }), change);
    expect(JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    expect(await reminders(turn.principalId)).toEqual([]);
  });

  it("refuses a voice reminder when the shared argument tier gate fails", async () => {
    const gate = await testToolGate(env.DB);
    const turn = await voiceArgumentTurn("Remind me to study.",
      reminderCall("reminder_schedule", { at: VOICE_NOW.toISOString(), text: "Study." }),
      { gate: { ...gate, evaluateToolCall: async () => { throw new Error("tier_refused"); } } });
    expect(await reminders(turn.principalId)).toEqual([]);
  });
});
