import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { TelegramProvider, TelegramSendMessageResult } from "../providers/provider-types.js";
import {
  canonicalizeOwnerPassphrase,
  decodeOwnerPassphraseVerifierRecord,
  OwnerPassphraseVerifier,
  type OwnerPassphraseVerifierRecordV1,
} from "../security/owner-passphrase-verifier.js";

export const OWNER_STEP_UP_PROMPT = "Passphrase, please.";
export const OWNER_STEP_UP_RETRY_PROMPT = "Please try your passphrase again.";
export const OWNER_STEP_UP_FORMAT_PROMPT = "Please say only your passphrase.";
export const OWNER_STEP_UP_VERIFIED = "Verified.";
export const OWNER_STEP_UP_REJECTED = "Verification failed. Ending this call.";
export const OWNER_STEP_UP_HANDOFF_DATA = "jarvis:owner-step-up-rejected:v1";
export const OWNER_STEP_UP_WINDOW_MS = 60_000;
export const OWNER_STEP_UP_ASSEMBLY_MS = 1_500;
export const OWNER_STEP_UP_REPEAT_MS = 2_000;
export const OWNER_STEP_UP_REPEAT_FRAGMENT_MS = OWNER_STEP_UP_REPEAT_MS + OWNER_STEP_UP_ASSEMBLY_MS;

export type OwnerCallerIdPolicy = "passphrase_always" | "waive_on_passed_a" | "invalid";
export type OwnerAttestationClass = "passed_a" | "absent" | "other" | "not_applicable";
export type OwnerStepUpRequirement = "required" | "waived_passed_a" | "not_applicable";

export interface OwnerStepUpBindingSnapshot {
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly ownerPrincipalId: string;
  readonly ownerIdentityId: string;
  readonly direction: "inbound" | "outbound";
  readonly lifecycleGeneration: 1;
  readonly requirement: OwnerStepUpRequirement;
  readonly attestationClass: OwnerAttestationClass;
  readonly policy: OwnerCallerIdPolicy | "not_applicable";
  readonly createdAt: string;
}

interface BindingRow {
  session_id: string;
  call_sid: string;
  owner_principal_id: string;
  owner_identity_id: string;
  direction: string;
  lifecycle_generation: number;
  requirement: string;
  attestation_class: string;
  policy: string;
  created_at: string;
}

interface VerifierRow {
  verifier_version: number;
  algorithm: string;
  domain_version: string;
  word_list_version: string;
  pepper_version: string;
  iterations: number;
  salt: ArrayBuffer;
  digest: ArrayBuffer;
  prompted_at: string;
  deadline_at: string;
}

interface StepUpStateRow extends BindingRow {
  prompted_at: string | null;
  deadline_at: string | null;
  verifier_version: number | null;
  attempts: number;
  reprompts: number;
  success_at: string | null;
  rejection_reason: string | null;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new TypeError("owner_step_up_input_invalid");
  return value.toISOString();
}

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindingFrom(row: BindingRow | null): OwnerStepUpBindingSnapshot | null {
  if (row === null) return null;
  if ((row.direction !== "inbound" && row.direction !== "outbound") || row.lifecycle_generation !== 1) {
    throw new Error("owner_step_up_state_invalid");
  }
  return Object.freeze({
    sessionId: row.session_id as Ulid,
    callSid: row.call_sid,
    ownerPrincipalId: row.owner_principal_id,
    ownerIdentityId: row.owner_identity_id,
    direction: row.direction,
    lifecycleGeneration: 1,
    requirement: row.requirement as OwnerStepUpRequirement,
    attestationClass: row.attestation_class as OwnerAttestationClass,
    policy: row.policy as OwnerStepUpBindingSnapshot["policy"],
    createdAt: row.created_at,
  });
}

/** Parse one signed Twilio form field exactly. Duplicates are refused by returning null. */
export function classifyOwnerAttestation(values: readonly string[]): OwnerAttestationClass | null {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return null;
  if (values.length > 1) return null;
  if (values.length === 0) return "absent";
  return values[0] === "TN-Validation-Passed-A" ? "passed_a" : "other";
}

/** Missing and unknown values fail closed. The caller logs the fixed warning for invalid. */
export function classifyOwnerCallerIdPolicy(value: unknown): OwnerCallerIdPolicy {
  if (value === "waive_on_passed_a") return value;
  if (value === "passphrase_always" || value === undefined) return "passphrase_always";
  return "invalid";
}

export function ownerStepUpRequirement(
  direction: "inbound" | "outbound",
  policy: OwnerCallerIdPolicy,
  attestation: OwnerAttestationClass,
): OwnerStepUpRequirement {
  return direction === "inbound" && policy === "waive_on_passed_a" && attestation === "passed_a"
    ? "waived_passed_a"
    : "required";
}

/** Persistence and KDF boundary. Candidate material exists only in local variables and is never stored. */
export class OwnerCallStepUpService {
  readonly #database: D1Database;
  readonly #verifier: OwnerPassphraseVerifier;

  constructor(database: D1Database, verifier: OwnerPassphraseVerifier) {
    if (database === null || typeof database !== "object" || !(verifier instanceof OwnerPassphraseVerifier)) {
      throw new TypeError("owner_step_up_configuration_invalid");
    }
    this.#database = database;
    this.#verifier = verifier;
  }

  async bind(input: OwnerStepUpBindingSnapshot): Promise<OwnerStepUpBindingSnapshot> {
    const existing = await this.binding(input.sessionId);
    if (existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new Error("owner_step_up_binding_conflict");
      return existing;
    }
    await this.#database.prepare(`INSERT INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).bind(
      input.sessionId, input.callSid, input.ownerPrincipalId, input.ownerIdentityId,
      input.direction, input.requirement, input.attestationClass, input.policy, input.createdAt,
    ).run();
    const stored = await this.binding(input.sessionId);
    if (stored === null || JSON.stringify(stored) !== JSON.stringify(input)) {
      throw new Error("owner_step_up_binding_conflict");
    }
    return stored;
  }

  async binding(sessionId: Ulid): Promise<OwnerStepUpBindingSnapshot | null> {
    return bindingFrom(await this.#database.prepare(
      "SELECT * FROM owner_call_step_up_bindings WHERE session_id = ?",
    ).bind(sessionId).first<BindingRow>());
  }

  async begin(sessionId: Ulid, now: Date): Promise<{ readonly deadlineAt: string; readonly verifierVersion: number }> {
    const existing = await this.#activeVerifier(sessionId);
    if (existing !== null) {
      return Object.freeze({ deadlineAt: existing.deadline_at, verifierVersion: existing.verifier_version });
    }
    if (await this.#recordDisabledRejection(sessionId, now)) throw new Error("owner_step_up_disabled");
    const promptedAt = iso(now);
    const deadlineAt = new Date(now.valueOf() + OWNER_STEP_UP_WINDOW_MS).toISOString();
    const head = await this.#database.prepare(`SELECT head.verifier_version
      FROM owner_passphrase_heads head
      JOIN owner_passphrase_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
      WHERE head.singleton_id = 1 AND head.status = 'active' AND verifier.status = 'active'`)
      .first<{ verifier_version: number }>();
    if (head === null) throw new Error("owner_step_up_unavailable");
    try {
      await this.#database.prepare(`INSERT INTO owner_call_step_up_windows (
        session_id, lifecycle_generation, verifier_version, prompted_at, deadline_at
      ) VALUES (?, 1, ?, ?, ?)`)
        .bind(sessionId, head.verifier_version, promptedAt, deadlineAt).run();
    } catch (error) {
      if (await this.#recordDisabledRejection(sessionId, now)) throw new Error("owner_step_up_disabled");
      throw error;
    }
    const row = await this.#database.prepare(`SELECT verifier_version, deadline_at
      FROM owner_call_step_up_windows WHERE session_id = ? AND lifecycle_generation = 1`)
      .bind(sessionId).first<{ verifier_version: number; deadline_at: string }>();
    if (row === null) throw new Error("owner_step_up_unavailable");
    return Object.freeze({ deadlineAt: row.deadline_at, verifierVersion: row.verifier_version });
  }

  async verifyCandidate(
    sessionId: Ulid,
    candidate: string,
    now: Date,
  ): Promise<"matched" | "mismatched" | "rejected" | "expired" | "not_candidate"> {
    let canonical: Uint8Array;
    try { canonical = canonicalizeOwnerPassphrase(candidate); }
    catch { return "not_candidate"; }
    canonical.fill(0);
    const at = iso(now);
    const row = await this.#activeVerifier(sessionId);
    if (row === null) {
      if (await this.#recordDisabledRejection(sessionId, now) || await this.#hasRejection(sessionId)) return "rejected";
      throw new Error("owner_step_up_unavailable");
    }
    if (at >= row.deadline_at) return "expired";
    const count = await this.#database.prepare(`SELECT count(*) AS count FROM owner_call_step_up_attempts
      WHERE session_id = ? AND lifecycle_generation = 1`).bind(sessionId).first<{ count: number }>();
    const ordinal = (count?.count ?? 0) + 1;
    if (ordinal > 3) return "rejected";
    // This durable ordinal is committed before the expensive verifier starts.
    try {
      await this.#database.prepare(`INSERT INTO owner_call_step_up_attempts (
        session_id, lifecycle_generation, attempt_ordinal, verifier_version, attempted_at, outcome, resolved_at
      ) VALUES (?, 1, ?, ?, ?, NULL, NULL)`)
        .bind(sessionId, ordinal, row.verifier_version, at).run();
    } catch (error) {
      if (await this.#recordDisabledRejection(sessionId, now)) return "rejected";
      throw error;
    }
    let matched = false;
    try { matched = await this.#verifier.verify((await this.#requiredBinding(sessionId)).ownerIdentityId, candidate, this.#record(row)); }
    finally { candidate = ""; }
    const resolvedAt = iso(now);
    try {
      await this.#database.prepare(`UPDATE owner_call_step_up_attempts SET outcome = ?, resolved_at = ?
        WHERE session_id = ? AND lifecycle_generation = 1 AND attempt_ordinal = ? AND outcome IS NULL`)
        .bind(matched ? "matched" : "mismatched", resolvedAt, sessionId, ordinal).run();
    } catch (error) {
      if (await this.#recordDisabledRejection(sessionId, now)) return "rejected";
      throw error;
    }
    if (matched) return "matched";
    return ordinal === 3 ? "rejected" : "mismatched";
  }

  async recordReprompt(sessionId: Ulid, now: Date): Promise<"reprompt" | "rejected" | "expired"> {
    const at = iso(now);
    const state = await this.reconcileState(sessionId, now);
    if (state.rejectionReason !== null) return "rejected";
    if (state.deadlineAt === null || at >= state.deadlineAt) return "expired";
    const ordinal = state.reprompts + 1;
    if (ordinal > 3) return "rejected";
    await this.#database.prepare(`INSERT INTO owner_call_step_up_reprompts (
      session_id, lifecycle_generation, reprompt_ordinal, prompted_at
    ) VALUES (?, 1, ?, ?)`).bind(sessionId, ordinal, at).run();
    return ordinal === 3 ? "rejected" : "reprompt";
  }

  async expire(sessionId: Ulid, now: Date): Promise<void> {
    const existing = await this.#database.prepare(
      "SELECT session_id FROM owner_call_step_up_rejections WHERE session_id = ?",
    ).bind(sessionId).first<{ session_id: string }>();
    if (existing !== null) return;
    await this.#database.prepare(`INSERT INTO owner_call_step_up_rejections (
      session_id, lifecycle_generation, reason, rejected_at
    ) VALUES (?, 1, 'deadline_expired', ?)`)
      .bind(sessionId, iso(now)).run();
  }

  async assertWaiverAvailable(sessionId: Ulid): Promise<void> {
    const current = await this.#database.prepare(`SELECT binding.session_id
      FROM owner_call_step_up_bindings binding
      JOIN owner_passphrase_heads head ON head.singleton_id = 1
        AND head.owner_principal_id = binding.owner_principal_id
        AND head.owner_identity_id = binding.owner_identity_id
        AND head.status = 'active'
      JOIN owner_passphrase_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id
        AND verifier.verifier_version = head.verifier_version
        AND verifier.status = 'active'
      WHERE binding.session_id = ? AND binding.requirement = 'waived_passed_a'
        AND binding.direction = 'inbound' AND binding.attestation_class = 'passed_a'
        AND binding.policy = 'waive_on_passed_a'`).bind(sessionId).first<{ session_id: string }>();
    if (current === null) throw new Error("owner_step_up_unavailable");
  }

  async verifyRepeat(
    sessionId: Ulid,
    candidate: string,
    now: Date,
  ): Promise<"suppress" | "continue"> {
    const at = iso(now);
    const status = await this.repeatStatus(sessionId, now);
    // `spent` is suppressed alongside `guard`. `repeatStatus` returns `spent` as
    // soon as a repeat-check row exists, and this guard previously sent it to
    // "continue" -- which hands the utterance on as ordinary text, the opposite of
    // what a repeat filter is for. The caller passes that text to the conversation
    // service, so a `spent` repeat would be stored as a turn and sent to the model.
    //
    // NOT PROVEN BY A TEST. Nothing in this repository reaches the `spent` state:
    // the harnesses that exist answer `inactive` or `fragment`, and reverting this
    // line leaves every suite green. The argument above is from reading the status
    // machine. It is a one-line tightening in the safe direction -- it can only
    // turn a "continue" into a "suppress" -- but it is unverified behaviour rather
    // than a measured fix, and it should be reviewed as such.
    if (status === "guard" || status === "spent") return "suppress";
    if (status !== "fragment" && status !== "available") return "continue";
    let canonical: Uint8Array;
    try { canonical = canonicalizeOwnerPassphrase(candidate); }
    catch { return "continue"; }
    canonical.fill(0);
    const row = await this.#activeVerifier(sessionId);
    if (row === null) return "continue";
    const claim = await this.#database.prepare(`INSERT INTO owner_call_step_up_repeat_checks (
      session_id, lifecycle_generation, verifier_version, reserved_at, outcome, resolved_at
    ) VALUES (?, 1, ?, ?, NULL, NULL) RETURNING session_id`)
      .bind(sessionId, row.verifier_version, at).first<{ session_id: string }>();
    if (claim === null) return "continue";
    const matched = await this.#verifier.verify((await this.#requiredBinding(sessionId)).ownerIdentityId, candidate, this.#record(row));
    candidate = "";
    await this.#database.prepare(`UPDATE owner_call_step_up_repeat_checks SET outcome = ?, resolved_at = ?
      WHERE session_id = ? AND outcome IS NULL`).bind(matched ? "matched" : "mismatched", iso(now), sessionId).run();
    return matched ? "suppress" : "continue";
  }

  async repeatStatus(
    sessionId: Ulid,
    now: Date,
  ): Promise<"guard" | "fragment" | "available" | "spent" | "inactive"> {
    const state = await this.state(sessionId);
    if (state.verifiedAt === null) return "inactive";
    const observedAt = iso(now);
    const verifiedAt = new Date(state.verifiedAt).valueOf();
    if (observedAt <= new Date(verifiedAt + OWNER_STEP_UP_REPEAT_MS).toISOString()) {
      return "guard";
    }
    const existing = await this.#database.prepare(
      "SELECT session_id FROM owner_call_step_up_repeat_checks WHERE session_id = ?",
    ).bind(sessionId).first<{ session_id: string }>();
    if (existing !== null) return "spent";
    return observedAt <= new Date(verifiedAt + OWNER_STEP_UP_REPEAT_FRAGMENT_MS).toISOString()
      ? "fragment"
      : "available";
  }

  async state(sessionId: Ulid): Promise<Readonly<{
    requirement: OwnerStepUpRequirement;
    deadlineAt: string | null;
    attempts: number;
    reprompts: number;
    verifiedAt: string | null;
    rejectionReason: string | null;
  }>> {
    const row = await this.#database.prepare(`SELECT binding.*,
      window.prompted_at, window.deadline_at, window.verifier_version,
      (SELECT count(*) FROM owner_call_step_up_attempts attempt WHERE attempt.session_id = binding.session_id) AS attempts,
      (SELECT count(*) FROM owner_call_step_up_reprompts reprompt WHERE reprompt.session_id = binding.session_id) AS reprompts,
      success.verified_at AS success_at,
      COALESCE(rejection.reason,
        CASE WHEN disabled.session_id IS NOT NULL THEN 'passphrase_disabled' ELSE NULL END
      ) AS rejection_reason
      FROM owner_call_step_up_bindings binding
      LEFT JOIN owner_call_step_up_windows window ON window.session_id = binding.session_id
      LEFT JOIN owner_call_step_up_successes success ON success.session_id = binding.session_id
      LEFT JOIN owner_call_step_up_rejections rejection ON rejection.session_id = binding.session_id
      LEFT JOIN owner_call_step_up_disabled_rejections disabled ON disabled.session_id = binding.session_id
      WHERE binding.session_id = ?`).bind(sessionId).first<StepUpStateRow>();
    if (row === null) throw new Error("owner_step_up_binding_missing");
    return Object.freeze({
      requirement: row.requirement as OwnerStepUpRequirement,
      deadlineAt: row.deadline_at,
      attempts: row.attempts,
      reprompts: row.reprompts,
      verifiedAt: row.success_at,
      rejectionReason: row.rejection_reason,
    });
  }

  async reconcileState(sessionId: Ulid, now: Date): ReturnType<OwnerCallStepUpService["state"]> {
    await this.#recordDisabledRejection(sessionId, now);
    return this.state(sessionId);
  }

  async rejectionDelivered(sessionId: Ulid): Promise<boolean> {
    return await this.#database.prepare(
      "SELECT session_id FROM owner_call_step_up_rejection_deliveries WHERE session_id = ?",
    ).bind(sessionId).first<{ session_id: string }>() !== null;
  }

  async recordRejectionDelivered(sessionId: Ulid, now: Date): Promise<void> {
    if (await this.rejectionDelivered(sessionId)) return;
    try {
      await this.#database.prepare(`INSERT INTO owner_call_step_up_rejection_deliveries (
        session_id, lifecycle_generation, delivered_at
      ) VALUES (?, 1, ?)`).bind(sessionId, iso(now)).run();
    } catch (error) {
      if (await this.rejectionDelivered(sessionId)) return;
      throw error;
    }
  }

  async reserveGuestPinAttempt(sessionId: Ulid, now: Date): Promise<number> {
    const row = await this.#database.prepare(
      "SELECT count(*) AS count FROM guest_call_pin_attempts WHERE session_id = ?",
    ).bind(sessionId).first<{ count: number }>();
    const ordinal = (row?.count ?? 0) + 1;
    if (ordinal > 3) throw new Error("authentication_budget_exhausted");
    await this.#database.prepare(`INSERT INTO guest_call_pin_attempts (session_id, attempt_ordinal, attempted_at)
      VALUES (?, ?, ?)`).bind(sessionId, ordinal, iso(now)).run();
    return ordinal;
  }

  async #requiredBinding(sessionId: Ulid): Promise<OwnerStepUpBindingSnapshot> {
    const found = await this.binding(sessionId);
    if (found === null || found.requirement !== "required") throw new Error("owner_step_up_binding_missing");
    return found;
  }

  async #hasRejection(sessionId: Ulid): Promise<boolean> {
    return await this.#database.prepare(`SELECT session_id FROM owner_call_step_up_rejections
      WHERE session_id = ? UNION ALL
      SELECT session_id FROM owner_call_step_up_disabled_rejections WHERE session_id = ? LIMIT 1`)
      .bind(sessionId, sessionId).first<{ session_id: string }>() !== null;
  }

  async #recordDisabledRejection(sessionId: Ulid, now: Date): Promise<boolean> {
    const existing = await this.#database.prepare(
      "SELECT session_id FROM owner_call_step_up_disabled_rejections WHERE session_id = ?",
    ).bind(sessionId).first<{ session_id: string }>();
    if (existing !== null) return true;
    const disabled = await this.#database.prepare(`SELECT binding.session_id
      FROM owner_call_step_up_bindings binding
      JOIN owner_passphrase_heads head ON head.singleton_id = 1
        AND head.owner_principal_id = binding.owner_principal_id
        AND head.owner_identity_id = binding.owner_identity_id
        AND head.status = 'disabled'
      WHERE binding.session_id = ? AND binding.requirement IN ('required', 'waived_passed_a')`)
      .bind(sessionId).first<{ session_id: string }>();
    if (disabled === null) return false;
    try {
      await this.#database.prepare(`INSERT INTO owner_call_step_up_disabled_rejections (
        session_id, lifecycle_generation, rejected_at
      ) VALUES (?, 1, ?)`).bind(sessionId, iso(now)).run();
      return true;
    } catch (error) {
      const recorded = await this.#database.prepare(
        "SELECT session_id FROM owner_call_step_up_disabled_rejections WHERE session_id = ?",
      ).bind(sessionId).first<{ session_id: string }>();
      if (recorded !== null) return true;
      if (await this.#hasRejection(sessionId)) return false;
      throw error;
    }
  }

  async #activeVerifier(sessionId: Ulid): Promise<VerifierRow | null> {
    return this.#database.prepare(`SELECT verifier.verifier_version, verifier.algorithm,
      verifier.domain_version, verifier.word_list_version, verifier.pepper_version,
      verifier.iterations, verifier.salt, verifier.digest, window.prompted_at, window.deadline_at
      FROM owner_call_step_up_windows window
      JOIN owner_call_step_up_bindings binding ON binding.session_id = window.session_id
      JOIN owner_passphrase_heads head ON head.singleton_id = 1
        AND head.owner_principal_id = binding.owner_principal_id
        AND head.owner_identity_id = binding.owner_identity_id
        AND head.verifier_version = window.verifier_version AND head.status = 'active'
      JOIN owner_passphrase_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id
        AND verifier.verifier_version = head.verifier_version AND verifier.status = 'active'
      WHERE window.session_id = ? AND window.lifecycle_generation = 1`)
      .bind(sessionId).first<VerifierRow>();
  }

  #record(row: VerifierRow): OwnerPassphraseVerifierRecordV1 {
    return decodeOwnerPassphraseVerifierRecord({
      schemaVersion: "1.0", algorithm: row.algorithm, domainVersion: row.domain_version,
      wordListVersion: row.word_list_version, pepperVersion: row.pepper_version,
      iterations: row.iterations, verifierVersion: row.verifier_version,
      saltBase64: base64(row.salt), digestBase64: base64(row.digest),
    });
  }
}

export interface OwnerStepUpAlertSink {
  alert(input: Readonly<{
    ownerPrincipalId: string;
    alertClass: "rejected" | "configuration" | "admission_refused";
    direction: "inbound" | "outbound";
    attestationClass: OwnerAttestationClass;
    now: Date;
  }>): Promise<void>;
}

/** First alert is immediate; identical alerts are coalesced to one delivery per 15 minutes. */
export class D1OwnerStepUpAlertSink implements OwnerStepUpAlertSink {
  constructor(
    private readonly database: D1Database,
    private readonly telegram: Pick<TelegramProvider, "sendMessage">,
  ) {}

  async alert(input: Parameters<OwnerStepUpAlertSink["alert"]>[0]): Promise<void> {
    const at = iso(input.now);
    const eligibleBefore = new Date(input.now.valueOf() - 15 * 60_000).toISOString();
    const claimId = crypto.randomUUID();
    const claimExpiresAt = new Date(input.now.valueOf() + 30_000).toISOString();
    const inserted = await this.database.prepare(`INSERT INTO owner_call_step_up_alerts (
      owner_principal_id, alert_class, direction, attestation_class,
      first_observed_at, last_observed_at, observation_count, last_sent_at, claim_id, claim_expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM owner_call_step_up_alerts
      WHERE owner_principal_id = ? AND alert_class = ? AND direction = ?
    ) RETURNING claim_id, observation_count`).bind(
      input.ownerPrincipalId, input.alertClass, input.direction, input.attestationClass,
      at, at, claimId, claimExpiresAt,
      input.ownerPrincipalId, input.alertClass, input.direction,
    ).first<{ claim_id: string | null; observation_count: number }>();
    const claimed = inserted ?? await this.database.prepare(`UPDATE owner_call_step_up_alerts SET
      last_observed_at = ?,
      observation_count = owner_call_step_up_alerts.observation_count + 1,
      attestation_class = ?,
      claim_id = CASE
        WHEN (owner_call_step_up_alerts.last_sent_at IS NULL OR owner_call_step_up_alerts.last_sent_at <= ?)
          AND (owner_call_step_up_alerts.claim_expires_at IS NULL OR owner_call_step_up_alerts.claim_expires_at <= ?)
        THEN ? ELSE owner_call_step_up_alerts.claim_id END,
      claim_expires_at = CASE
        WHEN (owner_call_step_up_alerts.last_sent_at IS NULL OR owner_call_step_up_alerts.last_sent_at <= ?)
          AND (owner_call_step_up_alerts.claim_expires_at IS NULL OR owner_call_step_up_alerts.claim_expires_at <= ?)
        THEN ? ELSE owner_call_step_up_alerts.claim_expires_at END
      WHERE owner_principal_id = ? AND alert_class = ? AND direction = ?
      RETURNING claim_id, observation_count`).bind(
      at, input.attestationClass, eligibleBefore, at, claimId, eligibleBefore, at, claimExpiresAt,
      input.ownerPrincipalId, input.alertClass, input.direction,
    ).first<{ claim_id: string | null; observation_count: number }>();
    if (claimed === null || claimed.claim_id !== claimId) return;
    try {
      const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(input.ownerPrincipalId);
      if (chatId === null) throw new Error("owner_step_up_alert_unavailable");
      const text = input.alertClass === "configuration"
        ? "Jarvis owner call verification is unavailable because its passphrase configuration is invalid."
        : input.alertClass === "admission_refused"
          ? `Jarvis refused an ${input.direction} owner call because all call-session slots were occupied.`
            + (input.direction === "inbound" ? ` Caller attestation category: ${input.attestationClass}.` : "")
            + ` Total observations: ${claimed.observation_count}.`
          : `Jarvis ended an ${input.direction} owner call after passphrase verification failed.`
            + (input.direction === "inbound" ? ` Caller attestation category: ${input.attestationClass}.` : "")
            + ` Total observations: ${claimed.observation_count}.`
            + " To disable spoken owner-call step-up, use /disable-owner-step-up --confirm in your private chat.";
      const result: TelegramSendMessageResult = await this.telegram.sendMessage({
        chatId, text, idempotencyKey: `owner-step-up:${input.ownerPrincipalId}:${input.alertClass}:${input.direction}:${at.slice(0, 16)}`,
      });
      if (!/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) throw new Error("owner_step_up_alert_unavailable");
      const recorded = await this.database.prepare(`UPDATE owner_call_step_up_alerts
        SET last_sent_at = ?, claim_id = NULL, claim_expires_at = NULL
        WHERE owner_principal_id = ? AND alert_class = ? AND direction = ? AND claim_id = ?`)
        .bind(at, input.ownerPrincipalId, input.alertClass, input.direction, claimId).run();
      if (recorded.meta.changes !== 1) throw new Error("owner_step_up_alert_unavailable");
    } catch (error) {
      try {
        await this.database.prepare(`UPDATE owner_call_step_up_alerts
          SET claim_id = NULL, claim_expires_at = NULL
          WHERE owner_principal_id = ? AND alert_class = ? AND direction = ? AND claim_id = ?`)
          .bind(input.ownerPrincipalId, input.alertClass, input.direction, claimId).run();
      } catch {
        // An uncleared claim expires after 30 seconds and remains fail-closed.
      }
      throw error;
    }
  }
}
