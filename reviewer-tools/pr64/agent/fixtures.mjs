export const TURN = "01k5j000000000000000000001";
export const WATERLOO = "01k5j000000000000000000002";
export const WESTERN = "01k5j00000000000000000000a";
export const W_AIF = "01k5j000000000000000000003";
export const WE_REF = "01k5j00000000000000000000b";
export const WE_ESSAY = "01k5j00000000000000000000c";
export const WF_CONTACT = "01k5j000000000000000000004";
export const WF_OFFER_WAT = "01k5j000000000000000000006";
export const WF_ESSAY_SUB = "01k5j000000000000000000007";
export const WF_AIF_PAY = "01k5j000000000000000000008";
export const NOW = "2026-09-16T15:00:00.000Z";
const unver = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
function app(itemId, kind, label, status = "drafting") {
  return { itemId, kind, label, status, dueDate: null, verification: unver, sourceTurnId: TURN, submittedAt: null, updatedAt: NOW };
}
function wf(workflowId, applicationItemId, kind, label, status, owner = "sid") {
  return { workflowId, eventId: "01k5j0000000000000000000e" + workflowId.slice(-1), revision: 1, applicationItemId, kind, label, owner, status,
    preparedDetails: null, executionBoundary: "owner_only",
    deadline: { date: null, instant: null, timeZone: null, verification: unver }, sourceTurnId: TURN, updatedAt: NOW };
}
export function snapshot({ sameProgramName = true, workflows = true } = {}) {
  return {
    principalId: "principal:owner",
    programs: [
      { programId: WATERLOO, university: "University of Waterloo", campus: null, programName: "Computer Science", ouacCode: null,
        verification: unver, requirements: [], dates: [],
        applicationItems: [app(W_AIF, "supplementary_application", "Waterloo AIF")],
        workflowItems: workflows ? [
          wf(WF_OFFER_WAT, null, "offer", "conditional offer", "owner_reported_waitlisted", "university"),
          wf(WF_AIF_PAY, W_AIF, "payment_step", "Waterloo AIF fee", "prepared"),
        ] : [] },
      { programId: WESTERN, university: "Western University", campus: null, programName: sameProgramName ? "Computer Science" : "Medical Sciences", ouacCode: null,
        verification: unver, requirements: [], dates: [],
        applicationItems: [app(WE_REF, "reference", "Western reference"), app(WE_ESSAY, "essay", "Western essay")],
        workflowItems: workflows ? [
          wf(WF_CONTACT, WE_REF, "contact_step", "Ms Lee reference request", "prepared"),
          wf(WF_ESSAY_SUB, WE_ESSAY, "submission_step", "Western essay submission", "prepared"),
        ] : [] },
    ],
  };
}
export const redactor = { redactText: (t) => ({ ok: true, text: t }) };
export function existingUpdate(workflowRef, programRef, status, text) {
  return { workflowRef, programRef, applicationItemRef: null, kind: null, label: null, owner: null, status,
    statusEvidence: text, preparedDetails: null, deadline: null, executionBoundary: "owner_only" };
}
export function newUpdate(programRef, kind, label, status, text, applicationItemRef = null, owner = "sid") {
  return { workflowRef: "new-workflow-1", programRef, applicationItemRef, kind, label, owner, status,
    statusEvidence: text, preparedDetails: null,
    deadline: { date: null, instant: null, timeZone: null, verification: { state: "unverified", sourceUrl: null, cycle: null }, evidence: text },
    executionBoundary: "owner_only" };
}
