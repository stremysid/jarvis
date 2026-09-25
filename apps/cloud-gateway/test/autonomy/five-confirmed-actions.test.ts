/**
 * Sid's five actions ask first, and nothing else does.
 *
 * Sid, 2026-09-24: "the only thing Jarvis has restrictions on anything like
 * spending money sending emails making a call submitting school work
 * texting/calling somone on my behalf, that stuff needs an extra 'hey just to
 * be sure ...' ... that's literaly it".
 *
 * Tier 3 is the one tier that asks (a Telegram tap, or the PIN on a call).
 * This file pins the tier-3 set against the database the deployable migrations
 * build, so it is the rows production reads that are checked, not a copy.
 * Both directions fail loudly: a sixth tier-3 row, or one of the five dropping
 * below tier 3, fails the first test by name.
 */

import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import type { AutonomyMode } from "../../src/autonomy/autonomy-types.js";
import { capabilityForTool } from "../../src/autonomy/tool-capabilities.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

/** One capability per action Sid named, in the order he named them. */
const SIDS_FIVE = Object.freeze([
  "spend.money", // spending money
  "send.email", // sending an email
  "place.call", // making a phone call
  "submit.school_work", // submitting school work
  "contact.third_party", // texting or calling someone on his behalf
]);

const NOW = new Date("2026-09-25T12:00:00.000Z");
const PRINCIPAL = "principal:five-confirmed-actions";

async function registry(): Promise<readonly { capability: string; tier: number }[]> {
  const { results } = await env.DB.prepare("SELECT capability, tier FROM capability_tiers ORDER BY capability")
    .all<{ capability: string; tier: number }>();
  return results;
}

function service(): AutonomyService {
  return new AutonomyService({ repository: new AutonomyRepository(env.DB), now: () => new Date(NOW) });
}

describe("the actions Jarvis confirms with Sid before doing", () => {
  let modeBefore: AutonomyMode;

  beforeAll(async () => {
    await applyNewestRuntimeMigration();
    modeBefore = (await new AutonomyRepository(env.DB).readMode()).mode;
  }, 120_000);

  afterAll(async () => {
    await new AutonomyRepository(env.DB).setMode(modeBefore, NOW.toISOString());
  });

  it("holds tier 3 for exactly Sid's five actions and for no other registered capability", async () => {
    const rows = await registry();
    const tierThree = rows.filter((row) => row.tier === 3).map((row) => row.capability).sort();

    expect(tierThree).toEqual([...SIDS_FIVE].sort());
    // Not vacuous: the registry the migrations seed has more than the five in
    // it, so the equality above excluded real rows rather than an empty table.
    expect(rows.length).toBeGreaterThan(SIDS_FIVE.length + 10);
  });

  it.each(["shadow", "live"] as const)(
    "asks before each of the five and before nothing else, in %s mode",
    async (mode) => {
      await new AutonomyRepository(env.DB).setMode(mode, NOW.toISOString());
      const asked: string[] = [];
      for (const { capability } of await registry()) {
        const evaluation = await service().evaluate({ capability, principalId: PRINCIPAL, summary: "five-actions check" });
        if (evaluation.outcome === "requires_confirmation") asked.push(capability);
        // Whatever did not ask is still audited, so an action that no longer
        // asks is still receipted.
        const audit = await env.DB.prepare("SELECT outcome FROM autonomy_evaluations WHERE evaluation_id = ?")
          .bind(evaluation.evaluationId).first<{ outcome: string }>();
        expect(audit?.outcome).toBe(evaluation.outcome);
      }
      expect(asked.sort()).toEqual([...SIDS_FIVE].sort());
    },
  );

  it("keeps the four capabilities that used to ask out of the confirming tier", async () => {
    const tiers = new Map((await registry()).map((row) => [row.capability, row.tier]));

    // The dispatchable one stays runnable whatever the /shadow switch says.
    expect(tiers.get("school.collector.revoke")).toBe(1);
    // No tool reaches these yet. Tier 2 never asks. It runs when /shadow is off.
    expect(tiers.get("delete.data")).toBe(2);
    expect(tiers.get("write.production")).toBe(2);
    expect(tiers.get("vehicle.unlock")).toBe(2);
  });

  it("asks before sending an email and before no tool the model can dispatch today", async () => {
    await new AutonomyRepository(env.DB).setMode("live", NOW.toISOString());
    const gate = new ToolAutonomyGate(service());
    const verdict = async (toolName: string) =>
      (await gate.evaluateToolCall({ toolName, principalId: PRINCIPAL, arguments: "{}" })).verdict;

    // The reserved email tool is the one tool name already mapped into the five.
    // Its own row, not contact.third_party: an email asks whoever it is to,
    // and a merge that restored the older mapping must fail here.
    expect(capabilityForTool("send_email")).toBe("send.email");
    expect(await verdict("send_email")).toBe("confirm");
    expect(await verdict("tesla_unlock")).toBe("permit");
    expect(await verdict("tesla_precondition")).toBe("permit");

    const asking: string[] = [];
    for (const { name } of OWNER_TOOL_DEFINITIONS) {
      if (await verdict(name) === "confirm") asking.push(name);
    }
    expect(asking).toEqual([]);
    // Derived from the definitions, so a tool added tomorrow is covered, and
    // the revoke is named so an emptied list cannot pass this vacuously.
    expect(OWNER_TOOL_DEFINITIONS.map(({ name }) => name)).toContain("school_collector_revoke");
  });
});
