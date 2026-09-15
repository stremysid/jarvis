import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import type { SchoolCatchupSnapshot } from "../../src/school/school-catchup-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan } from "../../src/university/university-tracker-model.js";
import type { UniversityTrackerSnapshot } from "../../src/university/university-tracker-types.js";

const TURN = "01k5fb9pg00000000000000d00" as Ulid;
const PROGRAM = "01k5fb9pg00000000000000d01" as Ulid;
const ITEM = "01k5fb9pg00000000000000d02" as Ulid;
const NOW = new Date("2026-09-15T19:00:00.000Z");

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];

  constructor(private readonly responses: readonly string[]) {}

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    const response = this.responses[this.requests.length - 1] ?? "";
    return (async function* () { yield Object.freeze({ index: 0, text: response }); })();
  }
}

function input(principalId: string, text: string): ModelAdapterStreamInput {
  return {
    correlationId: TURN,
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

function schoolSnapshot(principalId: string): SchoolCatchupSnapshot {
  return { principalId, courses: [] };
}

function universitySnapshot(principalId: string): UniversityTrackerSnapshot {
  return {
    principalId,
    programs: [{
      programId: PROGRAM,
      university: "University of Waterloo",
      campus: null,
      programName: "Computer Science",
      ouacCode: null,
      verification: { state: "unverified", sourceUrl: null, cycle: "2027", verifiedAt: null },
      requirements: [],
      dates: [],
      applicationItems: [{
        itemId: ITEM,
        kind: "supplementary_application",
        label: "Waterloo AIF",
        status: "drafting",
        dueDate: null,
        verification: { state: "unverified", sourceUrl: null, cycle: "2027", verifiedAt: null },
        submittedAt: null,
        updatedAt: NOW.toISOString(),
      }],
    }],
  };
}

function readyResponse(): string {
  return JSON.stringify({
    schoolEngaged: false,
    universityEngaged: true,
    reply: "I marked your Waterloo AIF draft ready. Its due date is still unverified.",
    courseUpdates: [],
    completeActionIds: [],
    plan: [],
    programUpdates: [],
    applicationUpdates: [{
      itemRef: ITEM,
      programRef: PROGRAM,
      kind: null,
      label: null,
      status: "ready",
      statusEvidence: "I finished my Waterloo AIF draft",
      dueDate: null,
    }],
  });
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

describe("university application conversation model", () => {
  it("turns plain progress speech into a ready checklist update", async () => {
    const principalId = "principal:application-model-owner";
    const model = new SequenceModel([readyResponse()]);
    const applyOwnerPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => universitySnapshot(principalId),
        applyOwnerPlan,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });

    await expect(collect(adapter.stream(input(principalId, "I finished my Waterloo AIF draft"))))
      .resolves.toContain("due date is still unverified");
    expect(model.requests[0]?.userText).toContain("applicationUpdates");
    expect(model.requests[0]?.userText).toContain("university_state_json=");
    expect(applyOwnerPlan).toHaveBeenCalledWith(expect.objectContaining({
      principalId,
      plan: expect.objectContaining({
        applicationUpdates: [expect.objectContaining({ status: "ready", statusEvidence: "I finished my Waterloo AIF draft" })],
      }),
    }));
  });

  it("accepts a plain request to add an unverified scholarship without inventing a date", () => {
    const text = "Add the Schulich scholarship for Queen's.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1",
        programRef: PROGRAM,
        kind: "scholarship",
        label: "Schulich scholarship",
        status: "not_started",
        statusEvidence: text,
        dueDate: {
          date: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor())).toMatchObject({
      applicationUpdates: [{ kind: "scholarship", dueDate: { date: null, verification: { state: "unverified" } } }],
    });
  });

  it("refuses application evidence that is not an exact excerpt of the current owner message", () => {
    const text = "Add the Schulich scholarship for Queen's.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1",
        programRef: PROGRAM,
        kind: "scholarship",
        label: "Schulich scholarship",
        status: "not_started",
        statusEvidence: text,
        dueDate: {
          date: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          evidence: "The deadline is January 15, 2027.",
        },
      }],
    }, text, new Redactor())).toThrow("university_application_model_date_invalid");
  });

  it("refuses an application date when its current-message evidence does not contain that date", () => {
    const text = "Add the Schulich scholarship for Queen's.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1",
        programRef: PROGRAM,
        kind: "scholarship",
        label: "Schulich scholarship",
        status: "not_started",
        statusEvidence: text,
        dueDate: {
          date: "2027-01-15",
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor())).toThrow("university_application_model_date_invalid");
  });

  it("refuses submitted-by-Sid unless the current owner message explicitly says Sid submitted it", () => {
    const text = "When is my Waterloo AIF submitted?";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM,
        programRef: PROGRAM,
        kind: null,
        label: null,
        status: "submitted_by_sid",
        statusEvidence: text,
        dueDate: null,
      }],
    }, text, new Redactor())).toThrow("university_application_model_item_invalid");
  });

  it("accepts submitted-by-Sid when the whole current owner message explicitly reports it", () => {
    const text = "I submitted my Waterloo AIF.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM,
        programRef: PROGRAM,
        kind: null,
        label: null,
        status: "submitted_by_sid",
        statusEvidence: text,
        dueDate: null,
      }],
    }, text, new Redactor())).toMatchObject({
      applicationUpdates: [{ status: "submitted_by_sid", statusEvidence: text }],
    });
  });

  it("requires the whole current owner message for a submitted-by-Sid update", () => {
    const text = "I submitted my Waterloo AIF. Please show me what is next.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM,
        programRef: PROGRAM,
        kind: null,
        label: null,
        status: "submitted_by_sid",
        statusEvidence: "I submitted my Waterloo AIF.",
        dueDate: null,
      }],
    }, text, new Redactor())).toThrow("university_application_model_item_invalid");
  });

  it("refuses a submitted claim inside a negated owner message", () => {
    const text = "I don't think I submitted my Waterloo AIF.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM,
        programRef: PROGRAM,
        kind: null,
        label: null,
        status: "submitted_by_sid",
        statusEvidence: text,
        dueDate: null,
      }],
    }, text, new Redactor())).toThrow("university_application_model_item_invalid");
  });

  it("does not apply application mutations outside the configured owner's turn and guards fallback action claims", async () => {
    const principalId = "principal:application-model-other";
    const model = new SequenceModel([readyResponse(), "I've uploaded the application for you."]);
    const applyOwnerPlan = vi.fn(async () => undefined);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => universitySnapshot(principalId),
        applyOwnerPlan,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: "principal:configured-owner",
    });

    await expect(collect(adapter.stream(input(principalId, "I finished my Waterloo AIF draft")))).resolves.toBe(
      "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.",
    );
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it("guards external-action claims when an owner application update cannot be saved", async () => {
    const principalId = "principal:application-model-save-failure";
    const model = new SequenceModel([readyResponse(), "I've uploaded the application for you."]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => universitySnapshot(principalId),
        applyOwnerPlan: async () => { throw new Error("database unavailable"); },
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });

    const reply = await collect(adapter.stream(input(principalId, "I finished my Waterloo AIF draft")));
    expect(reply).toContain(
      "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.",
    );
    expect(reply).toContain("I couldn't update your university tracker.");
  });
});
