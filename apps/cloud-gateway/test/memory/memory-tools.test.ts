import { describe, expect, it } from "vitest";
import {
  MEMORY_TOOL_DEFINITIONS,
  MEMORY_TOOL_NAMES,
} from "../../src/memory/memory-tools.js";

/**
 * The declared schema is what the model trims against.
 *
 * A property that is listed but not required is one a token-saving model will
 * drop, and the dispatch layer then refuses the call for the missing grounding
 * excerpt -- a needless round trip, not a safety win. These assertions keep the
 * declared-required set in step with what each tool actually needs.
 */
describe("memory tool schemas", () => {
  const byName = new Map(MEMORY_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

  it("defines every advertised memory tool exactly once", () => {
    // `history_search` is defined here too but is not part of the mutation-tool
    // name list, so this checks coverage and uniqueness rather than equality.
    expect(new Set(MEMORY_TOOL_DEFINITIONS.map((definition) => definition.name)).size)
      .toBe(MEMORY_TOOL_DEFINITIONS.length);
    for (const name of MEMORY_TOOL_NAMES) expect(byName.has(name)).toBe(true);
  });

  it("requires supportingExcerpt on every tool that declares the property", () => {
    // `basis` replaced nothing: a tool with both must require both. This is the
    // regression `memory_restore` introduced when `basis` was added to its
    // required array in place of `supportingExcerpt`.
    for (const definition of MEMORY_TOOL_DEFINITIONS) {
      const properties = definition.parameters.properties as Record<string, unknown>;
      if (!Object.hasOwn(properties, "supportingExcerpt")) continue;
      expect(definition.parameters.required).toContain("supportingExcerpt");
    }
  });

  it("requires memory_restore's basis and its grounding excerpt together", () => {
    const definition = byName.get("memory_restore");
    if (definition === undefined) throw new Error("memory_restore_definition_missing");
    expect(definition.parameters.required).toEqual(["itemId", "basis", "supportingExcerpt"]);
  });

  it("requires the grounding excerpt on the sibling mutation tools", () => {
    for (const name of ["memory_remember", "memory_correct", "memory_confirm", "memory_explain"] as const) {
      const definition = byName.get(name);
      if (definition === undefined) throw new Error(`memory_tool_definition_missing:${name}`);
      expect(definition.parameters.required).toContain("supportingExcerpt");
    }
    const forget = byName.get("memory_forget");
    if (forget === undefined) throw new Error("memory_forget_definition_missing");
    expect(forget.parameters.required).toContain("supportingExcerpt");
  });

  it("requires the lifetime pair on the tools that decide how long a fact lasts", () => {
    // Row 7: an omission must be refused rather than defaulted, and the schema
    // is the first place a model learns that it has to state the pair.
    for (const name of ["memory_remember", "memory_correct"] as const) {
      const definition = byName.get(name);
      if (definition === undefined) throw new Error(`memory_tool_definition_missing:${name}`);
      expect(definition.parameters.required).toContain("lifetime");
      expect(definition.parameters.required).toContain("expiresAt");
    }
  });

  it("requires the model's basis and filing confidence on every writing tool", () => {
    // The model decides what the evidence counts as and how sure it is of the
    // filing. Code refuses an omission rather than choosing either one, and the
    // schema is where the model learns that.
    for (const name of ["memory_remember", "memory_correct"] as const) {
      const definition = byName.get(name);
      if (definition === undefined) throw new Error(`memory_tool_definition_missing:${name}`);
      expect(definition.parameters.required).toContain("basis");
      expect(definition.parameters.required).toContain("filingConfidence");
      const properties = definition.parameters.properties as Record<string, { enum?: readonly string[] }>;
      expect(properties.basis?.enum).toEqual([
        "stated", "confirmed", "observed", "inferred", "third_party",
      ]);
    }
  });

  it("no longer advertises the removed evidence-class fields", () => {
    for (const name of ["memory_remember", "memory_correct"] as const) {
      const definition = byName.get(name);
      if (definition === undefined) throw new Error(`memory_tool_definition_missing:${name}`);
      const properties = definition.parameters.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty("evidenceClass");
      expect(properties).not.toHaveProperty("previousOfferExcerpt");
    }
  });
});
