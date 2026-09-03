import { describe, expect, it } from "vitest";
import {
  EXPLAIN_OPTION_KEY,
  EXPLAIN_OPTION_LABEL,
  FREE_TEXT_OPTION_KEY,
  FREE_TEXT_OPTION_LABEL,
  type DecisionItem,
  type DecisionOption,
} from "../../src/decisions/decision-types.js";
import {
  MAX_CALLBACK_DATA_BYTES,
  buildDecisionKeyboard,
  encodeDecisionCallbackData,
  parseDecisionCallbackData,
} from "../../src/decisions/telegram-keyboard.js";

const DECISION_ID = "01k4b3c8d9e0f1g2h3j4k5m6n7";
const LONGEST_OPTION_KEY = "a".repeat(32);
const encoder = new TextEncoder();

const escapes: readonly DecisionOption[] = [
  { optionKey: FREE_TEXT_OPTION_KEY, label: FREE_TEXT_OPTION_LABEL, ordinal: 8, kind: "free_text" },
  { optionKey: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 9, kind: "explain" },
];

function item(options: readonly DecisionOption[]): DecisionItem {
  return {
    decisionId: DECISION_ID,
    principalId: "principal:owner",
    origin: "dev-session",
    originReference: "session:42",
    urgency: "urgent",
    question: "Deploy the hotfix now?",
    detail: null,
    status: "open",
    rank: 10,
    expiresAt: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    deliveredAt: null,
    resolvedAt: null,
    options,
  };
}

describe("decision callback data", () => {
  it("round-trips a decision id and an option key", () => {
    const data = encodeDecisionCallbackData(DECISION_ID, "deploy");

    expect(data).toBe(`d1:${DECISION_ID}:deploy`);
    expect(parseDecisionCallbackData(data)).toEqual({ decisionId: DECISION_ID, optionKey: "deploy" });
  });

  it("stays inside Telegram's 64-byte limit at the longest key the schema allows", () => {
    // decision_options.option_key is capped at 32 characters and the key
    // alphabet is one byte per character, so this is the largest callback data
    // this scheme can ever produce: 3 + 26 + 1 + 32.
    const data = encodeDecisionCallbackData(DECISION_ID, LONGEST_OPTION_KEY);

    expect(encoder.encode(data).byteLength).toBe(62);
    expect(encoder.encode(data).byteLength).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    expect(parseDecisionCallbackData(data)).toEqual({ decisionId: DECISION_ID, optionKey: LONGEST_OPTION_KEY });
  });

  it("refuses to build callback data that would not fit", () => {
    expect(() => encodeDecisionCallbackData(`${DECISION_ID}${DECISION_ID}${DECISION_ID}`, "deploy"))
      .toThrow("decision_callback_data_invalid");
    expect(() => encodeDecisionCallbackData(DECISION_ID, `${LONGEST_OPTION_KEY}a`))
      .toThrow("decision_callback_data_invalid");
  });

  it.each([
    ["an empty string", ""],
    ["the scheme alone", "d1:"],
    ["a decision id with no option", `d1:${DECISION_ID}`],
    ["an option with no scheme", `${DECISION_ID}:deploy`],
    ["a third field", `d1:${DECISION_ID}:deploy:extra`],
    ["an empty option key", `d1:${DECISION_ID}:`],
    ["a separator inside the option key", `d1:${DECISION_ID}:de:ploy`],
    ["a space inside the option key", `d1:${DECISION_ID}:de ploy`],
    ["an uppercase option key", `d1:${DECISION_ID}:DEPLOY`],
    ["an uppercase decision id", `d1:${DECISION_ID.toUpperCase()}:deploy`],
    ["a decision id one character short", `d1:${DECISION_ID.slice(1)}:deploy`],
    ["a decision id one character long", `d1:${DECISION_ID}0:deploy`],
    ["a letter the ULID alphabet excludes", `d1:${DECISION_ID.slice(0, 25)}i:deploy`],
    ["another scheme version", `d2:${DECISION_ID}:deploy`],
    ["a trailing newline", `d1:${DECISION_ID}:deploy\n`],
    ["a leading space", ` d1:${DECISION_ID}:deploy`],
    ["an option key past the schema's cap", `d1:${DECISION_ID}:${LONGEST_OPTION_KEY}a`],
  ])("rejects %s rather than guessing at it", (_name, data) => {
    expect(parseDecisionCallbackData(data)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{ decisionId: DECISION_ID }], [[`d1:${DECISION_ID}:deploy`]]])(
    "rejects callback data that is not a string (%j)",
    (data) => {
      expect(parseDecisionCallbackData(data)).toBeNull();
    },
  );
});

describe("the decision keyboard", () => {
  it("gives every option its own row, in ordinal order, escapes last", () => {
    const keyboard = buildDecisionKeyboard(item([
      { optionKey: "wait", label: "Wait", ordinal: 1, kind: "choice" },
      { optionKey: "deploy", label: "Deploy", ordinal: 0, kind: "choice" },
      ...escapes,
    ]));

    expect(keyboard).toEqual({
      inline_keyboard: [
        [{ text: "Deploy", callback_data: `d1:${DECISION_ID}:deploy` }],
        [{ text: "Wait", callback_data: `d1:${DECISION_ID}:wait` }],
        [{ text: FREE_TEXT_OPTION_LABEL, callback_data: `d1:${DECISION_ID}:${FREE_TEXT_OPTION_KEY}` }],
        [{ text: EXPLAIN_OPTION_LABEL, callback_data: `d1:${DECISION_ID}:${EXPLAIN_OPTION_KEY}` }],
      ],
    });
  });

  it("keeps every button it builds inside the callback data limit", () => {
    const keyboard = buildDecisionKeyboard(item([
      { optionKey: LONGEST_OPTION_KEY, label: "The longest key the schema allows", ordinal: 0, kind: "choice" },
      ...escapes,
    ]));

    const sizes = keyboard.inline_keyboard.flat().map((button) => encoder.encode(button.callback_data).byteLength);
    expect(sizes).toHaveLength(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
  });

  it("routes a tap on any of its own buttons back to the option it was built from", () => {
    const options: readonly DecisionOption[] = [
      { optionKey: "deploy", label: "Deploy", ordinal: 0, kind: "choice" },
      ...escapes,
    ];

    const keyboard = buildDecisionKeyboard(item(options));

    expect(keyboard.inline_keyboard.flat().map((button) => parseDecisionCallbackData(button.callback_data)))
      .toEqual(options.map((option) => ({ decisionId: DECISION_ID, optionKey: option.optionKey })));
  });

  it.each([
    ["the free-text escape", [{ optionKey: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 1, kind: "explain" as const }]],
    ["the explain escape", [{ optionKey: FREE_TEXT_OPTION_KEY, label: FREE_TEXT_OPTION_LABEL, ordinal: 0, kind: "free_text" as const }]],
    ["both escapes", [{ optionKey: "deploy", label: "Deploy", ordinal: 0, kind: "choice" as const }]],
  ])("refuses to render a question that is missing %s", (_name, options) => {
    expect(() => buildDecisionKeyboard(item([
      { optionKey: "hold", label: "Hold", ordinal: 7, kind: "choice" },
      ...options,
    ]))).toThrow("decision_keyboard_missing_escape");
  });

  it("refuses an escape whose key is not the reserved one, since the tap would route nowhere", () => {
    expect(() => buildDecisionKeyboard(item([
      { optionKey: "type-it", label: FREE_TEXT_OPTION_LABEL, ordinal: 0, kind: "free_text" },
      { optionKey: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 1, kind: "explain" },
    ]))).toThrow("decision_keyboard_missing_escape");
  });
});
