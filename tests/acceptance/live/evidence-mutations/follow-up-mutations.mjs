export const FOLLOW_UP_MUTATIONS = Object.freeze([
  Object.freeze({
    id: "P3-recipient-unauthenticated-on-no-answer",
    testName: "requires outbound no-answer evidence to leave the recipient unauthenticated",
    from: `    || evidence.recipientAuthenticated !== false
`,
    to: "",
  }),
  Object.freeze({
    id: "P4-failure-category-provider",
    testName: "accepts safe failure evidence only when no new callback was authorized",
    from: `    || evidence.modelFailureCategory !== TASK_5_MODEL_FAILURE_CATEGORY
`,
    to: "",
  }),
]);
