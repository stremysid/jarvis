import { describe, expect, it } from "vitest";
import { OWNER_AGENT_SYSTEM_PROMPT } from "../../src/agent/owner-agent-core.js";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";

const ACTION_REPLACEMENT = "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.";

// Reconstructed from Sid's review examples/categories; the original reviewer
// probe file was not supplied. Keep its provenance distinct from that artifact.
const REVIEW_FALSE_CLAIMS = [
  "I called Mrs. Patel.",
  "I called Coach Lee.",
  "I called the principal.",
  "I called the registrar.",
  "I called admissions.",
  "I called the office.",
  "I called your counselor.",
  "I called your teachers.",
  "I called the professor.",
  "I called the TA.",
  "I called your tutor.",
  "I called your doctor.",
  "I called the bank.",
  "I told Alex about it.",
  "I asked Jamie for a response.",
  "I called him.",
  "I told her.",
  "I asked them for a reply.",
  "Ms. Patel needed an update. I told her.",
  "We called him.",
  "We told her.",
  "We asked them for a response.",
  "I've applied for the scholarship.",
  "I applied for the bursary.",
  "I applied to Harvard.",
  "I applied to U of T.",
  "I applied for the job.",
  "I've applied for you.",
  "I applied for the scholarship for you.",
  "Applied for you.",
  "Applied for the scholarship for you.",
  "We put in the request.",
  "We requested your transcript.",
  "We booked your appointment.",
  "We scheduled the interview.",
  "We shared it with the class.",
  "I saved it.",
  "I saved that to memory.",
  "I've added it to your calendar.",
  "I saved your study plan.",
  "I saved your spot.",
  "We saved your seat.",
  "I've added you to the waitlist.",
  "We added you to the group chat.",
  "I added you to the course.",
  "We've added it to your timetable.",
  "I saved the notes to your drive.",
  "I saved it in the folder.",
  "I added it to the list.",
  "I put in the request.",
  "I scheduled it.",
  "We scheduled it.",
  "We put in a reminder.",
  "I saved your seat below.",
  "I added a note above.",
  "I saved the example to memory.",
  "I called him about the example.",
  "I told her about the formula.",
  "I asked them about the equation.",
  "I called the principal about the paragraph.",
  "I applied the teacher's rule.",
  "I've applied for the scholarship below.",
  "I sent it.",
  "We submitted it.",
  "I emailed it.",
  "We paid it.",
  "I uploaded it.",
  "We registered it.",
  "I contacted it.",
  "We forwarded it.",
] as const;

describe("tutoring review regressions", () => {
  it.each(REVIEW_FALSE_CLAIMS)("catches the review-derived false claim: %s", (reply) => {
    const guarded = guardReplyClaims(reply);
    expect(guarded).not.toBe(reply);
    expect(guarded).toContain(ACTION_REPLACEMENT);
    expect(guarded).not.toContain("I told her.");
  });

  it.each([
    "I added an example showing an application of the chain rule.",
    "I added a route to the Flask application below.",
    "I added a stronger hook to the application essay below.",
    "We added a 200 ms timeout.",
    "I added an email validation function.",
    "We called the parent constructor in the example below.",
    "I applied the rubric your teacher uses to the thesis below.",
    "I applied the rubric that your teacher uses to the paragraph below.",
    "We called the function recursively in this example.",
    "We added a loop to walk through each variable.",
    "We applied the formula to the return value below.",
  ])("keeps the worked code or essay explanation: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it.each(["rule", "law", "formula", "method", "theorem"])(
    "keeps a worked application of the %s for the owner",
    (topic) => {
      const reply = `I applied the ${topic} for you.`;
      expect(guardReplyClaims(reply)).toBe(reply);
    },
  );

  it.each(["saved", "added", "put in", "scheduled"])(
    "requires a receipt before the internal %s claim can survive",
    (verb) => {
      const reply = `I ${verb} it.`;
      expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
      expect(guardReplyClaims(reply, { receiptedInternalSentences: [reply] })).toBe(reply);
    },
  );

  it.each(["memory", "notes", "calendar", "plan", "drive", "folder", "list", "waitlist", "course", "timetable", "spot", "seat", "chat"])(
    "does not let an example marker excuse a save to the %s",
    (target) => {
      expect(guardReplyClaims(`I saved the example to your ${target}.`)).toBe(ACTION_REPLACEMENT);
    },
  );

  it.each(["Mrs. Patel", "Coach Lee", "the principal", "the registrar", "admissions", "the office", "your counselor", "your teachers", "the professor", "the TA", "your tutor", "your doctor", "the bank", "the school", "the university", "OUAC", "Alex", "him", "her", "them"])(
    "does not let an example marker excuse contact with %s",
    (target) => {
      expect(guardReplyClaims(`I called ${target} about the example.`)).toBe(ACTION_REPLACEMENT);
    },
  );

  it("does not borrow a worked marker from another sentence to excuse an unreceipted save", () => {
    const explanation = "We applied the chain rule.";
    expect(guardReplyClaims(`${explanation} I saved it.`)).toBe(`${explanation}\n\n${ACTION_REPLACEMENT}`);
  });

  it("limits the applied-for-you exemption to its own sentence", () => {
    const explanation = "Applied the theorem for you.";
    expect(guardReplyClaims(`${explanation} I applied for you.`)).toBe(`${explanation}\n\n${ACTION_REPLACEMENT}`);
  });

  it("keeps a worked applied-for-you sentence when only the next sentence names a person", () => {
    const reply = "Applied the theorem for you. Your teacher can check the example.";
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it("does not excuse a scholarship application that also mentions an example", () => {
    expect(guardReplyClaims("Applied for the scholarship for you, as in the example below.")).toBe(ACTION_REPLACEMENT);
  });

  it("keeps a worked sentence even when another sentence names a person", () => {
    const reply = "Your teacher set this problem. We added 5 to both sides.";
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it("keeps a person elsewhere in the sentence after recognizing a benign rubric phrase", () => {
    const reply = "I called her to explain the rubric your teacher uses in the example.";
    expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
  });

  it("does not turn explicit sending into a worked explanation", () => {
    expect(guardReplyClaims("We sent the example below.")).toBe(ACTION_REPLACEMENT);
  });

  it("does not give a singular scheduling claim the inclusive-we teaching exception", () => {
    expect(guardReplyClaims("I scheduled the example below.")).toBe(ACTION_REPLACEMENT);
  });

  it("tells the owner model that worked explanations need no action receipt", () => {
    expect(OWNER_AGENT_SYSTEM_PROMPT).toContain("Worked explanations, including calculations, applying a rule, and adding an example below, are not actions and need no receipt.");
  });
});
