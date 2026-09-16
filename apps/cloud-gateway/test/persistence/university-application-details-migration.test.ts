import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityApplicationDetailsMigration } from "./migration.js";

const NOW = new Date("2026-09-16T14:00:00.000Z");

async function seedTurn(
  principalId: string,
  turnId: Ulid,
  text: string,
  channel: "telegram" | "voice" = "telegram",
): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Workflow owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("university_workflow_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `${channel}:${principalId}`,
    principalId,
    channel,
    userText: redacted,
    now: NOW,
  });
}

async function seedProgramAndApplication(
  principalId: string,
  suffix = "One",
): Promise<{ readonly programId: Ulid; readonly applicationItemId: Ulid; readonly turnId: Ulid }> {
  const at = new Date(NOW.getTime() + suffix.length * 1_000);
  const turnId = newUlid(at);
  await seedTurn(principalId, turnId, `Add Test University ${suffix} Engineering and ${suffix} essay.`);
  const repository = new UniversityTrackerRepository(env.DB);
  await repository.applyOwnerPlan({
    principalId,
    turnId,
    responseHash: suffix.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
    now: at,
    plan: {
      engaged: true,
      programUpdates: [{
        programRef: "new-1",
        university: `Test University ${suffix}`,
        campus: null,
        programName: "Engineering",
        ouacCode: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null },
        addRequirements: [],
        addDates: [],
        resolveItemIds: [],
      }],
      applicationUpdates: [{
        itemRef: "new-item-1",
        programRef: "new-1",
        kind: "essay",
        label: `${suffix} essay`,
        status: "not_started",
        statusEvidence: `Add Test University ${suffix} Engineering and ${suffix} essay.`,
        dueDate: {
          date: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: `Add Test University ${suffix} Engineering and ${suffix} essay.`,
        },
      }],
      workflowUpdates: [],
    },
  });
  const program = (await repository.readSnapshot(principalId)).programs
    .find((candidate) => candidate.university === `Test University ${suffix}`);
  const applicationItemId = program?.applicationItems[0]?.itemId;
  if (program === undefined || applicationItemId === undefined) {
    throw new Error("university_workflow_fixture_missing");
  }
  return { programId: program.programId, applicationItemId, turnId };
}

function insertIdentity(input: {
  readonly principalId: string;
  readonly programId: Ulid;
  readonly applicationItemId: Ulid | null;
  readonly workflowId: Ulid;
  readonly key?: string;
  readonly label?: string;
  readonly kind?: "submission_step" | "offer" | "offer_condition" | "offer_response";
  readonly createdAt?: string;
}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO university_workflow_items (
    principal_id, program_id, application_item_id, workflow_id, workflow_key,
    workflow_kind, workflow_label, owner_role, created_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sid', ?8)`)
    .bind(input.principalId, input.programId, input.applicationItemId, input.workflowId,
      input.key ?? `submission | ${input.workflowId}`, input.kind ?? "submission_step",
      input.label ?? "Submit the essay", input.createdAt ?? NOW.toISOString());
}

function insertRevision(input: {
  readonly principalId: string;
  readonly workflowId: Ulid;
  readonly turnId: Ulid;
  readonly eventId: Ulid;
  readonly revision?: number;
  readonly status?: string;
  readonly createdAt?: string;
}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO university_workflow_revisions (
    principal_id, workflow_id, event_id, revision_number, workflow_status,
    prepared_details, execution_boundary, due_date, due_at, due_timezone,
    verification_state, source_url, admission_cycle, verified_at, source_turn_id, created_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, 'Owner submits this item.', 'owner_only',
    NULL, NULL, NULL, 'unverified', NULL, NULL, NULL, ?6, ?7)`)
    .bind(input.principalId, input.workflowId, input.eventId, input.revision ?? 1,
      input.status ?? "prepared", input.turnId, input.createdAt ?? NOW.toISOString());
}

beforeAll(async () => {
  await applyUniversityApplicationDetailsMigration();
});

describe("0029 university application details migration", () => {
  it("university_workflow_items_insert_guard rejects REPLACE and IGNORE for both unique keys", async () => {
    const principalId = "principal:workflow-item-insert-guard";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId, key: "submission | guarded" }).run();
    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_workflow_items
        SELECT * FROM university_workflow_items WHERE principal_id = ?1 AND workflow_id = ?2`)
        .bind(principalId, workflowId).run()).rejects.toThrow(/university_workflow_item_insert_conflict/u);
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_workflow_items (
        principal_id, program_id, application_item_id, workflow_id, workflow_key,
        workflow_kind, workflow_label, owner_role, created_at
      ) VALUES (?1, ?2, ?3, ?4, 'submission | guarded', 'submission_step',
        'Alternate id', 'sid', ?5)`).bind(principalId, seeded.programId, seeded.applicationItemId,
        newUlid(new Date(NOW.getTime() + strategy.length)), NOW.toISOString()).run())
        .rejects.toThrow(/university_workflow_item_insert_conflict/u);
    }
  });

  it("university_workflow_items_application_guard refuses an application item from another program", async () => {
    const principalId = "principal:workflow-application-guard";
    const first = await seedProgramAndApplication(principalId, "First");
    const second = await seedProgramAndApplication(principalId, "Second");
    await expect(insertIdentity({
      principalId,
      programId: first.programId,
      applicationItemId: second.applicationItemId,
      workflowId: newUlid(NOW),
    }).run()).rejects.toThrow(/university_workflow_application_item_invalid/u);
  });

  it("university_workflow_items_cap_insert refuses a sixty-fifth item for one program", async () => {
    const principalId = "principal:workflow-item-cap";
    const seeded = await seedProgramAndApplication(principalId);
    for (let index = 0; index < 64; index += 1) {
      await insertIdentity({
        ...seeded,
        principalId,
        workflowId: newUlid(new Date(NOW.getTime() + index + 1)),
        key: `submission | cap ${index}`,
        label: `Submit item ${index}`,
      }).run();
    }
    await expect(insertIdentity({
      ...seeded,
      principalId,
      workflowId: newUlid(new Date(NOW.getTime() + 100)),
      key: "submission | cap 64",
    }).run()).rejects.toThrow(/university_workflow_item_limit_exceeded/u);
  });

  it("university_workflow_items_cap_insert refuses a one-hundred-twenty-ninth item for one principal", async () => {
    const principalId = "principal:workflow-owner-cap";
    const first = await seedProgramAndApplication(principalId, "OwnerFirst");
    const second = await seedProgramAndApplication(principalId, "OwnerSecond");
    const third = await seedProgramAndApplication(principalId, "OwnerThird");
    for (const [seeded, offset] of [[first, 1_000], [second, 2_000]] as const) {
      for (let index = 0; index < 64; index += 1) {
        await insertIdentity({
          ...seeded,
          principalId,
          workflowId: newUlid(new Date(NOW.getTime() + offset + index)),
          key: `submission | owner cap ${offset}-${index}`,
          label: `Owner cap item ${offset}-${index}`,
        }).run();
      }
    }
    await expect(insertIdentity({
      ...third,
      principalId,
      workflowId: newUlid(new Date(NOW.getTime() + 3_000)),
      key: "submission | owner cap 129",
    }).run()).rejects.toThrow(/university_workflow_item_limit_exceeded/u);
  });

  it("university_workflow_items_reject_update keeps the named identity immutable", async () => {
    const principalId = "principal:workflow-item-update";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await expect(env.DB.prepare(`UPDATE university_workflow_items SET workflow_label = 'Changed'
      WHERE principal_id = ?1 AND workflow_id = ?2`).bind(principalId, workflowId).run())
      .rejects.toThrow(/university_workflow_item_update_forbidden/u);
  });

  it("university_workflow_items_reject_delete refuses deletion", async () => {
    const principalId = "principal:workflow-item-delete";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await expect(env.DB.prepare(`DELETE FROM university_workflow_items
      WHERE principal_id = ?1 AND workflow_id = ?2`).bind(principalId, workflowId).run())
      .rejects.toThrow(/university_workflow_item_delete_forbidden/u);
  });

  it("university_workflow_revisions_insert_guard rejects REPLACE and IGNORE for both unique keys", async () => {
    const principalId = "principal:workflow-revision-insert-guard";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    const eventId = newUlid(new Date(NOW.getTime() + 1));
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await insertRevision({ principalId, workflowId, turnId: seeded.turnId, eventId }).run();
    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_workflow_revisions
        SELECT * FROM university_workflow_revisions WHERE principal_id = ?1 AND event_id = ?2`)
        .bind(principalId, eventId).run()).rejects.toThrow(/university_workflow_revision_insert_conflict/u);
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO university_workflow_revisions (
        principal_id, workflow_id, event_id, revision_number, workflow_status,
        prepared_details, execution_boundary, due_date, due_at, due_timezone,
        verification_state, source_url, admission_cycle, verified_at, source_turn_id, created_at
      ) SELECT principal_id, workflow_id, ?3, revision_number, workflow_status,
          prepared_details, execution_boundary, due_date, due_at, due_timezone,
          verification_state, source_url, admission_cycle, verified_at, source_turn_id, created_at
        FROM university_workflow_revisions WHERE principal_id = ?1 AND event_id = ?2`)
        .bind(principalId, eventId, newUlid(new Date(NOW.getTime() + strategy.length + 10))).run())
        .rejects.toThrow(/university_workflow_revision_insert_conflict/u);
    }
  });

  it("university_workflow_revisions_sequence_guard refuses a skipped revision", async () => {
    const principalId = "principal:workflow-revision-sequence";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await insertRevision({
      principalId, workflowId, turnId: seeded.turnId, eventId: newUlid(new Date(NOW.getTime() + 1)),
    }).run();
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: seeded.turnId,
      eventId: newUlid(new Date(NOW.getTime() + 2)),
      revision: 3,
    }).run()).rejects.toThrow(/university_workflow_revision_sequence_invalid/u);
  });

  it("university_workflow_revisions_sequence_guard refuses a revision created before its item", async () => {
    const principalId = "principal:workflow-revision-created-order";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({
      ...seeded,
      principalId,
      workflowId,
      createdAt: "2026-09-16T14:01:00.000Z",
    }).run();
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: seeded.turnId,
      eventId: newUlid(new Date(NOW.getTime() + 1)),
      createdAt: NOW.toISOString(),
    }).run()).rejects.toThrow(/university_workflow_revision_sequence_invalid/u);
  });

  it("university_workflow_revisions_status_guard refuses an offer status on an action item", async () => {
    const principalId = "principal:workflow-revision-status";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: seeded.turnId,
      eventId: newUlid(new Date(NOW.getTime() + 1)),
      status: "owner_reported_offered",
    }).run()).rejects.toThrow(/university_workflow_revision_status_invalid/u);
  });

  it.each([
    ["submission_step", "prepared"],
    ["offer", "owner_reported_offered"],
    ["offer_condition", "owner_reported_pending"],
    ["offer_response", "owner_reported_accepted"],
  ] as const)("university_workflow_revisions_status_guard admits the %s status family", async (kind, status) => {
    const principalId = `principal:workflow-revision-status-${kind}`;
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({
      principalId,
      programId: seeded.programId,
      applicationItemId: kind === "submission_step" ? seeded.applicationItemId : null,
      workflowId,
      kind,
      key: `${kind} | allowed`,
      label: `${kind} allowed status`,
    }).run();
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: seeded.turnId,
      eventId: newUlid(new Date(NOW.getTime() + kind.length)),
      status,
    }).run()).resolves.toBeDefined();
  });

  it("university_workflow_revisions_require_owner_turn refuses another principal's turn", async () => {
    const principalId = "principal:workflow-revision-owner";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    const otherTurn = newUlid(new Date(NOW.getTime() + 20));
    await seedTurn("principal:workflow-revision-other", otherTurn, "I prepared the step.");
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: otherTurn,
      eventId: newUlid(new Date(NOW.getTime() + 21)),
    }).run()).rejects.toThrow(/university_workflow_revision_owner_turn_invalid/u);
  });

  it("university_workflow_revisions_require_owner_turn refuses a non-Telegram owner turn", async () => {
    const principalId = "principal:workflow-revision-channel";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    const voiceTurn = newUlid(new Date(NOW.getTime() + 30));
    await seedTurn(principalId, voiceTurn, "I prepared the step by voice.", "voice");
    await expect(insertRevision({
      principalId,
      workflowId,
      turnId: voiceTurn,
      eventId: newUlid(new Date(NOW.getTime() + 31)),
    }).run()).rejects.toThrow(/university_workflow_revision_owner_turn_invalid/u);
  });

  it("university_workflow_revisions_reject_update keeps history immutable", async () => {
    const principalId = "principal:workflow-revision-update";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    const eventId = newUlid(new Date(NOW.getTime() + 1));
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await insertRevision({ principalId, workflowId, turnId: seeded.turnId, eventId }).run();
    await expect(env.DB.prepare(`UPDATE university_workflow_revisions SET prepared_details = 'Changed'
      WHERE principal_id = ?1 AND event_id = ?2`).bind(principalId, eventId).run())
      .rejects.toThrow(/university_workflow_revision_update_forbidden/u);
  });

  it("university_workflow_revisions_reject_delete refuses deletion", async () => {
    const principalId = "principal:workflow-revision-delete";
    const seeded = await seedProgramAndApplication(principalId);
    const workflowId = newUlid(NOW);
    const eventId = newUlid(new Date(NOW.getTime() + 1));
    await insertIdentity({ ...seeded, principalId, workflowId }).run();
    await insertRevision({ principalId, workflowId, turnId: seeded.turnId, eventId }).run();
    await expect(env.DB.prepare(`DELETE FROM university_workflow_revisions
      WHERE principal_id = ?1 AND event_id = ?2`).bind(principalId, eventId).run())
      .rejects.toThrow(/university_workflow_revision_delete_forbidden/u);
  });
});
