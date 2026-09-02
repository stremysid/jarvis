import { describe, expect, it } from "vitest";
import {
  DAILY_CRON,
  DRAIN_CRON,
  POLL_CRON,
  ROUTED_CRONS,
  routeCron,
} from "../../src/scheduler/cron-router.js";

/**
 * The whole reason this module exists is that a fixed UTC hour is not a fixed
 * local hour.
 *
 * So the tests that matter are the ones that pin a firing on each side of the
 * daylight-saving boundary and assert the digest goes out once, at the same
 * local time, both times. A test that only checks July would pass against a
 * router that ignored the timezone entirely.
 */

const TORONTO = "America/Toronto";
const RETRO_CRON = "30 23,0 * * *";

function jobs(cron: string, iso: string, zone = TORONTO): string[] {
  return routeCron(cron, new Date(iso), zone).map((work) => work.job);
}

describe("the cron list and the router agree", () => {
  it("routes every cron it claims to route", () => {
    for (const cron of ROUTED_CRONS) {
      // Sampled across a day so a time-gated job is not counted absent purely
      // because this one instant did not match its local hour.
      const matched = [
        "2026-07-15T00:30:00.000Z",
        "2026-07-15T04:00:00.000Z",
        "2026-07-15T11:30:00.000Z",
        "2026-07-15T12:30:00.000Z",
        "2026-07-12T23:30:00.000Z",
        "2026-07-13T00:30:00.000Z",
      ].some((instant) => routeCron(cron, new Date(instant), TORONTO).length > 0);
      expect(matched, `${cron} routed nothing all day`).toBe(true);
    }
  });

  it("runs nothing for a cron it does not recognise", () => {
    // A trigger added to wrangler.toml and not here should do nothing rather
    // than fall through to some default job.
    expect(routeCron("15 3 * * *", new Date("2026-07-15T03:15:00.000Z"), TORONTO)).toEqual([]);
  });
});

describe("the frequent cadences", () => {
  it("drains on the five-minute tick", () => {
    expect(jobs(DRAIN_CRON, "2026-09-02T14:05:00.000Z")).toEqual(["drain"]);
  });

  it("polls on the hour", () => {
    expect(jobs(POLL_CRON, "2026-09-02T14:00:00.000Z")).toEqual(["poll"]);
  });

  it("keys a drain to the minute so a retry is recognised as the same run", () => {
    // Triggers are at-least-once. Two firings inside one minute are a retry,
    // and a key that distinguished them would let the retry do the work twice.
    const first = routeCron(DRAIN_CRON, new Date("2026-09-02T14:05:00.000Z"), TORONTO);
    const retry = routeCron(DRAIN_CRON, new Date("2026-09-02T14:05:41.000Z"), TORONTO);
    expect(retry[0]?.runKey).toBe(first[0]?.runKey);
  });

  it("keys separate minutes apart so a later tick is not mistaken for a retry", () => {
    const first = routeCron(DRAIN_CRON, new Date("2026-09-02T14:05:00.000Z"), TORONTO);
    const later = routeCron(DRAIN_CRON, new Date("2026-09-02T14:10:00.000Z"), TORONTO);
    expect(later[0]?.runKey).not.toBe(first[0]?.runKey);
  });
});

describe("the daily digest across the daylight-saving boundary", () => {
  it("goes out on the 11:30 firing in July, when Toronto is UTC-4", () => {
    // 11:30 UTC is 07:30 local in daylight time.
    expect(jobs(DAILY_CRON, "2026-07-15T11:30:00.000Z")).toEqual(["digest"]);
    expect(jobs(DAILY_CRON, "2026-07-15T12:30:00.000Z")).toEqual([]);
  });

  it("goes out on the 12:30 firing in December, when Toronto is UTC-5", () => {
    // The other half of the year the SAME local hour is an hour later in UTC.
    // A single fixed cron would deliver at 06:30 local here.
    expect(jobs(DAILY_CRON, "2026-12-15T12:30:00.000Z")).toEqual(["digest"]);
    expect(jobs(DAILY_CRON, "2026-12-15T11:30:00.000Z")).toEqual([]);
  });

  it("goes out from the firing an hour later in winter than in summer", () => {
    // Counting the firings is not enough. A router with a frozen UTC-4 offset
    // also fires exactly once a day all year -- it just fires at 06:30 local
    // in December, which is the entire bug. So the assertion is on WHICH
    // firing produced it.
    const firedAt = (day: string): string[] =>
      ["11:30", "12:30"].filter(
        (time) => routeCron(DAILY_CRON, new Date(`${day}T${time}:00.000Z`), TORONTO).length > 0,
      );
    expect(firedAt("2026-07-15")).toEqual(["11:30"]);
    expect(firedAt("2026-12-15")).toEqual(["12:30"]);
  });

  it("keys the digest to the local date so a retry does not send a second morning", () => {
    const run = routeCron(DAILY_CRON, new Date("2026-07-15T11:30:00.000Z"), TORONTO);
    expect(run[0]?.runKey).toBe("2026-07-15");
  });
});

describe("the Sunday retro", () => {
  it("goes out on Sunday evening in the owner's week, not UTC's", () => {
    // 23:30 UTC on Sunday the 6th is 19:30 Sunday in Toronto -- but the UTC
    // date has not rolled over yet, so this is the firing that should count.
    expect(jobs(RETRO_CRON, "2026-09-06T23:30:00.000Z")).toEqual(["retro"]);
  });

  it("does not go out on a Saturday", () => {
    expect(jobs(RETRO_CRON, "2026-09-05T23:30:00.000Z")).toEqual([]);
  });

  it("does not go out twice when the second firing is already Monday in UTC", () => {
    // 00:30 UTC Monday is 20:30 Sunday in Toronto. That is the wrong local
    // hour, so it must be discarded -- otherwise the retro sends twice in
    // daylight time.
    expect(jobs(RETRO_CRON, "2026-09-07T00:30:00.000Z")).toEqual([]);
  });

  it("goes out from the firing an hour later in winter than in summer", () => {
    // Same reasoning as the digest: a frozen offset also produces exactly one
    // retro per week, on the wrong evening hour. The assertion has to name the
    // firing, not count them. 2026-07-12 and 2026-12-13 are both Sundays.
    const firedAt = (saturday: string, sunday: string, monday: string): string[] =>
      [
        `${saturday}T23:30:00.000Z`,
        `${sunday}T00:30:00.000Z`,
        `${sunday}T23:30:00.000Z`,
        `${monday}T00:30:00.000Z`,
      ].filter((instant) => routeCron(RETRO_CRON, new Date(instant), TORONTO).length > 0);

    // In daylight time 23:30 UTC Sunday is 19:30 Sunday local.
    expect(firedAt("2026-07-11", "2026-07-12", "2026-07-13")).toEqual([
      "2026-07-12T23:30:00.000Z",
    ]);
    // In standard time the same local moment is an hour later in UTC, which
    // has already rolled over to Monday.
    expect(firedAt("2026-12-12", "2026-12-13", "2026-12-14")).toEqual([
      "2026-12-14T00:30:00.000Z",
    ]);
  });
});

describe("a different owner timezone", () => {
  it("moves the digest with the zone rather than with UTC", () => {
    // The same instant is the right local hour in one zone and not another.
    // A router that ignored the zone would fire for both.
    expect(jobs(DAILY_CRON, "2026-07-15T11:30:00.000Z", "America/Toronto")).toEqual(["digest"]);
    expect(jobs(DAILY_CRON, "2026-07-15T11:30:00.000Z", "Europe/London")).toEqual([]);
    expect(jobs(DAILY_CRON, "2026-07-15T11:30:00.000Z", "Asia/Tokyo")).toEqual([]);
  });
});
