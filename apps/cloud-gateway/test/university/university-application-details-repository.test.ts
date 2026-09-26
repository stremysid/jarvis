import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityApplicationDetailsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-16T16:00:00.000Z");

async function seedTurn(principalId: string, turnId: Ulid, text: string, now = NOW): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Workflow owner', ?2, ?2)`).bind(
    principalId,
    NOW.toISOString(),
  ).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("university_workflow_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now,
  });
}

beforeAll(async () => {
  await applyUniversityApplicationDetailsMigration();
});

describe("UniversityTrackerRepository application details", () => {
  it("atomically binds a prepared step to its same-response application item and owner turn", async () => {
    const principalId = "principal:workflow-repository-create";
    const turnId = newUlid(NOW);
    const ownerText = "Prepare the Queen's essay submission for the Queen's essay due 2027-01-15.";
    await seedTurn(principalId, turnId, ownerText);
    const repository = new UniversityTrackerRepository(env.DB);

    await repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "1".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "Queen's University",
          campus: null,
          programName: "Computing",
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
          label: "Queen's essay",
          status: "not_started",
          statusEvidence: ownerText,
          dueDate: {
            date: "2027-01-15",
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: ownerText,
          },
        }],
        workflowUpdates: [{
          workflowRef: "new-workflow-1",
          programRef: "new-1",
          applicationItemRef: "new-item-1",
          kind: "submission_step",
          label: "Queen's essay submission",
          owner: "sid",
          status: "prepared",
          statusEvidence: ownerText,
          preparedDetails: "Review the final essay, sign in, and submit it yourself.",
          deadline: {
            date: "2027-01-15",
            instant: null,
            timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: ownerText,
          },
          executionBoundary: "owner_only",
        }],
      },
    });

    const program = (await repository.readSnapshot(principalId)).programs[0];
    const application = program?.applicationItems[0];
    const workflow = program?.workflowItems?.[0];
    expect(workflow).toMatchObject({
      applicationItemId: application?.itemId,
      revision: 1,
      kind: "submission_step",
      status: "prepared",
      executionBoundary: "owner_only",
      sourceTurnId: turnId,
      deadline: {
        date: "2027-01-15",
        verification: { state: "unverified", sourceUrl: null, verifiedAt: null },
      },
    });
    expect(await repository.listWorkflowItemsByDueDate(principalId)).toEqual([
      expect.objectContaining({ workflowId: workflow?.workflowId, university: "Queen's University" }),
    ]);

    if (program === undefined || application === undefined) throw new Error("university_workflow_fixture_missing");
    const submittedAt = new Date("2026-09-16T16:05:00.000Z");
    const submittedTurnId = newUlid(submittedAt);
    const submittedText = "I submitted the Queen's essay.";
    await seedTurn(principalId, submittedTurnId, submittedText, submittedAt);
    await repository.applyOwnerPlan({
      principalId,
      turnId: submittedTurnId,
      responseHash: "6".repeat(64),
      now: submittedAt,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: application.itemId,
          programRef: program.programId,
          kind: null,
          label: null,
          status: "submitted_by_sid",
          statusEvidence: submittedText,
          dueDate: null,
        }],
        workflowUpdates: [],
      },
    });
    expect(await repository.listWorkflowItemsByDueDate(principalId)).toEqual([]);
  });

  it("keeps contact and payment work open after a parent submission while hiding only its submission step", async () => {
    const principalId = "principal:workflow-repository-parent-scope";
    const createTurnId = newUlid(NOW);
    const createText = "Prepare the Western essay submission for the Western essay. Draft the Ms Lee contact for the Western essay. Prepare the Western fee payment for the Western essay.";
    await seedTurn(principalId, createTurnId, createText);
    const repository = new UniversityTrackerRepository(env.DB);
    const deadline = {
      date: null, instant: null, timeZone: null,
      verification: { state: "unverified" as const, sourceUrl: null, cycle: null }, evidence: createText,
    };
    await repository.applyOwnerPlan({
      principalId,
      turnId: createTurnId,
      responseHash: "b".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Medical Sciences", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "essay", label: "Western essay",
          status: "not_started", statusEvidence: createText,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: createText },
        }],
        workflowUpdates: [
          ["new-workflow-1", "submission_step", "Western essay submission", "Review and submit it yourself."],
          ["new-workflow-2", "contact_step", "Ms Lee contact", "Thank you for your time today."],
          ["new-workflow-3", "payment_step", "Western fee payment", "Review the portal and pay it yourself."],
        ].map(([workflowRef, kind, label, preparedDetails]) => ({
          workflowRef, programRef: "new-1", applicationItemRef: "new-item-1",
          kind: kind as "submission_step" | "contact_step" | "payment_step", label, owner: "sid" as const,
          status: "prepared" as const, statusEvidence: createText, preparedDetails, deadline,
          executionBoundary: "owner_only" as const,
        })),
      },
    });
    const created = (await repository.readSnapshot(principalId)).programs[0]!;
    expect(created.workflowItems?.map((item) => item.preparedDetails)).toEqual([
      expect.stringMatching(/^Unverified draft text;/u),
      expect.stringMatching(/^Unverified draft text;/u),
      expect.stringMatching(/^Unverified draft text;/u),
    ]);
    const application = created.applicationItems[0]!;
    const submittedAt = new Date("2026-09-16T16:06:00.000Z");
    const submittedTurnId = newUlid(submittedAt);
    const submittedText = "I submitted the Western essay.";
    await seedTurn(principalId, submittedTurnId, submittedText, submittedAt);
    await repository.applyOwnerPlan({
      principalId,
      turnId: submittedTurnId,
      responseHash: "c".repeat(64),
      now: submittedAt,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: application.itemId, programRef: created.programId, kind: null, label: null,
          status: "submitted_by_sid", statusEvidence: submittedText, dueDate: null,
        }],
        workflowUpdates: [],
      },
    });

    expect((await repository.listWorkflowItemsByDueDate(principalId)).map((item) => item.kind).sort())
      .toEqual(["contact_step", "payment_step"]);
  });

  it("appends an owner-reported completion and retains the earlier prepared revision", async () => {
    const principalId = "principal:workflow-repository-revisions";
    const createTurnId = newUlid(NOW);
    const createText = "Prepare the Western transcript upload for the Western transcript.";
    await seedTurn(principalId, createTurnId, createText);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: createTurnId,
      responseHash: "2".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Medical Sciences", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "transcript",
          label: "Western transcript", status: "not_started", statusEvidence: createText,
          dueDate: {
            date: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: createText,
          },
        }],
        workflowUpdates: [{
          workflowRef: "new-workflow-1", programRef: "new-1", applicationItemRef: "new-item-1",
          kind: "upload_step", label: "Western transcript upload", owner: "sid",
          status: "prepared", statusEvidence: createText,
          preparedDetails: "Sign in, select the transcript, and upload it yourself.",
          deadline: {
            date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: createText,
          },
          executionBoundary: "owner_only",
        }],
      },
    });
    const created = (await repository.readSnapshot(principalId)).programs[0]!;
    const workflow = created.workflowItems?.[0];
    if (workflow === undefined) throw new Error("university_workflow_fixture_missing");
    const doneAt = new Date("2026-09-16T16:05:00.000Z");
    const doneTurnId = newUlid(doneAt);
    const doneText = "I uploaded the Western transcript upload for the Western transcript.";
    await seedTurn(principalId, doneTurnId, doneText, doneAt);

    await repository.applyOwnerPlan({
      principalId,
      turnId: doneTurnId,
      responseHash: "3".repeat(64),
      now: doneAt,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [],
        workflowUpdates: [{
          workflowRef: workflow.workflowId,
          programRef: created.programId,
          applicationItemRef: null,
          kind: null,
          label: null,
          owner: null,
          status: "owner_reported_done",
          statusEvidence: doneText,
          preparedDetails: null,
          deadline: null,
          executionBoundary: "owner_only",
        }],
      },
    });

    expect((await repository.readSnapshot(principalId)).programs[0]?.workflowItems?.[0]).toMatchObject({
      workflowId: workflow.workflowId,
      revision: 2,
      status: "owner_reported_done",
      sourceTurnId: doneTurnId,
    });
    const revisions = await env.DB.prepare(`SELECT revision_number, workflow_status, source_turn_id
      FROM university_workflow_revisions
      WHERE principal_id = ?1 AND workflow_id = ?2
      ORDER BY revision_number`).bind(principalId, workflow.workflowId).all<{
        revision_number: number;
        workflow_status: string;
        source_turn_id: string;
      }>();
    expect(revisions.results).toEqual([
      { revision_number: 1, workflow_status: "prepared", source_turn_id: createTurnId },
      { revision_number: 2, workflow_status: "owner_reported_done", source_turn_id: doneTurnId },
    ]);
    expect(await repository.listWorkflowItemsByDueDate(principalId)).toEqual([]);
  });

  it("stores a model-declared workflow status even when its evidence does not name the item", async () => {
    const principalId = "principal:workflow-repository-evidence";
    const turnId = newUlid(NOW);
    const ownerText = "Prepare the Western essay submission for the Western essay.";
    await seedTurn(principalId, turnId, ownerText);
    const repository = new UniversityTrackerRepository(env.DB);

    // Code no longer reads the evidence to decide whether it names the workflow
    // and application item; the model declared `owner_reported_done`.
    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "4".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Engineering", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "essay", label: "Western essay",
          status: "not_started", statusEvidence: ownerText,
          dueDate: {
            date: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: ownerText,
          },
        }],
        workflowUpdates: [{
          workflowRef: "new-workflow-1", programRef: "new-1", applicationItemRef: "new-item-1",
          kind: "submission_step", label: "Western essay submission", owner: "sid",
          status: "owner_reported_done", statusEvidence: "I submitted another application.",
          preparedDetails: null,
          deadline: {
            date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: ownerText,
          },
          executionBoundary: "owner_only",
        }],
      },
    })).resolves.toBeUndefined();
    const stored = await repository.readSnapshot(principalId);
    expect(stored.programs[0]!.workflowItems).toMatchObject([{
      kind: "submission_step", label: "Western essay submission", status: "owner_reported_done",
    }]);
  });

  it("revalidates exact school and program binding before storing an offer decision", async () => {
    const principalId = "principal:workflow-repository-offer-binding";
    const setupTurnId = newUlid(NOW);
    await seedTurn(principalId, setupTurnId, "Track Waterloo and Western Computer Science.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: setupTurnId,
      responseHash: "8".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "University of Waterloo", campus: null,
          programName: "Computer Science", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }, {
          programRef: "new-2", university: "Western University", campus: null,
          programName: "Computer Science", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [],
        workflowUpdates: [],
      },
    });
    const programs = (await repository.readSnapshot(principalId)).programs;
    const waterloo = programs.find((program) => program.university === "University of Waterloo");
    const western = programs.find((program) => program.university === "Western University");
    if (waterloo === undefined || western === undefined) throw new Error("university_workflow_fixture_missing");
    const offerAt = new Date("2026-09-16T16:10:00.000Z");
    const offerTurnId = newUlid(offerAt);
    const offerText = "I got an offer from University of Waterloo for Computer Science.";
    await seedTurn(principalId, offerTurnId, offerText, offerAt);
    await repository.applyOwnerPlan({
      principalId,
      turnId: offerTurnId,
      responseHash: "9".repeat(64),
      now: offerAt,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [],
        workflowUpdates: [{
          workflowRef: "new-workflow-1",
          programRef: waterloo.programId,
          applicationItemRef: null,
          kind: "offer",
          label: "offer",
          owner: "university",
          status: "owner_reported_offered",
          statusEvidence: offerText,
          preparedDetails: null,
          deadline: {
            date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null },
            evidence: offerText,
          },
          executionBoundary: "owner_only",
        }],
      },
    });
    const offer = (await repository.readSnapshot(principalId)).programs
      .find((program) => program.programId === waterloo.programId)?.workflowItems?.[0];
    if (offer === undefined) throw new Error("university_workflow_fixture_missing");
    const crossAt = new Date("2026-09-16T16:15:00.000Z");
    const crossTurnId = newUlid(crossAt);
    const crossText = "I received a Western University Computer Science offer instead of the University of Waterloo Computer Science offer.";
    await seedTurn(principalId, crossTurnId, crossText, crossAt);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId: crossTurnId,
      responseHash: "a".repeat(64),
      now: crossAt,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [],
        workflowUpdates: [{
          workflowRef: offer.workflowId,
          programRef: waterloo.programId,
          applicationItemRef: null,
          kind: null,
          label: null,
          owner: null,
          status: "owner_reported_offered",
          statusEvidence: crossText,
          preparedDetails: null,
          deadline: null,
          executionBoundary: "owner_only",
        }],
      },
    })).rejects.toThrow("university_workflow_item_invalid");

    for (const [offset, text, programId, existingWorkflow] of [
      [16, "I got a Computer Science offer from Toronto instead of Waterloo.", waterloo.programId, offer.workflowId],
      [17, "I got a Computer Science offer from UW instead of Western.", western.programId, null],
    ] as const) {
      const now = new Date(`2026-09-16T16:${offset}:00.000Z`);
      const turnId = newUlid(now);
      await seedTurn(principalId, turnId, text, now);
      await expect(repository.applyOwnerPlan({
        principalId,
        turnId,
        responseHash: String(offset).padStart(64, "0"),
        now,
        plan: {
          engaged: true,
          programUpdates: [],
          applicationUpdates: [],
          workflowUpdates: [{
            workflowRef: existingWorkflow ?? "new-workflow-1",
            programRef: programId,
            applicationItemRef: null,
            kind: existingWorkflow === null ? "offer" : null,
            label: existingWorkflow === null ? "offer" : null,
            owner: existingWorkflow === null ? "university" : null,
            status: "owner_reported_offered",
            statusEvidence: text,
            preparedDetails: null,
            deadline: existingWorkflow === null ? {
              date: null, instant: null, timeZone: null,
              verification: { state: "unverified", sourceUrl: null, cycle: null },
              evidence: text,
            } : null,
            executionBoundary: "owner_only",
          }],
        },
      })).rejects.toThrow("university_workflow_item_invalid");
    }
  });

  it("rechecks the explicit offer sentence, fixed label and owner at the repository boundary", async () => {
    const principalId = "principal:workflow-repository-offer-sentence";
    const repository = new UniversityTrackerRepository(env.DB);
    const setupTurnId = newUlid(NOW);
    await seedTurn(principalId, setupTurnId, "Track Waterloo Computer Science.");
    await repository.applyOwnerPlan({
      principalId, turnId: setupTurnId, responseHash: "c".repeat(64), now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "University of Waterloo", campus: null,
          programName: "Computer Science", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [],
        workflowUpdates: [],
      },
    });
    const waterloo = (await repository.readSnapshot(principalId)).programs[0];
    if (waterloo === undefined) throw new Error("university_workflow_fixture_missing");
    let minute = 20;
    const apply = async (text: string, update: Record<string, unknown>): Promise<void> => {
      const now = new Date(`2026-09-16T16:${minute}:00.000Z`);
      const turnId = newUlid(now);
      minute += 1;
      await seedTurn(principalId, turnId, text, now);
      await repository.applyOwnerPlan({
        principalId, turnId, responseHash: String(minute).padStart(64, "d"), now,
        plan: {
          engaged: true, programUpdates: [], applicationUpdates: [],
          workflowUpdates: [{
            workflowRef: "new-workflow-1", programRef: waterloo.programId, applicationItemRef: null,
            kind: "offer", label: "offer", owner: "university", status: "owner_reported_offered",
            statusEvidence: text, preparedDetails: null,
            deadline: { date: null, instant: null, timeZone: null,
              verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
            executionBoundary: "owner_only",
            ...update,
          } as never],
        },
      });
    };
    const explicit = "I got waitlisted by Waterloo for Computer Science.";
    await expect(apply(explicit, { status: "owner_reported_waitlisted", label: "Waterloo offer (confirmed, reply by June 1)" }))
      .rejects.toThrow("university_workflow_item_invalid");
    await expect(apply(explicit, { status: "owner_reported_waitlisted", owner: "sid" }))
      .rejects.toThrow("university_workflow_item_invalid");
    await expect(apply(explicit, { status: "owner_reported_waitlisted", preparedDetails: "Reply by June 1." }))
      .rejects.toThrow("university_workflow_item_invalid");
    for (const text of ["Waterloo still hasn't accepted me.", "I got a Waterloo Math offer.", "I hope I got an offer from Waterloo for Computer Science."]) {
      await expect(apply(text, {})).rejects.toThrow("university_workflow_item_invalid");
    }
    expect((await repository.readSnapshot(principalId)).programs[0]?.workflowItems).toEqual([]);

    await apply(explicit, { status: "owner_reported_waitlisted" });
    const waitlisted = (await repository.readSnapshot(principalId)).programs[0]?.workflowItems?.[0];
    if (waitlisted === undefined) throw new Error("university_workflow_fixture_missing");
    const offered = "I got an offer from University of Waterloo for Computer Science!";
    await apply(offered, {
      workflowRef: waitlisted.workflowId, kind: null, label: null, owner: null, deadline: null,
    });
    await expect(repository.listWorkflowItemsByDueDate(principalId)).resolves.toMatchObject([{
      university: "University of Waterloo", programName: "Computer Science", label: "offer",
      owner: "university", status: "owner_reported_offered",
    }]);
  });

  it("rechecks a digest-visible workflow label at the repository boundary", async () => {
    const principalId = "principal:workflow-repository-label-guard";
    const turnId = newUlid(NOW);
    const text = "Draft the Ms Lee reference Jan 15 verified for the Western reference.";
    await seedTurn(principalId, turnId, text);
    const repository = new UniversityTrackerRepository(env.DB);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "d".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Medical Sciences", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "reference", label: "Western reference",
          status: "not_started", statusEvidence: text,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
        }],
        workflowUpdates: [{
          workflowRef: "new-workflow-1", programRef: "new-1", applicationItemRef: "new-item-1",
          kind: "contact_step", label: "Ms Lee reference Jan 15 verified", owner: "sid",
          status: "prepared", statusEvidence: text, preparedDetails: "Thank you for your time.",
          deadline: { date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
          executionBoundary: "owner_only",
        }],
      },
    })).rejects.toThrow("university_workflow_item_invalid");
    expect((await repository.readSnapshot(principalId)).programs).toEqual([]);
  });

  it("rechecks the aggregate unverified-draft budget at the repository boundary", async () => {
    const principalId = "principal:workflow-repository-draft-budget";
    const turnId = newUlid(NOW);
    const clauses = Array.from({ length: 7 }, (_, index) => `Draft Step ${index + 1} for the Western essay.`);
    const text = clauses.join(" ");
    await seedTurn(principalId, turnId, text);
    const repository = new UniversityTrackerRepository(env.DB);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "e".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Medical Sciences", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "essay", label: "Western essay",
          status: "not_started", statusEvidence: text,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
        }],
        workflowUpdates: clauses.map((_clause, index) => ({
          workflowRef: `new-workflow-${index + 1}`, programRef: "new-1", applicationItemRef: "new-item-1",
          kind: "contact_step" as const, label: `Step ${index + 1}`, owner: "sid" as const,
          status: "prepared" as const, statusEvidence: text, preparedDetails: "x".repeat(1_750),
          deadline: { date: null, instant: null, timeZone: null,
            verification: { state: "unverified" as const, sourceUrl: null, cycle: null }, evidence: text },
          executionBoundary: "owner_only" as const,
        })),
      },
    })).rejects.toThrow("university_workflow_prepared_details_budget_exceeded");
    expect((await repository.readSnapshot(principalId)).programs).toEqual([]);
  });

  it("rechecks the wrapped unverified-draft item limit at the repository boundary", async () => {
    const principalId = "principal:workflow-repository-draft-item-limit";
    const turnId = newUlid(NOW);
    const text = "Draft Step 1 for the Western essay.";
    await seedTurn(principalId, turnId, text);
    const repository = new UniversityTrackerRepository(env.DB);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "f".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Western University", campus: null,
          programName: "Medical Sciences", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "essay", label: "Western essay",
          status: "not_started", statusEvidence: text,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
        }],
        workflowUpdates: [{
          workflowRef: "new-workflow-1", programRef: "new-1", applicationItemRef: "new-item-1",
          kind: "contact_step", label: "Step 1", owner: "sid", status: "prepared", statusEvidence: text,
          preparedDetails: "x".repeat(2_048),
          deadline: { date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
          executionBoundary: "owner_only",
        }],
      },
    })).rejects.toThrow("university_workflow_item_invalid");
    expect((await repository.readSnapshot(principalId)).programs).toEqual([]);
  });

  it("fails before D1 when one owner plan exceeds the declared statement budget", async () => {
    const principalId = "principal:workflow-repository-budget";
    const turnId = newUlid(NOW);
    await seedTurn(principalId, turnId, "Track three application programs.");
    const repository = new UniversityTrackerRepository(env.DB);
    const programUpdates = Array.from({ length: 3 }, (_, programIndex) => ({
      programRef: `new-${programIndex + 1}`,
      university: `University ${programIndex + 1}`,
      campus: null,
      programName: `Program ${programIndex + 1}`,
      ouacCode: null,
      verification: { state: "unverified" as const, sourceUrl: null, cycle: null },
      addRequirements: Array.from({ length: 32 }, (_, itemIndex) => ({
        label: `Requirement ${programIndex + 1}-${itemIndex + 1}`,
        detail: "Owner supplied this unverified requirement.",
        verification: { state: "unverified" as const, sourceUrl: null, cycle: null },
      })),
      addDates: [],
      resolveItemIds: [] as Ulid[],
    }));

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "5".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates,
        applicationUpdates: [],
        workflowUpdates: [],
      },
    })).rejects.toThrow("university_tracker_statement_budget_exceeded");
    expect((await repository.readSnapshot(principalId)).programs).toEqual([]);
  });
});
