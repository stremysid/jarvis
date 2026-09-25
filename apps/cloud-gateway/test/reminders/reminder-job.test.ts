import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { buildJobTable } from "../../src/jobs/job-table.js";
import { OwnerReminderRepository } from "../../src/reminders/owner-reminders.js";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { clock, resetReminders, seedReminder } from "./reminder-fixture.js";

describe("five-minute reminder job", () => {
  beforeEach(resetReminders);

  function drain(principal: string, fetcher: typeof fetch, configured = true) {
    const overrides: Partial<Env> = { OWNER_PRINCIPAL_ID: principal, TELEGRAM_BOT_TOKEN: configured ? `00000:${"synthetic".repeat(4)}` : undefined };
    const bindings = new Proxy(env as Env, { get(target, property, receiver) {
      return Object.hasOwn(overrides, property) ? Reflect.get(overrides, property) : Reflect.get(target, property, receiver);
    } });
    return buildJobTable({ env: bindings, clock, fetcher, delivery: { send: async () => {} } }).drain!;
  }

  it("delivers the stored words to the verified owner through the production drain wiring once", async () => {
    const seeded = await seedReminder();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { message_id: 321 } }));
    const run = drain(seeded.principalId, fetcher);
    expect(await run()).toEqual({ ok: true, detail: expect.stringContaining("1 owner reminders sent") });
    expect(await run()).toMatchObject({ ok: true, detail: expect.stringContaining("0 owner reminders sent") });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({
      chat_id: await new DeviceRepository(env.DB).findOwnerTelegramChat(seeded.principalId), text: seeded.reminder.text,
    });
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]?.status).toBe("sent");
  });

  it("retains due reminders while the Telegram delivery configuration is absent", async () => {
    const seeded = await seedReminder();
    const fetcher = vi.fn<typeof fetch>();
    expect(await drain(seeded.principalId, fetcher, false)()).toMatchObject({ ok: true, degraded: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await new OwnerReminderRepository(env.DB).list(seeded.principalId))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});
