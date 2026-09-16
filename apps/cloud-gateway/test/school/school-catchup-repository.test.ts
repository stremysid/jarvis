import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import type { OwnerCatchupPlan } from "../../src/school/school-catchup-types.js";
import { applyUniversityTrackerMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function seedTelegramTurn(principalId: string, turnId: Ulid, text: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  await addTelegramTurn(principalId, turnId, text, NOW);
}

async function addTelegramTurn(principalId: string, turnId: Ulid, text: string, now: Date): Promise<void> {
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("school_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now,
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
  await applyUniversityTrackerMigration();
});

describe("SchoolCatchupRepository", () => {
  it("clamps valid legacy rows that exceed the read caps", async () => {
    const principalId = "principal:school-read-clamp";
    const courseIds = Array.from({ length: 13 }, (_, index) => newUlid(new Date(NOW.getTime() + index)));
    const courseRows = courseIds.map((courseId, index) => ({
      principal_id: principalId,
      course_id: courseId,
      course_name: `Course ${index}`,
      course_name_source: "owner_reported",
      platform_name: null,
      platform_source: null,
    }));
    const factRows = Array.from({ length: 17 }, (_, index) => ({
      principal_id: principalId,
      course_id: courseIds[0]!,
      fact_id: newUlid(new Date(NOW.getTime() + 100 + index)),
      fact_kind: "weak_area",
      statement: `Weak area ${index}`,
      evidence_source: "owner_reported",
      observed_at: NOW.toISOString(),
      status: "active",
      resolved_at: null,
    }));
    const actionRows = Array.from({ length: 22 }, (_, index) => ({
      principal_id: principalId,
      action_id: newUlid(new Date(NOW.getTime() + 200 + index)),
      course_id: courseIds[index % 12]!,
      course_name: `Course ${index % 12}`,
      local_date: TODAY,
      sequence_rank: 1,
      action_text: `Action ${index}`,
      estimated_minutes: 10,
      status: "planned",
    }));
    const database = {
      prepare(query: string) {
        const results = query.includes("FROM school_course_cards")
          ? courseRows
          : query.includes("FROM school_course_facts")
            ? factRows
            : actionRows;
        const statement = {
          bind: () => statement,
          all: async () => ({ results }),
        };
        return statement;
      },
    } as unknown as D1Database;

    const snapshot = await new SchoolCatchupRepository(database).readSnapshot(principalId, TODAY);
    expect(snapshot.courses).toHaveLength(12);
    expect(snapshot.courses[0]?.ownerReportedFacts).toHaveLength(16);
    expect(snapshot.courses.filter((course) => course.currentNextAction !== null)).toHaveLength(12);
  });

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

  it("replans after a check-in while retaining recent completions and pruning superseded actions", async () => {
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
    ]);
    const resolvedFacts = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_course_facts
      WHERE principal_id = ?1 AND status = 'resolved'`).bind(principalId).first<{ count: number }>();
    expect(resolvedFacts?.count).toBe(1);
    expect(current.courses[0]?.recentResolvedFacts).toEqual([
      expect.objectContaining({ factId: missedFact.factId, status: "resolved" }),
    ]);
    const receipts = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_catchup_turn_receipts
      WHERE principal_id = ?1`).bind(principalId).first<{ count: number }>();
    expect(receipts?.count).toBe(2);

    const pruneTurn = "01k5fb9pg00000000000000612" as Ulid;
    const pruneNow = new Date("2026-10-16T12:00:01.000Z");
    await addTelegramTurn(principalId, pruneTurn, "Show me the current chemistry plan.", pruneNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: pruneTurn,
      today: "2026-10-16",
      responseHash: "7".repeat(64),
      now: pruneNow,
      plan: {
        engaged: true,
        reply: "The old completion history has aged out.",
        courseUpdates: [],
        completeActionIds: [],
        plan: [{
          courseRef: course.courseId,
          localDate: "2026-10-16",
          sequenceRank: 1,
          text: "Review the current chemistry lesson",
          estimatedMinutes: 20,
        }],
      },
    });
    const prunedFacts = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_course_facts
      WHERE principal_id = ?1 AND status = 'resolved'`).bind(principalId).first<{ count: number }>();
    const prunedActions = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_catchup_actions
      WHERE principal_id = ?1 AND status = 'completed'`).bind(principalId).first<{ count: number }>();
    expect(prunedFacts?.count).toBe(0);
    expect(prunedActions?.count).toBe(0);
  });

  it("keeps the existing schedule when only a valid course fact can be saved", async () => {
    const principalId = "principal:school-partial-plan";
    const firstTurn = "01k5fb9pg00000000000000613" as Ulid;
    await seedTelegramTurn(principalId, firstTurn, "I need a chemistry catch-up plan.");
    const repository = new SchoolCatchupRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, today: TODAY, responseHash: "a".repeat(64), plan: initialPlan(), now: NOW,
    });
    const before = await repository.readSnapshot(principalId, TODAY);
    const course = before.courses[0]!;
    const existingAction = course.currentNextAction!;
    const secondTurn = "01k5fb9pg00000000000000614" as Ulid;
    const secondNow = new Date("2026-09-15T12:15:00.000Z");
    await addTelegramTurn(principalId, secondTurn, "My chemistry test is Friday.", secondNow);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      today: TODAY,
      responseHash: "b".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        reply: "Owner-reported: the chemistry test is Friday.",
        courseUpdates: [{
          courseRef: course.courseId,
          name: null,
          platform: null,
          addFacts: [{ kind: "due_work", statement: "Chemistry test is Friday" }],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [],
      },
    })).resolves.toEqual({
      scheduleSaved: false,
      partialCodes: ["partial:school_catchup_course_missing_next_action"],
    });

    const after = await repository.readSnapshot(principalId, TODAY);
    expect(after.courses[0]?.currentNextAction).toMatchObject({
      actionId: existingAction.actionId,
      text: existingAction.text,
      status: "planned",
    });
    expect(after.courses[0]?.ownerReportedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "due_work", statement: "Chemistry test is Friday" }),
    ]));
  });

  it("stores a re-reported resolved owner fact as a new active fact", async () => {
    const principalId = "principal:school-fact-rereported";
    const firstTurn = "01k5fb9pg00000000000000640" as Ulid;
    await seedTelegramTurn(principalId, firstTurn, "I missed the acid-base lab.");
    const repository = new SchoolCatchupRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId, turnId: firstTurn, today: TODAY, responseHash: "1".repeat(64), plan: initialPlan(), now: NOW,
    });
    const first = await repository.readSnapshot(principalId, TODAY);
    const course = first.courses[0]!;
    const fact = course.ownerReportedFacts.find((item) => item.kind === "missed_work")!;
    await expect(env.DB.prepare(`UPDATE school_course_facts SET statement = 'Changed'
      WHERE principal_id = ?1 AND fact_id = ?2`).bind(principalId, fact.factId).run())
      .rejects.toThrow(/school_course_fact_core_immutable/u);

    const addTurn = async (turnId: Ulid, text: string, now: Date): Promise<void> => {
      const redacted = new Redactor().redactText(text);
      if (!redacted.ok) throw new Error("school_fixture_redaction_failed");
      await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
        turnId,
        sessionId: `telegram:${principalId}`,
        principalId,
        channel: "telegram",
        userText: redacted,
        now,
      });
    };
    const secondTurn = "01k5fb9pg00000000000000641" as Ulid;
    const secondNow = new Date("2026-09-15T12:00:00.000Z");
    await addTurn(secondTurn, "That lab is handled now.", secondNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      today: TODAY,
      responseHash: "2".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        reply: "Resolved.",
        courseUpdates: [{
          courseRef: course.courseId,
          name: null,
          platform: null,
          addFacts: [],
          resolveFactIds: [fact.factId],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: course.courseId,
          localDate: TODAY,
          sequenceRank: 1,
          text: "Review the next lesson",
          estimatedMinutes: 20,
        }],
      },
    });

    const thirdTurn = "01k5fb9pg00000000000000642" as Ulid;
    const thirdNow = new Date("2026-09-15T12:30:00.000Z");
    await addTurn(thirdTurn, "Actually, I still missed the acid-base lab.", thirdNow);
    await repository.applyOwnerPlan({
      principalId,
      turnId: thirdTurn,
      today: TODAY,
      responseHash: "3".repeat(64),
      now: thirdNow,
      plan: {
        engaged: true,
        reply: "I put it back on the active catch-up list.",
        courseUpdates: [{
          courseRef: course.courseId,
          name: null,
          platform: null,
          addFacts: [{ kind: "missed_work", statement: "The acid-base lab was missed during the absence" }],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: course.courseId,
          localDate: TODAY,
          sequenceRank: 1,
          text: "Recover the acid-base lab",
          estimatedMinutes: 25,
        }],
      },
    });

    const current = await repository.readSnapshot(principalId, TODAY);
    const rereported = current.courses[0]?.ownerReportedFacts
      .find((item) => item.kind === "missed_work");
    expect(rereported).toMatchObject({
      statement: "The acid-base lab was missed during the absence",
      status: "active",
    });
    expect(rereported?.factId).not.toBe(fact.factId);
  });

  it("drops an action that would push a day beyond 180 minutes", async () => {
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
    })).resolves.toEqual({
      scheduleSaved: true,
      partialCodes: ["partial:repaired:school_catchup_day_unrealistic"],
    });
    await expect(repository.listActionsForDate(principalId, TODAY)).resolves.toEqual([
      expect.objectContaining({ text: "Set one", estimatedMinutes: 100, sequenceRank: 1 }),
    ]);
  });

  it("resolves every fact before inserting any replacement fact in the batch", async () => {
    const principalId = "principal:school-fact-cap-order";
    const firstTurn = "01k5fb9pg00000000000000670" as Ulid;
    await seedTelegramTurn(principalId, firstTurn, "I have three courses with several catch-up facts.");
    const repository = new SchoolCatchupRepository(env.DB);
    const factCounts = [15, 16, 16, 1];
    const courses = ["Chemistry", "Calculus", "English", "Physics"].map((name, courseIndex) => ({
      courseRef: `new-${courseIndex + 1}`,
      name,
      platform: null,
      addFacts: Array.from({ length: factCounts[courseIndex]! }, (_, factIndex) => ({
        kind: "missed_work" as const,
        statement: `${name} catch-up item ${factIndex + 1}`,
      })),
      resolveFactIds: [],
    }));
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      today: TODAY,
      responseHash: "8".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        reply: "I recorded the owner-reported catch-up items.",
        courseUpdates: courses,
        completeActionIds: [],
        plan: courses.map((course, index) => ({
          courseRef: course.courseRef,
          localDate: index < 3 ? TODAY : "2026-09-16",
          sequenceRank: index < 3 ? index + 1 : 1,
          text: `Start ${course.name}`,
          estimatedMinutes: 20,
        })),
      },
    });
    const first = await repository.readSnapshot(principalId, TODAY);
    const addCourse = first.courses.find((course) => course.name === "Chemistry")!;
    const resolveCourse = first.courses.find((course) => course.name === "English")!;
    const factToResolve = resolveCourse.ownerReportedFacts[0]!;
    const secondTurn = "01k5fb9pg00000000000000671" as Ulid;
    const secondNow = new Date("2026-09-15T12:10:00.000Z");
    await addTelegramTurn(principalId, secondTurn, "English item one is done and Chemistry has one new item.", secondNow);
    await expect(repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      today: TODAY,
      responseHash: "9".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        reply: "I moved the completed item into recent history and added the new item.",
        courseUpdates: [{
          courseRef: addCourse.courseId,
          name: null,
          platform: null,
          addFacts: [{ kind: "due_work", statement: "Chemistry review sheet is due" }],
          resolveFactIds: [],
        }, {
          courseRef: resolveCourse.courseId,
          name: null,
          platform: null,
          addFacts: [],
          resolveFactIds: [factToResolve.factId],
        }],
        completeActionIds: [],
        plan: first.courses.map((course, index) => ({
          courseRef: course.courseId,
          localDate: index < 3 ? TODAY : "2026-09-16",
          sequenceRank: index < 3 ? index + 1 : 1,
          text: `Continue ${course.name}`,
          estimatedMinutes: 20,
        })),
      },
    })).resolves.toEqual({ scheduleSaved: true, partialCodes: [] });
    const active = await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_course_facts
      WHERE principal_id = ?1 AND status = 'active'`).bind(principalId).first<{ count: number }>();
    expect(active?.count).toBe(48);
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

  it("keeps the persisted course set readable when two concurrent plans race the cap", async () => {
    const principalId = "principal:school-concurrent-cap";
    const seedTurn = "01k5fb9pg00000000000000650" as Ulid;
    await seedTelegramTurn(principalId, seedTurn, "Here are eleven of my courses.");
    const repository = new SchoolCatchupRepository(env.DB);
    const courseUpdates = Array.from({ length: 11 }, (_, index) => ({
      courseRef: `new-${index + 1}`,
      name: `Course ${index + 1}`,
      platform: null,
      addFacts: [],
      resolveFactIds: [],
    }));
    const dates = Array.from({ length: 7 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 15 + index)).toISOString().slice(0, 10));
    await repository.applyOwnerPlan({
      principalId,
      turnId: seedTurn,
      today: TODAY,
      responseHash: "4".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        reply: "Seeded.",
        courseUpdates,
        completeActionIds: [],
        plan: courseUpdates.map((course, index) => ({
          courseRef: course.courseRef,
          localDate: dates[Math.floor(index / 2)]!,
          sequenceRank: index % 2 + 1,
          text: `Catch up course ${index + 1}`,
          estimatedMinutes: 15,
        })),
      },
    });
    const current = await repository.readSnapshot(principalId, TODAY);
    expect(current.courses).toHaveLength(11);

    const addTurn = async (turnId: Ulid, now: Date): Promise<void> => {
      const redacted = new Redactor().redactText("I also take one more course.");
      if (!redacted.ok) throw new Error("school_fixture_redaction_failed");
      await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
        turnId,
        sessionId: `telegram:${principalId}`,
        principalId,
        channel: "telegram",
        userText: redacted,
        now,
      });
    };
    const firstTurn = "01k5fb9pg00000000000000651" as Ulid;
    const secondTurn = "01k5fb9pg00000000000000652" as Ulid;
    const firstNow = new Date("2026-09-15T12:00:00.000Z");
    const secondNow = new Date("2026-09-15T12:00:01.000Z");
    await addTurn(firstTurn, firstNow);
    await addTurn(secondTurn, secondNow);
    const racingPlan = (name: string): OwnerCatchupPlan => ({
      engaged: true,
      reply: `Added ${name}.`,
      courseUpdates: [{ courseRef: "new-1", name, platform: null, addFacts: [], resolveFactIds: [] }],
      completeActionIds: [],
      plan: [
        ...current.courses.map((course, index) => ({
          courseRef: course.courseId,
          localDate: dates[Math.floor(index / 2)]!,
          sequenceRank: index % 2 + 1,
          text: `Continue ${course.name}`,
          estimatedMinutes: 15,
        })),
        {
          courseRef: "new-1",
          localDate: dates[5]!,
          sequenceRank: 2,
          text: `Start ${name}`,
          estimatedMinutes: 15,
        },
      ],
    });
    const results = await Promise.allSettled([
      repository.applyOwnerPlan({
        principalId, turnId: firstTurn, today: TODAY, responseHash: "5".repeat(64),
        plan: racingPlan("Course 12A"), now: firstNow,
      }),
      repository.applyOwnerPlan({
        principalId, turnId: secondTurn, today: TODAY, responseHash: "6".repeat(64),
        plan: racingPlan("Course 12B"), now: secondNow,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(repository.readSnapshot(principalId, TODAY)).resolves.toMatchObject({
      courses: expect.arrayContaining(current.courses.map((course) => expect.objectContaining({ courseId: course.courseId }))),
    });
    const after = await repository.readSnapshot(principalId, TODAY);
    expect(after.courses).toHaveLength(12);
  });
});
