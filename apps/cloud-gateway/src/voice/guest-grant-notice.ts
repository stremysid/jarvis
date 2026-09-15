import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { TelegramProvider } from "../providers/provider-types.js";

export interface GuestGrantNoticeSink {
  notify(input: Readonly<{ mutationId: Ulid; now: Date }>): Promise<void>;
}

export interface GuestGrantNoticeDrainResult {
  readonly delivered: number;
  readonly failed: number;
}

interface NoticeRow {
  mutation_id: string;
  owner_principal_id: string;
  status: string;
  event_type: string;
  created_at: string;
  provider_subject: string;
}

const OPERATION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  created: "Guest access created",
  permissions_replaced: "Guest permissions changed",
  pin_rotated: "Guest PIN rotated",
  revoked: "Guest access revoked",
});
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("guest_grant_notice_input_invalid");
  }
  return value.toISOString();
}

function maskNumber(value: string): string {
  if (!E164.test(value)) throw new Error("guest_grant_notice_data_invalid");
  const visiblePrefix = value.slice(0, Math.min(2, value.length - 4));
  return `${visiblePrefix}${"*".repeat(value.length - visiblePrefix.length - 4)}${value.slice(-4)}`;
}

/** Claims the mutation-owned outbox row before sending its fixed Telegram notice. */
export class D1GuestGrantNoticeSink implements GuestGrantNoticeSink {
  constructor(
    private readonly database: D1Database,
    private readonly telegram: Pick<TelegramProvider, "sendMessage">,
  ) {}

  async notify(input: Parameters<GuestGrantNoticeSink["notify"]>[0]): Promise<void> {
    if (typeof input.mutationId !== "string" || !ULID.test(input.mutationId)) {
      throw new TypeError("guest_grant_notice_input_invalid");
    }
    const at = iso(input.now);
    const existing = await this.#notice(input.mutationId);
    if (existing === null) throw new Error("guest_grant_notice_missing");
    if (existing.status === "delivered") return;

    const claimId = crypto.randomUUID();
    const claimExpiresAt = new Date(input.now.valueOf() + 30_000).toISOString();
    const claimed = await this.database.prepare(`UPDATE guest_grant_notices
      SET claim_id = ?, claim_expires_at = ?
      WHERE mutation_id = ? AND status = 'pending'
        AND (claim_id IS NULL OR claim_expires_at <= ?)
      RETURNING mutation_id`)
      .bind(claimId, claimExpiresAt, input.mutationId, at).first<{ mutation_id: string }>();
    if (claimed === null) {
      if ((await this.#notice(input.mutationId))?.status === "delivered") return;
      throw new Error("guest_grant_notice_delivery_in_progress");
    }

    try {
      const notice = await this.#notice(input.mutationId);
      if (notice === null || notice.status !== "pending") throw new Error("guest_grant_notice_data_invalid");
      const operation = OPERATION_TEXT[notice.event_type];
      if (operation === undefined) throw new Error("guest_grant_notice_data_invalid");
      const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(notice.owner_principal_id);
      if (chatId === null) throw new Error("guest_grant_notice_owner_unavailable");
      const result = await this.telegram.sendMessage({
        chatId,
        text: `${operation} for ${maskNumber(notice.provider_subject)} at ${notice.created_at}.`,
        idempotencyKey: `guest-grant:${notice.mutation_id}`,
      });
      if (!/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) {
        throw new Error("guest_grant_notice_delivery_unconfirmed");
      }
      const recorded = await this.database.prepare(`UPDATE guest_grant_notices
        SET status = 'delivered', claim_id = NULL, claim_expires_at = NULL,
          provider_message_id = ?, delivered_at = ?
        WHERE mutation_id = ? AND status = 'pending' AND claim_id = ?`)
        .bind(result.providerMessageId, at, input.mutationId, claimId).run();
      if (recorded.meta.changes !== 1) {
        if ((await this.#notice(input.mutationId))?.status === "delivered") return;
        throw new Error("guest_grant_notice_delivery_unconfirmed");
      }
    } catch (error) {
      try {
        await this.database.prepare(`UPDATE guest_grant_notices
          SET claim_id = NULL, claim_expires_at = NULL
          WHERE mutation_id = ? AND status = 'pending' AND claim_id = ?`)
          .bind(input.mutationId, claimId).run();
      } catch {
        // An abandoned claim expires so another isolate can retry it.
      }
      throw error;
    }
  }

  async drain(now: Date, limit = 10): Promise<GuestGrantNoticeDrainResult> {
    const at = iso(now);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("guest_grant_notice_input_invalid");
    }
    const rows = await this.database.prepare(`SELECT mutation_id FROM guest_grant_notices
      WHERE status = 'pending' AND (claim_id IS NULL OR claim_expires_at <= ?)
      ORDER BY created_at, mutation_id LIMIT ?`).bind(at, limit).all<{ mutation_id: string }>();
    let delivered = 0;
    let failed = 0;
    for (const row of rows.results) {
      try {
        await this.notify({ mutationId: row.mutation_id as Ulid, now });
        delivered += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ delivered, failed });
  }

  async #notice(mutationId: Ulid): Promise<NoticeRow | null> {
    return this.database.prepare(`SELECT notice.mutation_id, notice.owner_principal_id,
      notice.status, event.event_type, event.created_at, identity.provider_subject
      FROM guest_grant_notices notice
      JOIN voice_access_grant_events event ON event.event_id = notice.mutation_id
      JOIN voice_access_grants grant_row ON grant_row.grant_id = event.grant_id
      JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id
      WHERE notice.mutation_id = ?`).bind(mutationId).first<NoticeRow>();
  }
}
