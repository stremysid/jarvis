import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import { QuietWindowService } from "../deadlines/quiet-windows.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import { snapshotProviderFailure, type TelegramProvider, type TelegramSendMessageResult } from "../providers/provider-types.js";
import type { OwnerReminder } from "./owner-reminders.js";

/** Runs inside the guest-notice drain lease, with a per-row dispatch fence as well. */
export class OwnerReminderSender {
  constructor(private readonly database: D1Database,
    private readonly telegram: Pick<TelegramProvider, "sendMessage">,
    private readonly principal: string,
    private readonly clock: { now(): Date }) {}

  async run(): Promise<number> {
    const at = this.clock.now().toISOString();
    const rows = await this.database.prepare(`SELECT * FROM owner_reminders
      WHERE principal = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at, id`)
      .bind(this.principal, at).all<OwnerReminder>();
    const quiet = new QuietWindowService({ repository: new DeadlineRepository(this.database) });
    let sent = 0;
    for (const row of rows.results) {
      if (await quiet.isSuppressed(this.clock.now(), "deadline_reminder")) continue;
      const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(this.principal);
      if (chatId === null) throw new Error("owner_reminder_identity_unavailable");
      // Persist the fence before the request: a crash, expired outer lease or
      // lost acknowledgement must never make an uncertain send eligible again.
      const claimed = await this.database.prepare(`UPDATE owner_reminders
        SET status = 'failed', attempts = attempts + 1
        WHERE id = ? AND principal = ? AND status = 'pending'
        RETURNING attempts`).bind(row.id, this.principal).first<{ attempts: number }>();
      if (claimed === null) continue;
      let result: TelegramSendMessageResult;
      try {
        result = await this.telegram.sendMessage({ chatId, text: row.text, idempotencyKey: `owner-reminder:${row.id}` });
      } catch (error) {
        // Only an explicit rate-limit refusal proves Telegram did not accept
        // the message. Timeouts and post-send D1 failures retain the fence.
        if (snapshotProviderFailure(error)?.category === "rate_limited") {
          await this.database.prepare(`UPDATE owner_reminders SET status = 'pending'
            WHERE id = ? AND principal = ? AND status = 'failed' AND attempts = ?`)
            .bind(row.id, this.principal, claimed.attempts).run();
        }
        throw new Error("owner_reminder_delivery_unconfirmed");
      }
      if (!/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) throw new Error("owner_reminder_delivery_unconfirmed");
      const recorded = await this.database.prepare(`UPDATE owner_reminders SET status = 'sent', sent_at = ?
        WHERE id = ? AND principal = ? AND status = 'failed' AND attempts = ?`)
        .bind(this.clock.now().toISOString(), row.id, this.principal, claimed.attempts).run();
      if (recorded.meta.changes !== 1) throw new Error("owner_reminder_delivery_unconfirmed");
      sent += 1;
    }
    return sent;
  }
}
