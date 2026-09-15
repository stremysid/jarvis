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
    "I've sent your reference request to Ms. Chen.",
    "I've now submitted your Waterloo AIF.",
    "Done, your Waterloo AIF is submitted.",
    "Your transcript request has been sent to the guidance office.",
    "I've gone ahead and submitted the scholarship form.",
  ])("blocks an ordinary fallback external-action claim: %s", async (claim) => {
    const principalId = "principal:application-model-claim-fallback";
    const adapter = new SchoolCatchupModelAdapter({
      model: new SequenceModel([claim]),
      repository: {
        readSnapshot: async () => { throw new Error("migration missing"); },
        applyOwnerPlan: async () => undefined,
      },
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
    });
    await expect(collect(adapter.stream(input(principalId, "Help with my application."))))
      .resolves.toBe("I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.");
  });

  it.each([
    "I've spent some time thinking through your essay outline.",
    "We're calling this the draft stage for now.",
  ])("keeps a benign ordinary fallback reply: %s", async (reply) => {
    const principalId = "principal:application-model-benign-fallback";
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
    await expect(collect(adapter.stream(input(principalId, "Help with my application.")))).resolves.toBe(reply);
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
});
