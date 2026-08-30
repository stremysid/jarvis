import { TransactionRunner } from "./transaction.js";

export interface CursorRepositoryContract {
  advanceContiguous(consumerName: string, expectedCurrent: number, throughSequence: number): Promise<void>;
  read(consumerName: string): Promise<number>;
}

interface CursorRow { current_sequence: number; }
const encoder = new TextEncoder();

function requireSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
}

/** Advances only when the ledger's immutable sequence interval is complete. */
export class CursorRepository implements CursorRepositoryContract {
  private readonly transactions: TransactionRunner;

  constructor(private readonly database: D1Database) {
    this.transactions = new TransactionRunner(database);
  }

  async advanceContiguous(consumerName: string, expectedCurrent: number, throughSequence: number): Promise<void> {
    if (consumerName.length === 0) throw new TypeError("consumerName must be non-empty");
    if (encoder.encode(consumerName).byteLength > 128) throw new RangeError("consumerName exceeds UTF-8 byte limit");
    requireSequence(expectedCurrent, "expectedCurrent");
    requireSequence(throughSequence, "throughSequence");
    if (throughSequence <= expectedCurrent) throw new RangeError("cursor_range_invalid");

    const acknowledgedAt = new Date().toISOString();
    const snapshotId = `${consumerName}:${expectedCurrent}:${throughSequence}`;
    const contiguity = "(SELECT COUNT(*) FROM events WHERE sequence > ? AND sequence <= ?) = (? - ?) AND (SELECT MIN(sequence) FROM events WHERE sequence > ? AND sequence <= ?) = ? AND (SELECT MAX(sequence) FROM events WHERE sequence > ? AND sequence <= ?) = ?";
    const cursorResult = await this.transactions.batch([
      this.database.prepare(
        `INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at)
         SELECT ?, ?, ? WHERE ${contiguity}
         ON CONFLICT(consumer_name) DO UPDATE SET current_sequence = excluded.current_sequence, updated_at = excluded.updated_at
         WHERE consumer_cursors.current_sequence = ? AND ${contiguity}`,
      ).bind(
        consumerName, throughSequence, acknowledgedAt,
        expectedCurrent, throughSequence, throughSequence, expectedCurrent, expectedCurrent, throughSequence, expectedCurrent + 1, expectedCurrent, throughSequence, throughSequence,
        expectedCurrent,
        expectedCurrent, throughSequence, throughSequence, expectedCurrent, expectedCurrent, throughSequence, expectedCurrent + 1, expectedCurrent, throughSequence, throughSequence,
      ),
      this.database.prepare(
        `INSERT INTO sync_ack_receipts (receipt_id, snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind)
         SELECT ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'legacy'
         WHERE changes() = 1`,
      ).bind(snapshotId, snapshotId, consumerName, expectedCurrent, throughSequence, throughSequence, acknowledgedAt),
    ]);

    if (cursorResult[0]?.meta.changes !== 1 || cursorResult[1]?.meta.changes !== 1) {
      throw new Error(await this.failureReason(consumerName, expectedCurrent, throughSequence));
    }
  }

  async read(consumerName: string): Promise<number> {
    const row = await this.database.prepare("SELECT current_sequence FROM consumer_cursors WHERE consumer_name = ?").bind(consumerName).first<CursorRow>();
    return row?.current_sequence ?? 0;
  }

  private async failureReason(consumerName: string, expectedCurrent: number, throughSequence: number): Promise<string> {
    const current = await this.read(consumerName);
    if (current !== expectedCurrent) return "cursor_compare_failed";
    const range = await this.database.prepare(
      "SELECT COUNT(*) AS count, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence FROM events WHERE sequence > ? AND sequence <= ?",
    ).bind(expectedCurrent, throughSequence).first<{ count: number; first_sequence: number | null; last_sequence: number | null }>();
    if (range?.count !== throughSequence - expectedCurrent || range.first_sequence !== expectedCurrent + 1 || range.last_sequence !== throughSequence) {
      return "cursor_range_incomplete";
    }
    return "cursor_compare_failed";
  }
}
