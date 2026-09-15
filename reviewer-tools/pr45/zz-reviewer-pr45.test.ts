// Reviewer probes for PR #45. Each test ASSERTS THE BUG EXISTS (passes on a buggy head).
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { applySchoolCatchupMigration } from "./migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function addPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
}

async function addTurn(principalId: string): Promise<Ulid> {
  const turnId = newUlid(NOW);
  const redacted = new Redactor().redactText("probe provenance");
  if (!redacted.ok) throw new Error("probe_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId, sessionId: `telegram:${principalId}`, principalId, channel: "telegram", userText: redacted, now: NOW,
  });
  return turnId;
}

async function insertBareCard(principalId: string, turnId: Ulid, key: string): Promise<Ulid> {
  const courseId = newUlid(NOW);
  await env.DB.prepare(`INSERT INTO school_course_cards (
    principal_id, course_id, course_key, course_name, course_name_source,
    platform_name, platform_source, platform_source_ref, platform_observed_at,
    owner_source_turn_id, active, created_at, updated_at
  ) VALUES (?1, ?2, ?3, ?3, 'owner_reported', NULL, NULL, NULL, NULL, ?4, 1, ?5, ?5)`)
    .bind(principalId, courseId, key, turnId, NOW.toISOString()).run();
  return courseId;
}

beforeAll(async () => {
  await applySchoolCatchupMigration();
});

describe("PR45 reviewer probes", () => {
  it("P1: UPDATE OR REPLACE on course_key silently deletes another card (bypasses reject_delete)", async () => {
    const principalId = "principal:pr45-probe-p1";
    await addPrincipal(principalId);
    const turnId = await addTurn(principalId);
    const victim = await insertBareCard(principalId, turnId, "physics");
    const mover = await insertBareCard(principalId, turnId, "chemistry");
    await env.DB.prepare(`UPDATE OR REPLACE school_course_cards SET course_key = 'physics'
      WHERE principal_id = ?1 AND course_id = ?2`).bind(principalId, mover).run();
    const remaining = await env.DB.prepare(`SELECT course_id FROM school_course_cards WHERE principal_id = ?1`)
      .bind(principalId).all<{ course_id: string }>();
    expect(remaining.results.map((row) => row.course_id)).toEqual([mover]);
    expect(remaining.results.map((row) => row.course_id)).not.toContain(victim);
  });

  it("P2: re-reporting a fact that was resolved earlier makes the whole owner plan fail", async () => {
    const principalId = "principal:pr45-probe-p2";
    await addPrincipal(principalId);
    const repository = new SchoolCatchupRepository(env.DB);
    const first = await addTurn(principalId);
    const plan = (turnId: Ulid, courseRef: string, resolve: readonly Ulid[], add: boolean) => ({
      principalId, turnId, today: TODAY, now: NOW,
      responseHash: turnId.toLowerCase().padEnd(64, "a").replace(/[^a-f0-9]/gu, "a").slice(0, 64),
      plan: {
        engaged: true, reply: "ok",
        courseUpdates: [{
          courseRef, name: courseRef.startsWith("new-") ? "Math" : null, platform: null,
          addFacts: add ? [{ kind: "weak_area" as const, statement: "Fractions" }] : [],
          resolveFactIds: resolve,
        }],
        completeActionIds: [],
        plan: [{ courseRef, localDate: TODAY, sequenceRank: 1, text: "Practice fractions", estimatedMinutes: 20 }],
      },
    });
    await repository.applyOwnerPlan(plan(first, "new-1", [], true));
    const snapshot = await repository.readSnapshot(principalId, TODAY);
    const courseId = snapshot.courses[0]!.courseId;
    const factId = snapshot.courses[0]!.ownerReportedFacts[0]!.factId;
    const second = await addTurn(principalId);
    await repository.applyOwnerPlan(plan(second, courseId, [factId], false));
    const third = await addTurn(principalId);
    await expect(repository.applyOwnerPlan(plan(third, courseId, [], true))).rejects.toThrow();
  });

  it("P3: a code-fenced JSON reply never engages and pays for a second full model call", async () => {
    let calls = 0;
    let applied = false;
    const payload = JSON.stringify({ engaged: false, reply: "Hi Sid", courseUpdates: [], completeActionIds: [], plan: [] });
    const model = {
      async *stream() {
        calls += 1;
        yield { index: 0, text: calls === 1 ? "```json\n" + payload + "\n```" : "plain fallback reply" };
      },
    };
    const adapter = new SchoolCatchupModelAdapter({
      model: model as never,
      repository: {
        readSnapshot: async (principalId: string) => ({ principalId, courses: [] }),
        applyOwnerPlan: async () => { applied = true; },
      } as never,
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });
    let text = "";
    for await (const token of adapter.stream({
      correlationId: newUlid(NOW), principalId: "principal:pr45-probe-p3", channel: "telegram",
      userText: "hello", context: [],
    } as never)) text += token.text;
    expect(calls).toBe(2);
    expect(applied).toBe(false);
    expect(text).toBe("plain fallback reply");
  });

  it("P4: a model plan that omits one course's next action fails the whole owner turn", async () => {
    const principalId = "principal:pr45-probe-p4";
    await addPrincipal(principalId);
    const repository = new SchoolCatchupRepository(env.DB);
    const seedTurn = await addTurn(principalId);
    await repository.applyOwnerPlan({
      principalId, turnId: seedTurn, today: TODAY, now: NOW, responseHash: "b".repeat(64),
      plan: {
        engaged: true, reply: "ok",
        courseUpdates: [
          { courseRef: "new-1", name: "Math", platform: null, addFacts: [], resolveFactIds: [] },
          { courseRef: "new-2", name: "Chemistry", platform: null, addFacts: [], resolveFactIds: [] },
        ],
        completeActionIds: [],
        plan: [
          { courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Algebra review", estimatedMinutes: 20 },
          { courseRef: "new-2", localDate: TODAY, sequenceRank: 2, text: "Lab notes", estimatedMinutes: 20 },
        ],
      },
    });
    const snapshot = await repository.readSnapshot(principalId, TODAY);
    const math = snapshot.courses.find((course) => course.name === "Math")!.courseId;
    const response = JSON.stringify({
      engaged: true,
      reply: "Got it, graphs are on today's list.",
      courseUpdates: [{ courseRef: math, name: null, platform: null,
        addFacts: [{ kind: "weak_area", statement: "Graphs" }], resolveFactIds: [] }],
      completeActionIds: [],
      plan: [{ courseRef: math, localDate: TODAY, sequenceRank: 1, text: "Graph practice", estimatedMinutes: 20 }],
    });
    const adapter = new SchoolCatchupModelAdapter({
      model: { async *stream() { yield { index: 0, text: response }; } } as never,
      repository,
      redactor: new Redactor(),
      timeZone: "America/Toronto",
      now: () => NOW,
    });
    const turnId = await addTurn(principalId);
    const consume = async () => {
      for await (const _token of adapter.stream({
        correlationId: turnId, principalId, channel: "telegram", userText: "I'm weak at graphs", context: [],
      } as never)) { /* drain */ }
    };
    await expect(consume()).rejects.toThrow(/school_catchup_persistence_failed/u);
  });
});
