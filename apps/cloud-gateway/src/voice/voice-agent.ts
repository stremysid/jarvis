/**
 * Voice's half of the owner agent.
 *
 * A phone call could not call a tool at all at `d0ec419`: `ModelAdapterStreamInput`
 * has no `tools` field, so `DeepSeekModelAdapter` had nowhere to put one and
 * `src/voice/production-runtime.ts` composed it bare. The tool-calling loop was
 * already inside a `ModelAdapter` on Telegram, so this is the same design
 * applied once more rather than a new seam -- the argument is recorded in
 * `DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"*.
 *
 * What is voice's own is here and nothing else: the authority is the owner
 * principal on the call session rather than Sid's current Telegram text, a
 * confirmation has no keyboard to be tapped with, and the reply is spoken.
 */

import { validateEnvelope, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { ArchiveBucket } from "../archive/archival-service.js";
import type { ToolAutonomyGateContract } from "../autonomy/tool-gate.js";
import type { DecisionItem, RaiseDecisionInput } from "../decisions/decision-types.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import { snapshotModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelAdapter, ModelAdapterStreamInput } from "../model/model-adapter.js";
import { MEMORY_TOOL_DEFINITIONS } from "../memory/memory-tools.js";
import { OWNER_ARGUMENT_TOOL_DEFINITIONS, ownerArgumentTool } from "../agent/owner-argument-tools.js";
import { GUIDED_ASSIGNMENT_TOOL_DEFINITIONS } from "../school/guided-assignment-tools.js";
import type { TelegramProvider } from "../providers/provider-types.js";
import { SCHOOL_COLLECTOR_TOOLS } from "../school/collector-tools.js";
import type { MeaningSearchReader } from "../memory/meaning-search.js";
import { readMemoryOwnerTurnEvidence, readHistoryPayloadEnvelope } from "../memory/telegram-memory-controls.js";
import type { MemoryControlIntent } from "../memory/memory-types.js";
import type { TelegramMemoryTargetFinder } from "../memory/memory-control-targets.js";
import type {
  ModelAgentProvider,
  ModelAgentStreamProvider,
  ModelFunctionCall,
  ModelFunctionDefinition,
} from "../providers/provider-types.js";
import {
  composeReceiptReply,
  OwnerAgentCore,
  type OwnerAgentChannelPort,
} from "../agent/owner-agent-core.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const encoder = new TextEncoder();

/**
 * What a call adds to the shared prompt.
 *
 * Three statements and no conditions, in the spirit of `docs/CODE-VS-JUDGMENT.md`:
 * the model is told what its situation is and decides. It is told receipts are
 * read aloud by code because they are, so repeating one is a lie about who
 * spoke.
 */
export const OWNER_VOICE_AGENT_CHANNEL_PROMPT = `You are speaking with Sid on a phone call. Everything you return is spoken aloud, so write sentences a person would say: no lists, no headings, no markdown, no emoji. Keep it short — this is a conversation, not a message.

A receipt added to your words is read aloud verbatim by the system, so never read one back or paraphrase one.

There is no screen and he cannot swipe-reply on a call. The guided_assignment_draft tool can send his saved draft to his own Telegram; no other message, link, keyboard or file delivery is available here.

When an action needs his confirmation, the system asks him for it: on a call it asks for his four digit PIN in the moment and he says or keys it in, and a tap he already gave in Telegram in the last ten minutes also counts. Never ask for the PIN yourself and never repeat it back.`;

/** The tools a call can use; exported so the provider's tool cap is tested against it. */
export const OWNER_VOICE_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  ...MEMORY_TOOL_DEFINITIONS,
  ...OWNER_ARGUMENT_TOOL_DEFINITIONS,
  ...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS,
  ...SCHOOL_COLLECTOR_TOOLS,
]);

interface PreviousVoiceAssistantRow {
  readonly causation_id: unknown;
  readonly event_id: unknown;
  readonly subject_id: unknown;
  readonly content_hash: unknown;
  readonly envelope_json: unknown;
}

interface PreviousVoiceAssistant {
  readonly text: string;
}

export interface OwnerVoiceAgentDependencies {
  readonly guidedAssignmentTelegram?: TelegramProvider;
  readonly provider: ModelAgentProvider & ModelAgentStreamProvider;
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  /**
   * The owner principal on the call session.
   *
   * This is the voice authority boundary. A turn reaching this adapter has
   * already passed `CallSessionCore`'s authentication and
   * `conversation.basic` authorization on the session, and a guest call never
   * reaches a conversation turn at all; what this checks is that the turn's
   * principal is the configured owner, so a session bound to any other
   * principal cannot act.
   */
  readonly ownerPrincipalId: string;
  readonly targets: TelegramMemoryTargetFinder;
  readonly memorySearch?: MeaningSearchReader;
  /**
   * The narrow memory authority. True here, and it is not a default: a voice
   * turn only exists after the owner authenticated to this call session, so the
   * durable turn proof in `readMemoryOwnerTurnEvidence` is proof about the
   * owner's own words. A guest call never reaches a conversation turn.
   */
  readonly directOwnerText: boolean;
  readonly decisions: {
    raise(input: RaiseDecisionInput): Promise<DecisionItem>;
  };
  readonly autonomy: ToolAutonomyGateContract;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly timeZone?: string;
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

export class OwnerVoiceAgentAdapter extends OwnerAgentCore {
  constructor(private readonly voice: OwnerVoiceAgentDependencies) {
    super(voice, snapshotModelAdapterStreamInput);
    safeText(voice.ownerPrincipalId, 1_024);
  }

  protected override streamingProvider(): ModelAgentStreamProvider { return this.voice.provider; }

  protected port(input: Readonly<ModelAdapterStreamInput>): OwnerAgentChannelPort {
    const adapter = this;
    return Object.freeze({
      channelPrompt: `${OWNER_VOICE_AGENT_CHANNEL_PROMPT}\n\nOwner time zone: ${adapter.voice.timeZone ?? "America/Toronto"}. Current instant: ${(adapter.voice.now?.() ?? new Date()).toISOString()}. Deadline relative dates are checked against the durable current turn timestamp.`,
      toolDefinitions: OWNER_VOICE_TOOL_DEFINITIONS,
      canActOn: (): boolean =>
        input.channel === "voice" && input.principalId === adapter.voice.ownerPrincipalId,
      authorityRefusal:
        "I refused that tool call because this is not the owner's own call. Nothing changed.",
      memoryAuthorityRefusal:
        "I refused that memory tool call because this is not the owner's own call. Nothing changed.",
      pipelineAuthorityRefusal:
        "I refused that tool call because this call is not the owner's own. Nothing changed.",
      memoryOwnerTurn: (
        turnInput: Readonly<ModelAdapterStreamInput>,
        intent: MemoryControlIntent | null,
      ) => readMemoryOwnerTurnEvidence({
        database: adapter.voice.database,
        modelInput: turnInput,
        memoryIntent: intent,
        channelCode: 1,
        // A voice turn carries no `directOwnerText` marker, and that is not a
        // weaker proof here: the marker records that Telegram's ingress saw a
        // direct private message, and there is no equivalent question to ask of
        // a relay frame. What replaces it is upstream and already checked --
        // `CallSessionCore` requires the owner passphrase before a voice turn
        // exists at all, and the adapter's own `canActOn` requires the turn's
        // principal to be the configured owner. Everything else in this proof
        // (the committed user event, its envelope, its channel code, the
        // redaction, the exact text) is unchanged and still fails closed.
        requireDirectOwnerText: false,
      }),
      /**
       * Nothing is recorded, because on this channel there is nowhere for it to
       * go: the pending-reference map exists so a *staged Telegram delivery*
       * can carry the ids, and a voice turn sends on the relay and stages
       * nothing.
       */
      recordReferences: (): void => undefined,
      /**
       * The decision is raised durably in the core and that is the whole
       * authorization: `consumeStandingDecision` claims a tap by tool name,
       * capability and argument fingerprint with no channel in the query, so a
       * tap Sid gives in Telegram authorizes the same call. What a call cannot do is present
       * the question, which is what the spoken refusal says.
       */
      recordDecision: (): void => undefined,
      confirmationSurfaceRefusal:
        "That action always needs your tap, and I cannot show you a button on a call. Confirm it in Telegram",
      // There is no swipe-reply gesture on a call, so this is not a check that
      // passes vacuously -- it is a check whose subject does not exist here.
      replyTargetsLatestAssistant: async (): Promise<boolean> => true,
      replyTargetRefusal:
        "I refused that memory tool call because I cannot tell which memory you meant. Nothing changed.",
      // No school, university or study tool over a call yet. So that adding one
      // does not mean touching the loop, only this catalogue and the adapter
      // that runs it.
      pipelineModel: (): ModelAdapter | null => null,
      argumentTool: (call: ModelFunctionCall) => ownerArgumentTool(adapter.voice.database, input, call,
        () => adapter.voice.now?.() ?? new Date(), adapter.voice.timeZone ?? "America/Toronto",
        () => readMemoryOwnerTurnEvidence({ database: adapter.voice.database, modelInput: input, memoryIntent: null,
          channelCode: 1, requireDirectOwnerText: false })),
      unknownToolRefusal: "I refused an unknown tool call. Nothing changed.",
      previousAssistantText: async (turnInput: Readonly<ModelAdapterStreamInput>) =>
        (await adapter.previousAssistant(turnInput))?.text ?? null,
      composeReply: composeReceiptReply,
    });
  }

  /**
   * What Jarvis itself said on the previous turn of this call.
   *
   * Two tools are grounded in it -- `memory_remember` with
   * `evidenceClass: "confirmed"` and `memory_confirm` -- and without it they
   * refuse rather than guess, so a call could never confirm a memory it had
   * just offered.
   *
   * Read from the durable `conversation.assistant_sent` event rather than from
   * any staging table, because a voice turn has no delivery row: it is sent on
   * the relay. The turn that sent it must share this turn's `session_id`, which
   * is what makes a "yes" an answer to something said on this call. Without it,
   * an offer Jarvis made as one call ended was the grounding for a "yes" on the
   * next call, which answered nothing Jarvis had said there.
   *
   * `events` carries no correlation or causation column -- both live only in
   * the envelope -- so the link is the turn row's `sent_assistant_event_id`,
   * and the envelope's `causationId` is checked against that turn's user event.
   */
  private async previousAssistant(
    input: Readonly<ModelAdapterStreamInput>,
  ): Promise<PreviousVoiceAssistant | null> {
    const row = await this.voice.database.prepare(`SELECT previous.user_event_id AS causation_id,
        sent.event_id, sent.subject_id, sent.content_hash, sent.envelope_json
      FROM conversation_turns current
      JOIN conversation_turns previous
        ON previous.session_id = current.session_id
        AND previous.principal_id = current.principal_id
        AND previous.channel = 'voice'
        AND previous.state = 'voice_sent'
      JOIN events sent ON sent.event_id = previous.sent_assistant_event_id
      WHERE current.turn_id = ?1 AND current.principal_id = ?2
        AND sent.subject_id = ?2
        AND sent.event_type = 'conversation.assistant_sent'
        AND sent.source = ?3
      ORDER BY sent.sequence DESC LIMIT 1`)
      .bind(input.correlationId, input.principalId, CONVERSATION_EVENT_SOURCE).first<PreviousVoiceAssistantRow>();
    if (row === null || typeof row.envelope_json !== "string") return null;
    let decoded: unknown;
    try { decoded = JSON.parse(row.envelope_json) as unknown; }
    catch { throw new TypeError("owner_agent_previous_reply_invalid"); }
    const envelope = await validateEnvelope(decoded);
    const eventId = safeUlid(row.event_id);
    if (envelope.eventId !== eventId || envelope.subjectId !== input.principalId
      || envelope.causationId !== safeUlid(row.causation_id)
      || envelope.eventType !== "conversation.assistant_sent"
      || envelope.source !== CONVERSATION_EVENT_SOURCE
      || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
      || envelope.contentHash !== row.content_hash) {
      throw new TypeError("owner_agent_previous_reply_invalid");
    }
    return Object.freeze({
      text: readHistoryPayloadEnvelope(envelope.payload, "owner_agent_previous_reply_invalid"),
    });
  }
}
