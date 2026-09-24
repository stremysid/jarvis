import { newUlid } from "../../../../packages/contracts/src/index.js";
import { requireInstant, requireText } from "../deadlines/deadline-types.js";

export interface OwnerReminder {
  readonly id: string;
  readonly principal: string;
  readonly due_at: string;
  readonly text: string;
  readonly status: "pending" | "sent" | "cancelled" | "failed";
  readonly created_turn_id: string;
  readonly sent_at: string | null;
  readonly attempts: number;
}

export class OwnerReminderRepository {
  constructor(private readonly database: D1Database) {}

  async schedule(principal: string, turnId: string, at: unknown, text: unknown): Promise<OwnerReminder> {
    const dueAt = requireInstant(at, "owner_reminder_at");
    const message = requireText(text, "owner_reminder_text", 4096);
    const id = newUlid();
    await this.database.prepare(`INSERT INTO owner_reminders
      (id, principal, due_at, text, status, created_turn_id, sent_at, attempts)
      VALUES (?, ?, ?, ?, 'pending', ?, NULL, 0)
      ON CONFLICT (principal, created_turn_id) DO NOTHING`)
      .bind(id, principal, dueAt, message, turnId).run();
    // Replaying a turn returns its original commitment, including its actual
    // wording, rather than claiming a second or different reminder was made.
    const row = await this.database.prepare("SELECT * FROM owner_reminders WHERE principal = ? AND created_turn_id = ?")
      .bind(principal, turnId).first<OwnerReminder>();
    if (row === null) throw new Error("owner_reminder_write_unconfirmed");
    return row;
  }

  async list(principal: string): Promise<readonly OwnerReminder[]> {
    const rows = await this.database.prepare("SELECT * FROM owner_reminders WHERE principal = ? ORDER BY due_at, id")
      .bind(principal).all<OwnerReminder>();
    return rows.results;
  }

  async cancel(principal: string, id: unknown): Promise<boolean> {
    const reminderId = requireText(id, "owner_reminder_id", 26);
    const cancelled = await this.database.prepare(`UPDATE owner_reminders SET status = 'cancelled'
      WHERE principal = ? AND id = ? AND status = 'pending'`)
      .bind(principal, reminderId).run();
    return cancelled.meta.changes === 1;
  }
}
