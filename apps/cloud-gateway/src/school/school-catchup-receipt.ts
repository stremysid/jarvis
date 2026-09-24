import type { ApplyOwnerCatchupPlanResult, SchoolCatchupSaveReceipt } from "./school-catchup-types.js";

// Leaves room for a normal agent reply inside Telegram's 4,096 UTF-16 units.
const MAX_RECEIPT_CHARACTERS = 3_200;

function excerpt(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export function schoolPlanReceipt(
  result: ApplyOwnerCatchupPlanResult | undefined,
  saved: SchoolCatchupSaveReceipt | undefined,
  today: string,
): string {
  if (saved === undefined) return "Saved your school update. Detailed save counts are unavailable.";
  if (saved.replayed) return "This school update was already saved. No new changes.";
  const inserted = saved.courses.reduce((sum, course) => sum + course.insertedFacts.length, 0);
  const duplicate = saved.courses.reduce((sum, course) => sum + course.alreadySaved, 0);
  const heading = `Saved school work (owner-reported): ${inserted} new, ${duplicate} already saved (${inserted + duplicate} total).`;
  const todayActions = saved.actions.filter((action) => action.localDate === today)
    .sort((left, right) => left.sequenceRank - right.sequenceRank);
  const schedule = result?.scheduleSaved === false
    ? "Course notes saved; the proposed study schedule was not saved."
    : todayActions.length === 0 ? "No study blocks saved for today."
      : `Today: ${todayActions.map((action) => `${excerpt(action.courseName, 40)}: ${excerpt(action.text, 80)} (${action.estimatedMinutes} min)`).join("; ")}.`;
  const adjustment = result?.partialCodes.some((code) => code.startsWith("partial:repaired:"))
    ? "Schedule adjusted: proposed blocks were dropped or clamped to the storage limits."
    : "";
  // Counts for every course are retained before we spend space on examples.
  // Reducing the number of examples never hides how much work was committed.
  for (let examples = 2; examples >= 0; examples -= 1) {
    const courses = saved.courses.map((course) => {
      const shown = course.insertedFacts.slice(0, examples);
      const more = course.insertedFacts.length - shown.length;
      return `${excerpt(course.name, 80)}: ${course.insertedFacts.length} new, ${course.alreadySaved} already saved, ${course.resolved} resolved.`
        + shown.map((text) => ` ${excerpt(text, 120)}`).join("")
        + (more > 0 ? `; and ${more} more saved.` : "");
    });
    const text = [heading, ...courses, schedule, adjustment,
      `Study actions marked complete: ${saved.completedActions}.`].filter(Boolean).join("\n");
    if (text.length <= MAX_RECEIPT_CHARACTERS) return text;
  }
  // Validated stores have at most twelve courses; their count-only receipt fits.
  throw new RangeError("school_receipt_bounds_invalid");
}
