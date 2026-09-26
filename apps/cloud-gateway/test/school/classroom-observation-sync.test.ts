import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { runClassroomObservationSync } from "../../src/school/classroom-observation-sync.js";
import {
  CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET,
  D1StatementBudget,
  SchoolObservationRepository,
} from "../../src/school/school-observation-repository.js";
import { applyStudyCoachWeakSpotsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");

interface Fixture {
  readonly principalId: string;
  readonly sourceId: string;
  readonly courseId: string;
  readonly deadlineExternalId: string;
}

async function fixture(suffix: string): Promise<Fixture> {
  const principalId = `principal:classroom-observation-sync-${suffix}`;
  const sourceId = `classroom-sync-${suffix}`;
  const courseId = `course-${suffix}`;
  const deadlineExternalId = `${courseId}:work-1`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', ?, ?, ?)`).bind(
    principalId, principalId, NOW.toISOString(), NOW.toISOString(),
  ).run();
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
  await deadlines.upsert({
    sourceId,
    externalId: deadlineExternalId,
    course: "Calculus",
    title: "Limits quiz",
    dueAt: "2026-09-15T11:00:00.000Z",
    now: NOW,
  });
  return { principalId, sourceId, courseId, deadlineExternalId };
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
});

describe("runClassroomObservationSync", () => {
  it("completes a bounded scan, persists a verified grade and derives no factual miss", async () => {
    const item = await fixture("complete");
    const budget = new D1StatementBudget();
    const repository = new SchoolObservationRepository(env.DB, budget);
    const listSubmissionPage = vi.fn(async () => ({
      items: [{
        deadlineExternalId: item.deadlineExternalId,
        externalSubmissionId: `${item.deadlineExternalId}:submission-1`,
        state: "returned" as const,
        late: false,
        assignedGrade: 91,
        sourceUpdatedAt: NOW.toISOString(),
      }],
      rejected: 0,
      nextPageToken: null,
    }));
    const result = await runClassroomObservationSync({
      repository,
      client: { listSubmissionPage },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
      courseWorkMaxPoints: new Map([[item.deadlineExternalId, 100]]),
    });

    expect(result).toMatchObject({
      outcome: "complete",
      pages: 1,
      seen: 1,
      undatedCoursework: 0,
      rejected: 0,
      failure: null,
    });
    expect(result.statementsUsed).toBeLessThanOrEqual(CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET);
    const snapshot = await new SchoolObservationRepository(env.DB).readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: NOW,
    });
    expect(snapshot.grades[0]?.assignedGrade).toBe(91);
    expect(snapshot.grades[0]?.maxPoints).toBe(100);
    expect(snapshot.grades[0]?.gradeUpdatedAt).toBe(NOW.toISOString());
    expect(snapshot.missingWork).toEqual([]);
    expect(snapshot.source).toMatchObject({
      checkpointCourseId: null,
      checkpointPageToken: null,
      derivationScanAt: null,
      derivationStartedAt: null,
      lastSuccessAt: NOW.toISOString(),
      lastSuccessStartedAt: NOW.toISOString(),
    });
  });

  it("counts undated coursework submissions separately from rejected submission evidence", async () => {
    const item = await fixture("undated-separate");
    const undatedExternalId = `${item.courseId}:work-undated`;
    const budget = new D1StatementBudget();
    const result = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: {
        listSubmissionPage: async () => ({
          items: [{
            deadlineExternalId: item.deadlineExternalId,
            externalSubmissionId: `${item.deadlineExternalId}:submission-1`,
            state: "returned" as const,
            late: false,
            assignedGrade: 91,
            sourceUpdatedAt: NOW.toISOString(),
          }, {
            deadlineExternalId: undatedExternalId,
            externalSubmissionId: `${undatedExternalId}:submission-1`,
            state: "new" as const,
            late: null,
            assignedGrade: null,
            sourceUpdatedAt: NOW.toISOString(),
          }, {
            deadlineExternalId: `${item.courseId}:work-unknown`,
            externalSubmissionId: `${item.courseId}:work-unknown:submission-1`,
            state: "new" as const,
            late: null,
            assignedGrade: null,
            sourceUpdatedAt: NOW.toISOString(),
          }],
          rejected: 1,
          nextPageToken: null,
        }),
      },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
      undatedDeadlineExternalIds: new Set([undatedExternalId]),
    });

    expect(result).toMatchObject({
      outcome: "complete",
      seen: 1,
      undatedCoursework: 1,
      rejected: 2,
    });
  });

  it("stops at the provider request budget and resumes from the exact stored page token", async () => {
    const item = await fixture("resume");
    const calls: Array<string | null> = [];
    const client = {
      listSubmissionPage: async (_courseId: string, pageToken: string | null) => {
        calls.push(pageToken);
        const next = pageToken === null ? "page-1"
          : pageToken === "page-1" ? "page-2"
            : pageToken === "page-2" ? "page-3"
              : pageToken === "page-3" ? "page-4"
                : null;
        return {
          items: pageToken === "page-4" ? [{
            deadlineExternalId: item.deadlineExternalId,
            externalSubmissionId: `${item.deadlineExternalId}:submission-1`,
            state: "new" as const,
            late: null,
            assignedGrade: null,
            sourceUpdatedAt: null,
          }] : [],
          rejected: 0,
          nextPageToken: next,
        };
      },
    };
    let budget = new D1StatementBudget();
    let result = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client,
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
    });
    expect(result).toMatchObject({ outcome: "partial", pages: 4 });
    expect(calls).toEqual([null, "page-1", "page-2", "page-3"]);
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({ checkpointCourseId: item.courseId, checkpointPageToken: "page-4" });

    budget = new D1StatementBudget();
    result = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client,
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => new Date("2026-09-15T13:00:00.000Z"),
    });
    expect(result.outcome).toBe("complete");
    expect(calls.at(-1)).toBe("page-4");
    const snapshot = await new SchoolObservationRepository(env.DB).readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: new Date("2026-09-15T13:00:00.000Z"),
    });
    expect(snapshot.missingWork[0]).toMatchObject({
      classification: "derived",
      state: "no_submission_seen",
    });
  });

  it("advances from a completed course to the next course before completing the scan", async () => {
    const item = await fixture("two-courses");
    const secondCourseId = `${item.courseId}-second`;
    const secondExternalId = `${secondCourseId}:work-2`;
    await new DeadlineRepository(env.DB).upsert({
      sourceId: item.sourceId,
      externalId: secondExternalId,
      course: "Physics",
      title: "Motion quiz",
      dueAt: "2026-09-15T11:00:00.000Z",
      now: NOW,
    });
    const calls: string[] = [];
    const budget = new D1StatementBudget();
    const result = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: {
        listSubmissionPage: async (courseId) => {
          calls.push(courseId);
          const deadlineExternalId = courseId === item.courseId
            ? item.deadlineExternalId
            : secondExternalId;
          return {
            items: [{
              deadlineExternalId,
              externalSubmissionId: `${deadlineExternalId}:submission-1`,
              state: "new" as const,
              late: null,
              assignedGrade: null,
              sourceUpdatedAt: null,
            }],
            rejected: 0,
            nextPageToken: null,
          };
        },
      },
      courses: [
        { id: secondCourseId, name: "Physics" },
        { id: item.courseId, name: "Calculus" },
      ],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
    });

    expect(result).toMatchObject({ outcome: "complete", pages: 2, seen: 2, transitions: 2 });
    expect(calls).toEqual([item.courseId, secondCourseId]);
  });

  it("resumes derivation after 64 deadlines and keeps the partial digest evidence-bounded", async () => {
    const item = await fixture("derivation-pages");
    const deadlines = new DeadlineRepository(env.DB);
    const courseIds = [item.courseId, `${item.courseId}-b`, `${item.courseId}-c`];
    const externalIdsByCourse = new Map<string, string[]>([[item.courseId, [item.deadlineExternalId]]]);
    for (let courseIndex = 0; courseIndex < courseIds.length; courseIndex += 1) {
      const courseId = courseIds[courseIndex]!;
      const target = courseIndex < 2 ? 25 : 15;
      const externalIds = externalIdsByCourse.get(courseId) ?? [];
      for (let index = externalIds.length + 1; index <= target; index += 1) {
        const externalId = `${courseId}:work-${index}`;
        externalIds.push(externalId);
        await deadlines.upsert({
          sourceId: item.sourceId,
          externalId,
          course: `Course ${courseIndex + 1}`,
          title: `Practice ${index}`,
          dueAt: "2026-09-15T11:00:00.000Z",
          now: NOW,
        });
      }
      externalIdsByCourse.set(courseId, externalIds);
    }
    const listSubmissionPage = vi.fn(async (courseId: string) => ({
      items: (externalIdsByCourse.get(courseId) ?? []).map((deadlineExternalId) => ({
        deadlineExternalId,
        externalSubmissionId: `${deadlineExternalId}:submission-1`,
        state: "new" as const,
        late: null,
        assignedGrade: null,
        sourceUpdatedAt: null,
      })),
      rejected: 0,
      nextPageToken: null,
    }));

    let budget = new D1StatementBudget();
    const first = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage },
      courses: courseIds.map((id, index) => ({ id, name: `Course ${index + 1}` })),
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
    });
    expect(first).toMatchObject({ outcome: "partial", pages: 3, seen: 65, transitions: 64 });
    const between = await new SchoolObservationRepository(env.DB).readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: NOW,
    });
    expect(between.missingWork).toHaveLength(20);
    expect(between.missingWorkOmitted).toBe(44);
    expect(between.missingWork.every((entry) => entry.lastSeenAt === NOW.toISOString())).toBe(true);

    budget = new D1StatementBudget();
    const second = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage },
      courses: courseIds.map((id, index) => ({ id, name: `Course ${index + 1}` })),
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => new Date("2026-09-15T13:00:00.000Z"),
    });
    expect(second).toMatchObject({ outcome: "complete", pages: 0, transitions: 1 });
    expect(listSubmissionPage).toHaveBeenCalledTimes(3);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_missing_work_transitions
      WHERE principal_id = ? AND to_state = 'no_submission_seen'`)
      .bind(item.principalId).first("count")).toBe(65);
    const completed = await new SchoolObservationRepository(env.DB).readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: new Date("2026-09-15T13:00:00.000Z"),
    });
    expect(completed.missingWork).toHaveLength(20);
    expect(completed.missingWorkOmitted).toBe(45);
  });

  it("records a reachable failed checkpoint state and restarts safely on the next run", async () => {
    const item = await fixture("missing-course");
    const setup = new SchoolObservationRepository(env.DB);
    await setup.ensureSync(item.principalId, item.sourceId, NOW);
    await setup.saveCheckpoint({
      principalId: item.principalId,
      sourceId: item.sourceId,
      courseId: "archived-course",
      pageToken: "provider-token",
      scanStartedAt: NOW.toISOString(),
      now: NOW,
    });

    let budget = new D1StatementBudget();
    const failed = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage: async () => ({ items: [], rejected: 0, nextPageToken: null }) },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
    });
    expect(failed).toMatchObject({
      outcome: "failed",
      failure: "classroom_observation_checkpoint_course_missing",
    });
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({
        checkpointCourseId: null,
        checkpointPageToken: null,
        scanStartedAt: null,
        lastFailure: "classroom_observation_checkpoint_course_missing",
      });

    budget = new D1StatementBudget();
    const recovered = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage: async () => ({ items: [], rejected: 0, nextPageToken: null }) },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => new Date("2026-09-15T13:00:00.000Z"),
    });
    expect(recovered.outcome).toBe("complete");
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({ lastFailure: null, lastSuccessAt: "2026-09-15T13:00:00.000Z" });
  });

  it("resets a scan checkpoint that cannot finish within the declared age bound", async () => {
    const item = await fixture("stale-checkpoint");
    const setup = new SchoolObservationRepository(env.DB);
    await setup.ensureSync(item.principalId, item.sourceId, NOW);
    await setup.saveCheckpoint({
      principalId: item.principalId,
      sourceId: item.sourceId,
      courseId: item.courseId,
      pageToken: "old-token",
      scanStartedAt: NOW.toISOString(),
      now: NOW,
    });
    const listSubmissionPage = vi.fn();
    const budget = new D1StatementBudget();
    const failed = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => new Date("2026-09-16T12:00:00.001Z"),
    });

    expect(failed).toMatchObject({
      outcome: "failed",
      pages: 0,
      failure: "classroom_observation_checkpoint_stale",
    });
    expect(listSubmissionPage).not.toHaveBeenCalled();
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({ checkpointCourseId: null, checkpointPageToken: null, scanStartedAt: null });
  });

  it("records and resets a derivation checkpoint that exceeds the declared age bound", async () => {
    const item = await fixture("stale-derivation");
    const setup = new SchoolObservationRepository(env.DB);
    await setup.ensureSync(item.principalId, item.sourceId, NOW);
    await setup.saveCheckpoint({
      principalId: item.principalId,
      sourceId: item.sourceId,
      courseId: item.courseId,
      pageToken: null,
      scanStartedAt: NOW.toISOString(),
      now: NOW,
    });
    await setup.completeSubmissionScan(item.principalId, item.sourceId, NOW);
    const listSubmissionPage = vi.fn();
    const budget = new D1StatementBudget();
    const failed = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: { listSubmissionPage },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => new Date("2026-09-16T12:00:00.001Z"),
    });

    expect(failed).toMatchObject({
      outcome: "failed",
      pages: 0,
      failure: "classroom_observation_derivation_checkpoint_stale",
    });
    expect(listSubmissionPage).not.toHaveBeenCalled();
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({
        derivationScanAt: null,
        derivationStartedAt: null,
        derivationAfterDeadlineId: null,
        lastFailure: "classroom_observation_derivation_checkpoint_stale",
      });
  });

  it("records a provider page-token cycle instead of walking it indefinitely", async () => {
    const item = await fixture("token-cycle");
    const budget = new D1StatementBudget();
    const failed = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(env.DB, budget),
      client: {
        listSubmissionPage: vi.fn(async (_courseId: string, pageToken: string | null) => ({
          items: [],
          rejected: 0,
          nextPageToken: pageToken === null ? "page-1" : "page-1",
        })),
      },
      courses: [{ id: item.courseId, name: "Calculus" }],
      principalId: item.principalId,
      sourceId: item.sourceId,
      budget,
      now: () => NOW,
    });

    expect(failed).toMatchObject({
      outcome: "failed",
      pages: 2,
      failure: "classroom_pagination_unbounded",
    });
    expect(await new SchoolObservationRepository(env.DB).readSync(item.principalId, item.sourceId))
      .toMatchObject({ lastFailure: "classroom_pagination_unbounded" });
  });
});
