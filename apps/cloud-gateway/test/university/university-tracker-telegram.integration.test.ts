import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { applyUniversityTrackerMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T16:00:00.000Z");
const TURN = "01k5fb9pg00000000000000b00" as Ulid;

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
  await applyUniversityTrackerMigration();
});

describe("university tracker Telegram integration", () => {
  it("turns ordinary program talk into a labelled shortlist and one natural reply", async () => {
    const principalId = "principal:university-telegram";
    const identityId = "identity:university-telegram";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?1, 'human', 'active', 'University owner', ?2, ?2)`).bind(principalId, NOW.toISOString()),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?1, ?2, 'telegram', '44119900', 'active', ?3, ?3)`)
        .bind(identityId, principalId, NOW.toISOString()),
    ]);
    const structuredReply = JSON.stringify({
      schoolEngaged: false,
      universityEngaged: true,
      reply: "Unverified for the 2027 cycle: Waterloo Computer Science is on your shortlist, but its courses and application date still need a current official source. Which other program are you considering?",
      courseUpdates: [],
      completeActionIds: [],
      plan: [],
      programUpdates: [{
        programRef: "new-1",
        university: "University of Waterloo",
        campus: null,
        programName: "Computer Science",
        ouacCode: null,
        verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
        addRequirements: [{
          label: "Required Grade 12 courses",
          detail: "Advanced Functions, Calculus and Vectors, and English",
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
        }],
        addDates: [{
          label: "Application deadline",
          date: null,
          verification: { state: "unverified", sourceUrl: null, cycle: "2027" },
        }],
        resolveItemIds: [],
      }],
    });
    const baseModel = new SingleResponseModel(structuredReply);
    const redactor = new Redactor();
    const schoolRepository = new SchoolCatchupRepository(env.DB);
    const universityRepository = new UniversityTrackerRepository(env.DB);
    const conversationRepository = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const telegram = new FakeTelegramProvider();
    const service = new DefaultConversationService({
      repository: conversationRepository,
      model: new SchoolCatchupModelAdapter({
        model: baseModel,
        repository: schoolRepository,
        universityRepository,
        redactor,
        timeZone: "America/Toronto",
        now: () => NOW,
      }),
      context: { async retrieve() { return Object.freeze([]); } },
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
      sessionId: "telegram:university-integration",
      principalId,
      turnId: TURN,
      text: "I'm considering Waterloo Computer Science. I heard it needs calculus and English. The date might be January, but I haven't checked the official 2027 page.",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: identityId,
      replyToMessageId: 58,
    })).resolves.toMatchObject({ outcome: "telegram_delivered" });

    expect(baseModel.requests).toHaveLength(1);
    expect(telegram.requests[0]?.text).toContain("Unverified for the 2027 cycle");
    await expect(universityRepository.readSnapshot(principalId)).resolves.toMatchObject({
      programs: [{
        programName: "Computer Science",
        verification: { state: "unverified", verifiedAt: null },
        requirements: [{ verification: { state: "unverified", verifiedAt: null } }],
        dates: [{ date: null, verification: { state: "unverified", verifiedAt: null } }],
      }],
    });
  });
});
