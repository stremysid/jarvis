// Keeps the state carriers honest. Run: node scripts/check-state.mjs
//
// The rules here are the mistakes this repository has actually made, not
// hypotheticals: a handoff that asserted a revision as current three times, a
// queue file that would silently lose its priority column, and links that point at
// files nobody ever added.
//
// NOTHING RUNS THIS YET. Sweep-5 found that three of the four existing
// scripts/test/*.test.mjs files are executed by no workflow at all, so adding a
// fifth unrun script would repeat the defect this file exists to catch. It is
// written to be wired into the docs job; until it is, run it by hand.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const CARRIERS = ["docs/STATE.md", "docs/QUEUE.md", "docs/OWNER-ACTIONS.md"];
const STATE_LINE_BUDGET = 150;
const GENERATED = /^Last regenerated:\s*(\d{4}-\d{2}-\d{2})/mu;

for (const relative of CARRIERS) {
  const path = join(root, relative);
  if (!existsSync(path)) {
    failures.push(`${relative}: missing. The state carriers are not optional.`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);

  if (!GENERATED.test(text)) {
    failures.push(`${relative}: no "Last regenerated: YYYY-MM-DD" line. An undated state file is a rumour.`);
  }

  // A link that resolves to nothing is how a new session spends an hour.
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = match[1];
    if (/^[a-z]+:/iu.test(target) || target.startsWith("#")) continue;
    const resolved = resolve(dirname(path), target.split("#")[0]);
    if (!existsSync(resolved)) failures.push(`${relative}: link to a file that does not exist: ${target}`);
  }

  if (relative === "docs/STATE.md") {
    if (lines.length > STATE_LINE_BUDGET) {
      failures.push(`docs/STATE.md: ${lines.length} lines, budget is ${STATE_LINE_BUDGET}. State that does not fit is not state.`);
    }
    // The exact defect: prose presenting a revision as current. State names the
    // command that prints the revision; it never carries the revision itself.
    lines.forEach((line, index) => {
      if (/origin\/main/u.test(line) && /\b[0-9a-f]{7,40}\b/u.test(line)) {
        failures.push(`docs/STATE.md:${index + 1}: names origin/main and a literal sha. Query it instead.`);
      }
    });
  }

  if (relative === "docs/QUEUE.md" && !/\|\s*BLOCKS\s*\|/u.test(text)) {
    failures.push("docs/QUEUE.md: no BLOCKS column. Without it the priority rule stops being mechanical.");
  }
}

if (failures.length > 0) {
  console.error(`state check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`state check passed: ${CARRIERS.length} carriers, STATE.md within budget, links resolve, BLOCKS present.`);
