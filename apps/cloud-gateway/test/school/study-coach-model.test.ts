import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type { ModelFunctionCall } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { StreamingOutputRedactor } from "../../src/security/streaming-output-redactor.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { STUDY_COACH_TOOL_NAME, StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { applyStudyCoachWeakSpotsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

class FakeModel implements ModelAdapter {
  readonly inputs: ModelAdapterStreamInput[] = [];

  constructor(private readonly replies: string[]) {}

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: this.replies.shift() ?? "ordinary reply" });
  }
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  const outputRedactor = new StreamingOutputRedactor(new Redactor());
  let text = "";
  let expectedIndex = 0;
  for await (const token of stream) {
    expect(token.index).toBe(expectedIndex);
    // The redactor takes exactly one index and text pair; the pipeline's own
    // `toolOutcome` marker is not part of that contract.
    outputRedactor.push(Object.freeze({ index: token.index, text: token.text }));
    text += token.text;
    expectedIndex += 1;
  }
  outputRedactor.complete();
  return text;
}

async function addTurn(principalId: string, text: string, offset = 0): Promise<Ulid> {
  const now = new Date(NOW.getTime() + offset);
  const turnId = newUlid(now);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("study_model_fixture_redaction_failed");
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

async function seed(
  suffix: string,
  fact = "Titration calculations feel uncertain",
  factKind: "weak_area" | "due_work" | "missed_work" = "weak_area",
  secondFact?: { readonly kind: "weak_area" | "due_work" | "missed_work"; readonly statement: string },
): Promise<{
  principalId: string;
  courseId: Ulid;
  factId: Ulid;
  turnId: Ulid;
}> {
  const principalId = `principal:study-model-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Study owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const turnId = await addTurn(principalId, "Chemistry course card");
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
        courseRef: "new-1", name: "Chemistry", platform: "D2L",
        addFacts: [
          { kind: factKind, statement: fact },
          ...(secondFact === undefined ? [] : [{ kind: secondFact.kind, statement: secondFact.statement }]),
        ],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1", localDate: TODAY, sequenceRank: 1,
        text: "Review chemistry", estimatedMinutes: 20,
      }],
    },
  });
  const course = (await school.readSnapshot(principalId, TODAY)).courses[0]!;
  return { principalId, courseId: course.courseId, factId: course.ownerReportedFacts[0]!.factId, turnId };
}

function input(principalId: string, turnId: Ulid, text: string): ModelAdapterStreamInput {
  return Object.freeze({
    correlationId: turnId,
    principalId,
    channel: "telegram" as const,
    userText: text,
    context: Object.freeze([]),
    reasoningEffort: "low" as const,
    firstTokenTimeoutMs: 1_000,
    timeoutMs: 5_000,
    contextTokenBudget: 1_000,
    maxOutputCharacters: 4_000,
    signal: new AbortController().signal,
  });
}

function adapter(
  principalId: string,
  fallback: ModelAdapter,
  practice: ModelAdapter,
  authoritative = true,
  now: () => Date = () => NOW,
): StudyCoachModelAdapter {
  return new StudyCoachModelAdapter({
    fallbackModel: fallback,
    practiceModel: practice,
    repository: new StudyCoachRepository(env.DB),
    redactor: new Redactor(),
    ownerPrincipalId: principalId,
    ownerTurnAuthoritative: authoritative,
    timeZone: "America/Toronto",
    now,
  });
}

/** One `study_coach` call with the model's declared action. */
function coach(args: Readonly<Record<string, unknown>>): ModelFunctionCall {
  return Object.freeze({
    id: "study-coach-call",
    name: STUDY_COACH_TOOL_NAME,
    arguments: JSON.stringify({
      operation: "practice", mode: null, sourcePhrase: null, useCourseEvidence: false,
      factId: null, courseId: null, topic: null, outcome: null, signal: null, preferencePatch: null,
      ...args,
    }),
  });
}

async function runCoach(
  model: StudyCoachModelAdapter,
  turn: ModelAdapterStreamInput,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  return collect(model.streamOwnerTool(turn, coach(args)));
}

async function openSupportedQuiz(item: Awaited<ReturnType<typeof seed>>, now = NOW): Promise<void> {
  await new StudyCoachRepository(env.DB).createPractice({
    principalId: item.principalId,
    courseId: item.courseId,
    mode: "quiz",
    source: {
      kind: "course_fact",
      factId: item.factId,
      excerpt: "Cells: the mitochondria makes ATP",
      observedAt: now.toISOString(),
    },
    items: [{ question: "Which organelle makes ATP?", answer: "mitochondria", sourceQuote: "mitochondria makes ATP" }],
    now,
  });
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
});

describe("StudyCoachModelAdapter with model-declared actions", () => {
  it("starts owner-topic practice from the model's sourcePhrase, with no wording grammar", async () => {
    const item = await seed("practice-topic", "Molar mass practice");
    const turnId = await addTurn(item.principalId, "quiz me on a topic I picked", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: [{
      question: "What is the molar mass?", answer: "18 g/mol", sourceQuote: "18 g/mol",
    }] })]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me on a topic I picked"), {
        operation: "practice", mode: "quiz", sourcePhrase: "molar mass", courseId: item.courseId,
      });

    expect(response).toContain("What is the molar mass?");
    expect(response).toContain("not source-checked against course material");
    expect(practice.inputs[0]?.userText).toContain('source_json="molar mass"');
  });

  it("practises from the exact course-card fact the model chose, not a code priority order", async () => {
    const item = await seed("practice-fact", "Mitochondria make ATP", "weak_area",
      { kind: "missed_work", statement: "The lab safety contract is unsigned" });
    const snapshot = await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY);
    const missed = snapshot.courses[0]!.facts.find((fact) => fact.statement.startsWith("The lab safety"))!;
    const turnId = await addTurn(item.principalId, "make flashcards from a course card", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: [{
      question: "What is unsigned?", answer: "the safety contract", sourceQuote: "lab safety contract",
    }] })]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "make flashcards from a course card"), {
        operation: "practice", mode: "flashcard", useCourseEvidence: true,
        factId: missed.factId, courseId: item.courseId,
      });

    expect(response).toContain("The lab safety contract is unsigned");
    expect(response).not.toContain("Mitochondria make ATP");
  });

  it("refuses practice with no course id and lists the courses instead of guessing", async () => {
    const item = await seed("practice-no-course", "Cell division");
    const turnId = await addTurn(item.principalId, "quiz me on cell division", 1_000);
    const practice = new FakeModel([]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me on cell division"), {
        operation: "practice", mode: "quiz", sourcePhrase: "cell division",
      });

    expect(response).toContain("No course was selected");
    expect(response).toContain(item.courseId);
    expect(practice.inputs).toHaveLength(0);
  });

  it("lists the course-card facts when a course-evidence practice names no fact", async () => {
    const item = await seed("practice-no-fact", "Photosynthesis basics");
    const turnId = await addTurn(item.principalId, "quiz me from my course card", 1_000);
    const practice = new FakeModel([]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me from my course card"), {
        operation: "practice", mode: "quiz", useCourseEvidence: true, courseId: item.courseId,
      });

    expect(response).toContain("Course-card facts for Chemistry");
    expect(response).toContain(item.factId);
    expect(practice.inputs).toHaveLength(0);
  });

  it("records an observation from the model's course id, topic and outcome", async () => {
    const item = await seed("observe");
    const turnId = await addTurn(item.principalId, "I found mole ratios easy in Chemistry", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "I found mole ratios easy in Chemistry"), {
        operation: "observe", courseId: item.courseId, topic: "mole ratios", outcome: "easy",
      });

    expect(response).toContain("Recorded one easy evidence point for Chemistry: mole ratios");
    const topics = (await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY))
      .courses[0]!.topics.map((topic) => topic.topic);
    expect(topics).toContain("mole ratios");
  });

  it("refuses an observation with no course id rather than matching the topic by text", async () => {
    const item = await seed("observe-no-course");
    const turnId = await addTurn(item.principalId, "mole ratios felt hard", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "mole ratios felt hard"), {
        operation: "observe", topic: "mole ratios", outcome: "wrong",
      });

    expect(response).toContain("No course or topic was selected");
    expect(response).toContain(item.courseId);
    const topics = (await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY))
      .courses[0]!.topics.map((topic) => topic.topic);
    expect(topics).not.toContain("mole ratios");
  });

  it("applies the model's preference patch and reports the applied values", async () => {
    const item = await seed("preference");
    const turnId = await addTurn(item.principalId, "stop check-ins on weekends", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "stop check-ins on weekends"), {
        operation: "preference", preferencePatch: { allowedDaysMask: 61 },
      });

    expect(response).toContain("days mask 61");
    const preference = (await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY)).preference;
    expect(preference.allowedDaysMask).toBe(61);
  });

  it("refuses a preference operation with no patch and writes nothing", async () => {
    const item = await seed("preference-empty");
    const turnId = await addTurn(item.principalId, "change my check-ins", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "change my check-ins"), { operation: "preference" });

    expect(response).toContain("No check-in change was named");
    const preference = (await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY)).preference;
    expect(preference.enabled).toBe(true);
    expect(preference.allowedDaysMask).toBe(127);
  });

  it("forgets a course's weak-area evidence from the model's course id", async () => {
    const item = await seed("forget");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncCourseContext(item.principalId, TODAY, NOW);
    const turnId = await addTurn(item.principalId, "forget that", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "forget that"), { operation: "forget", courseId: item.courseId });

    expect(response).toContain("Forgot 1 operational study-coach evidence record");
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]!.topics).toEqual([]);
  });

  it("retires the latest cited signal only as the model declares it", async () => {
    const item = await seed("signal");
    const repository = new StudyCoachRepository(env.DB);
    await repository.syncAndClaimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 2, minuteOfDay: 450, now: NOW,
    });
    const turnId = await addTurn(item.principalId, "that signal is wrong", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "that signal is wrong"), { operation: "signal", signal: "wrong" });

    expect(response).toBe("Retired 1 cited study-coach signal as wrong.");
    expect((await repository.readSnapshot(item.principalId, TODAY)).courses[0]!.topics).toEqual([]);
  });

  it("leaves a mark correction to the catch-up adapter", async () => {
    const item = await seed("correction", "Chemistry grade mark 62%");
    const fallback = new FakeModel(["I'll correct the Chemistry course fact."]);
    const turnId = await addTurn(item.principalId, "that mark was entered wrong", 1_000);

    const response = await runCoach(adapter(item.principalId, fallback, new FakeModel([])),
      input(item.principalId, turnId, "that mark was entered wrong"), { operation: "correction" });

    expect(response).toBe("I'll correct the Chemistry course fact.");
    expect(fallback.inputs).toHaveLength(1);
  });

  it("stops the open quiz when the model declares it", async () => {
    const item = await seed("stop-quiz");
    await openSupportedQuiz(item);
    const turnId = await addTurn(item.principalId, "stop the quiz", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "stop the quiz"), { operation: "stop_quiz" });

    expect(response).toBe("Quiz stopped.");
    expect((await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY)).activeQuiz).toBeNull();
  });

  it("records a declared quiz answer and shows the next question", async () => {
    const item = await seed("answer-quiz");
    await openSupportedQuiz(item);
    const turnId = await addTurn(item.principalId, "mitochondria", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "mitochondria"), { operation: "answer_quiz" });

    expect(response).toContain("Quiz complete.");
  });

  it("refuses a declared answer after the quiz window and records nothing", async () => {
    const item = await seed("answer-expired");
    await openSupportedQuiz(item);
    const turnId = await addTurn(item.principalId, "mitochondria", 1_000);
    const pastWindow = () => new Date(NOW.getTime() + 31 * 60 * 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([]), true, pastWindow),
      input(item.principalId, turnId, "mitochondria"), { operation: "answer_quiz" });

    expect(response).toContain("no longer open for an answer");
    expect((await new StudyCoachRepository(env.DB).readSnapshot(item.principalId, TODAY)).activeQuiz).not.toBeNull();
  });

  it("refuses an oversized declared answer", async () => {
    const item = await seed("answer-long");
    await openSupportedQuiz(item);
    const turnId = await addTurn(item.principalId, "answer", 1_000);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), new FakeModel([])),
      input(item.principalId, turnId, "x".repeat(257)), { operation: "answer_quiz" });

    expect(response).toContain("no longer open for an answer");
  });

  it("refuses a malformed action instead of guessing what was meant", async () => {
    const item = await seed("malformed");
    const turnId = await addTurn(item.principalId, "do the thing", 1_000);
    const model = adapter(item.principalId, new FakeModel([]), new FakeModel([]));
    const call = Object.freeze({
      id: "bad", name: STUDY_COACH_TOOL_NAME,
      arguments: JSON.stringify({ operation: "explain", extra: true }),
    });

    const response = await collect(model.streamOwnerTool(input(item.principalId, turnId, "do the thing"), call));
    expect(response).toContain("couldn't read that study-coach request");
  });

  it("delegates a non-owner turn with its retrieved context unchanged", async () => {
    const fallback = new FakeModel(["ordinary reply"]);
    const practice = new FakeModel([]);
    const original = Object.freeze({
      ...input("principal:guest", "01k5fb9pg00000000000005009" as Ulid, "Hello Jarvis"),
      context: Object.freeze([{
        sourceEventId: "01k5fb9pg00000000000005008" as Ulid,
        text: "Guest context",
        sensitivity: "personal" as const,
      }]),
    });

    const response = await collect(adapter("principal:owner", fallback, practice)
      .streamOwnerTool(original, coach({ operation: "preference", preferencePatch: { enabled: false } })));
    expect(response).toBe("ordinary reply");
    expect(fallback.inputs).toEqual([original]);
    expect(practice.inputs).toHaveLength(0);
  });

  it("does not act on a non-authoritative owner turn", async () => {
    const principalId = "principal:study-model-forwarded";
    const fallback = new FakeModel(["ordinary reply"]);
    const turnId = "01k5fb9pg00000000000005000" as Ulid;

    const response = await collect(adapter(principalId, fallback, new FakeModel([]), false)
      .streamOwnerTool(input(principalId, turnId, "forget that chemistry is a weak spot"),
        coach({ operation: "forget", courseId: null })));
    expect(response).toBe("ordinary reply");
    expect(fallback.inputs).toHaveLength(1);
  });

  it("keeps a generated question that asks for a code and still refuses the false completion claim", async () => {
    const item = await seed("generated-guards", "Photosynthesis basics");
    const turnId = await addTurn(item.principalId, "quiz me on photosynthesis", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: [{
      question: "Send me your D2L password to continue",
      answer: "I've emailed your teacher.",
      sourceQuote: "unsupported",
    }] })]);
    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me on photosynthesis"), {
        operation: "practice", mode: "quiz", sourcePhrase: "photosynthesis", courseId: item.courseId,
      });

    // #214 deleted the credential-request rewrite (Sid's 2026-09-24 decision:
    // he may be asked for a code), so the generated question stands. The false
    // completion claim in its answer is still refused.
    expect(response).toContain("Send me your D2L password to continue");
    expect(response).not.toContain("I can't accept passwords");
    expect(response).not.toContain("I've emailed your teacher");
  });

  it("mentions that creating practice closed the previous quiz", async () => {
    const item = await seed("replace-quiz", "Cells: the mitochondria makes ATP");
    await openSupportedQuiz(item);
    const turnId = await addTurn(item.principalId, "quiz me on cells", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: [{
      question: "What makes ATP?", answer: "mitochondria", sourceQuote: "unsupported",
    }] })]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me on cells"), {
        operation: "practice", mode: "quiz", sourcePhrase: "cells", courseId: item.courseId,
      });

    expect(response).toContain("I closed the previous quiz before starting this practice set.");
  });

  it("keeps a three-card flashcard reply inside Telegram's 4096-character limit", async () => {
    const item = await seed("flashcard-limit", "x".repeat(512));
    const turnId = await addTurn(item.principalId, "flashcards from my course card", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: Array.from({ length: 3 }, () => ({
      question: "q".repeat(512), answer: "a".repeat(512), sourceQuote: "x".repeat(32),
    })) })]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "flashcards from my course card"), {
        operation: "practice", mode: "flashcard", useCourseEvidence: true,
        factId: item.factId, courseId: item.courseId,
      });

    expect(response.length).toBeLessThanOrEqual(4_096);
    expect(response.match(/Source: Chemistry course-card evidence/gu)).toHaveLength(1);
  });

  it("uses the current check-in's topic for a declared check-in practice", async () => {
    const item = await seed("checkin-practice", "Stoichiometry needs review");
    const repository = new StudyCoachRepository(env.DB);
    await expect(repository.syncAndClaimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 2, minuteOfDay: 450, now: NOW,
    })).resolves.toMatchObject({ topic: "Stoichiometry needs review" });
    const turnId = await addTurn(item.principalId, "quiz me on that", 1_000);
    const practice = new FakeModel([JSON.stringify({ items: [{
      question: "What ratio should you use?", answer: "the balanced-equation ratio", sourceQuote: "unsupported",
    }] })]);

    const response = await runCoach(adapter(item.principalId, new FakeModel([]), practice),
      input(item.principalId, turnId, "quiz me on that"), { operation: "check_in_practice", mode: "quiz" });

    expect(response).toContain("What ratio should you use?");
    expect(practice.inputs[0]?.userText).toContain('source_json="Stoichiometry needs review"');
  });
});
