import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import type { SchoolCatchupSnapshot } from "../../src/school/school-catchup-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan } from "../../src/university/university-tracker-model.js";
import type { UniversityTrackerSnapshot } from "../../src/university/university-tracker-types.js";

const TURN = "01k5fb9pg00000000000000a00" as Ulid;
const NOW = new Date("2026-09-15T15:30:00.000Z");
const SOURCE = "https://uwaterloo.ca/future-students/programs/computer-science";

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];

  constructor(private readonly responses: readonly string[]) {}

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    const response = this.responses[this.requests.length - 1] ?? "";
    return (async function* () {
      yield Object.freeze({ index: 0, text: response });
    })();
  }
}

function modelInput(userText: string): ModelAdapterStreamInput {
  return {
    correlationId: TURN,
    principalId: "principal:university-model",
    channel: "telegram",
    userText,
    context: [],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 40_000,
    timeoutMs: 90_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 8_000,
    signal: new AbortController().signal,
  };
}

function schoolSnapshot(): SchoolCatchupSnapshot {
  return { principalId: "principal:university-model", courses: [] };
}

function universitySnapshot(): UniversityTrackerSnapshot {
  return { principalId: "principal:university-model", programs: [] };
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

function verifiedResponse(): string {
  return JSON.stringify({
    schoolEngaged: false,
    universityEngaged: true,
    reply: "Verified for the 2027 cycle: Waterloo Computer Science lists the cited courses and January 15 date. Which other program are you considering?",
    courseUpdates: [],
    completeActionIds: [],
    plan: [],
    programUpdates: [{
      programRef: "new-1",
      university: "University of Waterloo",
      campus: null,
      programName: "Computer Science",
      ouacCode: "WCS",
      verification: { state: "verified", sourceUrl: SOURCE, cycle: "2027" },
      addRequirements: [{
        label: "Required courses",
        detail: "Advanced Functions, Calculus and Vectors, and English",
        verification: { state: "verified", sourceUrl: SOURCE, cycle: "2027" },
      }],
      addDates: [{
        label: "Application deadline",
        date: "2027-01-15",
        verification: { state: "verified", sourceUrl: SOURCE, cycle: "2027" },
      }],
      resolveItemIds: [],
    }],
    applicationUpdates: [],
    workflowUpdates: [],
  });
}

describe("university conversation model", () => {
  it("learns a sourced program through one ordinary Telegram model turn", async () => {
    const userText = `For the 2027 cycle, add Waterloo Computer Science from ${SOURCE}. It lists Advanced Functions, Calculus and English, with a January 15, 2027 deadline.`;
    const model = new SequenceModel([verifiedResponse()]);
    const applySchoolPlan = vi.fn(async () => undefined);
    const applyUniversityPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(), applyOwnerPlan: applySchoolPlan },
      universityRepository: { readSnapshot: async () => universitySnapshot(), applyOwnerPlan: applyUniversityPlan },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(modelInput(userText)))).resolves.toContain("Verified for the 2027 cycle");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.userText).toContain("ordinary conversation, not a form and not a command interface");
    expect(model.requests[0]?.userText).toContain("university_state_json=");
    expect(model.requests[0]?.context).toEqual([]);
    expect(applySchoolPlan).not.toHaveBeenCalled();
    expect(applyUniversityPlan).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "principal:university-model",
      turnId: TURN,
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      plan: expect.objectContaining({ engaged: true }),
    }));
  });

  it("refuses to mark a source verified unless the current owner message supplies its exact URL and cycle", () => {
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [{
        programRef: "new-1",
        university: "University of Waterloo",
        campus: null,
        programName: "Computer Science",
        ouacCode: null,
        verification: { state: "verified", sourceUrl: SOURCE, cycle: "2027" },
        addRequirements: [],
        addDates: [],
        resolveItemIds: [],
      }],
      applicationUpdates: [],
    }, "I might apply to Waterloo Computer Science.", new Redactor())).toThrow(
      "university_tracker_model_verification_invalid",
    );
  });

  it("falls back without claiming a university save when persistence rejects the plan", async () => {
    const userText = `For the 2027 cycle, add Waterloo Computer Science from ${SOURCE}.`;
    const model = new SequenceModel([verifiedResponse(), "I saved your university tracker."]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => universitySnapshot(),
        applyOwnerPlan: async () => { throw new Error("private D1 detail"); },
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });

    await expect(collect(adapter.stream(modelInput(userText)))).resolves.toBe(
      "I can still help with the university planning in your message.\n\nI couldn't update your university tracker.",
    );
  });
});
