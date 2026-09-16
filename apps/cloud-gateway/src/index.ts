import { newUlid } from "../../../packages/contracts/src/index.js";
import { AutonomyRepository } from "./autonomy/autonomy-repository.js";
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
import { parseDecisionCallbackData } from "./decisions/telegram-keyboard.js";
import { assembleDigest, unconfiguredDeadlineSourceKinds } from "./jobs/digest-job.js";
import {
  CLASSROOM_SOURCE_ID,
  buildJobTable,
  buildScheduledRuns,
  runOnDemandBrightspaceRefresh,
} from "./jobs/job-table.js";
import { handleScheduled } from "./scheduler/scheduled-handler.js";
import { heartbeatConfiguration } from "./scheduler/heartbeat-reporter.js";
import { D1ContextRetriever } from "./conversation/context-retriever.js";
import { ConversationRepository } from "./conversation/conversation-repository.js";
import { DefaultConversationService } from "./conversation/conversation-service.js";
import {
  D1TelegramIdentityResolver,
  DefaultOutboxDispatcher,
} from "./conversation/outbox-dispatcher.js";
import type { Env } from "./env.js";
import { handleLiveness } from "./http/health.js";
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
import { DeepSeekModelAdapter } from "./providers/deepseek-provider.js";
import { ProviderCircuitBreaker } from "./providers/provider-circuit-breaker.js";
import { TelegramRestProvider, withTelegramTyping } from "./providers/telegram-provider.js";
import { Redactor } from "./security/redaction.js";
import { SchoolCatchupModelAdapter } from "./school/school-catchup-model.js";
import { SchoolCatchupRepository } from "./school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "./school/study-coach-model.js";
import { StudyCoachRepository } from "./school/study-coach-repository.js";
import { SchoolObservationRepository } from "./school/school-observation-repository.js";
import { UniversityTrackerRepository } from "./university/university-tracker-repository.js";
export { CallSession } from "./voice/call-session-do.js";

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

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
const providerCircuitBreaker = new ProviderCircuitBreaker();

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
  const telegram = new TelegramRestProvider({ botToken });
  try {
    await withTelegramTyping(telegram, accepted.chatId, async () => {
      const observer = new TelegramTurnObserver();
      // The delivery target is the channel identity, not the chat. Resolving it
      // here also re-confirms the identity is still active: authentication
      // happened when the message arrived, and this runs afterwards.
      const identity = await new DeviceRepository(env.DB).findActiveVerifiedTelegramIdentity(
        accepted.telegramUserId,
      );
      if (identity === null) return;

      const events = new EventRepository(env.DB);
      const repository = new ConversationRepository(env.DB, events);
      const redactor = new Redactor();
      const baseModel = observer.observeProvider(new DeepSeekModelAdapter({
        apiKey,
        model: env.DEEPSEEK_MODEL,
        telegramTurn: true,
        telegramThinking: env.DEEPSEEK_TELEGRAM_THINKING,
      }));
      const ownerPrincipalId = env.OWNER_PRINCIPAL_ID;
      const model = ownerPrincipalId !== undefined && accepted.principalId === ownerPrincipalId
        ? new StudyCoachModelAdapter({
          fallbackModel: new SchoolCatchupModelAdapter({
            model: baseModel,
            repository: new SchoolCatchupRepository(env.DB),
            universityRepository: new UniversityTrackerRepository(env.DB),
            redactor,
            timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
            ownerPrincipalId,
            ownerTurnAuthoritative: accepted.isDirectText,
            refreshBrightspace: async (now) => runOnDemandBrightspaceRefresh({
              env,
              clock: { now: () => new Date(now.getTime()) },
              delivery: { send: async () => undefined },
              fetcher: globalThis.fetch.bind(globalThis),
            }),
          }),
          practiceModel: baseModel,
          repository: new StudyCoachRepository(env.DB),
          redactor,
          ownerPrincipalId,
          ownerTurnAuthoritative: accepted.isDirectText,
          timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
        })
        : baseModel;

      const service = new DefaultConversationService({
        repository,
        model: observer.observeModel(model),
        context: observer.observeContext(new D1ContextRetriever(env.DB)),
        dispatcher: observer.observeDelivery(new DefaultOutboxDispatcher({
          repository,
          identityResolver: new D1TelegramIdentityResolver(env.DB),
          channels: new Map([["telegram", telegram]]),
          circuitBreaker: providerCircuitBreaker,
        })),
        redactor,
      });

      const result = await service.handleTurn({
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
      });

      console.log("telegram_turn_outcome", telegramTurnOutcomeLog(
        accepted.eventId,
        result.outcome,
        observer.snapshot(),
      ));
    });
  } catch {
    // Contained, not hidden: the inbound message is already archived, so this
    // is a delivery problem rather than data loss.
    console.error("telegram_reply_failed", {
      eventId: accepted.eventId,
      reason: "unexpected",
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
          claimStudyCheckIn: async (date, weekday, minuteOfDay) => {
            const study = new StudyCoachRepository(env.DB);
            const now = clock.now();
            return study.syncAndClaimDigestCheckIn({ principalId, today: date, weekday, minuteOfDay, now });
          },
          readDeadlines: async (withinDays) =>
            new DeadlineRepository(env.DB).listDueWithin({
              from: clock.now(),
              to: new Date(clock.now().getTime() + withinDays * 86_400_000),
            }),
          readDeadlineSources: async () => new DeadlineRepository(env.DB).listSources(),
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
        unconfiguredDeadlineSourceKinds: unconfiguredDeadlineSourceKinds(env),
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
async function answerFromTap(env: Env, tap: AcceptedTelegramButtonTap): Promise<void> {
  const send = telegramSender(env);
  const callback = parseDecisionCallbackData(tap.data);
  // Not ours, or malformed. Nothing to do and nothing to say -- a tap on a
  // stale keyboard is ordinary, not an error worth reporting.
  if (callback === null) return;

  try {
    const identity = await new DeviceRepository(env.DB).findActiveVerifiedTelegramIdentity(
      tap.telegramUserId,
    );
    if (identity === null) return;

    const result = await new DecisionService({
      repository: new DecisionRepository(env.DB),
    }).answer({
      decisionId: callback.decisionId,
      answeredByIdentityId: identity.identityId,
      optionKey: callback.optionKey,
    });

    if (send === null) return;
    // Every outcome gets an answer. A tap that produced silence is
    // indistinguishable from a bot that has stopped working.
    const message = result.outcome === "recorded"
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
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;
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
        redactor: new Redactor(),
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
    const send = telegramSender(env);
    const principalId = env.OWNER_PRINCIPAL_ID;

    const context = {
      env,
      clock,
      delivery: {
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
      },
      fetcher: globalThis.fetch.bind(globalThis),
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
