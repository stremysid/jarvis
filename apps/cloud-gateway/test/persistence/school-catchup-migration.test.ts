import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { applyUniversityTrackerMigration } from "./migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function addPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
}

async function addTurn(principalId: string, channel: "telegram" | "voice"): Promise<Ulid> {
  const turnId = newUlid(NOW);
  const redacted = new Redactor().redactText("migration provenance");
  if (!redacted.ok) throw new Error("migration_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `${channel}:${principalId}`,
    principalId,
    channel,
    userText: redacted,
    now: NOW,
  });
  return turnId;
}

async function graph(suffix: string) {
  const principalId = `principal:school-migration-${suffix}`;
  const otherPrincipalId = `principal:school-migration-other-${suffix}`;
  await addPrincipal(principalId);
  await addPrincipal(otherPrincipalId);
  const turnId = await addTurn(principalId, "telegram");
  const otherTurnId = await addTurn(otherPrincipalId, "telegram");
  const voiceTurnId = await addTurn(principalId, "voice");
  const repository = new SchoolCatchupRepository(env.DB);
  await repository.applyOwnerPlan({
    principalId,
    turnId,
    today: TODAY,
    responseHash: suffix.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    now: NOW,
    plan: {
      engaged: true,
      reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "D2L",
        addFacts: [{ kind: "missed_work", statement: "Missed the lab" }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1",
        localDate: TODAY,
        sequenceRank: 1,
        text: "Review the lab",
        estimatedMinutes: 25,
      }],
    },
  });
  const snapshot = await repository.readSnapshot(principalId, TODAY);
  return {
    principalId,
    otherPrincipalId,
    turnId,
    otherTurnId,
    voiceTurnId,
    courseId: snapshot.courses[0]!.courseId,
    factId: snapshot.courses[0]!.ownerReportedFacts[0]!.factId,
    actionId: snapshot.courses[0]!.currentNextAction!.actionId,
  };
}

beforeAll(async () => {
  await applyUniversityTrackerMigration();
});

describe("school catch-up schema through 0022", () => {
  it("installs four private WITHOUT ROWID tables and every guard", async () => {
    const tables = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'school_%' ORDER BY name`).all<{ name: string; sql: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "school_catchup_actions",
      "school_catchup_turn_receipts",
      "school_course_cards",
      "school_course_facts",
    ]);
    for (const row of tables.results) expect(row.sql).toMatch(/WITHOUT ROWID$/u);
    const triggers = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'school_%' ORDER BY name`).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "school_catchup_actions_core_immutable",
      "school_catchup_actions_insert_guard",
      "school_catchup_actions_planned_cap_insert",
      "school_catchup_actions_reject_delete",
      "school_catchup_actions_require_plan_turn",
      "school_catchup_actions_status_transition",
      "school_catchup_turn_receipts_insert_guard",
      "school_catchup_turn_receipts_reject_delete",
      "school_catchup_turn_receipts_reject_update",
      "school_catchup_turn_receipts_require_turn",
      "school_course_cards_active_cap_insert",
      "school_course_cards_active_cap_update",
      "school_course_cards_course_key_unique_update",
      "school_course_cards_insert_guard",
      "school_course_cards_primary_key_immutable",
      "school_course_cards_reject_delete",
      "school_course_cards_require_owner_turn_insert",
      "school_course_cards_require_owner_turn_update",
      "school_course_facts_active_cap_insert",
      "school_course_facts_core_immutable",
      "school_course_facts_insert_guard",
      "school_course_facts_reject_delete",
      "school_course_facts_require_owner_turn",
      "school_course_facts_status_transition",
    ]);
  });

  it("protects course-card identity, replacement and owner-turn provenance", async () => {
    const item = await graph("cards");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO school_course_cards
      SELECT * FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2`)
      .bind(item.principalId, item.courseId).run()).rejects.toThrow(/school_course_card_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO school_course_cards
      SELECT * FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2`)
      .bind(item.principalId, item.courseId).run()).rejects.toThrow(/school_course_card_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT INTO school_course_cards (
      principal_id, course_id, course_key, course_name, course_name_source,
      platform_name, platform_source, platform_source_ref, platform_observed_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, 'physics', 'Physics', 'owner_reported', NULL, NULL, NULL, NULL,
      ?3, 1, ?4, ?4)`).bind(item.principalId, newUlid(NOW), item.otherTurnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_course_card_owner_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_course_cards SET owner_source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND course_id = ?4`)
      .bind(item.voiceTurnId, NOW.toISOString(), item.principalId, item.courseId).run())
      .rejects.toThrow(/school_course_card_owner_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_course_cards SET course_id = ?1
      WHERE principal_id = ?2 AND course_id = ?3`).bind(newUlid(NOW), item.principalId, item.courseId).run())
      .rejects.toThrow(/school_course_card_primary_key_immutable/u);
    await expect(env.DB.prepare(`UPDATE school_course_cards SET created_at = ?1
      WHERE principal_id = ?2 AND course_id = ?3`)
      .bind(new Date(NOW.getTime() + 1_000).toISOString(), item.principalId, item.courseId).run())
      .rejects.toThrow(/school_course_card_primary_key_immutable/u);
    await expect(env.DB.prepare(`DELETE FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2`)
      .bind(item.principalId, item.courseId).run()).rejects.toThrow(/school_course_card_delete_forbidden/u);
  });

  it("rejects UPDATE OR REPLACE collisions on every unique key", async () => {
    const item = await graph("update-replace-sweep");
    const secondCourseId = newUlid(new Date(NOW.getTime() + 1_000));
    const secondFactId = newUlid(new Date(NOW.getTime() + 2_000));
    const secondActionId = newUlid(new Date(NOW.getTime() + 3_000));
    const secondTurnId = await addTurn(item.principalId, "telegram");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO school_course_cards (
        principal_id, course_id, course_key, course_name, course_name_source,
        platform_name, platform_source, platform_source_ref, platform_observed_at,
        owner_source_turn_id, active, created_at, updated_at
      ) VALUES (?1, ?2, 'physics', 'Physics', 'owner_reported', NULL, NULL, NULL, NULL,
        ?3, 1, ?4, ?4)`).bind(item.principalId, secondCourseId, item.turnId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO school_course_facts (
        principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
        source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
      ) VALUES (?1, ?2, ?3, 'second fact', 'weak_area', 'Second fact', 'owner_reported',
        ?4, NULL, ?5, 'active', NULL, ?5)`)
        .bind(item.principalId, item.courseId, secondFactId, item.turnId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO school_catchup_actions (
        principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
        status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 2, 'Second action', 10, 'planned', ?5, NULL, NULL, ?6, ?6)`)
        .bind(item.principalId, secondActionId, item.courseId, TODAY, item.turnId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO school_catchup_turn_receipts (
        principal_id, turn_id, response_hash, applied_at
      ) VALUES (?1, ?2, ?3, ?4)`)
        .bind(item.principalId, secondTurnId, "d".repeat(64), NOW.toISOString()),
    ]);

    const probes = [
      {
        label: "course primary key",
        expected: /school_course_card_primary_key_immutable/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_course_cards SET course_id = ?1
          WHERE principal_id = ?2 AND course_id = ?3`)
          .bind(secondCourseId, item.principalId, item.courseId).run(),
      },
      {
        label: "course key",
        expected: /school_course_card_course_key_conflict/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_course_cards SET course_key = 'physics'
          WHERE principal_id = ?1 AND course_id = ?2`).bind(item.principalId, item.courseId).run(),
      },
      {
        label: "fact primary key",
        expected: /school_course_fact_core_immutable/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_course_facts SET fact_id = ?1
          WHERE principal_id = ?2 AND fact_id = ?3`).bind(secondFactId, item.principalId, item.factId).run(),
      },
      {
        label: "fact natural key",
        expected: /school_course_fact_core_immutable/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_course_facts
          SET fact_key = 'second fact', fact_kind = 'weak_area'
          WHERE principal_id = ?1 AND fact_id = ?2`).bind(item.principalId, item.factId).run(),
      },
      {
        label: "action primary key",
        expected: /school_catchup_action_core_immutable/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_catchup_actions SET action_id = ?1
          WHERE principal_id = ?2 AND action_id = ?3`).bind(secondActionId, item.principalId, item.actionId).run(),
      },
      {
        label: "receipt primary key",
        expected: /school_catchup_receipt_update_forbidden/u,
        run: () => env.DB.prepare(`UPDATE OR REPLACE school_catchup_turn_receipts SET turn_id = ?1
          WHERE principal_id = ?2 AND turn_id = ?3`).bind(secondTurnId, item.principalId, item.turnId).run(),
      },
    ];
    for (const probe of probes) {
      await expect(probe.run(), probe.label).rejects.toThrow(probe.expected);
    }
  });

  it("enforces active course caps inside inserts and reactivation updates", async () => {
    const item = await graph("course-caps");
    const extras = Array.from({ length: 11 }, (_, index) => env.DB.prepare(`INSERT INTO school_course_cards (
      principal_id, course_id, course_key, course_name, course_name_source,
      platform_name, platform_source, platform_source_ref, platform_observed_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'owner_reported', NULL, NULL, NULL, NULL, ?5, 1, ?6, ?6)`)
      .bind(
        item.principalId,
        newUlid(new Date(NOW.getTime() + 10_000 + index)),
        `course ${index}`,
        `Course ${index}`,
        item.turnId,
        NOW.toISOString(),
      ));
    await env.DB.batch(extras);

    const inactiveId = newUlid(new Date(NOW.getTime() + 20_000));
    await env.DB.prepare(`INSERT INTO school_course_cards (
      principal_id, course_id, course_key, course_name, course_name_source,
      platform_name, platform_source, platform_source_ref, platform_observed_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, 'inactive overflow', 'Inactive overflow', 'owner_reported',
      NULL, NULL, NULL, NULL, ?3, 0, ?4, ?4)`)
      .bind(item.principalId, inactiveId, item.turnId, NOW.toISOString()).run();
    await expect(env.DB.prepare(`INSERT INTO school_course_cards (
      principal_id, course_id, course_key, course_name, course_name_source,
      platform_name, platform_source, platform_source_ref, platform_observed_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, 'insert overflow', 'Insert overflow', 'owner_reported',
      NULL, NULL, NULL, NULL, ?3, 1, ?4, ?4)`)
      .bind(item.principalId, newUlid(new Date(NOW.getTime() + 21_000)), item.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_course_card_limit_exceeded/u);
    await expect(env.DB.prepare(`UPDATE school_course_cards SET active = 1, updated_at = ?1
      WHERE principal_id = ?2 AND course_id = ?3`)
      .bind(NOW.toISOString(), item.principalId, inactiveId).run())
      .rejects.toThrow(/school_course_card_limit_exceeded/u);
  });

  it("enforces the per-course active-fact cap inside the insert batch", async () => {
    const item = await graph("fact-cap");
    const extras = Array.from({ length: 15 }, (_, index) => env.DB.prepare(`INSERT INTO school_course_facts (
      principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
      source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'weak_area', ?5, 'owner_reported',
      ?6, NULL, ?7, 'active', NULL, ?7)`)
      .bind(
        item.principalId,
        item.courseId,
        newUlid(new Date(NOW.getTime() + 30_000 + index)),
        `fact ${index}`,
        `Fact ${index}`,
        item.turnId,
        NOW.toISOString(),
      ));
    await env.DB.batch(extras);
    await expect(env.DB.prepare(`INSERT INTO school_course_facts (
      principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
      source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
    ) VALUES (?1, ?2, ?3, 'fact overflow', 'weak_area', 'Fact overflow', 'owner_reported',
      ?4, NULL, ?5, 'active', NULL, ?5)`)
      .bind(item.principalId, item.courseId, newUlid(new Date(NOW.getTime() + 31_000)), item.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_course_fact_limit_exceeded/u);
  });

  it("enforces the principal-wide active-fact cap independently of the per-course cap", async () => {
    const item = await graph("fact-total-cap");
    const courseIds = [item.courseId];
    const courseStatements = Array.from({ length: 3 }, (_, index) => {
      const courseId = newUlid(new Date(NOW.getTime() + 32_000 + index));
      courseIds.push(courseId);
      return env.DB.prepare(`INSERT INTO school_course_cards (
        principal_id, course_id, course_key, course_name, course_name_source,
        platform_name, platform_source, platform_source_ref, platform_observed_at,
        owner_source_turn_id, active, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'owner_reported', NULL, NULL, NULL, NULL, ?5, 1, ?6, ?6)`)
        .bind(item.principalId, courseId, `fact cap course ${index}`, `Fact cap course ${index}`,
          item.turnId, NOW.toISOString());
    });
    await env.DB.batch(courseStatements);
    const factStatements = courseIds.flatMap((courseId, courseIndex) => {
      const count = courseIndex === 0 ? 11 : 12;
      return Array.from({ length: count }, (_, factIndex) => {
        const ordinal = courseIndex * 20 + factIndex;
        return env.DB.prepare(`INSERT INTO school_course_facts (
          principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
          source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'due_work', ?5, 'owner_reported',
          ?6, NULL, ?7, 'active', NULL, ?7)`)
          .bind(
            item.principalId,
            courseId,
            newUlid(new Date(NOW.getTime() + 33_000 + ordinal)),
            `total fact ${courseIndex} ${factIndex}`,
            `Total fact ${courseIndex} ${factIndex}`,
            item.turnId,
            NOW.toISOString(),
          );
      });
    });
    await env.DB.batch(factStatements);
    await expect(env.DB.prepare(`INSERT INTO school_course_facts (
      principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
      source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
    ) VALUES (?1, ?2, ?3, 'total fact overflow', 'due_work', 'Total fact overflow', 'owner_reported',
      ?4, NULL, ?5, 'active', NULL, ?5)`)
      .bind(item.principalId, courseIds[3], newUlid(new Date(NOW.getTime() + 39_000)), item.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_course_fact_limit_exceeded/u);
  });

  it("enforces the planned-action cap inside the insert batch", async () => {
    const item = await graph("action-cap");
    const extras = Array.from({ length: 20 }, (_, index) => {
      const localDate = new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10);
      return env.DB.prepare(`INSERT INTO school_catchup_actions (
        principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
        status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 1, ?5, 10, 'planned', ?6, NULL, NULL, ?7, ?7)`)
        .bind(
          item.principalId,
          newUlid(new Date(NOW.getTime() + 40_000 + index)),
          item.courseId,
          localDate,
          `Action ${index}`,
          item.turnId,
          NOW.toISOString(),
        );
    });
    await env.DB.batch(extras);
    await expect(env.DB.prepare(`INSERT INTO school_catchup_actions (
      principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
      status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, '2026-12-01', 1, 'Action overflow', 10, 'planned',
      ?4, NULL, NULL, ?5, ?5)`)
      .bind(item.principalId, newUlid(new Date(NOW.getTime() + 41_000)), item.courseId, item.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_catchup_action_limit_exceeded/u);
  });

  it("enforces per-day action count and minute caps inside inserts", async () => {
    const minutesItem = await graph("action-minute-cap");
    await expect(env.DB.prepare(`INSERT INTO school_catchup_actions (
      principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
      status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 2, 'Too many minutes', 160, 'planned',
      ?5, NULL, NULL, ?6, ?6)`)
      .bind(minutesItem.principalId, newUlid(new Date(NOW.getTime() + 42_000)), minutesItem.courseId,
        TODAY, minutesItem.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_catchup_action_limit_exceeded/u);

    const countItem = await graph("action-day-cap");
    await env.DB.batch([2, 3].map((rank) => env.DB.prepare(`INSERT INTO school_catchup_actions (
      principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
      status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, 'planned', ?7, NULL, NULL, ?8, ?8)`)
      .bind(countItem.principalId, newUlid(new Date(NOW.getTime() + 43_000 + rank)), countItem.courseId,
        TODAY, rank, `Action ${rank}`, countItem.turnId, NOW.toISOString())));
    await expect(env.DB.prepare(`INSERT INTO school_catchup_actions (
      principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
      status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 4, 'Fourth action', 10, 'planned',
      ?5, NULL, NULL, ?6, ?6)`)
      .bind(countItem.principalId, newUlid(new Date(NOW.getTime() + 44_000)), countItem.courseId,
        TODAY, countItem.turnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_catchup_action_limit_exceeded/u);
  });

  it("school_course_facts_core_immutable refuses content changes and accepts the resolve-key rewrite", async () => {
    const item = await graph("facts");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO school_course_facts
      SELECT * FROM school_course_facts WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(item.principalId, item.factId).run()).rejects.toThrow(/school_course_fact_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO school_course_facts
      SELECT * FROM school_course_facts WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(item.principalId, item.factId).run()).rejects.toThrow(/school_course_fact_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT INTO school_course_facts (
      principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
      source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
    ) VALUES (?1, ?2, ?3, 'wrong owner', 'weak_area', 'Wrong owner', 'owner_reported',
      ?4, NULL, ?5, 'active', NULL, ?5)`)
      .bind(item.principalId, item.courseId, newUlid(NOW), item.otherTurnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_course_fact_owner_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_course_facts SET statement = 'Changed'
      WHERE principal_id = ?1 AND fact_id = ?2`).bind(item.principalId, item.factId).run())
      .rejects.toThrow(/school_course_fact_core_immutable/u);
    await expect(env.DB.prepare(`DELETE FROM school_course_facts WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(item.principalId, item.factId).run()).rejects.toThrow(/school_course_fact_delete_forbidden/u);
    await expect(env.DB.prepare(`UPDATE school_course_facts
      SET fact_key = substr(fact_key, 1, 476) || ':resolved:' || fact_id,
          status = 'resolved', resolved_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND fact_id = ?3`).bind(NOW.toISOString(), item.principalId, item.factId).run())
      .resolves.toBeDefined();
    await expect(env.DB.prepare(`UPDATE school_course_facts SET status = 'active', resolved_at = NULL
      WHERE principal_id = ?1 AND fact_id = ?2`).bind(item.principalId, item.factId).run())
      .rejects.toThrow(/school_course_fact_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_course_facts WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(item.principalId, item.factId).run()).resolves.toBeDefined();
  });

  it("school_catchup_actions_reject_delete refuses planned deletion and permits terminal deletion", async () => {
    const item = await graph("actions");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO school_catchup_actions
      SELECT * FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(item.principalId, item.actionId).run()).rejects.toThrow(/school_catchup_action_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO school_catchup_actions
      SELECT * FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(item.principalId, item.actionId).run()).rejects.toThrow(/school_catchup_action_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT INTO school_catchup_actions (
      principal_id, action_id, course_id, local_date, sequence_rank, action_text, estimated_minutes,
      status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 2, 'Wrong owner plan', 10, 'planned', ?5, NULL, NULL, ?6, ?6)`)
      .bind(item.principalId, newUlid(NOW), item.courseId, TODAY, item.otherTurnId, NOW.toISOString()).run())
      .rejects.toThrow(/school_catchup_action_plan_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_catchup_actions SET action_text = 'Changed'
      WHERE principal_id = ?1 AND action_id = ?2`).bind(item.principalId, item.actionId).run())
      .rejects.toThrow(/school_catchup_action_core_immutable/u);
    await expect(env.DB.prepare(`DELETE FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(item.principalId, item.actionId).run()).rejects.toThrow(/school_catchup_action_delete_forbidden/u);
    await env.DB.prepare(`UPDATE school_catchup_actions SET status = 'completed', completed_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND action_id = ?3`).bind(NOW.toISOString(), item.principalId, item.actionId).run();
    await expect(env.DB.prepare(`UPDATE school_catchup_actions SET status = 'planned', completed_at = NULL
      WHERE principal_id = ?1 AND action_id = ?2`).bind(item.principalId, item.actionId).run())
      .rejects.toThrow(/school_catchup_action_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(item.principalId, item.actionId).run()).resolves.toBeDefined();

    const superseded = await graph("actions-superseded");
    await env.DB.prepare(`UPDATE school_catchup_actions
      SET status = 'superseded', superseded_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND action_id = ?3`)
      .bind(NOW.toISOString(), superseded.principalId, superseded.actionId).run();
    await expect(env.DB.prepare(`DELETE FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(superseded.principalId, superseded.actionId).run()).resolves.toBeDefined();
  });

  it("keeps turn receipts immutable, owner-bound and replacement-safe", async () => {
    const item = await graph("receipts");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO school_catchup_turn_receipts
      SELECT * FROM school_catchup_turn_receipts WHERE principal_id = ?1 AND turn_id = ?2`)
      .bind(item.principalId, item.turnId).run()).rejects.toThrow(/school_catchup_receipt_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO school_catchup_turn_receipts
      SELECT * FROM school_catchup_turn_receipts WHERE principal_id = ?1 AND turn_id = ?2`)
      .bind(item.principalId, item.turnId).run()).rejects.toThrow(/school_catchup_receipt_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT INTO school_catchup_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(item.principalId, item.otherTurnId, "f".repeat(64), NOW.toISOString()).run())
      .rejects.toThrow(/school_catchup_receipt_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_catchup_turn_receipts SET response_hash = ?1
      WHERE principal_id = ?2 AND turn_id = ?3`).bind("e".repeat(64), item.principalId, item.turnId).run())
      .rejects.toThrow(/school_catchup_receipt_update_forbidden/u);
    await expect(env.DB.prepare(`DELETE FROM school_catchup_turn_receipts WHERE principal_id = ?1 AND turn_id = ?2`)
      .bind(item.principalId, item.turnId).run()).rejects.toThrow(/school_catchup_receipt_delete_forbidden/u);
  });
});
