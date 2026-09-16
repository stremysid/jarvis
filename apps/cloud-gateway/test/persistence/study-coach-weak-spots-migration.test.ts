import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { SchoolObservationRepository } from "../../src/school/school-observation-repository.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { applyStudyCoachWeakSpotsMigration } from "./migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

const TRIGGERS = Object.freeze([
  "school_assignment_observations_scale_update_guard",
  "school_assignment_observation_revisions_scale_insert_guard",
  "school_study_check_in_claims_insert_guard",
  "school_study_check_in_claims_update_guard",
  "school_study_check_in_claims_delete_guard",
  "school_study_signal_controls_insert_guard",
  "school_study_signal_controls_update_guard",
  "school_study_signal_controls_delete_guard",
]);

interface Graph {
  readonly principalId: string;
  readonly courseId: Ulid;
  readonly claimId: Ulid;
  readonly earlyTurnId: Ulid;
  readonly directTurnId: Ulid;
  readonly voiceTurnId: Ulid;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
}

async function addTurn(
  principalId: string,
  channel: "telegram" | "voice",
  text: string,
  offset: number,
): Promise<Ulid> {
  const now = new Date(NOW.getTime() + offset);
  const turnId = newUlid(now);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("study_weak_spot_migration_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `${channel}:${principalId}`,
    principalId,
    channel,
    userText: redacted,
    now,
  });
  return turnId;
}

async function graph(suffix: string, externalDeadline = false): Promise<Graph> {
  const principalId = `principal:study-weak-spot-migration-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const planTurnId = await addTurn(principalId, "telegram", "Create the Chemistry course", 0);
  const directTurnId = await addTurn(principalId, "telegram", "I already handled that", 1_000);
  const voiceTurnId = await addTurn(principalId, "voice", "I already handled that", 2_000);
  const school = new SchoolCatchupRepository(env.DB);
  await school.applyOwnerPlan({
    principalId,
    turnId: planTurnId,
    today: TODAY,
    responseHash: suffix.replace(/[^a-f0-9]/gu, "a").padEnd(64, "a").slice(0, 64),
    now: NOW,
    plan: {
      engaged: true,
      reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "D2L",
        addFacts: [{
          kind: externalDeadline ? "due_work" : "weak_area",
          statement: externalDeadline ? "Worksheet due" : "Stoichiometry feels uncertain",
        }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1",
        localDate: TODAY,
        sequenceRank: 1,
        text: "Review Chemistry",
        estimatedMinutes: 20,
      }],
    },
  });
  const courseId = (await school.readSnapshot(principalId, TODAY)).courses[0]!.courseId;
  const study = new StudyCoachRepository(env.DB);
  const signalInputs = externalDeadline ? await (async () => {
    const deadlines = new DeadlineRepository(env.DB);
    const source = await deadlines.createSource({
      sourceId: `weak-spot-${suffix}`,
      kind: "manual",
      label: "Owner deadlines",
      now: NOW,
    });
    await deadlines.upsert({
      sourceId: source.sourceId,
      externalId: `overdue-${suffix}`,
      course: "Chemistry",
      title: "Untrusted title",
      dueAt: "2026-09-15T13:30:00.000Z",
      effort: "other",
      leadMinutes: 60,
      now: NOW,
    });
    return { deadlines: await deadlines.listStudyCandidates(NOW) };
  })() : undefined;
  const claimed = await study.syncAndClaimDigestCheckIn({
    principalId,
    today: TODAY,
    weekday: 2,
    minuteOfDay: 450,
    now: new Date(NOW.getTime() + 500),
    signalInputs,
  });
  if (claimed === null) throw new Error("study_weak_spot_claim_fixture_missing");
  const claim = await env.DB.prepare(`SELECT claim_id, source_keys_json
    FROM school_study_check_in_claims WHERE principal_id = ?1 AND local_date = ?2`)
    .bind(principalId, TODAY).first<{ claim_id: string; source_keys_json: string }>();
  if (claim === null) throw new Error("study_weak_spot_claim_row_missing");
  const sourceKeys = JSON.parse(claim.source_keys_json) as unknown;
  if (!Array.isArray(sourceKeys) || typeof sourceKeys[0] !== "string") {
    throw new Error("study_weak_spot_source_key_missing");
  }
  return {
    principalId,
    courseId,
    claimId: claim.claim_id as Ulid,
    earlyTurnId: planTurnId,
    directTurnId,
    voiceTurnId,
    sourceKey: sourceKeys[0],
    sourceRecordId: externalDeadline
      ? sourceKeys[0].slice("deadline:".length)
      : claimed.citations[0]!.sourceRecordId,
  };
}

async function scaleObservation(suffix: string): Promise<{
  readonly principalId: string;
  readonly observationId: string;
}> {
  const principalId = `principal:study-scale-migration-${suffix}`;
  const sourceId = `study-scale-source-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const deadlines = new DeadlineRepository(env.DB);
  await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
  await deadlines.upsert({
    sourceId, externalId: `course-${suffix}:work-1`, course: "Chemistry", title: "Quiz",
    dueAt: "2026-09-15T13:30:00.000Z", effort: "quiz", leadMinutes: 60, now: NOW,
  });
  const observations = new SchoolObservationRepository(env.DB);
  await observations.ensureSync(principalId, sourceId, NOW);
  await observations.ingest({
    principalId, sourceId, now: NOW,
    items: [{
      deadlineExternalId: `course-${suffix}:work-1`,
      externalSubmissionId: `course-${suffix}:work-1:submission-1`,
      state: "returned", late: false, assignedGrade: 9, maxPoints: 10,
      sourceUpdatedAt: NOW.toISOString(),
    }],
  });
  const row = await env.DB.prepare(`SELECT observation_id FROM school_assignment_observations
    WHERE principal_id = ?1`).bind(principalId).first<{ observation_id: string }>();
  if (row === null) throw new Error("study_scale_observation_missing");
  return { principalId, observationId: row.observation_id };
}

function insertDeadlineControl(item: Graph, input: {
  readonly verb?: "INSERT" | "INSERT OR REPLACE";
  readonly principalId?: string;
  readonly sourceKey?: string;
  readonly sourceRecordId?: string;
  readonly turnId?: string;
  readonly disposition?: "wrong" | "handled";
} = {}): Promise<D1Result<unknown>> {
  const controlledAt = new Date(NOW.getTime() + 1_000).toISOString();
  return env.DB.prepare(`${input.verb ?? "INSERT"} INTO school_study_signal_controls (
      principal_id, source_key, source_kind, source_record_id, disposition,
      check_in_id, control_turn_id, controlled_at, created_at
    ) VALUES (?1, ?2, 'deadline', ?3, ?4, ?5, ?6, ?7, ?7)`)
    .bind(
      input.principalId ?? item.principalId,
      input.sourceKey ?? item.sourceKey,
      input.sourceRecordId ?? item.sourceRecordId,
      input.disposition ?? "handled",
      item.claimId,
      input.turnId ?? item.directTurnId,
      controlledAt,
    ).run();
}

async function insertControlForMissingRecord(
  kind: "grade" | "missing_work" | "deadline",
  suffix: string,
): Promise<unknown> {
  const item = await graph(`missing-${suffix}`, true);
  const sourceRecordId = newUlid(new Date(NOW.getTime() + 2_000));
  const sourceKey = `${kind}:${sourceRecordId}`;
  const claimId = newUlid(new Date(NOW.getTime() + 2_001));
  const claimedAt = new Date(NOW.getTime() + 2_000).toISOString();
  await env.DB.prepare(`INSERT INTO school_study_check_in_claims (
      principal_id, claim_id, local_date, course_id, topic, outcome, evidence_count,
      confidence, observed_at, citations_json, source_keys_json, claimed_at
    ) SELECT principal_id, ?1, '2026-09-16', course_id, topic, outcome, 1,
      confidence, observed_at, citations_json, json_array(?2), ?3
    FROM school_study_check_in_claims
    WHERE principal_id = ?4 AND claim_id = ?5`)
    .bind(claimId, sourceKey, claimedAt, item.principalId, item.claimId).run();
  const turnId = await addTurn(item.principalId, "telegram", "that study check-in is wrong", 3_000);
  return env.DB.prepare(`INSERT INTO school_study_signal_controls (
      principal_id, source_key, source_kind, source_record_id, disposition,
      check_in_id, control_turn_id, controlled_at, created_at
    ) VALUES (?1, ?2, ?3, ?4, 'wrong', ?5, ?6, ?7, ?7)`)
    .bind(item.principalId, sourceKey, kind, sourceRecordId, claimId, turnId,
      new Date(NOW.getTime() + 3_000).toISOString()).run();
}

async function proveWholeTriggerRemoval(
  triggerName: string,
  mutation: () => Promise<unknown>,
  expectedFailure: RegExp,
): Promise<void> {
  const trigger = await env.DB.prepare(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?1`).bind(triggerName).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${triggerName}`);
  await expect(mutation()).rejects.toThrow(expectedFailure);
  await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
  try {
    await expect(mutation()).resolves.toBeDefined();
  } finally {
    await env.DB.prepare(trigger.sql).run();
  }
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
});

describe("study coach weak-spots migration", () => {
  it("installs both private tables and all eight remote-safe guards", async () => {
    const tables = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'school_study_check_in_claims', 'school_study_signal_controls'
      ) ORDER BY name`).all<{ name: string; sql: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "school_study_check_in_claims",
      "school_study_signal_controls",
    ]);
    for (const row of tables.results) expect(row.sql).toMatch(/WITHOUT ROWID$/u);
    const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => "?").join(", ")})
      ORDER BY name`).bind(...TRIGGERS).all<{ name: string; sql: string }>();
    expect(guards.results.map((row) => row.name).sort()).toEqual([...TRIGGERS].sort());
    for (const guard of guards.results) {
      expect(guard.sql).toMatch(/\bBEGIN\s+SELECT\s+RAISE\s*\(ABORT,[^;]+\)\s+WHERE\b/su);
      expect(guard.sql).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/isu);
    }
  });

  it("proves the observation scale update guard binds max points to the content hash", async () => {
    const item = await scaleObservation("update");
    await proveWholeTriggerRemoval(
      "school_assignment_observations_scale_update_guard",
      () => env.DB.prepare(`UPDATE school_assignment_observations SET max_points = 20
        WHERE principal_id = ?1 AND observation_id = ?2`).bind(item.principalId, item.observationId).run(),
      /school_assignment_observation_scale_update_invalid/u,
    );
  });

  it("proves the observation revision scale guard preserves the replaced max points", async () => {
    const item = await scaleObservation("revision");
    const mutation = () => env.DB.prepare(`INSERT INTO school_assignment_observation_revisions (
        principal_id, revision_id, observation_id, submission_state, late, assigned_grade,
        max_points, source_updated_at, content_hash, content_changed_at, replaced_at
      ) SELECT principal_id, ?1, observation_id, submission_state, late, assigned_grade,
        20, source_updated_at, content_hash, content_changed_at, ?2
      FROM school_assignment_observations
      WHERE principal_id = ?3 AND observation_id = ?4`)
      .bind(newUlid(new Date(NOW.getTime() + 10_000)), new Date(NOW.getTime() + 10_000).toISOString(),
        item.principalId, item.observationId).run();
    await proveWholeTriggerRemoval(
      "school_assignment_observation_revisions_scale_insert_guard",
      mutation,
      /school_assignment_observation_revision_scale_insert_invalid/u,
    );
  });

  it("proves the check-in insert guard is load-bearing by removing the whole trigger", async () => {
    const item = await graph("claim-insert");
    const duplicateKeyClaimId = newUlid(new Date(NOW.getTime() + 10_000));
    const mutation = () => env.DB.prepare(`INSERT INTO school_study_check_in_claims (
        principal_id, claim_id, local_date, course_id, topic, outcome, evidence_count,
        confidence, observed_at, citations_json, source_keys_json, claimed_at
      ) SELECT principal_id, ?1, '2026-09-16', course_id, topic, outcome, 2,
        confidence, observed_at, citations_json,
        json_array(json_extract(source_keys_json, '$[0]'), json_extract(source_keys_json, '$[0]')),
        ?2
      FROM school_study_check_in_claims WHERE principal_id = ?3 AND claim_id = ?4`)
      .bind(duplicateKeyClaimId, new Date(NOW.getTime() + 10_000).toISOString(),
        item.principalId, item.claimId).run();
    await proveWholeTriggerRemoval(
      "school_study_check_in_claims_insert_guard",
      mutation,
      /school_study_check_in_insert_conflict/u,
    );
  });

  it("proves the check-in update guard is load-bearing by removing the whole trigger", async () => {
    const item = await graph("claim-update");
    await proveWholeTriggerRemoval(
      "school_study_check_in_claims_update_guard",
      () => env.DB.prepare(`UPDATE school_study_check_in_claims SET topic = 'Changed topic'
        WHERE principal_id = ?1 AND claim_id = ?2`).bind(item.principalId, item.claimId).run(),
      /school_study_check_in_update_forbidden/u,
    );
  });

  it("proves the check-in delete guard is load-bearing by removing the whole trigger", async () => {
    const item = await graph("claim-delete");
    await proveWholeTriggerRemoval(
      "school_study_check_in_claims_delete_guard",
      () => env.DB.prepare(`DELETE FROM school_study_check_in_claims
        WHERE principal_id = ?1 AND claim_id = ?2`).bind(item.principalId, item.claimId).run(),
      /school_study_check_in_delete_forbidden/u,
    );
  });

  it("proves the control insert guard enforces direct Telegram provenance", async () => {
    const item = await graph("control-insert", true);
    const mutation = () => env.DB.prepare(`INSERT INTO school_study_signal_controls (
        principal_id, source_key, source_kind, source_record_id, disposition,
        check_in_id, control_turn_id, controlled_at, created_at
      ) VALUES (?1, ?2, 'deadline', ?3, 'handled', ?4, ?5, ?6, ?6)`)
      .bind(item.principalId, item.sourceKey, item.sourceRecordId, item.claimId,
        item.voiceTurnId, new Date(NOW.getTime() + 2_000).toISOString()).run();
    await proveWholeTriggerRemoval(
      "school_study_signal_controls_insert_guard",
      mutation,
      /school_study_signal_control_insert_invalid/u,
    );
  });

  it("the control insert guard rejects a duplicate before INSERT OR REPLACE can rewrite it", async () => {
    const item = await graph("control-duplicate", true);
    await insertDeadlineControl(item);
    await expect(insertDeadlineControl(item, {
      verb: "INSERT OR REPLACE",
      disposition: "wrong",
    })).rejects.toThrow(/school_study_signal_control_insert_invalid/u);
    await expect(env.DB.prepare(`SELECT disposition FROM school_study_signal_controls
      WHERE principal_id = ?1 AND source_key = ?2`).bind(item.principalId, item.sourceKey).first())
      .resolves.toEqual({ disposition: "handled" });
  });

  it("the control insert guard requires the correction turn to belong to the same principal", async () => {
    const item = await graph("control-turn-principal", true);
    const otherPrincipal = `${item.principalId}-other`;
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(otherPrincipal, NOW.toISOString()).run();
    const otherTurn = await addTurn(otherPrincipal, "telegram", "that study check-in is wrong", 1_000);
    await expect(insertDeadlineControl(item, { turnId: otherTurn }))
      .rejects.toThrow(/school_study_signal_control_insert_invalid/u);
  });

  it("the control insert guard requires the source key to be cited by that check-in", async () => {
    const item = await graph("control-cited-source", true);
    const existing = await new DeadlineRepository(env.DB).readDeadline(item.sourceRecordId);
    if (existing === null) throw new Error("study_control_deadline_missing");
    const second = await new DeadlineRepository(env.DB).upsert({
      sourceId: existing.sourceId,
      externalId: "second-cited-source",
      course: "Chemistry",
      title: "Second worksheet",
      dueAt: "2026-09-15T14:30:00.000Z",
      effort: "other",
      leadMinutes: 60,
      now: NOW,
    });
    await expect(insertDeadlineControl(item, {
      sourceKey: `deadline:${second.deadline.deadlineId}`,
      sourceRecordId: second.deadline.deadlineId,
    })).rejects.toThrow(/school_study_signal_control_insert_invalid/u);
  });

  it.each([
    ["grade", "grade observation"],
    ["missing_work", "missing-work transition"],
    ["deadline", "deadline"],
  ] as const)("the control insert guard requires the cited %s record to exist", async (kind, suffix) => {
    await expect(insertControlForMissingRecord(kind, suffix))
      .rejects.toThrow(/school_study_signal_control_insert_invalid/u);
  });

  it("the control insert guard requires the correction turn to be at or after the check-in", async () => {
    const item = await graph("control-turn-time", true);
    await expect(insertDeadlineControl(item, { turnId: item.earlyTurnId }))
      .rejects.toThrow(/school_study_signal_control_insert_invalid/u);
  });

  it("proves the control update guard is load-bearing by removing the whole trigger", async () => {
    const item = await graph("control-update", true);
    await new StudyCoachRepository(env.DB).retireLatestCheckInSignals({
      principalId: item.principalId,
      turnId: item.directTurnId,
      reason: "handled",
      today: TODAY,
      now: new Date(NOW.getTime() + 1_000),
    });
    await proveWholeTriggerRemoval(
      "school_study_signal_controls_update_guard",
      () => env.DB.prepare(`UPDATE school_study_signal_controls SET disposition = 'wrong'
        WHERE principal_id = ?1 AND source_key = ?2`).bind(item.principalId, item.sourceKey).run(),
      /school_study_signal_control_update_forbidden/u,
    );
  });

  it("proves the control delete guard is load-bearing by removing the whole trigger", async () => {
    const item = await graph("control-delete", true);
    await new StudyCoachRepository(env.DB).retireLatestCheckInSignals({
      principalId: item.principalId,
      turnId: item.directTurnId,
      reason: "handled",
      today: TODAY,
      now: new Date(NOW.getTime() + 1_000),
    });
    await proveWholeTriggerRemoval(
      "school_study_signal_controls_delete_guard",
      () => env.DB.prepare(`DELETE FROM school_study_signal_controls
        WHERE principal_id = ?1 AND source_key = ?2`).bind(item.principalId, item.sourceKey).run(),
      /school_study_signal_control_delete_forbidden/u,
    );
  });
});
