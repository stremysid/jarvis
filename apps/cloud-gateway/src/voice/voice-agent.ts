/** Voice supplies authenticated call authority and spoken consent to the shared owner agent. */

import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ArchiveBucket } from "../archive/archival-service.js";
import type { ToolAutonomyGateContract } from "../autonomy/tool-gate.js";
import type { DecisionItem, RaiseDecisionInput } from "../decisions/decision-types.js";
import { snapshotModelAdapterStreamInput } from "../model/model-adapter.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import { OWNER_TOOL_DEFINITIONS } from "../agent/owner-tools.js";
import { ownerPipelineModel, type OwnerPipelineModels } from "../agent/owner-pipelines.js";
import { ownerArgumentTool } from "../agent/owner-argument-tools.js";
import { ownerCommandTool } from "../agent/owner-command-tools.js";
import type { OwnerCommandCapabilities } from "../agent/owner-command-capabilities.js";
import type { TelegramProvider } from "../providers/provider-types.js";
import type { MeaningSearchReader } from "../memory/meaning-search.js";
import { readPreviousVoiceAssistant } from "../memory/voice-memory-reference.js";
import { recordPendingTelegramMemoryReferences } from "../memory/telegram-memory-reference.js";
import { readMemoryOwnerTurnEvidence } from "../memory/telegram-memory-controls.js";
import type { MemoryControlIntent } from "../memory/memory-types.js";
import {
  citedMemoryItemIds,
  type TelegramMemoryTargetFinder,
} from "../memory/memory-control-targets.js";
import type {
  ModelAgentProvider,
  ModelAgentStreamProvider,
  ModelFunctionCall,
} from "../providers/provider-types.js";
import {
  composeReceiptReply,
  OwnerAgentCore,
  type OwnerAgentChannelPort,
} from "../agent/owner-agent-core.js";
import type { WebToolsDependencies } from "../web/web-tools.js";
import type { OwnerAccessToolPort } from "./owner-access-tool.js";

const encoder = new TextEncoder();

/**
 * What a call adds to the shared prompt.
 *
 * Medium instructions rather than a second set of capability rules:
 * the model is told what its situation is and decides. It is told receipts are
 * read aloud by code because they are, so repeating one is a lie about who
 * spoke.
 */
export const OWNER_VOICE_AGENT_CHANNEL_PROMPT = `You are speaking with Sid on a phone call. Everything you return is spoken aloud, so write sentences a person would say: no lists, no headings, no markdown, no emoji. Keep it short — this is a conversation, not a message.

A receipt added to your words is read aloud verbatim by the system, so never read one back or paraphrase one.

There is no screen and Sid cannot swipe-reply on a call. The guided_assignment_draft tool can send his saved draft to his own Telegram; no other message, link, keyboard or file delivery is available here. Describe links or files in spoken words when needed. You can read Sid's own status with owner_status, what is waiting on him with decision_queue and today's digest with run_digest; answering one of those stored questions still needs his Telegram tap, so read them out and point him there.

For a staged model-inferred memory, ask Sid to open /queue in Telegram and tap Confirm or Discard. A spoken yes does not confirm a model-inferred memory. For a tier-3 action, the system itself asks him for his four digit PIN at that moment, and he says it or keys it in; a Telegram tap he already gave for the same action also counts. Never ask for the PIN yourself and never repeat it back. If the system says it cannot take a PIN on this call, ask him to open /queue in Telegram, tap Confirm, then repeat the request on this call. A spoken yes is not a tier-3 confirmation.`;

/**
 * The spoken refusals name `/queue`, which is the bot's real decision list.
 *
 * Exported so the test reads the exact strings the caller hears rather than a
 * copy; the command name in each one has to be a command the bot actually
 * recognises, or the one instruction a call gives Sid for confirming a tier-3
 * action sends him to "No such command."
 */
export const OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL =
  "Nothing changed. Open /queue in Telegram and tap Confirm or Discard. A spoken yes cannot confirm a model-inferred memory.";
export const OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL =
  "That action always needs your tap, and I cannot show you a button on a call. Open /queue in Telegram, tap Confirm, then ask me again on this call.";

export interface OwnerVoiceAgentDependencies extends OwnerPipelineModels {
  readonly guidedAssignmentTelegram?: TelegramProvider;
  readonly provider: ModelAgentProvider & ModelAgentStreamProvider;
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  /**
   * The owner principal on the call session.
   *
   * This is the voice authority boundary. A turn reaching this adapter has
   * already passed `CallSessionCore`'s authentication and
   * `conversation.basic` authorization on the session. An authenticated guest
   * can converse, but remains bound to the guest principal; this exact owner
   * comparison is what keeps that session from acting.
   */
  readonly ownerPrincipalId: string;
  readonly targets: TelegramMemoryTargetFinder;
  readonly memorySearch?: MeaningSearchReader;
  /**
   * The narrow memory authority. True here, and it is not a default: a voice
   * owner tool path only exists after the configured owner authenticated to
   * this call session, so the durable turn proof in
   * `readMemoryOwnerTurnEvidence` is proof about the owner's own words. Guest
   * turns receive no tools and never call this proof.
   */
  readonly directOwnerText: boolean;
  readonly decisions: {
    raise(input: RaiseDecisionInput): Promise<DecisionItem>;
  };
  readonly autonomy: ToolAutonomyGateContract;
  /** Shared with Telegram: the same web tools on both channels. */
  readonly web?: WebToolsDependencies;
  /**
   * Guest access management. Present on a call because that is where a guest
   * grant and a PIN question live; the shared catalogue offers the tool on both
   * channels and the core refuses where this port is absent.
   */
  readonly ownerAccessTool?: OwnerAccessToolPort | null;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly timeZone?: string;
  /** The reads behind `owner_status`, `decision_queue` and `run_digest`. */
  readonly commands?: OwnerCommandCapabilities;
}

function safeText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError("owner_agent_text_invalid");
  }
  return value;
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
      channelPrompt: `${OWNER_VOICE_AGENT_CHANNEL_PROMPT}\n\nOwner time zone: ${adapter.voice.timeZone ?? "America/Toronto"}. Current instant: ${(adapter.voice.now?.() ?? new Date()).toISOString()}. You resolve deadline dates and times from what Sid says; if you are unsure which one he means, ask him.`,
      toolDefinitions: OWNER_TOOL_DEFINITIONS,
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
        // owner calls pass the owner authentication path, and the adapter's own
        // `canActOn` requires the turn's principal to be the configured owner.
        // Guest turns get no tools, so they cannot reach this method. Everything
        // else in this proof
        // (the committed user event, its envelope, its channel code, the
        // redaction, the exact text) is unchanged and still fails closed.
        requireDirectOwnerText: false,
      }),
      recordReferences: recordPendingTelegramMemoryReferences,
      /**
       * The decision is raised durably in the core and that is the whole
       * authorization: `consumeStandingDecision` claims a tap by tool name,
       * capability and argument fingerprint with no channel in the query, so a
       * tap Sid gives in Telegram authorizes the same call. A call cannot display
       * Telegram's confirmation keyboard, so the spoken refusal points to /queue.
       */
      recordDecision: (): void => undefined,
      inferredMemoryConfirmationRefusal: OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL,
      confirmationSurfaceRefusal: OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL,
      // There is no swipe-reply gesture on a call, so this is not a check that
      // passes vacuously -- it is a check whose subject does not exist here.
      replyTargetsLatestAssistant: async (): Promise<boolean> => true,
      replyTargetRefusal:
        "I refused that memory tool call because I cannot tell which memory you meant. Nothing changed.",
      pipelineModel: (call: ModelFunctionCall) => ownerPipelineModel(adapter.voice, call),
      argumentTool: (call: ModelFunctionCall) => ownerArgumentTool(adapter.voice.database, input, call,
        () => adapter.voice.now?.() ?? new Date(), adapter.voice.timeZone ?? "America/Toronto"),
      commandTool: (call: ModelFunctionCall) => ownerCommandTool(adapter.voice.commands, call),
      unknownToolRefusal: "I refused an unknown tool call. Nothing changed.",
      previousAssistant: async (turnInput: Readonly<ModelAdapterStreamInput>) => {
        const previous = await readPreviousVoiceAssistant(adapter.voice.database, turnInput);
        return previous === null ? null : Object.freeze({
          text: previous.text,
          eventId: previous.eventId,
          itemIds: Object.freeze([
            ...new Set([...previous.itemIds, ...citedMemoryItemIds(previous.text)]),
          ]),
        });
      },
      composeReply: composeReceiptReply,
    });
  }

}
