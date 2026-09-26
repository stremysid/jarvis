import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeadlineRepository,
  STUDY_DEADLINE_ROW_LIMIT,
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
      now: MONDAY,
      ...overrides,
    });
  }

  it("ensures a stable scheduled source idempotently without reactivating an owner-disabled source", async () => {
    await resetDeadlineTables();
    const first = await repository.ensureSource({
      sourceId: "google-classroom",
      kind: "classroom",
      label: "Google Classroom",
      now: MONDAY,
      active: false,
    });
    const second = await repository.ensureSource({
      sourceId: "google-classroom",
      kind: "classroom",
      label: "Renamed by code",
      now: TUESDAY,
      active: true,
    });

    expect(first.sourceId).toBe("google-classroom");
    expect(second).toEqual(first);
    expect(second.active).toBe(false);
    expect(await repository.listSources()).toHaveLength(1);
  });

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

  it("appends a revision when a due date moves and updates the row", async () => {
    const created = await upsert();

    const moved = await upsert({ dueAt: "2026-09-25T18:00:00.000Z", now: WEDNESDAY });

    expect(moved.outcome).toBe("revised");
    expect(moved.previous).toEqual({ dueAt: "2026-09-18T18:00:00.000Z", title: "Unit 3 Quiz", course: "SPH4U Physics" });
    expect(moved.deadline.dueAt).toBe("2026-09-25T18:00:00.000Z");

    const revisions = await repository.listRevisions(created.deadline.deadlineId);
    expect(revisions.map((revision) => revision.dueAt)).toEqual([
      "2026-09-18T18:00:00.000Z", "2026-09-25T18:00:00.000Z",
    ]);
    // The row itself keeps only the current answer, so the fact that it moved
    // exists nowhere but here.
    expect(revisions[0]!.dueAt).not.toBe(moved.deadline.dueAt);
  });

  it("appends a revision for a corrected title", async () => {
    const created = await upsert();

    const retitled = await upsert({ title: "Unit 3 Quiz (kinematics)", now: WEDNESDAY });

    expect(retitled.outcome).toBe("revised");
    expect(await countRevisions(created.deadline.deadlineId)).toBe(2);
  });

  it("stores a deadline with no due date as null instead of inventing one", async () => {
    const created = await upsert({ dueAt: null });

    expect(created.outcome).toBe("created");
    expect(created.deadline.dueAt).toBeNull();
    // No window can contain an instant that does not exist.
    expect(await repository.listDueWithin({ from: MONDAY, to: WEDNESDAY })).toEqual([]);
    // But it is not lost: the review listing always shows it.
    const reviewable = await repository.listReviewable({ from: MONDAY, to: WEDNESDAY });
    expect(reviewable.map((deadline) => deadline.externalId)).toEqual(["c-physics:1"]);
    expect(reviewable[0]?.dueAt).toBeNull();
  });

  it("treats a later date on a previously undated deadline as a content revision", async () => {
    const created = await upsert({ dueAt: null });
    const dated = await upsert({ dueAt: "2026-09-18T18:00:00.000Z", now: TUESDAY });

    expect(dated.outcome).toBe("revised");
    expect(dated.previous?.dueAt).toBeNull();
    expect(dated.deadline.dueAt).toBe("2026-09-18T18:00:00.000Z");
    expect(await countRevisions(created.deadline.deadlineId)).toBe(2);
  });

  it("lists undated deadlines and windowed ones together, undated first", async () => {
    await upsert({ externalId: "undated", dueAt: null });
    await upsert({ externalId: "soon", dueAt: "2026-09-10T00:00:00.000Z" });
    await upsert({ externalId: "far", dueAt: "2026-12-01T00:00:00.000Z" });

    const reviewable = await repository.listReviewable({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });

    expect(reviewable.map((deadline) => deadline.externalId)).toEqual(["undated", "soon"]);
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

  it("does not let an overlapping older sweep move source health backwards", async () => {
    await repository.recordSourceSuccess(sourceId, WEDNESDAY, "source_items_truncated:4");

    await expect(repository.recordSourceSuccess(sourceId, TUESDAY)).resolves.toBe(false);
    await expect(repository.readSource(sourceId)).resolves.toMatchObject({
      lastSuccessAt: WEDNESDAY.toISOString(),
      lastFailure: "source_items_truncated:4",
      lastFailureAt: WEDNESDAY.toISOString(),
    });
  });

  it("does not let an overlapping older failure replace newer source health", async () => {
    await repository.recordSourceSuccess(sourceId, WEDNESDAY);

    await expect(repository.recordSourceFailure(sourceId, "older sweep failed", TUESDAY)).resolves.toBe(false);
    await expect(repository.readSource(sourceId)).resolves.toMatchObject({
      lastSuccessAt: WEDNESDAY.toISOString(),
      lastFailure: null,
      lastFailureAt: null,
    });

    await repository.recordSourceFailure(sourceId, "new failure", WEDNESDAY);
    await expect(repository.recordSourceFailure(sourceId, "older retry", TUESDAY)).resolves.toBe(false);
    await expect(repository.readSource(sourceId)).resolves.toMatchObject({
      lastSuccessAt: WEDNESDAY.toISOString(),
      lastFailure: "new failure",
      lastFailureAt: WEDNESDAY.toISOString(),
    });
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

  it("bounds study candidates to open near-due rows ordered soonest-first from now", async () => {
    await repository.recordSourceSuccess(sourceId, MONDAY);
    let cancelledId = "";
    for (let index = 0; index < STUDY_DEADLINE_ROW_LIMIT + 2; index += 1) {
      const created = await upsert({
        externalId: `study-${String(index).padStart(2, "0")}`,
        dueAt: minutesAfter(TUESDAY, index + 1).toISOString(),
        now: TUESDAY,
      });
      if (index === 0) cancelledId = created.deadline.externalId;
    }
    await upsert({
      externalId: "past-for-study",
      dueAt: minutesAfter(TUESDAY, -1).toISOString(),
      now: TUESDAY,
    });
    await upsert({
      externalId: "too-far-for-study",
      dueAt: minutesAfter(TUESDAY, 73 * 60).toISOString(),
      now: TUESDAY,
    });
    await repository.cancelOpenByExternalId(sourceId, cancelledId, TUESDAY);
    await repository.recordSourceFailure(sourceId, "classroom_temporarily_unavailable", TUESDAY);

    const candidates = await repository.listStudyCandidates(TUESDAY);

    expect(candidates).toHaveLength(STUDY_DEADLINE_ROW_LIMIT);
    expect(candidates.every((candidate) => candidate.deadline.status === "open")).toBe(true);
    expect(candidates.map((candidate) => candidate.deadline.externalId)).not.toContain("past-for-study");
    expect(candidates.map((candidate) => candidate.deadline.externalId)).not.toContain(cancelledId);
    expect(candidates.map((candidate) => candidate.deadline.externalId)).not.toContain("too-far-for-study");
    expect(candidates[0]).toMatchObject({
      deadline: { externalId: "study-01" },
      sourceKind: "classroom",
      sourceLastSuccessAt: MONDAY.toISOString(),
      sourceLastFailure: "classroom_temporarily_unavailable",
    });
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
      const created = await upsert();
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
