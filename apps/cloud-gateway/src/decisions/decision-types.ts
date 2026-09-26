/**
 * The decision queue's vocabulary (plan section 6).
 *
 * Everything waiting on the owner -- a dev session that needs a call, a
 * project blocker, a question Jarvis cannot answer for itself -- becomes one
 * item here rather than a ping from whichever subsystem was blocked. The item
 * carries the origin that is waiting and an opaque reference of that origin's
 * own choosing, because the answer is worthless unless it can be routed back
 * to the thing that stopped.
 *
 * Two shapes in this file are load-bearing. `DecisionOptionKind` distinguishes
 * a real choice from the two escapes every question carries, so a caller
 * cannot pose a question that boxes the owner into a forced pick. And
 * `AnswerDecisionResult` is a result, not an exception: an owner double-tapping
 * a Telegram button is expected behaviour, and a second tap must come back as
 * a fact about the item rather than as a raised database error.
 */

import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type DecisionUrgency = "urgent" | "normal";
export type DecisionStatus = "open" | "delivered" | "answered" | "expired" | "withdrawn";
export type DecisionOptionKind = "choice" | "free_text" | "explain";

/**
 * The keys of the two escapes. They are reserved: a caller supplying a choice
 * under one of these keys would shadow the escape rather than add a choice,
 * and the question would lose the way out it is required to have.
 */
export const FREE_TEXT_OPTION_KEY = "other";
export const EXPLAIN_OPTION_KEY = "explain";
export const RESERVED_OPTION_KEYS: ReadonlySet<string> = new Set([FREE_TEXT_OPTION_KEY, EXPLAIN_OPTION_KEY]);

export const FREE_TEXT_OPTION_LABEL = "Other — I'll type it";
export const EXPLAIN_OPTION_LABEL = "Explain more";

/**
 * A question with more than a handful of choices is not answerable from a lock
 * screen, which is the only place this queue is ever cleared. The cap is on the
 * caller's choices; the two escapes are added on top.
 */
export const MAX_DECISION_CHOICES = 8;

/**
 * Option keys travel inside Telegram callback data, which is capped at 64
 * bytes. Restricting them to this alphabet keeps one key one byte per
 * character and keeps the field separator out of the key, so the callback
 * encoding stays unambiguous rather than merely usually unambiguous.
 */
export const DECISION_OPTION_KEY = /^[a-z0-9_-]{1,32}$/u;

/** One tappable answer supplied by whoever raised the question. */
export interface DecisionChoice {
  readonly key: string;
  readonly label: string;
}

export interface RaiseDecisionInput {
  readonly principalId: string;
  /** Which subsystem is blocked; quoted back when the answer is routed. */
  readonly origin: string;
  readonly originReference?: string | null;
  readonly urgency: DecisionUrgency;
  readonly question: string;
  /** Shown only when the owner taps "explain more", so the question stays short. */
  readonly detail?: string | null;
  /** Required. The queue orders by this, so whoever raises the question states its priority. */
  readonly rank: number;
  readonly expiresAt?: string | null;
  readonly choices?: readonly DecisionChoice[];
}

export interface DecisionOption {
  readonly optionKey: string;
  readonly label: string;
  readonly ordinal: number;
  readonly kind: DecisionOptionKind;
}

export interface DecisionItem {
  readonly decisionId: string;
  readonly principalId: string;
  readonly origin: string;
  readonly originReference: string | null;
  readonly urgency: DecisionUrgency;
  readonly question: string;
  readonly detail: string | null;
  readonly status: DecisionStatus;
  readonly rank: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly resolvedAt: string | null;
  readonly options: readonly DecisionOption[];
}

/**
 * A fully composed item on its way to storage. The service, not the
 * repository, decides ids, timestamps, ordinals and which options exist; the
 * repository writes exactly what it is handed, so the rule that every question
 * carries its escapes has one home and one test.
 */
export interface PersistDecisionInput {
  readonly decisionId: Ulid;
  readonly principalId: string;
  readonly origin: string;
  readonly originReference: string | null;
  readonly urgency: DecisionUrgency;
  readonly question: string;
  readonly detail: string | null;
  readonly rank: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly options: readonly DecisionOption[];
}

export interface AnswerDecisionInput {
  readonly decisionId: string;
  /**
   * The channel identity that tapped. Authenticating it is the caller's job;
   * proving it belongs to the principal that owns the item is not.
   */
  readonly answeredByIdentityId: string;
  readonly optionKey?: string | null;
  readonly freeText?: string | null;
}

export interface PersistResponseInput {
  readonly responseId: Ulid;
  readonly decisionId: string;
  readonly answeredByIdentityId: string;
  readonly optionKey: string | null;
  readonly freeText: string | null;
  readonly now: string;
}

export interface DecisionResponse {
  readonly responseId: string;
  readonly decisionId: string;
  readonly optionKey: string | null;
  readonly freeText: string | null;
  readonly answeredByIdentityId: string;
  readonly respondedAt: string;
}

/** Everything the blocked origin needs to pick up where it stopped. */
export interface DecisionRouting {
  readonly decisionId: string;
  readonly origin: string;
  readonly originReference: string | null;
  readonly optionKey: string | null;
  readonly optionKind: DecisionOptionKind | null;
  readonly freeText: string | null;
  readonly answeredByIdentityId: string;
  readonly respondedAt: string;
}

/**
 * Why a refusal is a value here: every one of these is something an owner or a
 * subsystem does in normal operation -- a second tap, a stale keyboard from
 * before the item expired, a button pressed from an account that is not the
 * owner's. A thrown database error would leave the caller unable to tell a
 * double-tap apart from a broken query.
 */
export type AnswerDecisionResult =
  | { readonly outcome: "recorded"; readonly routing: DecisionRouting }
  | { readonly outcome: "already_answered"; readonly standing: DecisionResponse }
  | { readonly outcome: "not_answerable"; readonly status: DecisionStatus }
  | { readonly outcome: "unknown_decision" }
  | { readonly outcome: "not_owner" }
  | { readonly outcome: "unknown_option" };

export interface DecisionRepositoryContract {
  raise(input: PersistDecisionInput): Promise<void>;
  readItem(decisionId: string): Promise<DecisionItem | null>;
  listOpenQueue(input: { readonly principalId: string; readonly now: string }): Promise<readonly DecisionItem[]>;
  markDelivered(input: { readonly decisionId: string; readonly now: string }): Promise<boolean>;
  recordResponse(input: PersistResponseInput): Promise<AnswerDecisionResult>;
}
