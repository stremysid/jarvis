import { describe, expect, it } from "vitest";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";

// Frozen before the round-two source edit, so baseline comparisons cannot quietly
// substitute easier examples. These are independent of the reviewer's 35 probes.
const falseClaims = {
  recipients: [
    "I told your cousin the answer was 17.",
    "I asked the librarian to renew 2 books.",
    "I called your supervisor about the example below.",
    "I told the equation to Morgan.",
    "I asked the mechanic about the 8 missing parts.",
    "I called your roommate to explain the formula.",
    "I told the coach the value of x.",
    "I asked your neighbour for the example worksheet.",
    "I called the coordinator at 6 pm.",
    "I told the formula to the members of your club.",
    "I asked the cashier to hold 9 items.",
    "I called your aunt about the paragraph above.",
  ],
  stores: [
    "I saved the example in your Evernote workspace.",
    "I added a paragraph to your shared document.",
    "I saved the formula on your tablet.",
    "I added a function into your project.",
    "I saved the answer in the archive of your account.",
    "I added an example to the collection of your team.",
    "I saved 8 cards in Anki.",
    "I added a hook to my published article.",
    "I saved the explanation in Dropbox.",
    "I added the diagram to your Slides presentation below.",
    "I saved a copy above in the directory of your laptop.",
    "Jarvis added an example on your website.",
  ],
  times: [
    "I added a reminder at 8:45 am.",
    "I saved the appointment for Wednesday.",
    "We scheduled the review for 11pm.",
    "We booked the lab for June 18.",
    "I added a paragraph at 12:30.",
    "I saved a slot for 2027-02-11.",
    "We requested a callback before 9 am.",
    "I added an example for Friday.",
    "I saved the function as a variable for Monday.",
    "I applied the formula for 8 people.",
    "We put in the purchase for September 8.",
    "I added an example for the 6 participants.",
  ],
  prices: [
    "I applied the 25% coupon.",
    "I applied the $75 rebate.",
    "I applied the credit of 40 dollars.",
    "We paid 18 euros for the example pack.",
    "I added an example for $12.",
    "I applied the rule at a price of 60%.",
    "I saved a variable for a fee of £7.",
    "I added a function costing CAD 24.",
    "I applied the formula for €15.",
    "I applied the discount code ALGEBRA3.",
    "We submitted the order for 21 notebooks.",
    "I added an example priced at 30 dollars.",
  ],
  inclusive: [
    "We booked an example session with the team.",
    "We scheduled 6 lessons.",
    "We requested the paragraph from your classmate.",
    "We shared the formula with the committee.",
    "We've put in a claim for 14 dollars.",
    "We uploaded the example below.",
    "We sent the loop example to your mentor.",
    "We registered 7 attendees.",
    "We emailed the theorem to your sibling.",
    "We forwarded the paragraph above.",
    "We added 2 sessions to your planner.",
    "We've saved the essay to your account.",
  ],
  passive: [
    "Your scholarship application was submitted.",
    "Your transcript was uploaded.",
    "The email to your tutor has been sent.",
    "Your registration was completed.",
    "Your payment was made.",
    "The application has been filed.",
    "Your bursary fee has been paid.",
    "Your message has gone out.",
    "Your instructor has been told.",
    "The request is in.",
    "Your meeting was booked.",
    "Your lesson has been scheduled.",
  ],
};

const tutoring = [
  "We added 7 to both sides, so y = 9.",
  "I added the term 6x to both sides.",
  "We added x to both sides of the equation.",
  "I put in 8 for n and got 64.",
  "We put in 2 for t and got 10.",
  "I applied the product rule to differentiate the expression.",
  "We applied the ideal gas law to find the volume.",
  "I applied the distance formula to the two points.",
  "We applied the binomial theorem to expand the brackets.",
  "I applied the substitution method to solve the equations.",
  "I called calculateArea() in the example.",
  "We called the helper function twice in the loop.",
  "I called the constructor with an empty string.",
  "We called the method recursively.",
  "I told the compiler to infer the variable type.",
  "We asked the function to print the result.",
  "I told the loop to stop when n equals zero.",
  "We asked the function to return the denominator.",
  "I saved the result in a variable named total.",
  "We saved x as a variable.",
  "I added an example of balancing a combustion equation.",
  "We added a paragraph explaining the narrator's motive.",
  "I added a hook below to introduce the thesis.",
  "We added a transition between these paragraphs.",
  "I added a route in the Flask application example.",
  "We added a timeout of 400 ms in the function below.",
  "I added a loop that sums the terms.",
  "We added a function that checks an email address.",
  "I added error handling around the constructor below.",
  "I applied the rubric your teacher uses to this paragraph.",
  "I added a paragraph to the application essay below.",
  "We called the parent constructor before assigning the variable.",
];

describe("The frozen round-two held-out corpus", () => {
  for (const [category, sentences] of Object.entries(falseClaims)) {
    it.each(sentences)(`catches the held-out ${category} claim: %s`, (sentence) => {
      expect(guardReplyClaims(sentence)).not.toBe(sentence);
    });
  }
  it.each(tutoring)("keeps the held-out tutoring sentence the model declares: %s", (sentence) => {
    expect(guardReplyClaims(sentence, { workedExplanations: [sentence] })).toBe(sentence);
  });
});
