import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import {
  argumentsFingerprint, confirmationReference, CONFIRMATION_TTL_MS,
  D1ToolConfirmationStore, TIER3_TOOL_ORIGIN,
} from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import type { AutonomyServiceContract } from "../../src/autonomy/autonomy-types.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

const TAP_AT = new Date("2026-09-23T12:00:00.000Z");
const CAPABILITY = "send.email";
let serial = 0;

async function harness() {
  const principalId = `principal:tap-${++serial}`;
  const identityId = `identity:tap-${serial}`;
  let clock = new Date(TAP_AT);
  const now = () => new Date(clock);
  await env.DB.prepare(`INSERT INTO principals
    (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?, 'human', 'active', 'Tap fixture', ?, ?)`)
    .bind(principalId, TAP_AT.toISOString(), TAP_AT.toISOString()).run();
  await env.DB.prepare(`INSERT INTO channel_identities
    (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
    VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`)
    .bind(identityId, principalId, `synthetic-tap-${serial}`, TAP_AT.toISOString(), TAP_AT.toISOString()).run();
  const service = new AutonomyService({ repository: new AutonomyRepository(env.DB), now });
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now });
  const request = { toolName: "send_email", principalId, arguments: JSON.stringify({ draft: serial }) };
  const gate = (authority: AutonomyServiceContract = service) => new ToolAutonomyGate(
    authority, new D1ToolConfirmationStore(env.DB, now),
  );
  async function raise(reference: string): Promise<string> {
    const item = await decisions.raise({
      rank: 100,
      principalId, origin: TIER3_TOOL_ORIGIN,
      originReference: reference,
      urgency: "normal", question: "Run this synthetic action?",
      choices: [{ key: "confirm", label: "Confirm" }, { key: "cancel", label: "Cancel" }],
    });
    await decisions.markDelivered(item.decisionId);
    return item.decisionId;
  }
  async function answer(decisionId: string, optionKey = "confirm"): Promise<void> {
    expect((await decisions.answer({ decisionId, answeredByIdentityId: identityId, optionKey })).outcome)
      .toBe("recorded");
  }
  async function tap(optionKey = "confirm", capability = CAPABILITY): Promise<string> {
    const id = await raise(confirmationReference(request.toolName, capability, await argumentsFingerprint(request.arguments)));
    await answer(id, optionKey);
    return id;
  }
  return { gate, service, tap, raise, answer, request, now, advance: (ms: number) => { clock = new Date(TAP_AT.getTime() + ms); } };
}

async function consumption(decisionId: string) {
  return env.DB.prepare("SELECT consumed_at FROM tool_confirmation_consumptions WHERE decision_id = ?")
    .bind(decisionId).first<{ consumed_at: string }>();
}

describe("single-use tier-3 taps", () => {
  beforeAll(applyNewestRuntimeMigration, 120_000);

  it("describes tap expiry using the configured confirmation lifetime", async () => {
    const h = await harness();
    const result = await h.gate().evaluateToolCall(h.request);
    expect(result.receipt).toContain(`valid once for ${CONFIRMATION_TTL_MS / 60_000} minutes`);
  });

  it("authorizes exactly one execution and explains why a second attempt needs a new tap", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    let executions = 0;
    const execute = async () => {
      const result = await h.gate().evaluateToolCall(h.request);
      if (result.verdict === "permit") executions++;
      return result;
    };
    expect(await execute()).toMatchObject({ verdict: "permit", confirmedBy: decisionId });
    const repeated = await execute();
    expect(repeated).toMatchObject({ verdict: "confirm", confirmedBy: null });
    expect(repeated.receipt).toContain("already used or expired");
    expect(executions).toBe(1);
    expect(await consumption(decisionId)).toEqual({ consumed_at: TAP_AT.toISOString() });
  });

  it.each([
    { tier: 1, outcome: "permitted" },
    { tier: 2, outcome: "withheld_shadow" },
    { tier: null, outcome: "denied_unknown_capability" },
  ] as const)("denies a confirmed call when a registry change makes the second outcome $outcome", async ({ tier, outcome }) => {
    const h = await harness();
    const decisionId = await h.tap();
    const readRegistryRow = () => env.DB.prepare(
      "SELECT tier, description, updated_at FROM capability_tiers WHERE capability = ?",
    ).bind(CAPABILITY).first<{ tier: number; description: string; updated_at: string }>();
    const original = await readRegistryRow();
    if (original === null) throw new Error("fixture_missing_capability_row");
    expect(original.tier).toBe(3);
    const changing: AutonomyServiceContract = { evaluate: async (input) => {
      const evaluated = await h.service.evaluate(input);
      if (input.decisionId === null) {
        expect(evaluated).toMatchObject({ tier: 3, outcome: "requires_confirmation" });
        // Both evaluations use the real repository. The mutation occurs after
        // the first read and audit, before the confirmation and second read.
        if (tier === null) {
          await env.DB.prepare("DELETE FROM capability_tiers WHERE capability = ?").bind(CAPABILITY).run();
        } else {
          await env.DB.prepare("UPDATE capability_tiers SET tier = ? WHERE capability = ?").bind(tier, CAPABILITY).run();
        }
      }
      return evaluated;
    } };
    try {
      const result = await h.gate(changing).evaluateToolCall(h.request);
      expect(result).toMatchObject({ verdict: "deny", confirmedBy: null, evaluation: { tier, outcome, decisionId: null } });
      expect(result.receipt).toContain(`safety outcome changed from requires_confirmation to ${outcome}`);
      expect(result.receipt).toContain("Nothing happened");
      expect(result.receipt).toContain("tap was spent");
      expect(result.receipt).not.toContain("Allowed");
      expect(result.receipt).toContain(`autonomy ${result.evaluation.evaluationId}`);
      expect(result.receipt).toContain(`capability=${CAPABILITY}`);
      expect(result.receipt).toContain(tier === null ? "unclassified" : `tier ${tier}`);
      expect(result.receipt).toContain(`outcome=${outcome}`);
      const audits = await env.DB.prepare(`SELECT outcome, decision_id FROM autonomy_evaluations
        WHERE principal_id = ? ORDER BY evaluated_at, rowid`).bind(h.request.principalId).all();
      expect(audits.results).toEqual([
        { outcome: "requires_confirmation", decision_id: null },
        { outcome, decision_id: null },
      ]);
      expect(await consumption(decisionId)).toEqual({ consumed_at: TAP_AT.toISOString() });
    } finally {
      // D1 state survives between tests in this file. Restore even when an
      // assertion fails, including when this case deleted the registry row.
      await env.DB.prepare(`INSERT INTO capability_tiers (capability, tier, description, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(capability) DO UPDATE SET
        tier = excluded.tier, description = excluded.description, updated_at = excluded.updated_at`)
        .bind(CAPABILITY, original.tier, original.description, original.updated_at).run();
    }
    expect(await readRegistryRow()).toEqual(original);
  });

  it.each(["pending", "answered"] as const)("requires a fresh tap for a legacy confirmation that was %s at deployment", async (state) => {
    const h = await harness();
    const hash = await argumentsFingerprint(h.request.arguments);
    // Written in the pre-change format, without calling the new encoder.
    const legacyReference = `${CAPABILITY}:${hash}`;
    expect(confirmationReference(h.request.toolName, CAPABILITY, hash)).not.toBe(legacyReference);
    const oldDecision = await h.raise(legacyReference);
    if (state === "answered") await h.answer(oldDecision);
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
    if (state === "pending") await h.answer(oldDecision);
    expect(await h.gate().evaluateToolCall(h.request)).toMatchObject({ verdict: "confirm", confirmedBy: null });
    expect(await consumption(oldDecision)).toBeNull();

    const freshDecision = await h.tap();
    expect(await h.gate().evaluateToolCall(h.request)).toMatchObject({ verdict: "permit", confirmedBy: freshDecision });
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
    expect(await consumption(freshDecision)).toEqual({ consumed_at: TAP_AT.toISOString() });
    expect(await consumption(oldDecision)).toBeNull();
  });

  it.each([CONFIRMATION_TTL_MS, CONFIRMATION_TTL_MS + 1])(
    "refuses an expired tap at age %i milliseconds without consuming it", async (age) => {
      const h = await harness();
      const decisionId = await h.tap();
      h.advance(age);
      const result = await h.gate().evaluateToolCall(h.request);
      expect(result.verdict).toBe("confirm");
      expect(result.receipt).toContain("expired");
      expect(await consumption(decisionId)).toBeNull();
    },
  );

  it("allows a tap one millisecond before expiry and records the claim time", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    h.advance(CONFIRMATION_TTL_MS - 1);
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("permit");
    expect(await consumption(decisionId)).toEqual({ consumed_at: h.now().toISOString() });
  });

  it("refuses a tap timestamped after the claim clock", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    h.advance(-1);
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
    expect(await consumption(decisionId)).toBeNull();
  });

  it("checks expiry at consumption after a delayed audit rather than using its earlier timestamp", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    const delayed: AutonomyServiceContract = { evaluate: async (input) => {
      const evaluated = await h.service.evaluate(input);
      h.advance(CONFIRMATION_TTL_MS);
      return evaluated;
    } };
    expect((await h.gate(delayed).evaluateToolCall(h.request)).verdict).toBe("confirm");
    expect(await consumption(decisionId)).toBeNull();
  });

  it("allows exactly one of two concurrent executions racing for the same tap", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const together: AutonomyServiceContract = { evaluate: async (input) => {
      const result = await h.service.evaluate(input);
      if (input.decisionId === null) {
        if (++arrivals === 2) release();
        await ready;
      }
      return result;
    } };
    let executions = 0;
    const execute = async () => {
      const result = await h.gate(together).evaluateToolCall(h.request);
      if (result.verdict === "permit") executions++;
      return result;
    };
    const results = await Promise.all([execute(), execute()]);
    expect(results.map((result) => result.verdict).sort()).toEqual(["confirm", "permit"]);
    expect(executions).toBe(1);
    expect(results.find((result) => result.verdict === "permit")?.confirmedBy).toBe(decisionId);
    const claims = await env.DB.prepare("SELECT count(*) AS count FROM tool_confirmation_consumptions WHERE decision_id = ?")
      .bind(decisionId).first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it("lets a Telegram tap authorize the same action through the voice gate once", async () => {
    const h = await harness();
    const telegramGate = h.gate();
    expect((await telegramGate.evaluateToolCall(h.request)).verdict).toBe("confirm");
    const decisionId = await h.tap();
    // Production voice constructs another gate over the same D1 store. Neither
    // gate accepts a session or channel key, so the Telegram identity is enough.
    const voiceGate = h.gate();
    expect(await voiceGate.evaluateToolCall(h.request)).toMatchObject({ verdict: "permit", confirmedBy: decisionId });
    expect((await telegramGate.evaluateToolCall(h.request)).verdict).toBe("confirm");
    expect((await voiceGate.evaluateToolCall(h.request)).verdict).toBe("confirm");
  });

  it("requires a new tap after a claimed action fails to record its second audit", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    const failing: AutonomyServiceContract = { evaluate: async (input) => {
      if (input.decisionId !== null) throw new Error("synthetic_second_audit_failure");
      return h.service.evaluate(input);
    } };
    await expect(h.gate(failing).evaluateToolCall(h.request)).rejects.toThrow("synthetic_second_audit_failure");
    expect(await consumption(decisionId)).not.toBeNull();
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
  });

  it("allows the owner to authorize the same action again with a new tap", async () => {
    const h = await harness();
    await h.tap();
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("permit");
    h.advance(1);
    const fresh = await h.tap();
    expect(await h.gate().evaluateToolCall(h.request)).toMatchObject({ verdict: "permit", confirmedBy: fresh });
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
  });

  it("does not fall back to an older approval after the newest matching tap is spent", async () => {
    const h = await harness();
    const older = await h.tap();
    h.advance(1);
    const newer = await h.tap();
    expect((await h.gate().evaluateToolCall(h.request)).confirmedBy).toBe(newer);
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
    expect(await consumption(older)).toBeNull();
  });

  it("does not consume a refusal or a tap for another capability or principal", async () => {
    const h = await harness();
    const refusal = await h.tap("cancel");
    const otherCapability = await h.tap("confirm", "contact.third_party");
    expect((await h.gate().evaluateToolCall(h.request)).verdict).toBe("confirm");
    const other = await harness();
    await h.tap();
    expect((await other.gate().evaluateToolCall({ ...h.request, principalId: other.request.principalId })).verdict).toBe("confirm");
    expect(await consumption(refusal)).toBeNull();
    expect(await consumption(otherCapability)).toBeNull();
  });

  it("refuses to erase or rewrite a consumed mark", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    await h.gate().evaluateToolCall(h.request);
    await expect(env.DB.prepare("DELETE FROM tool_confirmation_consumptions WHERE decision_id = ?")
      .bind(decisionId).run()).rejects.toThrow("tool_confirmation_consumption_delete_forbidden");
    await expect(env.DB.prepare("UPDATE tool_confirmation_consumptions SET consumed_at = ? WHERE decision_id = ?")
      .bind(new Date(TAP_AT.getTime() + 1).toISOString(), decisionId).run())
      .rejects.toThrow("tool_confirmation_consumption_update_forbidden");
  });

  it("requires a real response and a canonical nonnull consumption timestamp", async () => {
    const h = await harness();
    const decisionId = await h.tap();
    const insert = (id: string | null, time: string | null) => env.DB.prepare(
      "INSERT INTO tool_confirmation_consumptions (decision_id, consumed_at) VALUES (?, ?)",
    ).bind(id, time).run();
    await expect(insert("missing-decision", TAP_AT.toISOString())).rejects.toThrow();
    await expect(insert(null, TAP_AT.toISOString())).rejects.toThrow();
    await expect(insert(decisionId, null)).rejects.toThrow();
    await expect(insert(decisionId, "invalid-time")).rejects.toThrow();
    await expect(insert(decisionId, "2026-09-23T12:00:00Z")).rejects.toThrow();
    expect(await consumption(decisionId)).toBeNull();
  });
});
