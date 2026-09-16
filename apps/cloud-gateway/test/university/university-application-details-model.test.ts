import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import {
  isUniversityExecutionRequest,
  SchoolCatchupModelAdapter,
} from "../../src/school/school-catchup-model.js";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan } from "../../src/university/university-tracker-model.js";
import type { UniversityTrackerSnapshot } from "../../src/university/university-tracker-types.js";

const TURN = "01k5j000000000000000000001" as Ulid;
const PROGRAM = "01k5j000000000000000000002" as Ulid;
const APPLICATION = "01k5j000000000000000000003" as Ulid;
const WORKFLOW = "01k5j000000000000000000004" as Ulid;
const EVENT = "01k5j000000000000000000005" as Ulid;
const NOW = new Date("2026-09-16T15:00:00.000Z");

function snapshot(withWorkflow = false): UniversityTrackerSnapshot {
  return {
    principalId: "principal:workflow-model",
    programs: [{
      programId: PROGRAM,
      university: "Western University",
      campus: null,
      programName: "Medical Sciences",
      ouacCode: null,
      verification: { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null },
      requirements: [],
      dates: [],
      applicationItems: [{
        itemId: APPLICATION,
        kind: "reference",
        label: "Western reference",
        status: "drafting",
        dueDate: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null },
        sourceTurnId: TURN,
        submittedAt: null,
        updatedAt: NOW.toISOString(),
      }],
      workflowItems: withWorkflow ? [{
        workflowId: WORKFLOW,
        eventId: EVENT,
        revision: 1,
        applicationItemId: APPLICATION,
        kind: "contact_step",
        label: "Ms Chen reference request",
        owner: "sid",
        status: "prepared",
        preparedDetails: "Review the draft, then Sid sends it.",
        executionBoundary: "owner_only",
        deadline: {
          date: null,
          instant: null,
          timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null },
        },
        sourceTurnId: TURN,
        updatedAt: NOW.toISOString(),
      }] : [],
    }],
  };
}

function workflowUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowRef: "new-workflow-1",
    programRef: PROGRAM,
    applicationItemRef: APPLICATION,
    kind: "contact_step",
    label: "Ms Chen reference request",
    owner: "sid",
    status: "prepared",
    statusEvidence: "Draft the Ms Chen reference request for the Western reference.",
    preparedDetails: "Sid reviews this draft and sends it himself.",
    deadline: {
      date: null,
      instant: null,
      timeZone: null,
      verification: { state: "unverified", sourceUrl: null, cycle: null },
      evidence: "Draft the Ms Chen reference request for the Western reference.",
    },
    executionBoundary: "owner_only",
    ...overrides,
  };
}

function parseWorkflow(text: string, update: Record<string, unknown>, current = snapshot()): unknown {
  return parseOwnerUniversityPlan({
    engaged: true,
    programUpdates: [],
    applicationUpdates: [],
    workflowUpdates: [update],
  }, text, new Redactor(), current);
}

class CountingModel implements ModelAdapter {
  readonly stream = vi.fn((_input: ModelAdapterStreamInput): AsyncIterable<ModelToken> =>
    (async function* () { yield Object.freeze({ index: 0, text: "model should not run" }); })());
}

function input(text: string): ModelAdapterStreamInput {
  return {
    correlationId: TURN,
    principalId: "principal:workflow-model",
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

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

describe("university application detail model", () => {
  it("records a preparation step only when one clause names the workflow and application item", () => {
    const text = "Draft the Ms Chen reference request for the Western reference.";
    expect(parseWorkflow(text, workflowUpdate())).toMatchObject({
      workflowUpdates: [{
        kind: "contact_step",
        status: "prepared",
        executionBoundary: "owner_only",
        deadline: { verification: { state: "unverified" } },
      }],
    });
  });

  it("refuses a preparation status whose named workflow and application item are split across clauses", () => {
    const text = "Draft the Ms Chen reference request. The Western reference is next.";
    expect(() => parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toThrow("university_workflow_model_item_invalid");
  });

  it("accepts only Sid's direct report that he completed the named contact step", () => {
    const text = "I emailed Ms Chen for the Ms Chen reference request covering the Western reference.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW,
      applicationItemRef: null,
      kind: null,
      label: null,
      owner: null,
      status: "owner_reported_done",
      statusEvidence: text,
      preparedDetails: null,
      deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it.each([
    "Ms Chen said I emailed her for the Ms Chen reference request covering the Western reference.",
    "I asked you to draft the Ms Chen reference request for the Western reference.",
  ])("refuses ambiguous or reported contact completion: %s", (text) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW,
      applicationItemRef: null,
      kind: null,
      label: null,
      owner: null,
      status: "owner_reported_done",
      statusEvidence: text,
      preparedDetails: null,
      deadline: null,
    }), snapshot(true))).toThrow("university_workflow_model_item_invalid");
  });

  it("records an offer only from Sid's direct statement", () => {
    const text = "I received a Western offer.";
    expect(parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western offer",
      owner: "university",
      status: "owner_reported_offered",
      statusEvidence: text,
      preparedDetails: null,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_offered" }] });
  });

  it("refuses an offer relayed by another person", () => {
    const text = "My counsellor said I received a Western offer.";
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western offer",
      owner: "university",
      status: "owner_reported_offered",
      statusEvidence: text,
      preparedDetails: null,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toThrow("university_workflow_model_item_invalid");
  });

  it("refuses fee amounts in generated preparation details", () => {
    expect(() => parseWorkflow(
      "Draft the Ms Chen reference request for the Western reference.",
      workflowUpdate({ preparedDetails: "Pay $100 and then send the request." }),
    )).toThrow("university_workflow_model_item_invalid");
  });

  it("requires the owner-only execution boundary", () => {
    expect(() => parseWorkflow(
      "Draft the Ms Chen reference request for the Western reference.",
      workflowUpdate({ executionBoundary: "jarvis_executes" }),
    )).toThrow("university_workflow_model_item_invalid");
  });

  it("keeps a timed deadline unverified while preserving its exact instant and timezone", () => {
    const text = "Draft the Ms Chen reference request for the Western reference due 2027-01-15T22:00:00.000Z America/Toronto.";
    expect(parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: null,
        instant: "2027-01-15T22:00:00.000Z",
        timeZone: "America/Toronto",
        verification: { state: "unverified", sourceUrl: null, cycle: null },
        evidence: text,
      },
    }))).toMatchObject({
      workflowUpdates: [{ deadline: {
        instant: "2027-01-15T22:00:00.000Z",
        timeZone: "America/Toronto",
        verification: { state: "unverified" },
      } }],
    });
  });

  it("refuses a syntactically plausible timezone that is not in the runtime timezone database", () => {
    const text = "Draft the Ms Chen reference request for the Western reference due 2027-01-15T22:00:00.000Z Mars/Olympus.";
    expect(() => parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: null,
        instant: "2027-01-15T22:00:00.000Z",
        timeZone: "Mars/Olympus",
        verification: { state: "unverified", sourceUrl: null, cycle: null },
        evidence: text,
      },
    }))).toThrow("university_workflow_model_deadline_invalid");
  });

  it.each([
    "Can you submit my Western application?",
    "Please upload my Western essay.",
    "Email my teacher about the Western reference.",
    "Ask my teacher for the Western reference.",
    "Accept my Western offer.",
    "Order my transcript.",
    "Can you review the Western essay and then submit it?",
    "Draft the Western essay, then upload it.",
    "Go ahead and decline my Western offer.",
  ])("refuses execution in code before invoking the model: %s", async (text) => {
    expect(isUniversityExecutionRequest(text)).toBe(true);
    const model = new CountingModel();
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => ({ principalId: "principal:workflow-model", courses: [] }),
        applyOwnerPlan: async () => undefined },
      universityRepository: { readSnapshot: async () => snapshot(), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      ownerPrincipalId: "principal:workflow-model",
      now: () => NOW,
    });
    await expect(collect(adapter.stream(input(text)))).resolves.toContain("you must send, upload, submit, pay");
    expect(model.stream).not.toHaveBeenCalled();
  });

  it.each([
    "Help me submit my Western application.",
    "Draft an email to my teacher about the Western reference.",
    "Give me a checklist for accepting my Western offer.",
  ])("keeps preparation requests available to the model: %s", (text) => {
    expect(isUniversityExecutionRequest(text)).toBe(false);
  });
});
