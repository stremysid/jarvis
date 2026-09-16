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

    const unverifiedNow = new Date("2026-09-15T18:40:00.000Z");
    const unverifiedTurn = newUlid(unverifiedNow);
    const unverifiedEvidence = "The Waterloo AIF may instead be due January 16, 2027.";
    await seedTurn(principalId, unverifiedTurn, unverifiedEvidence, unverifiedNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: unverifiedTurn,
      responseHash: "0".repeat(64),
      now: unverifiedNow,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: aif.itemId,
          programRef: first.programId,
          kind: null,
          label: null,
          status: null,
          statusEvidence: null,
          dueDate: {
            date: "2027-01-16",
            verification: { state: "unverified", sourceUrl, cycle: "2027" },
            evidence: unverifiedEvidence,
          },
        }],
      },
    });
    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{ applicationItems: [{
        dueDate: "2027-01-16",
        verification: { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null },
      }] }],
    });
  });

  it("keeps submitted-by-Sid as owner-reported history and lets a later owner turn correct it", async () => {
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

    const correctionNow = new Date("2026-09-15T18:45:00.000Z");
    const correctionTurn = newUlid(correctionNow);
    const correction = "I didn't submit the Queen's Commerce essay; put it back as ready.";
    await seedTurn(principalId, correctionTurn, correction, correctionNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: correctionTurn,
      responseHash: "6".repeat(64),
      now: correctionNow,
      plan: {
        engaged: true,
        programUpdates: [],
        applicationUpdates: [{
          itemRef: item.itemId,
          programRef: program.programId,
          kind: null,
          label: null,
          status: "ready",
          statusEvidence: correction,
          dueDate: null,
        }],
      },
    });

    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{ applicationItems: [{ status: "ready", submittedAt: null, sourceTurnId: correctionTurn }] }],
    });
    await expect(repository.listApplicationItemsByDueDate(principalId)).resolves.toHaveLength(1);
  });

  it("retires an owner-reported item from the digest and can reactivate it later", async () => {
    const principalId = "principal:application-repository-retired";
    const firstTurn = newUlid(NOW);
    const evidence = "Add my Waterloo AIF to the checklist.";
    await seedTurn(principalId, firstTurn, evidence);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      responseHash: "7".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "University of Waterloo", campus: null,
          programName: "Computer Science", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "supplementary_application",
          label: "Waterloo AIF", status: "not_started", statusEvidence: evidence,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence },
        }],
      },
    });
    const program = (await repository.readSnapshot(principalId)).programs[0]!;
    const item = program.applicationItems[0]!;

    const retireNow = new Date("2026-09-15T18:50:00.000Z");
    const retireTurn = newUlid(retireNow);
    const retire = "I am not applying, so mark the Waterloo AIF not needed.";
    await seedTurn(principalId, retireTurn, retire, retireNow);
    await repository.applyOwnerPlan({
      principalId, turnId: retireTurn, responseHash: "8".repeat(64), now: retireNow,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: item.itemId, programRef: program.programId, kind: null, label: null,
          status: "not_needed_by_sid", statusEvidence: retire, dueDate: null,
        }],
      },
    });
    await expect(repository.listApplicationItemsByDueDate(principalId)).resolves.toEqual([]);

    const restoreNow = new Date("2026-09-15T18:55:00.000Z");
    const restoreTurn = newUlid(restoreNow);
    const restore = "I changed my mind; restore the Waterloo AIF to drafting.";
    await seedTurn(principalId, restoreTurn, restore, restoreNow);
    await repository.applyOwnerPlan({
      principalId, turnId: restoreTurn, responseHash: "9".repeat(64), now: restoreNow,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: item.itemId, programRef: program.programId, kind: null, label: null,
          status: "drafting", statusEvidence: restore, dueDate: null,
        }],
      },
    });
    await expect(repository.listApplicationItemsByDueDate(principalId)).resolves.toMatchObject([
      { itemId: item.itemId, status: "drafting" },
    ]);
  });

  it("reactivates a response-local duplicate of a retired item without discarding other updates", async () => {
    const principalId = "principal:application-repository-duplicate";
    const turnId = newUlid(NOW);
    const evidence = "Add my Waterloo AIF to the checklist.";
    await seedTurn(principalId, turnId, evidence);
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId, responseHash: "a".repeat(64), now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "University of Waterloo", campus: null,
          programName: "Computer Science", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: "new-1", kind: "supplementary_application",
          label: "Waterloo AIF", status: "not_started", statusEvidence: evidence,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence },
        }],
      },
    });
    const program = (await repository.readSnapshot(principalId)).programs[0]!;
    const item = program.applicationItems[0]!;
    const secondNow = new Date("2026-09-15T19:00:00.000Z");
    const secondTurn = newUlid(secondNow);
    const retireEvidence = "I no longer need the Waterloo AIF.";
    await seedTurn(principalId, secondTurn, retireEvidence, secondNow);
    await repository.applyOwnerPlan({
      principalId, turnId: secondTurn, responseHash: "b".repeat(64), now: secondNow,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: item.itemId, programRef: program.programId, kind: null, label: null,
          status: "not_needed_by_sid", statusEvidence: retireEvidence, dueDate: null,
        }],
      },
    });

    const restoreNow = new Date("2026-09-15T19:05:00.000Z");
    const restoreTurn = newUlid(restoreNow);
    const restoreEvidence = "Restore my Waterloo AIF and add the English requirement.";
    await seedTurn(principalId, restoreTurn, restoreEvidence, restoreNow);
    await expect(repository.applyOwnerPlan({
      principalId, turnId: restoreTurn, responseHash: "c".repeat(64), now: restoreNow,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: program.programId, university: null, campus: null, programName: null,
          ouacCode: null, verification: null,
          addRequirements: [{
            label: "English requirement",
            detail: "Owner reported English requirement",
            verification: { state: "unverified", sourceUrl: null, cycle: null },
          }],
          addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: program.programId, kind: "supplementary_application",
          label: "Waterloo AIF", status: "not_started", statusEvidence: restoreEvidence,
          dueDate: {
            date: null,
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
            evidence: restoreEvidence,
          },
        }],
      },
    })).resolves.toBeUndefined();
    const saved = (await repository.readSnapshot(principalId)).programs[0]!;
    expect(saved.requirements).toMatchObject([{ label: "English requirement" }]);
    expect(saved.applicationItems).toMatchObject([{ label: "Waterloo AIF", status: "not_started" }]);
    expect(saved.applicationItems).toHaveLength(1);
  });

  it("applies retirements before inserts when the final plan stays at the active cap", async () => {
    const principalId = "principal:application-repository-cap-order";
    const firstTurn = newUlid(NOW);
    await seedTurn(principalId, firstTurn, "Track Test University Engineering.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, responseHash: "e".repeat(64), now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1", university: "Test University", campus: null,
          programName: "Engineering", ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          addRequirements: [], addDates: [], resolveItemIds: [],
        }],
        applicationUpdates: [],
      },
    });
    const program = (await repository.readSnapshot(principalId)).programs[0]!;
    await env.DB.batch(Array.from({ length: 32 }, (_, index) => {
      const itemId = newUlid(new Date(NOW.getTime() + index + 1));
      return env.DB.prepare(`INSERT INTO university_application_items (
        principal_id, program_id, item_id, item_key, item_kind, item_label, item_status,
        due_date, verification_state, source_url, admission_cycle, verified_at,
        source_turn_id, submitted_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'essay', ?5, 'not_started', NULL, 'unverified',
        NULL, '2027', NULL, ?6, NULL, ?7, ?7)`)
        .bind(principalId, program.programId, itemId, `essay | ordered ${index}`,
          `Ordered ${index}`, firstTurn, NOW.toISOString());
    }));
    const current = (await repository.readSnapshot(principalId)).programs[0]!;
    const later = new Date("2026-09-15T19:10:00.000Z");
    const laterTurn = newUlid(later);
    const evidence = "Retire Ordered 0 and add Replacement essay.";
    await seedTurn(principalId, laterTurn, evidence, later);

    await expect(repository.applyOwnerPlan({
      principalId, turnId: laterTurn, responseHash: "f".repeat(64), now: later,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: current.programId, kind: "essay",
          label: "Replacement essay", status: "not_started", statusEvidence: evidence,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence },
        }, {
          itemRef: current.applicationItems[0]!.itemId, programRef: current.programId,
          kind: null, label: null, status: "not_needed_by_sid", statusEvidence: evidence, dueDate: null,
        }],
      },
    })).resolves.toBeUndefined();
    const saved = (await repository.readSnapshot(principalId)).programs[0]!.applicationItems;
    expect(saved.filter((item) => item.status !== "not_needed_by_sid")).toHaveLength(32);
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Ordered 0", status: "not_needed_by_sid" }),
      expect.objectContaining({ label: "Replacement essay", status: "not_started" }),
    ]));

    const reorderNow = new Date("2026-09-15T19:15:00.000Z");
    const reorderTurn = newUlid(reorderNow);
    const reorderEvidence = "Restore Ordered 0 and retire Ordered 1.";
    await seedTurn(principalId, reorderTurn, reorderEvidence, reorderNow);
    const retired = saved.find((item) => item.label === "Ordered 0")!;
    const active = saved.find((item) => item.label === "Ordered 1")!;
    await expect(repository.applyOwnerPlan({
      principalId, turnId: reorderTurn, responseHash: "1".repeat(64), now: reorderNow,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: retired.itemId, programRef: current.programId,
          kind: null, label: null, status: "not_started", statusEvidence: reorderEvidence, dueDate: null,
        }, {
          itemRef: active.itemId, programRef: current.programId,
          kind: null, label: null, status: "not_needed_by_sid", statusEvidence: reorderEvidence, dueDate: null,
        }],
      },
    })).resolves.toBeUndefined();
    const reordered = (await repository.readSnapshot(principalId)).programs[0]!.applicationItems;
    expect(reordered.filter((item) => item.status !== "not_needed_by_sid")).toHaveLength(32);
    expect(reordered).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Ordered 0", status: "not_started" }),
      expect.objectContaining({ label: "Ordered 1", status: "not_needed_by_sid" }),
    ]));
  });

  it("counts cap-held items under inactive programs before attempting a save", async () => {
    const principalId = "principal:application-repository-inactive-cap";
    const firstTurn = newUlid(NOW);
    await seedTurn(principalId, firstTurn, "Track five test programs.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, responseHash: "c".repeat(64), now: NOW,
      plan: {
        engaged: true,
        programUpdates: Array.from({ length: 5 }, (_, index) => ({
          programRef: `new-${index + 1}`,
          university: `Test University ${index}`,
          campus: null,
          programName: `Program ${index}`,
          ouacCode: null,
          verification: { state: "unverified" as const, sourceUrl: null, cycle: "2027" },
          addRequirements: [], addDates: [], resolveItemIds: [],
        })),
        applicationUpdates: [],
      },
    });
    const programs = (await repository.readSnapshot(principalId)).programs;
    for (const program of programs.slice(0, 4)) {
      const inserts = Array.from({ length: 32 }, (_, index) => {
        const itemId = newUlid(new Date(NOW.getTime() + index + 1));
        return env.DB.prepare(`INSERT INTO university_application_items (
          principal_id, program_id, item_id, item_key, item_kind, item_label, item_status,
          due_date, verification_state, source_url, admission_cycle, verified_at,
          source_turn_id, submitted_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'essay', ?5, 'not_started', NULL, 'unverified',
          NULL, '2027', NULL, ?6, NULL, ?7, ?7)`)
          .bind(principalId, program.programId, itemId, `essay | cap ${program.programId} ${index}`,
            `Cap ${index}`, firstTurn, NOW.toISOString());
      });
      await env.DB.batch(inserts);
      await env.DB.prepare(`UPDATE university_programs
        SET active = 0, owner_source_turn_id = ?1, updated_at = ?2
        WHERE principal_id = ?3 AND program_id = ?4`)
        .bind(firstTurn, NOW.toISOString(), principalId, program.programId).run();
    }
    const activeProgram = (await repository.readSnapshot(principalId)).programs[0]!;
    const later = new Date("2026-09-15T19:05:00.000Z");
    const laterTurn = newUlid(later);
    const evidence = "Add the final essay checklist item.";
    await seedTurn(principalId, laterTurn, evidence, later);
    await expect(repository.applyOwnerPlan({
      principalId, turnId: laterTurn, responseHash: "d".repeat(64), now: later,
      plan: {
        engaged: true, programUpdates: [],
        applicationUpdates: [{
          itemRef: "new-item-1", programRef: activeProgram.programId, kind: "essay",
          label: "Final essay", status: "not_started", statusEvidence: evidence,
          dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence },
        }],
      },
    })).rejects.toBeInstanceOf(RangeError);
  });
});
