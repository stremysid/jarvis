import { describe, expect, it, vi } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import type { SchoolCatchupSnapshot } from "../../src/school/school-catchup-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan, universityStateJson } from "../../src/university/university-tracker-model.js";
import type { UniversityTrackerSnapshot } from "../../src/university/university-tracker-types.js";

const TURN = "01k5fb9pg00000000000000d00" as Ulid;
const PROGRAM = "01k5fb9pg00000000000000d01" as Ulid;
const ITEM = "01k5fb9pg00000000000000d02" as Ulid;
const OTHER_ITEM = "01k5fb9pg00000000000000d03" as Ulid;
const WESTERN_PROGRAM = "01k5fb9pg00000000000000d04" as Ulid;
const QUEENS_PROGRAM = "01k5fb9pg00000000000000d05" as Ulid;
const UOFT_PROGRAM = "01k5fb9pg00000000000000d06" as Ulid;
const WESTERN_ESSAY = "01k5fb9pg00000000000000d07" as Ulid;
const WESTERN_REFERENCE = "01k5fb9pg00000000000000d08" as Ulid;
const QUEENS_SCHOLARSHIP = "01k5fb9pg00000000000000d09" as Ulid;
const UOFT_ESSAY = "01k5fb9pg00000000000000d0a" as Ulid;
const UOFT_TRANSCRIPT = "01k5fb9pg00000000000000d0b" as Ulid;
const UOFT_ALT_ESSAY = "01k5fb9pg00000000000000d0c" as Ulid;
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
        sourceTurnId: TURN,
        submittedAt: null,
        updatedAt: NOW.toISOString(),
      }],
    }],
  };
}

function roundTwoSnapshot(principalId: string): UniversityTrackerSnapshot {
  const base = universitySnapshot(principalId);
  const item = base.programs[0]!.applicationItems[0]!;
  return {
    ...base,
    programs: [{
      ...base.programs[0]!,
      applicationItems: [{
        ...item,
        dueDate: "2027-02-01",
        verification: {
          state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027", verifiedAt: NOW.toISOString(),
        },
      }],
    }, {
      ...base.programs[0]!,
      programId: WESTERN_PROGRAM,
      university: "Western University",
      programName: "Medical Sciences",
      applicationItems: [{ ...item, itemId: WESTERN_ESSAY, kind: "essay", label: "Western essay", status: "not_started" },
        { ...item, itemId: WESTERN_REFERENCE, kind: "reference", label: "Western reference", status: "not_started" }],
    }, {
      ...base.programs[0]!,
      programId: QUEENS_PROGRAM,
      university: "Queen's University",
      programName: "Commerce",
      applicationItems: [{
        ...item, itemId: QUEENS_SCHOLARSHIP, kind: "scholarship", label: "Queen's scholarship",
        status: "not_needed_by_sid",
      }],
    }, {
      ...base.programs[0]!,
      programId: UOFT_PROGRAM,
      university: "University of Toronto",
      programName: "Engineering Science",
      applicationItems: [{
        ...item, itemId: UOFT_ESSAY, kind: "essay", label: "UofT essay",
        status: "submitted_by_sid", submittedAt: NOW.toISOString(),
      }],
    }],
  };
}

function conjunctionSnapshot(principalId: string): UniversityTrackerSnapshot {
  const base = universitySnapshot(principalId);
  const item = base.programs[0]!.applicationItems[0]!;
  return {
    ...base,
    programs: [{
      ...base.programs[0]!,
      programId: UOFT_PROGRAM,
      university: "University of Toronto",
      programName: "Arts and Science",
      applicationItems: [{
        ...item,
        itemId: UOFT_ESSAY,
        kind: "essay",
        label: "Arts and Science essay",
        status: "not_started",
      }, {
        ...item,
        itemId: UOFT_TRANSCRIPT,
        kind: "transcript",
        label: "UofT transcript",
        status: "not_started",
      }, {
        ...item,
        itemId: UOFT_ALT_ESSAY,
        kind: "essay",
        label: "UofT alternate essay",
        status: "not_started",
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
    workflowUpdates: [],
  });
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

function parseStatus(
  snapshot: UniversityTrackerSnapshot,
  text: string,
  itemRef: Ulid,
  programRef: Ulid,
  status: "not_started" | "drafting" | "ready" | "submitted_by_sid" | "not_needed_by_sid",
) {
  return parseOwnerUniversityPlan({
    engaged: true,
    programUpdates: [],
    applicationUpdates: [{
      itemRef, programRef, kind: null, label: null, status, statusEvidence: text, dueDate: null,
    }],
  }, text, new Redactor(), snapshot);
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
      .resolves.toBe("Saved: University of Waterloo Computer Science Waterloo AIF — ready.");
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
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner"))).toMatchObject({
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

  it("accepts an ISO application date the model supplies even when the wording does not spell it out", () => {
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
          date: "2027-01-15",
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor())).toMatchObject({
      applicationUpdates: [{ dueDate: { date: "2027-01-15" } }],
    });
  });

  it("refuses a date the model supplies that is not a real calendar date", () => {
    const text = "Add the Waterloo AIF due 2027-02-30.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1",
        programRef: PROGRAM,
        kind: "supplementary_application",
        label: "Waterloo AIF",
        status: "not_started",
        statusEvidence: text,
        dueDate: {
          date: "2027-02-30",
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor())).toThrow("university_application_model_date_invalid");
  });

  it("refuses a verified date whose cycle is absent from Sid's message", () => {
    const text = "Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2026-2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:verified-cycle-absent")))
      .toThrow("university_tracker_model_verification_invalid");
  });

  it("refuses a status with no provenance or provenance with no status", () => {
    const text = "I submitted my Waterloo AIF.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: null, dueDate: null,
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:status-pairing"))).toThrow("university_application_model_item_invalid");
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: null, statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:status-pairing"))).toThrow("university_application_model_item_invalid");
  });

  it("accepts a submitted-by-Sid status the model declares for Sid's whole current message", () => {
    const text = "When is my Waterloo AIF submitted?";
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
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner"))).toMatchObject({
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

  it("accepts the model's submitted claim inside a negated owner message", () => {
    const text = "I don't think I submitted my Waterloo AIF.";
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

  it("P1 accepts the item the model chose even when the wording also names another item", () => {
    const text = "I submitted my Waterloo AIF. I haven't started the Western essay yet.";
    const snapshot = universitySnapshot("principal:application-model-owner");
    const program = snapshot.programs[0]!;
    const withEssay: UniversityTrackerSnapshot = {
      ...snapshot,
      programs: [{
        ...program,
        applicationItems: [...program.applicationItems, {
          ...program.applicationItems[0]!,
          itemId: OTHER_ITEM,
          kind: "essay",
          label: "Western essay",
        }],
      }],
    };
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: OTHER_ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), withEssay)).toMatchObject({
      applicationUpdates: [{ itemRef: OTHER_ITEM, status: "submitted_by_sid" }],
    });
  });

  it("P2 refuses a cropped positive excerpt from a negated status report", () => {
    const text = "I haven't started the Waterloo AIF yet";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "drafting", statusEvidence: "started the Waterloo AIF", dueDate: null,
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toThrow("university_application_model_item_invalid");
  });

  it("P3 accepts the model's declared status even when the wording retracts itself", () => {
    const text = "I just submitted the Waterloo AIF. Actually no, the portal crashed, so it didn't go through.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toMatchObject({ applicationUpdates: [{ status: "submitted_by_sid" }] });
  });

  it("P4 accepts the model's declared status even inside a quoted question", () => {
    const text = "Counsellor asked me: I submitted the Waterloo AIF, right? Not sure.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toMatchObject({ applicationUpdates: [{ status: "submitted_by_sid" }] });
  });

  it.each([
    "Mom says: I submitted the Western essay for you",
    "From guidance: I uploaded your Western essay today",
    "Hi Sid. I have uploaded your Western essay to OUAC. Ms. Lee",
    "Mom writes: I submitted the Western essay",
    "Dad sent me this: I submitted the Western essay",
    "Guidance forwarded this: I submitted the Western essay",
    "Ms. Lee says I submitted the Western essay",
    "Ms. Lee wrote that I submitted the Western essay",
  ])("accepts the model's declared submission even in forwarded or third-party wording: %s", (text) => {
    expect(parseStatus(
      roundTwoSnapshot("principal:reported-submission"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      "submitted_by_sid",
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status: "submitted_by_sid" }] });
  });

  it.each([
    "My counsellor told Ms. Lee I submitted the Western essay.",
    "The school told Mr. Chen I submitted the Western essay.",
    "My counsellor told Mrs. Lee I submitted the Western essay.",
    "The school told St. Clair I submitted the Western essay.",
  ])("accepts the model's declared submission across a masked title abbreviation: %s", (text) => {
    expect(parseStatus(
      roundTwoSnapshot("principal:titled-reported-submission"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      "submitted_by_sid",
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status: "submitted_by_sid" }] });
  });

  it.each([
    "My parents and I submitted the Western essay.",
    "My sister and I submitted the Western essay.",
    "My guidance counselor and I submitted the Western essay.",
    "My mom and I have submitted the Western essay.",
  ])("accepts the model's declared submission in ordinary joint-submission wording: %s", (text) => {
    expect(parseStatus(
      roundTwoSnapshot("principal:joint-submission"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      "submitted_by_sid",
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status: "submitted_by_sid" }] });
  });

  it.each([
    ["Keep the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["I need the Queen's scholarship after all", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["Don't restore the Queen's scholarship, I never submitted it", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["I submitted my Waterloo AIF and started the Western essay.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["I've started my Waterloo AIF but haven't started the Western essay", ITEM, PROGRAM, "not_started"],
    ["I finished the Waterloo AIF and started the Western essay", WESTERN_ESSAY, WESTERN_PROGRAM, "ready"],
    ["I finished the Waterloo AIF and started the Western essay", ITEM, PROGRAM, "drafting"],
  ] as const)("applies the status the model bound to its chosen item: %s", (text, itemRef, programRef, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-status"), text, itemRef, programRef, status))
      .toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it("keeps the submission clause valid for the item it actually names", () => {
    const text = "I submitted my Waterloo AIF and started the Western essay.";
    expect(parseStatus(roundTwoSnapshot("principal:round-two-positive"), text, ITEM, PROGRAM, "submitted_by_sid"))
      .toMatchObject({ applicationUpdates: [{ itemRef: ITEM, status: "submitted_by_sid" }] });
  });

  it.each([
    ["I submitted the Western essay with no issues.", "submitted_by_sid"],
    ["I submitted the Western essay like Ms Lee told me to.", "submitted_by_sid"],
    ["I texted Mom right after I submitted the Western essay.", "submitted_by_sid"],
    ["I emailed Ms Lee and then I submitted the Western essay.", "submitted_by_sid"],
    ["I'm no longer applying to Western so skip the Western essay.", "not_needed_by_sid"],
    ["I finished the Western essay with no more edits to make.", "ready"],
  ] as const)("keeps PR 52 checklist evidence at least as permissive as main: %s", (text, status) => {
    expect(parseStatus(
      roundTwoSnapshot("principal:pr52-checklist-regression"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      status,
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status }] });
  });

  it.each([
    ["Don't remove the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_needed_by_sid"],
    ["I'm not skipping the Waterloo AIF", ITEM, PROGRAM, "not_needed_by_sid"],
    ["I don't need help with the Waterloo AIF", ITEM, PROGRAM, "not_needed_by_sid"],
    ["I'm not doing the Waterloo AIF tonight, tomorrow instead", ITEM, PROGRAM, "not_needed_by_sid"],
    ["I'll skip the gym tonight and work on the Western essay", WESTERN_ESSAY, WESTERN_PROGRAM, "not_needed_by_sid"],
    ["Remove the Western essay, keep the Waterloo AIF", ITEM, PROGRAM, "not_needed_by_sid"],
    ["Don't restore the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_started"],
    ["I'm not going ahead with the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_started"],
  ] as const)("applies the model's declared retirement or reactivation: %s", (text, itemRef, programRef, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-retirement"), text, itemRef, programRef, status))
      .toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it("accepts a natural submitted correction with an intervening adverb", () => {
    const text = "I didn't actually submit the UofT essay, the portal crashed";
    expect(parseStatus(roundTwoSnapshot("principal:round-two-correction-positive"), text, UOFT_ESSAY, UOFT_PROGRAM, "drafting"))
      .toMatchObject({ applicationUpdates: [{ itemRef: UOFT_ESSAY, status: "drafting" }] });
  });

  it.each([
    ["Skip the Western reference, it's a duplicate", WESTERN_REFERENCE, WESTERN_PROGRAM],
    ["I'm not applying for the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM],
  ] as const)("accepts an explicit retirement clause: %s", (text, itemRef, programRef) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-retirement-positive"), text, itemRef, programRef, "not_needed_by_sid"))
      .toMatchObject({ applicationUpdates: [{ itemRef, status: "not_needed_by_sid" }] });
  });

  it.each([
    "If I didn't submit the UofT essay, remind me",
    "Wait, I didn't submit the UofT essay?",
    "I never submit anything late, and the UofT essay went in fine",
  ])("accepts the model's declared correction even in a conditional, questioned or cross-clause sentence: %s", (text) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-correction"), text, UOFT_ESSAY, UOFT_PROGRAM, "drafting"))
      .toMatchObject({ applicationUpdates: [{ itemRef: UOFT_ESSAY, status: "drafting" }] });
  });

  it.each([
    "I submitted the AIF",
    "I just submitted the AIF for Waterloo",
    "Submitted my Waterloo AIF",
    "I submitted my Waterloo AIF, so I don't have to think about it anymore",
    "I submitted my Waterloo AIF. What's next?",
    "I submitted my Waterloo AIF ",
    "I submitted my Waterloo AIF\nwhat's next",
  ])("accepts a direct submission report without requiring brittle formatting: %s", (text) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-submission-positive"), text, ITEM, PROGRAM, "submitted_by_sid"))
      .toMatchObject({ applicationUpdates: [{ itemRef: ITEM, status: "submitted_by_sid" }] });
  });

  it.each([
    ["I began the Western essay today", "drafting"],
    ["I'm done with the Western essay", "ready"],
    ["I finished my Western essay but haven't proofread it", "ready"],
  ] as const)("accepts a direct progress report in its positive clause: %s", (text, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:round-two-progress-positive"), text, WESTERN_ESSAY, WESTERN_PROGRAM, status))
      .toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status }] });
  });

  it.each([
    ["I submitted my Arts and Science essay", "submitted_by_sid"],
    ["I'm working on the Arts and Science essay", "drafting"],
    ["I finished the Arts and Science essay", "ready"],
    ["Skip the Arts and Science essay, it's a duplicate", "not_needed_by_sid"],
  ] as const)("keeps a connective inside the named item while applying status %s", (text, status) => {
    expect(parseStatus(
      conjunctionSnapshot("principal:conjunction-status"),
      text,
      UOFT_ESSAY,
      UOFT_PROGRAM,
      status,
    )).toMatchObject({ applicationUpdates: [{ itemRef: UOFT_ESSAY, status }] });
  });

  it("accepts a date for an item whose program and label contain a connective", () => {
    const text = "The Arts and Science essay is due Feb 1, 2027";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: UOFT_ESSAY, programRef: UOFT_PROGRAM, kind: null, label: null,
        status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: text,
        },
      }],
    }, text, new Redactor(), conjunctionSnapshot("principal:conjunction-date")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: "2027-02-01" } }] });
  });

  it("creates an item whose label and program contain a connective", () => {
    const text = "Add the Arts and Science supplement for UofT";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: UOFT_PROGRAM, kind: "supplementary_application",
        label: "Arts and Science supplement", status: "not_started", statusEvidence: text,
        dueDate: {
          date: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: text,
        },
      }],
    }, text, new Redactor(), conjunctionSnapshot("principal:conjunction-create")))
      .toMatchObject({ applicationUpdates: [{ label: "Arts and Science supplement", status: "not_started" }] });
  });

  it("binds an unnamed follow-up submission clause when the whole message names only one item", () => {
    const text = "I finished the Western essay then submitted it";
    expect(parseStatus(
      roundTwoSnapshot("principal:follow-up-submission"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      "submitted_by_sid",
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status: "submitted_by_sid" }] });
  });

  it.each([
    ["I'm drafting the Western essay. The Common App is done and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is next. My mom and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is the last one. I am skipping band this term, remove it.", WESTERN_ESSAY, WESTERN_PROGRAM, "not_needed_by_sid"],
    ["The Queen's scholarship is retired. I changed my mind about the gym, keep it.", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_started"],
    ["UofT essay check. The band form didn't go through, I never submitted it.", UOFT_ESSAY, UOFT_PROGRAM, "drafting"],
  ] as const)("applies the status the model declared even across a sentence boundary: %s", (text, itemRef, programRef, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:sentence-anaphora"), text, itemRef, programRef, status))
      .toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it.each([
    ["The Western essay is next, the Common App is done and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["I'm drafting the Western essay, the Common App is done and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is next, my Common App personal statement is finished and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is next, band camp is over and I submitted it yesterday.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is next, the Common App is open and I finished it.", WESTERN_ESSAY, WESTERN_PROGRAM, "ready"],
    ["The Western essay is next, the Common App is open and I'm working on it.", WESTERN_ESSAY, WESTERN_PROGRAM, "drafting"],
    ["The Western essay is next, I quit the swim team, I'm not applying for it.", WESTERN_ESSAY, WESTERN_PROGRAM, "not_needed_by_sid"],
    ["The Queen's scholarship is retired, the gym membership lapsed, I changed my mind, keep it.", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_started"],
    ["UofT essay check, the band form bounced, I never submitted it.", UOFT_ESSAY, UOFT_PROGRAM, "drafting"],
  ] as const)("applies the status the model declared in the following clause: %s", (text, itemRef, programRef, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:adjacent-anaphora"), text, itemRef, programRef, status))
      .toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it.each([
    ["The Western essay is next, and I submitted it.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["The Western essay is the last one, so remove it.", WESTERN_ESSAY, WESTERN_PROGRAM, "not_needed_by_sid"],
    ["The Queen's scholarship is retired, but I changed my mind, keep it.", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "not_started"],
    ["UofT essay check: it didn't go through, I never submitted it.", UOFT_ESSAY, UOFT_PROGRAM, "drafting"],
  ] as const)("keeps an item pronoun bound inside its naming sentence: %s", (text, itemRef, programRef, status) => {
    expect(parseStatus(roundTwoSnapshot("principal:same-sentence-anaphora"), text, itemRef, programRef, status))
      .toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it.each([
    ["I submitted my scholarship form today. The UofT transcript is next.", UOFT_TRANSCRIPT, "submitted_by_sid"],
    ["I finished my chemistry lab. The UofT transcript is the last thing.", UOFT_TRANSCRIPT, "ready"],
    ["Remove my shift on Friday. The UofT transcript is fine.", UOFT_TRANSCRIPT, "not_needed_by_sid"],
    ["I still have to write the Arts and Science essay. I submitted my OUAC application today.", UOFT_ESSAY, "submitted_by_sid"],
    ["I am going to skip grade 12 calculus. The Arts and Science essay is my focus.", UOFT_ESSAY, "not_needed_by_sid"],
    ["I'm working on the Arts and Science essay. I finished my Mac supplement.", UOFT_ESSAY, "ready"],
    ["My mom and I submitted the Arts and Science essay.", UOFT_ESSAY, "submitted_by_sid"],
  ] as const)("applies the model's declared status for an item in a connective-named program: %s", (text, itemRef, status) => {
    expect(parseStatus(
      conjunctionSnapshot("principal:connective-wrong-claim"),
      text,
      itemRef,
      UOFT_PROGRAM,
      status,
    )).toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it.each([
    ["I submitted the UofT transcript today.", UOFT_TRANSCRIPT, "submitted_by_sid"],
    ["I finished the UofT transcript.", UOFT_TRANSCRIPT, "ready"],
    ["Remove the UofT transcript.", UOFT_TRANSCRIPT, "not_needed_by_sid"],
    ["I submitted the Arts and Science essay today.", UOFT_ESSAY, "submitted_by_sid"],
    ["Skip the Arts and Science essay.", UOFT_ESSAY, "not_needed_by_sid"],
    ["I finished the Arts and Science essay.", UOFT_ESSAY, "ready"],
  ] as const)("accepts a same-clause claim for an item in a connective-named program: %s", (text, itemRef, status) => {
    expect(parseStatus(
      conjunctionSnapshot("principal:connective-direct-claim"),
      text,
      itemRef,
      UOFT_PROGRAM,
      status,
    )).toMatchObject({ applicationUpdates: [{ itemRef, status }] });
  });

  it.each(["Medical Sciences", "Arts and Science"])(
    "keeps a dotted item label intact before splitting a %s program sentence",
    (programName) => {
      const base = roundTwoSnapshot(`principal:dotted-label:${programName}`);
      const snapshot: UniversityTrackerSnapshot = {
        ...base,
        programs: base.programs.map((program) => program.programId === WESTERN_PROGRAM ? {
          ...program,
          programName,
          applicationItems: program.applicationItems.map((item) => item.itemId === WESTERN_REFERENCE
            ? { ...item, label: "St. Michael's reference" }
            : item),
        } : program),
      };
      const text = "I submitted the St. Michael's reference.";
      expect(parseStatus(snapshot, text, WESTERN_REFERENCE, WESTERN_PROGRAM, "submitted_by_sid"))
        .toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_REFERENCE, status: "submitted_by_sid" }] });
    },
  );

  it.each([
    "I have a dentist appointment on Feb 1, 2027. The Arts and Science essay is next.",
    "My band concert is Feb 1, 2027. The Arts and Science essay is the last thing left.",
  ])("accepts an ISO date the model bound to a connective-named item: %s", (text) => {
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: UOFT_ESSAY, programRef: UOFT_PROGRAM, kind: null, label: null,
        status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: text,
        },
      }],
    }, text, new Redactor(), conjunctionSnapshot("principal:connective-wrong-date")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: "2027-02-01" } }] });
  });

  it.each([
    ["I submitted my Arts and Science essay. What's next?", "submitted_by_sid"],
    ["I submitted my Arts and Science essay, so I don't have to think about it anymore", "submitted_by_sid"],
    ["I finished the Arts and Science essay but I haven't proofread it", "ready"],
    ["I submitted my Arts and Science essay today, maybe check it later", "submitted_by_sid"],
  ] as const)("keeps unrelated trailing language out of a connective-named item's status clause: %s", (text, status) => {
    expect(parseStatus(
      conjunctionSnapshot("principal:connective-trailing"), text, UOFT_ESSAY, UOFT_PROGRAM, status,
    )).toMatchObject({ applicationUpdates: [{ itemRef: UOFT_ESSAY, status }] });
    const ordinary = text.replace("Arts and Science essay", "Western essay");
    expect(parseStatus(
      roundTwoSnapshot("principal:ordinary-trailing"), ordinary, WESTERN_ESSAY, WESTERN_PROGRAM, status,
    )).toMatchObject({ applicationUpdates: [{ itemRef: WESTERN_ESSAY, status }] });
  });

  it("accepts a whole-message owner correction for a named submitted item", () => {
    const text = "I didn't submit the Waterloo AIF; reopen it as ready.";
    const snapshot = universitySnapshot("principal:application-model-owner");
    const program = snapshot.programs[0]!;
    const submitted: UniversityTrackerSnapshot = {
      ...snapshot,
      programs: [{
        ...program,
        applicationItems: [{
          ...program.applicationItems[0]!,
          status: "submitted_by_sid",
          submittedAt: NOW.toISOString(),
        }],
      }],
    };
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "ready", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), submitted)).toMatchObject({
      applicationUpdates: [{ status: "ready", statusEvidence: text }],
    });
    expect(universityStateJson(submitted, text)).toContain(ITEM);
    expect(universityStateJson(submitted, text, 0)).toContain(ITEM);
    expect(universityStateJson(submitted, "What should I work on next?")).not.toContain(ITEM);
  });

  it("allows at most one submitted-by-Sid update in one turn", () => {
    const text = "I submitted the Waterloo AIF and Waterloo essay.";
    const snapshot = universitySnapshot("principal:application-model-owner");
    const program = snapshot.programs[0]!;
    const withEssay: UniversityTrackerSnapshot = {
      ...snapshot,
      programs: [{
        ...program,
        applicationItems: [...program.applicationItems, {
          ...program.applicationItems[0]!, itemId: OTHER_ITEM, kind: "essay", label: "Waterloo essay",
        }],
      }],
    };
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [ITEM, OTHER_ITEM].map((itemRef) => ({
        itemRef, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      })),
    }, text, new Redactor(), withEssay)).toThrow("university_application_model_item_invalid");
  });

  it("accepts explicit retirement and reactivation of a named item", () => {
    const retire = "I am not applying, so mark the Waterloo AIF not needed.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "not_needed_by_sid", statusEvidence: retire, dueDate: null,
      }],
    }, retire, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toMatchObject({ applicationUpdates: [{ status: "not_needed_by_sid" }] });

    const restore = "I changed my mind; restore the Waterloo AIF to drafting.";
    const snapshot = universitySnapshot("principal:application-model-owner");
    const program = snapshot.programs[0]!;
    const retired: UniversityTrackerSnapshot = {
      ...snapshot,
      programs: [{
        ...program,
        applicationItems: [{ ...program.applicationItems[0]!, status: "not_needed_by_sid" }],
      }],
    };
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "drafting", statusEvidence: restore, dueDate: null,
      }],
    }, restore, new Redactor(), retired)).toMatchObject({
      applicationUpdates: [{ status: "drafting" }],
    });
  });

  it("refuses labels that smuggle dates or verification claims", () => {
    const text = "Add my Waterloo AIF to the checklist.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: PROGRAM, kind: "supplementary_application",
        label: "Waterloo AIF due 2027-02-01 verified", status: "not_started",
        statusEvidence: text,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: text },
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toThrow("university_application_model_item_invalid");
  });

  it.each([
    ["Add Waterloo AIF February 1st for Waterloo", "Waterloo AIF February 1st"],
    ["Add Waterloo AIF 1 Feb for Waterloo", "Waterloo AIF 1 Feb"],
    ["Add Waterloo AIF 2027/02/01 for Waterloo", "Waterloo AIF 2027/02/01"],
    ["Add the Waterloo AIF official", "Waterloo AIF ✅ official"],
  ])("refuses label metadata or decoration absent from Sid's exact label text: %s", (text, label) => {
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: PROGRAM, kind: "supplementary_application",
        label, status: "not_started", statusEvidence: text,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-label-metadata")))
      .toThrow("university_application_model_item_invalid");
  });

  it.each([
    ["Add the Queen's Commerce reference", "Queen's Commerce reference"],
    ["Add the Queen’s Commerce reference", "Queen's Commerce reference"],
    ["Add the Queen's Commerce reference", "Queen’s Commerce reference"],
    ["Add the Queen’s Commerce reference", "Queen’s Commerce reference"],
    ["Add the video-interview", "video interview"],
    ["Add the video interview", "video-interview"],
  ])("accepts equivalent apostrophes and dashes in a new-item label: %s / %s", (text, label) => {
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: PROGRAM, kind: "reference",
        label, status: "not_started", statusEvidence: text,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-label-punctuation")))
      .toMatchObject({ applicationUpdates: [{ label }] });
  });

  it("allows a non-date title that happens to contain a month and day", () => {
    const text = "Add the May 5 info session essay for Western";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: WESTERN_PROGRAM, kind: "essay",
        label: "May 5 info session essay", status: "not_started", statusEvidence: text,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:application-label-title")))
      .toMatchObject({ applicationUpdates: [{ label: "May 5 info session essay" }] });
  });

  it("accepts the model's clear of a verified date from Sid's whole current message", () => {
    const snapshot = universitySnapshot("principal:application-model-owner");
    const program = snapshot.programs[0]!;
    const dated: UniversityTrackerSnapshot = {
      ...snapshot,
      programs: [{
        ...program,
        applicationItems: [{
          ...program.applicationItems[0]!,
          dueDate: "2027-01-15",
          verification: {
            state: "verified", sourceUrl: "https://example.edu/aif", cycle: "2027", verifiedAt: NOW.toISOString(),
          },
        }],
      }],
    };
    const incidental = "What is next for the Waterloo AIF?";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: incidental },
      }],
    }, incidental, new Redactor(), dated)).toMatchObject({
      applicationUpdates: [{ dueDate: { date: null, evidence: incidental } }],
    });

    const correction = "The Waterloo AIF deadline is wrong; clear the date.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: correction },
      }],
    }, correction, new Redactor(), dated)).toMatchObject({
      applicationUpdates: [{ dueDate: { date: null, evidence: correction } }],
    });
  });

  it.each([
    ["Is the Waterloo AIF due Feb 15, 2027?", "2027-02-15", "Feb 15, 2027"],
    ["My friend thinks the Waterloo AIF might be due Feb 3, 2027", "2027-02-03", "Feb 3, 2027"],
    ["Western essay due Feb 15, 2027 and the Waterloo AIF is on the site", "2027-02-15", "Feb 15, 2027"],
  ])("accepts the model's date change without requiring verification wording: %s", (text, date, evidence) => {
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-date")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date } }] });
  });

  it.each([
    "Don't remove the Waterloo AIF deadline",
    "Is the Waterloo AIF date unknown now?",
  ])("accepts the model's clear of a verified date without requiring correction wording: %s", (text) => {
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-date-clear")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: null } }] });
  });

  it("stores the verification the model gave when Sid restates the same date", () => {
    const text = "The Waterloo AIF is due Feb 1, 2027 right";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: text,
        },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-date-restatement"))).toMatchObject({
      applicationUpdates: [{ dueDate: {
        date: "2027-02-01",
        verification: { state: "unverified", sourceUrl: null, cycle: null },
      } }],
    });
  });

  it("accepts a verified date whose source and cycle the model found in Sid's message", () => {
    const text = "Western essay due Feb 1, 2027 per https://uwo.ca/x";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: WESTERN_ESSAY, programRef: WESTERN_PROGRAM, kind: null, label: null,
        status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "verified", sourceUrl: "https://uwo.ca/x", cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-cycle")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: "2027-02-01" } }] });
  });

  it("keeps a complete HTTPS source inside a verified application-date clause", () => {
    const text = "Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif for the 2027 cycle";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027" },
          evidence: text,
        },
      }],
    }, text, new Redactor(), universitySnapshot("principal:verified-application-date")))
      .toMatchObject({ applicationUpdates: [{ dueDate: {
        date: "2027-02-01",
        verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027" },
      } }] });
  });

  it("accepts the ISO application date the model resolved from all-numeric wording", () => {
    const text = "Add the Waterloo AIF due 03/04/2027.";
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: PROGRAM, kind: "supplementary_application",
        label: "Waterloo AIF", status: "not_started", statusEvidence: text,
        dueDate: { date: "2027-03-04", verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: text },
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: "2027-03-04" } }] });
  });

  it.each([
    "Western essay due February 1st, 2027",
    "Western essay due Feb. 1, 2027",
    "Western essay due 1 February 2027",
  ])("accepts an unambiguous named application date: %s", (text) => {
    expect(parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: WESTERN_ESSAY, programRef: WESTERN_PROGRAM, kind: null, label: null,
        status: null, statusEvidence: null,
        dueDate: {
          date: "2027-02-01",
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          evidence: text,
        },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:application-date-positive")))
      .toMatchObject({ applicationUpdates: [{ dueDate: { date: "2027-02-01" } }] });
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

  it("normalizes and bounds an ordinary fallback reply instead of ending the turn", async () => {
    const principalId = "principal:application-model-long-fallback";
    const model = new SequenceModel([`Cafe\u0301 ${"x".repeat(25_000)}`]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: {
        readSnapshot: async () => { throw new Error("migration missing"); },
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });

    const reply = await collect(adapter.stream(input(principalId, "Tell me something useful.")));
    expect(reply.startsWith("Café ")).toBe(true);
    expect(reply).toBe(reply.normalize("NFC"));
    expect(new TextEncoder().encode(reply).byteLength).toBeLessThanOrEqual(24_000);
  });

  it.each([
    [false, "I've spent some time thinking through your essay outline."],
    [false, "We're calling this the draft stage for now."],
    [false, "I asked earlier which programs you're considering."],
    [false, "I'm asking because the Waterloo AIF is still unverified."],
    [false, "As I asked before, which essay prompt did you pick?"],
    [false, "Once your Waterloo AIF is submitted, Waterloo emails a confirmation."],
    [false, "After your transcript request is sent, your school has to process it."],
    [false, "Nice, you said your Waterloo AIF is submitted. I noted it as submitted by you."],
    [false, "Got it. Your Waterloo AIF was submitted by you, so it's off the list."],
    [false, "I sent you a summary above."],
    [false, "I've requested that you double-check the date on the Waterloo site."],
    [false, "Make sure the essay is submitted before the deadline."],
    [false, "Ask Ms. Chen whether your reference was sent."],
    [false, "Check whether your transcript has been sent by guidance."],
    [false, "I called it the Waterloo AIF in your tracker."],
    [false, "We're asking OUAC-style questions to build your list."],
    [false, "I'm filing this under the Western program."],
    [false, "I asked earlier which university you are aiming for."],
    [false, "I asked earlier which school you are applying from."],
    [false, "I told you the university deadline is Feb 1, so start now."],
    [false, "I called it your school essay in the tracker."],
    [false, "I asked about the transcript because your guidance office handles it, not you."],
    [false, "I shared a checklist with you; your teacher may want a different one."],
    [false, "I sent you the list above so your counsellor can review it with you."],
    [false, "Your essay is in good shape."],
    [false, "Your personal statement is in your drafts folder."],
    [false, "Your application is in progress, not submitted."],
    [false, "Your transcript request is in your school's queue, so you still have to confirm it."],
    [false, "Your Waterloo AIF is in the tracker as drafting."],
    [false, "I've applied your feedback to the outline."],
    [false, "I booked nothing; only you can book the interview."],
    [true, "I've put in a note about the Waterloo deadline."],
    [false, "I've applied your edits to the outline."],
    [false, "I've applied your changes to the tracker."],
    [false, "I've applied your notes from last night."],
    [false, "I applied the same structure to the second paragraph."],
    [false, "I've applied a stricter word limit to the draft."],
    [true, "I've put in a placeholder due date until you confirm it."],
    [true, "I've put in two reminders for the Waterloo deadline."],
    [true, "I've put in the tracker that your teacher owes you a reference."],
    [false, "I booked no time for this; you decide when to write."],
    [false, "I've booked out nothing on your calendar."],
    [false, "I asked whether you want me to draft a note to your teacher."],
    [false, "I asked earlier if the reference came back from Ms. Chen."],
    [false, "I asked you to confirm the deadline with the university."],
    [false, "I told you the transcript is with the school, so chase it tomorrow."],
    [false, "I told you what to say to your counsellor."],
    [false, "I've requested nothing from the school on your behalf."],
    [false, "Submitted. Is that what you meant?"],
    [true, "Your Waterloo AIF has now been submitted."],
    [true, "Your Waterloo AIF got submitted."],
    [true, "Your AIF is now in with Waterloo."],
    [true, "Submitted! Your Waterloo AIF is in."],
    [true, "I've handed in your AIF."],
    [true, "I've completed your OUAC submission."],
    [true, "I have applied to Waterloo for you."],
    [true, "I've put in the transcript request."],
    [true, "I've let Ms. Chen know you need a reference."],
    [true, "I told your counsellor about the transcript."],
    [true, "I shared your essay with Ms. Chen."],
    [true, "I just texted Ms. Chen."],
    [true, "I booked your Waterloo interview."],
    [true, "Ms. Chen has been contacted."],
    [true, "I've emailed your essay to Ms. Chen."],
    [true, "I've requested your reference from Ms. Chen."],
    [true, "I've requested your transcript from the school."],
    [true, "I've messaged your reference request to Ms. Chen."],
    [true, "I've requested the reference from your teacher."],
    [true, "I put in your scholarship application."],
    [true, "I've put in your essay."],
    [true, "I put in the scholarship for you."],
    [true, "I've applied on your behalf."],
    [true, "I've applied you to Western."],
    [true, "I've booked your guidance meeting."],
    [true, "I've sent your essay, as promised, to Ms. Chen."],
    [true, "I've forwarded your reference form, finally, to Ms. Chen."],
    [true, "I've shared your draft, this morning, with your teacher."],
    [true, "I've sent your transcript request; it went to the guidance office."],
    [true, "I've emailed your essay, at last, to Ms. Chen."],
    [true, "I've reached out; your counsellor will send the transcript."],
    [true, "I've emailed her already, so Ms. Chen has your essay."],
    [true, "I've notified them; the school has your form now."],
    [true, "I've asked for it, and your teacher said yes."],
    [true, "I've sent it off, so the guidance office has your transcript request."],
    [true, "I've requested it, and Ms. Chen will upload the reference."],
    [true, "I've sent your reference form over, and Ms. Chen has it now."],
  ] as const)("classifies an ordinary reply without hiding benign guidance: %s %s", async (blocked, reply) => {
    const principalId = "principal:application-model-reply-guard";
    const adapter = new SchoolCatchupModelAdapter({
      model: new SequenceModel([reply]),
      repository: {
        readSnapshot: async () => { throw new Error("migration missing"); },
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });
    await expect(collect(adapter.stream(input(principalId, "Help with my application.")))).resolves.toBe(blocked
      ? "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap."
      : reply);
  });

  it("keeps a full cap of submitted and retired items inside the structured prompt budget", async () => {
    const principalId = "principal:application-model-full-cap";
    let sequence = 0;
    const programs = Array.from({ length: 16 }, (_, programIndex) => {
      const programId = newUlid(new Date(NOW.getTime() + sequence++));
      return {
        programId,
        university: `University ${programIndex}`,
        campus: null,
        programName: `Program ${programIndex}`,
        ouacCode: null,
        verification: { state: "unverified" as const, sourceUrl: null, cycle: "2027", verifiedAt: null },
        requirements: [],
        dates: [],
        applicationItems: Array.from({ length: 16 }, (_, itemIndex) => ({
          itemId: newUlid(new Date(NOW.getTime() + sequence++)),
          kind: "essay" as const,
          label: `Application item ${programIndex}-${itemIndex} ${"x".repeat(100)}`,
          status: itemIndex % 2 === 0 ? "submitted_by_sid" as const : "not_needed_by_sid" as const,
          dueDate: "2027-01-15",
          verification: {
            state: "verified" as const,
            sourceUrl: `https://example.edu/${"path/".repeat(20)}${programIndex}/${itemIndex}`,
            cycle: "2027",
            verifiedAt: NOW.toISOString(),
          },
          sourceTurnId: TURN,
          submittedAt: itemIndex % 2 === 0 ? NOW.toISOString() : null,
          updatedAt: NOW.toISOString(),
        })),
      };
    });
    const model = new SequenceModel([JSON.stringify({
      schoolEngaged: false,
      universityEngaged: false,
      reply: "Still here.",
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => ({ principalId, programs }),
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });

    await expect(collect(adapter.stream(input(principalId, "What should I work on?")))).resolves.toBe("Still here.");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.userText).toContain("university_state_json=");
    expect(model.requests[0]?.userText).not.toContain("Application item 0-0");
    expect(new TextEncoder().encode(model.requests[0]?.userText ?? "").byteLength).toBeLessThanOrEqual(48_000);
  });

  it("keeps twelve named programs with full active rows inside the structured prompt budget", async () => {
    const principalId = "principal:application-model-named-programs";
    let sequence = 0;
    const itemIds: Ulid[] = [];
    const programs = Array.from({ length: 12 }, (_, programIndex) => {
      const programId = newUlid(new Date(NOW.getTime() + sequence++));
      const programItems = Array.from({ length: 6 }, (_, itemIndex) => {
        const itemId = newUlid(new Date(NOW.getTime() + sequence++));
        itemIds.push(itemId);
        return {
          itemId,
          kind: itemIndex < 4 ? "requirement" as const : "date" as const,
          label: `Program item ${programIndex}-${itemIndex}`.padEnd(40, "x"),
          detail: itemIndex < 4 ? "d".repeat(200) : null,
          date: itemIndex < 4 ? null : "2027-01-15",
          verification: {
            state: "verified" as const,
            sourceUrl: `https://university${programIndex}.example/${itemIndex}/${"x".repeat(45)}`,
            cycle: "2027 cycle",
            verifiedAt: NOW.toISOString(),
          },
        };
      });
      const applicationItems = Array.from({ length: 6 }, (_, itemIndex) => {
        const itemId = newUlid(new Date(NOW.getTime() + sequence++));
        itemIds.push(itemId);
        return {
          itemId,
          kind: "essay" as const,
          label: `Application item ${programIndex}-${itemIndex}`.padEnd(40, "x"),
          status: "drafting" as const,
          dueDate: "2027-02-01",
          verification: {
            state: "verified" as const,
            sourceUrl: `https://university${programIndex}.example/app/${itemIndex}/${"x".repeat(45)}`,
            cycle: "2027 cycle",
            verifiedAt: NOW.toISOString(),
          },
          sourceTurnId: TURN,
          submittedAt: null,
          updatedAt: NOW.toISOString(),
        };
      });
      return {
        programId,
        university: `University of Named Place ${programIndex}`,
        campus: null,
        programName: `Named Honours Program ${programIndex}`,
        ouacCode: "WXY",
        verification: {
          state: "verified" as const,
          sourceUrl: `https://university${programIndex}.example/program`,
          cycle: "2027 cycle",
          verifiedAt: NOW.toISOString(),
        },
        requirements: programItems.slice(0, 4),
        dates: programItems.slice(4),
        applicationItems,
      };
    });
    const model = new SequenceModel([JSON.stringify({
      schoolEngaged: false,
      universityEngaged: false,
      reply: "Still structured and named.",
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => ({ principalId, programs }),
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });
    const shortlist = `My list is ${programs.map((program) => program.programName).join(", ")}.`;

    await expect(collect(adapter.stream(input(principalId, shortlist))))
      .resolves.toBe("Still structured and named.");
    const prompt = model.requests[0]?.userText ?? "";
    expect(prompt).toContain("university_state_json=");
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(48_000);
    for (const itemId of itemIds) expect(prompt).toContain(itemId);
  });

  it("keeps 128 active application items and 128 program items inside the structured prompt budget", async () => {
    const principalId = "principal:application-model-active-cap";
    let sequence = 0;
    const itemIds: Ulid[] = [];
    const sourceUrl = (programIndex: number, itemIndex: number): string =>
      `https://university${programIndex}.example/${String(itemIndex).padStart(2, "0")}/${"x".repeat(45)}`;
    const programs = Array.from({ length: 16 }, (_, programIndex) => {
      const programId = newUlid(new Date(NOW.getTime() + sequence++));
      const programItems = Array.from({ length: 8 }, (_, itemIndex) => {
        const itemId = newUlid(new Date(NOW.getTime() + sequence++));
        itemIds.push(itemId);
        return {
          itemId,
          kind: itemIndex < 4 ? "requirement" as const : "date" as const,
          label: `Program item ${programIndex}-${itemIndex}`.padEnd(40, "x"),
          detail: itemIndex < 4 ? "d".repeat(200) : null,
          date: itemIndex < 4 ? null : "2027-01-15",
          verification: {
            state: "verified" as const,
            sourceUrl: sourceUrl(programIndex, itemIndex),
            cycle: "2027 cycle",
            verifiedAt: NOW.toISOString(),
          },
        };
      });
      const applicationItems = Array.from({ length: 8 }, (_, itemIndex) => {
        const itemId = newUlid(new Date(NOW.getTime() + sequence++));
        itemIds.push(itemId);
        return {
          itemId,
          kind: "essay" as const,
          label: `Application item ${programIndex}-${itemIndex}`.padEnd(40, "x"),
          status: "drafting" as const,
          dueDate: "2027-02-01",
          verification: {
            state: "verified" as const,
            sourceUrl: sourceUrl(programIndex, itemIndex + 8),
            cycle: "2027 cycle",
            verifiedAt: NOW.toISOString(),
          },
          sourceTurnId: TURN,
          submittedAt: null,
          updatedAt: NOW.toISOString(),
        };
      });
      return {
        programId,
        university: `University of Place ${programIndex}`,
        campus: null,
        programName: `Honours Program ${programIndex}`,
        ouacCode: "WXY",
        verification: {
          state: "verified" as const,
          sourceUrl: sourceUrl(programIndex, 99),
          cycle: "2027 cycle",
          verifiedAt: NOW.toISOString(),
        },
        requirements: programItems.slice(0, 4),
        dates: programItems.slice(4),
        applicationItems,
      };
    });
    const model = new SequenceModel([JSON.stringify({
      schoolEngaged: false,
      universityEngaged: false,
      reply: "Still structured.",
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [],
    })]);
    const adapter = new SchoolCatchupModelAdapter({
      model,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: {
        readSnapshot: async () => ({ principalId, programs }),
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });

    await expect(collect(adapter.stream(input(principalId, "What should I work on?"))))
      .resolves.toBe("Still structured.");
    const prompt = model.requests[0]?.userText ?? "";
    expect(prompt).toContain("university_state_json=");
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(48_000);
    expect(prompt).not.toContain("d".repeat(200));
    for (const itemId of itemIds) expect(prompt).toContain(itemId);
  });

  it("lets an ordinary turn pass with a warning when a cap-valid workflow tracker exceeds the prompt budget", async () => {
    const principalId = "principal:application-model-overflow-escape";
    let sequence = 0;
    const programs = Array.from({ length: 16 }, (_, programIndex) => {
      const programId = newUlid(new Date(NOW.getTime() + sequence++));
      const applicationItems = Array.from({ length: 8 }, (_, itemIndex) => ({
        itemId: newUlid(new Date(NOW.getTime() + sequence++)),
        kind: "essay" as const,
        label: `Application item ${programIndex}-${itemIndex}`.padEnd(120, "x"),
        status: "drafting" as const,
        dueDate: "2027-02-01",
        verification: { state: "unverified" as const, sourceUrl: null, cycle: null, verifiedAt: null },
        sourceTurnId: TURN,
        submittedAt: null,
        updatedAt: NOW.toISOString(),
      }));
      return {
        programId,
        university: `University ${programIndex}`,
        campus: null,
        programName: `Program ${programIndex}`,
        ouacCode: null,
        verification: { state: "unverified" as const, sourceUrl: null, cycle: null, verifiedAt: null },
        requirements: Array.from({ length: 8 }, (_, itemIndex) => ({
          itemId: newUlid(new Date(NOW.getTime() + sequence++)),
          kind: "requirement" as const,
          label: `Requirement ${programIndex}-${itemIndex}`.padEnd(120, "r"),
          detail: "Owner-reported requirement.",
          date: null,
          verification: { state: "unverified" as const, sourceUrl: null, cycle: null, verifiedAt: null },
        })),
        dates: [],
        applicationItems,
        workflowItems: applicationItems.map((application, itemIndex) => ({
          workflowId: newUlid(new Date(NOW.getTime() + sequence++)),
          eventId: newUlid(new Date(NOW.getTime() + sequence++)),
          revision: 1,
          applicationItemId: application.itemId,
          kind: "contact_step" as const,
          label: `University ${programIndex} step ${itemIndex}`.padEnd(120, "w"),
          owner: "sid" as const,
          status: "prepared" as const,
          preparedDetails: null,
          executionBoundary: "owner_only" as const,
          deadline: { date: null, instant: null, timeZone: null,
            verification: { state: "unverified" as const, sourceUrl: null, cycle: null, verifiedAt: null } },
          sourceTurnId: TURN,
          updatedAt: NOW.toISOString(),
        })),
      };
    });
    const ordinaryModel = new SequenceModel(["Ordinary answer."]);
    const adapter = new SchoolCatchupModelAdapter({
      model: ordinaryModel,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: { readSnapshot: async () => ({ principalId, programs }), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(), timeZone: "America/Toronto", now: () => NOW, ownerPrincipalId: principalId,
    });

    await expect(collect(adapter.stream(input(principalId, "ok")))).resolves.toBe(
      "Ordinary answer.\n\nYour school and university tracker is too large for one safe update. I didn't save anything from this message; name one course, school, program, or application item and try again.",
    );
    expect(ordinaryModel.requests).toHaveLength(1);

    // The keyword gate is gone: a message that names the tracker now reaches the
    // model too, with the same notice, instead of a keyword list deciding it was
    // "about" the tracker and answering without the model.
    const trackerModel = new SequenceModel(["I can't change that from here."]);
    const trackerAdapter = new SchoolCatchupModelAdapter({
      model: trackerModel,
      repository: { readSnapshot: async () => schoolSnapshot(principalId), applyOwnerPlan: async () => undefined },
      universityRepository: { readSnapshot: async () => ({ principalId, programs }), applyOwnerPlan: async () => undefined },
      redactor: new Redactor(), timeZone: "America/Toronto", now: () => NOW, ownerPrincipalId: principalId,
    });
    await expect(collect(trackerAdapter.stream(input(principalId, "Mark every University 3 step not needed."))))
      .resolves.toBe(
        "I can't change that from here.\n\nYour school and university tracker is too large for one safe update. I didn't save anything from this message; name one course, school, program, or application item and try again.",
      );
    expect(trackerModel.requests).toHaveLength(1);
  });
});
