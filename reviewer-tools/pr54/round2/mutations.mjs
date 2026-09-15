// Independent mutation set over every guard the PR #54 fix commits added or kept,
// plus the five round-1 F1 rules and the builder's claimed behaviour-equivalent survivors.
export const MUTATIONS = [
  { id: "BASE", note: "control", from: `  return Object.freeze(missing);`, to: `  return Object.freeze(missing);` },

  // --- builder's claimed behaviour-equivalent survivors ---
  {
    id: "V04-waiver-inbound-only", note: "builder claims equivalent",
    from: `      direction !== "inbound"\n      || !claimsOwnerAuthority\n`,
    to: `      !claimsOwnerAuthority\n`,
  },
  {
    id: "V05-waiver-needs-authority", note: "builder claims equivalent",
    from: `      direction !== "inbound"\n      || !claimsOwnerAuthority\n`,
    to: `      direction !== "inbound"\n`,
  },
  {
    id: "V08-verified-prompt-min-1", note: "builder claims equivalent",
    from: `|| !validInteger(evidence.ownerStepUpPromptCount, 1, 5)`,
    to: `|| !validInteger(evidence.ownerStepUpPromptCount, 0, 5)`,
  },
  {
    id: "V13-refused-outcome", note: "builder claims equivalent",
    from: `    || evidence.ownerStepUpOutcome !== "refused"\n    || evidence.ownerStepUpAttemptCount !== 3\n`,
    to: `    || evidence.ownerStepUpAttemptCount !== 3\n`,
  },
  {
    id: "V22-no-answer-zero-prompts", note: "builder claims equivalent; real gap in round 1",
    from: `    || evidence.ownerStepUpPromptCount !== 0\n    || evidence.ownerStepUpAttemptCount !== 0\n    || evidence.modelRequests !== 0\n`,
    to: `    || evidence.modelRequests !== 0\n`,
  },

  // --- round-1 F1 rules ---
  {
    id: "F1-V03-outbound-attestation", note: "F1: outbound attestation binding",
    from: `    || direction === "outbound" && attestation !== "not_applicable"\n`,
    to: ``,
  },
  {
    id: "F1-V11-refusal-terminal-state", note: "F1: refusal terminalState",
    from: `    evidence.terminalState !== "rejected"\n    || evidence.authenticatedTurns !== 0\n    || evidence.ownerStepUpOutcome !== "refused"`,
    to: `    false\n    || evidence.authenticatedTurns !== 0\n    || evidence.ownerStepUpOutcome !== "refused"`,
  },
  {
    id: "F1-V12-refusal-authenticated-turns", note: "F1: refusal authenticatedTurns",
    from: `    || evidence.authenticatedTurns !== 0\n    || evidence.ownerStepUpOutcome !== "refused"\n`,
    to: `    || evidence.ownerStepUpOutcome !== "refused"\n`,
  },
  {
    id: "F1-V22-no-answer-outcome", note: "F1: no-answer not_started outcome",
    from: `    || evidence.ownerStepUpOutcome !== "not_started"\n`,
    to: ``,
  },
  {
    id: "F1-V25-schema-1-2", note: "F1: schema 1.2 carrying 1.3 fields",
    from: `    evidence.schemaVersion !== "1.3"\n`,
    to: `    evidence.schemaVersion !== "1.3" && evidence.schemaVersion !== "1.2"\n`,
  },

  // --- new guards from the fix commits ---
  {
    id: "N-inbound-attestation-not-applicable",
    from: `    || direction === "inbound" && attestation === "not_applicable"\n`, to: ``,
  },
  {
    id: "N-L2-attempts-le-prompts",
    from: `        || evidence.ownerStepUpAttemptCount > evidence.ownerStepUpPromptCount\n`, to: ``,
  },
  {
    id: "N-L2-prompts-le-attempts-plus-2",
    from: `        || evidence.ownerStepUpPromptCount > evidence.ownerStepUpAttemptCount + 2\n`, to: ``,
  },
  {
    id: "N-reprompt-range-0-2",
    from: `    || !validInteger(evidence.ownerStepUpRepromptCount, 0, 2)\n`, to: ``,
  },
  {
    id: "N-prompt-equals-3-plus-reprompt",
    from: `    || evidence.ownerStepUpPromptCount !== 3 + evidence.ownerStepUpRepromptCount\n`, to: ``,
  },
  {
    id: "N-rejection-reason-attempts-exhausted",
    from: `    || evidence.ownerStepUpRejectionReason !== "attempts_exhausted"\n`, to: ``,
  },
  {
    id: "N-rejection-delivery-row-count",
    from: `    || evidence.rejectionDeliveryRowCount !== 1\n`, to: ``,
  },
  {
    id: "N-alert-disposition-sent",
    from: `    || evidence.ownerAlertDisposition !== "sent"\n`, to: ``,
  },
  {
    id: "N-refusal-duration-bound",
    from: `    || Date.parse(evidence.endedAt as string) - Date.parse(evidence.startedAt as string) > 5 * 60_000\n`,
    to: ``,
  },
  {
    id: "N-not-started-outbound-only",
    from: `      direction !== "outbound"\n      || claimsOwnerAuthority\n`,
    to: `      claimsOwnerAuthority\n`,
  },
  {
    id: "N-not-started-no-authority",
    from: `      direction !== "outbound"\n      || claimsOwnerAuthority\n`,
    to: `      direction !== "outbound"\n`,
  },
  {
    id: "N-not-started-policy",
    from: `      || policy !== "passphrase_always"\n      || evidence.ownerStepUpPromptCount !== 0\n      || evidence.ownerStepUpAttemptCount !== 0\n    ) unsafe();\n  } else {`,
    to: `      || evidence.ownerStepUpPromptCount !== 0\n      || evidence.ownerStepUpAttemptCount !== 0\n    ) unsafe();\n  } else {`,
  },
  {
    id: "N-not-started-zero-counts",
    from: `      || policy !== "passphrase_always"\n      || evidence.ownerStepUpPromptCount !== 0\n      || evidence.ownerStepUpAttemptCount !== 0\n    ) unsafe();\n  } else {`,
    to: `      || policy !== "passphrase_always"\n    ) unsafe();\n  } else {`,
  },
  {
    id: "N-outbound-policy-passphrase-always",
    from: `      || direction === "outbound" && policy !== "passphrase_always"\n`, to: ``,
  },

  // --- new audit-level guards ---
  {
    id: "A-audit-policy-passphrase-always",
    from: `        if (dataField(record as object, "ownerCallerIdPolicy") !== "passphrase_always") throw new Error();\n`,
    to: ``,
  },
  {
    id: "A-audit-inbound-verified",
    from: `        if (scenario === "inbound" && dataField(record as object, "ownerStepUpOutcome") !== "verified") throw new Error();\n`,
    to: ``,
  },
  {
    id: "A-audit-distinct-correlations",
    from: `      if (correlationIds.has(correlationId)) throw new Error();\n`, to: ``,
  },
  {
    id: "A-audit-disjoint-event-ids",
    from: `        if (eventIds.has(eventId)) throw new Error();\n`, to: ``,
  },
  {
    id: "A-audit-started-before-audit-time",
    from: `      if (Date.parse(dataField(record as object, "startedAt") as string) > auditTimeMs) throw new Error();\n`,
    to: ``,
  },
  {
    id: "A-audit-per-scenario-loop",
    from: `    for (const scenario of VOICE_SMOKE_SCENARIOS) {\n      if (!scenarios.has(scenario)) throw new Error();\n    }\n`,
    to: ``,
  },
  {
    id: "A-audit-finite-audit-time",
    from: `    if (!Number.isFinite(auditTimeMs)) throw new Error();\n`, to: ``,
  },
  {
    id: "A-audit-record-count",
    from: ` || records.length !== VOICE_SMOKE_SCENARIOS.length`, to: ``,
  },
  {
    id: "A-audit-scenario-set-size",
    from: `    if (scenarios.size !== VOICE_SMOKE_SCENARIOS.length || commitShas.size !== 1) throw new Error();\n`,
    to: `    if (commitShas.size !== 1) throw new Error();\n`,
  },
  {
    id: "A-audit-single-commit",
    from: `    if (scenarios.size !== VOICE_SMOKE_SCENARIOS.length || commitShas.size !== 1) throw new Error();\n`,
    to: `    if (scenarios.size !== VOICE_SMOKE_SCENARIOS.length) throw new Error();\n`,
  },
];
