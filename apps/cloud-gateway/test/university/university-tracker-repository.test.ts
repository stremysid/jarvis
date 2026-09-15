import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import type { OwnerUniversityPlan } from "../../src/university/university-tracker-types.js";
import { applyUniversityTrackerMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T15:00:00.000Z");

async function seedTurn(principalId: string, turnId: Ulid, text: string, now = NOW): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'University owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("university_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now,
  });
}

function unverifiedPlan(): OwnerUniversityPlan {
  return {
    engaged: true,
    programUpdates: [{
      programRef: "new-1",
      university: "University of Waterloo",
      campus: "Main campus",
      programName: "Computer Science",
      ouacCode: null,
      verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
      addRequirements: [{
        label: "Grade 12 prerequisites",
        detail: "Advanced Functions and English are required",
        verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
      }],
      addDates: [{
        label: "Application deadline",
        date: null,
        verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
      }],
      resolveItemIds: [],
    }],
  };
}

beforeAll(async () => {
  await applyUniversityTrackerMigration();
});

describe("UniversityTrackerRepository", () => {
  it("keeps a conversational program, requirement, and unpublished date visibly unverified", async () => {
    const principalId = "principal:university-unverified";
    const turnId = "01k5fb9pg00000000000000900" as Ulid;
    await seedTurn(principalId, turnId, "I'm considering Waterloo Computer Science for 2027.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "a".repeat(64),
      plan: unverifiedPlan(),
      now: NOW,
    });
    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{
        university: "University of Waterloo",
        campus: "Main campus",
        programName: "Computer Science",
        verification: { state: "unverified", sourceUrl: null, cycle: "2027", verifiedAt: null },
        requirements: [{
          label: "Grade 12 prerequisites",
          detail: "Advanced Functions and English are required",
          verification: { state: "unverified", verifiedAt: null },
        }],
        dates: [{
          label: "Application deadline",
          date: null,
          verification: { state: "unverified", verifiedAt: null },
        }],
      }],
    });
    await repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "a".repeat(64),
      plan: unverifiedPlan(),
      now: NOW,
    });
    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "b".repeat(64),
      plan: unverifiedPlan(),
      now: NOW,
    })).rejects.toThrow("university_tracker_turn_conflict");
  });

  it("records current-cycle official source metadata on every verified value", async () => {
    const principalId = "principal:university-verified";
    const turnId = "01k5fb9pg00000000000000910" as Ulid;
    const sourceUrl = "https://uwaterloo.ca/future-students/programs/computer-science";
    await seedTurn(principalId, turnId, `The official 2027 page is ${sourceUrl}.`);
    const verification = { state: "verified" as const, sourceUrl, cycle: "2027" };
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "c".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "University of Waterloo",
          campus: null,
          programName: "Computer Science",
          ouacCode: "WCS",
          verification,
          addRequirements: [{
            label: "Required courses",
            detail: "Advanced Functions, Calculus and Vectors, and English",
            verification,
          }],
          addDates: [{ label: "Application deadline", date: "2027-01-15", verification }],
          resolveItemIds: [],
        }],
      },
    });
    const snapshot = await repository.readSnapshot(principalId);
    expect(snapshot.programs[0]?.verification).toEqual({
      state: "verified", sourceUrl, cycle: "2027", verifiedAt: NOW.toISOString(),
    });
    expect(snapshot.programs[0]?.requirements[0]?.verification).toEqual({
      state: "verified", sourceUrl, cycle: "2027", verifiedAt: NOW.toISOString(),
    });
    expect(snapshot.programs[0]?.dates[0]).toMatchObject({
      date: "2027-01-15",
      verification: { state: "verified", sourceUrl, cycle: "2027", verifiedAt: NOW.toISOString() },
    });
  });

  it("refuses to carry stale verification onto a changed program identity", async () => {
    const principalId = "principal:university-stale-verification";
    const firstTurn = "01k5fb9pg00000000000000915" as Ulid;
    await seedTurn(principalId, firstTurn, "I'm considering Waterloo Computer Science for 2027.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      responseHash: "7".repeat(64),
      plan: unverifiedPlan(),
      now: NOW,
    });
    const program = (await repository.readSnapshot(principalId)).programs[0]!;
    const secondTurn = "01k5fb9pg00000000000000916" as Ulid;
    const secondNow = new Date("2026-09-15T15:05:00.000Z");
    await seedTurn(principalId, secondTurn, "Change that to Software Engineering.", secondNow);
    await expect(repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      responseHash: "8".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: program.programId,
          university: null,
          campus: null,
          programName: "Software Engineering",
          ouacCode: null,
          verification: null,
          addRequirements: [],
          addDates: [],
          resolveItemIds: [],
        }],
      },
    })).rejects.toThrow("university_tracker_verification_invalid");
    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{ programName: "Computer Science", verification: { state: "unverified" } }],
    });
  });

  it("retains a resolved requirement while allowing the owner to report it again", async () => {
    const principalId = "principal:university-rereported";
    const firstTurn = "01k5fb9pg00000000000000920" as Ulid;
    await seedTurn(principalId, firstTurn, "I am considering Waterloo Computer Science.");
    const repository = new UniversityTrackerRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, responseHash: "d".repeat(64), plan: unverifiedPlan(), now: NOW,
    });
    const first = await repository.readSnapshot(principalId);
    const program = first.programs[0]!;
    const requirement = program.requirements[0]!;
    const secondTurn = "01k5fb9pg00000000000000921" as Ulid;
    const secondNow = new Date("2026-09-15T15:10:00.000Z");
    await seedTurn(principalId, secondTurn, "Remove that prerequisite note for now.", secondNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      responseHash: "e".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: program.programId,
          university: null,
          campus: null,
          programName: null,
          ouacCode: null,
          verification: null,
          addRequirements: [],
          addDates: [],
          resolveItemIds: [requirement.itemId],
        }],
      },
    });
    const thirdTurn = "01k5fb9pg00000000000000922" as Ulid;
    const thirdNow = new Date("2026-09-15T15:20:00.000Z");
    await seedTurn(principalId, thirdTurn, "Put that unverified prerequisite note back.", thirdNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: thirdTurn,
      responseHash: "f".repeat(64),
      now: thirdNow,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: program.programId,
          university: null,
          campus: null,
          programName: null,
          ouacCode: null,
          verification: null,
          addRequirements: [{
            label: requirement.label,
            detail: requirement.detail!,
            verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          }],
          addDates: [],
          resolveItemIds: [],
        }],
      },
    });
    const counts = await env.DB.prepare(`SELECT status, COUNT(*) AS count
      FROM university_program_items WHERE principal_id = ?1 AND item_kind = 'requirement'
      GROUP BY status ORDER BY status`).bind(principalId).all<{ status: string; count: number }>();
    expect(counts.results).toEqual([{ status: "active", count: 1 }, { status: "resolved", count: 1 }]);
  });
});
