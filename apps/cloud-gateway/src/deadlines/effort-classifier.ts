/**
 * Effort classification: what kind of thing is this, and how much warning does
 * it need?
 *
 * Without this the digest treats a Friday vocabulary quiz and a term project
 * as equally urgent, which is the same as treating neither as urgent. The
 * effort tag exists only to pick a lead time.
 *
 * What this cannot know is worth being blunt about. A title is weak evidence.
 * "Unit 4" is a real assignment title and says nothing at all; "Final Draft"
 * is an essay, "Final Project" is a project, and "Finals" is an exam, and no
 * amount of keyword work separates them reliably. So the classifier is
 * deliberately shy: it matches a small, fixed table of words that mean what
 * they say, it reports which word it matched so a caller can show its
 * working, and anything it does not recognise becomes `other` rather than a
 * confident guess. An explicit override always wins, because the override is
 * the owner correcting it and the whole point of having one is that this is
 * fallible.
 *
 * The title is untrusted text -- a teacher typed it into a system we do not
 * control, or a scraper lifted it off a page. It is read here as a bag of
 * tokens and compared against constants. Nothing in it becomes a pattern, a
 * lookup key, or anything a model is later asked to follow.
 */

import type { DeadlineEffort } from "./deadline-types.js";

/**
 * Default lead time per effort, in minutes.
 *
 * These are the plan's "a quiz gets a same-day reminder and a term project
 * gets days of warning", made specific. They are defaults: `lead_minutes` is
 * stored per deadline and any of these can be overridden for one item.
 *
 * `quiz` at twelve hours is the shortest deliberately. It puts the reminder in
 * the evening before or the morning of, depending on when the digest next
 * runs, which is what "same-day" means for something you revise for once.
 *
 * `other` sits above `quiz` and below `test`, and that ordering is the point:
 * a deadline we could not identify gets more warning than one we identified as
 * small. An unknown item is more likely to be a project we failed to recognise
 * than a quiz, and being early about a quiz costs a glance.
 */
export const DEFAULT_LEAD_MINUTES: Readonly<Record<DeadlineEffort, number>> = Object.freeze({
  exam: 10_080,    // 7 days
  project: 7_200,  // 5 days
  essay: 4_320,    // 3 days
  test: 2_880,     // 2 days
  other: 1_440,    // 1 day
  quiz: 720,       // 12 hours
});

/**
 * The keyword table. One entry per effort, in the order they are tried.
 *
 * The order IS the precedence rule, and the rule is one sentence: when a title
 * names two kinds of work, take the one that demands more, never the one that
 * demands less. Read down the list and it is exactly `DEFAULT_LEAD_MINUTES`
 * in descending order, which is what makes it a rule rather than a list of
 * decisions. "Unit 3 Quiz -- group project component" is a project: warning him
 * five days early about a quiz costs him nothing, and warning him twelve hours
 * before a project costs him the project.
 *
 * It is also deliberately independent of where the words appear. Ranking by
 * first occurrence would let the order of words in an untrusted title decide
 * how much warning the owner gets, and the order of words in a title is not
 * ours to trust.
 *
 * Two omissions are choices rather than oversights:
 *
 * "final" and "finals" are not exam keywords. "Final Draft", "Final Copy" and
 * "Final Project" are all vastly more common in a course than "final" meaning
 * an examination, and a false exam is not a harmless over-warning: an exam tag
 * creates a quiet window that suppresses real business traffic for hours. So
 * "Final Exam" matches on "exam" and a bare "Finals" does not match at all.
 *
 * "assignment", "homework", "lab" and "reading" are not mapped to anything.
 * They name a delivery format, not an amount of work -- an assignment can be
 * twenty minutes or three weeks -- and mapping them would replace an honest
 * `other` with a confident wrong answer.
 */
const EFFORT_KEYWORDS: readonly (readonly [DeadlineEffort, readonly string[]])[] = Object.freeze([
  ["exam", Object.freeze(["exam", "exams", "midterm", "midterms", "midyear"])],
  ["project", Object.freeze(["project", "projects", "presentation", "presentations"])],
  ["essay", Object.freeze(["essay", "essays", "paper", "papers", "thesis"])],
  ["test", Object.freeze(["test", "tests", "testing"])],
  ["quiz", Object.freeze(["quiz", "quizzes", "quizes"])],
]);

/** Non-alphanumeric runs separate tokens, so "Quiz:", "(quiz)" and "quiz -- unit 3" all match. */
const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;

/** A title longer than this is a scraper that grabbed the page, not a title; tokenizing all of it buys nothing. */
const MAXIMUM_CLASSIFIED_CHARACTERS = 512;

/** Where the effort came from, so a caller can say how much to trust it. */
export type EffortBasis = "override" | "keyword" | "fallback";

export interface EffortClassification {
  readonly effort: DeadlineEffort;
  readonly leadMinutes: number;
  readonly basis: EffortBasis;
  /** The word that decided it, or null for an override or a fallback. Kept so the digest can show its working. */
  readonly matchedKeyword: string | null;
}

/** The default lead time for an effort. Separate from classification because an override still needs one. */
export function defaultLeadMinutes(effort: DeadlineEffort): number {
  return DEFAULT_LEAD_MINUTES[effort];
}

/** Splits a title into lowercase tokens. Fixed separator, no pattern built from the input. */
export function titleTokens(title: string): readonly string[] {
  return title
    .slice(0, MAXIMUM_CLASSIFIED_CHARACTERS)
    .normalize("NFC")
    .toLowerCase()
    .split(TOKEN_SEPARATOR)
    .filter((token) => token.length > 0);
}

/**
 * Classify one deadline.
 *
 * `override` is the owner's per-course rule or a source that genuinely knows
 * the type. When it is present the title is not consulted at all: a rule that
 * loses to a keyword is not a rule.
 */
export function classifyEffort(title: string, override?: DeadlineEffort | null): EffortClassification {
  if (override !== undefined && override !== null) {
    return Object.freeze({
      effort: override,
      leadMinutes: DEFAULT_LEAD_MINUTES[override],
      basis: "override" as const,
      matchedKeyword: null,
    });
  }

  const tokens = new Set(titleTokens(title));
  for (const [effort, keywords] of EFFORT_KEYWORDS) {
    for (const keyword of keywords) {
      if (tokens.has(keyword)) {
        return Object.freeze({
          effort,
          leadMinutes: DEFAULT_LEAD_MINUTES[effort],
          basis: "keyword" as const,
          matchedKeyword: keyword,
        });
      }
    }
  }

  // Nothing recognised. `other` is an admission, not a category: it says we
  // read the title and it did not tell us anything, which is a different claim
  // from "this is a small piece of work".
  return Object.freeze({
    effort: "other" as const,
    leadMinutes: DEFAULT_LEAD_MINUTES.other,
    basis: "fallback" as const,
    matchedKeyword: null,
  });
}
