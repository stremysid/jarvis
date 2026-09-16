import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import {
  isUniversityExecutionRequest,
  SchoolCatchupModelAdapter,
} from "../../src/school/school-catchup-model.js";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan, universityStateJson } from "../../src/university/university-tracker-model.js";
import type { UniversityTrackerSnapshot } from "../../src/university/university-tracker-types.js";

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
    const text = "I received a Western Medical Sciences offer.";
    expect(parseWorkflow(text, workflowUpdate({
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
    }))).toMatchObject({ workflowUpdates: [{ status: "owner_reported_offered" }] });
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
  ])("routes step completion through the direct-owner evidence validator: %s", (text) => {
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

  it("refuses a clause that names a second workflow item", () => {
    const text = "I emailed Ms Chen for the Ms Chen reference request beside the Western upload step for the Western reference.";
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
    }), snapshotWithTwoWorkflows())).toThrow("university_workflow_model_item_invalid");
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

  it("refuses a conditional workflow completion", () => {
    const text = "If I emailed Ms Chen for the Ms Chen reference request covering the Western reference.";
    expect(() => parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toThrow("university_workflow_model_item_invalid");
  });

  it("refuses a retracted workflow completion", () => {
    const text = "I emailed Ms Chen for the Ms Chen reference request covering the Western reference. Actually no.";
    expect(() => parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toThrow("university_workflow_model_item_invalid");
  });

  it("refuses a negated workflow completion", () => {
    const text = "I didn't email Ms Chen for the Ms Chen reference request covering the Western reference.";
    expect(() => parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null,
    }), snapshot(true))).toThrow("university_workflow_model_item_invalid");
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

  it("refuses prepared status when the owner says the step is not done", () => {
    const text = "Although I haven't contacted Ms Chen please draft the Ms Chen reference request for the Western reference.";
    expect(() => parseWorkflow(text, workflowUpdate({ statusEvidence: text,
      deadline: { date: null, instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text } })))
      .toThrow("university_workflow_model_item_invalid");
  });

  it("refuses a prepared-details revision without a preparation request", () => {
    const text = "The Ms Chen reference request for the Western reference needs a clearer opening.";
    expect(() => parseWorkflow(text, workflowUpdate({
      workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null,
      status: null, statusEvidence: null, preparedDetails: "Use a clearer opening.", deadline: null,
    }), snapshot(true))).toThrow("university_workflow_model_item_invalid");
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

  it("requires a verified deadline source and cycle in the target clause", () => {
    const text = "Draft the Ms Chen reference request for the Western reference due January 15, 2027. Source https://example.edu/deadline for the 2026-2027 admission cycle.";
    expect(() => parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: {
        date: "2027-01-15", instant: null, timeZone: null,
        verification: { state: "verified", sourceUrl: "https://example.edu/deadline", cycle: "2026-2027" },
        evidence: text,
      },
    }))).toThrow("university_workflow_model_deadline_invalid");
  });

  it("requires a deadline date in the clause that names the workflow target", () => {
    const text = "Draft the Ms Chen reference request for the Western reference. January 15, 2027 is another date.";
    expect(() => parseWorkflow(text, workflowUpdate({
      statusEvidence: text,
      deadline: { date: "2027-01-15", instant: null, timeZone: null,
        verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    }))).toThrow("university_workflow_model_deadline_invalid");
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
  ])("refuses factual dates, requirements, verification, and money in preparation details: %s", (details) => {
    expect(() => parseWorkflow(
      "Draft the Ms Chen reference request for the Western reference.",
      workflowUpdate({ preparedDetails: details }),
    )).toThrow("university_workflow_model_item_invalid");
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

  it("caps total preparation details below the model JSON response limit", () => {
    const statements = Array.from({ length: 7 }, (_, index) =>
      `Draft Step ${index + 1} for the Western reference.`);
    const text = statements.join(" ");
    const updates = statements.map((statement, index) => workflowUpdate({
      workflowRef: `new-workflow-${index + 1}`,
      label: `Step ${index + 1}`,
      statusEvidence: text,
      preparedDetails: "x".repeat(2_000),
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

  it("hides a pending workflow step when its application item is submitted", () => {
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
    "Jarvis, accept Waterloo for me.",
    "Please decline Western.",
    "yes do it",
    "pls submit it",
    "can u submit my Waterloo AIF",
    "Could you reach out to Ms. Lee?",
    "Can you text my counsellor?",
    "Can you let my counsellor know I'm applying?",
    "Go ahead and order it.",
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

  it.each([
    "Email from Western says my application is complete.",
    "Message from Ms. Lee: the chem test moved to Friday.",
    "Upload deadline for the Western supplement is January 15, 2027.",
    "I'll finish my essay tonight and then submit it tomorrow.",
    "I need to study for chem and then email my teacher about the extension.",
    "Can you make a checklist and email template for my reference request?",
    "Could you draft the steps and message for Ms. Lee?",
    "Pay attention, my Waterloo AIF is due Friday.",
    "Submit button on OUAC is greyed out, what should I check?",
  ])("does not treat school information or a draft request as an execution request: %s", (text) => {
    expect(isUniversityExecutionRequest(text)).toBe(false);
  });
});
