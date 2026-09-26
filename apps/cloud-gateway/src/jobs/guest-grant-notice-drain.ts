import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { GuestGrantNoticeSink } from "../voice/guest-grant-notice.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RUN_LEASE_MODIFIER = "+4 minutes";

/**
 * The notice phase executes four coordination statements plus at most nine statements
 * per notice. D1GuestGrantNoticeSink uses at most eight and advancing the
 * durable cursor uses one. A failed final coordination write adds one more.
 * An additional drain callback has its own I/O and is outside this notice budget.
 */
export const GUEST_GRANT_NOTICE_DRAIN_LIMITS = Object.freeze({
  noticesPerRun: 10,
  d1Statements: 95,
});

export type GuestGrantNoticeDrainOutcome =
  | "completed"
  | "delivery_deferred"
  | "already_running"
  | "expired_run_recovered";

interface DrainStateRow {
  status: string;
  cursor_created_at: string | null;
  cursor_mutation_id: string | null;
  updated_at: string;
}

interface NoticeKeyRow {
  mutation_id: unknown;
  created_at: unknown;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("guest_grant_notice_drain_input_invalid");
  }
  return value.toISOString();
}

function monotonicIso(value: Date, floor: string): string {
  if (!TIMESTAMP.test(floor)) throw new Error("guest_grant_notice_drain_state_invalid");
  const current = iso(value);
  return current < floor ? floor : current;
}

function noticeKey(row: NoticeKeyRow): Readonly<{
  mutationId: string;
  createdAt: string;
  deliverable: boolean;
}> {
  if (typeof row.mutation_id !== "string" || typeof row.created_at !== "string") {
    throw new Error("guest_grant_notice_drain_data_invalid");
  }
  return Object.freeze({
    mutationId: row.mutation_id,
    createdAt: row.created_at,
    deliverable: ULID.test(row.mutation_id) && TIMESTAMP.test(row.created_at),
  });
}

/** Rotates a durable cursor so one poison notice cannot monopolize the oldest batch. */
export class D1GuestGrantNoticeDrainer {
  constructor(
    private readonly database: D1Database,
    private readonly notices: GuestGrantNoticeSink,
    private readonly clock: { now(): Date },
    /** Owner reminders share this lease and retry tick, but retain their own dispatch fence. */
    private readonly additionalDrain?: () => Promise<void>,
  ) {}

  async run(limit = GUEST_GRANT_NOTICE_DRAIN_LIMITS.noticesPerRun): Promise<GuestGrantNoticeDrainOutcome> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GUEST_GRANT_NOTICE_DRAIN_LIMITS.noticesPerRun) {
      throw new TypeError("guest_grant_notice_drain_input_invalid");
    }
    const startedAt = iso(this.clock.now());
    const recovered = await this.database.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'failed', run_id = NULL, lease_expires_at = NULL,
        updated_at = ?, failure_code = 'lease_expired'
      WHERE singleton_id = 1 AND status = 'running' AND lease_expires_at <= ?`)
      .bind(startedAt, startedAt).run();
    if (recovered.meta.changes === 1) return "expired_run_recovered";

    const runId = crypto.randomUUID();
    const claimed = await this.database.prepare(`UPDATE guest_grant_notice_drain_state
      SET status = 'running', run_id = ?,
        lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(updated_at, ?), ?),
        updated_at = max(updated_at, ?), failure_code = NULL
      WHERE singleton_id = 1 AND status IN ('ready', 'failed')
      RETURNING status, cursor_created_at, cursor_mutation_id, updated_at`)
      .bind(runId, startedAt, RUN_LEASE_MODIFIER, startedAt).first<DrainStateRow>();
    if (claimed === null) {
      const current = await this.database.prepare(
        "SELECT status, cursor_created_at, cursor_mutation_id, updated_at FROM guest_grant_notice_drain_state WHERE singleton_id = 1",
      ).first<DrainStateRow>();
      if (current?.status === "running") return "already_running";
      throw new Error("guest_grant_notice_drain_state_missing");
    }

    let checkpointAt = claimed.updated_at;
    try {
      if (!TIMESTAMP.test(checkpointAt)) throw new Error("guest_grant_notice_drain_state_invalid");
      const rows = await this.database.prepare(`SELECT mutation_id, created_at
        FROM guest_grant_notices
        WHERE status = 'pending' AND (claim_id IS NULL OR claim_expires_at <= ?)
        ORDER BY CASE
          WHEN ? IS NULL OR created_at > ? OR (created_at = ? AND mutation_id > ?) THEN 0
          ELSE 1
        END, created_at, mutation_id
        LIMIT ?`).bind(
        startedAt,
        claimed.cursor_created_at,
        claimed.cursor_created_at,
        claimed.cursor_created_at,
        claimed.cursor_mutation_id,
        limit,
      ).all<NoticeKeyRow>();
      let deferred = false;
      for (const raw of rows.results) {
        const key = noticeKey(raw);
        if (!key.deliverable) {
          deferred = true;
        } else {
          try {
            await this.notices.notify({ mutationId: key.mutationId as Ulid, now: this.clock.now() });
          } catch {
            deferred = true;
          }
        }
        const advancedAt = monotonicIso(this.clock.now(), checkpointAt);
        const advanced = await this.database.prepare(`UPDATE guest_grant_notice_drain_state
          SET cursor_created_at = ?, cursor_mutation_id = ?, updated_at = ?
          WHERE singleton_id = 1 AND status = 'running' AND run_id = ?`)
          .bind(key.createdAt, key.mutationId, advancedAt, runId).run();
        if (advanced.meta.changes !== 1) throw new Error("guest_grant_notice_drain_checkpoint_lost");
        checkpointAt = advancedAt;
      }

      await this.additionalDrain?.();
      const completedAt = monotonicIso(this.clock.now(), checkpointAt);
      const completed = await this.database.prepare(`UPDATE guest_grant_notice_drain_state
        SET status = ?, run_id = NULL, lease_expires_at = NULL, updated_at = ?, failure_code = ?
        WHERE singleton_id = 1 AND status = 'running' AND run_id = ?`)
        .bind(
          deferred ? "failed" : "ready",
          completedAt,
          deferred ? "notice_delivery_failed" : null,
          runId,
        ).run();
      if (completed.meta.changes !== 1) throw new Error("guest_grant_notice_drain_checkpoint_lost");
      return deferred ? "delivery_deferred" : "completed";
    } catch (error) {
      try {
        await this.database.prepare(`UPDATE guest_grant_notice_drain_state
          SET status = 'failed', run_id = NULL, lease_expires_at = NULL,
            updated_at = ?, failure_code = 'drain_operation_failed'
          WHERE singleton_id = 1 AND status = 'running' AND run_id = ?`)
          .bind(monotonicIso(this.clock.now(), checkpointAt), runId).run();
      } catch {
        // The lease remains bounded so a later run can expose and recover it.
      }
      throw error;
    }
  }
}
