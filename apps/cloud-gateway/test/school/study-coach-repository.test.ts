import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { applyStudyCoachMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function addTurn(principalId: string, text: string, offset = 0): Promise<Ulid> {
  const now = new Date(NOW.getTime() + offset);
  const turnId = newUlid(now);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("study_coach_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now,
  });
  return turnId;
}

async function seedCourse(suffix: string, fact = "Titration calculations feel uncertain"): Promise<{
  principalId: string;
  courseId: Ulid;
  factId: Ulid;
  turnId: Ulid;
}> {
  const principalId = `principal:study-repository-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Study owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const turnId = await addTurn(principalId, "Chemistry needs study support");
  const school = new SchoolCatchupRepository(env.DB);
  await school.applyOwnerPlan({
    principalId,
    turnId,
    today: TODAY,
    responseHash: suffix.replace(/[^a-f0-9]/gu, "b").padEnd(64, "b").slice(0, 64),
    now: NOW,
    plan: {
      engaged: true,
      reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "D2L",
        addFacts: [{ kind: "weak_area", statement: fact }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1", localDate: TODAY, sequenceRank: 1,
        text: "Review chemistry", estimatedMinutes: 25,
      }],
    },
  });
  const snapshot = await school.readSnapshot(principalId, TODAY);
  return {
    principalId,
    courseId: snapshot.courses[0]!.courseId,
    factId: snapshot.courses[0]!.ownerReportedFacts[0]!.factId,
    turnId,
  };
}

beforeAll(async () => {
  await applyStudyCoachMigration();
});

describe("StudyCoachRepository", () => {
  it("keeps course-card context as one dated low-confidence evidence point", async () => {
    const item = await seedCourse("context");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);

    const snapshot = await repository.readSnapshot(item.principalId, TODAY);
    expect(snapshot.courses).toHaveLength(1);
    expect(snapshot.courses[0]?.facts[0]).toMatchObject({
      factId: item.factId,
      statement: "Titration calculations feel uncertain",
      evidenceSource: "owner_reported",
    });
    expect(snapshot.courses[0]?.topics[0]).toMatchObject({
      judgement: "tentative",
      confidence: "low",
      evidence: [{
        evidenceKind: "course_context",
        outcome: "uncertain",
        confidence: "low",
        observedAt: NOW.toISOString(),
      }],
    });
  });

  it("requires repeated evidence before deriving a supported weak-area view", async () => {
    const item = await seedCourse("repeat", "Stoichiometry");
    const repository = new StudyCoachRepository(env.DB);
    const firstTurn = await addTurn(item.principalId, "I found mole ratios hard in Chemistry", 1_000);
    const secondTurn = await addTurn(item.principalId, "I got mole ratios wrong in Chemistry", 2_000);
    await repository.recordOwnerObservation({
      principalId: item.principalId, turnId: firstTurn, courseId: item.courseId,
      topic: "mole ratios", outcome: "uncertain", evidenceText: "I found mole ratios hard in Chemistry",
      today: TODAY, now: new Date(NOW.getTime() + 1_000),
    });
    let snapshot = await repository.readSnapshot(item.principalId, TODAY);
    expect(snapshot.courses[0]?.topics.find((topic) => topic.topic === "mole ratios"))
      .toMatchObject({ judgement: "tentative", confidence: "low" });

    await repository.recordOwnerObservation({
      principalId: item.principalId, turnId: secondTurn, courseId: item.courseId,
      topic: "mole ratios", outcome: "wrong", evidenceText: "I got mole ratios wrong in Chemistry",
      today: TODAY, now: new Date(NOW.getTime() + 2_000),
    });
    snapshot = await repository.readSnapshot(item.principalId, TODAY);
    expect(snapshot.courses[0]?.topics.find((topic) => topic.topic === "mole ratios"))
      .toMatchObject({ judgement: "supported", confidence: "medium", evidence: [{}, {}] });
  });

  it("claims only one due check-in and honors conversational weekend and quiet settings", async () => {
    const item = await seedCourse("checkin");
    const repository = new StudyCoachRepository(env.DB);
    const first = await repository.syncAndClaimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 450, now: NOW,
    });
    expect(first).toMatchObject({
      courseName: "Chemistry", topic: "Titration calculations feel uncertain",
      evidenceCount: 1, confidence: "low",
    });
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 450, now: NOW,
    })).resolves.toBeNull();

    const turnId = await addTurn(item.principalId, "stop checking in on weekends", 1_000);
    await repository.updatePreference({
      principalId: item.principalId,
      turnId,
      preference: { enabled: true, allowedDaysMask: 62, quietStartMinute: 1320, quietEndMinute: 420 },
      now: new Date(NOW.getTime() + 1_000),
    });
    const secondEvidence = await addTurn(item.principalId, "I got equilibrium wrong in Chemistry", 2_000);
    await repository.recordOwnerObservation({
      principalId: item.principalId, turnId: secondEvidence, courseId: item.courseId,
      topic: "equilibrium", outcome: "wrong", evidenceText: "I got equilibrium wrong in Chemistry",
      today: TODAY, now: new Date(NOW.getTime() + 2_000),
    });
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 6, minuteOfDay: 450, now: NOW,
    })).resolves.toBeNull();
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 360, now: NOW,
    })).resolves.toBeNull();
  });

  it("correction and forget controls remove evidence from the operational view", async () => {
    const item = await seedCourse("controls", "Chemistry grade mark 62%");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);
    const correctionTurn = await addTurn(item.principalId, "that mark was entered wrong", 1_000);
    await expect(repository.correctLatestMark(
      item.principalId, correctionTurn, new Date(NOW.getTime() + 1_000),
    )).resolves.toBe(1);
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics).toEqual([]);

    const evidenceTurn = await addTurn(item.principalId, "I found balancing equations hard in Chemistry", 2_000);
    await repository.recordOwnerObservation({
      principalId: item.principalId, turnId: evidenceTurn, courseId: item.courseId,
      topic: "balancing equations", outcome: "uncertain",
      evidenceText: "I found balancing equations hard in Chemistry", today: TODAY,
      now: new Date(NOW.getTime() + 2_000),
    });
    const forgetTurn = await addTurn(item.principalId, "forget that chemistry is a weak spot", 3_000);
    await expect(repository.forget(
      item.principalId, forgetTurn, { courseId: item.courseId }, new Date(NOW.getTime() + 3_000),
    )).resolves.toBe(1);
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics).toEqual([]);
  });

  it("stores exact citations and feeds quiz answers back as evidence", async () => {
    const item = await seedCourse("practice", "Molar mass practice");
    const repository = new StudyCoachRepository(env.DB);
    const practiceTurn = await addTurn(item.principalId, "quiz me on water has a molar mass of 18 g/mol", 1_000);
    const practice = await repository.createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "quiz",
      source: {
        kind: "owner_topic",
        turnId: practiceTurn,
        excerpt: "water has a molar mass of 18 g/mol",
        observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      },
      items: [
        { question: "What is water's molar mass?", answer: "18 g/mol", sourceQuote: "18 g/mol" },
        { question: "What temperature was measured?", answer: "25 C", sourceQuote: "unsupported" },
      ],
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(practice.map((entry) => entry.answerSupport)).toEqual(["supported", "uncertain"]);
    const answerTurn = await addTurn(item.principalId, "20 g/mol", 2_000);
    await expect(repository.answerActiveQuiz({
      principalId: item.principalId,
      turnId: answerTurn,
      answer: "20 g/mol",
      today: TODAY,
      now: new Date(NOW.getTime() + 2_000),
    })).resolves.toMatchObject({ result: "wrong", item: { sourceExcerpt: "water has a molar mass of 18 g/mol" } });
    const uncertainTurn = await addTurn(item.principalId, "25 C", 3_000);
    await expect(repository.answerActiveQuiz({
      principalId: item.principalId,
      turnId: uncertainTurn,
      answer: "25 C",
      today: TODAY,
      now: new Date(NOW.getTime() + 3_000),
    })).resolves.toMatchObject({ result: "uncertain" });
    const snapshot = await repository.readSnapshot(item.principalId, TODAY);
    const results = snapshot.courses[0]?.topics
      .find((topic) => topic.topic === "water has a molar mass of 18 g/mol")?.evidence;
    expect(results?.map((point) => ({ outcome: point.outcome, confidence: point.confidence }))).toEqual([
      { outcome: "wrong", confidence: "medium" },
      { outcome: "uncertain", confidence: "low" },
    ]);
  });
});
