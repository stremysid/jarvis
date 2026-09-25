import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AutonomyRepository,
} from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { capabilityForTool } from "../../src/autonomy/tool-capabilities.js";
import {
  argumentsFingerprint,
  confirmationReference,
  D1ToolConfirmationStore,
  TIER3_CONFIRM_OPTION,
  TIER3_TOOL_ORIGIN,
} from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate, toolSummary } from "../../src/autonomy/tool-gate.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import {
  applyAutonomyToolCapabilitiesMigration,
  applyFoundationMigration,
} from "../persistence/migration.js";

const OBSERVED_AT = "2026-09-18T12:00:00.000Z";
const now = () => new Date(OBSERVED_AT);
const PRINCIPAL_ID = "principal:tier-gate";
const IDENTITY_ID = "identity:tier-gate";

function gate(): ToolAutonomyGate {
  const repository = new AutonomyRepository(env.DB);
  return new ToolAutonomyGate(
    new AutonomyService({ repository, now }),
    new D1ToolConfirmationStore(env.DB, now),
  );
}

/** A tier-3 capability the reserved tool mapping already points at. */
const TIER3_TOOL = "send_email";
const TIER3_CAPABILITY = "contact.third_party";
/** The reversible vehicle action 0008 seeds as tier 2. */
const TIER2_TOOL = "tesla_precondition";

async function auditRowsFor(capability: string): Promise<readonly Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    `SELECT capability, tier, outcome, decision_id, summary
     FROM autonomy_evaluations WHERE capability = ? ORDER BY evaluated_at ASC, rowid ASC`,
  ).bind(capability).all<Record<string, unknown>>();
  return results;
}

/**
 * Records the owner's tap the way the Telegram path does: a decision raised
 * under this subsystem's origin, then answered with the confirm option.
 */
async function ownerConfirms(
  toolName: string,
  capability: string,
  serializedArguments: string,
): Promise<string> {
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now });
  const hash = await argumentsFingerprint(serializedArguments);
  const raised = await decisions.raise({
    principalId: PRINCIPAL_ID,
    origin: TIER3_TOOL_ORIGIN,
    originReference: confirmationReference(toolName, capability, hash),
    urgency: "normal",
    question: "Run it?",
    choices: Object.freeze([{ key: TIER3_CONFIRM_OPTION, label: "Confirm" }]),
  });
  // Delivered before answered, exactly as the Telegram path does it: the
  // queue refuses an answer to a question the owner was never shown.
  await decisions.markDelivered(raised.decisionId);
  const answered = await decisions.answer({
    decisionId: raised.decisionId,
    answeredByIdentityId: IDENTITY_ID,
    optionKey: TIER3_CONFIRM_OPTION,
  });
  // The queue resolves the answering channel identity back to a principal and
  // refuses an answer from somebody else, so the fixture needs the identity row
  // as well as the principal one.
  if (answered.outcome !== "recorded") {
    throw new Error(`tier_gate_test_answer_failed:${answered.outcome}`);
  }
  return raised.decisionId;
}

describe("the tool capability gate", () => {
  beforeAll(async () => {
    await applyFoundationMigration();
    await applyAutonomyToolCapabilitiesMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM autonomy_evaluations"),
      env.DB.prepare("DELETE FROM decision_responses"),
      env.DB.prepare("DELETE FROM decision_options"),
      env.DB.prepare("DELETE FROM decision_items"),
      env.DB.prepare("DELETE FROM principals WHERE principal_id = ?1").bind(PRINCIPAL_ID),
    ]);
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Tier gate owner', ?2, ?2)`).bind(PRINCIPAL_ID, OBSERVED_AT).run();
    // The decision queue resolves an answer from the channel identity, and
    // refuses one that belongs to a different principal.
    await env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?1, ?2, 'telegram', '424242', 'active', ?3, ?3)`)
      .bind(IDENTITY_ID, PRINCIPAL_ID, OBSERVED_AT).run();
  });

  it("permits a tier-1 tool without asking for a confirmation", async () => {
    // The regression this guards is a gate that breaks ordinary use. Every
    // memory, school, university and study call is tier 1 and must sail
    // through, or the safety change has disabled the product.
    const decision = await gate().evaluateToolCall({
      toolName: "memory_explain",
      principalId: PRINCIPAL_ID,
      arguments: "{}",
    });

    expect(decision.verdict).toBe("permit");
    expect(decision.confirmedBy).toBeNull();
    expect(decision.evaluation.tier).toBe(1);
    expect(decision.evaluation.outcome).toBe("permitted");
    // The receipt names the evaluation, so an allowed action is as traceable as
    // a refused one.
    expect(decision.receipt).toContain("capability=memory.read");
    expect(decision.receipt).toContain("tier 1");
    expect(decision.receipt).toContain(`autonomy ${decision.evaluation.evaluationId}`);
  });

  it("refuses a tier-3 tool call that has no confirmation and says so in the receipt", async () => {
    const decision = await gate().evaluateToolCall({
      toolName: TIER3_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: JSON.stringify({ to: "supplier@example.com" }),
    });

    expect(decision.verdict).toBe("confirm");
    expect(decision.confirmedBy).toBeNull();
    expect(decision.evaluation.tier).toBe(3);
    expect(decision.evaluation.outcome).toBe("requires_confirmation");
    expect(decision.receipt).toContain(TIER3_CAPABILITY);
    expect(decision.receipt).toContain("tier 3");
    expect(decision.receipt).toContain("outcome=requires_confirmation");
    expect(decision.receipt).toContain("needs your tap");

    // Recorded, not merely returned: the refusal has a row an incident review
    // can read, and it is the row the receipt names.
    const rows = await auditRowsFor(TIER3_CAPABILITY);
    expect(rows.some((row) => row.outcome === "requires_confirmation"
      && row.capability === TIER3_CAPABILITY)).toBe(true);
    expect(rows.every((row) => row.summary === toolSummary(TIER3_TOOL))).toBe(true);
  });

  it("denies a tool nobody classified instead of guessing a tier for it", async () => {
    // Fail closed means the unclassified case is stricter than tier 3, not
    // weaker: it is denied outright rather than offered a confirmation, because
    // nobody has decided what it is allowed to do.
    const decision = await gate().evaluateToolCall({
      toolName: "capability_nobody_registered",
      principalId: PRINCIPAL_ID,
      arguments: "{}",
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.evaluation.tier).toBeNull();
    expect(decision.evaluation.outcome).toBe("denied_unknown_capability");
    expect(decision.receipt).toContain("no tier classification");

    // The audit row still records tier 3, which UNCLASSIFIED_AUDIT_TIER
    // documents as the honest value: the request WAS treated as the most
    // restrictive tier. The outcome is the field that says nobody classified it.
    const rows = await auditRowsFor("capability_nobody_registered");
    expect(rows.some((row) => row.tier === 3
      && row.outcome === "denied_unknown_capability")).toBe(true);
  });

  it("proceeds with the same tier-3 call after the owner confirms it", async () => {
    const serializedArguments = JSON.stringify({ to: "supplier@example.com", body: "confirmed order" });
    const decisionId = await ownerConfirms(TIER3_TOOL, TIER3_CAPABILITY, serializedArguments);

    const decision = await gate().evaluateToolCall({
      toolName: TIER3_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: serializedArguments,
    });

    expect(decision.verdict).toBe("permit");
    expect(decision.confirmedBy).toBe(decisionId);
    // The policy still requires a confirmation; what changed is that one
    // stands. The receipt names the decision so the permit is attributable.
    expect(decision.evaluation.outcome).toBe("requires_confirmation");
    expect(decision.receipt).toContain("confirmed by you");
    expect(decision.receipt).toContain(decisionId);
  });

  it("does not share a confirmation between two tools with the same capability and identical arguments", async () => {
    const toolName = "memory_pin";
    const otherToolName = "memory_unpin";
    const capability = capabilityForTool(toolName);
    expect(capabilityForTool(otherToolName)).toBe(capability);
    const repository = new AutonomyRepository(env.DB);
    const originalTier = await repository.readCapabilityTier(capability);
    expect(originalTier).toBe(1);
    try {
      // Temporarily promote the real shared mapping so this case asks for a tap.
      await env.DB.prepare("UPDATE capability_tiers SET tier = 3 WHERE capability = ?")
        .bind(capability).run();
      const args = JSON.stringify({ itemId: "synthetic-memory-item" });
      const hash = await argumentsFingerprint(args);
      expect(confirmationReference(toolName, capability, hash))
        .not.toBe(confirmationReference(otherToolName, capability, hash));
      const decisionId = await ownerConfirms(toolName, capability, args);
      const request = { toolName, principalId: PRINCIPAL_ID, arguments: args };

      expect(await gate().evaluateToolCall({ ...request, toolName: otherToolName }))
        .toMatchObject({ verdict: "confirm", confirmedBy: null });
      expect(await env.DB.prepare("SELECT decision_id FROM tool_confirmation_consumptions WHERE decision_id = ?")
        .bind(decisionId).first()).toBeNull();
      expect(await gate().evaluateToolCall(request)).toMatchObject({ verdict: "permit", confirmedBy: decisionId });
      expect(await gate().evaluateToolCall(request)).toMatchObject({ verdict: "confirm", confirmedBy: null });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM tool_confirmation_consumptions WHERE decision_id = ?")
        .bind(decisionId).first()).toEqual({ count: 1 });
    } finally {
      // The tier is shared by later tests as well as by these two tools.
      await env.DB.prepare("UPDATE capability_tiers SET tier = ? WHERE capability = ?")
        .bind(originalTier, capability).run();
    }
    expect(await repository.readCapabilityTier(capability)).toBe(originalTier);
  });

  it("does not let a confirmation authorize changed arguments for the same tool", async () => {
    await ownerConfirms(TIER3_TOOL, TIER3_CAPABILITY, JSON.stringify({ draft: "synthetic-approved" }));
    const decision = await gate().evaluateToolCall({
      toolName: TIER3_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: JSON.stringify({ draft: "synthetic-changed" }),
    });

    expect(decision.verdict).toBe("confirm");
    expect(decision.confirmedBy).toBeNull();
  });

  it("keeps tool and capability boundaries distinct when a name contains a delimiter", async () => {
    const hash = await argumentsFingerprint("{}");
    expect(confirmationReference("synthetic:tool", "capability", hash))
      .not.toBe(confirmationReference("synthetic", "tool:capability", hash));
  });

  it("refuses a tier-3 call even when no confirmation store is configured", async () => {
    // A gate built without the confirmation lookup -- a test seam, or a future
    // channel that has not wired one yet -- must still refuse tier 3 rather
    // than permit it for want of somewhere to look. This is the only path that
    // reads the `requires_confirmation` verdict mapping at all, and it was
    // uncovered: a mutation turning that refusal into permission survived the
    // suite until this test existed.
    const bare = new ToolAutonomyGate(
      new AutonomyService({ repository: new AutonomyRepository(env.DB), now }),
    );

    const decision = await bare.evaluateToolCall({
      toolName: TIER3_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: "{}",
    });

    expect(decision.verdict).toBe("confirm");
    expect(decision.confirmedBy).toBeNull();
    expect(decision.receipt).toContain("needs your tap");
  });

  it("withholds a tier-2 action while the system is in shadow mode", async () => {
    // 0008 seeds shadow, and shadow reports a tier-2 action instead of running
    // it. This is the mode working, not a refusal -- the receipt says which.
    const decision = await gate().evaluateToolCall({
      toolName: TIER2_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: "{}",
    });

    expect(decision.evaluation.tier).toBe(2);
    expect(decision.evaluation.mode).toBe("shadow");
    expect(decision.verdict).toBe("withheld");
    expect(decision.receipt).toContain("shadow mode");
  });

  it("denies rather than permitting when the evaluation cannot be recorded", async () => {    // The service throws exactly when its audit row could not be written, and
    // its contract calls that a denial. A gate that swallowed the throw would
    // hand back a verdict with no row behind it.
    const failing = new ToolAutonomyGate({
      evaluate: async () => { throw new Error("autonomy_audit_persistence_failed"); },
    });
    await expect(failing.evaluateToolCall({
      toolName: "memory_explain",
      principalId: PRINCIPAL_ID,
      arguments: "{}",
    })).rejects.toThrow();
  });

  it("treats reordered arguments as the same action", async () => {
    // The fingerprint is taken over canonical JSON, so a model that re-issues
    // the same call with its keys in a different order still matches the tap.
    await ownerConfirms(TIER3_TOOL, TIER3_CAPABILITY, JSON.stringify({ draft: "synthetic-reordered", body: "x" }));

    const decision = await gate().evaluateToolCall({
      toolName: TIER3_TOOL,
      principalId: PRINCIPAL_ID,
      arguments: JSON.stringify({ body: "x", draft: "synthetic-reordered" }),
    });

    expect(decision.verdict).toBe("permit");
  });
});
