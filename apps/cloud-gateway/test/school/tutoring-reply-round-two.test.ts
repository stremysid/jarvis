import { describe, expect, it } from "vitest";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";

const REFUSAL = "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.";

// These exact probes, including synthetic telephone examples, were supplied in
// review 5805905082. Keeping them verbatim makes the 35/35 claim reproducible.
const reviewerBlockers = [
  "I told your brother the formula for the area of a circle.",
  "I asked your landlord about the 3 missed payments.",
  "I called your manager and said you'd work 4 hours.",
  "I told the answer to Jake: x = 12.",
  "We shared the example essay with your friend Jake.",
  "I called 911 for you.",
  "I called 416-555-0199 to confirm your appointment.",
  "I called the example number on the form, 555-0100.",
  "I asked your friend Sam which theorem to use.",
  "I told your partner the example you liked.",
  "I told the formula to your study group.",
  "I asked the dentist to move your 3pm appointment.",
  "I applied the 10% student discount to your order.",
  "I applied the $50 credit to your account.",
  "I applied the rule for you and filed your appeal.",
  "I applied the formula for you and uploaded the result.",
  "We booked the 3 pm slot for your tutoring session.",
  "We scheduled the exam review for 4pm Thursday.",
  "We requested an extension until the 12th.",
  "We've put in your request for 2 extra days.",
  "We booked a room for the 5 of you.",
  "We put in the order for 3 calculators.",
  "We scheduled a call for 10 am.",
  "I saved the essay below to your Google Docs.",
  "I saved the file to your desktop at 3pm.",
  "I added the exam to your agenda for May 5.",
  "I saved the example to your phone.",
  "I added a reminder for 7 am.",
  "I saved 3 flashcards to your deck.",
  "I added the paragraph above to your document.",
  "I saved the equation to your OneNote.",
  "I added 2 hours of study to Tuesday.",
  "I saved the formula in your notebook.",
  "I added the example to your Notion page.",
  "Jarvis added the 5 equations to your Quizlet.",
];

describe("The second adversarial tutoring review", () => {
  it.each(reviewerBlockers)("catches the exact reviewer blocker: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(REFUSAL);
  });

  it("keeps a numeric substitution with an explicit variable", () => {
    const reply = "I put in 4 for x and got 20.";
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it.each([
    "I signed you up for the 2 pm info session.",
    "I reserved a spot for you in the review session.",
    "I cancelled your 4 pm appointment.",
    "Your application fee is paid.",
    "Your fee has been paid.",
    "Your email has gone out.",
    "The form is in.",
    "Your teacher has been told.",
  ])("catches the previously missing action claim: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(REFUSAL);
  });

  it.each([
    "I added an example to your account.",
    "I added an example in my document.",
    "I added an example on the page of the club.",
    "I added an example into your portfolio.",
    "I added an example with your coordinator.",
    "I added an example to someone else's journal.",
    "I added an example to the packet.",
    "I added an example for you.",
    "I applied the rule for you to your account.",
    "I applied the rubric that your teacher uses to the paragraph for you.",
    "I added an example for 2 students.",
    "I added an example for the 2 students.",
    "I added an example to Robin.",
    "I added an example with Robin.",
    "I added an example for Robin.",
    "I added an example referencing 555-0100.",
    "I added an example at 2 pm.",
    "I added an example at 14:15.",
    "I added an example dated 2027-01-08.",
    "I added an example dated 08/01/2027.",
    "I added an example dated August 8.",
    "I added an example due next Sunday.",
    "I added an example costing $9.",
    "I added an example costing 9 dollars.",
    "I added an example with a 5% discount.",
    "I applied the discount rule.",
    "I applied the credit formula.",
    "I applied the code method.",
    "I applied the fee rule.",
    "I applied the coupon formula.",
    "I added a card with an example below.",
    "I saved the variable to a disk.",
    "I put in 4 for your reservation.",
    "I put in 4 for x and sent the answer.",
    "We booked the example below.",
    "We scheduled the example below.",
    "We requested the example below.",
    "We shared the example below.",
    "In your office, I added an example.",
    "With my coordinator, I added an example.",
    "On the page of the club, I added an example.",
    "For you, I added an example.",
    "For 2 people, I added an example.",
    "With Robin, I added an example.",
    "At 14:15, I added an example.",
    "I added an example yielding 5%.",
  ])("rejects a non-explanation object or an explanation with an external context: %s", (reply) => {
    expect(guardReplyClaims(reply)).toBe(REFUSAL);
  });

  it.each(["filed", "uploaded", "submitted", "sent", "paid", "registered", "emailed", "booked", "sending", "uploading", "paying", "contacting"])(
    "keeps the second %s action visible after an applied-for-you phrase",
    (verb) => {
      expect(guardReplyClaims(`Applied the rule for you and ${verb} it.`)).toBe(REFUSAL);
    },
  );

  it("checks context in the same sentence even when the object is locally safe", () => {
    expect(guardReplyClaims("At 2 pm, I added an example.")).toBe(REFUSAL);
    const reply = "The appointment is at 2 pm. I added an example.";
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it("keeps passive advice and owner reports separate from completion claims", () => {
    for (const reply of ["Once your fee has been paid, check the receipt.", "You said your teacher has been told.", "Your email has been sent by you."]) {
      expect(guardReplyClaims(reply)).toBe(reply);
    }
  });
});
