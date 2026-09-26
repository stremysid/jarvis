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
 * The question belongs to the turn that asked. When that turn ends -- the
 * call hangs up, the turn is cancelled -- the question closes with a refusal,
 * and `ToolAutonomyGate` and the agent core both re-check the turn before any
 * tool body runs. A PIN said after that can never run the action.
 *
 * The PIN itself is a Cloudflare Worker secret (`OWNER_ACTION_PIN`), like the
 * peppers already used for the guest PIN and the owner passphrase. Reviewer
 * decision on #196 round 2, under Sid's minimal-security rule: a plain secret
 * is acceptable. What this module owes it instead is that it is compared in
 * constant time (`candidateMatches`), never logged, never stored and never
 * spoken back. What is stored is the attempt ledger, which holds an outcome
 * and a timestamp and no candidate.
 */

import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { CHANNEL_REFUSED, type ToolChannelAuthorization } from "../autonomy/tool-gate.js";
import { normalizeSpokenPin, pinAnswerWords } from "./pin-capture.js";

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
/** Spoken when four digits arrive just after a question closed without them. */
export const SENSITIVE_ACTION_PIN_TOO_LATE =
  "That came too late, so nothing was done. Ask me again if you still want it.";

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
 * How long each attempt waits for an answer before the question refuses.
 *
 * Per attempt, not per question: the timer is re-armed after every re-prompt,
 * so five slow tries all get the full wait. It starts when the prompt is sent,
 * and the prompt itself takes a few seconds to play, so this leaves Sid well
 * over ten seconds to answer each time. The owner-agent turn clock is held
 * while a question is open (`ToolGateTurn.holdDeadline`), so this timer, not
 * the turn budget, decides. The whole question is still bounded: at most
 * `MAX_ATTEMPTS` of these.
 */
export const SENSITIVE_ACTION_PIN_PROMPT_TIMEOUT_MS = 20_000;

/**
 * How long after a question closes an utterance of four digits is still
 * treated as an answer to it.
 *
 * A PIN said just after the timeout, or while the refusal is being spoken, is
 * still the credential. Without this window it became an ordinary utterance:
 * a conversation turn, a transcript row and model input -- or, if the turn
 * was still running, a "turn in progress" error that ended the call.
 */
export const SENSITIVE_ACTION_PIN_LATE_GRACE_MS = 10_000;

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
  /** Told when a question opens, so keypad digits from before it are dropped. */
  questionOpened?(): void;
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
  /**
   * True when `text` is four digits said just after a question closed, in
   * which case it has been consumed and must not become a turn.
   */
  claimLateAnswer(text: string, now: Date): Promise<boolean>;
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
  /** Resolves the current attempt's wait as expired. */
  expire: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Read through a call so a check after an await is not narrowed away. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Whether an answer at the prompt is the prompt's own "cancel".
 *
 * The prompt tells Sid to say cancel, so any form of that word -- "Cancel.",
 * "cancel that", "cancelled" -- closes the question, as does the whole answer
 * "stop". These are the prompt's control words, not a reading of what he
 * meant: an answer holding "cancel" cannot be a PIN.
 */
function isCancelAnswer(words: readonly string[]): boolean {
  return words.some((word) => /^cancel(?:l?ed|l?ing|s)?$/u.test(word))
    || words.length === 1 && words[0] === "stop";
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
  /** When the last question closed, and whether it closed authorized. */
  #lastClosed: Readonly<{ at: number; authorized: boolean }> | null = null;

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
    this.#session = Object.freeze({
      sessionId: input.sessionId,
      speak: input.speak,
      ...(input.questionOpened === undefined ? {} : { questionOpened: input.questionOpened }),
    });
  }

  hasPendingPrompt(): boolean {
    return this.#pending !== null && !this.#pending.settled;
  }

  /**
   * A single-use authorization id; `CHANNEL_REFUSED` when Sid was asked and
   * did not authorize; or null when this call cannot ask at all.
   *
   * Null covers every condition in which no question was put to him: no PIN
   * configured, no session attached, or a question already open. The gate
   * then keeps the tap route open. `CHANNEL_REFUSED` covers a question he
   * cancelled, ran out of attempts on or did not answer, a rate-limited
   * question, and a question whose turn ended: the action is not done, and he
   * is not also sent to Telegram for something he just declined.
   */
  async authorizeToolCall(request: Readonly<{
    readonly principalId: string;
    readonly toolName: string;
    readonly capability: string;
    readonly argumentsHash: string;
    readonly signal?: AbortSignal;
  }>): Promise<ToolChannelAuthorization> {
    const session = this.#session;
    const pin = this.#pin;
    if (session === null || pin === null || this.#pending !== null) return null;
    const signal = request.signal;
    const now = isoDate(this.#now());
    if (now === null) return null;
    if (await this.#rateLimited(request.principalId, now)) {
      await this.#speak(SENSITIVE_ACTION_PIN_RATE_LIMITED);
      return CHANNEL_REFUSED;
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
      expire: null,
      timer: null,
    };
    // The turn that asked has ended: close the question silently. Nothing is
    // spoken because the turn's audio is already gone, and the authorization
    // stays null, so a PIN said after this cannot run the action.
    const onAbort = (): void => { this.#settle(pending, null); };
    this.#pending = pending;
    this.#lastClosed = null;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session.questionOpened?.();
      // A turn that ended before the listener existed (already over on
      // arrival, or during the rate-limit read) is caught here: the question
      // closes before anything is spoken.
      if (signalAborted(signal)) this.#settle(pending, null);
      if (!pending.settled) await this.#speak(SENSITIVE_ACTION_PIN_PROMPT);
      const expired = new Promise<void>((expire) => { pending.expire = expire; });
      this.#armAttemptTimer(pending);
      await Promise.race([answered, expired]);
      // A timeout settles nothing, so the caller is refused rather than left
      // waiting on a question nobody answered.
      if (!pending.settled) {
        this.#settle(pending, null);
        await this.#speak(SENSITIVE_ACTION_PIN_EXPIRED);
      }
      return pending.authorizationId ?? CHANNEL_REFUSED;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      if (this.#pending === pending) this.#pending = null;
    }
  }

  /**
   * Four digits said just after a question closed. Consumed, so the credential
   * never becomes a turn, and answered with a fixed sentence when the question
   * had not been authorized. After an authorized question it is consumed
   * silently: the action's own receipt is what Sid needs to hear.
   */
  async claimLateAnswer(text: string, now: Date): Promise<boolean> {
    if (this.hasPendingPrompt()) return false;
    const closed = this.#lastClosed;
    const at = isoDate(now);
    if (closed === null || at === null) return false;
    const elapsed = at.valueOf() - closed.at;
    if (elapsed < 0 || elapsed > SENSITIVE_ACTION_PIN_LATE_GRACE_MS) return false;
    const digits = normalizeSpokenPin(text);
    if (digits === null) return false;
    digits.fill(0);
    if (!closed.authorized) await this.#speak(SENSITIVE_ACTION_PIN_TOO_LATE);
    return true;
  }

  /**
   * The spoken answer. Never stored and never echoed: the only thing that
   * leaves this method is code-authored speech.
   */
  async submitSpoken(text: string, now: Date): Promise<void> {
    const pending = this.#pending;
    if (pending === null || pending.settled) return;
    if (typeof text === "string" && isCancelAnswer(pinAnswerWords(text))) {
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
    // Each attempt gets the full wait. A single timer for the whole question
    // left about two tries once the re-prompts had been spoken.
    this.#armAttemptTimer(pending);
  }

  #armAttemptTimer(pending: PendingQuestion): void {
    if (pending.settled) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    const expire = pending.expire;
    pending.timer = expire === null ? null : setTimeout(expire, this.#promptTimeoutMs);
  }

  #settle(pending: PendingQuestion, authorizationId: Ulid | null): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.authorizationId = authorizationId;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    const closedAt = isoDate(this.#now());
    this.#lastClosed = closedAt === null
      ? null
      : Object.freeze({ at: closedAt.valueOf(), authorized: authorizationId !== null });
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
