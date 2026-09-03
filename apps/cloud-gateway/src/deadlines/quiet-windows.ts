/**
 * Exam-mode quiet hours.
 *
 * Two halves. Derivation turns exam-tagged deadlines into stored windows;
 * suppression answers, for one instant and one class of message, whether that
 * message waits.
 *
 * The critical property is that suppression is decided per message class and
 * never per channel. Silencing the channel would silence the error-log alert
 * that says the gateway is down and the notice that a supplier payment failed,
 * and it would do it during the three hours he is least able to notice. So the
 * classes that pass are an explicit list in this file, not a boolean the
 * caller hands in -- a caller-supplied "this one is urgent" is a decision made
 * at hundreds of call sites by whoever wrote each of them, and the first one
 * that gets it wrong is silent.
 */

import type { DeadlineRepository } from "./deadline-repository.js";
import { instantOf, toInstant, type Deadline, type QuietWindow } from "./deadline-types.js";

/**
 * Every kind of message the assistant sends. Exhaustive on purpose: a new kind
 * of message must be named here before it can be sent, which is what forces
 * someone to decide whether it is urgent instead of inheriting an answer.
 */
export type MessageClass =
  | "error_alert"
  | "payment"
  | "deadline_reminder"
  | "business_digest"
  | "business_ping"
  | "project_nudge";

export const MESSAGE_CLASSES: readonly MessageClass[] = Object.freeze([
  "error_alert", "payment", "deadline_reminder", "business_digest", "business_ping", "project_nudge",
]);

/**
 * The classes a quiet window does not hold.
 *
 * `error_alert` is the watchdog and the error log: if the system is broken,
 * the window is the worst possible time to find out late.
 *
 * `payment` is anything payment-critical -- a failed charge, a supplier
 * deadline. Money that stops moving does not resume because he was in an exam.
 *
 * `deadline_reminder` is deliberately absent, which surprises people. A
 * reminder about Thursday's essay arriving during Wednesday's exam is exactly
 * the interruption the window exists to prevent, and it is the one message he
 * can do nothing about while sitting in the room.
 */
export const QUIET_WINDOW_PASSING_CLASSES: ReadonlySet<MessageClass> = new Set<MessageClass>([
  "error_alert", "payment",
]);

/**
 * How far around an exam's due instant the window reaches.
 *
 * The schema stores when an exam is, not how long it lasts, and no source
 * tells us -- so this is a fixed span rather than a measured one, and it is
 * biased to cover the whole sitting rather than to end in the middle of it.
 * An hour before is the walk in and the last review; three hours after covers
 * a normal secondary-school exam block.
 */
export const EXAM_WINDOW_STARTS_BEFORE_MINUTES = 60;
export const EXAM_WINDOW_ENDS_AFTER_MINUTES = 180;

export type ExamWindowOutcome = "created" | "moved" | "unchanged";

export interface DerivedExamWindow {
  readonly deadline: Deadline;
  readonly window: QuietWindow;
  readonly outcome: ExamWindowOutcome;
}

export interface QuietWindowServiceOptions {
  readonly repository: DeadlineRepository;
  readonly now?: () => Date;
  readonly startsBeforeMinutes?: number;
  readonly endsAfterMinutes?: number;
}

function requireMessageClass(value: unknown): MessageClass {
  // A class nobody classified must not be resolved by a default. Suppressing it
  // silently holds a message that may be the one that mattered; passing it
  // silently defeats the window. Either way nothing observable says a decision
  // was skipped, so the omission is refused where it can still be seen.
  if (typeof value !== "string" || !MESSAGE_CLASSES.includes(value as MessageClass)) {
    throw new TypeError("quiet_window_message_class_invalid");
  }
  return value as MessageClass;
}

/**
 * Is this message held?
 *
 * Pure, so the decision can be tested without a database and stated without
 * one. Windows are half-open, `[startsAt, endsAt)`: a message at the exact
 * instant a window ends is not in it, and back-to-back windows neither overlap
 * nor leave a gap.
 */
export function isSuppressed(input: {
  readonly at: Date | string;
  readonly messageClass: MessageClass;
  readonly windows: readonly QuietWindow[];
}): boolean {
  const at = instantOf(input.at, "quiet_window_at");
  const messageClass = requireMessageClass(input.messageClass);
  const covered = input.windows.some(
    (window) => window.cancelledAt === null && window.startsAt <= at && at < window.endsAt,
  );
  if (!covered) return false;
  return !QUIET_WINDOW_PASSING_CLASSES.has(messageClass);
}

export class QuietWindowService {
  readonly #repository: DeadlineRepository;
  readonly #now: () => Date;
  readonly #startsBefore: number;
  readonly #endsAfter: number;

  constructor(options: QuietWindowServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#startsBefore = options.startsBeforeMinutes ?? EXAM_WINDOW_STARTS_BEFORE_MINUTES;
    this.#endsAfter = options.endsAfterMinutes ?? EXAM_WINDOW_ENDS_AFTER_MINUTES;
    if (!Number.isSafeInteger(this.#startsBefore) || this.#startsBefore < 0) throw new TypeError("quiet_window_span_invalid");
    if (!Number.isSafeInteger(this.#endsAfter) || this.#endsAfter <= 0) throw new TypeError("quiet_window_span_invalid");
  }

  /**
   * Create or correct the quiet window for every exam due in `[from, to)`.
   *
   * Idempotent, because it runs after every sweep: an exam whose window
   * already matches is left alone. When an exam's date moves the old window is
   * cancelled rather than edited, and a new one created -- the old window was
   * in force, messages were held by it, and rewriting its bounds would make
   * the record disagree with what actually happened.
   */
  async deriveExamWindows(input: { readonly from: Date | string; readonly to: Date | string }): Promise<readonly DerivedExamWindow[]> {
    const now = new Date(toInstant(this.#now()));
    const exams = await this.#repository.listDueWithin({ from: input.from, to: input.to, efforts: ["exam"] });
    const derived: DerivedExamWindow[] = [];

    for (const deadline of exams) {
      const due = new Date(deadline.dueAt).getTime();
      const startsAt = new Date(due - this.#startsBefore * 60_000).toISOString();
      const endsAt = new Date(due + this.#endsAfter * 60_000).toISOString();

      const existing = await this.#repository.listQuietWindowsForDeadline(deadline.deadlineId);
      const matching = existing.find((window) => window.startsAt === startsAt && window.endsAt === endsAt);
      if (matching !== undefined) {
        derived.push(Object.freeze({ deadline, window: matching, outcome: "unchanged" as const }));
        continue;
      }

      for (const stale of existing) await this.#repository.cancelQuietWindow(stale.windowId, now);
      const window = await this.#repository.createQuietWindow({
        reason: "exam",
        deadlineId: deadline.deadlineId,
        startsAt,
        endsAt,
        now,
      });
      derived.push(Object.freeze({
        deadline,
        window,
        outcome: existing.length === 0 ? "created" as const : "moved" as const,
      }));
    }

    return Object.freeze(derived);
  }

  /**
   * The stored answer for one instant and one class.
   *
   * Only windows live at `at` are loaded -- the range is the instant itself --
   * so this stays one indexed read no matter how many terms of exams have
   * accumulated.
   */
  async isSuppressed(at: Date | string, messageClass: MessageClass): Promise<boolean> {
    const instant = instantOf(at, "quiet_window_at");
    // Validated before the read so a bad class fails the same way whether or
    // not a window happens to be in force. Otherwise the check has a hole
    // exactly when nothing is being suppressed, which is most of the time and
    // is when every test would be written.
    const validated = requireMessageClass(messageClass);
    const windows = await this.#repository.listQuietWindows({
      from: instant,
      to: new Date(new Date(instant).getTime() + 1).toISOString(),
    });
    return isSuppressed({ at: instant, messageClass: validated, windows });
  }
}
