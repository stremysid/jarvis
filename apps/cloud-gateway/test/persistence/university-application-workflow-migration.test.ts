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
  readonly status?: "not_started" | "drafting" | "ready" | "submitted_by_sid";
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

  it("does not let a submitted-by-Sid item move backwards", async () => {
    const principalId = "principal:application-migration-submitted";
    const { programId, turnId } = await seedProgram(principalId);
    const itemId = newUlid(NOW);
    await insertItem({ principalId, programId, turnId, itemId, status: "submitted_by_sid" }).run();
    await expect(env.DB.prepare(`UPDATE university_application_items
      SET item_status = 'ready', submitted_at = NULL, source_turn_id = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`)
      .bind(turnId, NOW.toISOString(), principalId, itemId).run())
      .rejects.toThrow(/university_application_item_status_invalid/u);
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
