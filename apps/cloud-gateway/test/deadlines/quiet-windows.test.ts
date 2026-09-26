import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import {
  MESSAGE_CLASSES,
  QUIET_WINDOW_PASSING_CLASSES,
  QuietWindowService,
  isSuppressed,
  type MessageClass,
} from "../../src/deadlines/quiet-windows.js";
import type { QuietWindow } from "../../src/deadlines/deadline-types.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const MONDAY = new Date("2026-09-07T12:00:00.000Z");

function window(overrides: Partial<QuietWindow> = {}): QuietWindow {
  return {
    windowId: "w-1",
    reason: "manual",
    deadlineId: null,
    startsAt: "2026-09-18T12:00:00.000Z",
    endsAt: "2026-09-18T16:00:00.000Z",
    createdAt: "2026-09-07T12:00:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

describe("isSuppressed", () => {
  it("holds a non-urgent message inside a window and lets the same message through outside it", () => {
    const windows = [window()];
    expect(isSuppressed({ at: "2026-09-18T14:00:00.000Z", messageClass: "business_ping", windows })).toBe(true);
    expect(isSuppressed({ at: "2026-09-18T11:00:00.000Z", messageClass: "business_ping", windows })).toBe(false);
    expect(isSuppressed({ at: "2026-09-18T14:00:00.000Z", messageClass: "business_ping", windows: [] })).toBe(false);
  });

  it("lets an urgent class through a window that is holding everything else", () => {
    const windows = [window()];
    const at = "2026-09-18T14:00:00.000Z";
    // Suppression is checked per message class and never applied to the
    // channel. Silencing the channel would silence the alert saying the gateway
    // is down, during the three hours he is least able to notice.
    expect(isSuppressed({ at, messageClass: "error_alert", windows })).toBe(false);
    expect(isSuppressed({ at, messageClass: "payment", windows })).toBe(false);
    expect(isSuppressed({ at, messageClass: "business_ping", windows })).toBe(true);
  });

  it("decides every declared message class from one explicit list rather than from a flag the caller passes", () => {
    // Stated by equality, not membership: a class added to the type and
    // forgotten here is exactly the one that would go missing, and a membership
    // check would not notice it.
    expect([...MESSAGE_CLASSES]).toEqual([
      "error_alert", "payment", "deadline_reminder", "business_digest", "business_ping", "project_nudge",
    ]);
    expect([...QUIET_WINDOW_PASSING_CLASSES].sort()).toEqual(["error_alert", "payment"]);

    const windows = [window()];
    const decided = MESSAGE_CLASSES.map((messageClass) => [
      messageClass,
      isSuppressed({ at: "2026-09-18T14:00:00.000Z", messageClass, windows }),
    ]);
    expect(decided).toEqual([
      ["error_alert", false],
      ["payment", false],
      // A reminder about Thursday's essay arriving during Wednesday's exam is
      // the interruption the window exists to prevent, and the one message he
      // can do nothing about while sitting in the room.
      ["deadline_reminder", true],
      ["business_digest", true],
      ["business_ping", true],
      ["project_nudge", true],
    ]);
  });

  it("refuses a message class nobody classified rather than choosing an answer for it", () => {
    // Either default is silent: suppressing holds a message that may be the one
    // that mattered, passing defeats the window, and neither leaves a trace
    // saying a decision was skipped.
    for (const bad of ["urgent", "", "ERROR_ALERT", null, undefined, 7]) {
      expect(() => isSuppressed({
        at: "2026-09-18T14:00:00.000Z",
        messageClass: bad as unknown as MessageClass,
        windows: [window()],
      })).toThrow("quiet_window_message_class_invalid");
    }
  });

  it("treats a window as half-open, so back-to-back windows neither overlap nor leave a gap", () => {
    const windows = [window()];
    expect(isSuppressed({ at: "2026-09-18T12:00:00.000Z", messageClass: "business_ping", windows })).toBe(true);
    expect(isSuppressed({ at: "2026-09-18T15:59:59.999Z", messageClass: "business_ping", windows })).toBe(true);
    expect(isSuppressed({ at: "2026-09-18T16:00:00.000Z", messageClass: "business_ping", windows })).toBe(false);
    expect(isSuppressed({ at: "2026-09-18T11:59:59.999Z", messageClass: "business_ping", windows })).toBe(false);
  });

  it("ignores a cancelled window even when it is handed one", () => {
    const cancelled = [window({ cancelledAt: "2026-09-08T12:00:00.000Z" })];
    expect(isSuppressed({ at: "2026-09-18T14:00:00.000Z", messageClass: "business_ping", windows: cancelled })).toBe(false);
  });
});

describe("QuietWindowService", () => {
  let repository: DeadlineRepository;

  function service(): QuietWindowService {
    return new QuietWindowService({ repository });
  }

  beforeEach(async () => {
    await resetDeadlineTables();
    repository = new DeadlineRepository(env.DB);
  });
  afterEach(resetDeadlineTables);

  it("validates the message class before reading the database, so the check has no hole when no window is in force", async () => {
    // With no window stored the answer is "not suppressed" for everything, which
    // is where a bad class would slip past unnoticed and where every test would
    // be written.
    await expect(service().isSuppressed(MONDAY, "urgent" as unknown as MessageClass))
      .rejects.toThrow("quiet_window_message_class_invalid");
  });

  it("holds a non-urgent message inside a stored manual window and lets it through after it ends", async () => {
    await repository.createQuietWindow({
      reason: "manual", startsAt: "2026-09-18T12:00:00.000Z", endsAt: "2026-09-18T16:00:00.000Z", now: MONDAY,
    });

    expect(await service().isSuppressed("2026-09-18T13:30:00.000Z", "business_ping")).toBe(true);
    expect(await service().isSuppressed("2026-09-18T13:30:00.000Z", "error_alert")).toBe(false);
    expect(await service().isSuppressed("2026-09-18T16:00:00.000Z", "business_ping")).toBe(false);
  });

  it("has no way to derive a window from a deadline, because there is no category to derive from", () => {
    // Windows come from the owner, not from a deadline's kind. Deadlines no
    // longer carry an effort or a lead, so there is nothing here to turn one
    // into a warning schedule.
    expect((service() as unknown as Record<string, unknown>).deriveExamWindows).toBeUndefined();
  });
});
