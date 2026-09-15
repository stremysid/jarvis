import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { applySchoolCatchupMigration, applyUniversityTrackerMigration } from "./migration.js";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const TODAY = "2026-09-15";

async function addTurn(principalId: string, turnId: Ulid, text: string, now: Date): Promise<void> {
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("school_upgrade_fixture_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `telegram:${principalId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now,
  });
}

beforeAll(async () => {
  await applySchoolCatchupMigration();
});

describe("0022 school history upgrade", () => {
  it("rewrites an existing resolved fact key and permits the same fact to be reported again", async () => {
    const principalId = "principal:school-0022-upgrade";
    const firstTurn = "01k5fb9pg00000000000000d00" as Ulid;
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'School upgrade owner', ?2, ?2)`)
      .bind(principalId, NOW.toISOString()).run();
    await addTurn(principalId, firstTurn, "I missed the chemistry lab.", NOW);
    const repository = new SchoolCatchupRepository(env.DB);
    await repository.applyOwnerPlan({
      principalId,
      turnId: firstTurn,
      today: TODAY,
      responseHash: "a".repeat(64),
      now: NOW,
      plan: {
        engaged: true,
        reply: "I added the missed lab.",
        courseUpdates: [{
          courseRef: "new-1",
          name: "Chemistry",
          platform: null,
          addFacts: [{ kind: "missed_work", statement: "The chemistry lab was missed" }],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: "new-1",
          localDate: TODAY,
          sequenceRank: 1,
          text: "Recover the chemistry lab",
          estimatedMinutes: 25,
        }],
      },
    });
    const initial = await repository.readSnapshot(principalId, TODAY);
    const course = initial.courses[0]!;
    const fact = course.ownerReportedFacts[0]!;
    const beforeUpgrade = await env.DB.prepare(`SELECT fact_key FROM school_course_facts
      WHERE principal_id = ?1 AND fact_id = ?2`).bind(principalId, fact.factId).first<{ fact_key: string }>();
    const resolvedAt = new Date(NOW.getTime() + 60_000).toISOString();
    await env.DB.prepare(`UPDATE school_course_facts
      SET status = 'resolved', resolved_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND fact_id = ?3`).bind(resolvedAt, principalId, fact.factId).run();

    await applyUniversityTrackerMigration();

    const afterUpgrade = await env.DB.prepare(`SELECT fact_key, status FROM school_course_facts
      WHERE principal_id = ?1 AND fact_id = ?2`)
      .bind(principalId, fact.factId).first<{ fact_key: string; status: string }>();
    const archivedKey = `${beforeUpgrade!.fact_key.slice(0, 476)}:resolved:${fact.factId}`;
    expect(afterUpgrade).toEqual({ fact_key: archivedKey, status: "resolved" });

    const secondTurn = "01k5fb9pg00000000000000d01" as Ulid;
    const secondNow = new Date(NOW.getTime() + 120_000);
    await addTurn(principalId, secondTurn, "I still need to recover that chemistry lab.", secondNow);
    await expect(repository.applyOwnerPlan({
      principalId,
      turnId: secondTurn,
      today: TODAY,
      responseHash: "b".repeat(64),
      now: secondNow,
      plan: {
        engaged: true,
        reply: "I put the missed lab back on the active list.",
        courseUpdates: [{
          courseRef: course.courseId,
          name: null,
          platform: null,
          addFacts: [{ kind: "missed_work", statement: "The chemistry lab was missed" }],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: course.courseId,
          localDate: TODAY,
          sequenceRank: 1,
          text: "Recover the chemistry lab",
          estimatedMinutes: 25,
        }],
      },
    })).resolves.toBeUndefined();
    const facts = await env.DB.prepare(`SELECT fact_id, fact_key, status FROM school_course_facts
      WHERE principal_id = ?1 ORDER BY status, fact_id`)
      .bind(principalId).all<{ fact_id: string; fact_key: string; status: string }>();
    expect(facts.results).toHaveLength(2);
    expect(facts.results[0]).toMatchObject({ fact_key: beforeUpgrade!.fact_key, status: "active" });
    expect(facts.results[0]?.fact_id).not.toBe(fact.factId);
    expect(facts.results[1]).toEqual({ fact_id: fact.factId, fact_key: archivedKey, status: "resolved" });
  });
});
