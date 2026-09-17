// Mutation runner for the PR #82 round-2 narrow review. Untracked files are ignored.
// Usage: node mutrun-r2.mjs [comma-separated ids] [tests=path,path]
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const AD = "apps/cloud-gateway/src/memory/automatic-distillation.ts";
const MR = "apps/cloud-gateway/src/memory/memory-repository.ts";
const JT = "apps/cloud-gateway/src/jobs/job-table.ts";
const m = (id, file, from, to) => ({ id, file, from, to });
const root = "C:/Users/Sid/jarvis-pr82-adv";
const defaultTests = [
  "apps/cloud-gateway/test/memory/automatic-distillation.test.ts",
  "apps/cloud-gateway/test/memory/memory-repository.test.ts",
  "apps/cloud-gateway/test/memory/memory-repository-faults.test.ts",
  "apps/cloud-gateway/test/sync/memory-distill.test.ts",
];
const mutations = [
  m("G01-path-redaction", AD, "if (!checked.ok || checked.text !== display) return null;", "void checked;"),
  m("G02-path-json-320", AD, "if (encoder.encode(JSON.stringify(path)).byteLength > MAX_TOPIC_PATH_JSON_BYTES) return null;", ""),
  m("G03-infallible-reason-workflow", AD,
    "  try {\n    return automaticFilingReason(decision, topicPath ?? undefined);\n  } catch {\n    return automaticFilingReason(\"inbox_invalid_path\");\n  }",
    "  return automaticFilingReason(decision, topicPath ?? undefined);"),
  m("G04-filingConfidence-range", AD, "&& record.filingConfidence >= 0 && record.filingConfidence <= 1", ""),
  m("G05-required-fields", AD,
    "\n    || [...REQUIRED_PROPOSAL_FIELDS].some((key) => !Object.hasOwn(value, key))) return null;", ") return null;"),
  m("G06-created-count-accumulate", AD, "this.automaticallyCreatedTopicCount += result.automaticFilingCreatedTopicCount ?? 0;", ""),
  m("G07-null-path-skips-filing", AD, "if (proposal.topicPath !== null\n      && lifecycleState", "if (\n      lifecycleState"),
  m("G08-capture-automatic-authority", MR,
    "if (input.placement.topicId !== inboxTopicId || filingSource !== \"rule\"\n      || input.transition.lifecycleState !== \"active\" || input.version.uncertain\n      || input.placement.confidence < 0.6) refuse();",
    ""),
  m("G09-prepare-inbox-id-match", MR,
    "if (bootstrapped === null || bootstrapped.inbox.topicId !== automatic.inboxTopicId) refuse();",
    "if (bootstrapped === null) refuse();"),
  m("G10-prepare-corrupt-rethrow", MR,
    "if (error instanceof MemoryRepositoryError && error.code === \"memory_corrupt\") throw error;\n      return inboxPlan(\"inbox_filing_failure\", true);\n    }\n    if (resolved.missingIndex",
    "return inboxPlan(\"inbox_filing_failure\", true);\n    }\n    if (resolved.missingIndex"),
  m("G11-prepare-inbox-target", MR, "if (resolved.topicId === automatic.inboxTopicId) return inboxPlan(\"inbox_invalid_path\", false);", ""),
  m("G12-prepare-six-cap", MR, "if (missingCount > automatic.maximumNewTopics) return inboxPlan(\"inbox_cap\", true);", ""),
  m("G13-prepare-child-cap", MR,
    "if (await this.activeChildCount(input.principalId, resolved.topicId) >= AUTOMATIC_TOPIC_CHILD_LIMIT) {",
    "if (await this.activeChildCount(input.principalId, resolved.topicId) >= 1_000_000) {"),
  m("G14-reprepare-on-retry", MR, "if (attempt > 1) plan = await this.prepareAutomaticCommit(captured);", ""),
  m("G15-replay-equivalent-reason", MR,
    "|| !equivalentAutomaticFilingReason(placement.reason, input.placement.reason)",
    "|| placement.reason !== input.placement.reason"),
  m("G16-single-batch", MR,
    "await repositoryTestSeams.get(this)?.beforeBatch(\"commit\", attempt);\n          await this.transactions.batch(statements);",
    "await repositoryTestSeams.get(this)?.beforeBatch(\"commit\", attempt);\n          if (plan.topicStatements.length > 0) await this.transactions.batch([...plan.topicStatements]);\n          await this.transactions.batch(statements.slice(plan.topicStatements.length));"),
  m("G17-refile-sql-decision-filter", MR,
    "AND (instr(event.reason, ?) = 1 OR instr(event.reason, ?) = 1)",
    "AND (instr(event.reason, ?) >= 0 OR instr(event.reason, ?) >= 0)"),
  m("G18-refile-filing-failure-decision", MR,
    "`${AUTOMATIC_FILING_REASON_PREFIX}{\"decision\":\"inbox_filing_failure\",`,",
    "`${AUTOMATIC_FILING_REASON_PREFIX}{\"decision\":\"inbox_cap\",`,"),
  m("G19-refile-ten-move-stop", MR, "if (refiledItemCount >= AUTOMATIC_INBOX_REFILE_LIMIT) break;", ""),
  m("G20-refile-candidates-100", MR,
    "const AUTOMATIC_INBOX_REFILE_CANDIDATE_LIMIT = 100;", "const AUTOMATIC_INBOX_REFILE_CANDIDATE_LIMIT = 10;"),
  m("G21-refile-invalid-path-skip", MR, "if (normalizedPath === null) continue;", ""),
  m("G22-nfkc-fold", MR, "return topics.find((topic) => foldedTopicName(topic.displayName) === folded) ?? null;", "return null;"),
  m("G23-exact-before-fold", MR, "if (exact[0] !== undefined) return exact[0];", ""),
  m("G24-fold-oldest-order", MR, "ORDER BY created_at ASC, topic_id ASC`)", "ORDER BY created_at DESC, topic_id DESC`)"),
  m("G25-component-64-bytes", MR,
    "utf8.encode(component.display).byteLength > AUTOMATIC_TOPIC_COMPONENT_BYTES",
    "utf8.encode(component.display).byteLength > 100_000"),
  m("G26-separator-reject", MR, "|| /[>/]/u.test(component.display)", ""),
  m("G27-cf-reject", MR, "|| /\\p{Cf}/u.test(component.display)", ""),
  m("G28-inbox-name-reject", MR, "inboxNames.has(foldedTopicName(component.display))) return null;", "false) return null;"),
  m("G29-root-drop", MR, "components = components.slice(1);", ""),
  m("G30-depth-after-root-drop", MR,
    "if (components.length < 1 || components.length > AUTOMATIC_TOPIC_DEPTH_LIMIT) return null;",
    "if (components.length < 1) return null;"),
  m("G31-safe-reason-repository", MR,
    "  try {\n    return automaticFilingReason(decision, topicPath);\n  } catch {\n    return automaticFilingReason(\"inbox_invalid_path\");\n  }",
    "  return automaticFilingReason(decision, topicPath);"),
  m("G32-job-admission-reserves-refile", JT,
    "+ providerD1Ceiling\n        + AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING\n", "+ providerD1Ceiling\n"),
  m("G33-job-canRefile", JT,
    "const canRefile = chargedD1Statements + AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING\n    <= MEMORY_DISTILLATION_D1_STATEMENT_ALLOWANCE;",
    "const canRefile = true;"),
  m("G34-job-charge-refile", JT, "if (canRefile) chargedD1Statements += AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING;", ""),
];

const args = process.argv.slice(2);
const only = args.find((arg) => !arg.startsWith("tests="));
const testsArg = args.find((arg) => arg.startsWith("tests="));
const tests = testsArg === undefined ? defaultTests : testsArg.slice(6).split(",");
const git = (...gitArgs) => spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
const tracked = () => git("status", "--porcelain", "--untracked-files=no").stdout.trim();
if (tracked() !== "") throw new Error("tracked tree dirty before start");
const results = [];
for (const mutation of mutations.filter((x) => !only || only.split(",").includes(x.id))) {
  const path = `${root}/${mutation.file}`;
  const raw = fs.readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");
  let text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) {
    console.log(`\n== ${mutation.id}: MATCHED ${count} TIMES, skipped`);
    results.push({ id: mutation.id, verdict: "SKIPPED" });
    continue;
  }
  if (process.env.DRY === "1") { results.push({ id: mutation.id, verdict: "MATCHED" }); continue; }
  text = text.replace(mutation.from, () => mutation.to);
  fs.writeFileSync(path, crlf ? text.replace(/\n/g, "\r\n") : text);
  const run = spawnSync("npx.cmd", ["vitest", "--config", "vitest.workspace.ts", "run", ...tests], {
    cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
  });
  git("checkout", "--", mutation.file);
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  const lines = out.split(/\r?\n/);
  const failed = lines.filter((line) => /^\s*×\s/.test(line)).slice(0, 30);
  const summary = lines.filter((line) => /^\s*(Test Files|Tests)\s/.test(line)).slice(-2);
  const verdict = run.status === 0 ? "SURVIVED" : "KILLED";
  console.log(`\n== ${mutation.id}: ${verdict} (exit ${run.status})`);
  for (const line of [...summary, ...failed]) console.log(`   ${line.trim()}`);
  if (summary.length === 0) console.log(`   (no test summary)\n${out.slice(-800)}`);
  results.push({ id: mutation.id, verdict });
  if (tracked() !== "") throw new Error("tree not clean after restore");
}
console.log("\n=== summary");
for (const result of results) console.log(`${result.verdict.padEnd(9)} ${result.id}`);
