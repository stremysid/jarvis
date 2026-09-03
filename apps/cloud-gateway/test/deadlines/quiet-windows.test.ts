import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import {
  EXAM_WINDOW_ENDS_AFTER_MINUTES,
  EXAM_WINDOW_STARTS_BEFORE_MINUTES,
  MESSAGE_CLASSES,
  QUIET_WINDOW_PASSING_CLASSES,
  QuietWindowService,
  isSuppressed,
  type MessageClass,
} from "../../src/deadlines/quiet-windows.js";
import type { QuietWindow } from "../../src/deadlines/deadline-types.js";
import { resetDeadlineTables } from "./deadline-fixture.js";

const MONDAY = new Date("2026-09-07T12:00:00.000Z");
const TUESDAY = new Date("2026-09-08T12:00:00.000Z");
const EXAM_DUE = "2026-09-18T13:00:00.000Z";
const TERM = { from: "2026-09-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" } as const;

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
  let sourceId: string;
  let now: Date;

  function service(): QuietWindowService {
    return new QuietWindowService({ repository, now: () => now });
  }

  async function deadline(effort: "exam" | "quiz", externalId: string, dueAt: string): Promise<string> {
    const result = await repository.upsert({
      sourceId,
      externalId,
      course: "SPH4U Physics",
      title: effort === "exam" ? "Final Exam" : "Unit 3 Quiz",
      dueAt,
      effort,
      leadMinutes: 720,
      now: MONDAY,
    });
    return result.deadline.deadlineId;
  }

  beforeEach(async () => {
    await resetDeadlineTables();
    repository = new DeadlineRepository(env.DB);
    now = MONDAY;
    sourceId = (await repository.createSource({ kind: "classroom", label: "Classroom", now: MONDAY })).sourceId;
  });
  afterEach(resetDeadlineTables);

  it("turns an exam deadline into a quiet window and leaves every other kind of deadline alone", async () => {
    const examId = await deadline("exam", "exam-1", EXAM_DUE);
    await deadline("quiz", "quiz-1", "2026-09-19T13:00:00.000Z");

    const derived = await service().deriveExamWindows(TERM);

    expect(derived).toHaveLength(1);
    expect(derived[0]?.outcome).toBe("created");
    expect(derived[0]?.window).toMatchObject({
      reason: "exam",
      deadlineId: examId,
      // An hour before and three hours after: the schema records when an exam
      // is, never how long it lasts, so the span is fixed and biased to cover
      // the whole sitting rather than end in the middle of it.
      startsAt: "2026-09-18T12:00:00.000Z",
      endsAt: "2026-09-18T16:00:00.000Z",
    });
    expect(EXAM_WINDOW_STARTS_BEFORE_MINUTES).toBe(60);
    expect(EXAM_WINDOW_ENDS_AFTER_MINUTES).toBe(180);
  });

  it("suppresses a business ping during the derived exam window while an urgent class still gets through", async () => {
    await deadline("exam", "exam-1", EXAM_DUE);
    await service().deriveExamWindows(TERM);

    const during = "2026-09-18T13:30:00.000Z";
    expect(await service().isSuppressed(during, "business_ping")).toBe(true);
    expect(await service().isSuppressed(during, "business_digest")).toBe(true);
    expect(await service().isSuppressed(during, "error_alert")).toBe(false);
    expect(await service().isSuppressed(during, "payment")).toBe(false);
    // And nothing is held outside the window.
    expect(await service().isSuppressed("2026-09-18T16:00:00.000Z", "business_ping")).toBe(false);
  });

  it("validates the message class before reading the database, so the check has no hole when no window is in force", async () => {
    // With no window stored the answer is "not suppressed" for everything, which
    // is where a bad class would slip past unnoticed and where every test would
    // be written.
    await expect(service().isSuppressed(MONDAY, "urgent" as unknown as MessageClass))
      .rejects.toThrow("quiet_window_message_class_invalid");
  });

  it("derives the same window again without creating a second one", async () => {
    await deadline("exam", "exam-1", EXAM_DUE);
    const first = await service().deriveExamWindows(TERM);

    now = TUESDAY;
    const second = await service().deriveExamWindows(TERM);

    expect(second[0]?.outcome).toBe("unchanged");
    expect(second[0]?.window.windowId).toBe(first[0]?.window.windowId);
    // Derivation runs after every sweep, so a second window per sweep would
    // accumulate one per five minutes for the life of the term.
    const stored = await env.DB.prepare("SELECT COUNT(*) AS count FROM quiet_windows").first<{ count: number }>();
    expect(stored?.count).toBe(1);
  });

  it("cancels the old window and creates a new one when the exam itself moves", async () => {
    const examId = await deadline("exam", "exam-1", EXAM_DUE);
    const original = (await service().deriveExamWindows(TERM))[0]!.window;

    now = TUESDAY;
    await repository.upsert({
      sourceId,
      externalId: "exam-1",
      course: "SPH4U Physics",
      title: "Final Exam",
      dueAt: "2026-09-19T13:00:00.000Z",
      effort: "exam",
      leadMinutes: 720,
      now: TUESDAY,
    });
    const moved = await service().deriveExamWindows(TERM);

    expect(moved[0]?.outcome).toBe("moved");
    expect(moved[0]?.window.startsAt).toBe("2026-09-19T12:00:00.000Z");
    // The old window was in force and messages were held by it, so it is
    // cancelled rather than rewritten: an edited window would make the record
    // disagree with what actually happened.
    expect((await repository.readQuietWindow(original.windowId))?.cancelledAt).toBe("2026-09-08T12:00:00.000Z");
    expect(await repository.listQuietWindowsForDeadline(examId)).toHaveLength(1);
    // And the old window no longer silences anything.
    expect(await service().isSuppressed("2026-09-18T13:30:00.000Z", "business_ping")).toBe(false);
    expect(await service().isSuppressed("2026-09-19T13:30:00.000Z", "business_ping")).toBe(true);
  });

  it("derives nothing for an exam outside the range it was asked about", async () => {
    await deadline("exam", "exam-1", EXAM_DUE);
    const derived = await service().deriveExamWindows({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(derived).toEqual([]);
    expect(await service().isSuppressed("2026-09-18T13:30:00.000Z", "business_ping")).toBe(false);
  });
});
