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

  it("P1 refuses a submission report for a different application item", () => {
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
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: OTHER_ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), withEssay)).toThrow("university_application_model_item_invalid");
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

  it("P3 refuses a retracted submission report", () => {
    const text = "I just submitted the Waterloo AIF. Actually no, the portal crashed, so it didn't go through.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toThrow("university_application_model_item_invalid");
  });

  it("P4 refuses a submitted claim inside a quoted question", () => {
    const text = "Counsellor asked me: I submitted the Waterloo AIF, right? Not sure.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null,
        status: "submitted_by_sid", statusEvidence: text, dueDate: null,
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toThrow("university_application_model_item_invalid");
  });

  it.each([
    "Mom says: I submitted the Western essay for you",
    "From guidance: I uploaded your Western essay today",
    "Hi Sid. I have uploaded your Western essay to OUAC. Ms. Lee",
  ])("refuses common forwarded or third-party submission wording: %s", (text) => {
    expect(() => parseStatus(
      roundTwoSnapshot("principal:reported-submission"),
      text,
      WESTERN_ESSAY,
      WESTERN_PROGRAM,
      "submitted_by_sid",
    )).toThrow("university_application_model_item_invalid");
  });

  it.each([
    ["Keep the Queen's scholarship", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["I need the Queen's scholarship after all", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["Don't restore the Queen's scholarship, I never submitted it", QUEENS_SCHOLARSHIP, QUEENS_PROGRAM, "submitted_by_sid"],
    ["I submitted my Waterloo AIF and started the Western essay.", WESTERN_ESSAY, WESTERN_PROGRAM, "submitted_by_sid"],
    ["I've started my Waterloo AIF but haven't started the Western essay", ITEM, PROGRAM, "not_started"],
    ["I finished the Waterloo AIF and started the Western essay", WESTERN_ESSAY, WESTERN_PROGRAM, "ready"],
    ["I finished the Waterloo AIF and started the Western essay", ITEM, PROGRAM, "drafting"],
  ] as const)("binds each status report to the one item named in its clause: %s", (text, itemRef, programRef, status) => {
    expect(() => parseStatus(roundTwoSnapshot("principal:round-two-status"), text, itemRef, programRef, status))
      .toThrow("university_application_model_item_invalid");
  });

  it("keeps the submission clause valid for the item it actually names", () => {
    const text = "I submitted my Waterloo AIF and started the Western essay.";
    expect(parseStatus(roundTwoSnapshot("principal:round-two-positive"), text, ITEM, PROGRAM, "submitted_by_sid"))
      .toMatchObject({ applicationUpdates: [{ itemRef: ITEM, status: "submitted_by_sid" }] });
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
  ] as const)("refuses negated or cross-item retirement and reactivation: %s", (text, itemRef, programRef, status) => {
    expect(() => parseStatus(roundTwoSnapshot("principal:round-two-retirement"), text, itemRef, programRef, status))
      .toThrow("university_application_model_item_invalid");
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
  ])("refuses a conditional, questioned, or cross-clause submitted correction: %s", (text) => {
    expect(() => parseStatus(roundTwoSnapshot("principal:round-two-correction"), text, UOFT_ESSAY, UOFT_PROGRAM, "drafting"))
      .toThrow("university_application_model_item_invalid");
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

  it("requires a named whole-message correction before clearing a verified date", () => {
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
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: incidental },
      }],
    }, incidental, new Redactor(), dated)).toThrow("university_application_model_date_invalid");

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
  ])("refuses an unsupported change to an existing verified date: %s", (text, date, evidence) => {
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-date")))
      .toThrow("university_application_model_date_invalid");
  });

  it.each([
    "Don't remove the Waterloo AIF deadline",
    "Is the Waterloo AIF date unknown now?",
  ])("refuses a negated or questioned verified-date clear: %s", (text) => {
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: ITEM, programRef: PROGRAM, kind: null, label: null, status: null, statusEvidence: null,
        dueDate: { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
      }],
    }, text, new Redactor(), roundTwoSnapshot("principal:round-two-date-clear")))
      .toThrow("university_application_model_date_invalid");
  });

  it("keeps official verification when Sid restates the same date without a source", () => {
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
        verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027" },
      } }],
    });
  });

  it("requires a verified cycle phrase outside the date's own year", () => {
    const text = "Western essay due Feb 1, 2027 per https://uwo.ca/x";
    expect(() => parseOwnerUniversityPlan({
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
      .toThrow("university_application_model_date_invalid");
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

  it("refuses an ambiguous all-numeric application date", () => {
    const text = "Add the Waterloo AIF due 03/04/2027.";
    expect(() => parseOwnerUniversityPlan({
      engaged: true,
      programUpdates: [],
      applicationUpdates: [{
        itemRef: "new-item-1", programRef: PROGRAM, kind: "supplementary_application",
        label: "Waterloo AIF", status: "not_started", statusEvidence: text,
        dueDate: { date: "2027-03-04", verification: { state: "unverified", sourceUrl: null, cycle: "2027" }, evidence: text },
      }],
    }, text, new Redactor(), universitySnapshot("principal:application-model-owner")))
      .toThrow("university_application_model_date_invalid");
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
    [false, "I've put in a note about the Waterloo deadline."],
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
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [],
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
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [],
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
      courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [],
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
});
