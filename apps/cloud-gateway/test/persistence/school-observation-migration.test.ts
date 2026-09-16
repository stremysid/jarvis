import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { applySchoolObservationsMigration } from "./migration.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const PAST = "2026-09-15T11:00:00.000Z";

async function addPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', ?, ?, ?)`).bind(
    principalId, principalId, NOW.toISOString(), NOW.toISOString(),
  ).run();
}

interface Graph {
  readonly principalId: string;
  readonly sourceId: string;
  readonly deadlineId: string;
  readonly secondDeadlineId: string;
}

async function graph(suffix: string): Promise<Graph> {
  const principalId = `principal:school-observation-${suffix}`;
  const sourceId = `classroom-${suffix}`;
  await addPrincipal(principalId);
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
  const first = await deadlines.upsert({
    sourceId,
    externalId: `course-${suffix}:work-1`,
    course: "Calculus",
    title: "Limits quiz",
    dueAt: PAST,
    effort: "quiz",
    leadMinutes: 60,
    now: NOW,
  });
  const second = await deadlines.upsert({
    sourceId,
    externalId: `course-${suffix}:work-2`,
    course: "Calculus",
    title: "Derivative practice",
    dueAt: PAST,
    effort: "other",
    leadMinutes: 60,
    now: NOW,
  });
  await env.DB.prepare(`INSERT INTO school_observation_sync (
    principal_id, source_id, provider, checkpoint_course_id, checkpoint_page_token,
    scan_started_at, derivation_scan_at, derivation_started_at, derivation_after_deadline_id,
    last_batch_at, last_success_at, last_success_started_at,
    last_failure, last_failure_at, created_at, updated_at
  ) VALUES (?, ?, 'google_classroom_api', NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`)
    .bind(
      principalId, sourceId,
      NOW.toISOString(), NOW.toISOString(),
      NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    )
    .run();
  return {
    principalId,
    sourceId,
    deadlineId: first.deadline.deadlineId,
    secondDeadlineId: second.deadline.deadlineId,
  };
}

async function addObservation(
  item: Graph,
  deadlineId = item.deadlineId,
  externalId = `submission-${item.sourceId}`,
): Promise<string> {
  const observationId = newUlid();
  await env.DB.prepare(`INSERT INTO school_assignment_observations (
    principal_id, observation_id, source_id, deadline_id, external_submission_id,
    submission_state, late, assigned_grade, source_updated_at, content_hash,
    first_seen_at, content_changed_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, 'new', NULL, NULL, NULL, ?, ?, ?, ?)`)
    .bind(
      item.principalId, observationId, item.sourceId, deadlineId, externalId,
      "a".repeat(64), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    ).run();
  return observationId;
}

beforeAll(async () => {
  await applySchoolObservationsMigration();
});

describe("school observations migration 0027", () => {
  it("installs every named trigger in remote-D1 WHEN and SELECT RAISE form", async () => {
    const result = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND (
        name LIKE 'school_observation_sync_%'
        OR name LIKE 'school_assignment_observations_%'
        OR name LIKE 'school_assignment_observation_revisions_%'
        OR name LIKE 'school_missing_work_transitions_%'
      ) ORDER BY name`).all<{ name: string; sql: string }>();
    expect(result.results.map((row) => row.name)).toEqual([
      "school_assignment_observation_revisions_delete_guard",
      "school_assignment_observation_revisions_insert_guard",
      "school_assignment_observation_revisions_update_guard",
      "school_assignment_observations_delete_guard",
      "school_assignment_observations_insert_guard",
      "school_assignment_observations_update_guard",
      "school_missing_work_transitions_delete_guard",
      "school_missing_work_transitions_insert_guard",
      "school_missing_work_transitions_update_guard",
      "school_observation_sync_delete_guard",
      "school_observation_sync_insert_guard",
      "school_observation_sync_update_guard",
    ]);
    for (const row of result.results) {
      expect(row.sql, row.name).toMatch(/\bWHEN\b[\s\S]*\bBEGIN\s+SELECT RAISE\(ABORT,/iu);
      expect(row.sql, row.name).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
    }
  });

  it("school_observation_sync_insert_guard defeats replacement and ignore on its unique key", async () => {
    const item = await graph("sync-insert");
    for (const mode of ["OR REPLACE", "OR IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT ${mode} INTO school_observation_sync
        SELECT * FROM school_observation_sync WHERE principal_id = ? AND source_id = ?`)
        .bind(item.principalId, item.sourceId).run())
        .rejects.toThrow(/school_observation_sync_insert_invalid/u);
    }
  });

  it("school_observation_sync_update_guard keeps provider authority and monotonic freshness immutable", async () => {
    const item = await graph("sync-update");
    await expect(env.DB.prepare(`UPDATE school_observation_sync SET provider = 'invented'
      WHERE principal_id = ? AND source_id = ?`).bind(item.principalId, item.sourceId).run())
      .rejects.toThrow(/school_observation_sync_update_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_observation_sync SET last_success_at = NULL
      WHERE principal_id = ? AND source_id = ?`).bind(item.principalId, item.sourceId).run())
      .rejects.toThrow(/school_observation_sync_update_invalid/u);
  });

  it("school_observation_sync_delete_guard keeps source health durable", async () => {
    const item = await graph("sync-delete");
    await expect(env.DB.prepare(`DELETE FROM school_observation_sync
      WHERE principal_id = ? AND source_id = ?`).bind(item.principalId, item.sourceId).run())
      .rejects.toThrow(/school_observation_sync_delete_forbidden/u);
  });

  it("school_assignment_observations_insert_guard covers every unique key against replacement and ignore", async () => {
    const item = await graph("observation-insert");
    const observationId = await addObservation(item);
    for (const mode of ["OR REPLACE", "OR IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT ${mode} INTO school_assignment_observations
        SELECT * FROM school_assignment_observations
        WHERE principal_id = ? AND observation_id = ?`).bind(item.principalId, observationId).run())
        .rejects.toThrow(/school_assignment_observation_insert_invalid/u);
    }
    await expect(addObservation(item, item.secondDeadlineId)).rejects
      .toThrow(/school_assignment_observation_insert_invalid/u);
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO school_assignment_observations (
      principal_id, observation_id, source_id, deadline_id, external_submission_id,
      submission_state, late, assigned_grade, source_updated_at, content_hash,
      first_seen_at, content_changed_at, last_seen_at
    ) SELECT principal_id, ?, source_id, deadline_id, external_submission_id,
      submission_state, late, assigned_grade, source_updated_at, content_hash,
      first_seen_at, content_changed_at, last_seen_at
      FROM school_assignment_observations WHERE principal_id = ? AND observation_id = ?`)
      .bind(newUlid(), item.principalId, observationId).run())
      .rejects.toThrow(/school_assignment_observation_insert_invalid/u);
  });

  it("school_assignment_observations_update_guard requires a matching history row before content changes", async () => {
    const item = await graph("observation-update");
    const observationId = await addObservation(item);
    await expect(env.DB.prepare(`UPDATE school_assignment_observations
      SET submission_state = 'returned', assigned_grade = 82, content_hash = ?,
          content_changed_at = ?, last_seen_at = ?
      WHERE principal_id = ? AND observation_id = ?`)
      .bind("b".repeat(64), NOW.toISOString(), NOW.toISOString(), item.principalId, observationId).run())
      .rejects.toThrow(/school_assignment_observation_update_invalid/u);
  });

  it("school_assignment_observations_delete_guard preserves the current verified observation", async () => {
    const item = await graph("observation-delete");
    const observationId = await addObservation(item);
    await expect(env.DB.prepare(`DELETE FROM school_assignment_observations
      WHERE principal_id = ? AND observation_id = ?`).bind(item.principalId, observationId).run())
      .rejects.toThrow(/school_assignment_observation_delete_forbidden/u);
  });

  it("school_assignment_observation_revisions_insert_guard accepts only the current version and blocks replacement", async () => {
    const item = await graph("revision-insert");
    const observationId = await addObservation(item);
    const revisionId = newUlid();
    const replacedAt = "2026-09-15T12:01:00.000Z";
    await env.DB.prepare(`INSERT INTO school_assignment_observation_revisions (
      principal_id, revision_id, observation_id, submission_state, late, assigned_grade,
      source_updated_at, content_hash, content_changed_at, replaced_at
    ) VALUES (?, ?, ?, 'new', NULL, NULL, NULL, ?, ?, ?)`)
      .bind(item.principalId, revisionId, observationId, "a".repeat(64), NOW.toISOString(), replacedAt).run();
    for (const mode of ["OR REPLACE", "OR IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT ${mode} INTO school_assignment_observation_revisions
        SELECT * FROM school_assignment_observation_revisions
        WHERE principal_id = ? AND revision_id = ?`).bind(item.principalId, revisionId).run())
        .rejects.toThrow(/school_assignment_observation_revision_insert_invalid/u);
    }
  });

  it("school_assignment_observation_revisions_update_guard keeps history immutable", async () => {
    const item = await graph("revision-update");
    const observationId = await addObservation(item);
    const revisionId = newUlid();
    await env.DB.prepare(`INSERT INTO school_assignment_observation_revisions (
      principal_id, revision_id, observation_id, submission_state, late, assigned_grade,
      source_updated_at, content_hash, content_changed_at, replaced_at
    ) VALUES (?, ?, ?, 'new', NULL, NULL, NULL, ?, ?, ?)`)
      .bind(item.principalId, revisionId, observationId, "a".repeat(64), NOW.toISOString(), NOW.toISOString()).run();
    await expect(env.DB.prepare(`UPDATE school_assignment_observation_revisions SET late = 1
      WHERE principal_id = ? AND revision_id = ?`).bind(item.principalId, revisionId).run())
      .rejects.toThrow(/school_assignment_observation_revision_update_forbidden/u);
  });

  it("school_assignment_observation_revisions_delete_guard keeps changed-grade evidence", async () => {
    const item = await graph("revision-delete");
    const observationId = await addObservation(item);
    const revisionId = newUlid();
    await env.DB.prepare(`INSERT INTO school_assignment_observation_revisions (
      principal_id, revision_id, observation_id, submission_state, late, assigned_grade,
      source_updated_at, content_hash, content_changed_at, replaced_at
    ) VALUES (?, ?, ?, 'new', NULL, NULL, NULL, ?, ?, ?)`)
      .bind(item.principalId, revisionId, observationId, "a".repeat(64), NOW.toISOString(), NOW.toISOString()).run();
    await expect(env.DB.prepare(`DELETE FROM school_assignment_observation_revisions
      WHERE principal_id = ? AND revision_id = ?`).bind(item.principalId, revisionId).run())
      .rejects.toThrow(/school_assignment_observation_revision_delete_forbidden/u);
  });

  it("school_missing_work_transitions_insert_guard permits only reconciled derived no-submission evidence", async () => {
    const item = await graph("transition-insert");
    const observationId = await addObservation(item);
    const transitionId = newUlid();
    await env.DB.prepare(`INSERT INTO school_missing_work_transitions (
      principal_id, transition_id, deadline_id, classification, from_state, to_state,
      basis_due_at, basis_observation_id, derived_at
    ) VALUES (?, ?, ?, 'derived', 'untracked', 'no_submission_seen', ?, ?, ?)`)
      .bind(item.principalId, transitionId, item.deadlineId, PAST, observationId, NOW.toISOString()).run();
    for (const mode of ["OR REPLACE", "OR IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT ${mode} INTO school_missing_work_transitions
        SELECT * FROM school_missing_work_transitions
        WHERE principal_id = ? AND transition_id = ?`).bind(item.principalId, transitionId).run())
        .rejects.toThrow(/school_missing_work_transition_insert_invalid/u);
    }
    await expect(env.DB.prepare(`INSERT INTO school_missing_work_transitions (
      principal_id, transition_id, deadline_id, classification, from_state, to_state,
      basis_due_at, basis_observation_id, derived_at
    ) VALUES (?, ?, ?, 'derived', 'untracked', 'submission_seen', ?, NULL, ?)`)
      .bind(item.principalId, newUlid(), item.secondDeadlineId, PAST, NOW.toISOString()).run())
      .rejects.toThrow(/school_missing_work_transition_insert_invalid/u);
  });

  it("school_missing_work_transitions_update_guard keeps derived history immutable", async () => {
    const item = await graph("transition-update");
    const observationId = await addObservation(item);
    const transitionId = newUlid();
    await env.DB.prepare(`INSERT INTO school_missing_work_transitions (
      principal_id, transition_id, deadline_id, classification, from_state, to_state,
      basis_due_at, basis_observation_id, derived_at
    ) VALUES (?, ?, ?, 'derived', 'untracked', 'no_submission_seen', ?, ?, ?)`)
      .bind(item.principalId, transitionId, item.deadlineId, PAST, observationId, NOW.toISOString()).run();
    await expect(env.DB.prepare(`UPDATE school_missing_work_transitions SET classification = 'derived'
      WHERE principal_id = ? AND transition_id = ?`).bind(item.principalId, transitionId).run())
      .rejects.toThrow(/school_missing_work_transition_update_forbidden/u);
  });

  it("school_missing_work_transitions_delete_guard keeps every derivation transition", async () => {
    const item = await graph("transition-delete");
    const observationId = await addObservation(item);
    const transitionId = newUlid();
    await env.DB.prepare(`INSERT INTO school_missing_work_transitions (
      principal_id, transition_id, deadline_id, classification, from_state, to_state,
      basis_due_at, basis_observation_id, derived_at
    ) VALUES (?, ?, ?, 'derived', 'untracked', 'no_submission_seen', ?, ?, ?)`)
      .bind(item.principalId, transitionId, item.deadlineId, PAST, observationId, NOW.toISOString()).run();
    await expect(env.DB.prepare(`DELETE FROM school_missing_work_transitions
      WHERE principal_id = ? AND transition_id = ?`).bind(item.principalId, transitionId).run())
      .rejects.toThrow(/school_missing_work_transition_delete_forbidden/u);
  });
});
