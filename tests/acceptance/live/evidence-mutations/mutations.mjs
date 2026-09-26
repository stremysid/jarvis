export const MUTATIONS = Object.freeze([
  Object.freeze({
    id: "P1-no-authentication-prompt-before-first-turn",
    testName: "requires an owner call to reach its first model turn with zero authentication prompts",
    from: `  if (evidence.authenticationPromptsBeforeFirstModelTurn !== 0) unsafe();
`,
    to: "",
  }),
  Object.freeze({
    id: "P2-owner-authority-from-relay-setup",
    testName: "requires an owner call to be authorized from relay setup without a prompt",
    from: `  if (evidence.ownerAuthorityGranted !== claimsOwnerAuthority) unsafe();
`,
    to: "",
  }),
  Object.freeze({
    id: "N2-finite-audit-time",
    testName: "rejects an invalid audit time",
    from: `    if (!Number.isFinite(auditTimeMs)) throw new Error();
`,
    to: "",
  }),
  Object.freeze({
    id: "N3-bounded-audit-clock-skew",
    testName: "allows bounded clock skew but rejects implausibly future evidence",
    from: `const AUDIT_CLOCK_SKEW_MS = 5 * 60_000;
`,
    to: `const AUDIT_CLOCK_SKEW_MS = 0;
`,
  }),
]);
