import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { applySchoolCatchupMigration } from "./migration.js";

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
  await applySchoolCatchupMigration();
});

describe("0020 school catch-up migration", () => {
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
      "school_catchup_actions_reject_delete",
      "school_catchup_actions_require_plan_turn",
      "school_catchup_actions_status_transition",
      "school_catchup_turn_receipts_insert_guard",
      "school_catchup_turn_receipts_reject_delete",
      "school_catchup_turn_receipts_reject_update",
      "school_catchup_turn_receipts_require_turn",
      "school_course_cards_insert_guard",
      "school_course_cards_primary_key_immutable",
      "school_course_cards_reject_delete",
      "school_course_cards_require_owner_turn_insert",
      "school_course_cards_require_owner_turn_update",
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
    await expect(env.DB.prepare(`DELETE FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2`)
      .bind(item.principalId, item.courseId).run()).rejects.toThrow(/school_course_card_delete_forbidden/u);
  });

  it("protects fact evidence, immutable content and one-way resolution", async () => {
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
    await env.DB.prepare(`UPDATE school_course_facts SET status = 'resolved', resolved_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND fact_id = ?3`).bind(NOW.toISOString(), item.principalId, item.factId).run();
    await expect(env.DB.prepare(`UPDATE school_course_facts SET status = 'active', resolved_at = NULL
      WHERE principal_id = ?1 AND fact_id = ?2`).bind(item.principalId, item.factId).run())
      .rejects.toThrow(/school_course_fact_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_course_facts WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(item.principalId, item.factId).run()).rejects.toThrow(/school_course_fact_delete_forbidden/u);
  });

  it("protects action provenance, immutable plan content and one-way completion", async () => {
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
    await env.DB.prepare(`UPDATE school_catchup_actions SET status = 'completed', completed_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND action_id = ?3`).bind(NOW.toISOString(), item.principalId, item.actionId).run();
    await expect(env.DB.prepare(`UPDATE school_catchup_actions SET status = 'planned', completed_at = NULL
      WHERE principal_id = ?1 AND action_id = ?2`).bind(item.principalId, item.actionId).run())
      .rejects.toThrow(/school_catchup_action_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_catchup_actions WHERE principal_id = ?1 AND action_id = ?2`)
      .bind(item.principalId, item.actionId).run()).rejects.toThrow(/school_catchup_action_delete_forbidden/u);
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
