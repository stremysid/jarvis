import { newUlid } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { TelegramProvider, TelegramSendMessageResult } from "../providers/provider-types.js";
import type { CapacityAlert, CapacityAlertSink } from "./capacity-guard.js";

interface SinkOptions {
  database: D1Database;
  ownerPrincipalId: string;
  telegram: TelegramProvider;
  now: () => Date;
}

function unavailable(): Error { return new Error("capacity_alert_unavailable"); }
function key(value: string): string {
  if (!/^capacity:(?:(?:d1|r2|provider:[a-z0-9][a-z0-9_-]{0,63}):(?:70|85)|provider:model:remaining-1-usd)$/u.test(value)) {
    throw unavailable();
  }
  return value;
}

function rearmableKey(value: string): string {
  if (!/^capacity:(?:d1|r2|provider:(?!model:)[a-z0-9][a-z0-9_-]{0,63}):(?:70|85)$/u.test(value)) throw unavailable();
  return value;
}

/** Durable crossing receipts through the existing owner Telegram channel. */
export class D1CapacityAlertSink implements CapacityAlertSink {
  private readonly database: D1Database;
  private readonly owner: string;
  private readonly telegram: TelegramProvider;
  private readonly now: () => Date;

  constructor(options: SinkOptions) {
    if (typeof options.ownerPrincipalId !== "string" || options.ownerPrincipalId.length === 0
      || options.ownerPrincipalId.length > 256) throw new TypeError("capacity_configuration_invalid");
    this.database = options.database;
    this.owner = options.ownerPrincipalId;
    this.telegram = Object.freeze({ sendMessage: options.telegram.sendMessage.bind(options.telegram) });
    this.now = options.now;
  }

  async emit(alert: CapacityAlert): Promise<void> {
    const alertKey = key(alert.idempotencyKey);
    const balanceNotice = alert.resource === "provider:model"
      && alert.threshold === "remaining_1_usd"
      && alert.code === "deepseek_balance_1_usd"
      && alertKey === "capacity:provider:model:remaining-1-usd";
    const percentageNotice = typeof alert.threshold === "number"
      && alert.resource !== "provider:model"
      && alertKey === `capacity:${alert.resource}:${alert.threshold}`
      && alert.code === `capacity_${alert.threshold}`;
    if (!balanceNotice && !percentageNotice) throw unavailable();
    const now = this.now();
    const claimedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    const claimId = newUlid();
    const claim = await this.database.prepare(`INSERT INTO capacity_alert_crossings
      (owner_principal_id, alert_key, claim_id, state, claimed_at, lease_expires_at, sent_at)
      VALUES (?1, ?2, ?3, 'sending', ?4, ?5, NULL)
      ON CONFLICT(owner_principal_id, alert_key) DO UPDATE SET
        claim_id = excluded.claim_id, state = 'sending', claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at, sent_at = NULL
      WHERE capacity_alert_crossings.state = 'sending' AND capacity_alert_crossings.lease_expires_at <= ?4
      RETURNING claim_id`).bind(this.owner, alertKey, claimId, claimedAt, expiresAt).first<{ claim_id: string }>();
    if (claim === null) {
      const current = await this.database.prepare(`SELECT state FROM capacity_alert_crossings
        WHERE owner_principal_id = ? AND alert_key = ?`).bind(this.owner, alertKey).first<{ state: string }>();
      if (current?.state === "sent") return;
      // Another isolate is still sending. Admission cannot treat that as an
      // acknowledged alert; the next fresh observation can try again later.
      throw unavailable();
    }
    if (claim.claim_id !== claimId) throw unavailable();
    const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(this.owner);
    if (chatId === null) throw unavailable();
    // Resolving the current destination is asynchronous. A delayed resolution
    // must not send after another invocation has recovered or rearmed the row.
    const owned = await this.database.prepare(`SELECT lease_expires_at FROM capacity_alert_crossings
      WHERE owner_principal_id = ? AND alert_key = ? AND claim_id = ? AND state = 'sending'`)
      .bind(this.owner, alertKey, claimId).first<{ lease_expires_at: string }>();
    if (owned === null || owned.lease_expires_at <= this.now().toISOString()) throw unavailable();
    const text = balanceNotice
      ? "Jarvis model credit: DeepSeek reports $1 or less remaining. Plan the switch to the next provider (R7). Voice calls remain governed separately by the configured balance floor."
      : `Jarvis ${alert.resource}: reported usage is at or above ${alert.threshold}% of the configured limit. Review capacity before admitting more work.`;
    await this.send(chatId, text, alertKey);
    const sentAt = this.now().toISOString();
    const recorded = await this.database.prepare(`UPDATE capacity_alert_crossings SET state = 'sent', sent_at = ?
      WHERE owner_principal_id = ? AND alert_key = ? AND claim_id = ? AND state = 'sending'
        AND lease_expires_at > ?`).bind(sentAt, this.owner, alertKey, claimId, sentAt).run();
    if (recorded.meta.changes !== 1) throw unavailable();
  }

  async rearm(idempotencyKey: string): Promise<void> {
    await this.database.prepare("DELETE FROM capacity_alert_crossings WHERE owner_principal_id = ? AND alert_key = ?")
      .bind(this.owner, rearmableKey(idempotencyKey)).run();
  }

  private async send(chatId: string, text: string, idempotencyKey: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 5000); });
      const result: TelegramSendMessageResult = await Promise.race([
        this.telegram.sendMessage({ chatId, text, idempotencyKey }), timeout,
      ]);
      if (typeof result?.providerMessageId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) throw unavailable();
    } catch {
      // Keep the sending lease after an uncertain result. Telegram cannot
      // deduplicate on our key, so retrying an expired lease can duplicate an
      // unacknowledged delivery. A failure must never become a sent receipt.
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
