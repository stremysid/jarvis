import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { SchoolProgressRepository } from "../../src/school/school-progress-repository.js";
import { applySchoolProgressMigration } from "./migration.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");
let sequence = 0;

interface Seeded {
  readonly principalId: string;
  readonly workItemId: string;
  readonly submissionObservationId: string;
  readonly gradeObservationId: string;
  readonly transitionId: string;
}

async function addPrincipal(prefix: string): Promise<string> {
  sequence += 1;
  const principalId = `principal:${prefix}:${sequence}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`)
    .bind(principalId, NOW.toISOString()).run();
  return principalId;
}

async function seed(prefix: string): Promise<Seeded> {
  const principalId = await addPrincipal(prefix);
  await new SchoolProgressRepository(env.DB).ingestClassroomCourse({
    principalId,
    sourceId: "google-classroom",
    checkpointCourseId: "course-chem",
    checkpointWorkItemExternalId: null,
    healthGap: null,
    now: NOW,
    items: [{
      externalId: "course-chem:work-lab",
      course: "SCH4U Chemistry",
      title: "Acid-base lab",
      dueAt: "2026-09-15T20:00:00.000Z",
      maximumPoints: 100,
      submission: {
        externalId: "submission-lab",
        state: "returned",
        late: false,
        sourceUpdatedAt: "2026-09-16T11:55:00.000Z",
      },
      assignedPoints: 84,
    }],
  });
  const work = await env.DB.prepare(`SELECT work_item_id FROM school_progress_work_items
    WHERE principal_id = ?1`).bind(principalId).first<{ work_item_id: string }>();
  const submission = await env.DB.prepare(`SELECT observation_id FROM school_submission_observations
    WHERE principal_id = ?1`).bind(principalId).first<{ observation_id: string }>();
  const grade = await env.DB.prepare(`SELECT grade_observation_id FROM school_grade_observations
    WHERE principal_id = ?1`).bind(principalId).first<{ grade_observation_id: string }>();
  const transition = await env.DB.prepare(`SELECT transition_id FROM school_missing_work_transitions
    WHERE principal_id = ?1`).bind(principalId).first<{ transition_id: string }>();
  if (work === null || submission === null || grade === null || transition === null) {
    throw new Error("school_progress_fixture_failed");
  }
  return {
    principalId,
    workItemId: work.work_item_id,
    submissionObservationId: submission.observation_id,
    gradeObservationId: grade.grade_observation_id,
    transitionId: transition.transition_id,
  };
}

async function rejects(statement: D1PreparedStatement, message: string): Promise<void> {
  await expect(statement.run()).rejects.toThrow(message);
}

beforeAll(async () => {
  await applySchoolProgressMigration();
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.ensureSource({
    sourceId: "google-classroom", kind: "classroom", label: "Google Classroom", now: NOW,
  });
  await deadlines.ensureSource({
    sourceId: "manual-progress", kind: "manual", label: "Manual", now: NOW,
  });
});

describe("0027 school progress trigger contracts", () => {
  it("school_progress_source_state_insert_guard makes INSERT OR REPLACE abort before replacement deletion", async () => {
    const seeded = await seed("source-insert");
    await rejects(env.DB.prepare(`INSERT OR REPLACE INTO school_progress_source_state
      SELECT * FROM school_progress_source_state WHERE principal_id = ?1`)
      .bind(seeded.principalId), "school_progress_source_insert_conflict");
  });

  it("school_progress_source_state_require_classroom rejects a non-Classroom source row", async () => {
    const principalId = await addPrincipal("source-kind");
    await rejects(env.DB.prepare(`INSERT INTO school_progress_source_state (
      principal_id, source_id, route, checkpoint_course_id, last_success_at,
      last_failure, last_failure_at, created_at, updated_at
    ) VALUES (?1, 'manual-progress', 'classroom_api', NULL, NULL, NULL, NULL, ?2, ?2)`)
      .bind(principalId, NOW.toISOString()), "school_progress_source_invalid");
  });

  it("school_progress_source_state_core_immutable rejects changing creation identity", async () => {
    const seeded = await seed("source-core");
    await rejects(env.DB.prepare(`UPDATE school_progress_source_state SET created_at = ?1
      WHERE principal_id = ?2`).bind("2026-09-16T11:59:00.000Z", seeded.principalId),
    "school_progress_source_core_immutable");
  });

  it("school_progress_source_state_reject_delete preserves source health and checkpoint state", async () => {
    const seeded = await seed("source-delete");
    await rejects(env.DB.prepare("DELETE FROM school_progress_source_state WHERE principal_id = ?1")
      .bind(seeded.principalId), "school_progress_source_delete_forbidden");
  });

  it("school_progress_work_items_insert_guard makes OR IGNORE abort on every unique key", async () => {
    const seeded = await seed("work-insert");
    await rejects(env.DB.prepare(`INSERT OR IGNORE INTO school_progress_work_items
      SELECT * FROM school_progress_work_items WHERE principal_id = ?1`)
      .bind(seeded.principalId), "school_progress_work_item_insert_conflict");
  });

  it("school_progress_work_items_core_immutable rejects source identity rewrites", async () => {
    const seeded = await seed("work-core");
    await rejects(env.DB.prepare(`UPDATE school_progress_work_items SET external_id = 'different'
      WHERE principal_id = ?1`).bind(seeded.principalId), "school_progress_work_item_core_immutable");
  });

  it("school_progress_work_items_reject_delete preserves the rows behind observations", async () => {
    const seeded = await seed("work-delete");
    await rejects(env.DB.prepare("DELETE FROM school_progress_work_items WHERE principal_id = ?1")
      .bind(seeded.principalId), "school_progress_work_item_delete_forbidden");
  });

  it("school_submission_observations_insert_guard makes OR IGNORE abort on replay", async () => {
    const seeded = await seed("submission-insert");
    await rejects(env.DB.prepare(`INSERT OR IGNORE INTO school_submission_observations
      SELECT * FROM school_submission_observations WHERE principal_id = ?1`)
      .bind(seeded.principalId), "school_submission_observation_insert_conflict");
  });

  it("school_submission_observations_reject_update keeps provider observations append-only", async () => {
    const seeded = await seed("submission-update");
    await rejects(env.DB.prepare(`UPDATE school_submission_observations SET late = 1
      WHERE principal_id = ?1`).bind(seeded.principalId), "school_submission_observation_update_forbidden");
  });

  it("school_submission_observations_reject_delete keeps provider observations append-only", async () => {
    const seeded = await seed("submission-delete");
    await rejects(env.DB.prepare("DELETE FROM school_submission_observations WHERE principal_id = ?1")
      .bind(seeded.principalId), "school_submission_observation_delete_forbidden");
  });

  it("school_grade_observations_insert_guard makes OR IGNORE abort on replay", async () => {
    const seeded = await seed("grade-insert");
    await rejects(env.DB.prepare(`INSERT OR IGNORE INTO school_grade_observations
      SELECT * FROM school_grade_observations WHERE principal_id = ?1`)
      .bind(seeded.principalId), "school_grade_observation_insert_conflict");
  });

  it("school_grade_observations_reject_update keeps verified grades append-only", async () => {
    const seeded = await seed("grade-update");
    await rejects(env.DB.prepare(`UPDATE school_grade_observations SET assigned_points = 85
      WHERE principal_id = ?1`).bind(seeded.principalId), "school_grade_observation_update_forbidden");
  });

  it("school_grade_observations_reject_delete keeps verified grades append-only", async () => {
    const seeded = await seed("grade-delete");
    await rejects(env.DB.prepare("DELETE FROM school_grade_observations WHERE principal_id = ?1")
      .bind(seeded.principalId), "school_grade_observation_delete_forbidden");
  });

  it("school_missing_work_transitions_insert_guard makes OR IGNORE abort on replay", async () => {
    const seeded = await seed("transition-insert");
    await rejects(env.DB.prepare(`INSERT OR IGNORE INTO school_missing_work_transitions
      SELECT * FROM school_missing_work_transitions WHERE principal_id = ?1`)
      .bind(seeded.principalId), "school_missing_work_transition_insert_conflict");
  });

  it("school_missing_work_transitions_basis_guard rejects no-submission-seen when a returned signal exists", async () => {
    const seeded = await seed("transition-basis");
    await rejects(env.DB.prepare(`INSERT INTO school_missing_work_transitions (
      principal_id, transition_id, work_item_id, derived_state, basis_due_at,
      basis_checked_at, basis_submission_observation_id, derived_at
    ) VALUES (?1, ?2, ?3, 'no_submission_seen', '2026-09-15T20:00:00.000Z',
      ?4, NULL, ?4)`).bind(seeded.principalId, newUlid(NOW), seeded.workItemId, NOW.toISOString()),
    "school_missing_work_transition_basis_invalid");
  });

  it("school_missing_work_transitions_reject_update keeps derivation history append-only", async () => {
    const seeded = await seed("transition-update");
    await rejects(env.DB.prepare(`UPDATE school_missing_work_transitions SET derived_state = 'no_submission_seen'
      WHERE principal_id = ?1`).bind(seeded.principalId), "school_missing_work_transition_update_forbidden");
  });

  it("school_missing_work_transitions_reject_delete keeps derivation history append-only", async () => {
    const seeded = await seed("transition-delete");
    await rejects(env.DB.prepare("DELETE FROM school_missing_work_transitions WHERE principal_id = ?1")
      .bind(seeded.principalId), "school_missing_work_transition_delete_forbidden");
  });
});
