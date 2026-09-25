import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
/**
 * The guard that keeps every dispatchable tool classified AND its capability
 * registered.
 *
 * The tier gate has always failed closed: an unclassified tool is passed to
 * `AutonomyService.evaluate` under its own name, no tier row matches, and the
 * outcome is `denied_unknown_capability`. That is the right behaviour, and it
 * is silent in exactly one direction -- the gate cannot tell "nobody has
 * thought about this tool" from "this tool must never run", so a tool that
 * arrives from main while a branch holds an older copy of
 * `OWNER_TOOL_CAPABILITIES` becomes a refusal in production with a green
 * suite.
 *
 * `memory_correct` is the case that happened. It is in
 * `OWNER_TOOL_DEFINITIONS` and in the dispatch chain in
 * `owner-telegram-agent.ts`, and it had no entry in the map, so correcting a
 * memory stopped working. The test below is the missing half: classification
 * is a property of the pair, so it is asserted over the pair rather than over
 * a list somebody has to remember to extend.
 *
 * Both sides are derived. A hand-written list of nine names here would be the
 * same defect one level up, and would go stale the first time a tenth tool is
 * defined -- which is the day it would be needed.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyAutonomyToolCapabilitiesMigration } from "../persistence/migration.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { capabilityForTool, isToolClassified } from "../../src/autonomy/tool-capabilities.js";


/** Every tool the model is offered, and therefore every tool it can dispatch. */
const DISPATCHABLE_TOOL_NAMES: readonly string[] = Object.freeze(
  OWNER_TOOL_DEFINITIONS.map((definition) => definition.name),
);

/**
 * Fails with the offending names, because `expect([]).toEqual([])` says only
 * that two lists differ -- not which tool was forgotten, which is the whole
 * content of the failure.
 */
function expectNothingMissing(kind: string, names: readonly string[]): void {
  if (names.length > 0) throw new Error(`${kind}:${JSON.stringify(names)}`);
}

describe("tool capability classification", () => {
  beforeAll(async () => {
    // The real migration the deployable gateway applies, so the rows read below
    // are the rows production reads. A fixture that declared its own
    // capabilities could not catch a capability that was never seeded.
    await applyAutonomyToolCapabilitiesMigration();
  });

  it("every tool the model can dispatch has a capability classification", () => {
    // Derived from the definitions rather than a literal, so this covers a
    // tool added tomorrow without anybody editing the test.
    const unclassified = DISPATCHABLE_TOOL_NAMES.filter((name) => !isToolClassified(name));

    expectNothingMissing("unclassified_dispatchable_tools", unclassified);
    // The property is the assertion above. This one keeps the derivation
    // honest: if the definitions list ever emptied, the filter would have
    // nothing to reject and the test would pass over no coverage at all.
    expect(DISPATCHABLE_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("every capability those tools are classified as is registered at a tier", async () => {
    // The second way a dispatch silently becomes a denial, and the reason
    // checking the map alone is not enough. A tool mapped to `memory.correct`
    // when the seeded capability is `memory.write` is still refused -- with
    // `classified` true, so the receipt blames the request rather than the
    // missing row.
    const repository = new AutonomyRepository(env.DB);
    const capabilities = [...new Set(DISPATCHABLE_TOOL_NAMES.map(capabilityForTool))];
    const tiers = await Promise.all(capabilities.map((name) => repository.readCapabilityTier(name)));
    const unregistered = capabilities.filter((_, index) => tiers[index] === null);

    expectNothingMissing("dispatchable_tools_with_unregistered_capability", unregistered);
    // `memory.write` is the one every memory tool shares, so the repository
    // was asked about something the migration seeds. Without this, an empty or
    // unmigrated table would make the assertion above vacuous in the passing
    // direction, which is the one direction a guard must not be vacuous in.
    expect(capabilities).toContain("memory.write");
  });
});
