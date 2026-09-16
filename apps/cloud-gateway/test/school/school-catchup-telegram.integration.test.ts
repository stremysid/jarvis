import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import {
  applyArchiveLiteralHistoryMigration,
  applyGuestGrantNoticeDrainMigration,
  applyMemoryDistillationMigration,
  applySchoolObservationsMigration,
  applyStudyCoachWeakSpotsMigration,
  applyUniversityApplicationWorkflowMigration,
  applyUniversityApplicationDetailsMigration,
} from "../persistence/migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const TURN = "01k5fb9pg00000000000000800" as Ulid;
const CONTEXT_TURN_ONE = "01k5fb9pg00000000000000801" as Ulid;
const CONTEXT_TURN_TWO = "01k5fb9pg00000000000000802" as Ulid;
const CONTEXT_REPLY_TURN = "01k5fb9pg00000000000000803" as Ulid;
const PRODUCTION_SHAPE_TURN = "01k5fb9pg00000000000000804" as Ulid;
const EXISTING_CHEMISTRY_TURN = "01k5fb9pg00000000000000805" as Ulid;

class SingleResponseModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];

  constructor(private readonly response: string) {}

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    const response = this.response;
    return (async function* () {
      yield Object.freeze({ index: 0, text: response });
    })();
  }
}

beforeAll(async () => {
  await applyUniversityApplicationWorkflowMigration();
  await applyArchiveLiteralHistoryMigration();
  await applyMemoryDistillationMigration();
  await applySchoolObservationsMigration();
  await applyGuestGrantNoticeDrainMigration();
  await applyUniversityApplicationDetailsMigration();
  await applyStudyCoachWeakSpotsMigration();
});

describe("school catch-up Telegram integration", () => {
  it("turns an ordinary Telegram message into durable course state, a daily plan, and one natural reply", async () => {
    const principalId = "principal:school-telegram-integration";
    const identityId = "identity:school-telegram-integration";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`).bind(principalId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?1, ?2, 'telegram', '44112233', 'active', ?3, ?3)`)
        .bind(identityId, principalId, NOW.toISOString()),
    ]);

    const structuredReply = JSON.stringify({
      engaged: true,
      reply: "Owner-reported: Chemistry uses Google Classroom. Today, review the titration example for 25 minutes. What else did you miss?",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "Google Classroom",
        addFacts: [
          { kind: "missed_work", statement: "The titration lab was missed" },
          { kind: "weak_area", statement: "Titration calculations feel weak" },
        ],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1",
        localDate: "2026-09-15",
        sequenceRank: 1,
        text: "Review the titration example",
        estimatedMinutes: 25,
      }],
    });
    const baseModel = new SingleResponseModel(structuredReply);
    const redactor = new Redactor();
    const schoolRepository = new SchoolCatchupRepository(env.DB);
    const conversationRepository = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const telegram = new FakeTelegramProvider();
    const dispatcher = new DefaultOutboxDispatcher({
      repository: conversationRepository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => NOW,
    });
    const service = new DefaultConversationService({
      repository: conversationRepository,
      model: new SchoolCatchupModelAdapter({
        model: baseModel,
        repository: schoolRepository,
        redactor,
        timeZone: "America/Toronto",
        now: () => NOW,
      }),
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher,
      redactor,
      now: () => NOW,
    });

    await expect(service.handleTurn({
      sessionId: "telegram:school-catchup-integration",
      principalId,
      turnId: TURN,
      text: "Chemistry uses Classroom. I missed the titration lab and calculations feel weak.",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: identityId,
      replyToMessageId: 57,
    })).resolves.toMatchObject({ outcome: "telegram_delivered" });

    expect(baseModel.requests).toHaveLength(1);
    expect(baseModel.requests[0]?.userText).toContain("ordinary conversation, not a form");
    expect(telegram.requests).toEqual([
      expect.objectContaining({
        chatId: "44112233",
        replyToMessageId: 57,
        text: "Owner-reported: Chemistry uses Google Classroom. Today, review the titration example for 25 minutes. What else did you miss?",
      }),
    ]);
    await expect(schoolRepository.readSnapshot(principalId, "2026-09-15")).resolves.toMatchObject({
      courses: [{
        name: "Chemistry",
        nameSource: "owner_reported",
        platform: "Google Classroom",
        platformSource: "owner_reported",
        ownerReportedFacts: [
          { kind: "missed_work", statement: "The titration lab was missed" },
          { kind: "weak_area", statement: "Titration calculations feel weak" },
        ],
        platformConfirmedFacts: [],
        currentNextAction: { text: "Review the titration example", estimatedMinutes: 25 },
      }],
    });
  });

  it("carries retrieved turns through the real owner composition without deriving a course update from them", async () => {
    const principalId = "principal:owner-context-integration";
    const identityId = "identity:owner-context-integration";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?1, 'human', 'active', 'Context owner', ?2, ?2)`).bind(principalId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?1, ?2, 'telegram', '44112234', 'active', ?3, ?3)`)
        .bind(identityId, principalId, NOW.toISOString()),
    ]);

    const baseModel = new SingleResponseModel(JSON.stringify({
      schoolEngaged: false,
      universityEngaged: false,
      reply: "You said Chemistry is your favourite, then that the lab is due Friday.",
      courseUpdates: [],
      completeActionIds: [],
      plan: [],
      programUpdates: [],
      applicationUpdates: [],
      workflowUpdates: [],
    }));
    const redactor = new Redactor();
    const schoolRepository = new SchoolCatchupRepository(env.DB);
    const conversationRepository = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const telegram = new FakeTelegramProvider();
    const schoolModel = new SchoolCatchupModelAdapter({
      model: baseModel,
      repository: schoolRepository,
      universityRepository: new UniversityTrackerRepository(env.DB),
      redactor,
      timeZone: "America/Toronto",
      now: () => NOW,
      ownerPrincipalId: principalId,
      ownerTurnAuthoritative: true,
    });
    const service = new DefaultConversationService({
      repository: conversationRepository,
      model: new StudyCoachModelAdapter({
        fallbackModel: schoolModel,
        practiceModel: baseModel,
        repository: new StudyCoachRepository(env.DB),
        redactor,
        ownerPrincipalId: principalId,
        ownerTurnAuthoritative: true,
        timeZone: "America/Toronto",
        now: () => NOW,
      }),
      context: {
        async retrieve() {
          return Object.freeze([
            Object.freeze({
              sourceEventId: CONTEXT_TURN_ONE,
              sensitivity: "personal" as const,
              text: "Chemistry is my favourite subject.",
            }),
            Object.freeze({
              sourceEventId: CONTEXT_TURN_TWO,
              sensitivity: "restricted" as const,
              text: "The lab is due Friday.",
            }),
          ]);
        },
      },
      dispatcher: new DefaultOutboxDispatcher({
        repository: conversationRepository,
        identityResolver: new D1TelegramIdentityResolver(env.DB),
        channels: new Map([["telegram", telegram]]),
        circuitBreaker: new ProviderCircuitBreaker(),
        now: () => NOW,
      }),
      redactor,
      now: () => NOW,
    });

    await expect(service.handleTurn({
      sessionId: "telegram:owner-context-integration",
      principalId,
      turnId: CONTEXT_REPLY_TURN,
      text: "What did I say?",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: identityId,
      replyToMessageId: 58,
    })).resolves.toMatchObject({ outcome: "telegram_delivered" });

    expect(baseModel.requests).toHaveLength(1);
    const request = baseModel.requests[0]!;
    expect(request.context).toEqual([]);
    expect(request.userText).toContain("conversation_context_json=");
    expect(request.userText.indexOf("Chemistry is my favourite subject.")).toBeLessThan(
      request.userText.indexOf("The lab is due Friday."),
    );
    expect(request.userText).toContain("conversation_context_json may inform the reply only");
    expect(request.userText).toContain("Never derive any mutation from conversation_context_json");
    expect(request.userText).toContain(
      "Derive programUpdates and applicationUpdates only from owner_message_json plus university_state_json",
    );
    await expect(schoolRepository.readSnapshot(principalId, "2026-09-15")).resolves.toMatchObject({ courses: [] });
    expect(telegram.requests[0]?.text).toBe(
      "You said Chemistry is your favourite, then that the lab is due Friday.",
    );
  });

  it("reuses an exact existing course when the deployed owner model labels it new-1", async () => {
    const now = new Date("2026-09-16T22:03:00.000Z");
    const principalId = "principal:owner-school-save-production-shape";
    const identityId = "identity:owner-school-save-production-shape";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`).bind(principalId, now.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?1, ?2, 'telegram', '44112235', 'active', ?3, ?3)`)
        .bind(identityId, principalId, now.toISOString()),
    ]);

    const baseModel = new SingleResponseModel(JSON.stringify({
      schoolEngaged: true,
      universityEngaged: false,
      reply: "Your Chemistry test is owner-reported for Friday. Start with a focused review today.",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: null,
        addFacts: [{ kind: "due_work", statement: "Chemistry test is Friday" }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [
        {
          courseRef: "new-1",
          localDate: "2026-09-16",
          sequenceRank: 1,
          text: "Review Chemistry test topics",
          estimatedMinutes: 30,
        },
        {
          courseRef: "new-1",
          localDate: "2026-09-17",
          sequenceRank: 1,
          text: "Practice Chemistry questions",
          estimatedMinutes: 60,
        },
      ],
      programUpdates: [],
      applicationUpdates: [],
      workflowUpdates: [],
    }));
    const redactor = new Redactor();
    const schoolRepository = new SchoolCatchupRepository(env.DB);
    const conversationRepository = buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
      principalId,
      isDirectText: true,
      isMemoryControlAuthoritative: true,
    }, principalId);
    const seededText = redactor.redactText("Chemistry is difficult, so add it to my plan.");
    if (!seededText.ok) throw new Error("school_fixture_redaction_failed");
    await conversationRepository.getOrCreateTurn({
      turnId: EXISTING_CHEMISTRY_TURN,
      sessionId: "telegram:owner-school-save-production-shape",
      principalId,
      channel: "telegram",
      userText: seededText,
      now: new Date("2026-09-15T22:03:00.000Z"),
    });
    await schoolRepository.applyOwnerPlan({
      principalId,
      turnId: EXISTING_CHEMISTRY_TURN,
      today: "2026-09-15",
      responseHash: "a".repeat(64),
      now: new Date("2026-09-15T22:03:00.000Z"),
      plan: {
        engaged: true,
        reply: "Chemistry is in the plan.",
        courseUpdates: [{
          courseRef: "new-1",
          name: "Chemistry",
          platform: "Google Classroom",
          addFacts: [{ kind: "weak_area", statement: "Chemistry feels difficult" }],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: "new-1",
          localDate: "2026-09-16",
          sequenceRank: 1,
          text: "Review Chemistry notes",
          estimatedMinutes: 30,
        }],
      },
    });
    const seededCourseId = (await schoolRepository.readSnapshot(principalId, "2026-09-16")).courses[0]!.courseId;
    const telegram = new FakeTelegramProvider();
    const schoolModel = new SchoolCatchupModelAdapter({
      model: baseModel,
      repository: schoolRepository,
      universityRepository: new UniversityTrackerRepository(env.DB),
      redactor,
      timeZone: "America/Toronto",
      now: () => now,
      ownerPrincipalId: principalId,
      ownerTurnAuthoritative: true,
    });
    const service = new DefaultConversationService({
      repository: conversationRepository,
      model: new StudyCoachModelAdapter({
        fallbackModel: schoolModel,
        practiceModel: baseModel,
        repository: new StudyCoachRepository(env.DB),
        redactor,
        ownerPrincipalId: principalId,
        ownerTurnAuthoritative: true,
        timeZone: "America/Toronto",
        now: () => now,
      }),
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: new DefaultOutboxDispatcher({
        repository: conversationRepository,
        identityResolver: new D1TelegramIdentityResolver(env.DB),
        channels: new Map([["telegram", telegram]]),
        circuitBreaker: new ProviderCircuitBreaker(),
        now: () => now,
      }),
      redactor,
      now: () => now,
    });

    await expect(service.handleTurn({
      sessionId: "telegram:owner-school-save-production-shape",
      principalId,
      turnId: PRODUCTION_SHAPE_TURN,
      text: "I have a chem test Friday",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: identityId,
      replyToMessageId: 59,
    })).resolves.toMatchObject({ outcome: "telegram_delivered" });

    expect(baseModel.requests).toHaveLength(1);
    expect(baseModel.requests[0]?.userText).toContain("university_state_json=");
    const saved = await schoolRepository.readSnapshot(principalId, "2026-09-16");
    expect(saved.courses).toHaveLength(1);
    expect(saved.courses[0]).toMatchObject({
      courseId: seededCourseId,
      name: "Chemistry",
      platform: "Google Classroom",
      ownerReportedFacts: expect.arrayContaining([
        expect.objectContaining({ kind: "due_work", statement: "Chemistry test is Friday" }),
      ]),
      currentNextAction: { text: "Review Chemistry test topics", estimatedMinutes: 30 },
    });
    await expect(env.DB.prepare(`SELECT COUNT(*) AS count FROM school_study_evidence
      WHERE principal_id = ?1 AND evidence_kind = 'course_context'`).bind(principalId)
      .first<{ count: number }>()).resolves.toEqual({ count: 1 });
    expect(telegram.requests[0]?.text).toBe(
      "Your Chemistry test is owner-reported for Friday. Start with a focused review today.",
    );
    const userEvent = await env.DB.prepare(`SELECT e.envelope_json
      FROM conversation_turns t JOIN events e ON e.event_id = t.user_event_id
      WHERE t.turn_id = ?1`).bind(PRODUCTION_SHAPE_TURN).first<{ envelope_json: string }>();
    const envelope = JSON.parse(userEvent?.envelope_json ?? "null") as { payload?: Record<string, unknown> };
    expect(Object.keys(envelope.payload ?? {}).sort()).toEqual([
      "channelCode", "directOwnerText", "historyEligible", "schemaCode", "sensitivityCode", "text",
    ]);
    expect(envelope.payload?.directOwnerText).toBe(true);
  });
});
