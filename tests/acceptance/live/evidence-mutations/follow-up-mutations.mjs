export const FOLLOW_UP_MUTATIONS = Object.freeze([
  Object.freeze({
    id: "F1-not-started-outbound-only",
    testName: "refuses an inbound record whose owner step-up outcome is not_started",
    from: `      direction !== "outbound"
      || claimsOwnerAuthority
`,
    to: `      claimsOwnerAuthority
`,
  }),
  Object.freeze({
    id: "F2-audit-inbound-verified",
    testName: "requires the release audit's inbound record to have a verified owner step-up outcome",
    from: `        if (scenario === "inbound" && dataField(record as object, "ownerStepUpOutcome") !== "verified") throw new Error();
`,
    to: "",
  }),
  Object.freeze({
    id: "F3-verified-inbound-passphrase-policy",
    testName: "requires a verified inbound record itself to use the passphrase-always policy",
    from: `        || direction === "inbound" && policy !== "passphrase_always"
`,
    to: "",
  }),
  Object.freeze({
    id: "O1-one-outbound-attempt",
    testName: "requires outbound step-up-refused evidence to show one outbound attempt",
    from: `    evidence.callAttempts !== 1
`,
    to: `    false
`,
  }),
  Object.freeze({
    id: "O2-recipient-answered",
    testName: "requires outbound step-up-refused evidence to show an answered recipient",
    from: `    || evidence.recipientAnswered !== true
`,
    to: "",
  }),
  Object.freeze({
    id: "O3-recipient-not-authenticated",
    testName: "requires outbound step-up-refused evidence to show no authenticated recipient",
    from: `    || evidence.recipientAnswered !== true
    || evidence.recipientAuthenticated !== false
`,
    to: `    || evidence.recipientAnswered !== true
`,
  }),
  Object.freeze({
    id: "O4-neutral-greeting",
    testName: "requires outbound step-up-refused evidence to show only a neutral pre-authentication greeting",
    from: `    || evidence.recipientAuthenticated !== false
    || evidence.neutralGreetingBeforeAuthentication !== true
    || evidence.purposeDisclosed !== false
`,
    to: `    || evidence.recipientAuthenticated !== false
    || evidence.purposeDisclosed !== false
`,
  }),
  Object.freeze({
    id: "O5-no-purpose-disclosure",
    testName: "requires outbound step-up-refused evidence to show no purpose disclosure",
    from: `    || evidence.neutralGreetingBeforeAuthentication !== true
    || evidence.purposeDisclosed !== false
`,
    to: `    || evidence.neutralGreetingBeforeAuthentication !== true
`,
  }),
  Object.freeze({
    id: "O6-no-private-message",
    testName: "requires outbound step-up-refused evidence to show no private message",
    from: `    || evidence.purposeDisclosed !== false
    || evidence.privateMessageLeft !== false
  ) unsafe();
`,
    to: `    || evidence.purposeDisclosed !== false
  ) unsafe();
`,
  }),
]);
