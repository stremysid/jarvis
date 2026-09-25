import { createOwnerPipelineModels } from "./agent/owner-pipelines.js";
import { newUlid, type Ulid } from "../../../packages/contracts/src/index.js";
import { AutonomyRepository } from "./autonomy/autonomy-repository.js";
import { AutonomyService } from "./autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "./autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "./autonomy/tool-gate.js";
import { runCommand, type CommandContext } from "./channels/telegram/command-handler.js";
import { COMMAND_HELP, parseCommand } from "./channels/telegram/telegram-commands.js";
import { D1TelegramOwnerStepUpCommands } from "./channels/telegram/telegram-owner-step-up-command.js";
import { TelegramRateLimiter } from "./channels/telegram/telegram-rate-limit.js";
import {
  handleTelegramWebhook,
  type AcceptedTelegramButtonTap,
  type AcceptedTelegramUpdate,
} from "./channels/telegram/telegram-webhook.js";
import {
  TelegramTurnObserver,
  telegramTurnOutcomeLog,
} from "./channels/telegram/telegram-turn-observability.js";
import { DeadlineRepository } from "./deadlines/deadline-repository.js";
import { ProjectRepository } from "./projects/project-repository.js";
import { QuietWindowService } from "./deadlines/quiet-windows.js";
import { DecisionRepository } from "./decisions/decision-repository.js";
import { DecisionService } from "./decisions/decision-service.js";
import type { AnswerDecisionResult, DecisionItem } from "./decisions/decision-types.js";
import { parseDecisionCallbackData } from "./decisions/telegram-keyboard.js";
import { assembleDigest, expectedPushSources, unconfiguredDeadlineSources } from "./jobs/digest-job.js";
import {
  CLASSROOM_SOURCE_ID,
  buildJobTable,
  buildScheduledRuns,
  runOnDemandBrightspaceRefresh,
} from "./jobs/job-table.js";
import { handleScheduled } from "./scheduler/scheduled-handler.js";
import { heartbeatConfiguration } from "./scheduler/heartbeat-reporter.js";
import { ConversationRepository } from "./conversation/conversation-repository.js";
import { DefaultConversationService } from "./conversation/conversation-service.js";
import type { ConversationDeliveryId } from "./conversation/conversation-types.js";
import {
  D1TelegramIdentityResolver,
  DefaultOutboxDispatcher,
} from "./conversation/outbox-dispatcher.js";
import type { Env } from "./env.js";
import { handleLiveness } from "./http/health.js";
import { handleCalendarFeedRequest } from "./http/calendar-feed-routes.js";
import { handleProductionVoiceRequest, requestProductionTelegramCall } from "./voice/production-routes.js";
import { handleSyncRequest, isSyncPath } from "./http/sync-routes.js";
import {
  handleOwnerPhoneEnrollmentRequest,
  isOwnerPhoneEnrollmentPath,
} from "./http/owner-phone-enrollment-routes.js";
import {
  handleOwnerPassphraseRequest,
  isOwnerPassphrasePath,
} from "./http/owner-passphrase-routes.js";
import { DeviceRepository } from "./persistence/device-repository.js";
import { EventRepository } from "./persistence/event-repository.js";
import { PolicyService } from "./policy/policy-service.js";
import { DeepSeekAgentProvider, DeepSeekJsonProvider, DeepSeekModelAdapter } from "./providers/deepseek-provider.js";
import { ProviderCircuitBreaker } from "./providers/provider-circuit-breaker.js";
import { TelegramRestProvider, withTelegramTyping } from "./providers/telegram-provider.js";
import { Redactor } from "./security/redaction.js";
import type { ModelAdapter } from "./model/model-types.js";
import { TelegramMemoryRetriever } from "./memory/telegram-memory-retriever.js";
import {
  MemoryMeaningService,
  VectorizeMemoryVectorStore,
  WorkersAiMemoryEmbeddingProvider,
  readMemoryMeaningCoverage,
} from "./memory/meaning-search.js";
import { MemoryExtractionBudget } from "./memory/memory-extraction-budget.js";
import { MemoryOwnerControlsService } from "./memory/memory-owner-controls.js";
import { SchoolCatchupRepository } from "./school/school-catchup-repository.js";
import { StudyCoachRepository } from "./school/study-coach-repository.js";
import { SchoolObservationRepository } from "./school/school-observation-repository.js";
import { SchoolCollectorRepository } from "./school/collector-repository.js";
import { SchoolCollectorPairing } from "./school/collector-pairing.js";
import { SCHOOL_PAIR_ORIGIN } from "./school/collector-protocol.js";
import { handleSchoolRequest, isSchoolPath } from "./http/school-routes.js";
import { handleD2lNotificationEmail } from "./school/d2l-email-handler.js";
import { UniversityTrackerRepository } from "./university/university-tracker-repository.js";
import { OwnerTelegramAgentAdapter } from "./channels/telegram/owner-telegram-agent.js";
export { ownerAgentTurnTimeoutMs } from "./channels/telegram/owner-telegram-agent.js";
export { CallSession } from "./voice/call-session-do.js";

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

export function ownerTelegramToolAuthority(accepted: Pick<
  AcceptedTelegramUpdate,
  "isDirectText" | "isPrivateHumanText" | "isMemoryControlAuthoritative"
>): Readonly<{ directOwnerText: boolean; directPipelineText: boolean }> {
  return Object.freeze({
    directOwnerText: accepted.isMemoryControlAuthoritative,
    directPipelineText: accepted.isDirectText && accepted.isPrivateHumanText,
  });
}

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
}

function unavailable(): Response {
  return new Response("Channel not configured", { status: 503 });
}

/**
 * Module scope, so state survives between requests in one isolate.
 *
 * Per-isolate, not global: Cloudflare may run several isolates for one Worker,
 * so rate limiting is weaker than configured and the circuit breaker sees only
 * one isolate's failures. Both belong in a Durable Object -- the mechanism
 * already used for call sessions -- before either becomes load-bearing.
 */
const telegramLimiter = new TelegramRateLimiter();
// Separate allowance: monitoring traffic must never consume Telegram admission.
const livenessLimiter = new TelegramRateLimiter(30, 43_200);
const calendarLimiter = new TelegramRateLimiter(30, 43_200);
const providerCircuitBreaker = new ProviderCircuitBreaker();

export function buildTelegramConversationRepository(
  database: D1Database,
  events: EventRepository,
  accepted: Pick<
    AcceptedTelegramUpdate,
    "principalId" | "isDirectText" | "isMemoryControlAuthoritative"
  >,
  ownerPrincipalId: string | undefined,
): ConversationRepository {
  return new ConversationRepository(database, events, {
    telegramDirectOwnerText: ownerPrincipalId !== undefined
      && accepted.principalId === ownerPrincipalId
      && accepted.isDirectText
      && accepted.isMemoryControlAuthoritative,
  });
}

/**
 * The reader for one Telegram turn: Sid's only when the authenticated principal
 * is the configured owner. A verified guest identity also reaches `replyTo`, and
 * Sid's reader would store the guest's raw PIN and let a labelled credential
 * through to the guest's reply.
 */
export function telegramTurnRedactor(principalId: string, ownerPrincipalId: string | undefined): Redactor {
  return new Redactor(ownerPrincipalId !== undefined && principalId === ownerPrincipalId ? "owner" : "external");
}

export type TelegramReplyFailureReason = "identity_lookup" | "conversation" | "dispatcher" | "other";

export class TelegramReplyFailure extends Error {
  constructor(readonly reason: Exclude<TelegramReplyFailureReason, "other">) {
    super("telegram_reply_failed");
    this.name = "TelegramReplyFailure";
  }
}

export function telegramReplyFailureReason(error: unknown): TelegramReplyFailureReason {
  return error instanceof TelegramReplyFailure ? error.reason : "other";
}

async function telegramReplyStage<T>(
  reason: Exclude<TelegramReplyFailureReason, "other">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TelegramReplyFailure) throw error;
    throw new TelegramReplyFailure(reason);
  }
}

function telegramReplyStageSync<T>(
  reason: Exclude<TelegramReplyFailureReason, "other">,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TelegramReplyFailure) throw error;
    throw new TelegramReplyFailure(reason);
  }
}

function isVoicePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/voice" || pathname.startsWith("/voice/");
}

/**
 * Answer an accepted message through the conversation service.
 *
 * The service owns the entire turn: it commits the user event, claims the
 * turn, streams the model, stages the assistant delivery and dispatches it.
 * That matters because the database enforces those transitions with triggers
 * -- a delivery cannot be recorded without the staging that proves it
 * happened. Writing those events directly, as an earlier version did, aborts
 * the transaction and takes the reply down with it.
 *
 * Runs under ctx.waitUntil, after the webhook has already returned 200, so a
 * slow model cannot cause Telegram to time out and redeliver.
 */
async function replyTo(env: Env, accepted: AcceptedTelegramUpdate): Promise<void> {
  const apiKey = env.DEEPSEEK_API_KEY;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (apiKey === undefined || botToken === undefined) return;

  const controller = new AbortController();
  const webhookReceivedAt = Date.parse(accepted.receivedAt);
  try {
    const telegram = new TelegramRestProvider({ botToken });
    await withTelegramTyping(telegram, accepted.chatId, async () => {
      const observer = new TelegramTurnObserver();
      // The delivery target is the channel identity, not the chat. Resolving it
      // here also re-confirms the identity is still active: authentication
      // happened when the message arrived, and this runs afterwards.
      const identity = await telegramReplyStage(
        "identity_lookup",
        () => new DeviceRepository(env.DB).findActiveVerifiedTelegramIdentity(accepted.telegramUserId),
      );
      if (identity === null) return;

      const events = new EventRepository(env.DB);
      const ownerPrincipalId = env.OWNER_PRINCIPAL_ID;
      const repository = buildTelegramConversationRepository(
        env.DB,
        events,
        accepted,
        ownerPrincipalId,
      );
      const toolAuthority = ownerTelegramToolAuthority(accepted);
      const redactor = telegramTurnRedactor(accepted.principalId, ownerPrincipalId);
      const baseModel = observer.observeProvider(new DeepSeekModelAdapter({
        apiKey,
        model: env.DEEPSEEK_MODEL,
        telegramTurn: true,
        telegramThinking: env.DEEPSEEK_TELEGRAM_THINKING,
      }));
      // One reader, two callers: the automatic retrieval path and the explicit
      // `memory_search` tool. They differ in their gates, not in how they reach
      // the index, and two instances would be two places to configure a model.
      const meaningSearch = env.AI === undefined || env.MEMORY_VECTORS === undefined
        ? undefined
        : new MemoryMeaningService({
          database: env.DB,
          embeddings: new WorkersAiMemoryEmbeddingProvider(env.AI),
          vectors: new VectorizeMemoryVectorStore(env.MEMORY_VECTORS),
        });
      const memory = new TelegramMemoryRetriever({
        database: env.DB,
        archive: env.ARCHIVE,
        meaningSearch,
        observeMeaningSearch: (observation) => observer.recordMeaningSearch(observation),
        observeRetrieval: (metrics) => observer.observeMemoryRetrieval(metrics),
      });
      let model: ModelAdapter = baseModel;
      if (ownerPrincipalId !== undefined && accepted.principalId === ownerPrincipalId) {
        const pipelines = createOwnerPipelineModels(env, baseModel, redactor, ownerPrincipalId, toolAuthority.directPipelineText);
        model = new OwnerTelegramAgentAdapter({
          guidedAssignmentTelegram: telegram,
          provider: new DeepSeekAgentProvider({
            apiKey,
            model: env.DEEPSEEK_MODEL,
            telegramTurn: true,
            telegramThinking: "disabled",
          }),
          database: env.DB,
          archive: env.ARCHIVE,
          ownerPrincipalId,
          directOwnerText: toolAuthority.directOwnerText,
          directPipelineText: toolAuthority.directPipelineText,
          authorityText: accepted.text,
          replyToBotMessageId: accepted.replyToBotMessageId,
          targets: memory,
          memorySearch: meaningSearch,
          decisions: new DecisionService({ repository: new DecisionRepository(env.DB) }),
          // The capability gate. Constructed here so every owner tool call is
          // classified against the database tiers before it acts, which is what
          // makes the backstop the README advertises a thing that runs.
          autonomy: new ToolAutonomyGate(
            new AutonomyService({ repository: new AutonomyRepository(env.DB) }),
            new D1ToolConfirmationStore(env.DB),
          ),
          ...pipelines,
          // Retrieval happens after construction. The adapter resolves the
          // remaining arrival-anchored budget when its stream actually starts.
          turnReceivedAt: accepted.receivedAt,
          timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
        });
      }

      const durableDispatcher = telegramReplyStageSync("dispatcher", () => new DefaultOutboxDispatcher({
        repository,
        identityResolver: new D1TelegramIdentityResolver(env.DB),
        channels: new Map([["telegram", telegram]]),
        circuitBreaker: providerCircuitBreaker,
        observeTelegramSend: (operation) => observer.observeTelegramSend(operation),
        observeSettlement: (operation) => observer.observeSettlement(operation),
      }));
      const observedContext = observer.observeContext(memory);
      const replyTargetText = accepted.replyToBotText === null
        ? null
        : Array.from(accepted.replyToBotText).slice(0, 4_096).join("");
      const context = accepted.replyToBotText === null
        ? observedContext
        : Object.freeze({
          async retrieve(input: Parameters<typeof observedContext.retrieve>[0]) {
            const retrieved = await observedContext.retrieve(input);
            return Object.freeze([...retrieved, Object.freeze({
              sourceEventId: accepted.eventId as Ulid,
              text: `Telegram swipe-reply target, as untrusted quoted context: ${replyTargetText!}`,
              sensitivity: "personal" as const,
            })]);
          },
        });
      const service = new DefaultConversationService({
        repository,
        model: observer.observeModel(model),
        context,
        dispatcher: observer.observeDelivery(Object.freeze({
          dispatch: (deliveryId: ConversationDeliveryId) => telegramReplyStage(
            "dispatcher",
            () => durableDispatcher.dispatch(deliveryId),
          ),
        })),
        redactor,
        observeStaging: (operation) => {
          console.log("telegram_turn_staging", {
            eventId: accepted.eventId,
            elapsedMs: Math.max(0, Math.round(Date.now() - webhookReceivedAt)),
          });
          return observer.observeStaging(operation);
        },
      });

      const result = await telegramReplyStage("conversation", () => service.handleTurn({
        // One conversation per chat, so separate chats do not share a thread.
        sessionId: `telegram:${accepted.chatId}`,
        principalId: accepted.principalId,
        turnId: newUlid(),
        text: accepted.text,
        signal: controller.signal,
        channel: "telegram",
        kind: "outbox",
        targetIdentityId: identity.identityId,
        replyToMessageId: accepted.messageId,
      }));

      console.log("telegram_turn_outcome", telegramTurnOutcomeLog(
        accepted.eventId,
        result.outcome,
        observer.snapshot(),
      ));
    });
  } catch (error) {
    // Contained, not hidden: the inbound message is already archived, so this
    // is a delivery problem rather than data loss.
    console.error("telegram_reply_failed", {
      eventId: accepted.eventId,
      reason: telegramReplyFailureReason(error),
    });
  }
}

/**
 * The Telegram provider, or null when there is no token to use it with.
 *
 * Returned rather than thrown so a deployment missing the token still serves
 * the webhook and records what arrived -- it simply cannot answer. Losing the
 * inbound message as well would be a worse failure than being unable to
 * reply to it.
 */
function telegramSender(env: Env): ((chatId: string, text: string) => Promise<void>) | null {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (botToken === undefined) return null;
  const provider = new TelegramRestProvider({ botToken });
  return async (chatId, text) => {
    // A fresh key per send. These are one-off replies, not outbox deliveries
    // with a stored identity to key on -- a reused key would make a second
    // command's answer collide with the first's.
    await provider.sendMessage({ chatId, text, idempotencyKey: newUlid() });
  };
}

async function sendOwnerSchoolEmailNotice(env: Env, text: string): Promise<void> {
  const principalId = env.OWNER_PRINCIPAL_ID;
  const send = telegramSender(env);
  if (principalId === undefined || principalId.length === 0 || send === null) {
    throw new Error("school_email_owner_notice_unavailable");
  }
  const chatId = await new DeviceRepository(env.DB).findOwnerTelegramChat(principalId);
  if (chatId === null) throw new Error("school_email_owner_notice_unavailable");
  await send(chatId, text);
}

/** What the command handlers are allowed to reach. */
function commandContext(env: Env, principalId: string): CommandContext {
  const clock = { now: () => new Date() };
  const deadlines = new DeadlineRepository(env.DB);
  const quiet = new QuietWindowService({ repository: deadlines, now: () => clock.now() });
  return {
    principalId,
    autonomy: new AutonomyRepository(env.DB),
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => clock.now() }),
    scheduler: buildScheduledRuns({
      env,
      clock,
      delivery: { send: async () => undefined },
      fetcher: globalThis.fetch.bind(globalThis),
    }),
    memoryMeaningCoverage: {
      read: () => readMemoryMeaningCoverage(env.DB, principalId, clock.now()),
    },
    quietWindows: {
      // Adapted rather than passed through: the service answers "is this
      // suppressed", and the command needs to open and close a window. Both
      // reach the same table.
      open: async (reason, from, to) => {
        void quiet;
        await deadlines.createQuietWindow({ reason, startsAt: from, endsAt: to, now: from });
      },
      closeManual: async (at) => {
        const open = await deadlines.listQuietWindows({ from: at, to: at });
        let closed = 0;
        for (const window of open) {
          // Only the ones a person opened. An exam window is derived from a
          // deadline and comes back on the next sweep, so cancelling it here
          // would look like it did nothing.
          if (window.reason !== "manual") continue;
          if (await deadlines.cancelQuietWindow(window.windowId, at)) closed += 1;
        }
        return closed;
      },
    },
    // The digest is assembled but NOT sent here: /digest answers in the chat
    // the owner typed it in, and sending it separately would deliver it twice.
    runDigestNow: async () => {
      const digest = await assembleDigest("daily", {
        sources: {
          readCatchupActions: async (date) =>
            new SchoolCatchupRepository(env.DB).listActionsForDate(principalId, date),
          readApplicationItems: async () =>
            new UniversityTrackerRepository(env.DB).listApplicationItemsByDueDate(principalId),
          readWorkflowItems: async () =>
            new UniversityTrackerRepository(env.DB).listWorkflowItemsByDueDate(principalId),
          claimStudyCheckIn: async (date, weekday, minuteOfDay) => {
            const study = new StudyCoachRepository(env.DB);
            const now = clock.now();
            const [schoolSignals, deadlineSignals] = await Promise.all([
              new SchoolObservationRepository(env.DB).readStudySnapshot({ principalId, now }),
              new DeadlineRepository(env.DB).listStudyCandidates(now),
            ]);
            return study.syncAndClaimDigestCheckIn({
              principalId, today: date, weekday, minuteOfDay, now,
              signalInputs: { observations: schoolSignals, deadlines: deadlineSignals },
            });
          },
          readDeadlines: async (withinDays) =>
            new DeadlineRepository(env.DB).listDueWithin({
              from: clock.now(),
              to: new Date(clock.now().getTime() + withinDays * 86_400_000),
            }),
          readDeadlineSources: async () => new DeadlineRepository(env.DB).listSources(),
          readD2lStatus: () => new SchoolCollectorRepository(env.DB, principalId, () => clock.now()).status({ limit: 1 }),
          readSchoolObservations: async () => {
            const now = new Date(clock.now().getTime());
            return new SchoolObservationRepository(env.DB).readDigestSnapshot({
              principalId,
              sourceId: CLASSROOM_SOURCE_ID,
              changedSince: new Date(now.getTime() - 7 * 86_400_000),
              now,
            });
          },
          readProjectStatuses: async () => new ProjectRepository(env.DB).readActiveProjectStatuses(),
          readOpenDecisions: async () =>
            new DecisionService({ repository: new DecisionRepository(env.DB) }).queue(principalId),
        },
        delivery: { send: async () => undefined },
        clock,
        timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
        unconfiguredDeadlineSources: unconfiguredDeadlineSources(env),
        expectedPushSources: expectedPushSources(env),
      });
      return digest.text;
    },
    now: () => clock.now(),
  };
}

/**
 * Answer a slash command.
 *
 * Runs instead of the model, not before it: a command that reached DeepSeek
 * would come back as a confident paragraph about a thing that did not happen.
 */
async function runTelegramCommand(
  env: Env,
  accepted: AcceptedTelegramUpdate,
  name: Parameters<typeof runCommand>[0],
  argument: string,
): Promise<void> {
  const send = telegramSender(env);
  if (send === null) return;
  const context = commandContext(env, accepted.principalId);
  const ownerPrincipalId = env.OWNER_PRINCIPAL_ID;
  const replies = await runCommand(name, argument,
    name === "call"
      ? { ...context, calls: { request: () => requestProductionTelegramCall(env, accepted) } }
      : name === "disable-owner-step-up" && ownerPrincipalId !== undefined
        ? { ...context, ownerStepUp: { disable: () => new D1TelegramOwnerStepUpCommands({
          database: env.DB,
          ownerPrincipalId,
          ownerVoiceIdentityId: env.OWNER_VOICE_IDENTITY_ID,
        }).disable(accepted) } }
        : context);
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB) });
  const replyChatId = name === "disable-owner-step-up" && accepted.chatId !== accepted.telegramUserId
    ? accepted.telegramUserId
    : accepted.chatId;
  for (const reply of replies) {
    await send(replyChatId, reply.text);
    // Recorded only after the send succeeded. Marking delivery first would
    // let a failed send leave a question the owner never saw but which the
    // system believes it asked.
    if (reply.decisionId !== undefined) await decisions.markDelivered(reply.decisionId);
  }
}

/**
 * Resolve a decision from a button tap.
 *
 * The identity is resolved again here rather than trusted from the tap. The
 * webhook authenticated the Telegram user; what writes the response row is
 * the channel identity, and the decision service checks that identity against
 * the principal that owns the question.
 */
export function confirmedTelegramForgetRoute(
  result: AnswerDecisionResult,
  identityId: string,
  principalId: string,
  standingItem: DecisionItem | null,
): Readonly<{ decisionId: string; originReference: string }> | null {
  if (result.outcome === "recorded") {
    return result.routing.origin === "telegram-memory-forget"
      && result.routing.optionKey === "confirm"
      && result.routing.originReference !== null
      ? Object.freeze({
        decisionId: result.routing.decisionId,
        originReference: result.routing.originReference,
      })
      : null;
  }
  return result.outcome === "already_answered"
    && result.standing.optionKey === "confirm"
    && result.standing.answeredByIdentityId === identityId
    && standingItem !== null
    && standingItem.principalId === principalId
    && standingItem.status === "answered"
    && standingItem.origin === "telegram-memory-forget"
    && standingItem.originReference !== null
    ? Object.freeze({ decisionId: standingItem.decisionId, originReference: standingItem.originReference })
    : null;
}

export function confirmedTelegramMemoryRoute(
  result: AnswerDecisionResult,
  identityId: string,
  principalId: string,
  standingItem: DecisionItem | null,
): Readonly<{ decisionId: string; originReference: string }> | null {
  if (result.outcome === "recorded") {
    return result.routing.origin === "telegram-memory-confirm"
      && result.routing.optionKey === "confirm"
      && result.routing.answeredByIdentityId === identityId
      && result.routing.originReference !== null
      ? Object.freeze({
        decisionId: result.routing.decisionId,
        originReference: result.routing.originReference,
      })
      : null;
  }
  return result.outcome === "already_answered"
    && result.standing.optionKey === "confirm"
    && result.standing.answeredByIdentityId === identityId
    && standingItem !== null
    && standingItem.principalId === principalId
    && standingItem.status === "answered"
    && standingItem.origin === "telegram-memory-confirm"
    && standingItem.originReference !== null
    ? Object.freeze({ decisionId: standingItem.decisionId, originReference: standingItem.originReference })
    : null;
}

export async function answerFromTap(
  env: Env,
  tap: AcceptedTelegramButtonTap,
  sendOverride?: ((chatId: string, text: string) => Promise<void>) | null,
): Promise<void> {
  const send = sendOverride === undefined ? telegramSender(env) : sendOverride;
  const callback = parseDecisionCallbackData(tap.data);
  // Not ours, or malformed. Nothing to do and nothing to say -- a tap on a
  // stale keyboard is ordinary, not an error worth reporting.
  if (callback === null) return;

  try {
    const identity = await new DeviceRepository(env.DB).findActiveVerifiedTelegramIdentity(
      tap.telegramUserId,
    );
    if (identity === null) return;

    const decisionRepository = new DecisionRepository(env.DB);
    const result = await new DecisionService({ repository: decisionRepository }).answer({
      decisionId: callback.decisionId,
      answeredByIdentityId: identity.identityId,
      optionKey: callback.optionKey,
    });

    let confirmedForgetReceipts: readonly string[] = Object.freeze([]);
    let confirmedMemoryReceipts: readonly string[] = Object.freeze([]);
    const standingItem = result.outcome === "already_answered"
      && result.standing.optionKey === "confirm"
      && result.standing.answeredByIdentityId === identity.identityId
      ? await decisionRepository.readItem(callback.decisionId)
      : null;
    const schoolPair = result.outcome === "recorded" ? result.routing.origin === SCHOOL_PAIR_ORIGIN
      : standingItem?.origin === SCHOOL_PAIR_ORIGIN;
    if (schoolPair && env.OWNER_PRINCIPAL_ID === tap.principalId) {
      const activated = await new SchoolCollectorPairing(env.DB, tap.principalId, () => new Date())
        .activateFromDecision(callback.decisionId, identity.identityId);
      if (send !== null) await send(tap.chatId, activated ? "School collector activated." : "No collector was activated by this tap.");
      return;
    }
    const forget = confirmedTelegramForgetRoute(result, identity.identityId, tap.principalId, standingItem);
    if (forget !== null) {
      const itemIds = forget.originReference.split(",");
      if (itemIds.length < 2 || itemIds.length > 8) throw new Error("telegram_memory_forget_decision_invalid");
      const receipts = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forgetConfirmedDecision({
        principalId: tap.principalId,
        callbackEventId: tap.eventId as ReturnType<typeof newUlid>,
        decisionId: forget.decisionId as ReturnType<typeof newUlid>,
        itemIds: itemIds as ReturnType<typeof newUlid>[],
      });
      confirmedForgetReceipts = Object.freeze(receipts.map((receipt) => receipt.receipt));
    }
    const memory = confirmedTelegramMemoryRoute(result, identity.identityId, tap.principalId, standingItem);
    if (memory !== null) {
      const reference = memory.originReference.split(":");
      if (reference.length !== 2) throw new Error("telegram_memory_confirm_decision_invalid");
      const [itemId, previousVersionId] = reference;
      if (itemId === undefined || previousVersionId === undefined) {
        throw new Error("telegram_memory_confirm_decision_invalid");
      }
      const receipt = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).confirmInferredFromDecision({
        principalId: tap.principalId,
        callbackEventId: tap.eventId as Ulid,
        decisionId: memory.decisionId as Ulid,
        itemId: itemId as Ulid,
        previousVersionId: previousVersionId as Ulid,
      });
      confirmedMemoryReceipts = Object.freeze([
        `${receipt.receipt} Memory: ${JSON.stringify(receipt.item.version.text)}`,
      ]);
    }

    if (send === null) return;
    // Every outcome gets an answer. A tap that produced silence is
    // indistinguishable from a bot that has stopped working.
    const message = confirmedMemoryReceipts.length > 0
      ? confirmedMemoryReceipts.join("\n\n")
      : confirmedForgetReceipts.length > 0
        ? confirmedForgetReceipts.join("\n\n")
        : result.outcome === "recorded"
          ? "Got it."
          : result.outcome === "already_answered"
            ? "That one is already answered."
            : result.outcome === "not_owner"
              ? "That question is not yours to answer."
              : "That question is no longer open.";
    await send(tap.chatId, message);
  } catch (error) {
    console.error("telegram_callback_failed", {
      eventId: tap.eventId,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (send !== null) {
      try {
        await send(tap.chatId, "I couldn't finish that confirmed memory change. Tap Confirm again to retry safely.");
      } catch (sendError) {
        console.error("telegram_callback_failure_reply_failed", {
          eventId: tap.eventId,
          reason: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
    }
  }
}

export default {
  async email(message, env, ctx): Promise<void> {
    await handleD2lNotificationEmail(message, env, {
      sendOwnerText: (text) => sendOwnerSchoolEmailNotice(env, text),
    });
    void ctx;
  },

  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (/^\/calendar(?:\/|$)/u.test(pathname)) {
      return handleCalendarFeedRequest(request, env, {
        clock: () => new Date(),
        rateLimiter: { allow: () => calendarLimiter.admit("calendar", Date.now()).allowed },
      });
    }
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
      }
      // Process liveness only. No database probes or private readiness snapshot.
      const response = await handleLiveness({
        rateLimiter: { allow: () => livenessLimiter.admit("liveness", Date.now()).allowed },
        availability: "available",
      });
      return request.method === "HEAD" ? new Response(null, response) : response;
    }

    if (pathname === TELEGRAM_WEBHOOK_PATH) {
      const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
      // Refuse rather than fall through: an empty secret would compare equal
      // to an absent header, authenticating anyone.
      if (webhookSecret === undefined || webhookSecret.length === 0) return unavailable();
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      return handleTelegramWebhook(request, {
        webhookSecret,
        policy: new PolicyService(new DeviceRepository(env.DB)),
        // The reader is the authenticated principal, not the channel: any
        // active verified Telegram identity passes, so only the configured
        // owner gets Sid's reader and everyone else the external one.
        redactor: new Redactor("external"),
        ...(env.OWNER_PRINCIPAL_ID === undefined || env.OWNER_PRINCIPAL_ID.length === 0
          ? {}
          : { owner: { principalId: env.OWNER_PRINCIPAL_ID, redactor: new Redactor("owner") } }),
        events: new EventRepository(env.DB),
        limiter: telegramLimiter,
        onAccepted: (accepted) => {
          // The split happens here, before any model call. A command must not
          // reach DeepSeek and come back as prose about a thing that did not
          // happen.
          const parsed = parseCommand(accepted.text, env.TELEGRAM_BOT_USERNAME ?? null);
          if (parsed.kind === "command") {
            ctx.waitUntil(runTelegramCommand(env, accepted, parsed.name, parsed.argument));
            return;
          }
          if (parsed.kind === "unknown_command") {
            const send = telegramSender(env);
            if (send !== null) {
              ctx.waitUntil(send(accepted.chatId, `No such command.

${COMMAND_HELP}`));
            }
            return;
          }
          ctx.waitUntil(replyTo(env, accepted));
        },
        onCallback: (tap) => ctx.waitUntil(answerFromTap(env, tap)),
      });
    }

    // Device-signed; authentication is the signature, not the path.
    if (isOwnerPhoneEnrollmentPath(pathname)) return handleOwnerPhoneEnrollmentRequest(request, env);
    if (isOwnerPassphrasePath(pathname)) return handleOwnerPassphraseRequest(request, env);
    if (isSyncPath(pathname)) return handleSyncRequest(request, env);
    if (isSchoolPath(pathname)) return handleSchoolRequest(request, env);

    if (isVoicePath(request)) return handleProductionVoiceRequest(request, env);
    return notImplemented();
  },
  /**
   * Cron. Four expressions, routed in `cron-router.ts`.
   *
   * Awaited rather than run under waitUntil: a scheduled invocation's whole
   * purpose is the work, and returning early would let the platform tear the
   * isolate down mid-job. The handler already contains every failure, so
   * awaiting it cannot make the invocation throw.
   */
  async scheduled(controller, env, ctx): Promise<void> {
    const clock = { now: () => new Date(controller.scheduledTime) };
    const liveClock = { now: () => new Date() };
    const send = telegramSender(env);
    const principalId = env.OWNER_PRINCIPAL_ID;
    const delivery = {
      send: async (text: string) => {
        // No sender and no owner means no way to deliver. Raising here
        // records it as a job failure rather than reporting a digest that
        // went nowhere as sent.
        if (send === null) throw new Error("TELEGRAM_BOT_TOKEN is not set");
        if (principalId === undefined) throw new Error("OWNER_PRINCIPAL_ID is not set");
        const identity = await new DeviceRepository(env.DB).findOwnerTelegramChat(principalId);
        if (identity === null) throw new Error("no verified Telegram identity for the owner");
        await send(identity, text);
      },
    };
    const fetcher = globalThis.fetch.bind(globalThis);
    const extractionModel = env.MEMORY_EXTRACTION_MODEL?.trim()
      || env.DEEPSEEK_MODEL?.trim()
      || "deepseek-flash";
    const memoryDistillationFactory = env.DEEPSEEK_API_KEY !== undefined && env.DEEPSEEK_API_KEY.length > 0
      && principalId !== undefined && principalId.length > 0
      ? () => {
        const extractionBudget = new MemoryExtractionBudget({
          database: env.DB,
          modelId: extractionModel,
          monthlyCapUsd: env.MEMORY_EXTRACTION_MONTHLY_CAP_USD,
          now: liveClock.now,
          notice: delivery,
        });
        return {
          provider: new DeepSeekJsonProvider({
            apiKey: env.DEEPSEEK_API_KEY!,
            model: extractionModel,
            budget: extractionBudget,
            fetchImplementation: fetcher,
          }),
          providerModelId: extractionBudget.providerModelId,
          prepare: (ownerPrincipalId: string) => extractionBudget.prepare(ownerPrincipalId),
        };
      }
      : undefined;
    const memoryConsolidationFactory = env.DEEPSEEK_API_KEY !== undefined
      && env.DEEPSEEK_API_KEY.length > 0 && principalId !== undefined && principalId.length > 0
      ? () => {
        const extractionBudget = new MemoryExtractionBudget({
          database: env.DB,
          modelId: "deepseek-flash",
          monthlyCapUsd: env.MEMORY_EXTRACTION_MONTHLY_CAP_USD,
          now: liveClock.now,
          notice: delivery,
        });
        return {
          provider: new DeepSeekJsonProvider({
            apiKey: env.DEEPSEEK_API_KEY!,
            model: "deepseek-flash",
            budget: extractionBudget,
            fetchImplementation: fetcher,
          }),
          providerModelId: extractionBudget.providerModelId,
          prepare: (ownerPrincipalId: string) => extractionBudget.prepare(ownerPrincipalId),
        };
      }
      : undefined;
    const context = {
      env,
      clock,
      liveClock,
      delivery,
      fetcher,
      memoryDistillationFactory,
      memoryConsolidationFactory,
    };

    const report = await handleScheduled(controller.cron, clock.now(), {
      runs: buildScheduledRuns(context),
      jobs: buildJobTable(context),
      timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
      heartbeat: heartbeatConfiguration(env.WATCHDOG_HEARTBEAT_URL, env.WATCHDOG_HEARTBEAT_SECRET),
      fetcher: context.fetcher,
    });

    // Logged unconditionally. A cron that silently did nothing and one that
    // silently succeeded look identical in the dashboard, and the difference
    // is the whole question when a digest fails to arrive.
    console.log("scheduled", {
      cron: report.cron,
      jobs: report.jobs,
      heartbeat: report.heartbeat,
    });
    void ctx;
  },
} satisfies ExportedHandler<Env>;
