import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_MINUTES,
  classifyEffort,
  defaultLeadMinutes,
  titleTokens,
} from "../../src/deadlines/effort-classifier.js";
import type { DeadlineEffort } from "../../src/deadlines/deadline-types.js";

/** One keyword per effort the table actually recognises, used to build ambiguous titles. */
const KEYWORD: Readonly<Record<Exclude<DeadlineEffort, "other">, string>> = Object.freeze({
  exam: "exam",
  project: "project",
  essay: "essay",
  test: "test",
  quiz: "quiz",
});

describe("classifyEffort", () => {
  it("reads a plain quiz title as a quiz and gives it the shortest lead time of any effort", () => {
    const classification = classifyEffort("Unit 3 Quiz");
    expect(classification).toEqual({ effort: "quiz", leadMinutes: 720, basis: "keyword", matchedKeyword: "quiz" });
    expect(Math.min(...Object.values(DEFAULT_LEAD_MINUTES))).toBe(classification.leadMinutes);
  });

  it("resolves a title naming two kinds of work to the one that demands more, whichever order the words appear in", () => {
    const quizFirst = classifyEffort("Unit 3 Quiz - group project component");
    const projectFirst = classifyEffort("Group project - includes a quiz");

    expect(quizFirst.effort).toBe("project");
    expect(projectFirst.effort).toBe("project");
    // The rule is not "the first word wins". Word order in a scraped title is
    // not ours to trust, so the two orderings must agree.
    expect(quizFirst.leadMinutes).toBe(projectFirst.leadMinutes);
    expect(quizFirst.leadMinutes).toBeGreaterThan(DEFAULT_LEAD_MINUTES.quiz);
  });

  it("breaks every ambiguous pairing toward the longer lead time, which is the whole of the precedence rule", () => {
    const efforts = Object.keys(KEYWORD) as (keyof typeof KEYWORD)[];
    const pairs: { readonly title: string; readonly expected: DeadlineEffort }[] = [];
    for (const first of efforts) {
      for (const second of efforts) {
        if (first === second) continue;
        const expected = DEFAULT_LEAD_MINUTES[first] >= DEFAULT_LEAD_MINUTES[second] ? first : second;
        pairs.push({ title: `Unit 5 ${KEYWORD[first]} and ${KEYWORD[second]}`, expected });
      }
    }
    // Twenty pairings, so a precedence list reordered by hand cannot pass by
    // agreeing with the one or two cases someone thought to write down.
    expect(pairs).toHaveLength(20);
    expect(pairs.map((pair) => classifyEffort(pair.title).effort)).toEqual(pairs.map((pair) => pair.expected));
  });

  it("falls back to other rather than guessing when a title says nothing about the work", () => {
    for (const title of ["Unit 4", "Chapter 11 homework", "Lab writeup", "Reading: pages 40-60"]) {
      expect(classifyEffort(title)).toMatchObject({ effort: "other", basis: "fallback", matchedKeyword: null });
    }
  });

  it("gives an unrecognised title more warning than a quiz and less than a test, so being unsure is not read as being small", () => {
    expect(DEFAULT_LEAD_MINUTES.other).toBeGreaterThan(DEFAULT_LEAD_MINUTES.quiz);
    expect(DEFAULT_LEAD_MINUTES.other).toBeLessThan(DEFAULT_LEAD_MINUTES.test);
  });

  it("refuses to read the word final as an exam, because a false exam silences real business traffic", () => {
    expect(classifyEffort("Final Draft").effort).toBe("other");
    expect(classifyEffort("Finals week").effort).toBe("other");
    // The words that do mean an examination still work, including in the exact
    // title the rejected keyword was tempting for.
    expect(classifyEffort("Final Exam").effort).toBe("exam");
    expect(classifyEffort("Midterm").effort).toBe("exam");
    // And "Final Project" resolves on the word that carries information.
    expect(classifyEffort("Final Project").effort).toBe("project");
  });

  it("lets an override win outright and does not consult the title at all", () => {
    const overridden = classifyEffort("Final Exam - Calculus", "quiz");
    expect(overridden).toEqual({ effort: "quiz", leadMinutes: DEFAULT_LEAD_MINUTES.quiz, basis: "override", matchedKeyword: null });
    // An explicit `other` is a decision, not an absence of one, so it must not
    // fall through to the keyword table.
    expect(classifyEffort("Midterm", "other").effort).toBe("other");
    // A null or absent override is the absence of one and does consult it.
    expect(classifyEffort("Midterm", null).effort).toBe("exam");
    expect(classifyEffort("Midterm", undefined).effort).toBe("exam");
  });

  it("matches whole words only, so punctuation and casing do not hide a keyword and a substring does not invent one", () => {
    expect(classifyEffort("QUIZ: unit 3").effort).toBe("quiz");
    expect(classifyEffort("(quiz) unit 3").effort).toBe("quiz");
    expect(classifyEffort("Unit 3 -- quiz").effort).toBe("quiz");
    // "quizzical" contains "quiz" and is not a quiz.
    expect(classifyEffort("A quizzical reading response").effort).toBe("other");
    expect(classifyEffort("Protesting the reading").effort).toBe("other");
  });

  it("reports the keyword it matched so a caller can say how the answer was reached", () => {
    expect(classifyEffort("Chemistry midterm").matchedKeyword).toBe("midterm");
    expect(classifyEffort("Unit 4").matchedKeyword).toBeNull();
    expect(classifyEffort("Unit 4", "exam").matchedKeyword).toBeNull();
  });

  it("classifies a title that arrives with combining marks or unusual whitespace", () => {
    // Decomposed "c-cedilla" (c plus a combining mark) and a non-breaking
    // space, which is what a scraped title actually looks like. The token split
    // has to see the keyword through both.
    const scraped = "Français quiz";
    expect(scraped.normalize("NFC")).not.toBe(scraped);
    expect(classifyEffort(scraped).effort).toBe("quiz");
    expect(titleTokens(scraped)).toContain("quiz");
  });

  it("exposes the same default lead time through the classifier and the lookup", () => {
    for (const effort of Object.keys(DEFAULT_LEAD_MINUTES) as DeadlineEffort[]) {
      expect(defaultLeadMinutes(effort)).toBe(DEFAULT_LEAD_MINUTES[effort]);
      expect(classifyEffort("Unit 4", effort).leadMinutes).toBe(DEFAULT_LEAD_MINUTES[effort]);
    }
  });
});
