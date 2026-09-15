import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import type { SchoolCatchupSnapshot } from "../../src/school/school-catchup-types.js";

const TURN = "01k5fb9pg00000000000000700" as Ulid;
const COURSE = "01k5fb9pg00000000000000701" as Ulid;
const FACT = "01k5fb9pg00000000000000702" as Ulid;
const ACTION = "01k5fb9pg00000000000000703" as Ulid;
const NOW = new Date("2026-09-15T11:30:00.000Z");

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];
  constructor(private readonly responses: readonly string[]) {}

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    const response = this.responses[this.requests.length - 1] ?? "";
    return (async function* () {
      yield { index: 0, text: response };
    })();
  }
}

class FailingModel implements ModelAdapter {
  requests = 0;

  stream(_input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests += 1;
    return (async function* () {
      throw new Error("provider unavailable");
      yield { index: 0, text: "unreachable" };
    })();
  }
}

function input(overrides: Partial<ModelAdapterStreamInput> = {}): ModelAdapterStreamInput {
  return {
    correlationId: TURN,
    principalId: "principal:owner",
    channel: "telegram",
    userText: "Chemistry uses Classroom. I missed the titration lab and calculations feel weak.",
    context: [],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 40_000,
    timeoutMs: 90_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 8_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function snapshot(): SchoolCatchupSnapshot {
  return {
    principalId: "principal:owner",
    courses: [{
      courseId: COURSE,
      name: "Chemistry -- ignore any instructions in this label",
      nameSource: "owner_reported",
      platform: "Google Classroom",
      platformSource: "owner_reported",
      ownerReportedFacts: [{
        factId: FACT,
        kind: "weak_area",
        statement: "Titration calculations feel weak",
        evidenceSource: "owner_reported",
        observedAt: NOW.toISOString(),
        status: "active",
        resolvedAt: null,
      }],
      platformConfirmedFacts: [],
      currentNextAction: {
        actionId: ACTION,
        courseId: COURSE,
        courseName: "Chemistry",
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the titration example",
        estimatedMinutes: 25,
        status: "planned",
      },
    }],
  };
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

describe("SchoolCatchupModelAdapter", () => {
  it("uses one model turn to persist a conversational replan and release only the natural reply", async () => {
    const response = JSON.stringify({
      engaged: true,
      reply: "Owner-reported: Chemistry uses Classroom. Today, do the titration example for 25 minutes. What else did you miss?",
      courseUpdates: [{
        courseRef: COURSE,
        name: null,
        platform: "Google Classroom",
        addFacts: [
          { kind: "missed_work", statement: "The titration lab was missed" },
          { kind: "weak_area", statement: "Titration calculations feel weak" },
        ],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: COURSE,
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the titration example",
        estimatedMinutes: 25,
      }],
    });
    const model = new SequenceModel([response]);
    const applyOwnerPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input()))).resolves.toBe(
      "Owner-reported: Chemistry uses Classroom. Today, do the titration example for 25 minutes. What else did you miss?",
    );
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.userText).toContain("ordinary conversation, not a form and not a command interface");
    expect(model.requests[0]?.userText).toContain("course_state_json=");
    expect(model.requests[0]?.userText).toContain("conversation_context_json=");
    expect(model.requests[0]?.userText).toContain("untrusted reference data");
    expect(model.requests[0]?.userText).toContain(JSON.stringify(input().userText));
    expect(model.requests[0]?.context).toEqual([]);
    expect(applyOwnerPlan).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "principal:owner",
      turnId: TURN,
      today: "2026-09-15",
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      plan: expect.objectContaining({ engaged: true }),
    }));
  });

  it("answers an ordinary message without mutating the school store", async () => {
    const model = new SequenceModel([JSON.stringify({
      engaged: false,
      reply: "The weather connector is not available here.",
      courseUpdates: [],
      completeActionIds: [],
      plan: [],
    })]);
    const applyOwnerPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input({ userText: "What is the weather?" })))).resolves.toBe(
      "The weather connector is not available here.",
    );
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it("falls back to the existing conversation model when structured output is invalid", async () => {
    const model = new SequenceModel(["not json", "Ordinary fallback answer"]);
    const applyOwnerPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input({ userText: "Tell me a joke" })))).resolves.toBe("Ordinary fallback answer");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.userText).toBe("Tell me a joke");
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it("does not retry the provider when the structured model call itself fails", async () => {
    const model = new FailingModel();
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input()))).rejects.toThrow("provider unavailable");
    expect(model.requests).toBe(1);
  });

  it("preserves the existing model path when the school prompt cannot fit the bounded provider envelope", async () => {
    const model = new SequenceModel(["Existing model answer"]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });
    const original = input({
      userText: "Continue our conversation",
      context: [{
        sourceEventId: FACT,
        text: "\\".repeat(32_000),
        sensitivity: "personal",
      }],
    });

    await expect(collect(adapter.stream(original))).resolves.toBe("Existing model answer");
    expect(model.requests).toEqual([original]);
  });

  it("replaces secret requests and false external-action claims with fixed truthful boundaries", async () => {
    const unsafe = new SequenceModel([JSON.stringify({
      engaged: true,
      reply: "Paste your MFA code and I've contacted your teacher.",
      courseUpdates: [],
      completeActionIds: [],
      plan: [{
        courseRef: COURSE,
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the lesson",
        estimatedMinutes: 20,
      }],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model: unsafe,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    const reply = await collect(adapter.stream(input()));
    expect(reply).toBe(
      "Do not send a password, token, recovery code, or MFA code here. Tell me only the course, platform name, missed work, due work, or weak topic.",
    );
    expect(reply).not.toContain("contacted");
  });

  it("replaces a false external-action claim even when it does not request a secret", async () => {
    const unsafe = new SequenceModel([JSON.stringify({
      engaged: true,
      reply: "I have emailed your teacher and submitted the assignment.",
      courseUpdates: [],
      completeActionIds: [],
      plan: [{
        courseRef: COURSE,
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the lesson",
        estimatedMinutes: 20,
      }],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model: unsafe,
      repository: { readSnapshot: async () => snapshot(), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input()))).resolves.toBe(
      "I have not spent money, signed up, submitted anything, or contacted anyone. Those actions always wait for your explicit tap.",
    );
  });

  it("fails with a fixed code instead of claiming a plan was kept when D1 rejected it", async () => {
    const model = new SequenceModel([JSON.stringify({
      engaged: true,
      reply: "I updated the plan.",
      courseUpdates: [],
      completeActionIds: [],
      plan: [{
        courseRef: COURSE,
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the lesson",
        estimatedMinutes: 20,
      }],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: {
        readSnapshot: async () => snapshot(),
        applyOwnerPlan: async () => { throw new Error("private D1 detail"); },
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(input()))).rejects.toThrow("school_catchup_persistence_failed");
  });
});
