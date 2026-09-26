/**
 * The one alert about a call that still has nothing to do with a credential.
 *
 * This used to live beside the owner-passphrase step-up, because both were
 * things the gateway told Sid about a call it did not complete. The passphrase
 * gate is gone (Sid, 2026-09-24: an ordinary owner call goes straight to
 * Jarvis); what remains is the admission refusal, which is a genuine operation
 * condition -- every call-session slot was occupied, so the call never reached
 * Jarvis at all. Deleting it with the gate would have silently dropped a
 * notification Sid reads.
 *
 * The alert row is keyed by principal, class and direction, and it coalesces:
 * the first observation is delivered immediately, further identical ones only
 * bump the count, and the same class is not sent again for fifteen minutes.
 * A failed delivery releases its claim so the next refusal retries rather than
 * waiting out the window.
 */

import { DeviceRepository } from "../persistence/device-repository.js";
import type { TelegramProvider, TelegramSendMessageResult } from "../providers/provider-types.js";

const COALESCE_MS = 15 * 60_000;
const CLAIM_TTL_MS = 30_000;

export interface OwnerCallAdmissionAlert {
  readonly ownerPrincipalId: string;
  readonly direction: "inbound" | "outbound";
  readonly now: Date;
}

export interface OwnerCallAdmissionAlertSink {
  /** Delivers at most one identical alert per fifteen minutes. */
  alert(input: OwnerCallAdmissionAlert): Promise<void>;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("owner_call_alert_input_invalid");
  }
  return value.toISOString();
}

export class D1OwnerCallAdmissionAlertSink implements OwnerCallAdmissionAlertSink {
  constructor(
    private readonly database: D1Database,
    private readonly telegram: Pick<TelegramProvider, "sendMessage">,
  ) {}

  async alert(input: OwnerCallAdmissionAlert): Promise<void> {
    const at = iso(input.now);
    const eligibleBefore = new Date(input.now.valueOf() - COALESCE_MS).toISOString();
    const claimId = crypto.randomUUID();
    const claimExpiresAt = new Date(input.now.valueOf() + CLAIM_TTL_MS).toISOString();
    const inserted = await this.database.prepare(`INSERT INTO owner_call_step_up_alerts (
      owner_principal_id, alert_class, direction, attestation_class,
      first_observed_at, last_observed_at, observation_count, last_sent_at, claim_id, claim_expires_at
    ) SELECT ?, 'admission_refused', ?, 'not_applicable', ?, ?, 1, NULL, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM owner_call_step_up_alerts
      WHERE owner_principal_id = ? AND alert_class = 'admission_refused' AND direction = ?
    ) RETURNING claim_id, observation_count`).bind(
      input.ownerPrincipalId, input.direction, at, at, claimId, claimExpiresAt,
      input.ownerPrincipalId, input.direction,
    ).first<{ claim_id: string | null; observation_count: number }>();
    const claimed = inserted ?? await this.database.prepare(`UPDATE owner_call_step_up_alerts SET
      last_observed_at = ?,
      observation_count = owner_call_step_up_alerts.observation_count + 1,
      claim_id = CASE
        WHEN (owner_call_step_up_alerts.last_sent_at IS NULL OR owner_call_step_up_alerts.last_sent_at <= ?)
          AND (owner_call_step_up_alerts.claim_expires_at IS NULL OR owner_call_step_up_alerts.claim_expires_at <= ?)
        THEN ? ELSE owner_call_step_up_alerts.claim_id END,
      claim_expires_at = CASE
        WHEN (owner_call_step_up_alerts.last_sent_at IS NULL OR owner_call_step_up_alerts.last_sent_at <= ?)
          AND (owner_call_step_up_alerts.claim_expires_at IS NULL OR owner_call_step_up_alerts.claim_expires_at <= ?)
        THEN ? ELSE owner_call_step_up_alerts.claim_expires_at END
      WHERE owner_principal_id = ? AND alert_class = 'admission_refused' AND direction = ?
      RETURNING claim_id, observation_count`).bind(
      at, eligibleBefore, at, claimId, eligibleBefore, at, claimExpiresAt,
      input.ownerPrincipalId, input.direction,
    ).first<{ claim_id: string | null; observation_count: number }>();
    if (claimed === null || claimed.claim_id !== claimId) return;
    try {
      const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(input.ownerPrincipalId);
      if (chatId === null) throw new Error("owner_call_alert_unavailable");
      const text = `Jarvis refused an ${input.direction} owner call because all call-session slots were occupied.`
        + ` Total observations: ${claimed.observation_count}.`;
      const result: TelegramSendMessageResult = await this.telegram.sendMessage({
        chatId,
        text,
        idempotencyKey: `owner-call-admission:${input.ownerPrincipalId}:${input.direction}:${at.slice(0, 16)}`,
      });
      if (!/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) throw new Error("owner_call_alert_unavailable");
      const recorded = await this.database.prepare(`UPDATE owner_call_step_up_alerts
        SET last_sent_at = ?, claim_id = NULL, claim_expires_at = NULL
        WHERE owner_principal_id = ? AND alert_class = 'admission_refused' AND direction = ? AND claim_id = ?`)
        .bind(at, input.ownerPrincipalId, input.direction, claimId).run();
      if (recorded.meta.changes !== 1) throw new Error("owner_call_alert_unavailable");
    } catch (error) {
      try {
        await this.database.prepare(`UPDATE owner_call_step_up_alerts
          SET claim_id = NULL, claim_expires_at = NULL
          WHERE owner_principal_id = ? AND alert_class = 'admission_refused' AND direction = ? AND claim_id = ?`)
          .bind(input.ownerPrincipalId, input.direction, claimId).run();
      } catch {
        // An uncleared claim expires after 30 seconds and remains fail-closed.
      }
      throw error;
    }
  }
}
