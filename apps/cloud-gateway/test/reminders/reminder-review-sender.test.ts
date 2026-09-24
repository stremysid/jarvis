import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { OwnerReminderSender } from "../../src/reminders/reminder-sender.js";
import { TelegramRestProvider } from "../../src/providers/telegram-provider.js";
import { QuietWindowService } from "../../src/deadlines/quiet-windows.js";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { NOW, clock, resetReminders, seedReminder } from "./reminder-fixture.js";

function restProvider(fetchImplementation: typeof fetch) {
  return new TelegramRestProvider({ botToken: `12345:${"a".repeat(30)}`, fetchImplementation });
}

describe("reviewed reminder drain", () => {
  beforeEach(resetReminders);
  afterEach(() => vi.restoreAllMocks());

  it.each([401, 403])("reopens a received Telegram %s refusal and resends on the next run", async (status) => {
    const seeded = await seedReminder();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false }, { status }))
      .mockImplementation(async () => Response.json({ ok: true, result: { message_id: 321 } }));
    const sender = new OwnerReminderSender(env.DB, restProvider(request), seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "pending", attempts: 1 }]);
    expect(await sender.run()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "sent", attempts: 2 }]);
  });

  it("records a received Telegram 400 as rejected and never resends it", async () => {
    const seeded = await seedReminder();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: false }, { status: 400 }));
    const sender = new OwnerReminderSender(env.DB, restProvider(request), seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "rejected", sent_at: null, attempts: 1 }]);
    expect(await sender.run()).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 400])("does not overwrite a newer attempt after a Telegram %s refusal", async (status) => {
    const seeded = await seedReminder();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      await env.DB.prepare("UPDATE owner_reminders SET attempts = attempts + 1 WHERE id = ?").bind(seeded.reminder.id).run();
      return Response.json({ ok: false }, { status });
    });
    const sender = new OwnerReminderSender(env.DB, restProvider(request), seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "failed", attempts: 2 }]);
    expect(await sender.run()).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 400])("does not overwrite a changed dispatch status after a Telegram %s refusal", async (status) => {
    const seeded = await seedReminder();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      await env.DB.prepare("UPDATE owner_reminders SET status = 'cancelled' WHERE id = ?").bind(seeded.reminder.id).run();
      return Response.json({ ok: false }, { status });
    });
    await expect(new OwnerReminderSender(env.DB, restProvider(request), seeded.principalId, clock).run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "cancelled", attempts: 1 }]);
  });

  it.each(["network", "malformed success", "missing success marker", "server error"])("keeps the uncertain fence after a %s", async (outcome) => {
    const seeded = await seedReminder();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (outcome === "network") throw new Error("network unavailable");
      if (outcome === "malformed success") return new Response("not JSON", { status: 200 });
      if (outcome === "missing success marker") return Response.json({ result: { message_id: 321 } });
      return Response.json({ ok: false }, { status: 503 });
    });
    const sender = new OwnerReminderSender(env.DB, restProvider(request), seeded.principalId, clock);
    await expect(sender.run()).rejects.toThrow("owner_reminder_delivery_unconfirmed");
    expect(await sender.run()).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await new OwnerReminderRepository(env.DB).list(seeded.principalId)).toMatchObject([{ status: "failed", attempts: 1 }]);
  });

  it("drains fifteen due reminders as ten then five without stranding any behind the fence", async () => {
    const seeded = await seedReminder();
    const repo = new OwnerReminderRepository(env.DB);
    for (let i = 1; i < 15; i++) await repo.schedule(seeded.principalId, seeded.turnId, NOW.toISOString(), `Study ${i}.`);
    const identity = vi.spyOn(DeviceRepository.prototype, "findOwnerTelegramChat");
    const quiet = vi.spyOn(QuietWindowService.prototype, "isSuppressed");
    const sendMessage = vi.fn(async () => ({ providerMessageId: "321" }));
    const sender = new OwnerReminderSender(env.DB, { sendMessage }, seeded.principalId, clock);
    expect(await sender.run()).toBe(10);
    expect(await repo.list(seeded.principalId)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "pending", attempts: 0 })]));
    expect(identity).toHaveBeenCalledTimes(1);
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(await sender.run()).toBe(5);
    expect(await repo.list(seeded.principalId)).toHaveLength(15);
    expect((await repo.list(seeded.principalId)).every(row => row.status === "sent" && row.attempts === 1)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(15);
    expect(identity).toHaveBeenCalledTimes(2);
    expect(quiet).toHaveBeenCalledTimes(2);
  });

  it("does not require a Telegram identity when there are no due rows", async () => {
    const identity = vi.spyOn(DeviceRepository.prototype, "findOwnerTelegramChat").mockResolvedValue(null);
    expect(await new OwnerReminderSender(env.DB, { sendMessage: vi.fn() }, "principal:empty", clock).run()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });

  it("requires a dispatch attempt before a reminder can be marked rejected", async () => {
    const seeded = await seedReminder();
    await expect(env.DB.prepare("UPDATE owner_reminders SET status = 'rejected' WHERE id = ?").bind(seeded.reminder.id).run()).rejects.toThrow();
  });
});
