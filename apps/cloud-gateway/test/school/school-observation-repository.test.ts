import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { assembleDigest } from "../../src/jobs/digest-job.js";
import {
  CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET,
  D1StatementBudget,
  SCHOOL_STUDY_OBSERVATION_ROW_LIMIT,
  SchoolObservationRepository,
} from "../../src/school/school-observation-repository.js";
import type { RawSchoolSubmissionObservation } from "../../src/school/school-observation-types.js";
import { applyStudyCoachWeakSpotsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");

interface Fixture {
  readonly principalId: string;
  readonly sourceId: string;
  readonly deadlineId: string;
  readonly deadlineExternalId: string;
}

async function fixture(suffix: string, dueAt = "2026-09-15T11:00:00.000Z"): Promise<Fixture> {
  const principalId = `principal:school-observation-repo-${suffix}`;
  const sourceId = `classroom-repo-${suffix}`;
  const deadlineExternalId = `course-${suffix}:work-1`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', ?, ?, ?)`).bind(
    principalId, principalId, NOW.toISOString(), NOW.toISOString(),
  ).run();
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
  const deadline = await deadlines.upsert({
    sourceId,
    externalId: deadlineExternalId,
    course: "Calculus",
    title: "Limits quiz",
    dueAt,
    now: NOW,
  });
  return { principalId, sourceId, deadlineId: deadline.deadline.deadlineId, deadlineExternalId };
}

function observation(
  item: Fixture,
  overrides: Partial<RawSchoolSubmissionObservation> = {},
): RawSchoolSubmissionObservation {
  return {
    deadlineExternalId: item.deadlineExternalId,
    externalSubmissionId: `${item.deadlineExternalId}:submission-1`,
    state: "returned",
    late: false,
    assignedGrade: 83.5,
    maxPoints: 100,
    sourceUpdatedAt: NOW.toISOString(),
    ...overrides,
  };
}

async function completeScan(
  repository: SchoolObservationRepository,
  item: Fixture,
  instant: Date,
): Promise<void> {
  const at = instant.toISOString();
  await repository.saveCheckpoint({
    principalId: item.principalId,
    sourceId: item.sourceId,
    courseId: `course-${item.sourceId}`,
    pageToken: null,
    scanStartedAt: at,
    now: instant,
  });
  await repository.completeSubmissionScan(item.principalId, item.sourceId, instant);
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
});

describe("SchoolObservationRepository", () => {
  it("keeps an exact verified grade, its source freshness and its changed-version history", async () => {
    const item = await fixture("grade-history", "2026-09-16T11:00:00.000Z");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);

    expect(await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item)],
      now: NOW,
    })).toEqual({ created: 1, revised: 0, unchanged: 0, rejected: 0 });

    const refreshedAt = new Date("2026-09-15T13:00:00.000Z");
    expect(await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item)],
      now: refreshedAt,
    })).toEqual({ created: 0, revised: 0, unchanged: 1, rejected: 0 });

    const changedAt = new Date("2026-09-15T14:00:00.000Z");
    expect(await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { assignedGrade: 87.25, sourceUpdatedAt: changedAt.toISOString() })],
      now: changedAt,
    })).toEqual({ created: 0, revised: 1, unchanged: 0, rejected: 0 });

    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: changedAt,
    });
    expect(snapshot.grades).toHaveLength(1);
    expect(snapshot.grades[0]).toMatchObject({
      deadlineId: item.deadlineId,
      course: "Calculus",
      title: "Limits quiz",
      assignedGrade: 87.25,
      maxPoints: 100,
      source: "google_classroom_api",
      gradeUpdatedAt: changedAt.toISOString(),
      contentChangedAt: changedAt.toISOString(),
      lastSeenAt: changedAt.toISOString(),
    });
    const revisions = await env.DB.prepare(`SELECT assigned_grade, max_points, content_changed_at, replaced_at
      FROM school_assignment_observation_revisions
      WHERE principal_id = ? ORDER BY replaced_at`).bind(item.principalId).all<{
        assigned_grade: number | null;
        max_points: number | null;
        content_changed_at: string;
        replaced_at: string;
      }>();
    expect(revisions.results).toEqual([{
      assigned_grade: 83.5,
      max_points: 100,
      content_changed_at: NOW.toISOString(),
      replaced_at: changedAt.toISOString(),
    }]);
  });

  it("does not expose a mark when the verified feed did not supply one", async () => {
    const item = await fixture("no-grade");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"),
      now: NOW,
    });
    expect(snapshot.grades).toEqual([]);
  });

  it("returns a bounded study-grade snapshot with source freshness", async () => {
    const item = await fixture("study-grade-bound", "2026-09-16T11:00:00.000Z");
    const repository = new SchoolObservationRepository(env.DB);
    const deadlines = new DeadlineRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    const items: RawSchoolSubmissionObservation[] = [observation(item)];
    for (let index = 1; index <= SCHOOL_STUDY_OBSERVATION_ROW_LIMIT; index += 1) {
      const externalId = `${item.deadlineExternalId}-${index}`;
      await deadlines.upsert({
        sourceId: item.sourceId,
        externalId,
        course: "Calculus",
        title: `Untrusted title ${index}`,
        dueAt: "2026-09-16T11:00:00.000Z",
        now: NOW,
      });
      items.push(observation(item, {
        deadlineExternalId: externalId,
        externalSubmissionId: `${externalId}:submission-1`,
        assignedGrade: 60 + index,
      }));
    }
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items,
      now: NOW,
    });
    await completeScan(repository, item, NOW);

    const snapshot = await repository.readStudySnapshot({ principalId: item.principalId, now: NOW });

    expect(snapshot.grades).toHaveLength(SCHOOL_STUDY_OBSERVATION_ROW_LIMIT);
    expect(snapshot.missingWork).toEqual([]);
    expect(snapshot.grades[0]).toMatchObject({
      course: "Calculus",
      source: "google_classroom_api",
      sourceLastSuccessAt: NOW.toISOString(),
      sourceLastFailure: null,
    });
  });

  it("the study snapshot uses only the latest missing-work transition when submission evidence arrives", async () => {
    const item = await fixture("derived-transition");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    const first = await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: NOW.toISOString(),
      observationsSeenSince: NOW.toISOString(),
      afterDeadlineId: null,
    });
    expect(first.transitions).toBe(1);
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    let snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"),
      now: NOW,
    });
    expect(snapshot.missingWork).toEqual([expect.objectContaining({
      deadlineId: item.deadlineId,
      classification: "derived",
      state: "no_submission_seen",
      lastSeenAt: NOW.toISOString(),
    })]);

    const submittedAt = new Date("2026-09-15T13:00:00.000Z");
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "turned_in", assignedGrade: null, sourceUpdatedAt: submittedAt.toISOString() })],
      now: submittedAt,
    });
    await completeScan(repository, item, submittedAt);
    const second = await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: submittedAt.toISOString(),
      observationsSeenSince: submittedAt.toISOString(),
      afterDeadlineId: null,
    });
    expect(second.transitions).toBe(1);
    await repository.completeDerivation(item.principalId, item.sourceId, submittedAt);

    snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"),
      now: submittedAt,
    });
    expect(snapshot.missingWork).toEqual([]);
    expect((await repository.readStudySnapshot({ principalId: item.principalId, now: submittedAt })).missingWork)
      .toEqual([]);
    const transitions = await env.DB.prepare(`SELECT classification, from_state, to_state
      FROM school_missing_work_transitions WHERE principal_id = ? ORDER BY derived_at`)
      .bind(item.principalId).all<{ classification: string; from_state: string; to_state: string }>();
    expect(transitions.results).toEqual([
      { classification: "derived", from_state: "untracked", to_state: "no_submission_seen" },
      { classification: "derived", from_state: "no_submission_seen", to_state: "submission_seen" },
    ]);
  });

  it("the study snapshot requires the current observation to remain unsubmitted", async () => {
    const item = await fixture("current-submission-state");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: NOW.toISOString(), observationsSeenSince: NOW.toISOString(), afterDeadlineId: null,
    });
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    const submittedAt = new Date("2026-09-15T13:00:00.000Z");
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "turned_in", assignedGrade: null, sourceUpdatedAt: submittedAt.toISOString() })],
      now: submittedAt,
    });

    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId, sourceId: item.sourceId,
      changedSince: NOW, now: submittedAt,
    });
    expect(snapshot.missingWork).toEqual([]);
    expect((await repository.readStudySnapshot({ principalId: item.principalId, now: submittedAt })).missingWork)
      .toEqual([]);
  });

  it("does not derive no submission seen from an observation read before the deadline", async () => {
    const item = await fixture("pre-deadline-evidence", "2026-09-15T12:30:00.000Z");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    const completedAt = new Date("2026-09-15T13:00:00.000Z");
    await repository.saveCheckpoint({
      principalId: item.principalId, sourceId: item.sourceId,
      courseId: `course-${item.sourceId}`, pageToken: null,
      scanStartedAt: NOW.toISOString(), now: NOW,
    });
    await repository.completeSubmissionScan(item.principalId, item.sourceId, completedAt);
    const report = await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: completedAt.toISOString(), observationsSeenSince: NOW.toISOString(), afterDeadlineId: null,
    });
    expect(report.transitions).toBe(0);
    await repository.completeDerivation(item.principalId, item.sourceId, completedAt);
    expect((await repository.readDigestSnapshot({
      principalId: item.principalId, sourceId: item.sourceId,
      changedSince: NOW, now: completedAt,
    })).missingWork).toEqual([]);
  });

  it("keeps the digest evidence stamp at the Classroom read time when the scan completes later", async () => {
    const item = await fixture("read-time-stamp");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await repository.saveCheckpoint({
      principalId: item.principalId,
      sourceId: item.sourceId,
      courseId: `course-${item.sourceId}`,
      pageToken: null,
      scanStartedAt: NOW.toISOString(),
      now: NOW,
    });
    const completedAt = new Date("2026-09-15T13:00:00.000Z");
    await repository.completeSubmissionScan(item.principalId, item.sourceId, completedAt);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: completedAt.toISOString(),
      observationsSeenSince: NOW.toISOString(),
      afterDeadlineId: null,
    });
    await repository.completeDerivation(item.principalId, item.sourceId, completedAt);

    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: completedAt,
    });
    expect(snapshot.source?.lastSuccessAt).toBe(completedAt.toISOString());
    expect(snapshot.missingWork[0]?.lastSeenAt).toBe(NOW.toISOString());

    const digest = await assembleDigest("daily", {
      sources: {
        readCatchupActions: async () => [],
        readApplicationItems: async () => [],
        readDeadlines: async () => [],
        readDeadlineSources: async () => [{
          sourceId: item.sourceId,
          kind: "classroom",
          label: "Classroom",
          active: true,
          lastSuccessAt: completedAt.toISOString(),
          lastFailure: null,
          lastFailureAt: null,
          createdAt: NOW.toISOString(),
        }],
        readSchoolObservations: async () => snapshot,
        readProjectStatuses: async () => [],
        readOpenDecisions: async () => [],
      },
      delivery: { send: async () => undefined },
      clock: { now: () => completedAt },
      timeZone: "America/Toronto",
    });
    expect(digest.text).toContain("showed no submission as of 2026-09-15 08:00 local");
    expect(digest.text).not.toContain("showed no submission as of 2026-09-15 09:00 local");
  });

  it("replays a committed derivation page idempotently after the deadline changes", async () => {
    const item = await fixture("derivation-replay");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    expect((await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: NOW.toISOString(), observationsSeenSince: NOW.toISOString(), afterDeadlineId: null,
    })).transitions).toBe(1);

    const changedAt = new Date("2026-09-15T13:00:00.000Z");
    await new DeadlineRepository(env.DB).upsert({
      sourceId: item.sourceId,
      externalId: item.deadlineExternalId,
      course: "Calculus",
      title: "Limits quiz",
      dueAt: "2026-09-20T11:00:00.000Z",
      now: changedAt,
    });
    await expect(repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: NOW.toISOString(), observationsSeenSince: NOW.toISOString(), afterDeadlineId: null,
    })).resolves.toMatchObject({ transitions: 0, nextAfterDeadlineId: null });
    await repository.completeDerivation(item.principalId, item.sourceId, changedAt);
  });

  it("stops showing a derived item immediately when its deadline is extended", async () => {
    const item = await fixture("deadline-extension");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: NOW.toISOString(), observationsSeenSince: NOW.toISOString(), afterDeadlineId: null,
    });
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    const changedAt = new Date("2026-09-15T13:00:00.000Z");
    await new DeadlineRepository(env.DB).upsert({
      sourceId: item.sourceId,
      externalId: item.deadlineExternalId,
      course: "Calculus",
      title: "Limits quiz",
      dueAt: "2026-09-20T11:00:00.000Z",
      now: changedAt,
    });
    expect((await repository.readDigestSnapshot({
      principalId: item.principalId, sourceId: item.sourceId,
      changedSince: NOW, now: changedAt,
    })).missingWork).toEqual([]);
  });

  it("stops showing a derived item when its deadline moves after the basis read but remains overdue", async () => {
    const item = await fixture("deadline-extension-still-overdue");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: NOW.toISOString(),
      observationsSeenSince: NOW.toISOString(),
      afterDeadlineId: null,
    });
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    const changedAt = new Date("2026-09-15T13:00:00.000Z");
    await new DeadlineRepository(env.DB).upsert({
      sourceId: item.sourceId,
      externalId: item.deadlineExternalId,
      course: "Calculus",
      title: "Limits quiz",
      dueAt: "2026-09-15T12:30:00.000Z",
      now: changedAt,
    });
    expect((await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: NOW,
      now: changedAt,
    })).missingWork).toEqual([]);
  });

  it("stays silent when an overdue deadline has no submission observation row at all", async () => {
    const item = await fixture("bare-absence");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await completeScan(repository, item, NOW);
    const report = await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: NOW.toISOString(),
      observationsSeenSince: NOW.toISOString(),
      afterDeadlineId: null,
    });
    expect(report.transitions).toBe(0);
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);
    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"),
      now: NOW,
    });
    expect(snapshot.missingWork).toEqual([]);
  });

  it("stops showing no submission seen when a later completed scan did not observe that assignment", async () => {
    const item = await fixture("stale-absence");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "new", assignedGrade: null, sourceUpdatedAt: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: NOW.toISOString(),
      observationsSeenSince: NOW.toISOString(),
      afterDeadlineId: null,
    });
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    const later = new Date("2026-09-15T13:00:00.000Z");
    await completeScan(repository, item, later);
    const report = await repository.deriveMissingWorkPage({
      principalId: item.principalId,
      sourceId: item.sourceId,
      derivedAt: later.toISOString(),
      observationsSeenSince: later.toISOString(),
      afterDeadlineId: null,
    });
    expect(report.transitions).toBe(0);
    await repository.completeDerivation(item.principalId, item.sourceId, later);

    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId,
      sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"),
      now: later,
    });
    expect(snapshot.missingWork).toEqual([]);
  });

  it("re-derives no submission seen after Classroom reports that a turned-in item was reclaimed", async () => {
    const item = await fixture("reclaimed");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "turned_in", assignedGrade: null })],
      now: NOW,
    });
    await completeScan(repository, item, NOW);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: NOW.toISOString(), afterDeadlineId: null,
      observationsSeenSince: NOW.toISOString(),
    });
    await repository.completeDerivation(item.principalId, item.sourceId, NOW);

    const reclaimedAt = new Date("2026-09-15T13:00:00.000Z");
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item, { state: "reclaimed_by_student", assignedGrade: null, sourceUpdatedAt: reclaimedAt.toISOString() })],
      now: reclaimedAt,
    });
    await completeScan(repository, item, reclaimedAt);
    await repository.deriveMissingWorkPage({
      principalId: item.principalId, sourceId: item.sourceId,
      derivedAt: reclaimedAt.toISOString(), afterDeadlineId: null,
      observationsSeenSince: reclaimedAt.toISOString(),
    });
    await repository.completeDerivation(item.principalId, item.sourceId, reclaimedAt);

    const snapshot = await repository.readDigestSnapshot({
      principalId: item.principalId, sourceId: item.sourceId,
      changedSince: new Date("2026-09-01T00:00:00.000Z"), now: reclaimedAt,
    });
    expect(snapshot.missingWork[0]).toMatchObject({
      classification: "derived",
      state: "no_submission_seen",
      lastSeenAt: reclaimedAt.toISOString(),
    });
  });

  it("re-validates malformed feed observations and never stores an invented course or mark", async () => {
    const item = await fixture("invalid-feed");
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    const report = await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [
        observation(item, { deadlineExternalId: "unknown-course:invented-work" }),
        { ...observation(item), assignedGrade: Number.NaN },
      ],
      now: NOW,
    });
    expect(report).toEqual({ created: 0, revised: 0, unchanged: 0, rejected: 2 });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_assignment_observations
      WHERE principal_id = ?`).bind(item.principalId).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("declares and counts every D1 statement in the repeated ingestion step", async () => {
    const item = await fixture("budget");
    const budget = new D1StatementBudget();
    const repository = new SchoolObservationRepository(env.DB, budget);
    await repository.ensureSync(item.principalId, item.sourceId, NOW);
    await repository.ingest({
      principalId: item.principalId,
      sourceId: item.sourceId,
      items: [observation(item)],
      now: NOW,
    });
    expect(budget.used).toBe(6);
    expect(budget.used).toBeLessThanOrEqual(CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET);

    const oneStatement = new D1StatementBudget(1);
    const bounded = new SchoolObservationRepository(env.DB, oneStatement);
    await bounded.readSync(item.principalId, item.sourceId);
    await expect(bounded.readSync(item.principalId, item.sourceId))
      .rejects.toThrow("school_observation_d1_budget_exhausted");
  });
});
