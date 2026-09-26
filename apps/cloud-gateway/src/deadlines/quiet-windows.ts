/**
 * Quiet windows: a window in which non-urgent traffic is held.
 *
 * Windows are created by hand (the `/quiet` command) or by a caller that has a
 * reason code. There is deliberately no derivation from a deadline's effort any
 * more: code used to turn every `exam`-tagged deadline into a window around its
 * due instant, which made a category column decide when messages were held.
 * That category is gone, and so is the derivation.
 *
 * The critical property that remains is that suppression is decided per message
 * class and never per channel. Silencing the channel would silence the
 * error-log alert that says the gateway is down and the notice that a supplier
 * payment failed, and it would do it during the three hours he is least able to
 * notice. So the classes that pass are an explicit list in this file, not a
 * boolean the caller hands in -- a caller-supplied "this one is urgent" is a
 * decision made at hundreds of call sites by whoever wrote each of them, and
 * the first one that gets it wrong is silent.
 */

import type { DeadlineRepository } from "./deadline-repository.js";
import { instantOf, type QuietWindow } from "./deadline-types.js";

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
 * `deadline_reminder` is deliberately absent: a reminder about Thursday's essay
 * arriving during Wednesday's exam is exactly the interruption the window
 * exists to prevent.
 */
export const QUIET_WINDOW_PASSING_CLASSES: ReadonlySet<MessageClass> = new Set<MessageClass>([
  "error_alert", "payment",
]);

export interface QuietWindowServiceOptions {
  readonly repository: DeadlineRepository;
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

  constructor(options: QuietWindowServiceOptions) {
    this.#repository = options.repository;
  }

  /**
   * The stored answer for one instant and one class.
   *
   * Only windows live at `at` are loaded -- the range is the instant itself --
   * so this stays one indexed read no matter how many windows have accumulated.
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
