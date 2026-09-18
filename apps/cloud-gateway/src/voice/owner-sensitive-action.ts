/**
 * The gate a sensitive action passes through on a call.
 *
 * Nothing here is asked at the start of a call. Sid's decision on 2026-09-17
 * was that an always-on gate costs more than it buys, so the question is asked
 * once, immediately before the action, about that action: the explanation of
 * what is being authorised, the two-minute window it is open for, and the
 * receipt naming the capability, the credential and the version that
 * satisfied it. A receipt is spent by the action it authorised, so a
 * successful PIN authorises that action rather than the rest of the call.
 *
 * Either credential is accepted. The four-digit PIN is the primary one
 * because digits are easier to recognise than three words and the keypad is
 * always available; the three-word phrase remains valid because it was
 * already spoken into this system and taking it away would break a credential
 * Sid holds.
 *
 * A failed attempt is far more likely to be a mis-hearing than an attack.
 * Five attempts are allowed, every re-prompt says something different, the
 * keypad is offered as soon as it would help, and running out never ends the
 * call: the action is refused and the caller can ask again.
 *
 * No candidate reaches a row, a log, a receipt or an event. The digits live
 * in a Uint8Array that the verifier zeroises, and the tables this writes to
 * have no column a candidate could occupy. See 0034.
 */

import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { AutonomyServiceContract } from "../autonomy/autonomy-types.js";
import { isSensitiveAction, type CapabilityTierReader } from "../autonomy/sensitive-action.js";
import {
  canonicalizeOwnerPassphrase,
  decodeOwnerPassphraseVerifierRecord,
  OwnerPassphraseVerifier,
  type OwnerPassphraseVerifierRecordV1,
} from "../security/owner-passphrase-verifier.js";
import {
  decodeOwnerCallPinVerifierRecord,
  OwnerCallPinVerifier,
  type OwnerCallPinVerifierRecordV1,
} from "../security/owner-call-pin-verifier.js";
import { readSpokenPin } from "./owner-call-pin-speech.js";

export const OWNER_ACTION_WINDOW_MS = 120_000;
export const OWNER_ACTION_MAX_ATTEMPTS = 5;
export const OWNER_ACTION_PIN_PROMPT = "Say your four digit PIN, or key it in.";
export const OWNER_ACTION_AUTHORISED = "Thank you. Going ahead.";
export const OWNER_ACTION_REFUSED = "I have not done that, and nothing was changed. Ask me again when you want to.";
export const OWNER_ACTION_EXPIRED = "That took too long, so I have not done it. Ask me again if you still want it.";

export const OWNER_ACTION_REPROMPT_SPEECH: Readonly<Record<OwnerActionReprompt, string>> = Object.freeze({
  unclear: "I did not catch that. Say the four digits again, or key them in.",
  partial: "I did not hear four digits. Say them again, or key them in.",
  wrong: "That was not it. Try the four digits again, or use the keypad.",
  keypad: "Let us use the keypad instead. Key in four digits now.",
});

export type OwnerActionCredential = "call_pin" | "owner_passphrase";
export type OwnerActionReprompt = "unclear" | "partial" | "wrong" | "keypad";
export type OwnerActionAttemptMethod = "spoken_pin" | "spoken_passphrase" | "spoken_unreadable" | "keypad";

/**
 * What a candidate is, settled before a key is derived: the method the
 * attempt row records, and the one value the verifier will compare.
 */
type CandidatePlan =
  | Readonly<{ kind: "keypad"; method: "keypad"; digits: Uint8Array }>
  | Readonly<{ kind: "pin"; method: "spoken_pin"; digits: Uint8Array }>
  | Readonly<{ kind: "passphrase"; method: "spoken_passphrase"; text: string }>
  | Readonly<{ kind: "unreadable"; method: "spoken_unreadable"; reprompt: OwnerActionReprompt }>;

export type OwnerActionBegin =
  | Readonly<{ kind: "prompt"; requestId: Ulid; capability: string; explanation: string }>
  | Readonly<{ kind: "not_sensitive" }>
  | Readonly<{ kind: "exhausted"; speech: string }>
  | Readonly<{ kind: "unavailable" }>;

export type OwnerActionSubmit =
  | Readonly<{ kind: "authorised"; authorisationId: Ulid; credential: OwnerActionCredential }>
  | Readonly<{ kind: "reprompt"; reprompt: OwnerActionReprompt; speech: string }>
  | Readonly<{ kind: "refused"; speech: string }>
  | Readonly<{ kind: "expired"; speech: string }>;

export interface OwnerSensitiveActionDependencies {
  readonly database: D1Database;
  readonly tiers: CapabilityTierReader;
  readonly autonomy: AutonomyServiceContract;
  readonly pinVerifier: OwnerCallPinVerifier;
  readonly passphraseVerifier: OwnerPassphraseVerifier;
  readonly now?: () => Date;
  readonly newId?: () => Ulid;
}

interface RequestRow {
  request_id: string;
  session_id: string;
  outcome: string | null;
  deadline_at: string;
  capability: string;
  evaluation_id: string;
  owner_principal_id: string;
  owner_identity_id: string;
}

interface VerifierRow {
  pin_version: number;
  algorithm: string;
  domain_version: string;
  pepper_version: string;
  iterations: number;
  salt: ArrayBuffer;
  digest: ArrayBuffer;
}

interface PassphraseVerifierRow {
  verifier_version: number;
  algorithm: string;
  domain_version: string;
  word_list_version: string;
  pepper_version: string;
  iterations: number;
  salt: ArrayBuffer;
  digest: ArrayBuffer;
}

/** The four ways a re-prompt may differ, in the order this prefers to reach for them. */
const REPROMPT_ORDER: readonly OwnerActionReprompt[] = Object.freeze(["wrong", "partial", "unclear", "keypad"]);

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new TypeError("owner_action_input_invalid");
  return value.toISOString();
}

function boundedExplanation(value: string): string {
  const points = Array.from(value);
  return points.length <= 256 ? value : points.slice(0, 256).join("");
}

export class OwnerSensitiveActionService {
  readonly #database: D1Database;
  readonly #tiers: CapabilityTierReader;
  readonly #autonomy: AutonomyServiceContract;
  readonly #pinVerifier: OwnerCallPinVerifier;
  readonly #passphraseVerifier: OwnerPassphraseVerifier;
  readonly #now: () => Date;
  readonly #newId: () => Ulid;

  constructor(dependencies: OwnerSensitiveActionDependencies) {
    const { database, tiers, autonomy, pinVerifier, passphraseVerifier } = dependencies;
    if (database === null || typeof database !== "object"
      || tiers === null || typeof tiers !== "object" || typeof tiers.readCapabilityTier !== "function"
      || autonomy === null || typeof autonomy !== "object" || typeof autonomy.evaluate !== "function"
      || !(pinVerifier instanceof OwnerCallPinVerifier)
      || !(passphraseVerifier instanceof OwnerPassphraseVerifier)) {
      throw new TypeError("owner_sensitive_action_configuration_invalid");
    }
    this.#database = database;
    this.#tiers = tiers;
    this.#autonomy = autonomy;
    this.#pinVerifier = pinVerifier;
    this.#passphraseVerifier = passphraseVerifier;
    this.#now = dependencies.now ?? (() => new Date());
    this.#newId = dependencies.newId ?? newUlid;
  }

  /** True for every capability `capability_tiers` stores at tier 3, and no others. */
  async isSensitive(capability: string): Promise<boolean> {
    return isSensitiveAction(await this.#tiers.readCapabilityTier(capability));
  }

  /**
   * Opens the question the caller is about to be asked. A capability that is
   * not sensitive is reported as such rather than prompted for: the gate is
   * the list, so a flow that asks here for something the list does not cover
   * would be a second list.
   */
  async begin(input: Readonly<{
    sessionId: Ulid;
    principalId: string;
    identityId: string;
    capability: string;
    summary: string;
  }>): Promise<OwnerActionBegin> {
    const now = this.#now();
    const at = iso(now);
    const evaluation = await this.#autonomy.evaluate({
      capability: input.capability,
      principalId: input.principalId,
      summary: input.summary,
    });
    if (evaluation.outcome !== "requires_confirmation") return Object.freeze({ kind: "not_sensitive" });

    const explanation = boundedExplanation(input.summary);
    const existing = await this.#openRequest(input.sessionId);
    if (existing !== null) {
      if (existing.deadline_at > at && existing.capability === input.capability) {
        return Object.freeze({
          kind: "prompt", requestId: existing.request_id as Ulid,
          capability: existing.capability, explanation,
        });
      }
      await this.#resolve(existing.request_id, "refused", at);
    }

    // The budget is per call, not per question. Five tries at four digits is
    // already a tenth of a percent; letting a second question start a second
    // five would make the question the caller repeats the one that resets the
    // guessing cost, and nothing about who is speaking would have changed.
    if (await this.#sessionAttempts(input.sessionId) >= OWNER_ACTION_MAX_ATTEMPTS) {
      return Object.freeze({ kind: "exhausted", speech: OWNER_ACTION_REFUSED });
    }

    const requestId = this.#newId();
    const deadlineAt = new Date(now.valueOf() + OWNER_ACTION_WINDOW_MS).toISOString();
    await this.#database.prepare(`INSERT INTO owner_action_requests (
      request_id, session_id, lifecycle_generation, owner_principal_id, owner_identity_id,
      capability, evaluation_id, explanation, opened_at, deadline_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).bind(
      requestId, input.sessionId, input.principalId, input.identityId,
      input.capability, evaluation.evaluationId, explanation, at, deadlineAt,
    ).run();
    return Object.freeze({
      kind: "prompt", requestId, capability: input.capability, explanation,
    });
  }

  /** A spoken candidate: four digits, the three-word phrase, or neither. */
  async submitSpoken(requestId: Ulid, text: string): Promise<OwnerActionSubmit> {
    return this.#submit(requestId, { kind: "spoken", text });
  }

  /** Four digits collected from the keypad. The array is zeroised either way. */
  async submitKeypad(requestId: Ulid, digits: Uint8Array): Promise<OwnerActionSubmit> {
    try {
      return await this.#submit(requestId, { kind: "keypad", digits });
    } finally {
      if (digits instanceof Uint8Array) digits.fill(0);
    }
  }

  /** The live, unspent receipt for exactly this capability, or null. */
  async liveReceipt(input: Readonly<{
    sessionId: Ulid;
    capability: string;
  }>): Promise<Readonly<{ authorisationId: string; expiresAt: string }> | null> {
    const at = iso(this.#now());
    const row = await this.#database.prepare(`SELECT authorisation_id, expires_at
      FROM owner_action_authorisations
      WHERE session_id = ? AND capability = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY authorised_at DESC LIMIT 1`).bind(input.sessionId, input.capability, at)
      .first<{ authorisation_id: string; expires_at: string }>();
    return row === null ? null : Object.freeze({ authorisationId: row.authorisation_id, expiresAt: row.expires_at });
  }

  /**
   * Spending is one-way and happens before the action runs. A receipt that
   * was consumed by an action which then failed is not reusable, which is the
   * conservative direction: the failure path asks again.
   */
  async consume(authorisationId: string): Promise<void> {
    await this.#database.prepare(
      "UPDATE owner_action_authorisations SET consumed_at = ? WHERE authorisation_id = ? AND consumed_at IS NULL",
    ).bind(iso(this.#now()), authorisationId).run();
  }

  /**
   * The caller changed their mind. The question is closed rather than left
   * open, so the next sensitive action opens a fresh two-minute window with
   * the whole attempt budget of this call already accounted for.
   */
  async cancel(requestId: Ulid): Promise<void> {
    await this.#resolve(requestId, "refused", iso(this.#now()));
  }

  async #openRequest(sessionId: Ulid): Promise<RequestRow | null> {
    return this.#database.prepare(`SELECT request_id, session_id, outcome, deadline_at, capability, evaluation_id,
      owner_principal_id, owner_identity_id
      FROM owner_action_requests WHERE session_id = ? AND outcome IS NULL`).bind(sessionId)
      .first<RequestRow>();
  }

  async #request(requestId: Ulid): Promise<RequestRow | null> {
    return this.#database.prepare(`SELECT request_id, session_id, outcome, deadline_at, capability, evaluation_id,
      owner_principal_id, owner_identity_id
      FROM owner_action_requests WHERE request_id = ?`).bind(requestId).first<RequestRow>();
  }

  async #resolve(requestId: string, outcome: "authorised" | "refused", at: string): Promise<void> {
    await this.#database.prepare(
      "UPDATE owner_action_requests SET outcome = ?, resolved_at = ? WHERE request_id = ? AND outcome IS NULL",
    ).bind(outcome, at, requestId).run();
  }

  async #submit(
    requestId: Ulid,
    candidate: Readonly<{ kind: "spoken"; text: string }> | Readonly<{ kind: "keypad"; digits: Uint8Array }>,
  ): Promise<OwnerActionSubmit> {
    const now = this.#now();
    const at = iso(now);
    const request = await this.#request(requestId);
    if (request === null || request.outcome !== null) {
      return Object.freeze({ kind: "refused", speech: OWNER_ACTION_REFUSED });
    }
    if (at >= request.deadline_at) {
      await this.#resolve(requestId, "refused", at);
      return Object.freeze({ kind: "expired", speech: OWNER_ACTION_EXPIRED });
    }

    // The ordinal is reserved before the chained verifier spends its work.
    // Verifying first would let a candidate that arrives while another is
    // still deriving pass the budget check too, so the effort of guessing
    // would stop being bounded by the five attempts this call is allowed. A
    // reservation that is never settled still counts, which is the
    // conservative direction for a failure in the middle of a derivation.
    const plan = this.#classifyCandidate(candidate);
    const ordinal = await this.#attemptCount(requestId) + 1;
    if (ordinal > OWNER_ACTION_MAX_ATTEMPTS) {
      await this.#resolve(requestId, "refused", at);
      return Object.freeze({ kind: "refused", speech: OWNER_ACTION_REFUSED });
    }
    try {
      await this.#database.prepare(`INSERT INTO owner_action_attempts (
        request_id, attempt_ordinal, method, outcome, attempted_at, resolved_at
      ) VALUES (?, ?, ?, NULL, ?, NULL)`).bind(requestId, ordinal, plan.method, at).run();
    } catch {
      // Another candidate took this ordinal while this one was reading, or
      // the question was settled underneath it. Either way there is no
      // attempt to spend, and the action is not authorised.
      await this.#resolve(requestId, "refused", at);
      return Object.freeze({ kind: "refused", speech: OWNER_ACTION_REFUSED });
    }

    const attempt = await this.#verifyCandidate(request, plan);
    await this.#database.prepare(`UPDATE owner_action_attempts
      SET outcome = ?, resolved_at = ? WHERE request_id = ? AND attempt_ordinal = ? AND outcome IS NULL`)
      .bind(attempt.outcome, at, requestId, ordinal).run();

    if (attempt.outcome === "matched" && attempt.credential !== null && attempt.credentialVersion !== null) {
      const authorisationId = this.#newId();
      const expiresAt = new Date(now.valueOf() + OWNER_ACTION_WINDOW_MS).toISOString();
      try {
        await this.#database.prepare(`INSERT INTO owner_action_authorisations (
          authorisation_id, request_id, session_id, lifecycle_generation, owner_principal_id, owner_identity_id,
          capability, evaluation_id, credential, credential_version, attempt_ordinal, authorised_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(
          authorisationId, requestId, request.session_id, request.owner_principal_id,
          request.owner_identity_id, request.capability, request.evaluation_id,
          attempt.credential, attempt.credentialVersion, ordinal, at, expiresAt,
        ).run();
      } catch (error) {
        throw new Error("owner_action_authorisation_failed", { cause: error });
      }
      return Object.freeze({ kind: "authorised", authorisationId, credential: attempt.credential });
    }

    const remaining = OWNER_ACTION_MAX_ATTEMPTS - ordinal;
    if (remaining <= 0) {
      return Object.freeze({ kind: "refused", speech: OWNER_ACTION_REFUSED });
    }
    const reprompt = await this.#recordReprompt(requestId, ordinal, attempt.reprompt);
    return Object.freeze({ kind: "reprompt", reprompt, speech: OWNER_ACTION_REPROMPT_SPEECH[reprompt] });
  }

  async #attemptCount(requestId: Ulid): Promise<number> {
    const row = await this.#database.prepare(
      "SELECT count(*) AS count FROM owner_action_attempts WHERE request_id = ?",
    ).bind(requestId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async #sessionAttempts(sessionId: Ulid): Promise<number> {
    const row = await this.#database.prepare(
      `SELECT count(*) AS count FROM owner_action_attempts attempt
       JOIN owner_action_requests request ON request.request_id = attempt.request_id
       WHERE request.session_id = ?`,
    ).bind(sessionId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  /** Everything about a candidate that can be known without deriving a key. */
  #classifyCandidate(
    candidate: Readonly<{ kind: "spoken"; text: string }> | Readonly<{ kind: "keypad"; digits: Uint8Array }>,
  ): CandidatePlan {
    if (candidate.kind === "keypad") {
      return Object.freeze({ kind: "keypad", method: "keypad", digits: candidate.digits });
    }
    const read = readSpokenPin(candidate.text);
    if (read.kind === "pin") {
      return Object.freeze({ kind: "pin", method: "spoken_pin", digits: read.digits });
    }
    const phrase = this.#readPassphrase(candidate.text);
    if (phrase !== null) {
      return Object.freeze({ kind: "passphrase", method: "spoken_passphrase", text: phrase });
    }
    return Object.freeze({
      kind: "unreadable", method: "spoken_unreadable",
      reprompt: read.kind === "partial" ? "partial" : "unclear",
    });
  }

  /**
   * One read of one candidate, and the only place a credential is compared.
   * The digits never leave this function: `readSpokenPin` hands back a
   * Uint8Array and both verifiers zeroise it before returning.
   */
  async #verifyCandidate(request: RequestRow, plan: CandidatePlan): Promise<Readonly<{
    method: OwnerActionAttemptMethod;
    outcome: "matched" | "mismatched" | "unusable";
    credential: OwnerActionCredential | null;
    credentialVersion: number | null;
    reprompt: OwnerActionReprompt;
  }>> {
    const identityId = request.owner_identity_id;
    if (plan.kind === "keypad" || plan.kind === "pin") {
      const version = await this.#activePinVersion(identityId);
      const record = version === null ? null : await this.#pinRecord(identityId, version);
      if (version === null || record === null) {
        plan.digits.fill(0);
        return this.#unusable(plan.method, "unclear");
      }
      const matched = await this.#pinVerifier.verify(identityId, plan.digits, record);
      return matched
        ? { method: plan.method, outcome: "matched", credential: "call_pin", credentialVersion: version, reprompt: "wrong" }
        : { method: plan.method, outcome: "mismatched", credential: null, credentialVersion: null, reprompt: "wrong" };
    }

    if (plan.kind === "passphrase") {
      const version = await this.#activePassphraseVersion(identityId);
      if (version === null) return this.#unusable(plan.method, "unclear");
      const record = await this.#passphraseRecord(identityId, version);
      if (record !== null && await this.#passphraseVerifier.verify(identityId, plan.text, record)) {
        return {
          method: plan.method, outcome: "matched", credential: "owner_passphrase",
          credentialVersion: version, reprompt: "wrong",
        };
      }
      return {
        method: plan.method, outcome: "mismatched", credential: null,
        credentialVersion: null, reprompt: "wrong",
      };
    }

    return this.#unusable(plan.method, plan.reprompt);
  }  #unusable(
    method: OwnerActionAttemptMethod,
    reprompt: OwnerActionReprompt,
  ): Readonly<{
    method: OwnerActionAttemptMethod;
    outcome: "unusable";
    credential: null;
    credentialVersion: null;
    reprompt: OwnerActionReprompt;
  }> {
    return { method, outcome: "unusable", credential: null, credentialVersion: null, reprompt };
  }

  /**
   * A phrase is only attempted when it already looks like one, so a garbled
   * digit read is never compared against the phrase and counted as a wrong
   * phrase.
   */
  #readPassphrase(text: string): string | null {
    let canonical: Uint8Array;
    try {
      canonical = canonicalizeOwnerPassphrase(text);
    } catch {
      return null;
    }
    canonical.fill(0);
    return text;
  }

  /**
   * A re-prompt is chosen by what went wrong and never repeats a sentence
   * already used on this question, which the schema refuses outright.
   */
  async #recordReprompt(requestId: Ulid, ordinal: number, preferred: OwnerActionReprompt): Promise<OwnerActionReprompt> {
    const used = await this.#database.prepare(
      "SELECT reprompt_kind FROM owner_action_reprompts WHERE request_id = ?",
    ).bind(requestId).all<{ reprompt_kind: string }>();
    const taken = new Set(used.results.map((row) => row.reprompt_kind));
    const chosen = taken.has(preferred) ? REPROMPT_ORDER.find((kind) => !taken.has(kind)) : preferred;
    if (chosen === undefined) return preferred;
    await this.#database.prepare(`INSERT INTO owner_action_reprompts (
      request_id, reprompt_ordinal, reprompt_kind, prompted_at
    ) VALUES (?, ?, ?, ?)`).bind(requestId, ordinal, chosen, iso(this.#now())).run();
    return chosen;
  }

  async #activePinVersion(identityId: string): Promise<number | null> {
    const row = await this.#database.prepare(`SELECT head.pin_version AS pin_version
      FROM owner_call_pin_heads head
      JOIN owner_call_pin_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id AND verifier.pin_version = head.pin_version
      WHERE head.singleton_id = 1 AND head.owner_identity_id = ? AND verifier.status = 'active'`)
      .bind(identityId).first<{ pin_version: number }>();
    return row?.pin_version ?? null;
  }

  async #pinRecord(identityId: string, version: number): Promise<OwnerCallPinVerifierRecordV1 | null> {
    const row = await this.#database.prepare(`SELECT pin_version, algorithm, domain_version, pepper_version,
      iterations, salt, digest FROM owner_call_pin_verifiers
      WHERE owner_identity_id = ? AND pin_version = ? AND status = 'active'`)
      .bind(identityId, version).first<VerifierRow>();
    if (row === null) return null;
    try {
      return decodeOwnerCallPinVerifierRecord({
        schemaVersion: "1.0",
        algorithm: row.algorithm,
        domainVersion: row.domain_version,
        pepperVersion: row.pepper_version,
        iterations: row.iterations,
        verifierVersion: row.pin_version,
        saltBase64: base64(row.salt),
        digestBase64: base64(row.digest),
      });
    } catch {
      return null;
    }
  }

  async #activePassphraseVersion(identityId: string): Promise<number | null> {
    const row = await this.#database.prepare(`SELECT head.verifier_version AS verifier_version
      FROM owner_passphrase_heads head
      JOIN owner_passphrase_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id
        AND verifier.verifier_version = head.verifier_version
      WHERE head.singleton_id = 1 AND head.owner_identity_id = ?
        AND head.status = 'active' AND verifier.status = 'active'`)
      .bind(identityId).first<{ verifier_version: number }>();
    return row?.verifier_version ?? null;
  }

  async #passphraseRecord(identityId: string, version: number): Promise<OwnerPassphraseVerifierRecordV1 | null> {
    const row = await this.#database.prepare(`SELECT verifier_version, algorithm, domain_version,
      word_list_version, pepper_version, iterations, salt, digest FROM owner_passphrase_verifiers
      WHERE owner_identity_id = ? AND verifier_version = ? AND status = 'active'`)
      .bind(identityId, version).first<PassphraseVerifierRow>();
    if (row === null) return null;
    try {
      return decodeOwnerPassphraseVerifierRecord({
        schemaVersion: "1.0",
        algorithm: row.algorithm,
        domainVersion: row.domain_version,
        wordListVersion: row.word_list_version,
        pepperVersion: row.pepper_version,
        iterations: row.iterations,
        verifierVersion: row.verifier_version,
        saltBase64: base64(row.salt),
        digestBase64: base64(row.digest),
      });
    } catch {
      return null;
    }
  }
}
