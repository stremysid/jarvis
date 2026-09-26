import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import {
  SchoolCatchupModelAdapter,
} from "../../src/school/school-catchup-model.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  isWorkflowLabelSafe,
  parseOwnerUniversityPlan,
  supportsWorkflowStatusEvidence,
  universityStateJson,
} from "../../src/university/university-tracker-model.js";
import type {
  ApplyOwnerUniversityPlanInput,
  UniversityTrackerSnapshot,
} from "../../src/university/university-tracker-types.js";

const TURN = "01k5j000000000000000000001" as Ulid;
const PROGRAM = "01k5j000000000000000000002" as Ulid;
const APPLICATION = "01k5j000000000000000000003" as Ulid;
const WORKFLOW = "01k5j000000000000000000004" as Ulid;
const EVENT = "01k5j000000000000000000005" as Ulid;
const WATERLOO = "01k5j000000000000000000006" as Ulid;
const WATERLOO_APPLICATION = "01k5j000000000000000000007" as Ulid;
const SECOND_WORKFLOW = "01k5j000000000000000000008" as Ulid;
const SECOND_EVENT = "01k5j000000000000000000009" as Ulid;
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

function decisionSnapshot(sharedProgramName = false): UniversityTrackerSnapshot {
  const western = snapshot().programs[0]!;
  return {
    principalId: "principal:workflow-model",
    programs: [{
      ...western,
      programName: sharedProgramName ? "Computer Science" : "Medical Sciences",
      applicationItems: [],
      workflowItems: [],
    }, {
      ...western,
      programId: WATERLOO,
      university: "University of Waterloo",
      programName: "Computer Science",
      applicationItems: [{
        ...western.applicationItems[0]!,
        itemId: WATERLOO_APPLICATION,
        label: "Waterloo AIF",
        kind: "supplementary_application",
      }],
      workflowItems: [],
    }],
  };
}

function snapshotWithTwoWorkflows(): UniversityTrackerSnapshot {
  const current = snapshot(true);
  const program = current.programs[0]!;
  const first = program.workflowItems?.[0];
  if (first === undefined) throw new Error("workflow fixture missing");
  return {
    ...current,
    programs: [{
      ...program,
      workflowItems: [first, {
        ...first,
        workflowId: SECOND_WORKFLOW,
        eventId: SECOND_EVENT,
        label: "Western upload step",
        kind: "upload_step",
      }],
    }],
  };
}

function reviewerStepSnapshot(): UniversityTrackerSnapshot {
  const current = decisionSnapshot();
  return {
    ...current,
    programs: current.programs.map((program) => {
      if (program.programId === PROGRAM) {
        return {
          ...program,
          applicationItems: snapshot().programs[0]!.applicationItems,
          workflowItems: [{
            ...snapshot(true).programs[0]!.workflowItems![0]!,
            label: "Ms Lee reference request",
          }],
        };
      }
      return {
        ...program,
        workflowItems: [{
          workflowId: SECOND_WORKFLOW,
          eventId: SECOND_EVENT,
          revision: 1,
          applicationItemId: WATERLOO_APPLICATION,
          kind: "payment_step",
          label: "Waterloo AIF",
          owner: "sid",
          status: "prepared",
          preparedDetails: null,
          executionBoundary: "owner_only",
          deadline: {
            date: null,
            instant: null,
            timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null },
          },
          sourceTurnId: TURN,
          updatedAt: NOW.toISOString(),
        }],
      };
    }),
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

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];

  constructor(private readonly responses: readonly string[]) {}

  stream(request: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1] ?? "";
    return (async function* () { yield Object.freeze({ index: 0, text: response }); })();
  }
}

function combinedResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schoolEngaged: false,
    universityEngaged: false,
    reply: "Model reached.",
    courseUpdates: [],
    completeActionIds: [],
    plan: [],
    programUpdates: [],
    applicationUpdates: [],
    workflowUpdates: [],
    ...overrides,
  });
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

function adapterWith(
  model: ModelAdapter,
  current: UniversityTrackerSnapshot = snapshot(),
  applyOwnerPlan: (input: ApplyOwnerUniversityPlanInput) => Promise<void> = async () => undefined,
): SchoolCatchupModelAdapter {
  return new SchoolCatchupModelAdapter({
    model,
    repository: {
      readSnapshot: async () => ({ principalId: current.principalId, courses: [] }),
      applyOwnerPlan: async () => undefined,
    },
    universityRepository: { readSnapshot: async () => current, applyOwnerPlan },
    redactor: new Redactor(),
    timeZone: "America/Toronto",
    ownerPrincipalId: current.principalId,
    now: () => NOW,
  });
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

  it("accepts the model's prepared status; the split-clause deadline is what the retained deadline rule refuses", () => {
    const text = "Draft the Ms Chen reference request. The Western reference is next.";
    expect(() => parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toThrow("university_workflow_model_deadline_invalid");
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
  ])("accepts the model's declared contact completion even in reported or indirect wording: %s", (text) => {
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
    ["I paid the Waterloo AIF fee for the Waterloo AIF.", SECOND_WORKFLOW, WATERLOO],
    ["I paid the Waterloo AIF fee for the Waterloo AIF with my mom's card.", SECOND_WORKFLOW, WATERLOO],
    ["I emailed Ms Lee about the Ms Lee reference request for the Western reference.", WORKFLOW, PROGRAM],
    ["I asked Ms. Lee about the Ms Lee reference request for the Western reference.", WORKFLOW, PROGRAM],
    ["I emailed Ms. Lee about the Ms Lee reference request for the Western reference.", WORKFLOW, PROGRAM],
  ] as const)("accepts the reviewer M2 direct completion probe: %s", (text, workflowRef, programRef) => {
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef,
      programRef,
      applicationItemRef: null,
      kind: null,
      label: null,
      owner: null,
      status: "owner_reported_done",
      statusEvidence: text,
      preparedDetails: null,
      deadline: null,
    }), reviewerStepSnapshot())).toMatchObject({ workflowUpdates: [{ workflowRef, status: "owner_reported_done" }] });
  });

  it.each([
    "I'm sure I paid the Waterloo AIF fee for the Waterloo AIF.",
    "I asked my mom to email Ms Lee about the Ms Lee reference request for the Western reference.",
    "I asked Ms Lee's assistant about the Ms Lee reference request for the Western reference.",
  ])("accepts the model's declared completion for the reviewer M2 indirect or uncertain probe: %s", (text) => {
    const payment = text.includes("paid");
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: payment ? SECOND_WORKFLOW : WORKFLOW,
      programRef: payment ? WATERLOO : PROGRAM,
      applicationItemRef: null,
      kind: null,
      label: null,
      owner: null,
      status: "owner_reported_done",
      statusEvidence: text,
      preparedDetails: null,
      deadline: null,
    }), reviewerStepSnapshot())).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("records an offer only from Sid's one explicit sentence, with a fixed label and owner", () => {
    const text = "I received an offer from Western University for Medical Sciences.";
    expect(parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western Medical Sciences offer (confirmed, reply by June 1)",
      owner: "sid",
      status: "owner_reported_offered",
      statusEvidence: text,
      preparedDetails: null,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toMatchObject({ workflowUpdates: [{
      status: "owner_reported_offered", kind: "offer", label: "offer", owner: "university",
    }] });
  });

  it("refuses an offer update that carries a deadline date or prepared text", () => {
    const text = "I got an offer from Western for Medical Sciences.";
    const offer = (overrides: Record<string, unknown>) => workflowUpdate({
      applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      ...overrides,
    });
    expect(parseWorkflow(text, offer({}))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_offered" }] });
    expect(() => parseWorkflow(text, offer({ preparedDetails: "Reply by June 1." })))
      .toThrow("university_workflow_model_item_invalid");
    expect(() => parseWorkflow(text, offer({ deadline: { date: "2027-06-01", instant: null, timeZone: null,
      verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text } })))
      .toThrow("university_workflow_model_deadline_invalid");
  });

  it.each([
    ["I got into Waterloo!!", WATERLOO],
    ["Western accepted me", PROGRAM],
    ["I got my Waterloo offer!!", WATERLOO],
    ["I got my Waterloo offer", WATERLOO],
    ["I got an offer from Waterloo!", WATERLOO],
    ["I got a Waterloo CS offer", WATERLOO],
    ["I got my Waterloo Computer Science offer", WATERLOO],
    ["I received a Western Medical Sciences offer", PROGRAM],
  ] as const)("never infers the program from a school-only or reworded offer report: %s", (text, programRef) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toThrow("university_workflow_model_item_invalid");
  });

  it("binds only the explicitly named program when one school has several tracked programs", () => {
    const current = decisionSnapshot();
    const waterloo = current.programs.find((program) => program.programId === WATERLOO)!;
    const ambiguous: UniversityTrackerSnapshot = {
      ...current,
      programs: [...current.programs, {
        ...waterloo, programId: SECOND_WORKFLOW, programName: "Software Engineering", applicationItems: [],
      }],
    };
    const update = (text: string, programRef: Ulid) => workflowUpdate({
      programRef, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    });
    const named = "I got an offer from Waterloo for Software Engineering.";
    expect(parseWorkflow(named, update(named, SECOND_WORKFLOW), ambiguous))
      .toMatchObject({ workflowUpdates: [{ programRef: SECOND_WORKFLOW }] });
    expect(() => parseWorkflow(named, update(named, WATERLOO), ambiguous)).toThrow("university_workflow_model_item_invalid");
    const missing = "I got my Waterloo offer.";
    expect(() => parseWorkflow(missing, update(missing, WATERLOO), ambiguous)).toThrow("university_workflow_model_item_invalid");

    const twoCampuses: UniversityTrackerSnapshot = {
      ...current,
      programs: [...current.programs, {
        ...waterloo, programId: SECOND_WORKFLOW, campus: "Stratford", applicationItems: [],
      }],
    };
    const sameName = "I got an offer from Waterloo for Computer Science.";
    expect(parseWorkflow(sameName, update(sameName, WATERLOO), decisionSnapshot()))
      .toMatchObject({ workflowUpdates: [{ programRef: WATERLOO }] });
    expect(() => parseWorkflow(sameName, update(sameName, WATERLOO), twoCampuses))
      .toThrow("university_workflow_model_item_invalid");
  });

  it.each([
    ["I wish I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["I dreamt I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["Imagine I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["I bet I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["I'm sure I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["I'm convinced I got rejected by Waterloo Computer Science.", "owner_reported_rejected"],
    ["Pretend I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["Ugh, I just know I got rejected by Waterloo Computer Science.", "owner_reported_rejected"],
  ] as const)("refuses an imagined or speculative decision rather than recording it: %s", (text, status) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status, statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toThrow("university_workflow_model_item_invalid");
  });

  it.each([
    "I got an offer from Waterloo for Computer Science! I hope Western is next.",
    "I got an offer from Waterloo for Computer Science, I think I'm going to cry.",
    "I got an offer from Waterloo for Computer Science with no conditions!",
    "Omg I got an offer from Waterloo for Computer Science, no way",
    "Mom cried when I told her: I got an offer from Waterloo for Computer Science.",
    "I got an offer from Waterloo for Computer Science. Actually so happy.",
    "Wait, I got an offer from Waterloo for Computer Science!",
  ])("records nothing when the explicit offer sentence has a second clause: %s", (text) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toThrow("university_workflow_model_item_invalid");
  });

  it.each([
    "I got an offer from Waterloo for Computer Science.",
    "I got an offer from University of Waterloo for Computer Science!!",
    "I got an offer for Computer Science from the University of Waterloo",
    "Jarvis, I just got a conditional offer from Waterloo for Computer Science.",
  ])("records the explicit offer sentence: %s", (text) => {
    expect(parseWorkflow(text, workflowUpdate({
      programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toMatchObject({ workflowUpdates: [{ status: "owner_reported_offered", programRef: WATERLOO }] });
  });

  it.each([
    "I got a Computer Science offer from Toronto instead of Waterloo.",
    "I got a Computer Science offer from UW instead of Western.",
  ])("refuses a contrasted school or alias instead of binding the model target: %s", (text) => {
    const programRef = text.includes("Western") ? PROGRAM : WATERLOO;
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot(true))).toThrow("university_workflow_model_item_invalid");
  });

  it("refuses an offer relayed by another person", () => {
    const text = "My counsellor said I received a Western Medical Sciences offer.";
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western Medical Sciences offer",
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

  it("pins per-clause hearsay after an otherwise direct offer claim", () => {
    const text = "I got a Waterloo Computer Science offer or so my counsellor said.";
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toThrow("university_workflow_model_item_invalid");
  });

  it("pins offer-only yet-to negation after an otherwise direct offer claim", () => {
    const text = "I got a Waterloo Computer Science offer yet to receive it.";
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), decisionSnapshot())).toThrow("university_workflow_model_item_invalid");
  });

  it("records an offer response only from the explicit accepted or declined sentence", () => {
    const supports = (status: "owner_reported_accepted" | "owner_reported_declined", text: string): boolean =>
      supportsWorkflowStatusEvidence(
        status,
        "offer_response",
        text,
        "new-workflow-1",
        "offer response",
        null,
        null,
        null,
        { university: "University of Waterloo", programName: "Computer Science" },
        null,
      );
    expect(supports("owner_reported_accepted", "I accepted my offer from Waterloo for Computer Science.")).toBe(true);
    expect(supports("owner_reported_declined", "I declined the offer from University of Waterloo for Computer Science.")).toBe(true);
    expect(supports("owner_reported_accepted", "I accepted the Waterloo response offer.")).toBe(false);
    expect(supports("owner_reported_accepted", "I accepted the Waterloo response.")).toBe(false);
    expect(supports("owner_reported_accepted", "I declined my offer from Waterloo for Computer Science.")).toBe(false);
    expect(supports("owner_reported_accepted", "I haven't accepted my offer from Waterloo for Computer Science.")).toBe(false);
  });

  it("requires an offer clause to name exactly one tracked school and its program", () => {
    const current = decisionSnapshot(true);
    const direct = "I got a conditional offer from Waterloo for Computer Science.";
    expect(parseWorkflow(direct, workflowUpdate({
      programRef: WATERLOO,
      applicationItemRef: null,
      kind: "offer",
      label: "conditional offer",
      owner: "university",
      status: "owner_reported_offered",
      statusEvidence: direct,
      preparedDetails: null,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: direct,
      },
    }), current)).toMatchObject({ workflowUpdates: [{ status: "owner_reported_offered" }] });

    for (const text of [
      "I got a conditional offer from Western for Computer Science.",
      "I got a conditional offer from Western instead of Waterloo for Computer Science.",
    ]) {
      expect(() => parseWorkflow(text, workflowUpdate({
        programRef: WATERLOO,
        applicationItemRef: null,
        kind: "offer",
        label: "conditional offer",
        owner: "university",
        status: "owner_reported_offered",
        statusEvidence: text,
        preparedDetails: null,
        deadline: {
          date: null, instant: null, timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
        },
      }), current)).toThrow("university_workflow_model_item_invalid");
    }
  });

  it.each([
    "I got no offer from Western Medical Sciences.",
    "I have no offer from Western Medical Sciences yet.",
    "I have yet to get an offer from Western Medical Sciences.",
    "Dear Sid, I have an offer of admission for you from Western Medical Sciences.",
    "\"I received a Western Medical Sciences offer.\"",
  ])("refuses a negated, forwarded, or quoted offer statement: %s", (text) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "offer",
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

  it.each([
    "I'm scared I got rejected from Western Medical Sciences.",
    "I feel like I got rejected from Western Medical Sciences.",
  ])("refuses a hedged decision statement: %s", (text) => {
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western Medical Sciences",
      owner: "university",
      status: "owner_reported_rejected",
      statusEvidence: text,
      preparedDetails: null,
      deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text,
      },
    }))).toThrow("university_workflow_model_item_invalid");
  });

  it.each([
    "Mom told me I emailed Ms Chen for the Ms Chen reference request covering the Western reference.",
    "Mom and I emailed Ms Chen for the Ms Chen reference request covering the Western reference.",
    "I emailed Ms Chen for the Ms Chen reference request covering the Western reference. Actually no, it failed.",
    "I emailed my mom about the Ms Chen reference request for the Western reference.",
  ])("accepts the model's declared step completion for every owner-wording probe: %s", (text) => {
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
    "My counsellor told Ms. Lee I emailed Ms Chen for the Ms Chen reference request covering the Western reference.",
    "The school told Mr. Chen I emailed Ms Chen for the Ms Chen reference request covering the Western reference.",
    "Mom emailed Dr. Shah that I emailed Ms Chen for the Ms Chen reference request covering the Western reference.",
  ])("accepts the model's declared action across a titled-name period: %s", (text) => {
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("accepts the model's declared step even when another workflow item is also named", () => {
    const text = "I emailed Ms Chen for the Ms Chen reference request beside the Western upload step for the Western reference.";
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
    }), snapshotWithTwoWorkflows())).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("refuses an offer clause that also names an application item", () => {
    const text = "I received a Western Medical Sciences offer while reviewing the Western reference.";
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null,
      kind: "offer",
      label: "Western Medical Sciences offer",
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

  it("accepts the model's declared completion even in a conditional sentence", () => {
    const text = "If I emailed Ms Chen for the Ms Chen reference request covering the Western reference.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it.each([
    "If you have time, draft the Ms Chen reference request for the Western reference.",
    "Actually no, draft the Ms Chen reference request for the Western reference.",
  ])("accepts the model's prepared status for a conditional or retracted sentence: %s", (text) => {
    expect(parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }))).toMatchObject({ workflowUpdates: [{ status: "prepared" }] });
  });

  it("accepts the model's declared completion even when the sentence retracts itself", () => {
    const text = "I emailed Ms Chen for the Ms Chen reference request covering the Western reference. Actually no.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("accepts the model's declared completion even in a negated sentence", () => {
    const text = "I didn't email Ms Chen for the Ms Chen reference request covering the Western reference.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("accepts the model's declared completion independently of the action wording", () => {
    const text = "I emailed Ms Chen not successfully for the Ms Chen reference request covering the Western reference.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_done" }] });
  });

  it("refuses a negated offer status", () => {
    const text = "I got no Western Medical Sciences offer.";
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null, kind: "offer", label: "Western Medical Sciences offer", owner: "university",
      status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }))).toThrow("university_workflow_model_item_invalid");
  });

  it("accepts the model's prepared status even when the sentence also says the step is not done", () => {
    const text = "Although I haven't contacted Ms Chen please draft the Ms Chen reference request for the Western reference.";
    expect(parseWorkflow(text, workflowUpdate({ statusEvidence: text,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text } })))
      .toMatchObject({ workflowUpdates: [{ status: "prepared" }] });
  });

  it("accepts a prepared-details revision the model supplies", () => {
    const text = "The Ms Chen reference request for the Western reference needs a clearer opening.";
    expect(parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: null, statusEvidence: null, preparedDetails: "Use a clearer opening.", deadline: null,
    }), snapshot(true))).toMatchObject({ workflowUpdates: [{
      preparedDetails: expect.stringContaining("Use a clearer opening."),
    }] });
  });

  it("refuses a workflow status that is incompatible with its kind", () => {
    const text = "Draft the Western Medical Sciences offer.";
    expect(() => parseWorkflow(text, workflowUpdate({
      applicationItemRef: null, kind: "offer", label: "Western Medical Sciences offer", owner: "university",
      status: "prepared", statusEvidence: text, preparedDetails: null,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }))).toThrow("university_workflow_model_item_invalid");
  });

  it("refuses a workflow linked to an application item from another program", () => {
    const current = decisionSnapshot();
    const text = "Draft the cross-program request for the Waterloo AIF.";
    expect(() => parseWorkflow(text, workflowUpdate({
      programRef: PROGRAM,
      applicationItemRef: WATERLOO_APPLICATION,
      label: "cross-program request",
      statusEvidence: text,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }), current)).toThrow("university_workflow_model_item_invalid");
  });

  it("accepts a verified deadline the model supplies with a source and cycle anywhere in Sid's message", () => {
    const direct = "Draft the Ms Chen reference request for the Western reference due 2027-01-15 from https://example.edu/deadline for the 2026-2027 admission cycle.";
    expect(parseWorkflow(direct, workflowUpdate({
      statusEvidence: direct,
      deadline: {
        date: "2027-01-15", instant: null, timeZone: null,
        verification: { state: "verified", sourceUrl: "https://example.edu/deadline", cycle: "2026-2027" },
        evidence: direct,
      },
    }))).toMatchObject({ workflowUpdates: [{ deadline: { verification: { state: "verified" } } }] });

    const text = "Draft the Ms Chen reference request for the Western reference due 2027-01-15. Source https://example.edu/deadline for the 2026-2027 admission cycle.";
    expect(parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: "2027-01-15", instant: null, timeZone: null,
        verification: { state: "verified", sourceUrl: "https://example.edu/deadline", cycle: "2026-2027" },
        evidence: text,
      },
    }))).toMatchObject({ workflowUpdates: [{ deadline: { date: "2027-01-15", verification: { state: "verified" } } }] });
  });

  it("accepts a deadline date the model supplies even when another sentence carries the date", () => {
    const text = "Draft the Ms Chen reference request for the Western reference. January 15, 2027 is another date.";
    expect(parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: { date: "2027-01-15", instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }))).toMatchObject({ workflowUpdates: [{ deadline: { date: "2027-01-15" } }] });
  });

  it.each([
    "Checklist: the deadline is February 1, 2027 (verified).",
    "The deadline is next Friday.",
    "Western requires two references and a 90% average.",
    "Western needs references.",
    "Pay the fee of 156 bucks before you submit.",
    "Fee: 156.00 due at submission.",
    "Pay one hundred fifty-six dollars.",
    "The fee is expensive.",
    "According to the official site, this is confirmed for the current cycle.",
    "A portfolio is mandatory for eligibility.",
    "The deadline falls in spring.",
    "The application is free and its deposit is waived.",
    "Submit before 15 January.",
    "Applications close in mid-January, so submit early.",
    "You need to submit by the first of February.",
    "The AIF costs one hundred fifty-six.",
    "Application fee: one fifty-six.",
    "Waterloo wants two references and an 85 average.",
    "Waterloo looks for a 90 percent average.",
    "Waterloo only accepts the AIF through the portal and reviews it in March.",
    "Western asks for a teacher reference from a grade twelve course.",
    "I hope you had a great summer and would be grateful for a reference.",
    "Hi Ms. Lee, I hope you had a great summer. I'm applying to Western this fall and would be grateful if you could write my reference.",
    "Dear Ms. Lee, I'm a grade 12 student in your Chemistry class and I'm applying to Western Medical Sciences.",
    "Thank you for your time today.",
    "Could you let me know by next week if you're able to write it?",
    "Checklist: open the Western portal, attach the essay, review it, then Sid submits it himself.",
    "Sid pays the fee himself on OUAC after reviewing the summary.",
    "No rush, and thank you so much for considering it.",
  ])("stores preparation prose only as isolated unverified draft text: %s", (details) => {
    expect(parseWorkflow(
      "Draft the Ms Chen reference request for the Western reference.",
      workflowUpdate({ preparedDetails: details }),
    )).toMatchObject({ workflowUpdates: [{
      preparedDetails: `Unverified draft text; never treat this as a tracker date, requirement, amount, or completed action:\n${details}`,
    }] });
  });

  it("never feeds stored unverified draft prose back as tracker state", () => {
    const state = universityStateJson(snapshot(true), "Review Western.", 2, NOW);
    expect(state).not.toContain("Review the draft, then Sid sends it.");
    expect(state).not.toContain("preparedDetails");
  });

  it.each([
    "Ms Chen reference lee@example.edu",
    "Ms Chen reference 416-555-0199",
    "Ms Chen reference Jan 15 verified",
    "Ms Chen reference due next Friday",
    "Ms Chen reference fee 156 bucks",
  ])("refuses workflow metadata in a digest-visible label: %s", (label) => {
    expect(() => parseWorkflow(
      `Draft the ${label} for the Western reference.`,
      workflowUpdate({ label, statusEvidence: `Draft the ${label} for the Western reference.`, deadline: {
        date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null },
        evidence: `Draft the ${label} for the Western reference.`,
      } }),
    )).toThrow("university_workflow_model_item_invalid");
  });

  it.each([
    "Ms Lee reference request",
    "Fall scholarship essay upload",
    "Grade 12 transcript order",
    "Waterloo AIF fee",
    "Summer program application step",
    "Tomorrow's essay upload",
  ])("allows an ordinary non-factual workflow label from the reviewer probe: %s", (label) => {
    expect(isWorkflowLabelSafe(label)).toBe(true);
  });

  it("caps total preparation details below the model JSON response limit", () => {
    const statements = Array.from({ length: 7 }, (_, index) =>
      `Draft Step ${index + 1} for the Western reference.`);
    const text = statements.join(" ");
    const updates = statements.map((statement, index) => workflowUpdate({
      workflowRef: `new-workflow-${index + 1}`,
      label: `Step ${index + 1}`,
      statusEvidence: text,
      preparedDetails: "x".repeat(1_750),
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }));
    expect(() => parseOwnerUniversityPlan({
      engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: updates,
    }, text, new Redactor(), snapshot())).toThrow("university_tracker_model_response_invalid");
  });

  it("ages terminal workflow steps out of prompt state but keeps a named correction target reachable", () => {
    const current = snapshot(true);
    const program = current.programs[0]!;
    const workflow = program.workflowItems?.[0];
    if (workflow === undefined) throw new Error("workflow fixture missing");
    const closed: UniversityTrackerSnapshot = {
      ...current,
      programs: [{ ...program, workflowItems: [{ ...workflow, status: "owner_reported_done" }] }],
    };
    expect(universityStateJson(closed, "", 0, new Date("2026-09-17T15:00:00.000Z"))).toContain(WORKFLOW);
    expect(universityStateJson(closed, "", 0, new Date("2026-09-19T15:00:00.000Z"))).not.toContain(WORKFLOW);
    expect(universityStateJson(
      closed,
      "Correct the Ms Chen reference request.",
      0,
      new Date("2026-09-19T15:00:00.000Z"),
    )).toContain(WORKFLOW);
  });

  it("keeps an open contact step when its parent application item is submitted", () => {
    const current = snapshot(true);
    const program = current.programs[0]!;
    const submitted: UniversityTrackerSnapshot = {
      ...current,
      programs: [{
        ...program,
        applicationItems: program.applicationItems.map((item) => ({
          ...item, status: "submitted_by_sid", submittedAt: NOW.toISOString(),
        })),
      }],
    };
    expect(universityStateJson(submitted, "What is next?", 0, NOW)).toContain(WORKFLOW);
  });

  it("hides only the submission or upload step completed by its parent submission", () => {
    const current = snapshot(true);
    const program = current.programs[0]!;
    const workflow = program.workflowItems?.[0];
    if (workflow === undefined) throw new Error("workflow fixture missing");
    const submitted: UniversityTrackerSnapshot = {
      ...current,
      programs: [{
        ...program,
        applicationItems: program.applicationItems.map((item) => ({
          ...item, status: "submitted_by_sid", submittedAt: NOW.toISOString(),
        })),
        workflowItems: [{ ...workflow, kind: "submission_step" }],
      }],
    };
    expect(universityStateJson(submitted, "What is next?", 0, NOW)).not.toContain(WORKFLOW);
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

  it("shows only the fixed receipt after an offer save, never the model's reply", async () => {
    const text = "I got an offer from University of Waterloo for Computer Science.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Congrats! I accepted it for you and recorded it.",
      workflowUpdates: [workflowUpdate({
        programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "Waterloo offer, confirmed", owner: "sid",
        status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
        deadline: { date: null, instant: null, timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      })],
    })]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, decisionSnapshot(), applyOwnerPlan).stream(input(text))))
      .resolves.toBe("Saved: University of Waterloo Computer Science offer (you told me; unverified).");
    expect(model.requests).toHaveLength(1);
    expect(applyOwnerPlan).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ workflowUpdates: [expect.objectContaining({
        programRef: WATERLOO, kind: "offer", label: "offer", owner: "university",
      })] }),
    }));
  });

  it("asks for the one missing program when an offer report names a school with several programs", async () => {
    const current = decisionSnapshot();
    const waterloo = current.programs.find((program) => program.programId === WATERLOO)!;
    const ambiguous: UniversityTrackerSnapshot = {
      ...current,
      programs: [...current.programs, {
        ...waterloo, programId: SECOND_WORKFLOW, programName: "Software Engineering", applicationItems: [],
      }],
    };
    const model = new SequenceModel([combinedResponse({ reply: "Congrats, I recorded it!" })]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, ambiguous, applyOwnerPlan).stream(input("I got my Waterloo offer!!"))))
      .resolves.toBe("I didn't save anything from that message. Which University of Waterloo program is it (tracked: Computer Science, Software Engineering)? Send one sentence on its own, like: I got an offer from University of Waterloo for <program>. Send any other question separately.");
    expect(model.requests).toHaveLength(1);
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it.each([
    "I wish I got an offer from Waterloo for Computer Science.",
    "I dreamt I got an offer from Waterloo for Computer Science.",
    "Imagine I got an offer from Waterloo for Computer Science.",
  ])("makes a refused imagined offer visibly unsaved without model text: %s", async (text) => {
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Congrats!",
      workflowUpdates: [workflowUpdate({
        programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
        status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
        deadline: { date: null, instant: null, timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      })],
    }), "Congrats! I've recorded your Waterloo offer in your university tracker."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, decisionSnapshot(), applyOwnerPlan).stream(input(text)))).resolves.toBe(
      "I didn't save anything from that message. I only save an offer update you state directly in one sentence on its own, like: I got an offer from University of Waterloo for Computer Science. Send any other question separately.",
    );
    expect(model.requests).toHaveLength(1);
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it("makes a structured offer refusal visible even when the model falsely clears engagement", async () => {
    const text = "I got an offer from Toronto instead of Waterloo.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: false,
      reply: "Recorded.",
      workflowUpdates: [workflowUpdate({
        programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
        status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
        deadline: { date: null, instant: null, timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      })],
    }), "I've recorded your Waterloo offer in the university tracker."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, decisionSnapshot(), applyOwnerPlan).stream(input(text)))).resolves.toBe(
      "I didn't save anything from that message. I only save an offer update you state directly in one sentence on its own, like: I got an offer from University of Waterloo for <program>. Send any other question separately.",
    );
    expect(model.requests).toHaveLength(1);
    expect(applyOwnerPlan).not.toHaveBeenCalled();
  });

  it("says nothing was saved when the repository rejects an explicit offer", async () => {
    const text = "I got an offer from Waterloo for Computer Science.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Saved and accepted.",
      workflowUpdates: [workflowUpdate({
        programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
        status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
        deadline: { date: null, instant: null, timeZone: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      })],
    }), "I saved it."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => { throw new Error("d1 unavailable"); });
    await expect(collect(adapterWith(model, decisionSnapshot(), applyOwnerPlan).stream(input(text)))).resolves.toBe(
      "I couldn't update your university tracker, so nothing from that message was saved. Try again later as one sentence on its own, like: I got an offer from University of Waterloo for Computer Science. Send any other question separately.",
    );
    expect(model.requests).toHaveLength(1);
  });

  it("builds step, application-item and program receipts from the stored plan", async () => {
    const text = "I emailed Ms Lee about the Ms Lee reference request for the Western reference.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "I emailed Ms. Lee for you and marked it done.",
      workflowUpdates: [workflowUpdate({
        workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
        status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
      })],
    })]);
    const current = reviewerStepSnapshot();
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, current, applyOwnerPlan).stream(input(text)))).resolves.toBe(
      "Saved: Ms Lee reference request for Western University Medical Sciences marked done (you told me; unverified).",
    );
    expect(applyOwnerPlan).toHaveBeenCalledTimes(1);
  });

  it("keeps main's reply guard and model text on an ordinary turn that saves nothing", async () => {
    const model = new SequenceModel([combinedResponse({ reply: "Waterloo interviews are often in March." })]);
    await expect(collect(adapterWith(model).stream(input("When does Waterloo interview?"))))
      .resolves.toBe("Waterloo interviews are often in March.");
    const claim = new SequenceModel([combinedResponse({ reply: "I submitted your Western application." })]);
    await expect(collect(adapterWith(claim).stream(input("What should I do next?"))))
      .resolves.toBe("I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.");
  });

  it("S2 saves a model-declared submission even in titled-name reported speech", async () => {
    const base = snapshot();
    const program = base.programs[0]!;
    const current: UniversityTrackerSnapshot = {
      ...base,
      programs: [{ ...program, applicationItems: [{
        ...program.applicationItems[0]!, kind: "essay", label: "Western essay",
      }] }],
    };
    const text = "My counsellor told Ms. Lee I submitted the Western essay.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Recorded.",
      applicationUpdates: [{
        itemRef: APPLICATION, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }), "I saved your university tracker."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, current, applyOwnerPlan).stream(input(text)))).resolves.toContain("Saved:");
    expect(applyOwnerPlan).toHaveBeenCalledTimes(1);
  });

  it("S2 saves a model-declared workflow step even in titled-name reported speech", async () => {
    const text = "My counsellor told Ms. Lee I emailed Ms Chen for the Ms Chen reference request covering the Western reference.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Recorded.",
      workflowUpdates: [workflowUpdate({
        workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
        status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
      })],
    }), "I saved your university tracker."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, snapshot(true), applyOwnerPlan).stream(input(text)))).resolves.toContain("Saved:");
    expect(applyOwnerPlan).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "My counsellor told Ms. Lee I got an offer from Waterloo for Computer Science.",
      "offer",
    ],
    [
      "Mom told Mr. Chen I paid the Waterloo AIF fee for the Waterloo AIF.",
      "payment",
    ],
  ] as const)("S2 handles the reviewer titled-name workflow probe through the real adapter: %s", async (text, kind) => {
    const current = reviewerStepSnapshot();
    const update = kind === "offer"
      ? workflowUpdate({
          programRef: WATERLOO, applicationItemRef: null, kind: "offer", label: "offer", owner: "university",
          status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
          deadline: { date: null, instant: null, timeZone: null,
            verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
        })
      : workflowUpdate({
          workflowRef: SECOND_WORKFLOW, programRef: WATERLOO, applicationItemRef: null,
          kind: null, label: null, owner: null, status: "owner_reported_done", statusEvidence: text,
          preparedDetails: null, deadline: null,
        });
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Recorded.",
      workflowUpdates: [update],
    }), "I saved your university tracker."]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    const reply = await collect(adapterWith(model, current, applyOwnerPlan).stream(input(text)));
    if (kind === "offer") {
      expect(reply).toBe("I didn't save anything from that message. I only save an offer update you state directly in one sentence on its own, like: I got an offer from University of Waterloo for Computer Science. Send any other question separately.");
      expect(applyOwnerPlan).not.toHaveBeenCalled();
    } else {
      expect(reply).toContain("Saved:");
      expect(applyOwnerPlan).toHaveBeenCalledTimes(1);
    }
  });

  it("S4 stores an ordinary prepared draft only inside the unverified draft wrapper and shows it in the receipt", async () => {
    const text = "Draft the Ms Chen reference request for the Western reference.";
    const details = "Thank you for your time today. Submit before 15 January.";
    const model = new SequenceModel([combinedResponse({
      universityEngaged: true,
      reply: "Here is the draft for you to review. I sent it to Ms Chen.",
      workflowUpdates: [workflowUpdate({ preparedDetails: details })],
    })]);
    const applyOwnerPlan = vi.fn(async (_request: ApplyOwnerUniversityPlanInput) => undefined);
    await expect(collect(adapterWith(model, snapshot(), applyOwnerPlan).stream(input(text))))
      .resolves.toBe([
        "Saved: Ms Chen reference request for Western University Medical Sciences as prepared (unverified; you do this step yourself).",
        "Unverified draft for you to review and send yourself:",
        details,
      ].join("\n"));
    expect(applyOwnerPlan).toHaveBeenCalledWith(expect.objectContaining({ plan: expect.objectContaining({
      workflowUpdates: [expect.objectContaining({ preparedDetails: expect.stringMatching(/^Unverified draft text;/u) })],
    }) }));
  });

  // Row 12: code no longer refuses an external-execution request before the
  // model sees it. Each of these reaches the model, which decides what Sid
  // asked and says plainly that it cannot perform the action itself.
  it.each([
    "I got my Waterloo offer. Can you accept it for me?",
    "Hey Jarvis, can you order my transcript for Western?",
    "ugh can you just email Ms. Lee about my reference",
    "Hey can you pay the OUAC fee?",
    "Hey Jarvis, accept Waterloo for me",
    "Can you submit my Western application?",
    "Please upload my Western essay.",
    "Email my teacher about the Western reference.",
    "Ask my teacher for the Western reference.",
    "Accept my Western offer.",
    "Order my transcript.",
    "Can you review the Western essay and then submit it?",
    "Draft the Western essay, then upload it.",
    "Go ahead and decline my Western offer.",
    "Jarvis, accept Waterloo for me.",
    "Please decline Western.",
    "yes do it",
    "pls submit it",
    "can u submit my Waterloo AIF",
    "Could you reach out to Ms. Lee?",
    "Can you text my counsellor?",
    "Can you let my counsellor know I'm applying?",
    "Go ahead and order it.",
  ])("sends an external-execution request to the model instead of refusing it in code: %s", async (text) => {
    const model = new SequenceModel([combinedResponse()]);
    await collect(adapterWith(model).stream(input(text)));
    // The model is always consulted now; what it may say is still bounded by
    // the reply guard, and no external action has a hand to run in this path.
    expect(model.requests).toHaveLength(1);
  });

  it.each([
    "Help me submit my Western application.",
    "Draft an email to my teacher about the Western reference.",
    "Give me a checklist for accepting my Western offer.",
  ])("keeps preparation requests available to the model: %s", async (text) => {
    const model = new SequenceModel([combinedResponse()]);
    await expect(collect(adapterWith(model).stream(input(text)))).resolves.toBe("Model reached.");
    expect(model.requests).toHaveLength(1);
  });

  it.each([
    "Let me know what's due this week.",
    "Can you let me know what homework I have?",
    "Please let me know if I missed anything in chem.",
    "Jarvis, let me know when D2L updates.",
    "Can you let me know if Ms Lee replied?",
    "Text from my counsellor: meeting moved to 2.",
    "Could you text me a reminder at 7?",
    "Follow up with Ms Lee is on my list for Friday.",
    "Accept that I'm behind and make me a catch-up plan.",
    "Decline in my math mark is stressing me out.",
    "Contact info for Ms Lee is on the school site.",
    "Email to Western bounced, what should I do?",
    "Call with my counsellor is tomorrow at 3.",
    "Message my teacher sent says the quiz is Friday.",
    "Submit date for the Western essay is Jan 15.",
    "Upload link for the AIF isn't working.",
    "Can you message me tomorrow morning to study chem?",
    "Can you help me email Ms Lee?",
    "Can you remind me to email Ms Lee tomorrow?",
    "Call me out if I skip studying tonight.",
    "Buy time on the essay by doing chem first?",
    "Register for the SAT is on my to-do list, is it worth it?",
    "Can you call it a night and summarize what I did?",
    "Email from Western says my application is complete.",
    "Message from Ms. Lee: the chem test moved to Friday.",
    "Upload deadline for the Western supplement is January 15, 2027.",
    "I'll finish my essay tonight and then submit it tomorrow.",
    "I need to study for chem and then email my teacher about the extension.",
    "Can you make a checklist and email template for my reference request?",
    "Could you draft the steps and message for Ms. Lee?",
    "Pay attention, my Waterloo AIF is due Friday.",
    "Submit button on OUAC is greyed out, what should I check?",
  ])("S3 lets ordinary school information and self-directed requests reach the real adapter: %s", async (text) => {
    const model = new SequenceModel([combinedResponse()]);
    await expect(collect(adapterWith(model).stream(input(text)))).resolves.toBe("Model reached.");
    expect(model.requests).toHaveLength(1);
  });
});
