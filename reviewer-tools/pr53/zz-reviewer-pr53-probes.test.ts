// Reviewer probes for PR #53. Each asserts that a defect EXISTS. After a fix, every probe here must fail.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { applyStudyCoachMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

class FixedModel implements ModelAdapter {
  calls = 0;
  constructor(private readonly text: string) {}
  stream(): AsyncIterable<ModelToken> {
    this.calls += 1;
    const text = this.text;
    return (async function* () { yield Object.freeze({ index: 0, text }); })();
  }
}

async function addTurn(principalId: string, text: string, offset = 0): Promise<Ulid> {
  const now = new Date(NOW.getTime() + offset);
  const turnId = newUlid(now);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("probe_redaction_failed");
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

async function seedCourse(suffix: string): Promise<{ principalId: string; courseId: Ulid; turnId: Ulid }> {
  const principalId = `principal:zz-reviewer-pr53-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Study owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const turnId = await addTurn(principalId, "Chemistry needs study support");
  const school = new SchoolCatchupRepository(env.DB);
  await school.applyOwnerPlan({
    principalId,
    turnId,
    today: TODAY,
    responseHash: suffix.replace(/[^a-f0-9]/gu, "c").padEnd(64, "c").slice(0, 64),
    now: NOW,
    plan: {
      engaged: true,
      reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "D2L",
        addFacts: [{ kind: "weak_area", statement: "Titration calculations feel uncertain" }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{ courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Review chemistry", estimatedMinutes: 25 }],
    },
  });
  const snapshot = await school.readSnapshot(principalId, TODAY);
  return { principalId, courseId: snapshot.courses[0]!.courseId, turnId };
}

function input(principalId: string, turnId: Ulid, text: string): ModelAdapterStreamInput {
  return {
    correlationId: turnId,
    principalId,
    channel: "telegram",
    userText: text,
    context: [],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 40_000,
    timeoutMs: 90_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 8_000,
    signal: new AbortController().signal,
  };
}

function adapter(principalId: string, fallback: ModelAdapter): StudyCoachModelAdapter {
  return new StudyCoachModelAdapter({
    fallbackModel: fallback,
    practiceModel: new FixedModel(""),
    repository: new StudyCoachRepository(env.DB),
    redactor: new Redactor(),
    ownerPrincipalId: principalId,
    ownerTurnAuthoritative: true,
    timeZone: "America/Toronto",
    now: () => NOW,
  });
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

async function openQuiz(principalId: string, courseId: Ulid, turnId: Ulid): Promise<void> {
  await new StudyCoachRepository(env.DB).createPractice({
    principalId,
    courseId,
    mode: "quiz",
    source: { kind: "owner_topic", turnId, excerpt: "Cells: the mitochondria makes ATP", observedAt: NOW.toISOString() },
    items: [{ question: "Which organelle makes ATP?", answer: "mitochondria", sourceQuote: "the mitochondria makes ATP" }],
    now: NOW,
  });
}

beforeAll(async () => {
  await applyStudyCoachMigration();
});

describe("zzreviewerpr53", () => {
  it("Q1 hijack: an open quiz takes an unrelated message as a wrong answer and the bot never answers", async () => {
    const seeded = await seedCourse("hijack");
    await openQuiz(seeded.principalId, seeded.courseId, seeded.turnId);
    const fallback = new FixedModel("Ordinary answer");
    const turn = await addTurn(seeded.principalId, "What's due tomorrow?", 1_000);
    const reply = await collect(adapter(seeded.principalId, fallback).stream(input(seeded.principalId, turn, "What's due tomorrow?")));
    expect(reply).toContain("Recorded as one wrong result");
    expect(fallback.calls).toBe(0);
  });

  it("Q2 grading: a correct answer with a trailing period is graded wrong", async () => {
    const seeded = await seedCourse("grading");
    await openQuiz(seeded.principalId, seeded.courseId, seeded.turnId);
    const turn = await addTurn(seeded.principalId, "Mitochondria.", 1_000);
    const answered = await new StudyCoachRepository(env.DB).answerActiveQuiz({
      principalId: seeded.principalId, turnId: turn, answer: "Mitochondria.", today: TODAY, now: NOW,
    });
    expect(answered?.item.answerSupport).toBe("supported");
    expect(answered?.result).toBe("wrong");
  });

  it("Q3 ordinary: a non-school statement becomes study evidence and the bot never answers", async () => {
    const seeded = await seedCourse("ordinary");
    const fallback = new FixedModel("Ordinary answer");
    const turn = await addTurn(seeded.principalId, "Getting up early is hard.", 1_000);
    const reply = await collect(adapter(seeded.principalId, fallback).stream(input(seeded.principalId, turn, "Getting up early is hard.")));
    expect(reply).toContain("Recorded one uncertain evidence point for Chemistry");
    expect(fallback.calls).toBe(0);
  });

  it("Q4 lockout: at the per-course evidence cap an open quiz answers every message with a save failure", async () => {
    const seeded = await seedCourse("lockout");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(seeded.principalId, TODAY, NOW);
    for (let index = 0; index < 23; index += 1) {
      const text = `I found topic ${index} hard`;
      const turn = await addTurn(seeded.principalId, text, index + 1);
      await repository.recordOwnerObservation({
        principalId: seeded.principalId, turnId: turn, courseId: seeded.courseId,
        topic: `topic ${index}`, outcome: "uncertain", evidenceText: text, today: TODAY, now: NOW,
      });
    }
    await openQuiz(seeded.principalId, seeded.courseId, seeded.turnId);
    const fallback = new FixedModel("Ordinary answer");
    const replies: string[] = [];
    for (const [offset, text] of [[5_000, "What's due tomorrow?"], [6_000, "Can you help me plan my week"]] as const) {
      const turn = await addTurn(seeded.principalId, text, offset);
      replies.push(await collect(adapter(seeded.principalId, fallback).stream(input(seeded.principalId, turn, text))));
    }
    expect(replies).toEqual(["I couldn't update the study-coach record.", "I couldn't update the study-coach record."]);
    expect(fallback.calls).toBe(0);
  });

  it("Q5 unsupported: correct answers on an owner-topic quiz still build a strong weak-area judgment", async () => {
    const seeded = await seedCourse("unsupported");
    const repository = new StudyCoachRepository(env.DB);
    const items = await repository.createPractice({
      principalId: seeded.principalId,
      courseId: seeded.courseId,
      mode: "quiz",
      source: { kind: "owner_topic", turnId: seeded.turnId, excerpt: "photosynthesis", observedAt: NOW.toISOString() },
      items: [
        { question: "Where does photosynthesis happen?", answer: "chloroplasts", sourceQuote: "unsupported" },
        { question: "Which gas is absorbed?", answer: "carbon dioxide", sourceQuote: "unsupported" },
        { question: "Which gas is released?", answer: "oxygen", sourceQuote: "unsupported" },
      ],
      now: NOW,
    });
    for (const [index, item] of items.entries()) {
      const turn = await addTurn(seeded.principalId, item.answer, 1_000 + index);
      const answered = await repository.answerActiveQuiz({
        principalId: seeded.principalId, turnId: turn, answer: item.answer, today: TODAY, now: NOW,
      });
      expect(answered?.result).toBe("uncertain");
    }
    const snapshot = await repository.readSnapshot(seeded.principalId, TODAY);
    const topic = snapshot.courses[0]?.topics.find((entry) => entry.topicKey === "photosynthesis");
    expect(topic?.judgement).toBe("strong");
    expect(topic?.confidence).toBe("high");
  });
});
