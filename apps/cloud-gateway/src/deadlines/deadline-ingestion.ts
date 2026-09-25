/**
 * Ingestion: take one sweep's worth of normalized items from any source,
 * classify them, write them, and say what happened.
 *
 * The report is the product. A sweep that quietly succeeds tells nobody
 * anything; what the digest needs is the three things that changed -- what is
 * new, what moved, and what stopped appearing -- and the plan's rule that a
 * failed sync must alert rather than read as "nothing due".
 *
 * The caller owns the fetching, and hands the outcome in rather than the
 * items alone. That distinction is the whole safety property here: this code
 * cannot tell an empty result from a broken one by looking at it, and a source
 * that returns zero items is exactly what a half-broken scraper returns.
 * Making the caller say which it was is the only way the difference survives.
 *
 * Titles arriving here are untrusted. They are normalized, bounded and bound
 * into SQL as parameters; nothing here reads one to decide what the work is.
 * Nothing in this file composes a title into a prompt, a path, or a pattern.
 */

import { DEFAULT_LEAD_MINUTES } from "./effort-lead-times.js";
import type { DeadlineRepository } from "./deadline-repository.js";
import { truncateFailure } from "./deadline-repository.js";
import {
  requireLeadMinutes,
  toInstant,
  type Deadline,
  type DeadlineEffort,
  type RawDeadlineItem,
} from "./deadline-types.js";

const MAXIMUM_TITLE_CHARACTERS = 512;
const MAXIMUM_IDENTIFIER_CHARACTERS = 256;

/**
 * What a source's sweep produced.
 *
 * `failed` is not an error the caller swallowed -- it is a first-class result
 * that gets written to `deadline_sources.last_failure`, which is the only
 * place anything downstream can learn that today's silence is a fault rather
 * than a quiet week.
 */
export type SourceSweep =
  | {
    readonly kind: "items";
    readonly items: readonly RawDeadlineItem[];
    readonly cancelledExternalIds?: readonly string[];
    readonly sourceRejectedCount?: number;
    /** Valid source items omitted by a caller's bounded window. */
    readonly sourceTruncatedCount?: number;
  }
  | { readonly kind: "failed"; readonly reason: string };

export type RejectionReason =
  | "missing_external_id"
  | "missing_course"
  | "missing_title"
  | "invalid_due_at"
  | "invalid_effort"
  | "invalid_lead_minutes"
  | "duplicate_external_id"
  | "invalid_source_item";

export interface RejectedDeadlineItem {
  /** Present when we could read one; a rejected item may not have had a usable id. */
  readonly externalId: string | null;
  readonly reason: RejectionReason;
}

export interface MovedDeadline {
  readonly deadline: Deadline;
  readonly previousDueAt: string;
  readonly previousTitle: string;
  /** True when the date itself moved, as opposed to a title or course correction. */
  readonly dueDateMoved: boolean;
}

export interface DeadlineIngestionReport {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly outcome: "synced" | "failed";
  readonly failure: string | null;
  readonly created: readonly Deadline[];
  readonly moved: readonly MovedDeadline[];
  readonly cancelled: readonly Deadline[];
  readonly unchanged: number;
  /**
   * Open deadlines this source did not mention. Reported, never written to.
   * See the note on `ingest`.
   */
  readonly disappeared: readonly Deadline[];
  readonly rejected: readonly RejectedDeadlineItem[];
  /** Valid source items deliberately omitted to keep the sweep bounded. */
  readonly truncatedCount: number;
  /**
   * A sweep that succeeded and returned nothing while open deadlines still
   * stand. Flagged rather than acted on, because it is what both "term ended"
   * and "the scrape broke without erroring" look like.
   */
  readonly emptySweep: boolean;
}

export interface DeadlineIngestionOptions {
  readonly repository: DeadlineRepository;
  readonly now?: () => Date;
}

interface NormalizedItem {
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly effort: DeadlineEffort | null;
  readonly leadMinutes: number | null;
}

const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;
const UNSAFE_IDENTIFIER_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const WHITESPACE_RUN = /\s+/gu;
const EFFORTS: readonly DeadlineEffort[] = Object.freeze(["quiz", "test", "exam", "essay", "project", "other"]);

/**
 * Flatten a title to one line of stored text.
 *
 * Control and format characters go first. A scraped title can carry a
 * right-to-left override or a zero-width joiner picked up from page markup,
 * and those change how the title renders in a Telegram message without
 * changing anything a reader can see coming.
 */
function normalizeTitle(value: string): string {
  const flattened = value
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  if (flattened.length <= MAXIMUM_TITLE_CHARACTERS) return flattened;
  // Truncated rather than rejected. A title this long is a scraper that took
  // the page instead of the heading, and dropping the deadline over it would
  // lose a real assignment to a display bug. The identity of a deadline is
  // (source, external id), which truncation does not touch, and truncation is
  // deterministic -- so the next sweep hashes to the same value and does not
  // record a phantom revision.
  const sliced = flattened.slice(0, MAXIMUM_TITLE_CHARACTERS);
  return sliced.isWellFormed() ? sliced : sliced.slice(0, -1);
}

function normalizeItem(item: RawDeadlineItem): { ok: true; value: NormalizedItem } | { ok: false; rejection: RejectedDeadlineItem } {
  const externalIdRaw = typeof item.externalId === "string" ? item.externalId.trim() : "";
  const externalId = externalIdRaw.normalize("NFC");
  if (
    externalId.length === 0
    || externalId.length > MAXIMUM_IDENTIFIER_CHARACTERS
    || !externalId.isWellFormed()
    || UNSAFE_IDENTIFIER_CHARACTERS.test(externalId)
  ) {
    return { ok: false, rejection: { externalId: null, reason: "missing_external_id" } };
  }

  const course = typeof item.course === "string" ? normalizeTitle(item.course) : "";
  if (course.length === 0) return { ok: false, rejection: { externalId, reason: "missing_course" } };

  const title = typeof item.title === "string" ? normalizeTitle(item.title) : "";
  if (title.length === 0) return { ok: false, rejection: { externalId, reason: "missing_title" } };

  if (typeof item.dueAt !== "string" || !UTC_MILLISECONDS.test(item.dueAt)) {
    return { ok: false, rejection: { externalId, reason: "invalid_due_at" } };
  }
  const parsed = new Date(item.dueAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== item.dueAt) {
    return { ok: false, rejection: { externalId, reason: "invalid_due_at" } };
  }

  let effort: DeadlineEffort | null = null;
  if (item.effort !== undefined) {
    if (!EFFORTS.includes(item.effort)) return { ok: false, rejection: { externalId, reason: "invalid_effort" } };
    effort = item.effort;
  }

  let leadMinutes: number | null = null;
  if (item.leadMinutes !== undefined) {
    try {
      leadMinutes = requireLeadMinutes(item.leadMinutes);
    } catch {
      return { ok: false, rejection: { externalId, reason: "invalid_lead_minutes" } };
    }
  }

  return { ok: true, value: { externalId, course, title, dueAt: item.dueAt, effort, leadMinutes } };
}

export class DeadlineIngestion {
  readonly #repository: DeadlineRepository;
  readonly #now: () => Date;

  constructor(options: DeadlineIngestionOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Ingest one sweep.
   *
   * On what happens to a deadline that stops appearing: nothing. It stays
   * `open`, it stays due, and `last_seen_at` stays frozen at the last sweep
   * that saw it. It is named in the report and written to nowhere.
   *
   * Marking it cancelled is the obvious alternative and it is unsafe, for a
   * reason that has nothing to do with teachers deleting assignments. A
   * Brightspace feed that half-succeeds because the upstream export changes
   * returns fewer items, and from in here that is indistinguishable from a
   * teacher removing them. One bad feed would cancel a term of real
   * deadlines, and the owner would find out by missing them. An open deadline
   * that no longer exists costs him a reminder he dismisses; a cancelled one
   * that does exist costs him the assignment. The asymmetry decides it.
   *
   * `last_seen_at` is what keeps that recoverable rather than merely safe: the
   * digest can say "not seen since Tuesday" and let the one party who actually
   * knows whether the assignment still exists be the one to close it.
   */
  async ingest(sourceId: string, sweep: SourceSweep): Promise<DeadlineIngestionReport> {
    // Sampled once and immediately reduced to text. Every timestamp this sweep
    // writes is the same instant, which is what makes `last_seen_at < observedAt`
    // an exact statement about one sweep rather than about a few milliseconds.
    const observedAt = toInstant(this.#now());
    const now = new Date(observedAt);

    // Both of the writes below are conditional UPDATEs, so an unknown source id
    // makes them no-ops and the report would claim a sync that reached nothing.
    // A sweep against a source that does not exist is a wiring error, and it
    // has to be loud: the alternative is a source that appears healthy forever
    // because nothing was ever recorded against it.
    if (await this.#repository.readSource(sourceId) === null) throw new TypeError("deadline_source_unknown");

    if (sweep.kind === "failed") {
      const failure = truncateFailure(sweep.reason);
      await this.#repository.recordSourceFailure(sourceId, failure, now);
      // Deliberately no disappearance computation. A failed sweep saw nothing,
      // so everything would appear to have disappeared -- which is the exact
      // reading this subsystem exists to refuse.
      return Object.freeze({
        sourceId,
        observedAt,
        outcome: "failed" as const,
        failure,
        created: Object.freeze([]),
        moved: Object.freeze([]),
        cancelled: Object.freeze([]),
        unchanged: 0,
        disappeared: Object.freeze([]),
        rejected: Object.freeze([]),
        truncatedCount: 0,
        emptySweep: false,
      });
    }

    const created: Deadline[] = [];
    const moved: MovedDeadline[] = [];
    const cancelled: Deadline[] = [];
    const rejected: RejectedDeadlineItem[] = [];
    const seen = new Set<string>();
    let unchanged = 0;

    const sourceRejectedCount = sweep.sourceRejectedCount ?? 0;
    if (!Number.isSafeInteger(sourceRejectedCount) || sourceRejectedCount < 0 || sourceRejectedCount > 2_000) {
      throw new TypeError("deadline_source_rejected_count_invalid");
    }
    for (let index = 0; index < sourceRejectedCount; index += 1) {
      rejected.push(Object.freeze({ externalId: null, reason: "invalid_source_item" as const }));
    }
    const sourceTruncatedCount = sweep.sourceTruncatedCount ?? 0;
    if (!Number.isSafeInteger(sourceTruncatedCount) || sourceTruncatedCount < 0 || sourceTruncatedCount > 2_000) {
      throw new TypeError("deadline_source_truncated_count_invalid");
    }

    try {
      for (const raw of sweep.items) {
        const normalized = normalizeItem(raw);
        if (!normalized.ok) {
          rejected.push(Object.freeze(normalized.rejection));
          continue;
        }
        const item = normalized.value;
        // Two items claiming one external id inside a single sweep: the second
        // would overwrite the first and the report would call both ingested.
        // Reported instead, because a source emitting duplicate ids is a bug at
        // that end that nothing else will surface.
        if (seen.has(item.externalId)) {
          rejected.push(Object.freeze({ externalId: item.externalId, reason: "duplicate_external_id" as const }));
          continue;
        }
        seen.add(item.externalId);

        // Nothing here derives an effort from the title. A source tag is the
        // source's own assertion; otherwise the row is `other` and stays
        // unjudged until the model judges it through `deadline_judge`. Choosing
        // a category from the title's words would be this code making Jarvis's
        // decision.
        const effort = item.effort ?? "other";
        const result = await this.#repository.upsert({
          sourceId,
          externalId: item.externalId,
          course: item.course,
          title: item.title,
          dueAt: item.dueAt,
          effort,
          leadMinutes: item.leadMinutes ?? DEFAULT_LEAD_MINUTES[effort],
          now,
        });

        if (result.outcome === "created") created.push(result.deadline);
        else if (result.outcome === "revised" && result.previous !== null) {
          moved.push(Object.freeze({
            deadline: result.deadline,
            previousDueAt: result.previous.dueAt,
            previousTitle: result.previous.title,
            dueDateMoved: result.previous.dueAt !== result.deadline.dueAt,
          }));
        } else unchanged += 1;
      }

      for (const rawExternalId of sweep.cancelledExternalIds ?? []) {
        const normalized = normalizeIdentifier(rawExternalId);
        if (normalized === null) {
          rejected.push(Object.freeze({ externalId: null, reason: "missing_external_id" as const }));
          continue;
        }
        if (seen.has(normalized)) {
          rejected.push(Object.freeze({ externalId: normalized, reason: "duplicate_external_id" as const }));
          continue;
        }
        seen.add(normalized);
        const closed = await this.#repository.cancelOpenByExternalId(sourceId, normalized, now);
        if (closed !== null) cancelled.push(closed);
      }
    } catch (error) {
      // The failure column is the alert channel. A write that throws halfway
      // through must not leave the source looking like it last succeeded just
      // now -- the caller may well log the exception and move on, and then the
      // only durable trace of the fault would be gone.
      await this.#repository.recordSourceFailure(sourceId, `ingest_write_failed: ${describe(error)}`, now);
      throw error;
    }

    const disappeared = await this.#repository.listOpenNotSeenSince(sourceId, observedAt);
    await this.#repository.recordSourceSuccess(
      sourceId,
      now,
      sourceTruncatedCount === 0 ? null : `source_items_truncated:${sourceTruncatedCount}`,
    );

    return Object.freeze({
      sourceId,
      observedAt,
      outcome: "synced" as const,
      failure: null,
      created: Object.freeze(created),
      moved: Object.freeze(moved),
      cancelled: Object.freeze(cancelled),
      unchanged,
      disappeared,
      rejected: Object.freeze(rejected),
      truncatedCount: sourceTruncatedCount,
      emptySweep: sweep.items.length === 0 && (sweep.cancelledExternalIds?.length ?? 0) === 0 && disappeared.length > 0,
    });
  }
}

function normalizeIdentifier(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.normalize("NFC");
  return normalized.length > 0
    && normalized.length <= MAXIMUM_IDENTIFIER_CHARACTERS
    && normalized.isWellFormed()
    && !UNSAFE_IDENTIFIER_CHARACTERS.test(normalized)
    ? normalized
    : null;
}

/** A short, bounded description of a thrown value, for the failure column. */
function describe(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") return error.message;
  return "unknown";
}
