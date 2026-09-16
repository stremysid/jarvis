/**
 * Reviewer probes for PR #61 (school grade/submission observations).
 *
 * These are written to PASS against the PR head, because each one demonstrates
 * a defect. Once the defect is fixed they must FAIL. They are not part of the
 * PR's own suite.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { SchoolObservationRepository } from "../../src/school/school-observation-repository.js";
import type { RawSchoolSubmissionObservation } from "../../src/school/school-observation-types.js";
import { applySchoolObservationsMigration } from "../persistence/migration.js";

const T1 = new Date("2026-09-15T12:00:00.000Z");
const T2 = new Date("2026-09-15T13:00:00.000Z");
const DUE = "2026-09-15T11:00:00.000Z";

beforeAll(async () => {
  await applySchoolObservationsMigration();
});

async function makePrincipal(suffix: string): Promise<string> {
  const principalId = `principal:zz-pr61-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', ?, ?, ?)`).bind(
    principalId, principalId, T1.toISOString(), T1.toISOString(),
  ).run();
  return principalId;
}

interface Work {
  readonly deadlineId: string;
  readonly externalId: string;
}

async function makeDeadlines(sourceId: string, suffix: string, count: number): Promise<Work[]> {
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: T1 });
  const created: Work[] = [];
  for (let index = 0; index < count; index += 1) {
    const externalId = `course-${suffix}:work-${index}`;
    const result = await deadlines.upsert({
      sourceId,
      externalId,
      course: "Calculus",
      title: `Assignment ${index}`,
      dueAt: DUE,
      effort: "quiz",
      leadMinutes: 60,
      now: T1,
    });
    created.push({ deadlineId: result.deadline.deadlineId, externalId });
  }
  return created.sort((left, right) => left.deadlineId.localeCompare(right.deadlineId));
}

function item(work: Work, state: RawSchoolSubmissionObservation["state"]): RawSchoolSubmissionObservation {
  return {
    deadlineExternalId: work.externalId,
    externalSubmissionId: `${work.externalId}:submission-1`,
    state,
    late: false,
    assignedGrade: null,
    sourceUpdatedAt: T1.toISOString(),
  };
}

async function scan(
  repository: SchoolObservationRepository,
  principalId: string,
  sourceId: string,
  items: readonly RawSchoolSubmissionObservation[],
  instant: Date,
): Promise<void> {
  await repository.saveCheckpoint({
    principalId,
    sourceId,
    courseId: `course-${sourceId}`,
    pageToken: null,
    scanStartedAt: instant.toISOString(),
    now: instant,
  });
  await repository.ingest({ principalId, sourceId, items, sourceRejectedCount: 0, now: instant });
  await repository.completeSubmissionScan(principalId, sourceId, instant);
}

describe("PR #61 reviewer probes", () => {
  it("P1: a submitted assignment is still reported as missing while derivation is mid-page", async () => {
    const suffix = "paged";
    const principalId = await makePrincipal(suffix);
    const sourceId = `classroom-zz-${suffix}`;
    const works = await makeDeadlines(sourceId, suffix, 2);
    const first = works[0]!;
    const target = works[1]!;
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(principalId, sourceId, T1);

    // Scan 1: neither is submitted. Derivation completes and both become
    // no_submission_seen.
    await scan(repository, principalId, sourceId, [item(first, "created"), item(target, "created")], T1);
    const firstPass = await repository.deriveMissingWorkPage({
      principalId,
      sourceId,
      derivedAt: T1.toISOString(),
      observationsSeenSince: T1.toISOString(),
      afterDeadlineId: null,
    });
    expect(firstPass.transitions).toBe(2);
    await repository.completeDerivation(principalId, sourceId, T1);

    const before = await repository.readDigestSnapshot({
      principalId, sourceId, changedSince: T1, now: T2,
    });
    expect(before.missingWork.map((row) => row.deadlineId)).toContain(target.deadlineId);

    // Scan 2: Sid has now turned in the second assignment. The scan records
    // that. Derivation is paged, so this run only reaches the first deadline.
    await scan(repository, principalId, sourceId, [item(first, "created"), item(target, "turned_in")], T2);
    const paged = await repository.deriveMissingWorkPage({
      principalId,
      sourceId,
      derivedAt: T2.toISOString(),
      observationsSeenSince: T2.toISOString(),
      afterDeadlineId: null,
      limit: 1,
    });
    expect(paged.nextAfterDeadlineId).toBe(first.deadlineId);
    await repository.saveDerivationCheckpoint(principalId, sourceId, paged.nextAfterDeadlineId!, T2);

    const after = await repository.readDigestSnapshot({
      principalId, sourceId, changedSince: T1, now: T2,
    });
    const stale = after.missingWork.find((row) => row.deadlineId === target.deadlineId);

    // The defect: the turned-in assignment is still reported as missing, and
    // it is stamped with the newest completed scan, so it reads as current.
    expect(stale).toBeDefined();
    expect(stale?.state).toBe("no_submission_seen");
    expect(stale?.derivedAt).toBe(T2.toISOString());

    // And the observation the claim rests on says the opposite.
    const observed = await env.DB.prepare(
      "SELECT submission_state FROM school_assignment_observations WHERE principal_id = ? AND deadline_id = ?",
    ).bind(principalId, target.deadlineId).first<{ submission_state: string }>();
    expect(observed?.submission_state).toBe("turned_in");
  });

  it("P2: the same false claim survives when derivation never runs after the scan", async () => {
    const suffix = "noderive";
    const principalId = await makePrincipal(suffix);
    const sourceId = `classroom-zz-${suffix}`;
    const works = await makeDeadlines(sourceId, suffix, 1);
    const target = works[0]!;
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(principalId, sourceId, T1);

    await scan(repository, principalId, sourceId, [item(target, "created")], T1);
    await repository.deriveMissingWorkPage({
      principalId,
      sourceId,
      derivedAt: T1.toISOString(),
      observationsSeenSince: T1.toISOString(),
      afterDeadlineId: null,
    });
    await repository.completeDerivation(principalId, sourceId, T1);

    // Scan 2 sees the submission. Derivation then fails (budget, D1 error, or
    // the isolate being cut off) before it writes anything.
    await scan(repository, principalId, sourceId, [item(target, "turned_in")], T2);

    const after = await repository.readDigestSnapshot({
      principalId, sourceId, changedSince: T1, now: T2,
    });
    expect(after.missingWork.map((row) => row.deadlineId)).toContain(target.deadlineId);
    expect(after.missingWork[0]?.derivedAt).toBe(T2.toISOString());
  });

  it("P3: work read as NEW before its deadline is reported missing once the scan completes after it", async () => {
    const suffix = "early-read";
    const principalId = await makePrincipal(suffix);
    const sourceId = `classroom-zz-${suffix}`;
    const deadlines = new DeadlineRepository(env.DB);
    await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: T1 });
    const externalId = `course-${suffix}:essay`;
    // Due 12:30: after the read at 12:00, before the multi-slice scan completes at 13:00.
    const due = await deadlines.upsert({
      sourceId, externalId, course: "English", title: "Essay",
      dueAt: "2026-09-15T12:30:00.000Z", effort: "quiz", leadMinutes: 60, now: T1,
    });
    const work = { deadlineId: due.deadline.deadlineId, externalId };
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(principalId, sourceId, T1);
    await repository.saveCheckpoint({
      principalId, sourceId, courseId: `course-${sourceId}`, pageToken: null,
      scanStartedAt: T1.toISOString(), now: T1,
    });
    await repository.ingest({ principalId, sourceId, items: [item(work, "new")], sourceRejectedCount: 0, now: T1 });
    await repository.completeSubmissionScan(principalId, sourceId, T2);
    await repository.deriveMissingWorkPage({
      principalId, sourceId, derivedAt: T2.toISOString(), observationsSeenSince: T1.toISOString(), afterDeadlineId: null,
    });
    await repository.completeDerivation(principalId, sourceId, T2);
    const snapshot = await repository.readDigestSnapshot({ principalId, sourceId, changedSince: T1, now: T2 });
    // The only evidence is a read taken 30 minutes before the deadline.
    expect(snapshot.missingWork.map((row) => row.deadlineId)).toContain(work.deadlineId);
  });

  it("P4: a replayed derivation after a due-date change can never complete", async () => {
    const suffix = "wedge";
    const principalId = await makePrincipal(suffix);
    const sourceId = `classroom-zz-${suffix}`;
    const works = await makeDeadlines(sourceId, suffix, 1);
    const target = works[0]!;
    const repository = new SchoolObservationRepository(env.DB);
    await repository.ensureSync(principalId, sourceId, T1);
    await scan(repository, principalId, sourceId, [item(target, "created")], T1);
    await repository.deriveMissingWorkPage({
      principalId, sourceId, derivedAt: T1.toISOString(), observationsSeenSince: T1.toISOString(), afterDeadlineId: null,
    });
    // completeDerivation is lost here. The teacher then extends the deadline.
    await new DeadlineRepository(env.DB).upsert({
      sourceId, externalId: target.externalId, course: "Calculus", title: "Assignment 0",
      dueAt: "2026-09-20T11:00:00.000Z", effort: "quiz", leadMinutes: 60, now: T2,
    });
    const sync = await repository.readSync(principalId, sourceId);
    expect(sync?.derivationScanAt).toBe(T1.toISOString());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(repository.deriveMissingWorkPage({
        principalId, sourceId, derivedAt: sync!.derivationScanAt!, observationsSeenSince: sync!.derivationStartedAt!,
        afterDeadlineId: sync!.derivationAfterDeadlineId,
      })).rejects.toThrow();
    }
  });
});
