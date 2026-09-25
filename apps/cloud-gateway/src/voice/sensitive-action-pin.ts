/**
 * The four digit PIN that authorizes a sensitive action on a call.
 *
 * Nothing is asked at the start of a call. Sid, 2026-09-24: an ordinary owner
 * call goes straight to Jarvis. The only credential a call asks for is this
 * one, and only at the moment a tier-3 action is about to run, which is the
 * boundary `ToolAutonomyGate` already enforces for the Telegram tap.
 *
 * Two routes authorize a tier-3 call, and this is the second one. The first is
 * a standing Telegram tap, which `ToolAutonomyGate` spends before it asks this
 * service anything -- so a confirmation Sid already gave keeps working, and a
 * call does not ask for a PIN it did not need. This route is asked only when no
 * tap could be claimed.
 *
 * The question is asked from inside the agent turn that called the tool, and
 * the answer arrives as the next relay frame. The turn is blocked on the
 * promise this service hands back, so the PIN is given "at that action" and the
 * authorization is claimed immediately before the tool body runs. `CallSessionCore`
 * routes an utterance or DTMF to this service while a question is open, and
 * that is the only path that sees it: it never becomes an event, a transcript
 * row, a conversation turn, model input, a log line or a receipt, in digits or
 * in words.
 *
 * A mis-hear is not an attack. Five attempts are allowed on one question, the
 * question is answered by speech or by keypad, and running out refuses the
 * action and returns to the conversation -- it never ends the call and never
 * locks him out. Across questions, wrong guesses are recorded and bounded by a
 * fifteen minute window that always slides, so the worst case is a wait, never
 * a permanent lock. The numbers and why are in the constants below.
 *
 * The PIN itself is a deployment secret, like the peppers already used for the
 * guest PIN and the owner passphrase. No derived material is stored: with only
 * 10,000 possible values a salted verifier is offline-guessable in hours, so it
 * would add a table and a slow hash without adding secrecy. What is stored is
 * the attempt ledger, which holds an outcome and a timestamp and no candidate.
 */

import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { normalizeSpokenPin } from "./pin-capture.js";

/** Spoken when a tier-3 action is about to run and no tap authorized it. */
export const SENSITIVE_ACTION_PIN_PROMPT =
  "That action needs your four digit PIN. Say the four digits, key them in, or say cancel.";
/**
 * Spoken when the utterance did not resolve to four digits at all.
 *
 * A distinct sentence from a wrong PIN on purpose: Sid struggles to speak
 * clearly, and "I did not catch that" tells him to repeat himself while "that
 * was not it" tells him he misremembered the number. Treating the first as the
 * second is how a mis-hear becomes a security event.
 */
export const SENSITIVE_ACTION_PIN_REPROMPT_UNREADABLE =
  "I did not catch that, try once more. Say the four digits, or key them in.";
export const SENSITIVE_ACTION_PIN_REPROMPT_WRONG =
  "That was not it. Say the four digits again, or key them in.";
export const SENSITIVE_ACTION_PIN_REFUSED =
  "I have not done that, and nothing was changed.";
export const SENSITIVE_ACTION_PIN_EXPIRED =
  "I did not hear a PIN, so I have not done that. Ask me again if you still want it.";
export const SENSITIVE_ACTION_PIN_CANCELLED = "Cancelled. Nothing was done.";
export const SENSITIVE_ACTION_PIN_RATE_LIMITED =
  "There have been too many wrong PINs, so I will not ask again for a few minutes. Nothing was done.";

/**
 * How many candidates one question accepts.
 *
 * More than three on purpose. A four digit PIN is 10,000 values, so five tries
 * is 0.05% of the space and adds nothing an attacker could use; what it buys is
 * that four mis-hears in a row do not refuse the action. The three-attempt cap
 * this replaces was sized for a call-ending gate, and this gate must never end
 * the call.
 */
export const SENSITIVE_ACTION_PIN_MAX_ATTEMPTS = 5;

/**
 * How long a question waits for an answer before refusing.
 *
 * Deliberately shorter than the 20 s owner-agent turn budget. The turn that
 * called the tool is suspended while the question is open, and a question that
 * outlived the turn would be resolved by the turn's own deadline instead --
 * refusing nothing and saying nothing. Fifteen seconds is longer than any
 * spoken answer takes, and it makes this gate the one that decides.
 */
export const SENSITIVE_ACTION_PIN_PROMPT_TIMEOUT_MS = 15_000;

/**
 * The cross-question rate limit: at most this many wrong candidates for one
 * principal in a sliding window.
 *
 * Twelve is between two and three exhausted questions. The window slides, so
 * the state always decays and the worst case is a wait of at most
 * `RATE_WINDOW_MS` -- never a permanent lockout, which is the requirement. A
 * successful attempt is not recorded here at all, so using the PIN correctly
 * never counts against it.
 */
export const SENSITIVE_ACTION_PIN_RATE_WINDOW_MS = 15 * 60_000;
export const SENSITIVE_ACTION_PIN_RATE_MAX_MISMATCHES = 12;

/** The voice surface a question needs. Registered by `CallSessionCore`. */
export interface SensitiveActionPinSession {
  readonly sessionId: Ulid;
  /** Speaks code-authored text on the relay. Never carries a candidate. */
  speak(text: string): Promise<void>;
}

/**
 * What `CallSessionCore` needs from the gate: register the surface, answer
 * whether a question is open, and hand it an utterance or keypad candidate.
 */
export interface SensitiveActionPinPort {
  attachSession(input: SensitiveActionPinSession): void;
  hasPendingPrompt(): boolean;
  submitSpoken(text: string, now: Date): Promise<void>;
  submitKeypad(digits: Uint8Array, now: Date): Promise<void>;
}

export interface SensitiveActionPinDependencies {
  readonly database: D1Database;
  /** The four digit secret, or null when the deployment has not set one. */
  readonly pin: string | null;
  readonly now?: () => Date;
  readonly newId?: () => Ulid;
  /** Test seam. Never set below the real answer time in production. */
  readonly promptTimeoutMs?: number;
}

/**
 * One open question.
 *
 * It deliberately does not carry the tool, capability or arguments hash: the
 * gate that asked is the only thing awaiting the answer, and it has already
 * bound the authorization it receives to the exact call. A question is never
 * answered for one call and spent on another because there is only ever one
 * question and one claimant in flight.
 */
interface PendingQuestion {
  readonly sessionId: Ulid;
  readonly principalId: string;
  attempts: number;
  settled: boolean;
  authorizationId: Ulid | null;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function isoDate(value: unknown): Date | null {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { return null; }
  return Number.isFinite(epochMs) ? new Date(epochMs) : null;
}

/** Four bytes compared without an early exit, so a wrong PIN leaks only its length. */
function candidateMatches(pin: string, digits: Uint8Array): boolean {
  if (digits.byteLength !== 4 || !/^[0-9]{4}$/u.test(pin)) return false;
  let difference = 0;
  for (let index = 0; index < 4; index += 1) {
    difference |= digits[index]! ^ pin.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The gate. Implements both the surface `CallSessionCore` registers and the
 * port `ToolAutonomyGate` asks, because they are two halves of one question
 * and splitting them would let a question open without a way to answer it.
 */
export class SensitiveActionPinGate implements SensitiveActionPinPort {
  readonly #database: D1Database;
  readonly #pin: string | null;
  readonly #now: () => Date;
  readonly #newId: () => Ulid;
  readonly #promptTimeoutMs: number;
  #session: SensitiveActionPinSession | null = null;
  #pending: PendingQuestion | null = null;

  constructor(dependencies: SensitiveActionPinDependencies) {
    const pin = dependencies.pin;
    if (pin !== null && !/^[0-9]{4}$/u.test(pin)) {
      throw new TypeError("sensitive_action_pin_configuration_invalid");
    }
    this.#database = dependencies.database;
    this.#pin = pin;
    this.#now = dependencies.now ?? (() => new Date());
    this.#newId = dependencies.newId ?? newUlid;
    this.#promptTimeoutMs = dependencies.promptTimeoutMs ?? SENSITIVE_ACTION_PIN_PROMPT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#promptTimeoutMs) || this.#promptTimeoutMs < 1) {
      throw new TypeError("sensitive_action_pin_configuration_invalid");
    }
  }

  attachSession(input: SensitiveActionPinSession): void {
    this.#session = Object.freeze({ sessionId: input.sessionId, speak: input.speak });
  }

  hasPendingPrompt(): boolean {
    return this.#pending !== null && !this.#pending.settled;
  }

  /**
   * A single-use authorization id, or null when this call cannot authorize the
   * action.
   *
   * Null is the answer for every condition this service does not own: no PIN
   * configured, no session attached, a question already open, or a wrong PIN
   * that ran out of attempts. The caller treats null as "no authorization
   * here", which leaves the tap route open and never runs the tool.
   */
  async authorizeToolCall(request: Readonly<{
    readonly principalId: string;
    readonly toolName: string;
    readonly capability: string;
    readonly argumentsHash: string;
  }>): Promise<string | null> {
    const session = this.#session;
    const pin = this.#pin;
    if (session === null || pin === null || this.#pending !== null) return null;
    const now = isoDate(this.#now());
    if (now === null) return null;
    if (await this.#rateLimited(request.principalId, now)) {
      await this.#speak(SENSITIVE_ACTION_PIN_RATE_LIMITED);
      return null;
    }

    let resolve!: () => void;
    const answered = new Promise<void>((settle) => { resolve = settle; });
    const pending: PendingQuestion = {
      sessionId: session.sessionId,
      principalId: request.principalId,
      attempts: 0,
      settled: false,
      authorizationId: null,
      resolve,
      timer: null,
    };
    this.#pending = pending;
    try {
      await this.#speak(SENSITIVE_ACTION_PIN_PROMPT);
      await Promise.race([
        answered,
        new Promise<void>((expire) => {
          pending.timer = setTimeout(expire, this.#promptTimeoutMs);
        }),
      ]);
      // A timeout settles nothing, so the caller gets null and the action is
      // refused rather than left waiting on a question nobody answered.
      if (!pending.settled) {
        pending.settled = true;
        await this.#speak(SENSITIVE_ACTION_PIN_EXPIRED);
      }
      return pending.authorizationId;
    } finally {
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (this.#pending === pending) this.#pending = null;
    }
  }

  /**
   * The spoken answer. Never stored and never echoed: the only thing that
   * leaves this method is code-authored speech.
   */
  async submitSpoken(text: string, now: Date): Promise<void> {
    const pending = this.#pending;
    if (pending === null || pending.settled) return;
    // "cancel" and "stop" are control words of this prompt, like "confirm" is a
    // control word of the owner-access prompt. They are not an interpretation
    // of intent; the question named them.
    if (text === "cancel" || text === "stop") {
      this.#settle(pending, null);
      await this.#speak(SENSITIVE_ACTION_PIN_CANCELLED);
      return;
    }
    const digits = normalizeSpokenPin(text);
    if (digits === null) {
      await this.#refuseOrReprompt(pending, SENSITIVE_ACTION_PIN_REPROMPT_UNREADABLE);
      return;
    }
    try {
      await this.#verify(pending, digits, now);
    } finally {
      digits.fill(0);
    }
  }

  /** Four digits from the keypad. An equal alternative to speech. */
  async submitKeypad(digits: Uint8Array, now: Date): Promise<void> {
    const pending = this.#pending;
    try {
      if (pending === null || pending.settled) return;
      await this.#verify(pending, digits, now);
    } finally {
      digits.fill(0);
    }
  }

  async #verify(pending: PendingQuestion, digits: Uint8Array, now: Date): Promise<void> {
    if (candidateMatches(this.#pin ?? "", digits)) {
      // The authorization id is minted here and handed straight to the gate
      // that is awaiting it. It is never written down, so it cannot be replayed
      // and it cannot outlive this call.
      const authorizationId = this.#newId();
      this.#settle(pending, authorizationId);
      return;
    }
    try {
      await this.#recordMismatch(pending, now);
    } catch {
      // The wrong-candidate ledger could not be written, so the cost of the
      // guess cannot be counted. Refusing is the safe direction: it fails
      // closed without ending the call over a store outage.
      this.#settle(pending, null);
      await this.#speak(SENSITIVE_ACTION_PIN_REFUSED);
      return;
    }
    await this.#refuseOrReprompt(pending, SENSITIVE_ACTION_PIN_REPROMPT_WRONG);
  }

  async #refuseOrReprompt(pending: PendingQuestion, reprompt: string): Promise<void> {
    pending.attempts += 1;
    if (pending.attempts >= SENSITIVE_ACTION_PIN_MAX_ATTEMPTS) {
      this.#settle(pending, null);
      await this.#speak(SENSITIVE_ACTION_PIN_REFUSED);
      return;
    }
    await this.#speak(reprompt);
  }

  #settle(pending: PendingQuestion, authorizationId: Ulid | null): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.authorizationId = authorizationId;
    pending.resolve();
  }

  /** One row per wrong candidate. No candidate reaches the row. */
  async #recordMismatch(pending: PendingQuestion, now: Date): Promise<void> {
    const at = isoDate(now);
    if (at === null) return;
    await this.#database.prepare(`INSERT INTO sensitive_action_pin_attempts (
      attempt_id, session_id, owner_principal_id, attempted_at, outcome
    ) VALUES (?, ?, ?, ?, 'mismatched')`).bind(
      this.#newId(), pending.sessionId, pending.principalId, at.toISOString(),
    ).run();
  }

  async #rateLimited(principalId: string, now: Date): Promise<boolean> {
    const notBefore = new Date(now.valueOf() - SENSITIVE_ACTION_PIN_RATE_WINDOW_MS).toISOString();
    const row = await this.#database.prepare(`SELECT count(*) AS count
      FROM sensitive_action_pin_attempts
      WHERE owner_principal_id = ? AND outcome = 'mismatched' AND attempted_at > ?`)
      .bind(principalId, notBefore).first<{ count: number }>();
    return (row?.count ?? 0) >= SENSITIVE_ACTION_PIN_RATE_MAX_MISMATCHES;
  }

  /** A relay that cannot speak must not turn into a crash or a verdict. */
  async #speak(text: string): Promise<void> {
    const session = this.#session;
    if (session === null) return;
    try { await session.speak(text); }
    catch { /* The question stays open; the timeout refuses the action. */ }
  }
}
