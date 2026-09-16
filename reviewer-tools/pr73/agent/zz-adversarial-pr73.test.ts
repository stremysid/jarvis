import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { assembleDigest } from "../../src/jobs/digest-job.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { SchoolObservationRepository } from "../../src/school/school-observation-repository.js";
import { parseStudySignalControlIntent, StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { deriveStudySignals, chooseStudyCheckIn } from "../../src/school/study-coach-signals.js";
import type { StudyCoachSnapshot } from "../../src/school/study-coach-types.js";
import { applyStudyCoachWeakSpotsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z"); // 07:30 Toronto
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
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

async function addTurn(principalId: string, text: string, at: Date): Promise<Ulid> {
  const turnId = newUlid(at);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId, sessionId: `telegram:${principalId}`, principalId, channel: "telegram", userText: redacted, now: at,
  });
  return turnId;
}

async function seed(suffix: string, courseName: string, fact: string, factKind: "weak_area" | "due_work") {
  const principalId = `principal:adv73-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Study owner', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const turnId = await addTurn(principalId, "course card", NOW);
  const school = new SchoolCatchupRepository(env.DB);
  await school.applyOwnerPlan({
    principalId, turnId, today: TODAY,
    responseHash: suffix.replace(/[^a-f0-9]/gu, "d").padEnd(64, "d").slice(0, 64),
    now: NOW,
    plan: {
      engaged: true, reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1", name: courseName, platform: "D2L",
        addFacts: [{ kind: factKind, statement: fact }], resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{ courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Review", estimatedMinutes: 20 }],
    },
  });
  const snapshot = await school.readSnapshot(principalId, TODAY);
  return { principalId, courseId: snapshot.courses[0]!.courseId };
}

function digestDeps(principalId: string, now: Date) {
  const observations = new SchoolObservationRepository(env.DB);
  const deadlines = new DeadlineRepository(env.DB);
  const study = new StudyCoachRepository(env.DB);
  return {
    sources: {
      readCatchupActions: async () => [],
      readApplicationItems: async () => [],
      readDeadlines: async () => [],
      readDeadlineSources: async () => [],
      readSchoolObservations: async () => ({ source: null, grades: [], missingWork: [], missingWorkOmitted: 0 }),
      readProjectStatuses: async () => [],
      readOpenDecisions: async () => [],
      claimStudyCheckIn: async (date: string, weekday: number, minuteOfDay: number) => {
        const [schoolSignals, deadlineSignals] = await Promise.all([
          observations.readStudySnapshot({ principalId, now }),
          deadlines.listStudyCandidates(now),
        ]);
        return study.syncAndClaimDigestCheckIn({
          principalId, today: date, weekday, minuteOfDay, now,
          signalInputs: { observations: schoolSignals, deadlines: deadlineSignals },
        });
      },
    },
    delivery: { send: vi.fn(async () => undefined) },
    clock: { now: () => new Date(now) },
    timeZone: "America/Toronto",
  };
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
});

describe("PR #73 adversarial", () => {
  it("A1 a turned-in, returned 9/10 Classroom quiz becomes an 'overdue' weak spot plus a 'low grade'", async () => {
    const item = await seed("a1", "Calculus", "Unit test due next week", "due_work");
    const deadlines = new DeadlineRepository(env.DB);
    const sourceId = "adv73-classroom-a1";
    await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
    await deadlines.recordSourceSuccess(sourceId, NOW);
    const due = await deadlines.upsert({
      sourceId, externalId: "calc:limits", course: "Calculus", title: "Limits quiz (out of 10)",
      dueAt: "2026-09-14T15:00:00.000Z", effort: "quiz", leadMinutes: 60, now: NOW,
    });
    const obs = new SchoolObservationRepository(env.DB);
    await obs.ensureSync(item.principalId, sourceId, NOW);
    await obs.saveCheckpoint({
      principalId: item.principalId, sourceId, courseId: "course-calc", pageToken: null,
      scanStartedAt: NOW.toISOString(), now: NOW,
    });
    expect(await obs.ingest({
      principalId: item.principalId, sourceId, now: NOW,
      items: [{
        deadlineExternalId: "calc:limits", externalSubmissionId: "calc:limits:sub",
        state: "returned", late: false, assignedGrade: 9, sourceUpdatedAt: "2026-09-14T12:00:00.000Z",
      }],
    })).toMatchObject({ created: 1 });
    await obs.completeSubmissionScan(item.principalId, sourceId, NOW);

    const digest = await assembleDigest("daily", digestDeps(item.principalId, NOW) as never);
    console.log("A1 DIGEST >>>\n" + digest.text + "\n<<<");
    expect(digest.text).toContain(`deadline ${due.deadline.deadlineId}`);
    expect(digest.text).toContain("The open deadline was overdue as of 2026-09-15.");
    expect(digest.text).toContain("Google Classroom assigned grade 9.");
    const snap = await obs.readStudySnapshot({ principalId: item.principalId, now: NOW });
    expect(snap.missingWork).toHaveLength(0); // the platform itself says it was submitted
  });

  it("A2 the same weak-area evidence is re-claimed every day (slice-1 prompted it once)", async () => {
    const item = await seed("a2", "Chemistry", "Titration calculations feel uncertain", "weak_area");
    const repository = new StudyCoachRepository(env.DB);
    const topics: Array<string | null> = [];
    for (let day = 0; day < 4; day += 1) {
      const now = new Date(NOW.getTime() + day * 86_400_000);
      const today = now.toISOString().slice(0, 10);
      const claim = await repository.syncAndClaimDigestCheckIn({
        principalId: item.principalId, today, weekday: (2 + day) % 7 === 0 || (2 + day) % 7 === 6 ? 1 : (2 + day) % 7,
        minuteOfDay: 450, now, signalInputs: {},
      });
      topics.push(claim?.topic ?? null);
    }
    console.log("A2 topics per day", topics);
    expect(topics).toEqual(Array(4).fill("Titration calculations feel uncertain"));
  });

  it("A3 an unrelated overdue deadline inflates a one-point, low-confidence topic to 'high confidence'", async () => {
    const item = await seed("a3", "Physics", "Projectile motion feels uncertain", "weak_area");
    const deadlines = new DeadlineRepository(env.DB);
    const sourceId = "adv73-manual-a3";
    await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
    await deadlines.recordSourceSuccess(sourceId, NOW);
    await deadlines.upsert({
      sourceId, externalId: "phys:lab", course: "Physics", title: "Lab safety form",
      dueAt: "2026-09-13T15:00:00.000Z", effort: "other", leadMinutes: 60, now: NOW,
    });
    const digest = await assembleDigest("daily", digestDeps(item.principalId, NOW) as never);
    console.log("A3 DIGEST >>>\n" + digest.text + "\n<<<");
    expect(digest.text).toContain("Physics: study target “Projectile motion feels uncertain” (2 evidence points, high confidence;");
  });

  it("A4 a generic 'I finished it' fifteen days later retires the old check-in and swallows the reply", async () => {
    const item = await seed("a4", "Biology", "Cell respiration feels uncertain", "weak_area");
    const repository = new StudyCoachRepository(env.DB);
    await expect(repository.syncAndClaimDigestCheckIn({
      principalId: item.principalId, today: TODAY, weekday: 2, minuteOfDay: 450, now: NOW, signalInputs: {},
    })).resolves.toMatchObject({ courseName: "Biology" });
    const later = new Date(NOW.getTime() + 15 * 86_400_000);
    for (const text of ["I finished it", "it is done", "that is wrong", "this was wrong", "I did that", "It has been done."]) {
      expect(parseStudySignalControlIntent(text)).not.toBeNull();
    }
    const turnId = await addTurn(item.principalId, "I finished it", later);
    const fallback = new FakeModel(["Nice, I'll mark the essay draft done."]);
    const reply = await collect(new StudyCoachModelAdapter({
      fallbackModel: fallback, practiceModel: new FakeModel([]),
      repository, redactor: new Redactor(), ownerPrincipalId: item.principalId,
      ownerTurnAuthoritative: true, timeZone: "America/Toronto", now: () => later,
    }).stream(Object.freeze({
      correlationId: turnId, principalId: item.principalId, channel: "telegram" as const,
      userText: "I finished it", context: Object.freeze([]), reasoningEffort: "low" as const,
      firstTokenTimeoutMs: 1_000, timeoutMs: 5_000, contextTokenBudget: 1_000, maxOutputCharacters: 4_000,
      signal: new AbortController().signal,
    })));
    console.log("A4 reply:", reply);
    expect(reply).toBe("Retired 1 cited study-coach signal as handled.");
    expect(fallback.inputs).toHaveLength(0);
  });

  it("A5 raw points without a scale: 10/10 is 'low', and 45/50 then 9/10 is a 'falling grade'", () => {
    const courseId = "01k3w1t4000000000000000900" as Ulid;
    const snapshot: StudyCoachSnapshot = {
      principalId: "p", preference: { enabled: true, allowedDaysMask: 127, quietStartMinute: 1320, quietEndMinute: 420 },
      activeQuiz: null,
      courses: [{ courseId, name: "English", facts: [], topics: [] }],
    };
    const grade = (id: string, value: number, changed: string) => ({
      observationId: id as Ulid, deadlineId: `d-${id}`, course: "English", title: "t", assignedGrade: value,
      source: "google_classroom_api" as const, contentChangedAt: changed, lastSeenAt: NOW.toISOString(),
      sourceLastSuccessAt: NOW.toISOString(), sourceLastFailure: null,
    });
    const signals = deriveStudySignals(snapshot, {
      observations: {
        grades: [
          grade("01k3w1t4000000000000000901", 10, "2026-09-14T00:00:00.000Z"),
          grade("01k3w1t4000000000000000902", 45, "2026-09-10T00:00:00.000Z"),
        ],
        missingWork: [],
      },
    }, NOW);
    console.log("A5 signals", JSON.stringify(signals.map((s) => ({ score: s.score, conf: s.confidence, cites: s.citations.map((c) => c.detail) }))));
    expect(signals.some((s) => s.citations.length === 2 && s.score === 84)).toBe(true); // "falling": 45 -> 10
    expect(signals.some((s) => s.citations.length === 1 && s.citations[0]!.detail.includes("grade 10.") && s.score === 72)).toBe(true);
    const pick = chooseStudyCheckIn(signals);
    console.log("A5 pick", JSON.stringify({ topic: pick?.topic, count: pick?.evidenceCount, confidence: pick?.confidence }));
  });

  it("A6 24 stale-open past deadlines crowd out a deadline due in two hours", async () => {
    const item = await seed("a6", "History", "Essay due", "due_work");
    const deadlines = new DeadlineRepository(env.DB);
    const sourceId = "adv73-classroom-a6";
    await deadlines.createSource({ sourceId, kind: "classroom", label: "Classroom", now: NOW });
    await deadlines.recordSourceSuccess(sourceId, NOW);
    for (let index = 0; index < 24; index += 1) {
      await deadlines.upsert({
        sourceId, externalId: `hist:old-${index}`, course: "History", title: `Old ${index}`,
        dueAt: new Date(NOW.getTime() - (13 - index / 4) * 86_400_000).toISOString(),
        effort: "other", leadMinutes: 60, now: NOW,
      });
    }
    const soon = await deadlines.upsert({
      sourceId, externalId: "hist:soon", course: "History", title: "Due soon",
      dueAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), effort: "essay", leadMinutes: 60, now: NOW,
    });
    const candidates = await deadlines.listStudyCandidates(NOW);
    expect(candidates).toHaveLength(24);
    expect(candidates.some((c) => c.deadline.deadlineId === soon.deadline.deadlineId)).toBe(false);
    void item;
  });
  it('A4b with no check-in ever claimed, "that is wrong" still gets a canned study-coach reply', async () => {
    const item = await seed('a4b', 'Art', 'Perspective drawing due', 'due_work');
    const turnId = await addTurn(item.principalId, 'that is wrong', NOW);
    const fallback = new FakeModel(['You are right, I misread your calendar.']);
    const reply = await collect(new StudyCoachModelAdapter({
      fallbackModel: fallback, practiceModel: new FakeModel([]),
      repository: new StudyCoachRepository(env.DB), redactor: new Redactor(), ownerPrincipalId: item.principalId,
      ownerTurnAuthoritative: true, timeZone: 'America/Toronto', now: () => NOW,
    }).stream(Object.freeze({
      correlationId: turnId, principalId: item.principalId, channel: 'telegram' as const,
      userText: 'that is wrong', context: Object.freeze([]), reasoningEffort: 'low' as const,
      firstTokenTimeoutMs: 1_000, timeoutMs: 5_000, contextTokenBudget: 1_000, maxOutputCharacters: 4_000,
      signal: new AbortController().signal,
    })));
    console.log('A4b reply:', reply);
    expect(reply).toBe("I couldn't identify an active cited signal to retire.");
    expect(fallback.inputs).toHaveLength(0);
  });
});
