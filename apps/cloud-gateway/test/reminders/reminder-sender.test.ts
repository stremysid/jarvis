import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerReminderSender } from "../../src/reminders/reminder-sender.js";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { D1GuestGrantNoticeDrainer } from "../../src/jobs/guest-grant-notice-drain.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { NOW, clock, resetReminders, seedReminder } from "./reminder-fixture.js";

describe("owner reminder delivery", () => {
  beforeEach(resetReminders);
  afterEach(() => vi.restoreAllMocks());

  it("sends once across two overlapping leased drains and a later drain", async () => {
    const seeded = await seedReminder();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sendMessage = vi.fn(async () => { entered.resolve(); await release.promise; return { providerMessageId: "321" }; });
    const sender = new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock);
    const drain = () => new D1GuestGrantNoticeDrainer(env.DB, { notify: async () => {} }, clock, async () => { await sender.run(); }).run();
    const first = drain();
    await entered.promise;
    expect(await drain()).toBe("already_running");
    release.resolve();
    expect(await first).toBe("completed");
    expect(await drain()).toBe("completed");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const identity = await new DeviceRepository(env.DB).findOwnerTelegramChat(seeded.principalId);
    expect(sendMessage).toHaveBeenCalledWith({ chatId: identity, text: seeded.reminder.text, idempotencyKey: `owner-reminder:${seeded.reminder.id}` });
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0])
      .toMatchObject({ status: "sent", attempts: 1, sent_at: NOW.toISOString() });
  });

  it("uses the row fence when two senders have already selected the same reminder", async () => {
    const seeded = await seedReminder();
    const both = Promise.withResolvers<void>();
    let readers = 0;
    const original = DeviceRepository.prototype.findOwnerTelegramChat;
    vi.spyOn(DeviceRepository.prototype, "findOwnerTelegramChat").mockImplementation(async function (this: DeviceRepository, principal) {
      const chat = await original.call(this, principal);
      if (++readers === 2) both.resolve();
      await both.promise;
      return chat;
    });
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    const sender = () => new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run();
    expect(await Promise.all([sender(), sender()])).toContain(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never sends a cancelled reminder", async () => {
    const seeded = await seedReminder();
    expect(await new OwnerReminderRepository(env.DB).cancel(seeded.principalId, seeded.reminder.id)).toBe(true);
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never sends when cancellation wins after the due row was selected", async () => {
    const seeded = await seedReminder();
    const original = DeviceRepository.prototype.findOwnerTelegramChat;
    vi.spyOn(DeviceRepository.prototype, "findOwnerTelegramChat").mockImplementation(async function (this: DeviceRepository, principal) {
      await new OwnerReminderRepository(env.DB).cancel(principal, seeded.reminder.id);
      return original.call(this, principal);
    });
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a future reminder early", async () => {
    const seeded = await seedReminder("2026-09-23T14:00:00.001Z");
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends only the configured owner's reminders", async () => {
    const other = await seedReminder();
    const owner = await seedReminder();
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, owner.principalId, clock).run()).toBe(1);
    expect((await new OwnerReminderRepository(env.DB).list(other.principalId))[0]?.status).toBe("pending");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a reminder pending during a quiet window and sends the exact text at its end", async () => {
    const seeded = await seedReminder();
    await new DeadlineRepository(env.DB).createQuietWindow({ reason: "manual", startsAt: NOW,
      endsAt: "2026-09-23T14:05:00.000Z", now: NOW });
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run()).toBe(0);
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId,
      { now: () => new Date("2026-09-23T14:05:00.000Z") }).run()).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: seeded.reminder.text }));
  });

  it("leaves the reminder retryable when the owner has no verified Telegram identity", async () => {
    const seeded = await seedReminder();
    await env.DB.prepare("UPDATE channel_identities SET status = 'pending', verified_at = NULL WHERE principal_id = ?").bind(seeded.principalId).run();
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    await expect(new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run()).rejects.toThrow("owner_reminder_identity_unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("retries an explicit rate limit through the existing drain retry state", async () => {
    const seeded = await seedReminder();
    const sendMessage = vi.fn().mockRejectedValueOnce(ProviderFailure.transient("rate_limited"))
      .mockResolvedValue({ providerMessageId: "321" });
    const drain = () => new D1GuestGrantNoticeDrainer(env.DB, { notify: async () => {} }, clock,
      async () => { await new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock).run(); }).run();
    await expect(drain()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(await drain()).toBe("completed");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it.each([
    ["a timeout", ProviderFailure.transient("timeout")],
    ["a malformed success", null],
    ["an unbranded rate limit error", Object.assign(new Error("untrusted"), { category: "rate_limited" })],
  ])("does not retry %s because delivery may already have happened", async (_label, error) => {
    const seeded = await seedReminder();
    const sendMessage = vi.fn(async () => { if (error !== null) throw error; return { providerMessageId: "unknown" }; });
    const sender = new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await sender.run()).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "failed", attempts: 1, sent_at: null });
  });

  it.each([
    ["attempt count", "attempts = attempts + 1"],
    ["status", "status = 'cancelled'"],
  ])("does not resend or claim a receipt after the dispatch %s changes", async (_label, change) => {
    const seeded = await seedReminder();
    const sendMessage = vi.fn(async () => {
      await env.DB.prepare(`UPDATE owner_reminders SET ${change} WHERE id = ?`).bind(seeded.reminder.id).run();
      return { providerMessageId: "321" };
    });
    const sender = new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await sender.run()).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
