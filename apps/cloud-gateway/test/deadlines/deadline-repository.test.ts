import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeadlineRepository,
  deadlineContentHash,
  truncateFailure,
} from "../../src/deadlines/deadline-repository.js";
import { countRevisions, resetDeadlineTables } from "./deadline-fixture.js";

const MONDAY = new Date("2026-09-07T12:00:00.000Z");
const TUESDAY = new Date("2026-09-08T12:00:00.000Z");
const WEDNESDAY = new Date("2026-09-09T12:00:00.000Z");

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe("DeadlineRepository", () => {
  let repository: DeadlineRepository;
  let sourceId: string;

  beforeEach(async () => {
    await resetDeadlineTables();
    repository = new DeadlineRepository(env.DB);
    sourceId = (await repository.createSource({ kind: "classroom", label: "Google Classroom", now: MONDAY })).sourceId;
  });
  afterEach(resetDeadlineTables);

  function upsert(overrides: Partial<Parameters<DeadlineRepository["upsert"]>[0]> = {}) {
    return repository.upsert({
      sourceId,
      externalId: "c-physics:1",
      course: "SPH4U Physics",
      title: "Unit 3 Quiz",
      dueAt: "2026-09-18T18:00:00.000Z",
      effort: "quiz",
      leadMinutes: 720,
      now: MONDAY,
      ...overrides,
    });
  }

  it("writes a new deadline and its first version together, so the history starts where the deadline does", async () => {
    const result = await upsert();

    expect(result.outcome).toBe("created");
    expect(result.previous).toBeNull();
    expect(result.deadline.status).toBe("open");
    expect(result.deadline.firstSeenAt).toBe("2026-09-07T12:00:00.000Z");
    expect(result.deadline.lastSeenAt).toBe("2026-09-07T12:00:00.000Z");
    expect(result.deadline.contentHash).toBe(
      await deadlineContentHash({ course: "SPH4U Physics", title: "Unit 3 Quiz", dueAt: "2026-09-18T18:00:00.000Z" }),
    );

    const revisions = await repository.listRevisions(result.deadline.deadlineId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      contentHash: result.deadline.contentHash,
      dueAt: "2026-09-18T18:00:00.000Z",
      title: "Unit 3 Quiz",
      observedAt: "2026-09-07T12:00:00.000Z",
    });
  });

  it("appends no revision when a sweep sees the same deadline again, and advances only when it was last seen", async () => {
    const created = await upsert();
    const repeated = await upsert({ now: TUESDAY });
    const again = await upsert({ now: WEDNESDAY });

    expect(repeated.outcome).toBe("unchanged");
    expect(repeated.revisionId).toBeNull();
    expect(again.outcome).toBe("unchanged");
    // Three sightings, one version. Appending per sighting would bury the rows
    // that mean something under thousands that mean "still there".
    expect(await countRevisions(created.deadline.deadlineId)).toBe(1);
    expect(again.deadline.lastSeenAt).toBe("2026-09-09T12:00:00.000Z");
    expect(again.deadline.firstSeenAt).toBe("2026-09-07T12:00:00.000Z");
  });

  it("appends a revision when a due date moves, updates the row, and clears the reminder so it fires again", async () => {
    const created = await upsert();
    await repository.markReminded(created.deadline.deadlineId, TUESDAY);
    expect((await repository.readDeadline(created.deadline.deadlineId))?.remindedAt).toBe("2026-09-08T12:00:00.000Z");

    const moved = await upsert({ dueAt: "2026-09-25T18:00:00.000Z", now: WEDNESDAY });

    expect(moved.outcome).toBe("revised");
    expect(moved.previous).toEqual({ dueAt: "2026-09-18T18:00:00.000Z", title: "Unit 3 Quiz", course: "SPH4U Physics" });
    expect(moved.deadline.dueAt).toBe("2026-09-25T18:00:00.000Z");
    // He was already told about the old date. A moved date is the one thing he
    // has to be told about a second time.
    expect(moved.deadline.remindedAt).toBeNull();

    const revisions = await repository.listRevisions(created.deadline.deadlineId);
    expect(revisions.map((revision) => revision.dueAt)).toEqual([
      "2026-09-18T18:00:00.000Z", "2026-09-25T18:00:00.000Z",
    ]);
    // The row itself keeps only the current answer, so the fact that it moved
    // exists nowhere but here.
    expect(revisions[0]!.dueAt).not.toBe(moved.deadline.dueAt);
  });

  it("appends a revision for a corrected title but leaves the reminder standing", async () => {
    const created = await upsert();
    await repository.markReminded(created.deadline.deadlineId, TUESDAY);

    const retitled = await upsert({ title: "Unit 3 Quiz (kinematics)", now: WEDNESDAY });

    expect(retitled.outcome).toBe("revised");
    expect(await countRevisions(created.deadline.deadlineId)).toBe(2);
    // A typo fixed by a teacher is not a reason to interrupt him again.
    expect(retitled.deadline.remindedAt).toBe("2026-09-08T12:00:00.000Z");
  });

  it("keeps a tag through every sweep that sees the same text and re-derives it only when the text changes", async () => {
    const created = await upsert({ effort: "quiz", leadMinutes: 720 });
    // The sweep re-derives an effort each time. On an unchanged item the stored
    // one must win, or the owner's own retag would be undone every five minutes.
    const repeated = await upsert({ effort: "project", leadMinutes: 7200, now: TUESDAY });
    expect(repeated.deadline.effort).toBe("quiz");
    expect(repeated.deadline.leadMinutes).toBe(720);

    const rewritten = await upsert({ title: "Unit 3 Project", effort: "project", leadMinutes: 7200, now: WEDNESDAY });
    // Once the teacher actually edits the item, the tag derived from the old
    // text is stale and is replaced.
    expect(rewritten.deadline.effort).toBe("project");
    expect(rewritten.deadline.leadMinutes).toBe(7200);
    expect(await countRevisions(created.deadline.deadlineId)).toBe(2);
  });

  it("refuses to let a revision be deleted, which is what the append-only history rests on", async () => {
    const created = await upsert();
    await expect(
      env.DB.prepare("DELETE FROM deadline_revisions WHERE deadline_id = ?").bind(created.deadline.deadlineId).run(),
    ).rejects.toThrow(/deadline_revision_delete_forbidden/u);
    expect(await countRevisions(created.deadline.deadlineId)).toBe(1);
  });

  it("records a failure without disturbing the last success, then clears it when the source works again", async () => {
    await repository.recordSourceSuccess(sourceId, MONDAY);
    await repository.recordSourceFailure(sourceId, "brightspace_login_expired", TUESDAY);

    const failing = await repository.readSource(sourceId);
    expect(failing?.lastFailure).toBe("brightspace_login_expired");
    expect(failing?.lastFailureAt).toBe("2026-09-08T12:00:00.000Z");
    // How long it has been broken is the part that decides whether this is a
    // blip or the reason the digest has been quiet all week.
    expect(failing?.lastSuccessAt).toBe("2026-09-07T12:00:00.000Z");

    await repository.recordSourceSuccess(sourceId, WEDNESDAY);
    const recovered = await repository.readSource(sourceId);
    expect(recovered?.lastFailure).toBeNull();
    expect(recovered?.lastFailureAt).toBeNull();
    expect(recovered?.lastSuccessAt).toBe("2026-09-09T12:00:00.000Z");
  });

  it("bounds a failure reason so the write reporting a fault cannot be aborted by it", async () => {
    const scraped = `<html>${"x".repeat(4000)}</html>`;
    expect(truncateFailure(scraped).length).toBe(512);
    await expect(repository.recordSourceFailure(sourceId, scraped, TUESDAY)).resolves.toBe(true);
    expect((await repository.readSource(sourceId))?.lastFailure?.length).toBe(512);
  });

  it("lists deadlines in a half-open window so consecutive digests neither overlap nor skip", async () => {
    await upsert({ externalId: "a", dueAt: "2026-09-10T00:00:00.000Z" });
    await upsert({ externalId: "b", dueAt: "2026-09-11T00:00:00.000Z" });
    await upsert({ externalId: "c", dueAt: "2026-09-12T00:00:00.000Z" });

    const window = await repository.listDueWithin({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-12T00:00:00.000Z" });
    expect(window.map((deadline) => deadline.externalId)).toEqual(["a", "b"]);

    const next = await repository.listDueWithin({ from: "2026-09-12T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z" });
    expect(next.map((deadline) => deadline.externalId)).toEqual(["c"]);
  });

  it("filters a window by effort, which is how exam windows are found without reading every deadline", async () => {
    await upsert({ externalId: "quiz", effort: "quiz", dueAt: "2026-09-10T00:00:00.000Z" });
    await upsert({ externalId: "exam", effort: "exam", dueAt: "2026-09-11T00:00:00.000Z" });

    const exams = await repository.listDueWithin({
      from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", efforts: ["exam"],
    });
    expect(exams.map((deadline) => deadline.externalId)).toEqual(["exam"]);
  });

  it("brings a deadline up for reminding on its own effort's scale and not a shared one", async () => {
    const dueIn20Hours = minutesAfter(MONDAY, 1_200).toISOString();
    await upsert({ externalId: "quiz", effort: "quiz", leadMinutes: 720, dueAt: dueIn20Hours });
    await upsert({ externalId: "project", effort: "project", leadMinutes: 7_200, dueAt: dueIn20Hours });

    // Same due date, same instant, different answers -- which is the entire
    // point of storing a lead time per deadline.
    const due = await repository.listReminderDue(MONDAY);
    expect(due.map((deadline) => deadline.externalId)).toEqual(["project"]);

    // Twelve hours later the quiz is inside its own lead time too.
    const later = await repository.listReminderDue(minutesAfter(MONDAY, 600));
    expect(due.length).toBe(1);
    expect(later.map((deadline) => deadline.externalId).sort()).toEqual(["project", "quiz"]);
  });

  it("stops offering a deadline for reminding once it has been reminded or has passed", async () => {
    const created = await upsert({ dueAt: minutesAfter(MONDAY, 60).toISOString() });
    expect(await repository.listReminderDue(MONDAY)).toHaveLength(1);

    await repository.markReminded(created.deadline.deadlineId, MONDAY);
    expect(await repository.listReminderDue(MONDAY)).toHaveLength(0);

    const other = await upsert({ externalId: "past", dueAt: minutesAfter(MONDAY, -60).toISOString() });
    expect(other.outcome).toBe("created");
    expect(await repository.listReminderDue(MONDAY)).toHaveLength(0);
  });

  it("keeps the reminder mark monotonic so a replayed digest does not move it backwards", async () => {
    const created = await upsert();
    expect(await repository.markReminded(created.deadline.deadlineId, TUESDAY)).toBe(true);
    expect(await repository.markReminded(created.deadline.deadlineId, MONDAY)).toBe(false);
    expect(await repository.markReminded(created.deadline.deadlineId, TUESDAY)).toBe(false);
    expect((await repository.readDeadline(created.deadline.deadlineId))?.remindedAt).toBe("2026-09-08T12:00:00.000Z");
  });

  it("names the open deadlines a sweep did not mention without touching them", async () => {
    const stale = await upsert({ externalId: "stale" });
    await upsert({ externalId: "fresh" });
    // A later sweep sees only one of them.
    await upsert({ externalId: "fresh", now: TUESDAY });

    const missing = await repository.listOpenNotSeenSince(sourceId, TUESDAY);
    expect(missing.map((deadline) => deadline.externalId)).toEqual(["stale"]);
    // Named, not changed.
    const unchanged = await repository.readDeadline(stale.deadline.deadlineId);
    expect(unchanged?.status).toBe("open");
    expect(unchanged?.lastSeenAt).toBe("2026-09-07T12:00:00.000Z");
  });

  describe("quiet windows", () => {
    it("creates an exam window bound to its deadline and a manual window bound to nothing", async () => {
      const created = await upsert({ effort: "exam" });
      const exam = await repository.createQuietWindow({
        reason: "exam",
        deadlineId: created.deadline.deadlineId,
        startsAt: "2026-09-18T13:00:00.000Z",
        endsAt: "2026-09-18T17:00:00.000Z",
        now: MONDAY,
      });
      const manual = await repository.createQuietWindow({
        reason: "manual",
        startsAt: "2026-09-19T13:00:00.000Z",
        endsAt: "2026-09-19T17:00:00.000Z",
        now: MONDAY,
      });

      expect(exam.deadlineId).toBe(created.deadline.deadlineId);
      expect(manual.deadlineId).toBeNull();
      expect(await repository.listQuietWindowsForDeadline(created.deadline.deadlineId))
        .toEqual([exam]);
    });

    it("returns the window you are inside, not only the ones that start inside the range", async () => {
      await repository.createQuietWindow({
        reason: "manual", startsAt: "2026-09-18T13:00:00.000Z", endsAt: "2026-09-18T17:00:00.000Z", now: MONDAY,
      });
      // An instant in the middle. A containment test would answer "no window"
      // for exactly the window in force.
      const during = await repository.listQuietWindows({ from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T15:00:00.001Z" });
      expect(during).toHaveLength(1);
      const after = await repository.listQuietWindows({ from: "2026-09-18T17:00:00.000Z", to: "2026-09-18T17:00:00.001Z" });
      expect(after).toHaveLength(0);
    });

    it("cancels a window rather than deleting it, and cancels it only once", async () => {
      const window = await repository.createQuietWindow({
        reason: "manual", startsAt: "2026-09-18T13:00:00.000Z", endsAt: "2026-09-18T17:00:00.000Z", now: MONDAY,
      });
      expect(await repository.cancelQuietWindow(window.windowId, TUESDAY)).toBe(true);
      expect(await repository.cancelQuietWindow(window.windowId, WEDNESDAY)).toBe(false);
      // The row survives: a window that was in force is part of why a message
      // was late.
      expect((await repository.readQuietWindow(window.windowId))?.cancelledAt).toBe("2026-09-08T12:00:00.000Z");
      expect(await repository.listQuietWindows({ from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T15:00:00.001Z" }))
        .toHaveLength(0);
    });

    it("refuses a window that ends before it starts", async () => {
      await expect(repository.createQuietWindow({
        reason: "manual", startsAt: "2026-09-18T17:00:00.000Z", endsAt: "2026-09-18T13:00:00.000Z", now: MONDAY,
      })).rejects.toThrow("quiet_window_span_invalid");
    });
  });

  it("refuses an instant that is not the one canonical format, because the table sorts them as text", async () => {
    // Same moment, different text. Stored as-is it would sort nowhere near its
    // neighbours in every range query and never raise an error doing it.
    await expect(upsert({ dueAt: "2026-09-18T14:00:00-04:00" })).rejects.toThrow("deadline_due_at_invalid");
    await expect(upsert({ dueAt: "2026-09-18T18:00:00Z" })).rejects.toThrow("deadline_due_at_invalid");
    await expect(upsert({ dueAt: "2026-02-30T18:00:00.000Z" })).rejects.toThrow("deadline_due_at_invalid");
  });
});
