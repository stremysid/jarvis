import { describe, expect, it } from "vitest";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";

const ACTION_REPLACEMENT = "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.";

describe("tutoring reply claims", () => {
  it.each([
    "We added 5 to both sides, so x = 3.",
    "We applied the chain rule.",
    "We've applied the quadratic formula, so the roots are 2 and 3.",
    "We asked what happens when x approaches zero.",
  ])("keeps the complete maths explanation the model declares: %s", (reply) => {
    expect(guardReplyClaims(reply, { workedExplanations: [reply] })).toBe(reply);
  });

  // Reviewer round 2, finding 2: a worked-explanation declaration must never
  // exempt a sentence the external-completion guard matches. "applied ... for
  // you" is the external-application grammar, so a declared sentence phrased
  // that way is conservatively replaced rather than trusted. This fails closed
  // and is a deliberate cost of removing the code-side worked-object grammar.
  it.each([
    "I applied the chain rule for you.",
    "Applied the chain rule for you.",
  ])("conservatively replaces an applied-for-you sentence even when declared worked: %s", (reply) => {
    expect(guardReplyClaims(reply, { workedExplanations: [reply] })).toBe(ACTION_REPLACEMENT);
  });

  it.each([
    "We applied the ideal gas law to find the volume.",
    "I applied the concentration formula to find the result.",
    "We added a worked example of balancing the equation below.",
  ])("keeps the complete chemistry explanation the model declares: %s", (reply) => {
    expect(guardReplyClaims(reply, { workedExplanations: [reply] })).toBe(reply);
  });

  it.each([
    "I added a worked example below.",
    "I've added a transition between the two ideas below.",
    "I applied the rubric to explain why this thesis needs evidence.",
  ])("keeps the complete essay feedback the model declares: %s", (reply) => {
    expect(guardReplyClaims(reply, { workedExplanations: [reply] })).toBe(reply);
  });

  // Reviewer round 2, finding 2: a self-applied worked-explanation label must
  // never bypass the guard for a fact code owns. Jarvis has no hand that
  // reaches outside him, so these are replaced whether or not the model
  // declares them worked.
  it.each([
    "I submitted your essay to OUAC.",
    "I emailed Ms. Patel about the extension.",
    "I paid the Waterloo application fee.",
    "I contacted my counsellor about the reference.",
    "Your application has been submitted.",
  ])("a worked declaration never exempts an external completion: %s", (reply) => {
    expect(guardReplyClaims(reply, { workedExplanations: [reply] })).toBe(ACTION_REPLACEMENT);
  });

  it.each([
    "I added the attachment to the email.",
    "We added your teacher to the email.",
    "I applied to the school.",
    "We've applied through OUAC.",
    "I called your teacher.",
    "We called the school.",
    "I told the teacher about the deadline.",
    "We've told OUAC about the correction.",
    "I asked the school for an extension.",
    "We asked for it, and your teacher agreed.",
    "I saved your application.",
    "We've saved the email.",
    "I added the fee to your application.",
    "I told your mom.",
    "I asked for an extension on the chem lab.",
    "I've applied on your behalf.",
    "I've applied you to Western.",
    "Applied to OUAC for you.",
    "Your application: applied for you.",
    "We put in your application.",
    "We shared your essay with the teacher.",
    "We booked the school interview.",
    "We scheduled the fee payment.",
    "We requested the email.",
    "The teacher agreed, so we called again.",
    "I saved your school plan.",
    "I added your email.",
  ])("removes a contextual action claim with an external target: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
  });

  it.each(["sent", "submitted", "emailed", "paid", "uploaded", "registered", "contacted", "forwarded"])(
    "still removes an explicit external action with only a pronoun object after %s",
    (verb) => {
      for (const subject of ["I", "We", "I've", "We've", "I’ve", "We’ve", "Jarvis"]) {
        expect(guardReplyClaims(`${subject} ${verb} it.`)).toBe(ACTION_REPLACEMENT);
      }
    },
  );

  it("keeps tutoring sentences around a false claim without borrowing the next sentence's target", () => {
    const reply = "We added 5 to both sides, so x = 3. I emailed your teacher. I added a worked example below.";
    expect(guardReplyClaims(reply, {
      workedExplanations: ["We added 5 to both sides, so x = 3.", "I added a worked example below."],
    })).toBe(
      `We added 5 to both sides, so x = 3. I added a worked example below.\n\n${ACTION_REPLACEMENT}`,
    );
  });

  it("does not treat the previous sentence's school as a target of the worked explanation", () => {
    const reply = "This is practice for school. We applied the chain rule.";
    expect(guardReplyClaims(reply, { workedExplanations: ["We applied the chain rule."] })).toBe(reply);
  });

  it("keeps a request for a password after a worked explanation, because Sid may be asked for one", () => {
    const explanation = "We added 5 to both sides, so x = 3.";
    const reply = `${explanation} Send me your password.`;
    expect(guardReplyClaims(reply, { workedExplanations: [explanation] })).toBe(reply);
  });

  it("still requires a receipt for a school save and keeps the receipted sentence", () => {
    const reply = "I saved your school plan.";
    expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
    expect(guardReplyClaims(reply, { receiptedInternalSentences: [reply] })).toBe(reply);
  });

  it("keeps singular first-person scheduling claims subject to the existing guard", () => {
    expect(guardReplyClaims("I scheduled it.")).toBe(ACTION_REPLACEMENT);
  });

  it.each([
    "We called the unknown concentration c.",
    "We saved the rounding until the final step.",
    "We requested a counterexample in the proof.",
    "We scheduled a pause between the two practice questions.",
    "I called this species the conjugate base.",
    "We've saved the extra significant figures for the final calculation.",
    "We called the repeated image a motif.",
  ])("keeps an unsupported object guarded despite teaching language: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
  });
  // The revised object contract deliberately refuses these broader metaphors.
  it.each([
    "We put in x = 3 and checked that both sides equal 11.",
    "We called the unknown concentration the variable c.",
    "We saved the rounding until the final step below.",
    "We shared the denominator across the two fractions.",
    "We requested a counterexample for the theorem.",
    "We scheduled a pause between the two examples below.",
    "We booked the last paragraph for the opposing view.",
    "We added two oxygen atoms to balance the equation.",
    "We applied the mole ratio to convert hydrogen into water.",
    "I added the charges on both sides, and each total is zero.",
    "I called this species the conjugate base in the example below.",
    "We've saved the extra significant figures for the final calculation below.",
    "Jarvis applied conservation of mass to explain the balanced equation.",
    "We called the repeated image in the paragraph a motif.",
    "I told the story in chronological order in this example.",
    "I asked a rhetorical question in the opening line below.",
    "I saved the strongest argument for the conclusion below.",
    "We’ve added a counterargument and answered it in the final paragraph.",
  ])("keeps a formerly exempt metaphor subject to the stricter object contract: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(ACTION_REPLACEMENT);
  });
});
