import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { createOwnerPipelineModels } from "../../src/agent/owner-pipelines.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { capabilityForTool } from "../../src/autonomy/tool-capabilities.js";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import {
  applyStudyCoachWeakSpotsMigration,
  applyUniversityApplicationDetailsMigration,
} from "../persistence/migration.js";
import productionRuntimeSource from "../../src/voice/production-runtime.js?raw";

const NOW = new Date("2026-09-17T15:00:00.000Z");
let serial = 0;

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];
  constructor(private readonly replies: readonly string[]) {}

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    yield Object.freeze({ index: 0, text: this.replies[this.requests.length - 1] ?? "Fallback." });
  }
}

class ToolAgentProvider implements ModelAgentProvider {
  readonly requests: ModelAgentCompletionInput[] = [];
  constructor(private readonly toolName: string) {}

  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    this.requests.push(input);
    if (this.requests.length === 1) {
      return Object.freeze({
        content: null,
        toolCalls: Object.freeze([Object.freeze({
          id: "pipeline_call",
          name: this.toolName,
          arguments: "{}",
        })]),
        finishReason: "tool_calls" as const,
      });
    }
    return Object.freeze({
      content: JSON.stringify({ reply: "", claimedActions: [] }),
      toolCalls: Object.freeze([]),
      finishReason: "stop" as const,
    });
  }
}

async function runPipelineTurn(input: {
  readonly channel: "telegram" | "voice";
  readonly label: string;
  readonly message: string;
  readonly toolName: "school_update" | "university_update" | "study_coach";
  readonly modelReplies: readonly string[];
  readonly ownerTurnAuthoritative?: boolean;
}): Promise<Readonly<{
  principalId: string;
  reply: string;
  baseModel: SequenceModel;
  school: SchoolCatchupRepository;
  university: UniversityTrackerRepository;
  study: StudyCoachRepository;
  agent: ToolAgentProvider;
}>> {
  serial += 1;
  const principalId = `principal:owner-pipeline:${input.label}:${serial}`;
  const identityId = `identity:owner-pipeline:${input.label}:${serial}`;
  const providerSubject = String(8_000_000 + serial);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Pipeline owner', ?2, ?2)`).bind(principalId, NOW.toISOString()),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?1, ?2, 'telegram', ?3, 'active', ?4, ?4)`)
      .bind(identityId, principalId, providerSubject, NOW.toISOString()),
  ]);
  const redactor = new Redactor();
  const baseModel = new SequenceModel(input.modelReplies);
  const school = new SchoolCatchupRepository(env.DB);
  const university = new UniversityTrackerRepository(env.DB);
  const study = new StudyCoachRepository(env.DB);
  const pipelines = createOwnerPipelineModels(
    env,
    baseModel,
    redactor,
    principalId,
    input.ownerTurnAuthoritative ?? true,
    () => NOW,
  );
  const agent = new ToolAgentProvider(input.toolName);
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB), {
    ...(input.channel === "telegram" ? { telegramDirectOwnerText: true } : {}),
  });
  const telegram = new FakeTelegramProvider();
  const shared = {
    provider: agent, database: env.DB, archive: env.ARCHIVE,
    autonomy: await testToolGate(env.DB), ownerPrincipalId: principalId,
    directOwnerText: true,
    targets: { async findControlTargets() { return Object.freeze([]); } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    ...pipelines,
  };
  const service = new DefaultConversationService({
    repository,
    model: input.channel === "voice" ? new OwnerVoiceAgentAdapter(shared) : new OwnerTelegramAgentAdapter({
      ...shared, authorityText: input.message,
    }),
    context: { async retrieve() { return Object.freeze([]); } },
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => NOW,
    }),
    redactor,
    now: () => NOW,
  });
  const turnId = newUlid();
  const sessionId = input.channel + ":" + providerSubject;
  const pieces: string[] = [];
  const delivery = createVoiceStreamDelivery({
    sessionId, turnId, sendToken: async token => { pieces.push(token.text); },
    finish: async text => { expect(pieces.join("")).toBe(text); },
  });
  const turn = { sessionId, principalId, turnId, text: input.message, signal: new AbortController().signal };
  await expect(service.handleTurn(input.channel === "voice" ? { ...turn, ...delivery } : {
    ...turn, channel: "telegram", kind: "outbox", targetIdentityId: identityId, replyToMessageId: serial,
  })).resolves.toMatchObject({ outcome: input.channel === "voice" ? "voice_sent" : "telegram_delivered" });
  const audit = await env.DB.prepare("SELECT capability, outcome FROM autonomy_evaluations WHERE principal_id = ?")
    .bind(principalId).all();
  expect(audit.results).toEqual([{ capability: capabilityForTool(input.toolName), outcome: "permitted" }]);
  return Object.freeze({
    principalId,
    reply: input.channel === "voice" ? pieces.join("") : telegram.requests[0]?.text ?? "",
    baseModel,
    school,
    university,
    study,
    agent,
  });
}

beforeAll(async () => {
  await applyStudyCoachWeakSpotsMigration();
  await applyUniversityApplicationDetailsMigration();
});

it("keeps production voice pipelines authoritative with thinking disabled", () => {
  const composition = /createOwnerPipelineModels\(env, new DeepSeekModelAdapter\(\{[\s\S]*?telegramTurn: true, telegramThinking: "disabled"[\s\S]*?\}\), new Redactor\(\), ownerPrincipalId, true, now\)/u
    .exec(productionRuntimeSource)?.[0];
  expect(composition).toBeDefined();
  expect(composition).not.toContain("DEEPSEEK_TELEGRAM_THINKING");
});

describe.each(["telegram", "voice"] as const)("owner %s agent validated feature pipelines", (channel) => {
  const run = (input: Omit<Parameters<typeof runPipelineTurn>[0], "channel">) => runPipelineTurn({ ...input, channel });
  it("lets the agent choose school and preserves the existing validated save and receipt", async () => {
    const structured = JSON.stringify({
      engaged: true,
      reply: "I saved your Chemistry update.",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "Google Classroom",
        addFacts: [{ kind: "weak_area", statement: "Titration calculations feel weak" }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1",
        localDate: "2026-09-17",
        sequenceRank: 1,
        text: "Review titration calculations",
        estimatedMinutes: 25,
      }],
    });
    const result = await run({
      label: "school",
      message: "Chemistry uses Classroom and titration calculations feel weak",
      toolName: "school_update",
      modelReplies: [structured],
    });

    expect(result.reply).toContain("Today: Chemistry: Review titration calculations (25 min).");
    expect(result.agent.requests).toHaveLength(2);
    expect(JSON.parse(result.agent.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "completed",
      receiptId: "receipt:pipeline_call",
    });
    await expect(result.school.readSnapshot(result.principalId, "2026-09-17")).resolves.toMatchObject({
      courses: [{ name: "Chemistry", ownerReportedFacts: [{ statement: "Titration calculations feel weak" }] }],
    });
  });

  it("lets the agent choose university and preserves the existing validated save and receipt", async () => {
    const message = "Add Waterloo Computer Science to my shortlist, still unverified";
    const structured = JSON.stringify({
      schoolEngaged: false,
      universityEngaged: true,
      reply: "I saved that as unverified.",
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
        addRequirements: [],
        addDates: [],
        resolveItemIds: [],
      }],
      applicationUpdates: [],
      workflowUpdates: [],
    });
    const result = await run({
      label: "university",
      message,
      toolName: "university_update",
      modelReplies: [structured],
    });

    expect(result.reply).toContain("Saved: University of Waterloo Computer Science (unverified).");
    expect(JSON.parse(result.agent.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "completed",
      receiptId: "receipt:pipeline_call",
    });
    await expect(result.university.readSnapshot(result.principalId)).resolves.toMatchObject({
      programs: [{ university: "University of Waterloo", programName: "Computer Science" }],
    });
  });

  it("does not let a selected university tool mutate the school store", async () => {
    const result = await run({
      label: "university-scope",
      message: "Add Waterloo Computer Science to my shortlist",
      toolName: "university_update",
      modelReplies: [JSON.stringify({
        schoolEngaged: true,
        universityEngaged: false,
        reply: "I treated it as a school course.",
        courseUpdates: [{
          courseRef: "new-1",
          name: "Waterloo Computer Science",
          platform: null,
          addFacts: [],
          resolveFactIds: [],
        }],
        completeActionIds: [],
        plan: [{
          courseRef: "new-1",
          localDate: "2026-09-17",
          sequenceRank: 1,
          text: "Review the course",
          estimatedMinutes: 25,
        }],
        programUpdates: [],
        applicationUpdates: [],
        workflowUpdates: [],
      })],
    });

    expect(result.reply).toContain("I couldn't validate that as a university update, so I didn't save it.");
    expect(JSON.parse(result.agent.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "not_saved",
      receiptId: null,
    });
    await expect(result.school.readSnapshot(result.principalId, "2026-09-17"))
      .resolves.toMatchObject({ courses: [] });
  });

  it("lets the agent choose study coach and preserves its guarded preference save and receipt", async () => {
    const result = await run({
      label: "study",
      message: "turn off coursework check-ins",
      toolName: "study_coach",
      modelReplies: [],
    });

    expect(result.reply).toBe("Coursework check-ins are off.");
    expect(JSON.parse(result.agent.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "completed",
      receiptId: "receipt:pipeline_call",
    });
    await expect(result.study.readSnapshot(result.principalId, "2026-09-17"))
      .resolves.toMatchObject({ preference: { enabled: false } });
    expect(result.baseModel.requests).toHaveLength(0);
  });

  if (channel === "voice") {
    it("refuses a voice pipeline save when its owner turn is not authoritative", async () => {
      const result = await run({
        label: "voice-not-authoritative",
        message: "Chemistry uses Classroom and titration calculations feel weak",
        toolName: "school_update",
        modelReplies: ["I did not save that."],
        ownerTurnAuthoritative: false,
      });

      expect(JSON.parse(result.agent.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
        status: "not_saved",
        receiptId: null,
      });
      await expect(result.school.readSnapshot(result.principalId, "2026-09-17"))
        .resolves.toMatchObject({ courses: [] });
    });
  }
});
