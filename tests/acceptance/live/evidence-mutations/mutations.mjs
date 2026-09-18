export const MUTATIONS = Object.freeze([
  Object.freeze({
    id: "S1-not-started-no-owner-authority",
    testName: "rejects an answered outbound call granted owner authority with no step-up",
    from: `      || claimsOwnerAuthority
      || evidence.authenticationMode !== OWNER_PASSPHRASE_AUTHENTICATION_MODE
`,
    to: `      || evidence.authenticationMode !== OWNER_PASSPHRASE_AUTHENTICATION_MODE
`,
  }),
  Object.freeze({
    id: "N1-inbound-attestation-not-applicable",
    testName: "binds the not_applicable attestation to outbound owner evidence only",
    from: `    || direction === "inbound" && attestation === "not_applicable"
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
