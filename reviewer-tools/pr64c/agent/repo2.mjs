import { freshDb, seedPrincipal, apply, program, appItem, wfNew, wfExisting, P, UniversityTrackerRepository } from "./repo.mjs";
const digest = async (d1) => (await new UniversityTrackerRepository(d1).listWorkflowItemsByDueDate(P)).map((r) => `${r.university}: ${r.label} [${r.status}]`);
async function tryApply(d1, t, plan) { try { const s = await apply(d1, t, plan); console.log("  stored |", t); return s; } catch (e) { console.log("  refused (" + e.message + ") |", t); return null; } }
{
  console.log("--- H2 on the real repository (Waterloo CS, Western CS)");
  const d1 = freshDb(); seedPrincipal(d1);
  let t = "Add University of Waterloo Computer Science and Western University Computer Science.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "University of Waterloo", "Computer Science"), program("new-2", "Western University", "Computer Science")] });
  const wat = s.programs.find((p) => p.university.includes("Waterloo"));
  t = "I got a conditional offer from Waterloo for Computer Science.";
  s = await tryApply(d1, t, { workflowUpdates: [wfNew("new-workflow-1", wat.programId, null, "offer", "conditional offer", "university", "owner_reported_offered", t)] });
  const offer = s.programs.find((p) => p.programId === wat.programId).workflowItems[0];
  t = "I withdrew from the Waterloo Computer Science conditional offer.";
  await tryApply(d1, t, { workflowUpdates: [wfExisting(offer.workflowId, wat.programId, "owner_reported_withdrawn", t)] });
  t = "I got a conditional offer from Western instead of Waterloo.";
  await tryApply(d1, t, { workflowUpdates: [wfExisting(offer.workflowId, wat.programId, "owner_reported_offered", t)] });
  t = "I got a Computer Science conditional offer from Toronto instead of Waterloo.";
  await tryApply(d1, t, { workflowUpdates: [wfExisting(offer.workflowId, wat.programId, "owner_reported_offered", t)] });
  console.log("  digest:", await digest(d1));
}
{
  console.log("--- M6: step of a submitted item leaves the digest");
  const d1 = freshDb(); seedPrincipal(d1);
  let t = "Add Western University Computer Science and the Western essay, and prepare the Western essay submission for the Western essay.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "Western University", "Computer Science")],
    applicationUpdates: [appItem("new-item-1", "new-1", "essay", "Western essay", "not_started", t)],
    workflowUpdates: [wfNew("new-workflow-1", "new-1", "new-item-1", "submission_step", "Western essay submission", "sid", "prepared", t)] });
  const p = s.programs[0];
  console.log("  before:", await digest(d1));
  t = "I submitted the Western essay.";
  await tryApply(d1, t, { applicationUpdates: [{ itemRef: p.applicationItems[0].itemId, programRef: p.programId, kind: null, label: null, status: "submitted_by_sid", statusEvidence: t, dueDate: null }] });
  console.log("  after:", await digest(d1));
}
{
  console.log("--- regression: an OPEN step whose parent is submitted also leaves the digest");
  const d1 = freshDb(); seedPrincipal(d1);
  let t = "Add Western University Computer Science and the Western scholarship, and prepare the Ms Lee reference request for the Western scholarship.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "Western University", "Computer Science")],
    applicationUpdates: [appItem("new-item-1", "new-1", "scholarship", "Western scholarship", "not_started", t)],
    workflowUpdates: [wfNew("new-workflow-1", "new-1", "new-item-1", "contact_step", "Ms Lee reference request", "sid", "prepared", t)] });
  const p = s.programs[0];
  console.log("  before:", await digest(d1));
  t = "I submitted the Western scholarship.";
  await tryApply(d1, t, { applicationUpdates: [{ itemRef: p.applicationItems[0].itemId, programRef: p.programId, kind: null, label: null, status: "submitted_by_sid", statusEvidence: t, dueDate: null }] });
  console.log("  after (Ms Lee request still not sent):", await digest(d1));
}
