export const WORKED_REPLY = "We added 5 to both sides, so x = 3. We applied the chain rule. I added a worked example below.";

// The first question is copied from PR #172 at 6c09a86. Shared fixtures keep
// the two channel assertions tied to the same school mode and guard behaviour.
export const GUIDED_ASSIGNMENT_QUESTIONS = [
  "Let's take one small step. Why do you think Macbeth trusts the witches? Say it in your own words.",
  "What is the assignment asking you to explain?",
  "Which quotation supports your answer?",
  "We added 5 to both sides, so x = 3. What would you substitute next?",
  "I added a worked example below. Which part feels unclear?",
  "What does the rubric your teacher uses say about evidence?",
  "How would you explain that reaction in your own words?",
  "I asked you to choose one idea. Which idea do you want to start with?",
] as const;
