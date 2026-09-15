import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityApplicationWorkflowMigration } from "./migration.js";

const NOW = new Date("2026-09-15T18:00:00.000Z");
async function seedTurn(principalId: string, turnId: Ulid, text = "Update my university applications."): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Application owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("university_application_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now: NOW,
  });
}

async function seedProgram(principalId: string): Promise<{ readonly programId: Ulid; readonly turnId: Ulid }> {
  const turnId = newUlid(NOW);
  await seedTurn(principalId, turnId, "Add Test University Engineering for 2027.");
  const repository = new UniversityTrackerRepository(env.DB);
  await repository.applyOwnerPlan({
    principalId,
    turnId,
    responseHash: "a".repeat(64),
    now: NOW,
    plan: {
      engaged: true,
      programUpdates: [{
        programRef: "new-1",
        university: "Test University",
        campus: null,
        programName: "Engineering",
        ouacCode: null,
        verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
        addRequirements: [],
        addDates: [],
        resolveItemIds: [],
      }],
      applicationUpdates: [],
    },
  });
  const programId = (await repository.readSnapshot(principalId)).programs[0]?.programId;
  if (programId === undefined) throw new Error("university_application_fixture_program_missing");
  return { programId, turnId };
}

function insertItem(input: {
  readonly principalId: string;
  readonly programId: Ulid;
  readonly turnId: Ulid;
  readonly itemId?: Ulid;
  readonly itemKey?: string;
  readonly label?: string;
  readonly status?: "not_started" | "drafting" | "ready" | "submitted_by_sid" | "not_needed_by_sid";
}): D1PreparedStatement {
  const itemId = input.itemId ?? newUlid(NOW);
  const label = input.label ?? "Supplementary form";
  const status = input.status ?? "not_started";
  return env.DB.prepare(`INSERT INTO university_application_items (
    principal_id, program_id, item_id, item_key, item_kind, item_label, item_status,
    due_date, verification_state, source_url, admission_cycle, verified_at,
    source_turn_id, submitted_at, created_at, updated_at
  ) VALUES (?1, ?2, ?3, ?4, 'supplementary_application', ?5, ?6,
    NULL, 'unverified', NULL, '2027', NULL, ?7, ?8, ?9, ?9)`)
    .bind(input.principalId, input.programId, itemId,
      input.itemKey ?? `supplementary_application | ${label.toLowerCase()}`, label, status,
      input.turnId, status === "submitted_by_sid" ? NOW.toISOString() : null, NOW.toISOString());
}

beforeAll(async () => {
  await applyUniversityApplicationWorkflowMigration();
});

describe("0024 university application workflow migration", () => {
  it("rejects REPLACE and IGNORE in a generic existing-row sweep", async () => {
    const principalId = "principal:application-migration-sweep";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId }).run();
    const table = "university_application_items";
    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO ${table}
        SELECT * FROM ${table} WHERE principal_id = ?1 AND item_id = ?2`)
        .bind(principalId, itemId).run()).rejects.toThrow(/university_application_item_insert_conflict/u);
    }
  });

  it("refuses a thirty-third application item for one program", async () => {
    const principalId = "principal:application-migration-cap";
    const { programId, turnId } = await seedProgram(principalId);
    for (let index = 0; index < 32; index += 1) {
      await insertItem({
        principalId,
        programId,
        turnId,
        itemKey: `essay | item ${index}`,
        label: `Item ${index}`,
      }).run();
    }
    await expect(insertItem({
      principalId,
      programId,
      turnId,
      itemKey: "essay | item 32",
      label: "Item 32",
    }).run()).rejects.toThrow(/university_application_item_limit_exceeded/u);
  });

  it("refuses an insert sourced from another principal's Telegram turn", async () => {
    const principalId = "principal:application-migration-insert-owner";
    const otherPrincipalId = "principal:application-migration-insert-other";
    const { programId } = await seedProgram(principalId);
    const otherTurn = newUlid(NOW);
    await seedTurn(otherPrincipalId, otherTurn);
    await expect(insertItem({ principalId, programId, turnId: otherTurn }).run())
      .rejects.toThrow(/university_application_item_owner_turn_invalid/u);
  });

  it("refuses an update sourced from another principal's Telegram turn", async () => {
    const principalId = "principal:application-migration-update-owner";
    const otherPrincipalId = "principal:application-migration-update-other";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId }).run();
    const otherTurn = newUlid(NOW);
    await seedTurn(otherPrincipalId, otherTurn);
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_status = 'drafting', source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(otherTurn, NOW.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_owner_turn_invalid/u);
  });

  it("keeps the application item identity and label immutable", async () => {
    const principalId = "principal:application-migration-immutable";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId }).run();
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_label = 'Changed label', source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(turnId, NOW.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_core_immutable/u);
  });

  it("allows a later owner turn, but not the same turn, to correct submitted-by-Sid", async () => {
    const principalId = "principal:application-migration-submitted";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId, status: "submitted_by_sid" }).run();
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_status = 'ready', submitted_at = NULL, source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(turnId, NOW.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_status_invalid/u);

    const later = new Date("2026-09-15T18:05:00.000Z");
    const laterTurn = newUlid(later);
    await seedTurn(principalId, laterTurn, "I didn't submit this item.");
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_status = 'ready', submitted_at = NULL, source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(laterTurn, later.toISOString(), principalId, itemId).run()).resolves.toBeDefined();
  });

  it("refuses reactivating a retired item when its program is already at the active cap", async () => {
    const principalId = "principal:application-migration-reactivate-cap";
    const { programId, turnId } = await seedProgram(principalId);
    for (let index = 0; index < 32; index += 1) {
      await insertItem({
        principalId, programId, turnId, itemKey: `essay | active ${index}`, label: `Active ${index}`,
      }).run();
    }
    const retiredId = newUlid(new Date("2026-09-15T18:01:00.000Z"));
    await insertItem({
      principalId, programId, turnId, itemId: retiredId,
      itemKey: "essay | retired", label: "Retired", status: "not_needed_by_sid",
    }).run();
    const later = new Date("2026-09-15T18:05:00.000Z");
    const laterTurn = newUlid(later);
    await seedTurn(principalId, laterTurn, "Restore the retired application item.");
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_status = 'ready', source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(laterTurn, later.toISOString(), principalId, retiredId).run())
      .rejects.toThrow(/university_application_item_limit_exceeded/u);
  });

  it("keeps submitted timestamps, verified dates and update time internally consistent", async () => {
    const principalId = "principal:application-migration-state-consistent";
    const { programId, turnId } = await seedProgram(principalId);
    const submittedId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId: submittedId, status: "submitted_by_sid" }).run();
    const later = new Date("2026-09-15T18:05:00.000Z");
    const laterTurn = newUlid(later);
    await seedTurn(principalId, laterTurn);
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET submitted_at = ?1, source_turn_id = ?2, updated_at = ?1
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(later.toISOString(), laterTurn, principalId, submittedId).run())
      .rejects.toThrow(/university_application_item_state_invalid/u);

    const ordinaryId = newUlid(new Date("2026-09-15T18:00:01.000Z"));
    await insertItem({
      principalId, programId, turnId, itemId: ordinaryId,
      itemKey: "supplementary_application | ordinary", label: "Ordinary",
    }).run();
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET source_turn_id = ?1, updated_at = '2026-09-15T17:59:59.000Z'
      WHERE principal_id = ?2 AND item_id = ?3`)
      .bind(laterTurn, principalId, ordinaryId).run())
      .rejects.toThrow(/university_application_item_state_invalid/u);

    await env.DB.prepare(`UPDATE university_application_items
      SET due_date = '2027-01-15', verification_state = 'verified',
          source_url = 'https://example.edu/deadline', admission_cycle = '2027',
          verified_at = ?1, source_turn_id = ?2, updated_at = ?1
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(later.toISOString(), laterTurn, principalId, ordinaryId).run();
    const newest = new Date("2026-09-15T18:10:00.000Z");
    const newestTurn = newUlid(newest);
    await seedTurn(principalId, newestTurn);
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET due_date = '2027-01-16', source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(newestTurn, newest.toISOString(), principalId, ordinaryId).run())
      .rejects.toThrow(/university_application_item_state_invalid/u);
  });

  it("requires a newer verification timestamp before verified source metadata changes", async () => {
    const principalId = "principal:application-migration-verified-source";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(new Date("2026-09-15T18:00:01.000Z"));
    await insertItem({ principalId, programId, turnId, itemId }).run();
    const verified = new Date("2026-09-15T18:05:00.000Z");
    const verifiedTurn = newUlid(verified);
    await seedTurn(principalId, verifiedTurn, "The official date is January 15, 2027.");
    await env.DB.prepare(`UPDATE university_application_items
      SET due_date = '2027-01-15', verification_state = 'verified',
          source_url = 'https://example.edu/deadline', admission_cycle = '2027 cycle',
          verified_at = ?1, source_turn_id = ?2, updated_at = ?1
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(verified.toISOString(), verifiedTurn, principalId, itemId).run();
    const later = new Date("2026-09-15T18:10:00.000Z");
    const laterTurn = newUlid(later);
    await seedTurn(principalId, laterTurn, "Use a different source.");

    await expect(env.DB.prepare(`UPDATE university_application_items
      SET source_url = 'https://example.edu/replaced', admission_cycle = '2028 cycle',
          source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(laterTurn, later.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_state_invalid/u);
  });

  it("refuses a verification timestamp that moves backwards", async () => {
    const principalId = "principal:application-migration-verification-backdate";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(new Date("2026-09-15T18:00:01.000Z"));
    await insertItem({ principalId, programId, turnId, itemId }).run();
    const verified = new Date("2026-09-15T18:05:00.000Z");
    const verifiedTurn = newUlid(verified);
    await seedTurn(principalId, verifiedTurn, "The official date is January 15, 2027.");
    await env.DB.prepare(`UPDATE university_application_items
      SET due_date = '2027-01-15', verification_state = 'verified',
          source_url = 'https://example.edu/deadline', admission_cycle = '2027 cycle',
          verified_at = ?1, source_turn_id = ?2, updated_at = ?1
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(verified.toISOString(), verifiedTurn, principalId, itemId).run();
    const later = new Date("2026-09-15T18:10:00.000Z");
    const laterTurn = newUlid(later);
    await seedTurn(principalId, laterTurn, "Keep the source but backdate it.");

    await expect(env.DB.prepare(`UPDATE university_application_items
      SET verified_at = ?1, source_turn_id = ?2, updated_at = ?3
      WHERE principal_id = ?4 AND item_id = ?5`)
      .bind(NOW.toISOString(), laterTurn, later.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_state_invalid/u);
  });

  it("refuses an older source turn when leaving submitted or retired history", async () => {
    const principalId = "principal:application-migration-older-correction";
    const { programId, turnId } = await seedProgram(principalId);
    const terminalAt = new Date("2026-09-15T18:05:00.000Z");
    const terminalTurn = newUlid(terminalAt);
    await seedTurn(principalId, terminalTurn, "I submitted the application item.");
    const updated = new Date("2026-09-15T18:10:00.000Z");
    for (const [index, status] of (["submitted_by_sid", "not_needed_by_sid"] as const).entries()) {
      const itemId = newUlid(new Date(Date.parse("2026-09-15T18:05:01.000Z") + index));
      await insertItem({
        principalId,
        programId,
        turnId: terminalTurn,
        itemId,
        itemKey: `supplementary_application | terminal ${index}`,
        label: `Terminal ${index}`,
        status,
      }).run();
      await expect(env.DB.prepare(`UPDATE university_application_items
        SET item_status = 'ready', submitted_at = NULL, source_turn_id = ?1, updated_at = ?2
        WHERE principal_id = ?3 AND item_id = ?4`)
        .bind(turnId, updated.toISOString(), principalId, itemId).run())
        .rejects.toThrow(/university_application_item_state_invalid/u);
    }
  });

  it("refuses deletion of an application item", async () => {
    const principalId = "principal:application-migration-delete";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId }).run();
    await expect(env.DB.prepare(`DELETE FROM university_application_items
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, itemId).run())
      .rejects.toThrow(/university_application_item_delete_forbidden/u);
  });
});
