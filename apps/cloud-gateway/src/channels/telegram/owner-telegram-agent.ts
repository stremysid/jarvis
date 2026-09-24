/**
 * Telegram's half of the owner agent.
 *
 * The loop, the caps, the tier gate, the receipt guard and the nine memory
 * tools live in `src/agent/owner-agent-core.ts`, because at `d0ec419` they lived
 * here and the voice path could not reach any of them. What remains in this file
 * is what is genuinely Telegram's: the swipe-reply target check, the inline
 * keyboard a tier-3 confirmation is tapped with, the referral records that reach
 * the staged assistant event, and the school/university/study pipeline adapters.
 */

import { validateEnvelope, type Ulid } from "../../../../../packages/contracts/src/index.js";
import type { ArchiveBucket } from "../../archive/archival-service.js";import type { ToolAutonomyGateContract } from "../../autonomy/tool-gate.js";
import type { DecisionItem, RaiseDecisionInput } from "../../decisions/decision-types.js";
import { buildDecisionKeyboard } from "../../decisions/telegram-keyboard.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../../conversation/conversation-repository.js";
import {
  snapshotTelegramModelAdapterStreamInput,
  type ModelAdapter,
  type ModelAdapterStreamInput,
} from "../../model/model-adapter.js";
import { MEMORY_TOOL_DEFINITIONS } from "../../memory/memory-tools.js";
import { DEADLINE_TOOL_DEFINITION, recordDeadline } from "../../deadlines/deadline-tool.js";
import type { MeaningSearchReader } from "../../memory/meaning-search.js";
import { recordPendingTelegramMemoryReferences } from "../../memory/telegram-memory-reference.js";
import { readTelegramMemoryOwnerTurn } from "../../memory/telegram-memory-controls.js";
import type { MemoryControlIntent } from "../../memory/memory-types.js";
import type { TelegramMemoryTargetFinder } from "../../memory/memory-control-targets.js";
import type {
  ModelAgentProvider,
  ModelFunctionCall,
  ModelFunctionDefinition,
} from "../../providers/provider-types.js";
import {
  composeReceiptReply,
  OWNER_AGENT_SYSTEM_PROMPT,
  OWNER_TELEGRAM_AGENT_SYSTEM_PROMPT,
  ownerAgentSystemPrompt,
  ownerAgentTurnTimeoutMs,
  OwnerAgentCore,
  type OwnerAgentChannelPort,
} from "../../agent/owner-agent-core.js";
import { recordPendingTelegramReplyMarkup } from "./telegram-reply-markup.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const encoder = new TextEncoder();

export { OWNER_TELEGRAM_AGENT_SYSTEM_PROMPT, ownerAgentTurnTimeoutMs };

export const OWNER_TELEGRAM_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  ...MEMORY_TOOL_DEFINITIONS,
  DEADLINE_TOOL_DEFINITION,
  Object.freeze({
    name: "school_update",
    description: "Run the validated school catch-up pipeline for Sid's current message and conversation context, including missed classwork and finished work. Use deadline_record for a dated deadline, a missed deadline or an explicit submission; finished alone does not mean submitted.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
  Object.freeze({
    name: "university_update",
    description: "Run the validated university tracker pipeline for Sid's current message and conversation context.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
  Object.freeze({
    name: "study_coach",
    description: "Run the validated study-coach pipeline for Sid's current message and conversation context.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
]);

export interface OwnerTelegramAgentDependencies {
  readonly provider: ModelAgentProvider;
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  readonly ownerPrincipalId: string;
  readonly directOwnerText: boolean;
  /** Main's broader school/study authority: direct text in a private non-bot chat. */
  readonly directPipelineText?: boolean;
  readonly authorityText: string;
  readonly timeZone?: string;
  /** Telegram's durable pointer when Sid swipes on one of Jarvis's messages. */
  readonly replyToBotMessageId?: number | null;
  readonly targets: TelegramMemoryTargetFinder;
  readonly memorySearch?: MeaningSearchReader;
  readonly decisions: {
    raise(input: RaiseDecisionInput): Promise<DecisionItem>;
  };
  readonly autonomy: ToolAutonomyGateContract;
  readonly schoolModel: ModelAdapter;
  readonly universityModel: ModelAdapter;
  readonly studyCoachModel: ModelAdapter;
  /** Test seam and an explicit cap below Telegram's outer 90 second allowance. */
  readonly turnTimeoutMs?: number;
  /** Production webhook arrival anchor, recomputed when stream() actually starts. */
  readonly turnReceivedAt?: string;
  readonly now?: () => Date;
}

interface PreviousAssistantRow {
  readonly turn_id: unknown;
  readonly staged_event_id: unknown;
  readonly delivered_event_id: unknown;
  readonly delivered_envelope_json: unknown;
  readonly provider_message_id: unknown;
}

interface PreviousAssistantEvidence {
  readonly text: string;
  readonly providerMessageId: string;
}

function safeText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError("owner_agent_text_invalid");
  }
  return value;
}

function safeUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError("owner_agent_item_id_invalid");
  return value as Ulid;
}

export function ownerTelegramAgentSystemPrompt(
  coreProfile: string | null,
  coreProfileFailed: boolean,
): string {
  return ownerAgentSystemPrompt(OWNER_AGENT_SYSTEM_PROMPT, "", coreProfile, coreProfileFailed);
}

export class OwnerTelegramAgentAdapter extends OwnerAgentCore {
  constructor(private readonly telegram: OwnerTelegramAgentDependencies) {
    super(telegram, snapshotTelegramModelAdapterStreamInput);
    safeText(telegram.authorityText, 65_536);
    if (telegram.replyToBotMessageId !== undefined && telegram.replyToBotMessageId !== null
      && (!Number.isSafeInteger(telegram.replyToBotMessageId) || telegram.replyToBotMessageId <= 0)) {
      throw new TypeError("owner_agent_authority_invalid");
    }
  }

  protected port(input: Readonly<ModelAdapterStreamInput>): OwnerAgentChannelPort {
    const adapter = this;
    return Object.freeze({
      channelPrompt: `Owner time zone: ${adapter.telegram.timeZone ?? "America/Toronto"}. Message arrival: ${adapter.telegram.turnReceivedAt ?? (adapter.telegram.now?.() ?? new Date()).toISOString()}. Resolve deadline dates from this message, not a later processing time.`,
      toolDefinitions: OWNER_TELEGRAM_TOOL_DEFINITIONS,
      // Authority: this is Sid's direct current Telegram text, and nothing else.
      // A turn that fails this refuses before any tool body and before the tier
      // gate, so a steered or forwarded turn is not even audited as an action.
      canActOn: (): boolean => {
        if (input.channel !== "telegram" || input.principalId !== adapter.telegram.ownerPrincipalId
          || adapter.telegram.authorityText !== input.userText) return false;
        return true;
      },
      authorityRefusal:
        "I refused that tool call because this is not Sid's direct current Telegram text. Nothing changed.",
      memoryAuthorityRefusal:
        "I refused that memory tool call because this is not Sid's direct current Telegram text. Nothing changed.",
      pipelineAuthorityRefusal:
        "I refused that tool call because this is not Sid's direct private Telegram text. Nothing changed.",
      memoryOwnerTurn: (
        turnInput: Readonly<ModelAdapterStreamInput>,
        intent: MemoryControlIntent | null,
        allowNonDirectIngress?: boolean,
      ) => readTelegramMemoryOwnerTurn({
        database: adapter.telegram.database,
        modelInput: turnInput,
        memoryIntent: intent,
        ...(allowNonDirectIngress === true ? { requireDirectOwnerText: false } : {}),
      }),
      recordReferences: (turnId: Ulid, itemIds: readonly Ulid[]): void => {
        recordPendingTelegramMemoryReferences(turnId, itemIds);
      },
      recordDecision: (turnInput: Readonly<ModelAdapterStreamInput>, decision: DecisionItem): void => {
        recordPendingTelegramReplyMarkup(turnInput.correlationId, Object.freeze({
          decisionId: decision.decisionId as Ulid,
          replyMarkup: buildDecisionKeyboard(decision),
        }));
      },
      confirmationSurfaceRefusal: "",
      replyTargetsLatestAssistant: (turnInput: Readonly<ModelAdapterStreamInput>) =>
        adapter.replyTargetsLatestAssistant(turnInput),
      replyTargetRefusal:
        "I refused that memory tool call because the swipe reply does not target Jarvis's latest delivered message. Nothing changed.",
      pipelineModel: (call: ModelFunctionCall): ModelAdapter | null => {
        if (call.name === "school_update") return adapter.telegram.schoolModel;
        if (call.name === "university_update") return adapter.telegram.universityModel;
        if (call.name === "study_coach") return adapter.telegram.studyCoachModel;
        return null;
      },
      argumentTool: (call: ModelFunctionCall) => call.name === "deadline_record"
        ? async () => {
          const turn = await readTelegramMemoryOwnerTurn({ database: adapter.telegram.database, modelInput: input, memoryIntent: null });
          return recordDeadline(adapter.telegram.database, input, call, adapter.telegram.now?.() ?? new Date(),
            { ownerZone: adapter.telegram.timeZone ?? "America/Toronto", messageAt: turn.occurredAt });
        }
        : null,
      unknownToolRefusal: "I refused an unknown tool call. Nothing changed.",
      previousAssistantText: async (turnInput: Readonly<ModelAdapterStreamInput>) =>
        (await adapter.previousAssistant(turnInput))?.text ?? null,
      composeReply: composeReceiptReply,
    });
  }

  /**
   * Jarvis's own previous delivered message on this channel, for the two tools
   * that are grounded in what it actually said: `memory_remember` with
   * `evidenceClass: "confirmed"`, and `memory_confirm`.
   *
   * Scoped to `channel = 'telegram'` because a swipe reply is a Telegram
   * gesture and the provider message id it points at is Telegram's. The voice
   * adapter answers null here, which those tools turn into a refusal rather
   * than a guess.
   */
  private async previousAssistant(
    input: Readonly<ModelAdapterStreamInput>,
  ): Promise<PreviousAssistantEvidence | null> {
    const row = await this.telegram.database.prepare(`SELECT previous.turn_id,
        delivery.staged_event_id, previous.delivered_assistant_event_id AS delivered_event_id,
        delivered.envelope_json AS delivered_envelope_json,
        delivery.provider_message_id AS provider_message_id
      FROM conversation_turns current
      JOIN events current_user ON current_user.event_id = current.user_event_id
      JOIN conversation_turns previous
        ON previous.session_id = current.session_id AND previous.principal_id = current.principal_id
        AND previous.channel = 'telegram'
      JOIN events previous_user ON previous_user.event_id = previous.user_event_id
      JOIN conversation_deliveries delivery ON delivery.delivery_id = previous.staged_delivery_id
      JOIN events delivered ON delivered.event_id = previous.delivered_assistant_event_id
      WHERE current.turn_id = ? AND current.principal_id = ? AND current.channel = 'telegram'
        AND previous.state = 'delivered' AND previous_user.sequence < current_user.sequence
      ORDER BY previous_user.sequence DESC LIMIT 1`)
      .bind(input.correlationId, input.principalId).first<PreviousAssistantRow>();
    if (row === null || typeof row.delivered_envelope_json !== "string") return null;
    const turnId = safeUlid(row.turn_id);
    const stagedEventId = safeUlid(row.staged_event_id);
    const deliveredEventId = safeUlid(row.delivered_event_id);
    let decoded: unknown;
    try { decoded = JSON.parse(row.delivered_envelope_json) as unknown; }
    catch { throw new TypeError("owner_agent_previous_reply_invalid"); }
    const envelope = await validateEnvelope(decoded);
    if (envelope.eventId !== deliveredEventId || envelope.correlationId !== turnId
      || envelope.causationId !== stagedEventId || envelope.subjectId !== input.principalId
      || envelope.eventType !== "conversation.assistant_delivered"
      || envelope.source !== CONVERSATION_EVENT_SOURCE
      || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
      || envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
      throw new TypeError("owner_agent_previous_reply_invalid");
    }
    const payload = envelope.payload as Record<string, unknown>;
    if (payload.schemaCode !== 1 || payload.channelCode !== 2 || payload.sensitivityCode !== 1
      || payload.historyEligible !== true) throw new TypeError("owner_agent_previous_reply_invalid");
    return Object.freeze({
      text: safeText(payload.text, 65_536),
      providerMessageId: safeText(row.provider_message_id, 128),
    });
  }

  private async replyTargetsLatestAssistant(
    input: Readonly<ModelAdapterStreamInput>,
  ): Promise<boolean> {
    const target = this.telegram.replyToBotMessageId ?? null;
    if (target === null) return true;
    const previous = await this.previousAssistant(input);
    return previous !== null && previous.providerMessageId === String(target);
  }
}
