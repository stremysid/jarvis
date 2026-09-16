// Round-3 findings on the real repository (node:sqlite, all migrations incl. 0029) at 61bf0f2.
import { freshDb, seedPrincipal, apply, program, appItem, wfNew, P, UniversityTrackerRepository } from "./repo.mjs";
const repo = (d1) => new UniversityTrackerRepository(d1);
const wf = async (d1) => (await repo(d1).listWorkflowItemsByDueDate(P)).map((r) => `${r.university} ${r.programName}: ${r.label} [${r.status}]`);
const apps = async (d1) => (await repo(d1).listApplicationItemsByDueDate(P)).map((r) => `${r.label} [${r.status}]`);
async function tryApply(d1, t, plan) { try { await apply(d1, t, plan); console.log("  STORED  |", t); } catch (e) { console.log(`  refused (${e.message}) |`, t); } }
{
  console.log("--- #52 regression: someone else's report marks the essay submitted");
  const d1 = freshDb(); seedPrincipal(d1);
  let t = "Add Western University Medical Sciences and the Western essay.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "Western University", "Medical Sciences")],
    applicationUpdates: [appItem("new-item-1", "new-1", "essay", "Western essay", "not_started", t)] });
  const p = s.programs[0];
  console.log("  digest before:", await apps(d1));
  for (const msg of ["My sister told me I submitted the Western essay.", "I submitted the Western essay. Wait, I'm not sure it uploaded."]) {
    await tryApply(d1, msg, { applicationUpdates: [{ itemRef: p.applicationItems[0].itemId, programRef: p.programId, kind: null, label: null, status: "submitted_by_sid", statusEvidence: msg, dueDate: null }] });
  }
  console.log("  digest after:", await apps(d1), "| status:", (await repo(d1).readSnapshot(P)).programs[0].applicationItems[0].status);
}
{
  console.log("--- negated 'accepted me' and a different program's offer are recorded as offers");
  const d1 = freshDb(); seedPrincipal(d1);
  let t = "Add University of Waterloo Computer Science.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "University of Waterloo", "Computer Science")] });
  const wat = s.programs[0];
  t = "Waterloo still hasn't accepted me.";
  await tryApply(d1, t, { workflowUpdates: [wfNew("new-workflow-1", wat.programId, null, "offer", "offer", "university", "owner_reported_offered", t)] });
  console.log("  digest:", await wf(d1));
  const d2 = freshDb(); seedPrincipal(d2);
  s = await apply(d2, "Add University of Waterloo Computer Science.", { programUpdates: [program("new-1", "University of Waterloo", "Computer Science")] });
  t = "I got a Waterloo Math offer.";
  await tryApply(d2, t, { workflowUpdates: [wfNew("new-workflow-1", s.programs[0].programId, null, "offer", "offer", "university", "owner_reported_offered", t)] });
  console.log("  digest:", await wf(d2));
}
