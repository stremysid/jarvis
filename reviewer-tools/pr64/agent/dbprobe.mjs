import { freshDb, seedPrincipal, seedTurn, apply, program, appItem, P, newUlid } from "./repo.mjs";

const d1 = freshDb();
seedPrincipal(d1);
const db = d1.db;
const t = "Add University of Waterloo Computer Science and the Waterloo AIF.";
let s = await apply(d1, t, { programUpdates: [program("new-1", "University of Waterloo", "Computer Science")],
  applicationUpdates: [appItem("new-item-1", "new-1", "supplementary_application", "Waterloo AIF", "not_started", t)] });
const prog = s.programs[0], aif = prog.applicationItems[0];
const at = new Date("2026-09-17T00:00:00.000Z");
const turn = seedTurn(d1, at);
const voiceTurn = seedTurn(d1, new Date("2026-09-17T00:01:00.000Z"), P, "voice");
function tryRun(name, fn) { try { fn(); console.log("ALLOWED  |", name); } catch (e) { console.log("refused  |", name, "|", e.message); } }
const wid = newUlid(at);
db.prepare(`INSERT INTO university_workflow_items (principal_id, program_id, application_item_id, workflow_id, workflow_key, workflow_kind, workflow_label, owner_role, created_at)
  VALUES (?,?,?,?,?,'submission_step','Waterloo AIF submission','sid',?)`).run(P, prog.programId, aif.itemId, wid, "k1", "2026-09-17T00:00:00.000Z");
const rev = (n, status, turnId, created, extra = "") => db.prepare(`INSERT ${extra} INTO university_workflow_revisions (principal_id, workflow_id, event_id, revision_number, workflow_status, prepared_details, execution_boundary, due_date, due_at, due_timezone, verification_state, source_url, admission_cycle, verified_at, source_turn_id, created_at)
  VALUES (?,?,?,?,?,NULL,'owner_only',NULL,NULL,NULL,'unverified',NULL,NULL,NULL,?,?)`).run(P, wid, newUlid(new Date(Date.parse(created) + n)), n, status, turnId, created);
tryRun("revision 1 from a VOICE turn", () => rev(1, "prepared", voiceTurn, "2026-09-17T00:05:00.000Z"));
tryRun("revision 1 created before the item", () => rev(1, "prepared", turn, "2026-09-16T00:00:00.000Z"));
tryRun("revision 1 valid", () => rev(1, "prepared", turn, "2026-09-17T00:05:00.000Z"));
tryRun("revision 2 created BEFORE revision 1 (clock regression)", () => rev(2, "owner_reported_done", turn, "2026-09-17T00:01:00.000Z"));
tryRun("UPSERT ON CONFLICT DO UPDATE on items", () => db.prepare(`INSERT INTO university_workflow_items (principal_id, program_id, application_item_id, workflow_id, workflow_key, workflow_kind, workflow_label, owner_role, created_at)
  VALUES (?,?,?,?,?,'submission_step','x','sid',?) ON CONFLICT DO UPDATE SET workflow_label='y'`).run(P, prog.programId, aif.itemId, wid, "k1", "2026-09-17T00:00:00.000Z"));
tryRun("offer kind linked to an application item", () => db.prepare(`INSERT INTO university_workflow_items (principal_id, program_id, application_item_id, workflow_id, workflow_key, workflow_kind, workflow_label, owner_role, created_at)
  VALUES (?,?,?,?,?,'offer','o','university',?)`).run(P, prog.programId, aif.itemId, newUlid(new Date(at.getTime() + 5)), "k2", "2026-09-17T00:00:00.000Z"));
tryRun("UPDATE application item program under a linked workflow", () => db.prepare(`UPDATE university_application_items SET program_id = program_id WHERE item_id = ?`).run(aif.itemId));
console.log("latest rows:", db.prepare("SELECT revision_number, workflow_status, created_at FROM university_workflow_revisions WHERE workflow_id = ? ORDER BY revision_number").all(wid));
