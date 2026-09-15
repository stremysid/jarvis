// Reviewer probes for PR #52. Each asserts that a defect EXISTS (the parser accepts
// an update it should refuse). After a fix, every probe here must fail.
import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/security/redaction.js";
import { parseOwnerUniversityPlan } from "../../src/university/university-tracker-model.js";

const PROGRAM = "01k5fb9pg00000000000000d01";
const AIF = "01k5fb9pg00000000000000d02";
const ESSAY = "01k5fb9pg00000000000000d03";

function plan(message: string, update: Record<string, unknown>) {
  return parseOwnerUniversityPlan({
    engaged: true,
    programUpdates: [],
    applicationUpdates: [{
      itemRef: ESSAY,
      programRef: PROGRAM,
      kind: null,
      label: null,
      dueDate: null,
      ...update,
    }],
  }, message, new Redactor());
}

describe("zzreviewerpr52", () => {
  it("P1 crossitem: one positive report lets a different item become submitted_by_sid", () => {
    const message = "I submitted my Waterloo AIF. I haven't started the Western essay yet.";
    const parsed = plan(message, { itemRef: ESSAY, status: "submitted_by_sid", statusEvidence: message });
    expect(parsed.applicationUpdates[0]?.status).toBe("submitted_by_sid");
    expect(AIF).not.toBe(ESSAY);
  });

  it("P2 negation: a cropped excerpt of a negated sentence moves an item to drafting", () => {
    const message = "I haven't started the Western essay yet";
    const parsed = plan(message, { status: "drafting", statusEvidence: "started the Western essay" });
    expect(parsed.applicationUpdates[0]?.status).toBe("drafting");
  });

  it("P3 retracted: a retracted submission report is accepted as submitted_by_sid", () => {
    const message = "I just submitted the Western essay. Actually no, the portal crashed, so it didn't go through.";
    const parsed = plan(message, { status: "submitted_by_sid", statusEvidence: message });
    expect(parsed.applicationUpdates[0]?.status).toBe("submitted_by_sid");
  });

  it("P4 question: a quoted question counts as a positive report", () => {
    const message = "Counsellor asked me: I submitted the transcript request, right? Not sure.";
    const parsed = plan(message, { status: "submitted_by_sid", statusEvidence: message });
    expect(parsed.applicationUpdates[0]?.status).toBe("submitted_by_sid");
  });
});
