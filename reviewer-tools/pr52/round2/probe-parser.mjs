// Runs the PR's real parseOwnerUniversityPlan (5e1a2ed) against owner messages.
// "safe" is the outcome a correct guard should produce; FLAG marks a mismatch.
import { parseOwnerUniversityPlan } from "./tree/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { Redactor } from "./tree/apps/cloud-gateway/src/security/redaction.ts";

const r = new Redactor();
const id = (n) => "01k5fb9pg" + "0".repeat(14) + String(n).padStart(3, "0");
const TURN = id(900);
const NOW = "2026-09-15T19:00:00.000Z";
const unv = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
const item = (n, kind, label, status, extra = {}) => ({
  itemId: id(n), kind, label, status, dueDate: null, verification: unv, sourceTurnId: TURN,
  submittedAt: status === "submitted_by_sid" ? NOW : null, updatedAt: NOW, ...extra,
});
const program = (n, university, programName, applicationItems) => ({
  programId: id(n), university, campus: null, programName, ouacCode: null, verification: unv,
  requirements: [], dates: [], applicationItems,
});
const snapshot = {
  principalId: "p",
  programs: [
    program(1, "University of Waterloo", "Computer Science", [
      item(101, "supplementary_application", "Waterloo AIF", "drafting", {
        dueDate: "2027-02-01",
        verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027", verifiedAt: NOW },
      }),
      item(102, "transcript", "Waterloo transcript", "not_started"),
    ]),
    program(2, "Western University", "Medical Sciences", [
      item(201, "essay", "Western essay", "not_started"),
      item(202, "reference", "Western reference", "not_started"),
      item(203, "transcript", "Western transcript", "not_started"),
    ]),
    program(3, "Queen's University", "Commerce", [item(301, "scholarship", "Queen's scholarship", "not_needed_by_sid")]),
    program(4, "University of Toronto", "Engineering Science", [item(401, "essay", "UofT essay", "submitted_by_sid")]),
  ],
};
const ITEMS = {
  wat_aif: [101, 1], wat_tr: [102, 1], wes_essay: [201, 2], wes_ref: [202, 2], wes_tr: [203, 2],
  que_sch: [301, 3], tor_essay: [401, 4],
};

function parse(msg, update) {
  try {
    parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [update] }, msg, r, snapshot);
    return "ACCEPT";
  } catch (error) {
    return `reject(${error.message})`;
  }
}
function existing(msg, key, status, dueDate = null) {
  const [n, p] = ITEMS[key];
  return parse(msg, {
    itemRef: id(n), programRef: id(p), kind: null, label: null, status,
    statusEvidence: status === null ? null : msg, dueDate,
  });
}
function created(msg, p, kind, label, status, dueDate) {
  return parse(msg, {
    itemRef: "new-item-1", programRef: id(p), kind, label, status, statusEvidence: msg,
    dueDate: dueDate ?? { date: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: msg },
  });
}
const date = (value, evidence, verification = { state: "unverified", sourceUrl: null, cycle: null }) =>
  ({ date: value, verification, evidence });

const cases = [
  // group, message, runner, safe outcome
  ["B1 r1", "I submitted my Waterloo AIF. I haven't started the Western essay yet.", (m) => existing(m, "wes_essay", "submitted_by_sid"), "reject"],
  ["B1 r1", "I just submitted the Western essay. Actually no, the portal crashed, so it didn't go through.", (m) => existing(m, "wes_essay", "submitted_by_sid"), "reject"],
  ["B1 r1", "Counsellor asked me: I submitted the Western transcript, right? Not sure.", (m) => existing(m, "wes_tr", "submitted_by_sid"), "reject"],
  ["B1 r1", "Ms. Chen and I submitted your reference", (m) => existing(m, "wes_ref", "submitted_by_sid"), "reject"],
  ["B1 r1", "Ms. Chen and I submitted your Western reference", (m) => existing(m, "wes_ref", "submitted_by_sid"), "reject"],
  ["B1 r1", "I submitted none of them yet", (m) => existing(m, "wes_essay", "submitted_by_sid"), "reject"],
  ["B1 r1 fwd", "Hi Sid. I have uploaded your Western transcript to OUAC. Ms. Lee", (m) => existing(m, "wes_tr", "submitted_by_sid"), "reject"],
  ["B1 cross", "I submitted my Waterloo AIF and started the Western essay.", (m) => existing(m, "wes_essay", "submitted_by_sid"), "reject"],
  ["B1 cross", "I submitted the Waterloo AIF. Western essay is next.", (m) => existing(m, "wes_essay", "submitted_by_sid"), "reject"],
  ["B1 cross", "I uploaded the Waterloo transcript, the Western transcript is still with guidance.", (m) => existing(m, "wes_tr", "submitted_by_sid"), "reject"],
  ["B1 legit", "I submitted my Waterloo AIF!", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I submitted the AIF", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I just submitted the AIF for Waterloo", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "Submitted my Waterloo AIF", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I submitted my Waterloo AIF, so I don't have to think about it anymore", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I submitted my Waterloo AIF. What's next?", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I submitted my Waterloo AIF ", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["B1 legit", "I submitted my Waterloo AIF\nwhat's next", (m) => existing(m, "wat_aif", "submitted_by_sid"), "ACCEPT"],
  ["notneeded->submitted", "Keep the Queen's scholarship", (m) => existing(m, "que_sch", "submitted_by_sid"), "reject"],
  ["notneeded->submitted", "I need the Queen's scholarship after all", (m) => existing(m, "que_sch", "submitted_by_sid"), "reject"],
  ["notneeded->submitted", "Don't restore the Queen's scholarship, I never submitted it", (m) => existing(m, "que_sch", "submitted_by_sid"), "reject"],
  ["S1 retire neg", "Don't remove the Waterloo AIF", (m) => existing(m, "wat_aif", "not_needed_by_sid"), "reject"],
  ["S1 retire neg", "I'm not skipping the Waterloo AIF", (m) => existing(m, "wat_aif", "not_needed_by_sid"), "reject"],
  ["S1 retire neg", "I don't need help with the Waterloo AIF", (m) => existing(m, "wat_aif", "not_needed_by_sid"), "reject"],
  ["S1 retire neg", "I'm not doing the Waterloo AIF tonight, tomorrow instead", (m) => existing(m, "wat_aif", "not_needed_by_sid"), "reject"],
  ["S1 retire cross", "Remove the Western essay, keep the Waterloo AIF", (m) => existing(m, "wat_aif", "not_needed_by_sid"), "reject"],
  ["S1 retire legit", "I'm not applying for the Queen's scholarship", (m) => existing(m, "que_sch", "not_needed_by_sid"), "ACCEPT(no-op)"],
  ["S1 retire legit", "Skip the Western reference, it's a duplicate", (m) => existing(m, "wes_ref", "not_needed_by_sid"), "ACCEPT"],
  ["S1 reactivate neg", "Don't restore the Queen's scholarship", (m) => existing(m, "que_sch", "not_started"), "reject"],
  ["S1 reactivate neg", "I'm not going ahead with the Queen's scholarship", (m) => existing(m, "que_sch", "not_started"), "reject"],
  ["S1 reactivate legit", "I changed my mind, I'm doing the Queen's scholarship", (m) => existing(m, "que_sch", "not_started"), "ACCEPT"],
  ["correction cond", "If I didn't submit the UofT essay, remind me", (m) => existing(m, "tor_essay", "drafting"), "reject"],
  ["correction q", "Wait, I didn't submit the UofT essay?", (m) => existing(m, "tor_essay", "drafting"), "reject"],
  ["correction unrelated", "I never submit anything late, and the UofT essay went in fine", (m) => existing(m, "tor_essay", "drafting"), "reject"],
  ["correction legit", "I didn't actually submit the UofT essay, the portal crashed", (m) => existing(m, "tor_essay", "drafting"), "ACCEPT"],
  ["correction->notneeded", "I didn't submit the UofT essay, and I'm not applying there anymore", (m) => existing(m, "tor_essay", "not_needed_by_sid"), "ACCEPT"],
  ["S2 r1", "I haven't started the Western essay yet", (m) => existing(m, "wes_essay", "drafting"), "reject"],
  ["S2 cross not_started", "I've started my Waterloo AIF but haven't started the Western essay", (m) => existing(m, "wat_aif", "not_started"), "reject"],
  ["S2 cross ready", "I finished the Waterloo AIF and started the Western essay", (m) => existing(m, "wes_essay", "ready"), "reject"],
  ["S2 cross drafting", "I finished the Waterloo AIF and started the Western essay", (m) => existing(m, "wat_aif", "drafting"), "reject"],
  ["S2 legit", "I'm working on the Western essay", (m) => existing(m, "wes_essay", "drafting"), "ACCEPT"],
  ["S2 legit", "I began the Western essay today", (m) => existing(m, "wes_essay", "drafting"), "ACCEPT"],
  ["S2 legit", "I finished my Western essay but haven't proofread it", (m) => existing(m, "wes_essay", "ready"), "ACCEPT"],
  ["S2 legit", "I'm done with the Western essay", (m) => existing(m, "wes_essay", "ready"), "ACCEPT"],
  ["M4 r1", "ok what's next for the Waterloo AIF", (m) => existing(m, "wat_aif", null, date(null, "Waterloo AIF")), "reject"],
  ["M4 clear neg", "Don't remove the Waterloo AIF deadline", (m) => existing(m, "wat_aif", null, date(null, m)), "reject"],
  ["M4 clear q", "Is the Waterloo AIF date unknown now?", (m) => existing(m, "wat_aif", null, date(null, m)), "reject"],
  ["M4 question", "Is the Waterloo AIF due Feb 15, 2027?", (m) => existing(m, "wat_aif", null, date("2027-02-15", "Feb 15, 2027")), "reject"],
  ["M4 downgrade", "The Waterloo AIF is due Feb 1, 2027 right", (m) => existing(m, "wat_aif", null, date("2027-02-01", "Feb 1, 2027")), "reject(verified kept)"],
  ["M4 cross-item date", "Western essay due Feb 15, 2027 and the Waterloo AIF is on the site", (m) => existing(m, "wat_aif", null, date("2027-02-15", "Feb 15, 2027")), "reject"],
  ["M4 hearsay", "My friend thinks the Waterloo AIF might be due Feb 3, 2027", (m) => existing(m, "wat_aif", null, date("2027-02-03", "Feb 3, 2027")), "reject"],
  ["N3", "Western essay due 02/03/2027", (m) => existing(m, "wes_essay", null, date("2027-02-03", "02/03/2027")), "reject"],
  ["N3", "Western essay due 02/03/2027", (m) => existing(m, "wes_essay", null, date("2027-03-02", "02/03/2027")), "reject"],
  ["N3 legit", "Western essay due 13/02/2027", (m) => existing(m, "wes_essay", null, date("2027-02-13", "13/02/2027")), "ACCEPT"],
  ["L1", "Western essay due Feb 1, 2027; I have 15 essays to plan", (m) => existing(m, "wes_essay", null, date("2027-02-15", m)), "reject"],
  ["L1", "the Western essay may be due in 2027, maybe the 3rd week", (m) => existing(m, "wes_essay", null, date("2027-05-03", m)), "reject"],
  ["L1 legit", "Western essay due February 1st, 2027", (m) => existing(m, "wes_essay", null, date("2027-02-01", m)), "ACCEPT"],
  ["L1 legit", "Western essay due Feb. 1, 2027", (m) => existing(m, "wes_essay", null, date("2027-02-01", m)), "ACCEPT"],
  ["L1 legit", "Western essay due 1 February 2027", (m) => existing(m, "wes_essay", null, date("2027-02-01", m)), "ACCEPT"],
  ["L1 legit", "Western essay due February 1", (m) => existing(m, "wes_essay", null, date("2027-02-01", m)), "reject(no year)"],
  ["verified cycle=year", "Western essay due Feb 1, 2027 per https://uwo.ca/x", (m) => existing(m, "wes_essay", null, date("2027-02-01", m, { state: "verified", sourceUrl: "https://uwo.ca/x", cycle: "2027" })), "reject(no cycle stated)"],
  ["label meta", "Add Waterloo AIF February 1st for Waterloo", (m) => created(m, 1, "supplementary_application", "Waterloo AIF February 1st", "not_started"), "reject"],
  ["label meta", "Add Waterloo AIF 1 Feb for Waterloo", (m) => created(m, 1, "supplementary_application", "Waterloo AIF 1 Feb", "not_started"), "reject"],
  ["label meta", "Add Waterloo AIF 2027-02-01 for Waterloo", (m) => created(m, 1, "supplementary_application", "Waterloo AIF 2027/02/01", "not_started"), "reject"],
  ["label meta", "Add the Waterloo AIF official", (m) => created(m, 1, "supplementary_application", "Waterloo AIF ✅ official", "not_started"), "reject"],
  ["label legit", "Add the Waterloo video interview", (m) => created(m, 1, "supplementary_application", "Waterloo video interview", "not_started"), "ACCEPT"],
  ["label legit", "Add the May 5 info session essay for Western", (m) => created(m, 2, "essay", "May 5 info session essay", "not_started"), "ACCEPT"],
  ["new multiline", "Waterloo needs:\n- AIF\n- video interview", (m) => created(m, 1, "supplementary_application", "AIF", "not_started"), "ACCEPT"],
];

let flagged = 0;
for (const [group, message, runner, safe] of cases) {
  const actual = runner(message);
  const safeAccept = safe.startsWith("ACCEPT");
  const mismatch = actual.startsWith("ACCEPT") !== safeAccept;
  if (mismatch) flagged += 1;
  console.log(`${mismatch ? "FLAG" : "ok  "} | ${group.padEnd(22)} | safe=${safe.padEnd(22)} | actual=${actual.padEnd(52)} | ${JSON.stringify(message)}`);
}
console.log(`\n${flagged} mismatches of ${cases.length}`);
