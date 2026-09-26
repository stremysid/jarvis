/**
 * `owner_access`: guest access managed by Jarvis, on the owner's call.
 *
 * The model decides what Sid's words mean and calls this tool with the
 * operation, target, capability ids and PIN choice it inferred. Code keeps only
 * the validation (a real E.164 number, ids a guest can hold), the credential
 * capture and the repository writes. There is no phrase grammar and no
 * code-side "confirm"/"cancel" word match: the model decides whether to read the
 * number back or ask Sid to confirm before it calls this.
 *
 * The PIN is never a model input. A `pin: "digits"` request opens a question on
 * the call, exactly as the tier-3 PIN does, and the digits are consumed by the
 * call session before they can become a turn, a transcript row or model input.
 */

import type { GuestCapabilityId, Ulid } from "../../../../packages/contracts/src/index.js";
import type { ModelFunctionDefinition } from "../providers/provider-types.js";
import { normalizeSpokenPin } from "./pin-capture.js";
import type { OwnerCallAuthority } from "./voice-access-authority.js";
import type {
  OwnerAccessDraft,
  OwnerAccessExecutionResult,
  OwnerAccessService,
  OwnerPinSelection,
} from "./owner-access-service.js";

export const OWNER_ACCESS_TOOL_NAME = "owner_access";

/** Spoken when the model asked for a PIN Sid has not yet given. */
export const OWNER_ACCESS_PIN_PROMPT =
  "Enter four digits for the guest PIN: key them in, or say the four digits.";
export const OWNER_ACCESS_PIN_UNREADABLE =
  "I did not catch four digits. Key them in, or say the four digits.";
/** How long one PIN question waits before the access change is abandoned. */
export const OWNER_ACCESS_PIN_TIMEOUT_MS = 20_000;

export const OWNER_ACCESS_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  Object.freeze({
    name: OWNER_ACCESS_TOOL_NAME,
    description: "Manage who may call Jarvis as a guest: add a caller, replace their permissions, rotate their PIN, revoke them, or list the allowed callers. This is the owner's own access management, so you decide whether to read the number back or ask Sid to confirm before you call it; there is no separate confirmation step in code. Pass the capability ids the caller should hold, such as conversation.basic for ordinary conversation; access management itself can never be granted to a guest. Use pin default to give them the deployment's standard four digit PIN, or pin digits and the system will ask Sid for four digits on this call. Example: Sid says \"let my mum call you, just conversation\", so you use operation add, her E.164 number, [\"conversation.basic\"] and pin default.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["operation", "phone", "capabilities", "pin"],
      properties: {
        operation: {
          enum: ["add", "replace_permissions", "rotate_pin", "revoke", "list"],
          description: "What to do: add a new caller; replace_permissions for an existing one; rotate_pin to change their PIN; revoke to remove them; list to read who is currently allowed.",
        },
        phone: {
          type: ["string", "null"],
          description: "The caller's number in E.164, for example +14165550123. Required for every operation except list, which takes null.",
        },
        capabilities: {
          type: "array",
          maxItems: 32,
          items: { type: "string" },
          description: "The guest capability ids this caller should hold, for add and replace_permissions. Use [] for rotate_pin, revoke and list. An id a guest cannot hold is refused.",
        },
        pin: {
          enum: ["default", "digits"],
          description: "default uses the deployment's standard four digit PIN. digits asks Sid for four digits on this call. Only add and rotate_pin use a PIN; pass default otherwise.",
        },
      },
    }),
  }),
]);

export interface OwnerAccessToolRequest {
  readonly operation: "add" | "replace_permissions" | "rotate_pin" | "revoke" | "list";
  readonly providerE164: string | null;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly pin: "default" | "digits";
}

/** What the owner agent dispatches `owner_access` through. */
export interface OwnerAccessToolPort {
  run(request: OwnerAccessToolRequest, signal?: AbortSignal): Promise<OwnerAccessExecutionResult>;
}

/** The call surface the tool needs, registered by `CallSessionCore`. */
export interface OwnerAccessToolSession {
  readonly sessionId: Ulid;
  /** The owner authority of this call, or null when this is not the owner's call. */
  ownerAuthority(): OwnerCallAuthority | null;
  /** Speaks code-authored credential text on the relay; never a candidate. */
  speak(text: string): Promise<void>;
  /** Told when a PIN question opens, so keypad digits from before it are dropped. */
  pinQuestionOpened?(): void;
}

interface PendingPinQuestion {
  settled: boolean;
  resolve: (selection: OwnerPinSelection | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class OwnerAccessTool implements OwnerAccessToolPort {
  readonly #service: OwnerAccessService;
  readonly #now: () => Date;
  #session: OwnerAccessToolSession | null = null;
  #pendingPin: PendingPinQuestion | null = null;

  constructor(service: OwnerAccessService, now: () => Date = () => new Date()) {
    this.#service = service;
    this.#now = now;
  }

  attachSession(session: OwnerAccessToolSession): void {
    this.#session = Object.freeze({
      sessionId: session.sessionId,
      ownerAuthority: session.ownerAuthority,
      speak: session.speak,
      ...(session.pinQuestionOpened === undefined ? {} : { pinQuestionOpened: session.pinQuestionOpened }),
    });
  }

  hasPendingPin(): boolean {
    return this.#pendingPin !== null && !this.#pendingPin.settled;
  }

  /** Closes an open PIN question unanswered, for example when the turn ends. */
  cancelPendingPin(): void {
    this.#settlePin(null);
  }

  async submitPinSpoken(text: string): Promise<void> {
    const pending = this.#pendingPin;
    if (pending === null || pending.settled) return;
    const digits = normalizeSpokenPin(text);
    if (digits === null) {
      await this.#speak(OWNER_ACCESS_PIN_UNREADABLE);
      return;
    }
    this.#settlePin(Object.freeze({ kind: "explicit", digits }));
  }

  async submitPinKeypad(digits: Uint8Array): Promise<void> {
    if (this.#pendingPin === null || this.#pendingPin.settled) return;
    this.#settlePin(Object.freeze({ kind: "explicit", digits }));
  }

  async run(request: OwnerAccessToolRequest, signal?: AbortSignal): Promise<OwnerAccessExecutionResult> {
    const session = this.#session;
    if (session === null) throw new Error("owner_access_unavailable");
    const authority = session.ownerAuthority();
    if (authority === null) throw new Error("owner_access_authority_invalid");
    const now = this.#now();
    const draft = draftFor(request);
    const proposal = await this.#service.prepare({
      ownerAuthority: authority,
      sessionId: authority.sessionId,
      draft,
      now,
    });
    const needsPin = draft.kind === "add" || draft.kind === "rotate_pin";
    let pinSelection: OwnerPinSelection | null = null;
    if (needsPin) {
      pinSelection = request.pin === "default"
        ? Object.freeze({ kind: "default" })
        : await this.#requestPin(session, signal);
    }
    try {
      return await this.#service.execute({ proposal, ownerAuthority: authority, pinSelection, now: this.#now() });
    } finally {
      if (pinSelection?.kind === "explicit") pinSelection.digits.fill(0);
    }
  }

  async #requestPin(
    session: OwnerAccessToolSession,
    signal: AbortSignal | undefined,
  ): Promise<OwnerPinSelection | null> {
    if (this.#pendingPin !== null) throw new Error("owner_access_pin_in_progress");
    let resolve!: (selection: OwnerPinSelection | null) => void;
    const answered = new Promise<OwnerPinSelection | null>((settle) => { resolve = settle; });
    const pending: PendingPinQuestion = { settled: false, resolve, timer: null };
    const onAbort = (): void => { this.#settlePin(null); };
    this.#pendingPin = pending;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session.pinQuestionOpened?.();
      if (signal?.aborted === true) this.#settlePin(null);
      if (!pending.settled) await this.#speak(OWNER_ACCESS_PIN_PROMPT);
      if (!pending.settled && this.#pendingPin === pending) {
        pending.timer = setTimeout(() => { this.#settlePin(null); }, OWNER_ACCESS_PIN_TIMEOUT_MS);
      }
      return await answered;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      if (this.#pendingPin === pending) this.#pendingPin = null;
    }
  }

  #settlePin(selection: OwnerPinSelection | null): void {
    const pending = this.#pendingPin;
    if (pending === null || pending.settled) return;
    pending.settled = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.resolve(selection);
  }

  async #speak(text: string): Promise<void> {
    const session = this.#session;
    if (session === null) return;
    try { await session.speak(text); }
    catch { /* The question's timeout abandons the change. */ }
  }
}

/** The tool arguments as the service's draft, before the service's own validation. */
function draftFor(request: OwnerAccessToolRequest): OwnerAccessDraft {
  if (request.operation === "list") return Object.freeze({ kind: "list" });
  const providerE164 = request.providerE164;
  if (typeof providerE164 !== "string" || providerE164.length === 0) {
    throw new Error("owner_access_input_invalid");
  }
  if (request.operation === "rotate_pin" || request.operation === "revoke") {
    return Object.freeze({ kind: request.operation, providerE164 });
  }
  return Object.freeze({
    kind: request.operation,
    providerE164,
    capabilityIds: request.capabilityIds,
  });
}
