import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import {
  argumentsFingerprint, confirmationReference, D1ToolConfirmationStore, TIER3_TOOL_ORIGIN,
} from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import migration from "../../src/persistence/migrations/0039_tool_confirmation_consumptions.sql?raw";
import { applyFoundationMigration, splitMigration } from "./migration.js";

describe("the additive confirmation migration", () => {
  it("keeps old readers working and fails closed on tier 3 when code arrives before the schema", async () => {
    await applyFoundationMigration();
    const timestamp = "2026-09-23T12:00:00.000Z";
    const now = () => new Date(timestamp);
    const principalId = "principal:tap-rollout";
    await env.DB.prepare(`INSERT INTO principals
      (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Rollout fixture', ?, ?)`)
      .bind(principalId, timestamp, timestamp).run();
    await env.DB.prepare(`INSERT INTO channel_identities
      (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES ('identity:tap-rollout', ?, 'telegram', 'synthetic-rollout', 'active', ?, ?)`)
      .bind(principalId, timestamp, timestamp).run();
    const service = new AutonomyService({ repository: new AutonomyRepository(env.DB), now });
    const gate = new ToolAutonomyGate(service, new D1ToolConfirmationStore(env.DB, now));
    const request = { principalId, toolName: "send_email", arguments: "{}" };
    const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now });
    const reference = confirmationReference("contact.third_party", await argumentsFingerprint(request.arguments));
    const item = await decisions.raise({
      principalId, origin: TIER3_TOOL_ORIGIN, originReference: reference,
      urgency: "normal", question: "Run the fixture?", choices: [{ key: "confirm", label: "Confirm" }],
    });
    await decisions.markDelivered(item.decisionId);
    expect((await decisions.answer({
      decisionId: item.decisionId, answeredByIdentityId: "identity:tap-rollout", optionKey: "confirm",
    })).outcome).toBe("recorded");
    await expect(gate.evaluateToolCall(request)).rejects.toThrow("no such table: tool_confirmation_consumptions");
    // This tier-1 mapping predates 0035, so the check needs only the prior schema.
    expect((await service.evaluate({ capability: "read.archive", principalId, summary: "rollout check" })).outcome)
      .toBe("permitted");
    expect((await gate.evaluateToolCall({ ...request, toolName: "tesla_precondition" })).verdict).toBe("withheld");

    const responseBefore = await env.DB.prepare("SELECT * FROM decision_responses WHERE decision_id = ?")
      .bind(item.decisionId).first();
    await applyD1Migrations(env.DB, [{ name: "0039_tool_confirmation_consumptions.sql", queries: splitMigration(migration) }]);
    // The pre-deploy SELECT still resolves the existing tap against unchanged
    // answer tables. Old code ignores the new table until the gateway deploy.
    const oldReader = await env.DB.prepare(`SELECT item.decision_id
      FROM decision_items item JOIN decision_responses response ON response.decision_id = item.decision_id
      WHERE item.principal_id = ? AND item.origin = ? AND item.origin_reference = ?
        AND response.option_key = 'confirm' AND item.resolved_at IS NOT NULL
        AND item.resolved_at >= ?
      ORDER BY response.responded_at DESC LIMIT 1`)
      .bind(principalId, TIER3_TOOL_ORIGIN, reference, timestamp).first<{ decision_id: string }>();
    expect(oldReader?.decision_id).toBe(item.decisionId);
    expect(await env.DB.prepare("SELECT * FROM decision_responses WHERE decision_id = ?")
      .bind(item.decisionId).first()).toEqual(responseBefore);
    expect((await gate.evaluateToolCall(request)).verdict).toBe("permit");
    expect((await gate.evaluateToolCall(request)).verdict).toBe("confirm");
  });
});
