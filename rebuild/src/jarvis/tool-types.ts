import type { Clock } from "../clock.js";
import type { ConversationRepo } from "../conversation/conversation-repo.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import type { FactsRepo } from "../memory/facts-repo.js";
import type { PendingActionsRepo } from "../confirmations/pending-actions.js";
import type { ReceiptsRepo } from "../receipts/receipts-repo.js";
import type { SettingsRepo } from "../settings/settings-repo.js";
import type { ToolSchema } from "../model/types.js";
import type { Provenance, Trigger } from "../types.js";

export interface ToolResult {
  ok: boolean;
  /** Machine status: ok | not_connected | refused | shadow | error | confirmation_requested | ... */
  status: string;
  /** Human-facing detail returned to the model. */
  message?: string;
  data?: unknown;
}

/** A channel that can actually deliver a message to Sid. */
export interface OwnerChannel {
  /** Returns a status; never fabricates success. */
  sendText(message: string): Promise<{ ok: boolean; status: string; detail?: string }>;
}

export interface ToolContext {
  clock: Clock;
  ownerId: string;
  /** Provenance of the CURRENT turn, set by code from the channel. */
  provenance: Provenance;
  /** What triggered this turn. Recorded on every receipt. */
  trigger: Trigger;
  /** A unique id for the current event/turn. Confirmations may not self-confirm within it. */
  eventId: string;
  /** The current owner message text, for provenance quote verification. */
  ownerMessageText: string;

  facts: FactsRepo;
  conversation: ConversationRepo;
  receipts: ReceiptsRepo;
  pending: PendingActionsRepo;
  settings: SettingsRepo;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  ownerChannel: OwnerChannel;

  /** Enqueue a wake-up (Phase 6). Returns a status; a no-op scheduler is honest about it. */
  scheduleWakeup?: (fireAtIso: string, reason: string) => Promise<{ ok: boolean; status: string; id?: string }>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** True for exactly the five confirmed actions (brief section 3). */
  confirmable?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
