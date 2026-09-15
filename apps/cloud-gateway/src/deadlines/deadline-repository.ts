/**
 * D1 storage for deadlines, their revisions, their sources, and quiet windows.
 *
 * Two rules shape almost everything here.
 *
 * The first is that a deadline and its revision are written together or not at
 * all. `deadline_revisions` is the only record that a due date ever moved --
 * the row itself is mutable and keeps only the current answer -- so a deadline
 * written without its revision is a deadline whose history silently begins
 * wherever the next successful write happened to land. Every path that touches
 * both goes through `TransactionRunner.batch`, which is the persistence
 * layer's only transaction primitive.
 *
 * The second is that a revision is appended only when the content actually
 * changed. A sweep runs on a schedule and sees the same twenty assignments
 * every time; appending on every sighting would bury the four rows that mean
 * something under thousands that mean "still there", and "did this move?"
 * would stop being answerable by looking.
 *
 * Timestamps are passed in rather than read from a clock in here. The
 * persistence layer is the one place where a test needs to say exactly when
 * something happened, and a repository that knows the time is a repository
 * whose behaviour at a boundary cannot be written down.
 */

import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "../persistence/transaction.js";
import {
  DEADLINE_SOURCE_KINDS,
  instantOf,
  requireEffort,
  requireInstant,
  requireLeadMinutes,
  requireStatus,
  requireText,
  toInstant,
  type Deadline,
  type DeadlineEffort,
  type DeadlineRevision,
  type DeadlineSource,
  type DeadlineSourceKind,
  type DeadlineStatus,
  type QuietWindow,
} from "./deadline-types.js";

const MAXIMUM_IDENTIFIER_CHARACTERS = 256;
const MAXIMUM_TITLE_CHARACTERS = 512;
/** The `last_failure` CHECK caps this; exceeding it aborts the write that was reporting the failure. */
export const MAXIMUM_FAILURE_CHARACTERS = 512;

/** One re-read is enough to resolve a concurrent writer; a second means something else is wrong. */
const UPSERT_ATTEMPTS = 2;

interface DeadlineRow {
  readonly deadline_id: string;
  readonly source_id: string;
  readonly external_id: string;
  readonly course: string;
  readonly title: string;
  readonly due_at: string;
  readonly effort: string;
  readonly lead_minutes: number;
  readonly status: string;
  readonly content_hash: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly reminded_at: string | null;
}

interface DeadlineSourceRow {
  readonly source_id: string;
  readonly kind: string;
  readonly label: string;
  readonly active: number;
  readonly last_success_at: string | null;
  readonly last_failure: string | null;
  readonly last_failure_at: string | null;
  readonly created_at: string;
}

interface DeadlineRevisionRow {
  readonly revision_id: string;
  readonly deadline_id: string;
  readonly content_hash: string;
  readonly due_at: string;
  readonly title: string;
  readonly observed_at: string;
}

interface QuietWindowRow {
  readonly window_id: string;
  readonly reason: string;
  readonly deadline_id: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly created_at: string;
  readonly cancelled_at: string | null;
}

function toDeadline(row: DeadlineRow): Deadline {
  return Object.freeze({
    deadlineId: row.deadline_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    course: row.course,
    title: row.title,
    dueAt: row.due_at,
    effort: requireEffort(row.effort),
    leadMinutes: row.lead_minutes,
    status: requireStatus(row.status),
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    remindedAt: row.reminded_at,
  });
}

function toSource(row: DeadlineSourceRow): DeadlineSource {
  return Object.freeze({
    sourceId: row.source_id,
    kind: row.kind as DeadlineSourceKind,
    label: row.label,
    active: row.active === 1,
    lastSuccessAt: row.last_success_at,
    lastFailure: row.last_failure,
    lastFailureAt: row.last_failure_at,
    createdAt: row.created_at,
  });
}

function toRevision(row: DeadlineRevisionRow): DeadlineRevision {
  return Object.freeze({
    revisionId: row.revision_id,
    deadlineId: row.deadline_id,
    contentHash: row.content_hash,
    dueAt: row.due_at,
    title: row.title,
    observedAt: row.observed_at,
  });
}

function toQuietWindow(row: QuietWindowRow): QuietWindow {
  return Object.freeze({
    windowId: row.window_id,
    reason: row.reason === "exam" ? "exam" as const : "manual" as const,
    deadlineId: row.deadline_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  });
}

/**
 * The hash that decides whether a sighting is a new version.
 *
 * It covers exactly what the source controls: the course, the title, and the
 * due date. `effort` and `lead_minutes` are ours -- derived from the title or
 * set by the owner -- and folding them in would make his own retag of a course
 * look like every teacher in it moved every date on the same afternoon.
 *
 * `canonicalJson` rather than string concatenation, so a title containing the
 * separator cannot be arranged to collide with a different course and title.
 */
export function deadlineContentHash(input: {
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
}): Promise<string> {
  return sha256Hex(canonicalJson({ course: input.course, dueAt: input.dueAt, title: input.title }));
}

export interface CreateDeadlineSourceInput {
  readonly sourceId?: string;
  readonly kind: DeadlineSourceKind;
  readonly label: string;
  readonly active?: boolean;
  readonly now: Date;
}

export interface DeadlineUpsertInput {
  readonly sourceId: string;
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly effort: DeadlineEffort;
  readonly leadMinutes: number;
  readonly now: Date;
}

export type DeadlineUpsertOutcome = "created" | "revised" | "unchanged";

export interface DeadlineUpsertResult {
  readonly outcome: DeadlineUpsertOutcome;
  readonly deadline: Deadline;
  /** The revision appended by this call, or null when nothing changed. */
  readonly revisionId: string | null;
  /** What the row said before, present only on `revised`. It is how a caller reports that a date moved. */
  readonly previous: Readonly<{ dueAt: string; title: string; course: string }> | null;
}

export interface ListDueWithinInput {
  readonly from: Date | string;
  readonly to: Date | string;
  /** Defaults to open deadlines only; a submitted one is not something to remind about. */
  readonly statuses?: readonly DeadlineStatus[];
  readonly efforts?: readonly DeadlineEffort[];
}

export type CreateQuietWindowInput =
  | {
    readonly reason: "exam";
    /** Required by the schema's CHECK for an exam window, and required here so it cannot be forgotten. */
    readonly deadlineId: string;
    readonly startsAt: Date | string;
    readonly endsAt: Date | string;
    readonly now: Date;
  }
  | {
    readonly reason: "manual";
    readonly deadlineId?: never;
    readonly startsAt: Date | string;
    readonly endsAt: Date | string;
    readonly now: Date;
  };

/** Builds `?, ?, ?` from a count. The text is derived from the list's length, never from its contents. */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export class DeadlineRepository {
  readonly #database: D1Database;
  readonly #transactions: TransactionRunner;

  constructor(database: D1Database) {
    this.#database = database;
    this.#transactions = new TransactionRunner(database);
  }

  async createSource(input: CreateDeadlineSourceInput): Promise<DeadlineSource> {
    const sourceId = input.sourceId === undefined
      ? newUlid()
      : requireText(input.sourceId, "deadline_source_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const label = requireText(input.label, "deadline_source_label", MAXIMUM_TITLE_CHARACTERS);
    if (!DEADLINE_SOURCE_KINDS.includes(input.kind)) throw new TypeError("deadline_source_kind_invalid");
    const createdAt = toInstant(new Date(input.now.getTime()));
    await this.#database.prepare(
      `INSERT INTO deadline_sources (source_id, kind, label, active, last_success_at, last_failure, last_failure_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).bind(sourceId, input.kind, label, input.active === false ? 0 : 1, createdAt).run();
    const created = await this.readSource(sourceId);
    if (created === null) throw new Error("deadline_source_write_failed");
    return created;
  }

  /**
   * Create one source with a stable id, or return the row already carrying it.
   * Scheduled jobs are retried and overlap during deploys, so bootstrap must be
   * idempotent rather than a read-then-insert race. An existing id with a
   * different kind is corruption or an ownership collision and is refused.
   */
  async ensureSource(input: CreateDeadlineSourceInput & { readonly sourceId: string }): Promise<DeadlineSource> {
    const sourceId = requireText(input.sourceId, "deadline_source_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const label = requireText(input.label, "deadline_source_label", MAXIMUM_TITLE_CHARACTERS);
    if (!DEADLINE_SOURCE_KINDS.includes(input.kind)) throw new TypeError("deadline_source_kind_invalid");
    const createdAt = toInstant(new Date(input.now.getTime()));
    await this.#database.prepare(
      `INSERT INTO deadline_sources (source_id, kind, label, active, last_success_at, last_failure, last_failure_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(source_id) DO NOTHING`,
    ).bind(sourceId, input.kind, label, input.active === false ? 0 : 1, createdAt).run();
    const source = await this.readSource(sourceId);
    if (source === null) throw new Error("deadline_source_write_failed");
    if (source.kind !== input.kind) throw new Error("deadline_source_kind_conflict");
    return source;
  }

  async readSource(sourceId: string): Promise<DeadlineSource | null> {
    const row = await this.#database.prepare("SELECT * FROM deadline_sources WHERE source_id = ?")
      .bind(sourceId).first<DeadlineSourceRow>();
    return row === null ? null : toSource(row);
  }

  async listSources(input?: { readonly activeOnly?: boolean }): Promise<readonly DeadlineSource[]> {
    const activeOnly = input?.activeOnly === true;
    const result = await this.#database.prepare(
      `SELECT * FROM deadline_sources ${activeOnly ? "WHERE active = 1" : ""} ORDER BY created_at, source_id`,
    ).all<DeadlineSourceRow>();
    return Object.freeze(result.results.map(toSource));
  }

  /**
   * A sweep worked. An ordinary success clears the failure pair in the same
   * statement. A bounded partial success may instead retain one fixed health
   * gap so the digest cannot misreport an incomplete source as complete.
   */
  async recordSourceSuccess(sourceId: string, now: Date, healthGap: string | null = null): Promise<boolean> {
    const at = toInstant(new Date(now.getTime()));
    const boundedGap = healthGap === null ? null : truncateFailure(healthGap);
    const result = await this.#database.prepare(
      `UPDATE deadline_sources
       SET last_success_at = ?, last_failure = ?, last_failure_at = ?
       WHERE source_id = ?`,
    ).bind(at, boundedGap, boundedGap === null ? null : at, sourceId).run();
    return result.meta.changes > 0;
  }

  /**
   * A sweep failed. `last_success_at` is deliberately not touched: how long it
   * has been broken is the part that decides whether this is a blip or the
   * reason the digest has been quiet all week.
   *
   * The reason is truncated rather than refused. It reaches here from a caught
   * exception, and an exception message can carry a scraped page, so it is
   * bounded before it can abort the write that was reporting the failure --
   * losing the alert to the error it was alerting about. It is stored as
   * opaque text and read by nothing.
   */
  async recordSourceFailure(sourceId: string, failure: string, now: Date): Promise<boolean> {
    const at = toInstant(new Date(now.getTime()));
    const bounded = truncateFailure(failure);
    const result = await this.#database.prepare(
      "UPDATE deadline_sources SET last_failure = ?, last_failure_at = ? WHERE source_id = ?",
    ).bind(bounded, at, sourceId).run();
    return result.meta.changes > 0;
  }

  async readDeadline(deadlineId: string): Promise<Deadline | null> {
    const row = await this.#database.prepare("SELECT * FROM deadlines WHERE deadline_id = ?")
      .bind(deadlineId).first<DeadlineRow>();
    return row === null ? null : toDeadline(row);
  }

  async readByExternalId(sourceId: string, externalId: string): Promise<Deadline | null> {
    const row = await this.#readRow(sourceId, externalId);
    return row === null ? null : toDeadline(row);
  }

  async listRevisions(deadlineId: string): Promise<readonly DeadlineRevision[]> {
    const result = await this.#database.prepare(
      "SELECT * FROM deadline_revisions WHERE deadline_id = ? ORDER BY observed_at, revision_id",
    ).bind(deadlineId).all<DeadlineRevisionRow>();
    return Object.freeze(result.results.map(toRevision));
  }

  /**
   * Insert or update one deadline, appending a revision only when the content
   * hash moved.
   *
   * On a change the row's `effort` and `lead_minutes` are rewritten from the
   * arguments, and on no change they are left alone. That asymmetry is what
   * lets the owner retag a deadline by hand and keep the tag: the sweep sees
   * the same title tomorrow, computes the same hash, and does not reach the
   * branch that would overwrite him. When the teacher actually edits the item,
   * the tag we derived from the old text is stale anyway and is re-derived.
   *
   * `reminded_at` is cleared only when the due date itself moved. A corrected
   * typo in a title is not a reason to remind him again; a date that moved is
   * the one thing he must be told about a second time.
   */
  async upsert(input: DeadlineUpsertInput): Promise<DeadlineUpsertResult> {
    const sourceId = requireText(input.sourceId, "deadline_source_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const externalId = requireText(input.externalId, "deadline_external_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const course = requireText(input.course, "deadline_course", MAXIMUM_TITLE_CHARACTERS);
    const title = requireText(input.title, "deadline_title", MAXIMUM_TITLE_CHARACTERS);
    const dueAt = requireInstant(input.dueAt, "deadline_due_at");
    const effort = requireEffort(input.effort);
    const leadMinutes = requireLeadMinutes(input.leadMinutes);
    const observedAt = toInstant(new Date(input.now.getTime()));
    const contentHash = await deadlineContentHash({ course, title, dueAt });

    // The common hourly path is one statement per unchanged item. Reading
    // first and then touching last_seen_at tripled the D1 cost of a steady
    // school feed before the caller even computed disappearances.
    const unchanged = await this.#database.prepare(
      `UPDATE deadlines
       SET last_seen_at = CASE WHEN last_seen_at <= ? THEN ? ELSE last_seen_at END
       WHERE source_id = ? AND external_id = ? AND content_hash = ?
       RETURNING *`,
    ).bind(observedAt, observedAt, sourceId, externalId, contentHash).first<DeadlineRow>();
    if (unchanged !== null) {
      return Object.freeze({
        outcome: "unchanged" as const,
        deadline: toDeadline(unchanged),
        revisionId: null,
        previous: null,
      });
    }

    for (let attempt = 0; attempt < UPSERT_ATTEMPTS; attempt += 1) {
      const existing = await this.#readRow(sourceId, externalId);

      if (existing === null) {
        const deadlineId = newUlid();
        const revisionId = newUlid();
        const results = await this.#transactions.batch([
          this.#database.prepare(
            `INSERT INTO deadlines (
               deadline_id, source_id, external_id, course, title, due_at, effort, lead_minutes,
               status, content_hash, first_seen_at, last_seen_at, reminded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)
             ON CONFLICT (source_id, external_id) DO NOTHING`,
          ).bind(
            deadlineId, sourceId, externalId, course, title, dueAt, effort, leadMinutes,
            contentHash, observedAt, observedAt,
          ),
          // Guarded on the insert above having landed. Without the guard a lost
          // race would leave this pointing at a deadline_id that does not
          // exist, and the foreign key would abort the batch -- turning a
          // benign collision into a failed sweep.
          this.#database.prepare(
            `INSERT INTO deadline_revisions (revision_id, deadline_id, content_hash, due_at, title, observed_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deadlines WHERE deadline_id = ?)`,
          ).bind(revisionId, deadlineId, contentHash, dueAt, title, observedAt, deadlineId),
        ]);
        // Another writer inserted the same (source, external_id) first. Re-read
        // and take the update path rather than reporting a creation that is not
        // ours.
        if ((results[0]?.meta.changes ?? 0) !== 1) continue;
        if ((results[1]?.meta.changes ?? 0) !== 1) throw new Error("deadline_revision_write_failed");
        return Object.freeze({
          outcome: "created" as const,
          deadline: await this.#requireDeadline(deadlineId),
          revisionId,
          previous: null,
        });
      }

      if (existing.content_hash === contentHash) {
        return Object.freeze({
          outcome: "unchanged" as const,
          deadline: toDeadline(existing),
          revisionId: null,
          previous: null,
        });
      }

      const revisionId = newUlid();
      const results = await this.#transactions.batch([
        // SQLite evaluates every SET expression against the pre-update row, so
        // `due_at = ?` inside the CASE is comparing the stored date with the
        // incoming one.
        this.#database.prepare(
          `UPDATE deadlines
           SET course = ?, title = ?, due_at = ?, effort = ?, lead_minutes = ?, content_hash = ?, last_seen_at = ?,
               reminded_at = CASE WHEN due_at = ? THEN reminded_at ELSE NULL END
           WHERE deadline_id = ? AND content_hash = ?`,
        ).bind(
          course, title, dueAt, effort, leadMinutes, contentHash, observedAt,
          dueAt, existing.deadline_id, existing.content_hash,
        ),
        // Guarded on the new hash being what the row now holds, so a concurrent
        // writer that applied the same change cannot make us append it twice.
        this.#database.prepare(
          `INSERT INTO deadline_revisions (revision_id, deadline_id, content_hash, due_at, title, observed_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT content_hash FROM deadlines WHERE deadline_id = ?) = ?`,
        ).bind(revisionId, existing.deadline_id, contentHash, dueAt, title, observedAt, existing.deadline_id, contentHash),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) continue;
      if ((results[1]?.meta.changes ?? 0) !== 1) throw new Error("deadline_revision_write_failed");
      return Object.freeze({
        outcome: "revised" as const,
        deadline: await this.#requireDeadline(existing.deadline_id),
        revisionId,
        previous: Object.freeze({ dueAt: existing.due_at, title: existing.title, course: existing.course }),
      });
    }

    throw new Error("deadline_upsert_contended");
  }

  /** Close only an explicit upstream cancellation; absence alone stays recoverable. */
  async cancelOpenByExternalId(sourceId: string, externalId: string, now: Date): Promise<Deadline | null> {
    const requiredSourceId = requireText(sourceId, "deadline_source_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const requiredExternalId = requireText(externalId, "deadline_external_id", MAXIMUM_IDENTIFIER_CHARACTERS);
    const observedAt = toInstant(new Date(now.getTime()));
    const row = await this.#database.prepare(
      `UPDATE deadlines
       SET status = 'cancelled', last_seen_at = CASE WHEN last_seen_at <= ? THEN ? ELSE last_seen_at END
       WHERE source_id = ? AND external_id = ? AND status = 'open'
       RETURNING *`,
    ).bind(observedAt, observedAt, requiredSourceId, requiredExternalId).first<DeadlineRow>();
    return row === null ? null : toDeadline(row);
  }

  /** Deadlines due in `[from, to)`. Half-open so consecutive digest windows neither overlap nor skip. */
  async listDueWithin(input: ListDueWithinInput): Promise<readonly Deadline[]> {
    const from = instantOf(input.from, "deadline_window_from");
    const to = instantOf(input.to, "deadline_window_to");
    const statuses = (input.statuses ?? ["open"]).map(requireStatus);
    if (statuses.length === 0) throw new TypeError("deadline_status_invalid");
    const efforts = input.efforts === undefined ? null : input.efforts.map(requireEffort);
    if (efforts !== null && efforts.length === 0) throw new TypeError("deadline_effort_invalid");

    const effortClause = efforts === null ? "" : ` AND effort IN (${placeholders(efforts.length)})`;
    const result = await this.#database.prepare(
      `SELECT * FROM deadlines
       WHERE status IN (${placeholders(statuses.length)}) AND due_at >= ? AND due_at < ?${effortClause}
       ORDER BY due_at, deadline_id`,
    ).bind(...statuses, from, to, ...(efforts ?? [])).all<DeadlineRow>();
    return Object.freeze(result.results.map(toDeadline));
  }

  /**
   * Open deadlines whose reminder is due: still unreminded, still ahead of us,
   * and inside their own lead time.
   *
   * The lead arithmetic is done here rather than in SQL on purpose. This
   * subsystem defines an instant as one exact string format and compares it as
   * text; SQLite's date functions define it a second time, with their own
   * parsing rules, and a system with two definitions of "when" eventually
   * disagrees with itself at a daylight-saving boundary. The row count is a
   * student's open assignments, so reading them and filtering costs nothing.
   */
  async listReminderDue(now: Date): Promise<readonly Deadline[]> {
    const at = toInstant(new Date(now.getTime()));
    const result = await this.#database.prepare(
      `SELECT * FROM deadlines
       WHERE status = 'open' AND reminded_at IS NULL AND due_at > ?
       ORDER BY due_at, deadline_id`,
    ).bind(at).all<DeadlineRow>();
    const milliseconds = new Date(at).getTime();
    return Object.freeze(
      result.results
        .map(toDeadline)
        .filter((deadline) => new Date(deadline.dueAt).getTime() - deadline.leadMinutes * 60_000 <= milliseconds),
    );
  }

  /**
   * Open deadlines this source did not produce in the sweep that ran at
   * `observedAt`. Every sighting advances `last_seen_at` to the sweep's
   * timestamp, so anything still behind it was not seen.
   */
  async listOpenNotSeenSince(sourceId: string, observedAt: Date | string): Promise<readonly Deadline[]> {
    const at = instantOf(observedAt, "deadline_observed_at");
    const result = await this.#database.prepare(
      `SELECT * FROM deadlines
       WHERE source_id = ? AND status = 'open' AND last_seen_at < ?
       ORDER BY due_at, deadline_id`,
    ).bind(sourceId, at).all<DeadlineRow>();
    return Object.freeze(result.results.map(toDeadline));
  }

  /** Monotonic: a later mark wins, an earlier one is ignored, and a replay changes nothing. */
  async markReminded(deadlineId: string, now: Date): Promise<boolean> {
    const at = toInstant(new Date(now.getTime()));
    const result = await this.#database.prepare(
      "UPDATE deadlines SET reminded_at = ? WHERE deadline_id = ? AND (reminded_at IS NULL OR reminded_at < ?)",
    ).bind(at, deadlineId, at).run();
    return result.meta.changes > 0;
  }

  async createQuietWindow(input: CreateQuietWindowInput): Promise<QuietWindow> {
    const windowId = newUlid();
    const startsAt = instantOf(input.startsAt, "quiet_window_starts_at");
    const endsAt = instantOf(input.endsAt, "quiet_window_ends_at");
    if (endsAt <= startsAt) throw new TypeError("quiet_window_span_invalid");
    const createdAt = toInstant(new Date(input.now.getTime()));
    const deadlineId = input.reason === "exam"
      ? requireText(input.deadlineId, "quiet_window_deadline_id", MAXIMUM_IDENTIFIER_CHARACTERS)
      : null;
    await this.#database.prepare(
      `INSERT INTO quiet_windows (window_id, reason, deadline_id, starts_at, ends_at, created_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(windowId, input.reason, deadlineId, startsAt, endsAt, createdAt).run();
    const created = await this.readQuietWindow(windowId);
    if (created === null) throw new Error("quiet_window_write_failed");
    return created;
  }

  async readQuietWindow(windowId: string): Promise<QuietWindow | null> {
    const row = await this.#database.prepare("SELECT * FROM quiet_windows WHERE window_id = ?")
      .bind(windowId).first<QuietWindowRow>();
    return row === null ? null : toQuietWindow(row);
  }

  /**
   * Live windows overlapping `[from, to)`. A window that started yesterday and
   * ends this afternoon is live now, so the comparison is an overlap and not a
   * containment -- containment would miss exactly the window you are inside.
   */
  async listQuietWindows(input: { readonly from: Date | string; readonly to: Date | string }): Promise<readonly QuietWindow[]> {
    const from = instantOf(input.from, "quiet_window_from");
    const to = instantOf(input.to, "quiet_window_to");
    const result = await this.#database.prepare(
      `SELECT * FROM quiet_windows
       WHERE cancelled_at IS NULL AND starts_at < ? AND ends_at > ?
       ORDER BY starts_at, window_id`,
    ).bind(to, from).all<QuietWindowRow>();
    return Object.freeze(result.results.map(toQuietWindow));
  }

  /** Live windows derived from one deadline. Used to keep derivation idempotent. */
  async listQuietWindowsForDeadline(deadlineId: string): Promise<readonly QuietWindow[]> {
    const result = await this.#database.prepare(
      `SELECT * FROM quiet_windows
       WHERE deadline_id = ? AND cancelled_at IS NULL
       ORDER BY starts_at, window_id`,
    ).bind(deadlineId).all<QuietWindowRow>();
    return Object.freeze(result.results.map(toQuietWindow));
  }

  /** Cancels rather than deletes: a window that was in force is part of why a message was late. */
  async cancelQuietWindow(windowId: string, now: Date): Promise<boolean> {
    const at = toInstant(new Date(now.getTime()));
    const result = await this.#database.prepare(
      "UPDATE quiet_windows SET cancelled_at = ? WHERE window_id = ? AND cancelled_at IS NULL",
    ).bind(at, windowId).run();
    return result.meta.changes > 0;
  }

  #readRow(sourceId: string, externalId: string): Promise<DeadlineRow | null> {
    return this.#database.prepare("SELECT * FROM deadlines WHERE source_id = ? AND external_id = ?")
      .bind(sourceId, externalId).first<DeadlineRow>();
  }

  async #requireDeadline(deadlineId: string): Promise<Deadline> {
    const deadline = await this.readDeadline(deadlineId);
    if (deadline === null) throw new Error("deadline_write_failed");
    return deadline;
  }
}

/**
 * Bound a failure reason to what the column accepts.
 *
 * Sliced by code unit and then repaired, because slicing can land in the
 * middle of a surrogate pair and produce a lone surrogate -- which is not the
 * failure we were trying to record and would be a puzzling one to debug.
 */
export function truncateFailure(failure: string): string {
  const normalized = failure.normalize("NFC").trim();
  const reason = normalized.length === 0 ? "unspecified" : normalized;
  if (reason.length <= MAXIMUM_FAILURE_CHARACTERS) return reason;
  const sliced = reason.slice(0, MAXIMUM_FAILURE_CHARACTERS);
  return sliced.isWellFormed() ? sliced : sliced.slice(0, -1);
}
