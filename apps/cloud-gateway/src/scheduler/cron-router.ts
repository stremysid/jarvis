/**
 * Which jobs a cron firing should run.
 *
 * Kept pure and separate from the handler because the interesting part is a
 * calendar question, not an I/O one: Cloudflare crons fire on UTC and have no
 * notion of a timezone, so a fixed UTC hour lands on two different local
 * hours across the year. The morning digest is supposed to arrive at the same
 * local time in November as in July.
 *
 * The fix is to fire the daily trigger at two UTC hours and let exactly one of
 * them match the target local hour. Which one matches changes at the
 * daylight-saving boundary and neither the cron nor this module has to know
 * when that boundary is -- `Intl` already does.
 *
 * Triggers are at-least-once, so every job here is keyed by something a
 * repeat would collide on. The router produces the key; the caller is
 * responsible for refusing a key it has already recorded.
 */

import { localDate, localWeekday } from "../digest/digest-composer.js";

/** Every five minutes. Work that is already owed and cheap to retry. */
export const DRAIN_CRON = "*/5 * * * *";
/** Hourly. Reaching out to other people's systems. */
export const POLL_CRON = "0 * * * *";
/**
 * Twice daily, an hour apart. One of the two lands on the target local hour
 * whichever side of the daylight-saving boundary the date falls.
 */
export const DAILY_CRON = "30 11,12 * * *";

/** 07:30 local, the hour the plan fixes the morning rhythm to. */
const DIGEST_LOCAL_HOUR = 7;

/** Sunday evening, per the plan. Local hour, same reasoning as the digest. */
const RETRO_LOCAL_HOUR = 19;
const RETRO_CRON = "30 23,0 * * *";

export type ScheduledJob = "drain" | "poll" | "digest" | "retro";

export interface ScheduledWork {
  readonly job: ScheduledJob;
  /**
   * What a repeat of this run would collide on. A daily job is keyed by the
   * owner's local date, so a retry twenty minutes later is recognised as the
   * same run rather than as a second morning.
   */
  readonly runKey: string;
}

function localHour(instant: Date, timeZone: string): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(instant);
  // `en-US` with hour12: false renders midnight as "24" in some ICU versions
  // and "0" in others. Both mean the same instant, and normalising here is
  // cheaper than depending on which one this runtime ships.
  const hour = Number.parseInt(value, 10);
  return Number.isNaN(hour) ? -1 : hour % 24;
}

/**
 * Decide what this firing should do.
 *
 * An unrecognised cron expression returns nothing rather than falling back to
 * a default job. A cron that was added to the configuration and not to this
 * router is a mistake, and running the wrong job is a worse way to find out
 * than running none.
 */
export function routeCron(
  cron: string,
  instant: Date,
  timeZone: string,
): readonly ScheduledWork[] {
  if (cron === DRAIN_CRON) {
    // Keyed to the minute. Two firings inside one minute is a retry, not two
    // separate drains.
    return [{ job: "drain", runKey: instant.toISOString().slice(0, 16) }];
  }

  if (cron === POLL_CRON) {
    return [{ job: "poll", runKey: instant.toISOString().slice(0, 13) }];
  }

  if (cron === DAILY_CRON) {
    // Only the firing that lands on the target local hour does anything. The
    // other one is a deliberate no-op and costs a few milliseconds a day.
    if (localHour(instant, timeZone) !== DIGEST_LOCAL_HOUR) return [];
    return [{ job: "digest", runKey: localDate(instant, timeZone) }];
  }

  if (cron === RETRO_CRON) {
    if (localHour(instant, timeZone) !== RETRO_LOCAL_HOUR) return [];
    // Sunday in the owner's week, not in UTC's. Late Sunday evening in
    // Toronto is already Monday in UTC, and keying off the UTC day would send
    // the retro on the wrong evening for half of every year.
    if (localWeekday(instant, timeZone) !== 0) return [];
    return [{ job: "retro", runKey: localDate(instant, timeZone) }];
  }

  return [];
}

/** Every cron this router understands, for the deploy configuration to match. */
export const ROUTED_CRONS: readonly string[] = Object.freeze([
  DRAIN_CRON,
  POLL_CRON,
  DAILY_CRON,
  RETRO_CRON,
]);
