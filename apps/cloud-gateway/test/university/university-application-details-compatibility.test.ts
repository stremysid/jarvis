import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityApplicationWorkflowMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-16T17:00:00.000Z");

beforeAll(async () => {
  await applyUniversityApplicationWorkflowMigration();
});

describe("university application details migration compatibility", () => {
  it("propagates a workflow read error that is not a missing migration 0029 table", async () => {
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property, target) as unknown;
        return (query: string): D1PreparedStatement => {
          if (query.includes("FROM university_workflow_items w")) {
            throw new Error("D1_ERROR: database unavailable");
          }
          return target.prepare(query);
        };
      },
    });
    const repository = new UniversityTrackerRepository(database);

    await expect(repository.readSnapshot("principal:workflow-noncompatibility-error"))
      .rejects.toThrow("D1_ERROR: database unavailable");
  });

  it("keeps the existing university tracker writable before migration 0029 is applied", async () => {
    const principalId = "principal:workflow-compatibility";
    const turnId = newUlid(NOW);
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Compatibility owner', ?2, ?2)`).bind(
      principalId,
      NOW.toISOString(),
    ).run();
    const ownerText = "Track Western Medical Sciences.";
    const redacted = new Redactor().redactText(ownerText);
    if (!redacted.ok) throw new Error("university_workflow_fixture_redaction_failed");
    await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
      turnId,
      sessionId: `telegram:${principalId}`,
      principalId,
      channel: "telegram",
      userText: redacted,
      now: NOW,
    });
    const repository = new UniversityTrackerRepository(env.DB);

    await expect(repository.applyOwnerPlan({
      principalId,
      turnId,
      responseHash: "7".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        programUpdates: [{
          programRef: "new-1",
          university: "Western University",
          campus: null,
          programName: "Medical Sciences",
          ouacCode: null,
          verification: { state: "unverified", sourceUrl: null, cycle: null },
          addRequirements: [],
          addDates: [],
          resolveItemIds: [],
        }],
        applicationUpdates: [],
        workflowUpdates: [],
      },
    })).resolves.toBeUndefined();

    await expect(repository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{
        university: "Western University",
        programName: "Medical Sciences",
        workflowItems: [],
      }],
    });
  });
});
