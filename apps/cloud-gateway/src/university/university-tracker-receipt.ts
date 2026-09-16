import type {
  OwnerUniversityPlan,
  UniversityApplicationItemStatus,
  UniversityProgram,
  UniversityTrackerSnapshot,
  UniversityVerificationState,
  UniversityWorkflowKind,
  UniversityWorkflowStatus,
} from "./university-tracker-types.js";
import { unverifiedDraftText } from "./university-tracker-model.js";

/**
 * Sid learns what was saved only from these fixed sentences, built from the
 * validated plan that the repository stored and from tracked names. The model's
 * free text is never the thing that says a tracker row was saved.
 */

const OFFER_WORDS = /(?:\b(?:an?|my|the|their|this|that|no|any)|['’]s)\s+(?:(?:[\p{L}'’-]+\s+){0,3})?offer\b|\b(?:offer\s+of\s+admission|admission\s+offer|acceptance\s+letter)\b/iu;
const OFFER_REPORT_VERB = /\b(?:got|gotten|received|have|has|had|came|arrived|sent|gave|made|extended|accepted|declined|rescinded|withdrew|lost|is\s+in|are\s+in|in\s+hand)\b/iu;
const DECISION_WORDS = /\b(?:accepted\s+me|got\s+in(?:to)?\b(?!\s+touch)|admitted|wait-?listed|waitlist|rejected|rejection|withdrew|withdrawn|deferred|deferral|(?:accepted|declined|turned\s+down)\s+(?:my|the|their|an?)\b|conditions?\s+(?:of|on|for)\s+(?:my|the)\b)/iu;
const NEGATED_OR_UNSURE = /\b(?:no|not|never|none|nothing|yet|instead|rather|hope|wish|dreamt|dreamed|dream|imagine|pretend|think|maybe|might|probably|scared|worried|afraid|guess|bet|sure|if|unless|said|says|told|heard|asked|friend|mom|dad|counsell?or|teacher)\b|n['’]t\b|\?/iu;

type OfferHint = "offer" | "waitlisted" | "rejected" | "withdrew" | "accepted" | "declined" | "conditions";

function normalized(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-CA").replace(/[’ʼ`]/gu, "'")
    .replace(/(\p{L})'s\b/gu, "$1").replace(/[^\p{L}\p{N}']+/gu, " ").replace(/\s+/gu, " ").trim();
}

function mentionsName(value: string, name: string): boolean {
  const needle = normalized(name);
  return needle.length > 0 && ` ${normalized(value)} `.includes(` ${needle} `);
}

function universityAliases(university: string): readonly string[] {
  return Object.freeze([...new Set([
    university,
    university.replace(/^university\s+of\s+/iu, "").replace(/\s+university$/iu, ""),
  ].map((value) => value.trim()).filter(Boolean))]);
}

function sentences(value: string): readonly string[] {
  return Object.freeze((value.match(/[^.!?\r\n]+[.!?]*/gu) ?? []).map((sentence) => sentence.trim()).filter(Boolean));
}

/**
 * True when a non-question sentence reports an offer, decision or offer
 * condition about Sid. Such a turn never shows model free text: it gets a
 * receipt when the explicit sentence was saved, or the fixed not-saved line.
 */
export function isOfferUpdateReport(ownerMessage: string, snapshot: UniversityTrackerSnapshot | null): boolean {
  if (!ownerMessage.isWellFormed()) return false;
  const message = ownerMessage.normalize("NFC");
  const namesTrackedSchool = snapshot?.programs.some((program) =>
    universityAliases(program.university).some((alias) => mentionsName(message, alias))) ?? false;
  return sentences(message).some((sentence) => {
    if (sentence.endsWith("?")) return false;
    const firstPerson = /\b(?:i|i'm|i've|me|my)\b/iu.test(sentence.replace(/’/gu, "'"));
    if (OFFER_WORDS.test(sentence) && OFFER_REPORT_VERB.test(sentence) && (firstPerson || namesTrackedSchool)) {
      return true;
    }
    return DECISION_WORDS.test(sentence) && namesTrackedSchool;
  });
}

function offerHint(ownerMessage: string): OfferHint {
  if (/\bwait-?list/iu.test(ownerMessage)) return "waitlisted";
  if (/\b(?:rejected|rejection)\b/iu.test(ownerMessage)) return "rejected";
  if (/\bwithdr(?:ew|awn|aw)\b/iu.test(ownerMessage)) return "withdrew";
  if (/\bconditions?\b/iu.test(ownerMessage)) return "conditions";
  if (/\b(?:declined|decline|turned\s+down)\b/iu.test(ownerMessage)) return "declined";
  if (/\b(?:i|i've)\s+(?:just\s+)?accepted\b/iu.test(ownerMessage.replace(/’/gu, "'"))) return "accepted";
  return "offer";
}

function exampleSentence(hint: OfferHint, university: string, program: string): string {
  switch (hint) {
    case "waitlisted": return `I got waitlisted by ${university} for ${program}`;
    case "rejected": return `I got rejected by ${university} for ${program}`;
    case "withdrew": return `I withdrew from ${university} for ${program}`;
    case "accepted": return `I accepted my offer from ${university} for ${program}`;
    case "declined": return `I declined my offer from ${university} for ${program}`;
    case "conditions": return `I met the conditions of my offer from ${university} for ${program}`;
    default: return `I got an offer from ${university} for ${program}`;
  }
}

/**
 * The fixed line for an offer-family report that was not saved. It never says
 * anything was saved, and asks only for the missing tracked name when the
 * message was otherwise a plain first-person report.
 */
export function offerNotSavedLine(
  ownerMessage: string,
  snapshot: UniversityTrackerSnapshot | null,
  savedOtherChanges: boolean,
  saveFailed = false,
): string {
  const lead = saveFailed
    ? "I couldn't update your university tracker, so nothing from that message was saved."
    : savedOtherChanges
      ? "I didn't save an offer update from that message."
      : "I didn't save anything from that message.";
  const tail = "Send any other question separately.";
  const programs = snapshot?.programs ?? [];
  if (programs.length === 0) {
    return `${lead} Add the university and program to your tracker first, then send the update as its own message. ${tail}`;
  }
  const hint = offerHint(ownerMessage);
  const universities = [...new Set(programs.filter((program) =>
    universityAliases(program.university).some((alias) => mentionsName(ownerMessage, alias)))
    .map((program) => program.university))];
  const reportText = sentences(ownerMessage).filter((sentence) => !sentence.endsWith("?")).join(" ");
  const plainReport = reportText.length > 0 && !NEGATED_OR_UNSURE.test(reportText.replace(/’/gu, "'"));
  const university = universities.length === 1 ? universities[0] ?? "<university>" : "<university>";
  const atSchool = programs.filter((program) => program.university === university);
  const named = atSchool.filter((program) => mentionsName(ownerMessage, program.programName));
  const program = named.length === 1 ? named[0]?.programName ?? "<program>" : "<program>";
  const example = exampleSentence(hint, university, program);
  if (saveFailed) return `${lead} Try again later as one sentence on its own, like: ${example}. ${tail}`;
  if (!plainReport) {
    return `${lead} I only save an offer update you state directly in one sentence on its own, like: ${example}. ${tail}`;
  }
  if (named.length === 1) {
    return `${lead} Offer updates are saved only from one sentence sent on its own. To record it, send exactly: ${example}. ${tail}`;
  }
  if (universities.length === 1) {
    const tracked = atSchool.slice(0, 4).map((candidate: UniversityProgram) => candidate.programName).join(", ");
    return `${lead} Which ${university} program is it (tracked: ${tracked})? Send one sentence on its own, like: ${example}. ${tail}`;
  }
  return `${lead} Which university and program is it? Send one sentence on its own, like: ${example}. ${tail}`;
}

function verificationWord(state: UniversityVerificationState): string {
  return state === "verified" ? "verified" : "unverified";
}

function applicationStatusWords(status: UniversityApplicationItemStatus): string {
  switch (status) {
    case "not_started": return "not started";
    case "drafting": return "drafting";
    case "ready": return "ready";
    case "submitted_by_sid": return "submitted by you (you told me)";
    default: return "not needed (you told me)";
  }
}

function offerReceipt(name: string, status: UniversityWorkflowStatus): string | null {
  switch (status) {
    case "owner_reported_offered": return `Saved: ${name} offer (you told me; unverified).`;
    case "owner_reported_waitlisted": return `Saved: ${name} waitlist (you told me; unverified).`;
    case "owner_reported_rejected": return `Saved: ${name} rejection (you told me; unverified).`;
    case "owner_reported_withdrawn": return `Saved: you withdrew from ${name} (you told me; unverified).`;
    case "owner_reported_pending": return `Saved: ${name} offer conditions still pending (you told me; unverified).`;
    case "owner_reported_satisfied": return `Saved: ${name} offer conditions met (you told me; unverified).`;
    case "owner_reported_unsatisfied": return `Saved: ${name} offer conditions not met (you told me; unverified).`;
    case "owner_reported_accepted": return `Saved: you accepted the ${name} offer (you told me; unverified).`;
    case "owner_reported_declined": return `Saved: you declined the ${name} offer (you told me; unverified).`;
    case "prepared": return `Saved: a draft reply to the ${name} offer (unverified draft; you send any reply yourself).`;
    default: return null;
  }
}

function stepReceipt(name: string, label: string, status: UniversityWorkflowStatus | null): string {
  switch (status) {
    case "prepared": return `Saved: ${label} for ${name} as prepared (unverified; you do this step yourself).`;
    case "owner_reported_done": return `Saved: ${label} for ${name} marked done (you told me; unverified).`;
    case "owner_reported_not_done": return `Saved: ${label} for ${name} marked not done (you told me).`;
    case "not_needed_by_sid": return `Saved: ${label} for ${name} marked not needed (you told me).`;
    default: return `Saved: updated ${label} for ${name}.`;
  }
}

function isOfferKind(kind: UniversityWorkflowKind | undefined): boolean {
  return kind === "offer" || kind === "offer_condition" || kind === "offer_response";
}

/** Whether a validated plan stores at least one offer, condition or response row. */
export function planSavesOfferUpdate(plan: OwnerUniversityPlan, snapshot: UniversityTrackerSnapshot): boolean {
  return plan.workflowUpdates.some((update) => isOfferKind(update.kind ?? snapshot.programs
    .flatMap((program) => program.workflowItems ?? [])
    .find((item) => item.workflowId === update.workflowRef)?.kind));
}

/** Fixed receipt lines for a university plan the repository has just stored. */
export function universityPlanReceipt(plan: OwnerUniversityPlan, snapshot: UniversityTrackerSnapshot): string {
  const lines: string[] = [];
  const programName = (programRef: string): string => {
    const tracked = snapshot.programs.find((program) => program.programId === programRef);
    if (tracked !== undefined) return `${tracked.university} ${tracked.programName}`;
    const created = plan.programUpdates.find((update) => update.programRef === programRef);
    return created?.university !== null && created?.university !== undefined && created.programName !== null
      ? `${created.university} ${created.programName}`
      : "your tracked program";
  };
  for (const update of plan.programUpdates) {
    const name = programName(update.programRef);
    const isNew = !snapshot.programs.some((program) => program.programId === update.programRef);
    if (isNew) {
      lines.push(`Saved: ${name} (${verificationWord(update.verification?.state ?? "unverified")}).`);
    } else if (update.university !== null || update.campus !== null || update.programName !== null
      || update.ouacCode !== null || update.verification !== null) {
      lines.push(`Saved: updated details for ${name} (${verificationWord(update.verification?.state ?? "unverified")}).`);
    }
    for (const addition of update.addRequirements) {
      lines.push(`Saved requirement for ${name}: ${addition.label} (${verificationWord(addition.verification.state)}).`);
    }
    for (const addition of update.addDates) {
      lines.push(`Saved date for ${name}: ${addition.label}, ${addition.date ?? "no date yet"} (${verificationWord(addition.verification.state)}).`);
    }
    if (update.resolveItemIds.length > 0) {
      lines.push(`Saved: removed ${update.resolveItemIds.length} ${update.resolveItemIds.length === 1 ? "item" : "items"} from ${name}.`);
    }
  }
  const applicationItems = snapshot.programs.flatMap((program) => program.applicationItems
    .map((item) => ({ item, programId: program.programId })));
  for (const update of plan.applicationUpdates) {
    const existing = applicationItems.find((candidate) => candidate.item.itemId === update.itemRef);
    const name = programName(existing?.programId ?? update.programRef);
    const label = update.label ?? existing?.item.label ?? "application item";
    const parts: string[] = [];
    if (update.status !== null) parts.push(applicationStatusWords(update.status));
    if (update.dueDate !== null) {
      parts.push(update.dueDate.date === null
        ? "due date unverified"
        : `due ${update.dueDate.date} (${verificationWord(update.dueDate.verification.state)})`);
    }
    lines.push(`Saved: ${name} ${label}${parts.length === 0 ? "" : ` — ${parts.join("; ")}`}.`);
  }
  const workflowItems = snapshot.programs.flatMap((program) => (program.workflowItems ?? [])
    .map((item) => ({ item, programId: program.programId })));
  for (const update of plan.workflowUpdates) {
    const existing = workflowItems.find((candidate) => candidate.item.workflowId === update.workflowRef);
    const kind = update.kind ?? existing?.item.kind;
    const name = programName(existing?.programId ?? update.programRef);
    const status = update.status ?? null;
    if (isOfferKind(kind)) {
      const receipt = status === null ? null : offerReceipt(name, status);
      if (receipt !== null) lines.push(receipt);
      if (status === "prepared" && update.preparedDetails !== null) {
        const draft = unverifiedDraftText(update.preparedDetails);
        lines.push(`Unverified draft for you to review and send yourself:\n${draft}`);
      }
      continue;
    }
    lines.push(stepReceipt(name, update.label ?? existing?.item.label ?? "application step", status));
    if (update.preparedDetails !== null) {
      const draft = unverifiedDraftText(update.preparedDetails);
      lines.push(`Unverified draft for you to review and send yourself:\n${draft}`);
    }
    const deadline = update.deadline;
    if (deadline !== null && (deadline.date !== null || deadline.instant !== null)) {
      const when = deadline.date ?? `${deadline.instant ?? ""} ${deadline.timeZone ?? ""}`.trim();
      lines.push(`Saved deadline for ${update.label ?? existing?.item.label ?? "that step"}: ${when} (${verificationWord(deadline.verification.state)}).`);
    }
  }
  return lines.join("\n");
}
