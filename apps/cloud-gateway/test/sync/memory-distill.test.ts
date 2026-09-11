import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter, ModelToken } from "../../src/model/model-types.js";
import {
  distil,
  validateExcerpts,
  validateProposal,
} from "../../src/sync/memory-distill.js";

/**
 * The model's output is a claim, not a result.
 *
 * A distilled fact is something Jarvis will later state as true and cite
 * evidence for, so a proposal that cannot be checked against the excerpts we
 * actually submitted is dropped rather than repaired.
 */

function modelReturning(text: string): ModelAdapter {
  return {
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ModelToken> {
      yield { index: 0, text };
    },
  };
}

const EXCERPTS = [
  { sourceEventId: "event-1", text: "I like coffee" },
  { sourceEventId: "event-2", text: "I work on Tuesdays" },
];

function deps(model: ModelAdapter) {
  return { model, principalId: "principal-a" };
}

const supplied = new Set(["event-1", "event-2"]);

describe("excerpt validation, before any model call", () => {
  it("accepts well-formed excerpts", () => {
    expect(validateExcerpts(EXCERPTS)).toHaveLength(2);
  });

  it.each([
    ["not an array", {}],
    ["empty", []],
    ["missing text", [{ sourceEventId: "event-1" }]],
    ["blank text", [{ sourceEventId: "event-1", text: "   " }]],
    ["missing id", [{ text: "hello" }]],
    ["non-string id", [{ sourceEventId: 1, text: "hello" }]],
  ])("rejects %s", (_name, value) => {
    expect(validateExcerpts(value)).toBeNull();
  });

  it("rejects more excerpts than the bound allows", () => {
    const many = Array.from({ length: 33 }, (_, index) => ({
      sourceEventId: `event-${index}`,
      text: "x",
    }));
    expect(validateExcerpts(many)).toBeNull();
  });
});

describe("proposal validation", () => {
  it.each(["é".repeat(2049), `Order ${"6".repeat(6)}`])("rejects unprojectable model text", (text) => {
    expect(validateProposal({ text, sourceEventIds: ["event-1"] }, supplied)).toBeNull();
  });

  it("accepts the byte and source limits and rejects a ninth source", () => {
    const sources = Array.from({ length: 9 }, (_, index) => `event-${index}`);
    const allowed = new Set(sources);
    expect(validateProposal({ text: "é".repeat(2048), sourceEventIds: sources.slice(0, 8) }, allowed))
      .toEqual({ text: "é".repeat(2048), sourceEventIds: sources.slice(0, 8), confidence: 1 });
    expect(validateProposal({ text: "Too many sources", sourceEventIds: sources }, allowed)).toBeNull();
  });

  it("accepts a proposal citing submitted sources", () => {
    expect(
      validateProposal({ text: "Likes coffee", sourceEventIds: ["event-1"], confidence: 0.9 }, supplied),
    ).toEqual({ text: "Likes coffee", sourceEventIds: ["event-1"], confidence: 0.9 });
  });

  it("rejects a proposal citing a source we never submitted", () => {
    // Either invented, or an attempt to attach a claim to evidence we did not
    // provide. Provenance is the basis on which the fact is later trusted.
    expect(
      validateProposal({ text: "Likes tea", sourceEventIds: ["event-999"] }, supplied),
    ).toBeNull();
  });

  it("rejects a proposal with no sources", () => {
    expect(validateProposal({ text: "Likes tea", sourceEventIds: [] }, supplied)).toBeNull();
  });

  it.each(["tool", "tool_call", "function", "function_call", "action", "command", "state"])(
    "refuses a proposal carrying %s",
    (key) => {
      // The model tried to act, or to declare its own state, rather than
      // observe. Either is out of bounds for distillation.
      expect(
        validateProposal(
          { text: "Likes coffee", sourceEventIds: ["event-1"], [key]: "anything" },
          supplied,
        ),
      ).toBeNull();
    },
  );

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "high", null])(
    "rejects confidence %s",
    (confidence) => {
      expect(
        validateProposal({ text: "x", sourceEventIds: ["event-1"], confidence }, supplied),
      ).toBeNull();
    },
  );

  it("defaults a missing confidence rather than rejecting", () => {
    expect(
      validateProposal({ text: "x", sourceEventIds: ["event-1"] }, supplied)?.confidence,
    ).toBe(1);
  });
});

describe("distillation", () => {
  it("returns the proposals a well-behaved model produces", async () => {
    const model = modelReturning(
      JSON.stringify([{ text: "Likes coffee", sourceEventIds: ["event-1"], confidence: 0.8 }]),
    );
    const result = await distil(EXCERPTS, deps(model), new AbortController().signal);
    expect(result).toEqual([{ text: "Likes coffee", sourceEventIds: ["event-1"], confidence: 0.8 }]);
  });

  it("extracts the array even when the model wraps it in prose", async () => {
    const model = modelReturning(
      'Here you go:\n[{"text":"Likes coffee","sourceEventIds":["event-1"]}]\nHope that helps.',
    );
    const result = await distil(EXCERPTS, deps(model), new AbortController().signal);
    expect(result).toHaveLength(1);
  });

  it("returns nothing rather than throwing on unparseable output", async () => {
    const result = await distil(EXCERPTS, deps(modelReturning("I cannot help with that.")), new AbortController().signal);
    expect(result).toEqual([]);
  });

  it("drops only the invalid elements of a mixed response", async () => {
    // The valid ones were independently derived and are independently
    // checkable, so one bad element does not discard them.
    const model = modelReturning(
      JSON.stringify([
        { text: "Likes coffee", sourceEventIds: ["event-1"] },
        { text: "Invented", sourceEventIds: ["event-999"] },
        { text: "Works Tuesdays", sourceEventIds: ["event-2"] },
      ]),
    );
    const result = await distil(EXCERPTS, deps(model), new AbortController().signal);
    expect(result.map((item) => item.text)).toEqual(["Likes coffee", "Works Tuesdays"]);
  });

  it("passes every excerpt id to the model and no retrieved memory", async () => {
    // Empty context is deliberate: giving distillation existing facts would
    // let them reinforce themselves into new ones with no new evidence.
    const stream = vi.fn(async function* (..._args: Parameters<ModelAdapter["stream"]>): AsyncIterable<ModelToken> {
      yield { index: 0, text: "[]" };
    });
    await distil(EXCERPTS, deps({ stream } as unknown as ModelAdapter), new AbortController().signal);

    const input = stream.mock.calls[0]![0];
    expect(input.userText).toContain("event-1");
    expect(input.userText).toContain("event-2");
    expect(input.context).toEqual([]);
    // Background work, so it can afford the better answer.
    expect(input.reasoningEffort).toBe("high");
  });
});
