import type { Clock } from "../clock.js";
import { ConversationRepo } from "../conversation/conversation-repo.js";
import { PendingActionsRepo } from "../confirmations/pending-actions.js";
import { ToolDispatcher } from "../confirmations/gate.js";
import { actionTools } from "../confirmations/action-tools.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import { FactsRepo } from "../memory/facts-repo.js";
import { memoryTools } from "../memory/memory-tools.js";
import { ReceiptsRepo } from "../receipts/receipts-repo.js";
import { SettingsRepo } from "../settings/settings-repo.js";
import type { Model } from "../model/types.js";
import { AgentCore } from "./agent-core.js";
import { makeConfirmTools, receiptsQuery, sendText, settingsUpdate } from "./core-tools.js";
import type { OwnerChannel } from "./tool-types.js";

export interface BuildInput {
  model: Model;
  clock: Clock;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  ownerChannel: OwnerChannel;
  ownerId: string;
  timezone: string;
}

export interface BuiltJarvis {
  agent: AgentCore;
  dispatcher: ToolDispatcher;
  facts: FactsRepo;
  conversation: ConversationRepo;
  receipts: ReceiptsRepo;
  pending: PendingActionsRepo;
  settings: SettingsRepo;
}

/** Wire the whole brain together. Used by the DO, local runner and tests. */
export function buildJarvis(input: BuildInput): BuiltJarvis {
  const facts = new FactsRepo(input.clock);
  const conversation = new ConversationRepo(input.clock);
  const receipts = new ReceiptsRepo(input.clock);
  const pending = new PendingActionsRepo(input.clock);
  const settings = new SettingsRepo();

  const dispatcher = new ToolDispatcher([
    ...memoryTools,
    ...actionTools,
    sendText,
    receiptsQuery,
    settingsUpdate,
  ]);

  // confirm/cancel need a reference to the dispatcher's executeConfirmed.
  const confirmTools = makeConfirmTools((pendingId, ctx) => dispatcher.executeConfirmed(pendingId, ctx));
  for (const t of confirmTools) dispatcher.register(t);

  const agent = new AgentCore({
    model: input.model,
    dispatcher,
    facts,
    conversation,
    receipts,
    pending,
    settings,
    embeddings: input.embeddings,
    vectors: input.vectors,
    clock: input.clock,
    ownerChannel: input.ownerChannel,
    timezone: input.timezone,
    ownerId: input.ownerId,
  });

  return { agent, dispatcher, facts, conversation, receipts, pending, settings };
}
