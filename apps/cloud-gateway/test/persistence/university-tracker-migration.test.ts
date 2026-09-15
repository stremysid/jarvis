import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityApplicationWorkflowMigration } from "./migration.js";

const NOW = new Date("2026-09-15T17:00:00.000Z");
const UNIVERSITY_TRIGGER_NAMES = [
  "university_program_items_active_cap_insert",
  "university_program_items_core_immutable",
  "university_program_items_insert_guard",
  "university_program_items_reject_delete",
  "university_program_items_require_owner_turn",
  "university_program_items_status_transition",
  "university_programs_active_cap_insert",
  "university_programs_active_cap_update",
  "university_programs_insert_guard",
  "university_programs_reject_delete",
  "university_programs_require_owner_turn_insert",
  "university_programs_require_owner_turn_update",
  "university_programs_update_guard",
  "university_tracker_turn_receipts_insert_guard",
  "university_tracker_turn_receipts_reject_delete",
  "university_tracker_turn_receipts_reject_update",
  "university_tracker_turn_receipts_require_turn",
] as const;
const CHANGED_SCHOOL_TRIGGER_NAMES = [
  "school_catchup_actions_reject_delete",
  "school_course_facts_core_immutable",
] as const;
const APPLICATION_TRIGGER_NAMES = [
  "university_application_items_cap_insert",
  "university_application_items_core_immutable",
  "university_application_items_insert_guard",
  "university_application_items_reject_delete",
  "university_application_items_require_owner_turn_insert",
  "university_application_items_require_owner_turn_update",
  "university_application_items_submitted_terminal",
] as const;

async function seedTurn(principalId: string, turnId: Ulid, text = "Track a university program."): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'University owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("university_migration_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now: NOW,
  });
}

beforeAll(async () => {
  await applyUniversityApplicationWorkflowMigration();
});

describe("university tracker migrations through 0024", () => {
  it("installs the bounded program and item schema with every named guard", async () => {
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'university_%' ORDER BY name`).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "university_application_items",
      "university_program_items",
      "university_programs",
      "university_tracker_turn_receipts",
    ]);
    const triggers = await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'university_%' ORDER BY name`).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      ...APPLICATION_TRIGGER_NAMES,
      ...UNIVERSITY_TRIGGER_NAMES,
    ]);
    const changedSchoolGuards = await env.DB.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'school_course_facts_core_immutable',
        'school_catchup_actions_reject_delete'
      ) ORDER BY name`).all<{ name: string; sql: string }>();
    expect(changedSchoolGuards.results.map((row) => row.name)).toEqual(CHANGED_SCHOOL_TRIGGER_NAMES);
    expect(changedSchoolGuards.results[0]?.sql).toContain("NOT IN ('completed', 'superseded')");
    expect(changedSchoolGuards.results[1]?.sql).toContain(":resolved:");
    await expect(env.DB.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });
  });

  it.each([...APPLICATION_TRIGGER_NAMES, ...UNIVERSITY_TRIGGER_NAMES, ...CHANGED_SCHOOL_TRIGGER_NAMES])(
    "installs the %s trigger",
    async (triggerName) => {
      const trigger = await env.DB.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = ?1`).bind(triggerName).first<{ name: string }>();
      expect(trigger?.name).toBe(triggerName);
    },
  );

  it("rejects false verification and unsafe program replacement paths", async () => {
    const principalId = "principal:university-migration-guards";
    const firstTurn = "01k5fb9pg00000000000000c00" as Ulid;
    await seedTurn(principalId, firstTurn);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      responseHash: "1".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "University One",
          campus: null,
          programName: "Program One",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [{
            label: "Course requirement",
            detail: "English is required",
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          }],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [],
      },
    });
    const snapshot = await repository.readSnapshot(principalId);
    const program = snapshot.programs[0]!;
    const item = program.requirements[0]!;
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO university_programs
      SELECT * FROM university_programs WHERE principal_id = ?1 AND program_id = ?2`)
      .bind(principalId, program.programId).run()).rejects.toThrow(/university_program_insert_conflict/u);
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO university_program_items
      SELECT * FROM university_program_items WHERE principal_id = ?1 AND item_id = ?2`)
      .bind(principalId, item.itemId).run()).rejects.toThrow(/university_item_insert_conflict/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_programs SET program_id = ?1
      WHERE principal_id = ?2 AND program_id = ?3`)
      .bind(newUlid(), principalId, program.programId).run()).rejects.toThrow(/university_program_identity_invalid/u);
    await expect(env.DB.prepare(`UPDATE university_program_items SET item_label = 'Changed'
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, item.itemId).run())
      .rejects.toThrow(/university_item_core_immutable/u);
    await expect(env.DB.prepare(`DELETE FROM university_programs
      WHERE principal_id = ?1 AND program_id = ?2`).bind(principalId, program.programId).run())
      .rejects.toThrow(/university_program_delete_forbidden/u);
    await expect(env.DB.prepare(`DELETE FROM university_program_items
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, item.itemId).run())
      .rejects.toThrow(/university_item_delete_forbidden/u);
    await expect(env.DB.prepare(`UPDATE university_tracker_turn_receipts SET response_hash = ?1
      WHERE principal_id = ?2 AND turn_id = ?3`).bind("2".repeat(64), principalId, firstTurn).run())
      .rejects.toThrow(/university_tracker_receipt_update_forbidden/u);
    await expect(env.DB.prepare(`DELETE FROM university_tracker_turn_receipts
      WHERE principal_id = ?1 AND turn_id = ?2`).bind(principalId, firstTurn).run())
      .rejects.toThrow(/university_tracker_receipt_delete_forbidden/u);
    await expect(env.DB.prepare(`UPDATE university_programs
      SET verification_state = 'verified', verified_at = ?1
      WHERE principal_id = ?2 AND program_id = ?3`).bind(NOW.toISOString(), principalId, program.programId).run())
      .rejects.toThrow();
  });

  it("rejects REPLACE and IGNORE on every program, item, and receipt unique key", async () => {
    const principalId = "principal:university-migration-sweep";
    const firstTurn = "01k5fb9pg00000000000000c30" as Ulid;
    const secondTurn = "01k5fb9pg00000000000000c31" as Ulid;
    await seedTurn(principalId, firstTurn, "Track the first program.");
    await seedTurn(principalId, secondTurn, "Track the second program.");
    const repository = new UniversityTrackerRepository(env.DB);
    const addProgram = async (turnId: Ulid, suffix: string, hash: string): Promise<void> => repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: hash.repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: `University ${suffix}`,
          campus: null,
          programName: `Program ${suffix}`,
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [{
            label: `Requirement ${suffix}`,
            detail: `Detail ${suffix}`,
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          }],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [],
      },
    });
    await addProgram(firstTurn, "One", "4");
    await addProgram(secondTurn, "Two", "5");
    const programs = await env.DB.prepare(`SELECT program_id, program_key FROM university_programs
      WHERE principal_id = ?1 ORDER BY program_key`).bind(principalId)
      .all<{ program_id: string; program_key: string }>();
    const items = await env.DB.prepare(`SELECT item_id, item_key FROM university_program_items
      WHERE principal_id = ?1 ORDER BY item_key`).bind(principalId)
      .all<{ item_id: string; item_key: string }>();
    const firstProgram = programs.results[0]!;
    const secondProgram = programs.results[1]!;
    const firstItem = items.results[0]!;
    const secondItem = items.results[1]!;
    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_programs
        SELECT * FROM university_programs WHERE principal_id = ?1 AND program_id = ?2`)
        .bind(principalId, firstProgram.program_id).run()).rejects.toThrow(/university_program_insert_conflict/u);
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_program_items
        SELECT * FROM university_program_items WHERE principal_id = ?1 AND item_id = ?2`)
        .bind(principalId, firstItem.item_id).run()).rejects.toThrow(/university_item_insert_conflict/u);
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_tracker_turn_receipts
        SELECT * FROM university_tracker_turn_receipts WHERE principal_id = ?1 AND turn_id = ?2`)
        .bind(principalId, firstTurn).run()).rejects.toThrow(/university_tracker_receipt_insert_conflict/u);
    }
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_programs SET program_id = ?1
      WHERE principal_id = ?2 AND program_id = ?3`)
      .bind(secondProgram.program_id, principalId, firstProgram.program_id).run())
      .rejects.toThrow(/university_program_identity_invalid/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_programs SET program_key = ?1
      WHERE principal_id = ?2 AND program_id = ?3`)
      .bind(secondProgram.program_key, principalId, firstProgram.program_id).run())
      .rejects.toThrow(/university_program_key_conflict/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_program_items SET item_id = ?1
      WHERE principal_id = ?2 AND item_id = ?3`)
      .bind(secondItem.item_id, principalId, firstItem.item_id).run())
      .rejects.toThrow(/university_item_core_immutable/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_program_items SET item_key = ?1
      WHERE principal_id = ?2 AND item_id = ?3`)
      .bind(secondItem.item_key, principalId, firstItem.item_id).run())
      .rejects.toThrow(/university_item_core_immutable/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE university_tracker_turn_receipts SET turn_id = ?1
      WHERE principal_id = ?2 AND turn_id = ?3`).bind(secondTurn, principalId, firstTurn).run())
      .rejects.toThrow(/university_tracker_receipt_update_forbidden/u);
  });

  it("enforces program and active-item caps inside D1 writes", async () => {
    const principalId = "principal:university-migration-caps";
    const turnId = "01k5fb9pg00000000000000c10" as Ulid;
    await seedTurn(principalId, turnId);
    const programIds = Array.from({ length: 17 }, (_, index) => newUlid(new Date(NOW.getTime() + index)));
    const programInsert = (index: number, active: 0 | 1) => env.DB.prepare(`INSERT INTO university_programs (
      principal_id, program_id, program_key, university_name, campus_name, program_name,
      ouac_code, verification_state, source_url, admission_cycle, verified_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, 'unverified', NULL, '2027', NULL, ?6, ?7, ?8, ?8)`)
      .bind(principalId, programIds[index], `university ${index} | | program ${index}`,
        `University ${index}`, `Program ${index}`, turnId, active, NOW.toISOString());
    await env.DB.batch(Array.from({ length: 16 }, (_, index) => programInsert(index, 1)));
    await expect(programInsert(16, 1).run()).rejects.toThrow(/university_program_limit_exceeded/u);
    await programInsert(16, 0).run();
    await expect(env.DB.prepare(`UPDATE university_programs SET active = 1, updated_at = ?1
      WHERE principal_id = ?2 AND program_id = ?3`).bind(NOW.toISOString(), principalId, programIds[16]).run())
      .rejects.toThrow(/university_program_limit_exceeded/u);

    const itemInsert = (index: number) => env.DB.prepare(`INSERT INTO university_program_items (
      principal_id, program_id, item_id, item_key, item_kind, item_label, item_detail,
      date_value, verification_state, source_url, admission_cycle, verified_at,
      source_turn_id, status, resolved_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'requirement', ?5, ?6, NULL, 'unverified', NULL, '2027', NULL,
      ?7, 'active', NULL, ?8, ?8)`)
      .bind(principalId, programIds[0], newUlid(new Date(NOW.getTime() + 100 + index)),
        `requirement | requirement ${index} | detail ${index} |`, `Requirement ${index}`, `Detail ${index}`,
        turnId, NOW.toISOString());
    await env.DB.batch(Array.from({ length: 32 }, (_, index) => itemInsert(index)));
    await expect(itemInsert(32).run()).rejects.toThrow(/university_item_limit_exceeded/u);
  });

  it("requires same-principal Telegram turns", async () => {
    const principalId = "principal:university-migration-turns";
    const otherPrincipal = "principal:university-migration-other";
    const turnId = "01k5fb9pg00000000000000c20" as Ulid;
    const otherTurn = "01k5fb9pg00000000000000c21" as Ulid;
    await seedTurn(principalId, turnId);
    await seedTurn(otherPrincipal, otherTurn);
    const programId = newUlid(NOW);
    await expect(env.DB.prepare(`INSERT INTO university_programs (
      principal_id, program_id, program_key, university_name, campus_name, program_name,
      ouac_code, verification_state, source_url, admission_cycle, verified_at,
      owner_source_turn_id, active, created_at, updated_at
    ) VALUES (?1, ?2, 'wrong turn | | program', 'Wrong Turn', NULL, 'Program', NULL,
      'unverified', NULL, NULL, NULL, ?3, 1, ?4, ?4)`)
      .bind(principalId, programId, otherTurn, NOW.toISOString()).run())
      .rejects.toThrow(/university_program_owner_turn_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO university_tracker_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, otherTurn, "3".repeat(64), NOW.toISOString()).run())
      .rejects.toThrow(/university_tracker_receipt_turn_invalid/u);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "6".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "Turn University",
          campus: null,
          programName: "Turn Program",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [{
            label: "Turn requirement",
            detail: "Owner reported",
            verification: { state: "unverified", sourceUrl: null, cycle: null },
          }],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [],
      },
    });
    const snapshot = await repository.readSnapshot(principalId);
    const validProgram = snapshot.programs[0]!;
    const validItem = validProgram.requirements[0]!;
    await expect(env.DB.prepare(`UPDATE university_programs SET owner_source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND program_id = ?4`)
      .bind(otherTurn, NOW.toISOString(), principalId, validProgram.programId).run())
      .rejects.toThrow(/university_program_owner_turn_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO university_program_items (
      principal_id, program_id, item_id, item_key, item_kind, item_label, item_detail,
      date_value, verification_state, source_url, admission_cycle, verified_at,
      source_turn_id, status, resolved_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'wrong turn item', 'requirement', 'Wrong turn', 'Wrong turn', NULL,
      'unverified', NULL, NULL, NULL, ?4, 'active', NULL, ?5, ?5)`)
      .bind(principalId, validProgram.programId, newUlid(), otherTurn, NOW.toISOString()).run())
      .rejects.toThrow(/university_item_owner_turn_invalid/u);
    await env.DB.prepare(`UPDATE university_program_items
      SET status = 'resolved', resolved_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND item_id = ?3`).bind(NOW.toISOString(), principalId, validItem.itemId).run();
    await expect(env.DB.prepare(`UPDATE university_program_items
      SET status = 'active', resolved_at = NULL, updated_at = ?1
      WHERE principal_id = ?2 AND item_id = ?3`).bind(NOW.toISOString(), principalId, validItem.itemId).run())
      .rejects.toThrow(/university_item_status_invalid/u);
  });
});
