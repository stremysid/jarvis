import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import type { UniversityApplicationItemKind } from "../../src/university/university-tracker-types.js";
import { applyUniversityApplicationWorkflowMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T18:30:00.000Z");
const KINDS: readonly UniversityApplicationItemKind[] = [
  "supplementary_application", "essay", "personal_statement", "reference", "transcript", "scholarship",
];

async function seedTurn(principalId: string, turnId: Ulid, text: string, now = NOW): Promise<void> {
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
    now,
  });
}

beforeAll(async () => {
  await applyUniversityApplicationWorkflowMigration();
});

describe("UniversityTrackerRepository application workflow", () => {
  it("adds every checklist kind to a response-local program with visibly unverified dates", async () => {
    const principalId = "principal:application-repository-kinds";
    const turnId = newUlid(NOW);
    const evidence = "Add the application checklist for Test University Engineering.";
    await seedTurn(principalId, turnId, evidence);
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
          university: "Test University",
          campus: null,
          programName: "Engineering",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: KINDS.map((kind, index) => ({
          itemRef: `new-item-${index + 1}`,
          programRef: "new-1",
          kind,
          label: `Checklist ${index + 1}`,
          status: "not_started" as const,
          statusEvidence: evidence,
          dueDate: {
            date: null,
            verification: { state: "unverified" as const, sourceUrl: null, cycle: "2027" },
            evidence,
          },
        })),
      },
    });

    const program = (await repository.readSnapshot(principalId)).programs[0];
    expect(program?.applicationItems.map((item) => item.kind).sort()).toEqual([...KINDS].sort());
    expect(program?.applicationItems).toHaveLength(6);
    for (const item of program?.applicationItems ?? []) {
      expect(item).toMatchObject({
        status: "not_started",
        dueDate: null,
        verification: { state: "unverified", verifiedAt: null },
        submittedAt: null,
      });
    }
  });

  it("updates an AIF draft and its due date only from a new owner turn", async () => {
    const principalId = "principal:application-repository-progress";
    const firstTurn = newUlid(NOW);
    const firstEvidence = "Add my Waterloo AIF to the checklist.";
    await seedTurn(principalId, firstTurn, firstEvidence);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      responseHash: "2".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "University of Waterloo",
          campus: null,
          programName: "Computer Science",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1",
          programRef: "new-1",
          kind: "supplementary_application",
          label: "Waterloo AIF",
          status: "drafting",
          statusEvidence: firstEvidence,
          dueDate: {
            date: null,
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
            evidence: firstEvidence,
          },
        }],
      },
    });
    const first = (await repository.readSnapshot(principalId)).programs[0]!;
    const aif = first.applicationItems[0]!;
    const sourceUrl = "https://uwaterloo.ca/future-students/admissions/aif";
    const secondNow = new Date("2026-09-15T18:35:00.000Z");
    const secondTurn = newUlid(secondNow);
    const secondEvidence = `I finished my Waterloo AIF draft. The official 2027 deadline is January 15, 2027 at ${sourceUrl}.`;
    await seedTurn(principalId, secondTurn, secondEvidence, secondNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      responseHash: "3".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: aif.itemId,
          programRef: first.programId,
          kind: null,
          label: null,
          status: "ready",
          statusEvidence: "I finished my Waterloo AIF draft.",
          dueDate: {
            date: "2027-01-15",
            verification: { state: "verified", sourceUrl, cycle: "2027" },
            evidence: `The official 2027 deadline is January 15, 2027 at ${sourceUrl}.`,
          },
        }],
      },
    });

    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{
        applicationItems: [{
          label: "Waterloo AIF",
          status: "ready",
          dueDate: "2027-01-15",
          verification: { state: "verified", sourceUrl, cycle: "2027", verifiedAt: secondNow.toISOString() },
        }],
      }],
    });
  });

  it("keeps submitted-by-Sid as owner-reported history and removes it from upcoming digest items", async () => {
    const principalId = "principal:application-repository-submitted";
    const firstTurn = newUlid(NOW);
    const firstEvidence = "Add my Queen's Commerce essay with an unverified November 1, 2026 due date.";
    await seedTurn(principalId, firstTurn, firstEvidence);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      responseHash: "4".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "Queen's University",
          campus: null,
          programName: "Commerce",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1",
          programRef: "new-1",
          kind: "essay",
          label: "Commerce essay",
          status: "ready",
          statusEvidence: firstEvidence,
          dueDate: {
            date: "2026-11-01",
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
            evidence: firstEvidence,
          },
        }],
      },
    });
    const program = (await repository.readSnapshot(principalId)).programs[0]!;
    const item = program.applicationItems[0]!;
    expect(await repository.listApplicationItemsByDueDate(principalId)).toHaveLength(1);
    const secondNow = new Date("2026-09-15T18:40:00.000Z");
    const secondTurn = newUlid(secondNow);
    await seedTurn(principalId, secondTurn, "I submitted my Queen's Commerce essay.", secondNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      responseHash: "5".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: item.itemId,
          programRef: program.programId,
          kind: null,
          label: null,
          status: "submitted_by_sid",
          statusEvidence: "I submitted my Queen's Commerce essay.",
          dueDate: null,
        }],
      },
    });

    const submitted = (await repository.readSnapshot(principalId)).programs[0]!.applicationItems[0]!;
    expect(submitted).toMatchObject({ status: "submitted_by_sid", submittedAt: secondNow.toISOString() });
    await expect(repository.listApplicationItemsByDueDate(principalId)).resolves.toEqual([]);
  });
});
