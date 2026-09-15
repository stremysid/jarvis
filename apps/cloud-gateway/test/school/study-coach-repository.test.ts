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

async function seedCourse(
  suffix: string,
  fact = "Titration calculations feel uncertain",
  factKind: "weak_area" | "due_work" | "missed_work" = "weak_area",
): Promise<{
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
        addFacts: [{ kind: factKind, statement: fact }],
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

  it("syncs new weak-area facts even when owner evidence fills the course cap", async () => {
    const item = await seedCourse("context-at-cap", "Essay due Friday", "due_work");
    const repository = new StudyCoachRepository(env.DB);
    for (let index = 0; index < 24; index += 1) {
      const text = `Owner evidence ${index}`;
      const turnId = await addTurn(item.principalId, text, 10 + index);
      await repository.recordOwnerObservation({
        principalId: item.principalId,
        turnId,
        courseId: item.courseId,
        topic: `owner topic ${index}`,
        outcome: "uncertain",
        evidenceText: text,
        today: TODAY,
        now: new Date(NOW.getTime() + 10 + index),
      });
    }
    const factsTurn = await addTurn(item.principalId, "Add current weak areas", 1_000);
    await new SchoolCatchupRepository(env.DB).applyOwnerPlan({
      principalId: item.principalId,
      turnId: factsTurn,
      today: TODAY,
      responseHash: "d".repeat(64),
      now: new Date(NOW.getTime() + 1_000),
      plan: {
        engaged: true,
        reply: "Updated weak areas",
        courseUpdates: [{
          courseRef: item.courseId,
          name: "Chemistry",
          platform: "D2L",
          addFacts: [
            { kind: "weak_area", statement: "Balancing equations" },
            { kind: "weak_area", statement: "Mole ratios" },
            { kind: "weak_area", statement: "Titration setup" },
          ],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: item.courseId,
          localDate: TODAY,
          sequenceRank: 1,
          text: "Review current weak areas",
          estimatedMinutes: 20,
        }],
      },
    });

    await repository.syncCourseContext(
      item.principalId,
      TODAY,
      new Date(NOW.getTime() + 2_000),
    );

    const count = await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM school_study_evidence
      WHERE principal_id = ?1 AND course_id = ?2 AND evidence_kind = 'course_context'`)
      .bind(item.principalId, item.courseId).first<{ count: number }>();
    expect(count?.count).toBe(3);
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
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 450,
      now: new Date(NOW.getTime() + 3_000),
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
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 450,
      now: new Date(NOW.getTime() + 3_000),
    })).resolves.toBeNull();
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 6, minuteOfDay: 450, now: NOW,
    })).resolves.toBeNull();
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 1, minuteOfDay: 360, now: NOW,
    })).resolves.toBeNull();
  });

  it("forget controls remove evidence from the operational view", async () => {
    const item = await seedCourse("controls", "Chemistry grade mark 62%");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);
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
    )).resolves.toBe(2);
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics).toEqual([]);
  });

  it("stores exact course-card citations and grades a non-exact answer uncertain", async () => {
    const item = await seedCourse("practice", "water has a molar mass of 18 g/mol");
    const repository = new StudyCoachRepository(env.DB);
    const practice = await repository.createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "quiz",
      source: {
        kind: "course_fact",
        factId: item.factId,
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
    })).resolves.toMatchObject({ result: "uncertain", item: { sourceExcerpt: "water has a molar mass of 18 g/mol" } });
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
      { outcome: "uncertain", confidence: "medium" },
    ]);
  });

  it("does not label a negated question or one-letter answer as source-supported", async () => {
    const item = await seedCourse("support-check", "Water has a molar mass of 18 g/mol and choice a is listed");
    const practice = await new StudyCoachRepository(env.DB).createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "flashcard",
      source: {
        kind: "course_fact",
        factId: item.factId,
        excerpt: "Water has a molar mass of 18 g/mol and choice a is listed",
        observedAt: NOW.toISOString(),
      },
      items: [
        { question: "Which value is NOT the molar mass?", answer: "18 g/mol", sourceQuote: "molar mass of 18 g/mol" },
        { question: "Which choice is listed?", answer: "a", sourceQuote: "choice a" },
      ],
      now: NOW,
    });
    expect(practice.map((entry) => entry.answerSupport)).toEqual(["uncertain", "uncertain"]);
  });

  it("Q5 keeps owner-topic quiz results out of weak-area judgment and check-ins", async () => {
    const item = await seedCourse("q5-unsupported");
    const repository = new StudyCoachRepository(env.DB);
    const practiceTurn = await addTurn(item.principalId, "quiz me on photosynthesis", 1_000);
    const items = await repository.createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "quiz",
      source: {
        kind: "owner_topic",
        turnId: practiceTurn,
        excerpt: "photosynthesis",
        observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      },
      items: [
        { question: "Where does photosynthesis happen?", answer: "chloroplasts", sourceQuote: "unsupported" },
        { question: "Which gas is absorbed?", answer: "carbon dioxide", sourceQuote: "unsupported" },
        { question: "Which gas is released?", answer: "oxygen", sourceQuote: "unsupported" },
      ],
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(items.every((practice) => practice.answerSupport === "uncertain")).toBe(true);
    for (const [index, practice] of items.entries()) {
      const turnId = await addTurn(item.principalId, practice.answer, 2_000 + index);
      await expect(repository.answerActiveQuiz({
        principalId: item.principalId,
        turnId,
        answer: practice.answer,
        today: TODAY,
        now: new Date(NOW.getTime() + 2_000 + index),
      })).resolves.toMatchObject({ result: "uncertain" });
    }
    const topic = (await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics
      .find((candidate) => candidate.topicKey === "photosynthesis");
    expect(topic).toBeUndefined();
  });

  it("does not retire owner evidence when an owner-topic answer or retried turn adds no evidence", async () => {
    const item = await seedCourse("unsupported-at-cap");
    const repository = new StudyCoachRepository(env.DB);
    let firstEvidenceTurn: Ulid | null = null;
    for (let index = 0; index < 24; index += 1) {
      const text = `Cap evidence ${index}`;
      const turnId = await addTurn(item.principalId, text, 10 + index);
      firstEvidenceTurn ??= turnId;
      await repository.recordOwnerObservation({
        principalId: item.principalId,
        turnId,
        courseId: item.courseId,
        topic: `cap topic ${index}`,
        outcome: "uncertain",
        evidenceText: text,
        today: TODAY,
        now: new Date(NOW.getTime() + 10 + index),
      });
    }
    const practiceTurn = await addTurn(item.principalId, "quiz me on mitosis", 100);
    await repository.createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "quiz",
      source: {
        kind: "owner_topic",
        turnId: practiceTurn,
        excerpt: "mitosis",
        observedAt: new Date(NOW.getTime() + 100).toISOString(),
      },
      items: [{ question: "What is mitosis?", answer: "cell division", sourceQuote: "unsupported" }],
      now: new Date(NOW.getTime() + 100),
    });
    const answerTurn = await addTurn(item.principalId, "cell division", 200);
    await repository.answerActiveQuiz({
      principalId: item.principalId,
      turnId: answerTurn,
      answer: "cell division",
      today: TODAY,
      now: new Date(NOW.getTime() + 200),
    });

    const counts = async (): Promise<{ active: number; superseded: number } | null> => env.DB.prepare(`SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'superseded') AS superseded
      FROM school_study_evidence
      WHERE principal_id = ?1 AND course_id = ?2 AND evidence_kind != 'course_context'`)
      .bind(item.principalId, item.courseId).first<{ active: number; superseded: number }>();
    await expect(counts()).resolves.toEqual({ active: 24, superseded: 0 });

    if (firstEvidenceTurn === null) throw new Error("study_coach_retry_fixture_missing");
    await repository.recordOwnerObservation({
      principalId: item.principalId,
      turnId: firstEvidenceTurn,
      courseId: item.courseId,
      topic: "cap topic 0",
      outcome: "uncertain",
      evidenceText: "Cap evidence 0",
      today: TODAY,
      now: new Date(NOW.getTime() + 300),
    });
    await expect(counts()).resolves.toEqual({ active: 24, superseded: 0 });
  });

  it("uses the topic summary's weak-versus-easy judgment for check-in confidence", async () => {
    const item = await seedCourse("weak-count", "Unrelated weak fact");
    const repository = new StudyCoachRepository(env.DB);
    const outcomes = ["uncertain", "uncertain", "uncertain", "easy", "easy", "easy", "easy", "easy"] as const;
    for (const [index, outcome] of outcomes.entries()) {
      const text = `mole ratios ${outcome} ${index}`;
      const turnId = await addTurn(item.principalId, text, 1_000 + index);
      await repository.recordOwnerObservation({
        principalId: item.principalId,
        turnId,
        courseId: item.courseId,
        topic: "mole ratios",
        outcome,
        evidenceText: text,
        today: TODAY,
        now: new Date(NOW.getTime() + 1_000 + index),
      });
    }
    const summary = (await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics
      .find((topic) => topic.topic === "mole ratios");
    expect(summary?.confidence).toBe("low");
    const checkIn = await repository.claimDigestCheckIn({
      principalId: item.principalId,
      today: TODAY,
      weekday: 1,
      minuteOfDay: 450,
      now: new Date(NOW.getTime() + 5_000),
    });
    expect(checkIn).toMatchObject({ topic: "mole ratios", evidenceCount: 3, confidence: "low" });
    expect(checkIn?.confidence).toBe(summary?.confidence);
  });

  it("does not turn a due-work course fact into a weak-area check-in", async () => {
    const item = await seedCourse("due-fact", "Essay due Friday", "due_work");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics).toEqual([]);
    await expect(repository.claimDigestCheckIn({
      principalId: item.principalId,
      today: TODAY,
      weekday: 1,
      minuteOfDay: 450,
      now: NOW,
    })).resolves.toBeNull();
  });

  it("retires owner and practice evidence after the active retention window", async () => {
    const item = await seedCourse("retention");
    const repository = new StudyCoachRepository(env.DB);
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    const turnId = await addTurn(item.principalId, "I found old topic hard in Chemistry", old.getTime() - NOW.getTime());
    await repository.recordOwnerObservation({
      principalId: item.principalId,
      turnId,
      courseId: item.courseId,
      topic: "old topic",
      outcome: "uncertain",
      evidenceText: "I found old topic hard in Chemistry",
      today: old.toISOString().slice(0, 10),
      now: old,
    });

    await repository.syncCourseContext(item.principalId, TODAY, NOW);
    const row = await env.DB.prepare(`SELECT status FROM school_study_evidence
      WHERE principal_id = ?1 AND source_key = ?2`).bind(item.principalId, `turn:${turnId}`)
      .first<{ status: string }>();
    expect(row?.status).toBe("superseded");
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]?.topics
      .some((topic) => topic.topic === "old topic")).toBe(false);
  });
});
