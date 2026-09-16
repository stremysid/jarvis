// Mutation check of workflow guards in university-tracker-model.ts against the
// PR's own model-test inputs (transcribed from university-application-details-model.test.ts).
import { readFileSync, writeFileSync, rmSync } from "node:fs";
const dir = "./head/apps/cloud-gateway/src/university/";
const source = readFileSync(dir + "university-tracker-model.ts", "utf8");

const TURN = "01k5j000000000000000000001", PROGRAM = "01k5j000000000000000000002", APPLICATION = "01k5j000000000000000000003",
  WORKFLOW = "01k5j000000000000000000004", EVENT = "01k5j000000000000000000005", NOW = "2026-09-16T15:00:00.000Z";
const unver = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
function snapshot(withWorkflow = false) {
  return { principalId: "principal:workflow-model", programs: [{ programId: PROGRAM, university: "Western University", campus: null,
    programName: "Medical Sciences", ouacCode: null, verification: unver, requirements: [], dates: [],
    applicationItems: [{ itemId: APPLICATION, kind: "reference", label: "Western reference", status: "drafting", dueDate: null, verification: unver, sourceTurnId: TURN, submittedAt: null, updatedAt: NOW }],
    workflowItems: withWorkflow ? [{ workflowId: WORKFLOW, eventId: EVENT, revision: 1, applicationItemId: APPLICATION, kind: "contact_step",
      label: "Ms Chen reference request", owner: "sid", status: "prepared", preparedDetails: "Review the draft, then Sid sends it.", executionBoundary: "owner_only",
      deadline: { date: null, instant: null, timeZone: null, verification: unver }, sourceTurnId: TURN, updatedAt: NOW }] : [] }] };
}
const base = "Draft the Ms Chen reference request for the Western reference.";
function wu(o = {}) {
  return { workflowRef: "new-workflow-1", programRef: PROGRAM, applicationItemRef: APPLICATION, kind: "contact_step", label: "Ms Chen reference request",
    owner: "sid", status: "prepared", statusEvidence: base, preparedDetails: "Sid reviews this draft and sends it himself.",
    deadline: { date: null, instant: null, timeZone: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: base },
    executionBoundary: "owner_only", ...o };
}
const existing = (text) => ({ workflowRef: WORKFLOW, applicationItemRef: null, kind: null, label: null, owner: null, status: "owner_reported_done", statusEvidence: text, preparedDetails: null, deadline: null });
const offer = (text) => ({ applicationItemRef: null, kind: "offer", label: "Western offer", owner: "university", status: "owner_reported_offered", statusEvidence: text, preparedDetails: null,
  deadline: { date: null, instant: null, timeZone: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text } });
const dl = (text, tz) => ({ statusEvidence: text, deadline: { date: null, instant: "2027-01-15T22:00:00.000Z", timeZone: tz, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text } });
const t1 = "Draft the Ms Chen reference request. The Western reference is next.";
const tests = [
  ["prepared ok", true, base, wu()],
  ["split clauses", false, t1, wu({ statusEvidence: t1, deadline: { ...wu().deadline, evidence: t1 } })],
  ["done ok", true, "I emailed Ms Chen for the Ms Chen reference request covering the Western reference.", null, true],
  ["reported", false, "Ms Chen said I emailed her for the Ms Chen reference request covering the Western reference.", null, true],
  ["asked you", false, "I asked you to draft the Ms Chen reference request for the Western reference.", null, true],
  ["offer ok", true, "I received a Western offer.", "offer"],
  ["offer relayed", false, "My counsellor said I received a Western offer.", "offer"],
  ["fee", false, base, wu({ preparedDetails: "Pay $100 and then send the request." })],
  ["boundary", false, base, wu({ executionBoundary: "jarvis_executes" })],
  ["instant ok", true, base.replace(".", " due 2027-01-15T22:00:00.000Z America/Toronto."), "dlok"],
  ["bad tz", false, base.replace(".", " due 2027-01-15T22:00:00.000Z Mars/Olympus."), "dlbad"],
];

const NL = source.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : String.fromCharCode(10);
const mutants = [
  ["BASE (no change)", "const ULID = ", "const ULID = "],
  ["namesOnlyWorkflow check", "const namesOnlyWorkflow = namedWorkflows.length === 0\n      || namedWorkflows.length === 1 && namedWorkflows[0]?.workflowId === workflowRef;", "const namesOnlyWorkflow = true;"],
  ["CONDITIONAL_OR_QUESTION in workflow status", "if (CONDITIONAL_OR_QUESTION.test(clause) || HEARSAY.test(clause) || RETRACTION.test(clause)) return false;\n    if (status === \"prepared\")", "if (HEARSAY.test(clause) || RETRACTION.test(clause)) return false;\n    if (status === \"prepared\")"],
  ["RETRACTION in workflow status", "if (CONDITIONAL_OR_QUESTION.test(clause) || HEARSAY.test(clause) || RETRACTION.test(clause)) return false;\n    if (status === \"prepared\")", "if (CONDITIONAL_OR_QUESTION.test(clause) || HEARSAY.test(clause)) return false;\n    if (status === \"prepared\")"],
  ["NEGATION on done", "return pattern !== null && pattern.test(clause) && !NEGATION.test(clause);", "return pattern !== null && pattern.test(clause);"],
  ["NEGATION on offered", "return OWNER_OFFERED.test(clause) && !NEGATION.test(clause);", "return OWNER_OFFERED.test(clause);"],
  ["prepared excludes not-done", "return PREPARATION_REQUEST.test(clause) && !OWNER_ACTION_NOT_DONE.test(clause);", "return PREPARATION_REQUEST.test(clause);"],
  ["offer names no application item", "return namesNoApplicationItem && namesProgram;", "return namesProgram;"],
  ["offer names its program", "return namesNoApplicationItem && namesProgram;", "return namesNoApplicationItem;"],
  ["existing preparedDetails needs a request", "if (preparedDetails !== null && !isNew && !targetClauses.some((clause) => PREPARATION_REQUEST.test(clause))) {", "if (false) {"],
  ["model workflowStatusAllowed", "if (!workflowStatusAllowed(kind, status)) return false;", ""],
  ["application item program match", "|| existingApplication !== undefined && existingApplication.programId !== item.programRef", ""],
  ["verified deadline source in clause", "if (checkedVerification.state === \"verified\" && !targetClauses.some((clause) =>", "if (false && !targetClauses.some((clause) =>"],
  ["deadline date in target clause", "if (date !== null && !targetClauses.some((clause) => evidenceSupportsDate(clause, date))) {", "if (false) {"],
];

const results = [];
for (let [name, from, to] of mutants) {
  from = from.replaceAll(String.fromCharCode(10), NL); to = to.replaceAll(String.fromCharCode(10), NL);
  if (!source.includes(from)) { results.push(`${name}: PATTERN NOT FOUND`); continue; }
  const file = `university-tracker-model.mut${results.length}.ts`;
  writeFileSync(dir + file, source.replace(from, to));
  const mod = await import(`${dir}${file}`);
  const killedBy = [];
  for (const [tname, expectOk, text, upd, useExisting] of tests) {
    let update = upd;
    if (useExisting) update = wu(existing(text));
    else if (upd === "offer") update = wu(offer(text));
    else if (upd === "dlok") update = wu(dl(text, "America/Toronto"));
    else if (upd === "dlbad") update = wu(dl(text, "Mars/Olympus"));
    let ok;
    try { mod.parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [update] }, text, { redactText: (x) => ({ ok: true, text: x }) }, snapshot(Boolean(useExisting))); ok = true; } catch { ok = false; }
    if (ok !== expectOk) killedBy.push(tname);
  }
  results.push(`${name.startsWith("BASE") ? (killedBy.length === 0 ? "BASE OK " : "BASE FAILS") : killedBy.length === 0 ? "SURVIVES" : "killed  "} | ${name}${killedBy.length ? " <- " + killedBy.join(", ") : ""}`);
  rmSync(dir + file);
}
console.log(results.join("\n"));
