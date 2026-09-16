import { compose } from "./head/apps/cloud-gateway/src/digest/digest-composer.ts";
import * as F from "./fixtures.mjs";
const base = { catchupActions: [], applicationItems: [], deadlines: [], projects: [], decisions: [], gaps: [], grades: [], missingWork: [] };
const wf = (dueAt, tz) => ({ workflowId: F.WF_ESSAY_SUB, university: "Western University", programName: "Computer Science", label: "Western essay submission",
  owner: "sid", status: "prepared", dueDate: null, dueAt, dueTimeZone: tz, verificationState: "unverified" });
for (const [at, tz] of [["2027-01-16T04:59:00.000Z", "America/Toronto"], ["2027-07-01T03:59:00.000Z", "America/Toronto"], ["2027-01-16T07:59:00.000Z", "America/Vancouver"]]) {
  const d = compose({ ...base, universityWorkflowItems: [wf(at, tz)] }, { kind: "daily", timeZone: "America/Toronto" }, { now: () => new Date(F.NOW) });
  console.log(d.text.split("\n").filter((l) => l.includes("Western essay")).join(" / "));
}
