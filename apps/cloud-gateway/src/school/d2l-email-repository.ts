import { newUlid } from "../../../../packages/contracts/src/index.js";
import type { D2lEmailEventKind } from "./d2l-email-parser.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * How many refused receipts survive per principal, and for how long.
 *
 * A quarantined receipt is bounded evidence for Sid, not a permanent record:
 * the sender is unauthenticated by definition, so retaining every delivery
 * lets anyone who learns the address fill the D1 database that also holds his
 * deadlines and memory. The newest five are enough to diagnose the last few
 * refusals; anything older than the window is prunable by the same path.
 */
export const MAXIMUM_RETAINED_QUARANTINED_RECEIPTS = 5;
export const QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type D2lEmailMessageStatus = "pending" | "ingested" | "quarantined";

interface MessageRow {
  readonly principal_id: string;
  readonly email_id: string;
  readonly ingestion_key: string;
  readonly raw_sha256: string;
  readonly provider_message_id: string | null;
  readonly header_names_json: string;
  readonly authentication_json: string;
  readonly envelope_from_domain: string | null;
  readonly from_domain: string | null;
  readonly event_kind: string;
  readonly status: string;
  readonly quarantine_reason: string | null;
  readonly structured_json: string;
  readonly raw_mime_base64: string;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly verification_notified_at: string | null;
}

interface FailureStateRow {
  readonly consecutive_failures: number;
  readonly notice_claim_email_id: string | null;
  readonly notice_sent_at: string | null;
}

export interface D2lEmailMessageReceipt {
  readonly principalId: string;
  readonly emailId: string;
  readonly ingestionKey: string;
  readonly rawSha256: string;
  readonly providerMessageId: string | null;
  readonly headerNames: readonly string[];
  readonly authentication: Readonly<Record<string, unknown>>;
  readonly envelopeFromDomain: string | null;
  readonly fromDomain: string | null;
  readonly eventKind: D2lEmailEventKind;
  readonly status: D2lEmailMessageStatus;
  readonly quarantineReason: string | null;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly rawMimeBase64: string;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly verificationNotifiedAt: string | null;
}

export interface BeginD2lEmailMessageInput {
  readonly principalId: string;
  readonly ingestionKey: string;
  readonly rawSha256: string;
  readonly providerMessageId: string | null;
  readonly headerNames: readonly string[];
  readonly authentication: Readonly<Record<string, unknown>>;
  readonly envelopeFromDomain: string | null;
  readonly fromDomain: string | null;
  readonly eventKind: D2lEmailEventKind;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly rawMimeBase64: string;
  readonly now: Date;
}

const EVENT_KINDS = new Set<D2lEmailEventKind>([
  "assignment_due", "assignment_updated", "feedback_released", "grade_released",
  "new_content", "announcement", "address_verification", "unrecognised",
]);

function instant(value: string | null, label: string): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError(label);
  return value;
}

function at(value: Date): string {
  const copy = new Date(value.getTime());
  if (Number.isNaN(copy.getTime())) throw new TypeError("d2l_email_clock_invalid");
  return copy.toISOString();
}

function jsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError(label);
  return Object.freeze(parsed as Record<string, unknown>);
}

function headerNames(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError("d2l_email_header_names_invalid");
  }
  return Object.freeze([...parsed]);
}

function receipt(row: MessageRow): D2lEmailMessageReceipt {
  if (!ULID.test(row.email_id) || !SHA256.test(row.raw_sha256) || !EVENT_KINDS.has(row.event_kind as D2lEmailEventKind)) {
    throw new TypeError("d2l_email_message_row_invalid");
  }
  if (row.status !== "pending" && row.status !== "ingested" && row.status !== "quarantined") {
    throw new TypeError("d2l_email_message_row_invalid");
  }
  return Object.freeze({
    principalId: row.principal_id,
    emailId: row.email_id,
    ingestionKey: row.ingestion_key,
    rawSha256: row.raw_sha256,
    providerMessageId: row.provider_message_id,
    headerNames: headerNames(row.header_names_json),
    authentication: jsonObject(row.authentication_json, "d2l_email_authentication_invalid"),
    envelopeFromDomain: row.envelope_from_domain,
    fromDomain: row.from_domain,
    eventKind: row.event_kind as D2lEmailEventKind,
    status: row.status,
    quarantineReason: row.quarantine_reason,
    structured: jsonObject(row.structured_json, "d2l_email_structured_invalid"),
    rawMimeBase64: row.raw_mime_base64,
    receivedAt: instant(row.received_at, "d2l_email_message_time_invalid")!,
    processedAt: instant(row.processed_at, "d2l_email_message_time_invalid"),
    verificationNotifiedAt: instant(row.verification_notified_at, "d2l_email_message_time_invalid"),
  });
}

export class D2lEmailRepository {
  constructor(private readonly database: D1Database) {}

  async begin(input: BeginD2lEmailMessageInput): Promise<Readonly<{
    receipt: D2lEmailMessageReceipt;
    created: boolean;
  }>> {
    const existing = await this.readByIdentity(input.principalId, input.ingestionKey, input.rawSha256);
    if (existing !== null) return Object.freeze({ receipt: existing, created: false });
    const emailId = newUlid();
    try {
      await this.database.prepare(`INSERT INTO d2l_email_messages (
        principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
        header_names_json, authentication_json, envelope_from_domain, from_domain,
        event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
        received_at, processed_at, verification_notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL)`)
        .bind(
          input.principalId, emailId, input.ingestionKey, input.rawSha256, input.providerMessageId,
          JSON.stringify(input.headerNames), JSON.stringify(input.authentication),
          input.envelopeFromDomain, input.fromDomain, input.eventKind,
          JSON.stringify(input.structured), input.rawMimeBase64, at(input.now),
        ).run();
    } catch (error) {
      const raced = await this.readByIdentity(input.principalId, input.ingestionKey, input.rawSha256);
      if (raced !== null) return Object.freeze({ receipt: raced, created: false });
      throw error;
    }
    const created = await this.read(input.principalId, emailId);
    if (created === null) throw new Error("d2l_email_message_write_failed");
    return Object.freeze({ receipt: created, created: true });
  }

  async read(principalId: string, emailId: string): Promise<D2lEmailMessageReceipt | null> {
    const row = await this.database.prepare(
      "SELECT * FROM d2l_email_messages WHERE principal_id = ? AND email_id = ?",
    ).bind(principalId, emailId).first<MessageRow>();
    return row === null ? null : receipt(row);
  }

  async readByIdentity(
    principalId: string,
    ingestionKey: string,
    rawSha256: string,
  ): Promise<D2lEmailMessageReceipt | null> {
    const row = await this.database.prepare(`SELECT * FROM d2l_email_messages
      WHERE principal_id = ? AND (ingestion_key = ? OR raw_sha256 = ?)
      ORDER BY received_at, email_id LIMIT 1`).bind(principalId, ingestionKey, rawSha256).first<MessageRow>();
    return row === null ? null : receipt(row);
  }

  async complete(
    principalId: string,
    emailId: string,
    outcome: Readonly<{ status: "ingested"; reason?: never } | { status: "quarantined"; reason: string }>,
    now: Date,
  ): Promise<D2lEmailMessageReceipt> {
    const processedAt = at(now);
    await this.database.prepare(`UPDATE d2l_email_messages
      SET status = ?, quarantine_reason = ?, processed_at = ?
      WHERE principal_id = ? AND email_id = ? AND status = 'pending'`)
      .bind(outcome.status, outcome.status === "quarantined" ? outcome.reason : null, processedAt, principalId, emailId)
      .run();
    const completed = await this.read(principalId, emailId);
    if (completed === null || completed.status === "pending") throw new Error("d2l_email_message_completion_failed");
    return completed;
  }

  /**
   * Delete quarantined receipts that are beyond the cap or past the window.
   *
   * Ingested receipts are never touched, and the migration's delete trigger
   * refuses them explicitly: the whole point of the guard is that the evidence
   * for real school data cannot be removed. Refused mail is the opposite --
   * one stranger can produce it without limit, so it is the part that expires.
   */
  async pruneQuarantined(principalId: string, currentEmailId: string, now: Date): Promise<number> {
    const timestamp = at(now);
    const cutoff = at(new Date(now.getTime() - QUARANTINE_RETENTION_MS));
    // The receipt in hand is never a candidate: it is the one this request is
    // still writing about, and a clock skew must not turn its own reference
    // into a foreign-key failure.
    const victims = await this.database.prepare(`SELECT email_id FROM d2l_email_messages
      WHERE principal_id = ? AND status = 'quarantined' AND email_id <> ?
        AND (
          processed_at < ?
          OR email_id NOT IN (
            SELECT email_id FROM d2l_email_messages
            WHERE principal_id = ? AND status = 'quarantined'
            ORDER BY processed_at DESC, email_id DESC LIMIT ?
          )
        ) LIMIT 200`)
      .bind(principalId, currentEmailId, cutoff, principalId, MAXIMUM_RETAINED_QUARANTINED_RECEIPTS)
      .all<{ email_id: string }>();
    let deleted = 0;
    for (const victim of victims.results) {
      // The failure state points at refusals, so the pointer is released
      // before the row goes: the foreign key stays RESTRICT, and the count is
      // what the next refusal is measured against, not the receipt it arrived
      // on. Spending the claim here can re-arm one later notice, never more.
      await this.database.prepare(`UPDATE d2l_email_failure_state
        SET last_failure_email_id = NULL, updated_at = ?
        WHERE principal_id = ? AND last_failure_email_id = ?`)
        .bind(timestamp, principalId, victim.email_id).run();
      await this.database.prepare(`UPDATE d2l_email_failure_state
        SET notice_claim_email_id = NULL, notice_sent_at = NULL, updated_at = ?
        WHERE principal_id = ? AND notice_claim_email_id = ?`)
        .bind(timestamp, principalId, victim.email_id).run();
      const result = await this.database.prepare(`DELETE FROM d2l_email_messages
        WHERE principal_id = ? AND email_id = ? AND status = 'quarantined'`)
        .bind(principalId, victim.email_id).run();
      deleted += result.meta.changes;
    }
    return deleted;
  }

  async markVerificationNotified(principalId: string, emailId: string, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE d2l_email_messages
      SET verification_notified_at = ?
      WHERE principal_id = ? AND email_id = ? AND status = 'ingested'
        AND event_kind = 'address_verification' AND verification_notified_at IS NULL`)
      .bind(at(now), principalId, emailId).run();
    return result.meta.changes > 0;
  }

  /**
   * Count a refusal, and claim the one owner notice a failure streak earns.
   *
   * `claimImmediately` exists for a refused address-verification message:
   * Sid asked D2L for that mail and is waiting on it, so silence would look
   * like D2L never sent it. A flood of forged ones still earns at most the
   * one notice, because the claim only moves while it is still unclaimed.
   */
  async recordFailure(principalId: string, emailId: string, now: Date, claimImmediately = false): Promise<boolean> {
    const timestamp = at(now);
    await this.database.prepare(`INSERT INTO d2l_email_failure_state (
      principal_id, consecutive_failures, last_failure_email_id, notice_claim_email_id,
      notice_sent_at, last_success_at, updated_at
    ) VALUES (?, 1, ?, NULL, NULL, NULL, ?)
    ON CONFLICT(principal_id) DO UPDATE SET
      consecutive_failures = consecutive_failures + 1,
      last_failure_email_id = excluded.last_failure_email_id,
      updated_at = excluded.updated_at`)
      .bind(principalId, emailId, timestamp).run();
    const claimed = await this.database.prepare(`UPDATE d2l_email_failure_state
      SET notice_claim_email_id = ?, updated_at = ?
      WHERE principal_id = ? AND (consecutive_failures >= 3 OR ? = 1)
        AND notice_claim_email_id IS NULL
      RETURNING principal_id`)
      .bind(emailId, timestamp, principalId, claimImmediately ? 1 : 0)
      .first<{ principal_id: string }>();
    return claimed !== null;
  }

  async recordSuccess(principalId: string, now: Date): Promise<void> {
    const timestamp = at(now);
    await this.database.prepare(`INSERT INTO d2l_email_failure_state (
      principal_id, consecutive_failures, last_failure_email_id, notice_claim_email_id,
      notice_sent_at, last_success_at, updated_at
    ) VALUES (?, 0, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(principal_id) DO UPDATE SET
      consecutive_failures = 0,
      last_failure_email_id = NULL,
      notice_claim_email_id = NULL,
      notice_sent_at = NULL,
      last_success_at = excluded.last_success_at,
      updated_at = excluded.updated_at`)
      .bind(principalId, timestamp, timestamp).run();
  }

  async hasPendingFailureNotice(principalId: string): Promise<boolean> {
    const row = await this.database.prepare(`SELECT consecutive_failures, notice_claim_email_id, notice_sent_at
      FROM d2l_email_failure_state WHERE principal_id = ?`).bind(principalId).first<FailureStateRow>();
    // The claim itself is the record that a notice is owed: it is only ever
    // written by recordFailure, so the counter does not need re-testing here.
    return row !== null && row.notice_claim_email_id !== null && row.notice_sent_at === null;
  }

  async markFailureNoticeSent(principalId: string, now: Date): Promise<boolean> {
    const timestamp = at(now);
    const result = await this.database.prepare(`UPDATE d2l_email_failure_state
      SET notice_sent_at = ?, updated_at = ?
      WHERE principal_id = ? AND notice_claim_email_id IS NOT NULL AND notice_sent_at IS NULL`)
      .bind(timestamp, timestamp, principalId).run();
    return result.meta.changes > 0;
  }
}
