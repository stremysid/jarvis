// For each surviving mutation, remove the guard and check whether the escape input is
// still refused by some other checked path (implied) or now accepted (a real unpinned rule).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { MUTATIONS } from "./mutations.mjs";

const TARGET = new URL("./voice-smoke.ts", import.meta.url);
const ORIGINAL = readFileSync(new URL("./voice-smoke.orig.ts", import.meta.url), "utf8");
const byId = new Map(MUTATIONS.map((m) => [m.id, m]));

const PLAN = [
  ["V04-waiver-inbound-only", ["V04-waiver-inbound-only"]],
  ["V05-waiver-needs-authority", ["V05-waiver-needs-authority"]],
  ["V08-verified-prompt-min-1", ["V08-verified-prompt-min-1"]],
  ["V13-refused-outcome", ["V13-refused-outcome-verified", "V13-refused-outcome-not-started", "V13-refused-outcome-waived"]],
  ["V22-no-answer-zero-prompts", ["V22-no-answer-zero-prompts"]],
  ["N-inbound-attestation-not-applicable", ["N-inbound-attestation-not-applicable"]],
  ["N-not-started-no-authority", ["N-not-started-no-authority"]],
  ["N-not-started-outbound-only", ["N-not-started-outbound-only"]],
  ["N-not-started-policy", ["N-not-started-policy"]],
  ["N-not-started-zero-counts", ["N-not-started-zero-counts"]],
  ["A-audit-inbound-verified", ["A-audit-inbound-verified"]],
  ["A-audit-finite-audit-time", ["A-audit-finite-audit-time"]],
  ["A-audit-per-scenario-loop", ["A-audit-per-scenario-loop"]],
  ["A-audit-scenario-set-size", ["A-audit-scenario-set-size"]],
];

console.log("=== control: escape inputs against the UNMUTATED validator ===");
for (const [, cases] of PLAN) {
  for (const testCase of cases) {
    const run = spawnSync(process.execPath, ["escape-probe.mjs", testCase], {
      cwd: new URL("./", import.meta.url), encoding: "utf8",
    });
    console.log(`  [${testCase}] ${(run.stdout ?? run.stderr ?? "").trim()}`);
  }
}

console.log("\n=== each guard removed, one at a time ===");
try {
  for (const [mutationId, cases] of PLAN) {
    const mutation = byId.get(mutationId);
    if (mutation === undefined) { console.log(`${mutationId}: no such mutation`); continue; }
    writeFileSync(TARGET, ORIGINAL.replace(mutation.from, mutation.to), "utf8");
    console.log(`\n-- ${mutationId} removed:`);
    for (const testCase of cases) {
      const run = spawnSync(process.execPath, ["escape-probe.mjs", testCase], {
        cwd: new URL("./", import.meta.url), encoding: "utf8",
      });
      console.log(`  [${testCase}] ${(run.stdout ?? run.stderr ?? "").trim()}`);
    }
  }
} finally {
  writeFileSync(TARGET, ORIGINAL, "utf8");
  console.log("\n(validator copy restored)");
}
