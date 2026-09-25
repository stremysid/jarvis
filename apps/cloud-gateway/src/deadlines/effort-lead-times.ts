/**
 * The default lead time per effort, in minutes.
 *
 * This is a stored setting, not a judgment: it is the starting reminder window
 * for a kind of work, and `lead_minutes` on one deadline overrides it. Which
 * kind a deadline is comes from Jarvis through `deadline_record`, or from a
 * source that states it explicitly. It is never read off the title.
 *
 * The title keyword classifier that used to live in this file was deleted. A
 * title is weak evidence -- "Unit 4" is a real assignment title and says
 * nothing at all; "Final Draft" is an essay and "Final Project" is a project --
 * so choosing a category from a word table was code making a decision the
 * roadmap gives to Jarvis. See docs/CODE-VS-JUDGMENT.md.
 *
 * `quiz` at twelve hours is the shortest deliberately. It puts the reminder in
 * the evening before or the morning of, depending on when the digest next
 * runs, which is what "same-day" means for something you revise for once.
 *
 * `other` is an unknown, not a small piece of work, so it sits above `quiz`
 * and below `test`: being early about a quiz costs a glance, and being late to
 * an unrecognised project costs the project.
 */

import type { DeadlineEffort } from "./deadline-types.js";

export const DEFAULT_LEAD_MINUTES: Readonly<Record<DeadlineEffort, number>> = Object.freeze({
  exam: 10_080,    // 7 days
  project: 7_200,  // 5 days
  essay: 4_320,    // 3 days
  test: 2_880,     // 2 days
  other: 1_440,    // 1 day
  quiz: 720,       // 12 hours
});
