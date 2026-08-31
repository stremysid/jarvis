import type { Ulid } from "../../../../packages/contracts/src/index.js";

export interface ModelToken {
  readonly index: number;
  readonly text: string;
}

export interface RetrievedContext {
  readonly sourceEventId: Ulid;
  readonly text: string;
  readonly sensitivity: "personal" | "restricted";
}

export interface ModelAdapterStreamInput {
  readonly correlationId: Ulid;
  readonly principalId: string;
  readonly channel: "voice" | "telegram";
  readonly userText: string;
  readonly context: readonly RetrievedContext[];
  readonly reasoningEffort: "none" | "low" | "high" | "max";
  readonly firstTokenTimeoutMs: number;
  readonly timeoutMs: number;
  readonly contextTokenBudget: number;
  readonly maxOutputCharacters: number;
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken>;
}
