import { D1, migrate, allMigrations } from "./d1.mjs";
import { UniversityTrackerRepository } from "./head/apps/cloud-gateway/src/university/university-tracker-repository.ts";
import { newUlid } from "./head/packages/contracts/src/index.ts";

export const dir = "./head/apps/cloud-gateway/src/persistence/migrations";
export function freshDb() { const d1 = new D1(); migrate(d1, dir, allMigrations(dir)); for (const r of d1.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='conversation_turns' AND sql LIKE '%conversation_turn_insert_invalid%'").all()) d1.db.exec(`DROP TRIGGER ${r.name}`); return d1; }
const P = "principal:owner";
let clock = Date.parse("2026-09-16T16:00:00.000Z");
export function tick() { clock += 60_000; return new Date(clock); }
export function seedPrincipal(d1, principalId = P) {
  d1.db.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?, 'service', 'active', 'owner', ?, ?)`).run(principalId, "2026-09-16T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
}
export function seedTurn(d1, at, principalId = P, channel = "telegram") {
  const turnId = newUlid(at);
  const iso = at.toISOString();
  d1.db.prepare(`INSERT INTO conversation_turns (turn_id, session_id, principal_id, channel, request_hash, user_event_id, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'user_committed', ?, ?)`).run(turnId, `${channel}:${principalId}`, principalId, channel, "a".repeat(64), newUlid(at), iso, iso);
  return turnId;
}
const unver = { state: "unverified", sourceUrl: null, cycle: null };
export async function apply(d1, text, plan, principalId = P) {
  const now = tick();
  const turnId = seedTurn(d1, now, principalId);
  const repo = new UniversityTrackerRepository(d1);
  await repo.applyOwnerPlan({ principalId, turnId, responseHash: "b".repeat(64), now,
    plan: { engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [], ...plan } });
  return repo.readSnapshot(principalId);
}
export function program(ref, university, programName) {
  return { programRef: ref, university, campus: null, programName, ouacCode: null, verification: unver, addRequirements: [], addDates: [], resolveItemIds: [] };
}
export function appItem(ref, programRef, kind, label, status, text) {
  return { itemRef: ref, programRef, kind, label, status, statusEvidence: text, dueDate: { date: null, verification: unver, evidence: text } };
}
export function wfNew(ref, programRef, applicationItemRef, kind, label, owner, status, text, extra = {}) {
  return { workflowRef: ref, programRef, applicationItemRef, kind, label, owner, status, statusEvidence: text, preparedDetails: null,
    deadline: { date: null, instant: null, timeZone: null, verification: unver, evidence: text }, executionBoundary: "owner_only", ...extra };
}
export function wfExisting(workflowRef, programRef, status, text, extra = {}) {
  return { workflowRef, programRef, applicationItemRef: null, kind: null, label: null, owner: null, status, statusEvidence: text,
    preparedDetails: null, deadline: null, executionBoundary: "owner_only", ...extra };
}
export { P, UniversityTrackerRepository, newUlid };

if (process.argv[2] !== "lib") {
  const d1 = freshDb();
  seedPrincipal(d1);
  let t = "Add University of Waterloo Computer Science and Western University Computer Science.";
  let s = await apply(d1, t, { programUpdates: [program("new-1", "University of Waterloo", "Computer Science"), program("new-2", "Western University", "Computer Science")] });
  const [wat, wes] = [s.programs.find((p) => p.university.includes("Waterloo")), s.programs.find((p) => p.university.includes("Western"))];
  t = "I got a conditional offer from Waterloo.";
  s = await apply(d1, t, { workflowUpdates: [wfNew("new-workflow-1", wat.programId, null, "offer", "conditional offer", "university", "owner_reported_offered", t)] });
  const watOffer = s.programs.find((p) => p.programId === wat.programId).workflowItems[0];
  console.log("seeded Waterloo offer:", watOffer.label, watOffer.status);
  // Sid later says he withdrew from Waterloo
  t = "I withdrew from the Waterloo conditional offer.";
  s = await apply(d1, t, { workflowUpdates: [wfExisting(watOffer.workflowId, wat.programId, "owner_reported_withdrawn", t)] });
  console.log("after withdraw:", s.programs.find((p) => p.programId === wat.programId).workflowItems[0].status);
  // A message about Western re-binds to Waterloo's offer row
  t = "I got a conditional offer from Western instead of Waterloo.";
  try {
    s = await apply(d1, t, { workflowUpdates: [wfExisting(watOffer.workflowId, wat.programId, "owner_reported_offered", t)] });
    const row = s.programs.find((p) => p.programId === wat.programId).workflowItems[0];
    console.log("REPOSITORY ACCEPTED cross-program offer: Waterloo row now", row.status, "rev", row.revision);
  } catch (e) { console.log("repository refused:", e.message); }
  t = "I got no offer from Western.";
  try {
    s = await apply(d1, t, { workflowUpdates: [wfNew("new-workflow-1", wes.programId, null, "offer", "offer", "university", "owner_reported_offered", t)] });
    console.log("REPOSITORY ACCEPTED 'I got no offer from Western' as", s.programs.find((p) => p.programId === wes.programId).workflowItems[0].status);
  } catch (e) { console.log("repository refused:", e.message); }
  const digest = await new UniversityTrackerRepository(d1).listWorkflowItemsByDueDate(P);
  console.log("digest rows:", digest.map((r) => `${r.university}: ${r.label} [${r.status}]`));
}
