import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { applyStudyCoachWeakSpotsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TODAY = "2026-09-15";

async function addTurn(principalId: string, text: string, at: Date, channel: "telegram" | "voice" = "telegram"): Promise<Ulid> {
  const turnId = newUlid(at);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("fixture");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId, sessionId: `${channel}:${principalId}`, principalId, channel, userText: redacted, now: at,
  });
  return turnId;
}

async function graph(suffix: string) {
  const principalId = `principal:adv73m-${suffix}`;
  await env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?1, 'human', 'active', 'x', ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
  const early = await addTurn(principalId, "course", NOW);
  await new SchoolCatchupRepository(env.DB).applyOwnerPlan({
    principalId, turnId: early, today: TODAY, responseHash: suffix.replace(/[^a-f0-9]/gu, "e").padEnd(64, "e").slice(0, 64), now: NOW,
    plan: { engaged: true, reply: "Plan",
      courseUpdates: [{ courseRef: "new-1", name: `Chem ${suffix}`, platform: "D2L",
        addFacts: [{ kind: "due_work", statement: "Worksheet due" }], resolveFactIds: [] }],
      completeActionIds: [],
      plan: [{ courseRef: "new-1", localDate: TODAY, sequenceRank: 1, text: "Review", estimatedMinutes: 20 }] },
  });
  const deadlines = new DeadlineRepository(env.DB);
  const source = await deadlines.createSource({ sourceId: `adv73m-${suffix}`, kind: "manual", label: "Owner", now: NOW });
  const deadline = await deadlines.upsert({ sourceId: source.sourceId, externalId: `x-${suffix}`, course: `Chem ${suffix}`,
    title: "t", dueAt: "2026-09-14T11:30:00.000Z", effort: "other", leadMinutes: 60, now: NOW });
  const claim = await new StudyCoachRepository(env.DB).syncAndClaimDigestCheckIn({
    principalId, today: TODAY, weekday: 2, minuteOfDay: 450, now: NOW,
    signalInputs: { deadlines: (await deadlines.listStudyCandidates(NOW)).filter((d) => d.deadline.deadlineId === deadline.deadline.deadlineId) },
  });
  if (claim === null) throw new Error("no claim");
  const row = await env.DB.prepare("SELECT claim_id FROM school_study_check_in_claims WHERE principal_id = ?1")
    .bind(principalId).first<{ claim_id: string }>();
  return { principalId, early, claimId: row!.claim_id, deadlineId: deadline.deadline.deadlineId, courseId: claim.courseId };
}

beforeAll(async () => { await applyStudyCoachWeakSpotsMigration(); });

describe("0030 conflict-clause bypasses", () => {
  it("M1-M3 OR REPLACE / OR IGNORE / UPDATE OR REPLACE cannot rewrite a claim", async () => {
    const g = await graph("m1");
    const copy = (verb: string) => env.DB.prepare(`${verb} INTO school_study_check_in_claims (
        principal_id, claim_id, local_date, course_id, topic, outcome, evidence_count,
        confidence, observed_at, citations_json, source_keys_json, claimed_at)
      SELECT principal_id, ?1, local_date, course_id, 'Rewritten', outcome, evidence_count, confidence,
        observed_at, citations_json, source_keys_json, claimed_at
      FROM school_study_check_in_claims WHERE principal_id = ?2`).bind(newUlid(new Date(NOW.getTime() + 5)), g.principalId).run();
    await expect(copy("INSERT OR REPLACE")).rejects.toThrow(/school_study_check_in_insert_conflict/u);
    await expect(copy("REPLACE")).rejects.toThrow(/school_study_check_in_insert_conflict/u);
    await expect(copy("INSERT OR IGNORE")).rejects.toThrow(/school_study_check_in_insert_conflict/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE school_study_check_in_claims SET topic = 'x' WHERE principal_id = ?1`)
      .bind(g.principalId).run()).rejects.toThrow(/update_forbidden/u);
    const topic = await env.DB.prepare("SELECT topic FROM school_study_check_in_claims WHERE principal_id = ?1").bind(g.principalId).first();
    expect(topic).toEqual({ topic: `Chem m1 review` });
  });

  it("M4-M6 controls: REPLACE blocked, cross-principal claim blocked, but a pre-claim turn is accepted", async () => {
    const a = await graph("m4a");
    const b = await graph("m4b");
    const later = await addTurn(a.principalId, "I already handled that", new Date(NOW.getTime() + 60_000));
    const insert = (verb: string, principalId: string, claimId: string, turnId: string, deadlineId: string, disposition = "handled") =>
      env.DB.prepare(`${verb} INTO school_study_signal_controls (principal_id, source_key, source_kind, source_record_id,
        disposition, check_in_id, control_turn_id, controlled_at, created_at)
        VALUES (?1, ?2, 'deadline', ?3, ?4, ?5, ?6, ?7, ?7)`)
        .bind(principalId, `deadline:${deadlineId}`, deadlineId, disposition, claimId, turnId, new Date(NOW.getTime() + 60_000).toISOString()).run();
    // cross-principal: principal B cites A's claim id / A's turn
    await expect(insert("INSERT", b.principalId, a.claimId, b.early, a.deadlineId)).rejects.toThrow();
    await expect(insert("INSERT", b.principalId, b.claimId, later, b.deadlineId)).rejects.toThrow(/insert_invalid/u);
    // a turn that predates the claim (the plan turn) is accepted as the correction turn
    await expect(insert("INSERT", a.principalId, a.claimId, a.early, a.deadlineId)).resolves.toBeDefined();
    await expect(insert("INSERT OR REPLACE", a.principalId, a.claimId, later, a.deadlineId, "wrong")).rejects.toThrow(/insert_invalid/u);
    await expect(insert("INSERT OR IGNORE", a.principalId, a.claimId, later, a.deadlineId, "wrong")).rejects.toThrow(/insert_invalid/u);
  });
});
