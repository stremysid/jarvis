import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import type { OwnerCatchupPlan } from "../../src/school/school-catchup-types.js";
import { applySchoolCatchupMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function seedTelegramTurn(principalId: string, turnId: Ulid, text: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("school_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now: NOW,
  });
}

function initialPlan(): OwnerCatchupPlan {
  return {
    engaged: true,
    reply: "I made the first catch-up sequence.",
    courseUpdates: [{
      courseRef: "new-1",
      name: "Chemistry",
      platform: "Google Classroom",
      addFacts: [
        { kind: "missed_work", statement: "The acid-base lab was missed during the absence" },
        { kind: "due_work", statement: "The lab write-up is due Friday" },
        { kind: "weak_area", statement: "Titration calculations feel weak" },
      ],
      resolveFactIds: [],
    }],
    completeActionIds: [],
    plan: [
      { courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Finish the lab observations", estimatedMinutes: 25 },
      { courseRef: "new-1", localDate: "2026-09-16", sequenceRank: 1, text: "Draft the lab conclusion", estimatedMinutes: 35 },
    ],
  };
}

beforeAll(async () => {
  await applySchoolCatchupMigration();
});

describe("SchoolCatchupRepository", () => {
  it("keeps one course card with separately labelled evidence and a current next action", async () => {
    const principalId = "principal:school-cards";
    const turnId = "01k5fb9pg00000000000000600" as Ulid;
    await seedTelegramTurn(principalId, turnId, "Chemistry uses Classroom and I missed the acid-base lab.");
    const repository = new SchoolCatchupRepository(env.DB);

    await repository.applyOwnerPlan({
      principalId, turnId, today: TODAY, responseHash: "a".repeat(64), plan: initialPlan(), now: NOW,
    });
    const snapshot = await repository.readSnapshot(principalId, TODAY);
    expect(snapshot.courses).toHaveLength(1);
    expect(snapshot.courses[0]).toMatchObject({
      name: "Chemistry",
      nameSource: "owner_reported",
      platform: "Google Classroom",
      platformSource: "owner_reported",
      currentNextAction: { text: "Finish the lab observations", estimatedMinutes: 25 },
    });
    expect(snapshot.courses[0]?.ownerReportedFacts.map((fact) => fact.kind)).toEqual([
      "missed_work", "due_work", "weak_area",
    ]);

    const courseId = snapshot.courses[0]!.courseId;
    await env.DB.prepare(`INSERT INTO school_course_facts (
      principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
      source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
    ) VALUES (?1, ?2, ?3, 'classroom says lab returned', 'due_work', 'Classroom shows the lab returned',
      'platform_confirmed', NULL, 'classroom:submission:lab', ?4, 'active', NULL, ?4)`)
      .bind(principalId, courseId, "01k5fb9pg00000000000000601", NOW.toISOString()).run();

    const separated = await repository.readSnapshot(principalId, TODAY);
    expect(separated.courses[0]?.ownerReportedFacts).toHaveLength(3);
    expect(separated.courses[0]?.platformConfirmedFacts).toEqual([
      expect.objectContaining({
        statement: "Classroom shows the lab returned",
        evidenceSource: "platform_confirmed",
      }),
    ]);
    await expect(repository.listActionsForDate(principalId, TODAY)).resolves.toEqual([
      expect.objectContaining({ courseName: "Chemistry", sequenceRank: 1, status: "planned" }),
    ]);
  });

  it("replans after a check-in while retaining completed and superseded history", async () => {
    const principalId = "principal:school-replan";
    const firstTurn = "01k5fb9pg00000000000000610" as Ulid;
    await seedTelegramTurn(principalId, firstTurn, "I need a chemistry catch-up plan.");
    const repository = new SchoolCatchupRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, today: TODAY, responseHash: "b".repeat(64), plan: initialPlan(), now: NOW,
    });
    const first = await repository.readSnapshot(principalId, TODAY);
    const course = first.courses[0]!;
    const missedFact = course.ownerReportedFacts.find((fact) => fact.kind === "missed_work")!;
    const completedAction = course.currentNextAction!;

    const secondTurn = "01k5fb9pg00000000000000611" as Ulid;
    const secondNow = new Date("2026-09-15T12:00:00.000Z");
    const redacted = new Redactor().redactText("I finished the observations. The calculations are still hard.");
    if (!redacted.ok) throw new Error("school_fixture_redaction_failed");
    await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
      turnId: secondTurn,
      sessionId: `telegram:${principalId}`,
      principalId,
      channel: "telegram",
      userText: redacted,
      now: secondNow,
    });
    const replanned: OwnerCatchupPlan = {
      engaged: true,
      reply: "Owner-reported: the observations are done. Next is calculations.",
      courseUpdates: [{
        courseRef: course.courseId,
        name: null,
        platform: null,
        addFacts: [],
        resolveFactIds: [missedFact.factId],
      }],
      completeActionIds: [completedAction.actionId],
      plan: [
        { courseRef: course.courseId, localDate: TODAY, sequenceRank: 1, text: "Do three titration calculations", estimatedMinutes: 30 },
      ],
    };
    await repository.applyOwnerPlan({
      principalId, turnId: secondTurn, today: TODAY, responseHash: "c".repeat(64), plan: replanned, now: secondNow,
    });
    // Exact replay is a no-op, not a second plan revision.
    await repository.applyOwnerPlan({
      principalId, turnId: secondTurn, today: TODAY, responseHash: "c".repeat(64), plan: replanned, now: secondNow,
    });

    const current = await repository.readSnapshot(principalId, TODAY);
    expect(current.courses[0]?.ownerReportedFacts.map((fact) => fact.factId)).not.toContain(missedFact.factId);
    expect(current.courses[0]?.currentNextAction?.text).toBe("Do three titration calculations");
    const history = await env.DB.prepare(`SELECT status, COUNT(*) AS count
      FROM school_catchup_actions WHERE principal_id = ?1 GROUP BY status ORDER BY status`)
      .bind(principalId).all<{ status: string; count: number }>();
    expect(history.results).toEqual([
      { status: "completed", count: 1 },
      { status: "planned", count: 1 },
      { status: "superseded", count: 1 },
    ]);
    const receipts = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_catchup_turn_receipts
      WHERE principal_id = ?1`).bind(principalId).first<{ count: number }>();
    expect(receipts?.count).toBe(2);
  });

  it("rejects an unrealistic day atomically", async () => {
    const principalId = "principal:school-cap";
    const turnId = "01k5fb9pg00000000000000620" as Ulid;
    await seedTelegramTurn(principalId, turnId, "I take calculus.");
    const repository = new SchoolCatchupRepository(env.DB);
    const plan = initialPlan();
    const overloaded: OwnerCatchupPlan = {
      ...plan,
      plan: [
        { courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Set one", estimatedMinutes: 100 },
        { courseRef: "new-1", localDate: TODAY, sequenceRank: 2, text: "Set two", estimatedMinutes: 100 },
      ],
    };
    await expect(repository.applyOwnerPlan({
      principalId, turnId, today: TODAY, responseHash: "d".repeat(64), plan: overloaded, now: NOW,
    })).rejects.toThrow("school_catchup_day_unrealistic");
    await expect(repository.readSnapshot(principalId, TODAY)).resolves.toMatchObject({ courses: [] });
  });

  it("rejects an oversized course set before writing any cards", async () => {
    const principalId = "principal:school-course-cap";
    const turnId = "01k5fb9pg00000000000000630" as Ulid;
    await seedTelegramTurn(principalId, turnId, "I am listing all of my courses.");
    const repository = new SchoolCatchupRepository(env.DB);
    const plan: OwnerCatchupPlan = {
      engaged: true,
      reply: "I cannot keep more than the bounded course set.",
      courseUpdates: Array.from({ length: 13 }, (_, index) => ({
        courseRef: `new-${index + 1}`,
        name: `Course ${index + 1}`,
        platform: null,
        addFacts: [],
        resolveFactIds: [],
      })),
      completeActionIds: [],
      plan: [],
    };

    await expect(repository.applyOwnerPlan({
      principalId, turnId, today: TODAY, responseHash: "e".repeat(64), plan, now: NOW,
    })).rejects.toThrow("school_catchup_course_limit_exceeded");
    await expect(repository.readSnapshot(principalId, TODAY)).resolves.toMatchObject({ courses: [] });
  });
});
