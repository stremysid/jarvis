import type {
  ConversationFailureCategory,
  ConversationFailureCode,
  ConversationTurnOutcome,
} from "../../../apps/cloud-gateway/src/conversation/conversation-types.js";

export const VOICE_SMOKE_SCENARIOS = [
  "inbound",
  "unauthorized-caller",
  "outbound-answer",
  "outbound-no-answer",
  "owner-step-up-refused",
  "failure-callbacks",
] as const;

export type VoiceSmokeScenario = typeof VOICE_SMOKE_SCENARIOS[number];
export type OwnerStepUpOutcome = "verified" | "refused" | "waived_passed_a";

export const LIVE_VOICE_SMOKE_CONFIRMATION = "I_AUTHORIZE_PAID_VOICE_SMOKE";

export const REQUIRED_LIVE_CONFIGURATION = Object.freeze([
  "JARVIS_CLOUD_BASE_URL",
  "JARVIS_DEVICE_ID",
  "JARVIS_DEVICE_KEY_PATH",
  "JARVIS_PRINCIPAL_ID",
  "OWNER_VOICE_IDENTITY_ID",
] as const);

export const REQUIRED_LIVE_SECRETS = Object.freeze([
  "DEEPSEEK_API_KEY",
  "GUEST_PIN_PEPPER_V1",
  "OWNER_PASSPHRASE_PEPPER_V1",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_API_KEY_SID",
  "TWILIO_AUTH_TOKEN",
] as const);

export interface EvidenceStore {
  exists(name: string): Promise<boolean>;
  writeTemporary(name: string, contents: string): Promise<void>;
  commitTemporary(temporaryName: string, finalName: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface VoiceSmokeDriver {
  run(scenario: VoiceSmokeScenario): Promise<unknown>;
}

export interface VoiceSmokeGateInput {
  readonly scenario: VoiceSmokeScenario;
  readonly executeLive: boolean;
  readonly confirmation?: string;
  readonly doctorExitCode?: 0 | 2 | 3 | 4;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly secretPresence: Readonly<Record<string, unknown>>;
}

export type VoiceSmokeRunResult =
  | Readonly<{ status: "skipped"; reason: "live_execution_not_authorized" }>
  | Readonly<{
    status: "skipped";
    reason: "missing_required_prerequisites";
    missingConfiguration: readonly string[];
    missingSecrets: readonly string[];
  }>
  | Readonly<{
    status: "blocked";
    reason:
      | "live_confirmation_required"
      | "doctor_not_ready"
      | "live_driver_unavailable"
      | "evidence_store_unavailable"
      | "evidence_already_retained";
  }>
  | Readonly<{ status: "passed"; evidencePath: string }>;

export interface ParsedSmokeArguments {
  readonly scenario: VoiceSmokeScenario;
  readonly executeLive: boolean;
  readonly confirmation?: string;
}

const COMMON_FIELDS = [
  "schemaVersion",
  "generatorVersion",
  "status",
  "scenario",
  "manifestKey",
  "commitSha",
  "correlationId",
  "startedAt",
  "endedAt",
  "terminalState",
  "eventIds",
] as const;

const INBOUND_FIELDS = [
  ...COMMON_FIELDS,
  "authenticatedTurns",
  "authenticationMode",
  "ownerStepUpOutcome",
  "ownerStepUpPromptCount",
  "ownerStepUpAttemptCount",
  "callerIdAttestation",
  "ownerCallerIdPolicy",
  "ownerAuthorityGranted",
  "ownerStepUpBeforeFirstModelTurn",
  "interruptions",
  "firstAudibleMs",
  "interruptionStopMs",
  "persistenceVerified",
  "recallVerified",
  "cleanHangup",
  "sttProvider",
  "sttModel",
  "ttsProvider",
  "ttsVoice",
  "signedWssHandshake",
  "dtmfDelivery",
  "statusCallbackSchema",
  "relayEndedCallbackSchema",
  "assistantOutputEvidence",
  "assistantHistoryCommitted",
  "conversationTurnResult",
] as const;

const UNAUTHORIZED_FIELDS = [
  ...COMMON_FIELDS,
  "authenticatedTurns",
  "authenticationAttempts",
  "conversationRelaySessions",
  "pinPromptCount",
  "pinAttemptCount",
  "modelRequests",
  "personalContextReads",
] as const;

const OUTBOUND_ANSWER_FIELDS = [
  ...COMMON_FIELDS,
  "authenticatedTurns",
  "authenticationMode",
  "ownerStepUpOutcome",
  "ownerStepUpPromptCount",
  "ownerStepUpAttemptCount",
  "callerIdAttestation",
  "ownerCallerIdPolicy",
  "ownerAuthorityGranted",
  "ownerStepUpBeforeFirstModelTurn",
  "recipientAuthenticated",
  "neutralGreetingBeforeAuthentication",
  "purposeDisclosedAfterAuthentication",
  "sttProvider",
  "sttModel",
  "ttsProvider",
  "ttsVoice",
  "signedWssHandshake",
  "dtmfDelivery",
  "statusCallbackSchema",
  "relayEndedCallbackSchema",
  "assistantOutputEvidence",
  "assistantHistoryCommitted",
  "conversationTurnResult",
] as const;

const OUTBOUND_NO_ANSWER_FIELDS = [
  ...COMMON_FIELDS,
  "authenticationMode",
  "ownerStepUpOutcome",
  "ownerStepUpPromptCount",
  "ownerStepUpAttemptCount",
  "callerIdAttestation",
  "ownerCallerIdPolicy",
  "ownerAuthorityGranted",
  "callAttempts",
  "recipientAuthenticated",
  "purposeDisclosed",
  "privateMessageLeft",
  "modelRequests",
  "personalContextReads",
  "statusCallbackSchema",
] as const;

const OWNER_STEP_UP_REFUSED_FIELDS = [
  ...COMMON_FIELDS,
  "authenticatedTurns",
  "authenticationMode",
  "ownerStepUpOutcome",
  "ownerStepUpPromptCount",
  "ownerStepUpAttemptCount",
  "callerIdAttestation",
  "ownerCallerIdPolicy",
  "ownerAuthorityGranted",
  "modelRequests",
  "personalContextReads",
  "fixedRefusalSentToProvider",
  "cleanEndFrameSent",
  "rejectionRowCount",
  "ownerAlertCount",
] as const;

const FAILURE_FIELDS = [
  ...COMMON_FIELDS,
  "modelFailureHandled",
  "websocketFailureHandled",
  "callbackFailureHandled",
  "unauthorizedCallbackCreated",
  "statusCallbackSchema",
  "relayEndedCallbackSchema",
  "safeErrorCategories",
  "conversationTurnResult",
  "modelFailureCode",
  "modelFailureCategory",
] as const;

const SAFE_ERROR_CATEGORIES = new Set([
  "model_unavailable",
  "relay_closed",
  "callback_rejected",
]);
const TASK_5_VOICE_SENT = "voice_sent" satisfies ConversationTurnOutcome;
const TASK_5_MODEL_FAILED = "failed" satisfies ConversationTurnOutcome;
const TASK_5_MODEL_FAILURE_CODE = "model_failed" satisfies ConversationFailureCode;
const TASK_5_MODEL_FAILURE_CATEGORY = "provider" satisfies ConversationFailureCategory;
const OWNER_PASSPHRASE_AUTHENTICATION_MODE = "owner_passphrase";
const OWNER_ATTESTED_WAIVER_AUTHENTICATION_MODE = "owner_attested_waiver";
const OWNER_VOICE_IDENTITY_CONFIGURATION = "OWNER_VOICE_IDENTITY_ID";
const TASK_5_TURN_RESULT_FIELDS = [
  "outcome",
  "committedUserEventId",
  "sentAssistantEventId",
  "deliveryId",
  "deliveredAssistantEventId",
] as const;

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function unsafe(): never {
  throw new Error("unsafe_or_incomplete_evidence");
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) unsafe();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) unsafe();
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) unsafe();
    record[field] = descriptor.value;
  }
  return record;
}

function scenarioOf(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) unsafe();
  const descriptor = Object.getOwnPropertyDescriptor(value, "scenario");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) unsafe();
  return descriptor.value;
}

function dataField(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) unsafe();
  return descriptor.value;
}

function validUtcMilliseconds(value: unknown): value is string {
  return typeof value === "string"
    && UTC_MILLISECONDS.test(value)
    && new Date(value).toISOString() === value;
}

function validInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function validEventIds(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 1_000
    && value.every((eventId) => typeof eventId === "string" && ULID.test(eventId))
    && new Set(value).size === value.length;
}

function validLatencySamples(value: unknown, expectedLength: number): value is readonly number[] {
  return Array.isArray(value)
    && value.length === expectedLength
    && value.every((sample) => validInteger(sample, 0, 60_000));
}

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function validateCommon(evidence: Record<string, unknown>, scenario: VoiceSmokeScenario, manifestKey: string): void {
  if (
    evidence.schemaVersion !== "1.3"
    || evidence.generatorVersion !== "0.1.0"
    || evidence.status !== "passed"
    || evidence.scenario !== scenario
    || evidence.manifestKey !== manifestKey
    || typeof evidence.commitSha !== "string"
    || !COMMIT_SHA.test(evidence.commitSha)
    || typeof evidence.correlationId !== "string"
    || !ULID.test(evidence.correlationId)
    || !validUtcMilliseconds(evidence.startedAt)
    || !validUtcMilliseconds(evidence.endedAt)
    || Date.parse(evidence.startedAt) >= Date.parse(evidence.endedAt)
    || !validEventIds(evidence.eventIds)
  ) unsafe();
}

function validateOwnerStepUp(
  evidence: Record<string, unknown>,
  direction: "inbound" | "outbound",
  claimsOwnerAuthority: boolean,
): void {
  const outcome = evidence.ownerStepUpOutcome;
  const attestation = evidence.callerIdAttestation;
  const policy = evidence.ownerCallerIdPolicy;
  if (
    outcome !== "verified" && outcome !== "refused" && outcome !== "waived_passed_a"
    || attestation !== "passed_a" && attestation !== "other" && attestation !== "absent"
    || policy !== "passphrase_always" && policy !== "waive_on_passed_a"
    || evidence.ownerAuthorityGranted !== claimsOwnerAuthority
    || !validInteger(evidence.ownerStepUpPromptCount, 0, 3)
    || !validInteger(evidence.ownerStepUpAttemptCount, 0, 3)
    || direction === "outbound" && outcome !== "waived_passed_a" && attestation !== "absent"
  ) unsafe();

  if (outcome === "waived_passed_a") {
    if (
      direction !== "inbound"
      || !claimsOwnerAuthority
      || evidence.authenticationMode !== OWNER_ATTESTED_WAIVER_AUTHENTICATION_MODE
      || attestation !== "passed_a"
      || policy !== "waive_on_passed_a"
      || evidence.ownerStepUpPromptCount !== 0
      || evidence.ownerStepUpAttemptCount !== 0
    ) unsafe();
  } else {
    if (
      evidence.authenticationMode !== OWNER_PASSPHRASE_AUTHENTICATION_MODE
      || direction === "inbound" && attestation === "passed_a" && policy === "waive_on_passed_a"
    ) unsafe();
    if (outcome === "verified") {
      if (
        !claimsOwnerAuthority
        || evidence.ownerStepUpPromptCount !== 1
        || !validInteger(evidence.ownerStepUpAttemptCount, 1, 3)
      ) unsafe();
    } else if (claimsOwnerAuthority) unsafe();
  }

  if (claimsOwnerAuthority && evidence.ownerStepUpBeforeFirstModelTurn !== true) unsafe();
}

function validateTask5VoiceTurn(
  value: unknown,
  eventIdsValue: unknown,
  expectedOutcome: typeof TASK_5_VOICE_SENT | typeof TASK_5_MODEL_FAILED,
): void {
  const turn = exactRecord(value, TASK_5_TURN_RESULT_FIELDS);
  if (!Array.isArray(eventIdsValue)) unsafe();
  const eventIds = eventIdsValue as readonly unknown[];
  if (
    turn.outcome !== expectedOutcome
    || typeof turn.committedUserEventId !== "string"
    || !ULID.test(turn.committedUserEventId)
    || !eventIds.includes(turn.committedUserEventId)
    || turn.deliveryId !== null
    || turn.deliveredAssistantEventId !== null
  ) unsafe();
  if (expectedOutcome === TASK_5_VOICE_SENT) {
    if (
      typeof turn.sentAssistantEventId !== "string"
      || !ULID.test(turn.sentAssistantEventId)
      || !eventIds.includes(turn.sentAssistantEventId)
      || turn.sentAssistantEventId === turn.committedUserEventId
    ) unsafe();
  } else if (turn.sentAssistantEventId !== null) unsafe();
}

function validateInbound(value: unknown): void {
  const evidence = exactRecord(value, INBOUND_FIELDS);
  validateCommon(evidence, "inbound", "inbound_call");
  if (
    evidence.terminalState !== "completed"
    || !validInteger(evidence.authenticatedTurns, 20, 100)
    || !validInteger(evidence.interruptions, 1, 100)
    || !validLatencySamples(evidence.firstAudibleMs, evidence.authenticatedTurns)
    || !validLatencySamples(evidence.interruptionStopMs, evidence.interruptions)
    || percentile95(evidence.firstAudibleMs) > 4_000
    || percentile95(evidence.interruptionStopMs) > 1_500
    || evidence.persistenceVerified !== true
    || evidence.recallVerified !== true
    || evidence.cleanHangup !== true
  ) unsafe();
  validateOwnerStepUp(evidence, "inbound", true);
  validateRelayContract(evidence);
  validateTask5VoiceTurn(evidence.conversationTurnResult, evidence.eventIds, TASK_5_VOICE_SENT);
}

function validateUnauthorizedCaller(value: unknown): void {
  const evidence = exactRecord(value, UNAUTHORIZED_FIELDS);
  validateCommon(evidence, "unauthorized-caller", "unauthorized_caller");
  if (
    evidence.terminalState !== "rejected"
    || evidence.authenticatedTurns !== 0
    || evidence.authenticationAttempts !== 0
    || evidence.conversationRelaySessions !== 0
    || evidence.pinPromptCount !== 0
    || evidence.pinAttemptCount !== 0
    || evidence.modelRequests !== 0
    || evidence.personalContextReads !== 0
  ) unsafe();
}

function validateRelayContract(evidence: Record<string, unknown>): void {
  if (
    evidence.sttProvider !== "Deepgram"
    || evidence.sttModel !== "nova-3-general"
    || evidence.ttsProvider !== "Google"
    || evidence.ttsVoice !== "en-US-Journey-O"
    || evidence.signedWssHandshake !== "exact-configured-url"
    || evidence.dtmfDelivery !== "verified"
    || evidence.statusCallbackSchema !== "verified"
    || evidence.relayEndedCallbackSchema !== "verified"
    || evidence.assistantOutputEvidence !== "sent_to_provider_only"
    || evidence.assistantHistoryCommitted !== false
  ) unsafe();
}

function validateOutboundAnswer(value: unknown): void {
  const evidence = exactRecord(value, OUTBOUND_ANSWER_FIELDS);
  validateCommon(evidence, "outbound-answer", "outbound_answer");
  if (
    evidence.terminalState !== "completed"
    || !validInteger(evidence.authenticatedTurns, 1, 100)
    || evidence.recipientAuthenticated !== true
    || evidence.neutralGreetingBeforeAuthentication !== true
    || evidence.purposeDisclosedAfterAuthentication !== true
  ) unsafe();
  validateOwnerStepUp(evidence, "outbound", true);
  validateRelayContract(evidence);
  validateTask5VoiceTurn(evidence.conversationTurnResult, evidence.eventIds, TASK_5_VOICE_SENT);
}

function validateOutboundNoAnswer(value: unknown): void {
  const evidence = exactRecord(value, OUTBOUND_NO_ANSWER_FIELDS);
  validateCommon(evidence, "outbound-no-answer", "outbound_no_answer");
  if (
    evidence.terminalState !== "no-answer"
    || evidence.callAttempts !== 1
    || evidence.recipientAuthenticated !== false
    || evidence.purposeDisclosed !== false
    || evidence.privateMessageLeft !== false
    || evidence.ownerStepUpPromptCount !== 0
    || evidence.ownerStepUpAttemptCount !== 0
    || evidence.modelRequests !== 0
    || evidence.personalContextReads !== 0
    || evidence.statusCallbackSchema !== "verified"
  ) unsafe();
  validateOwnerStepUp(evidence, "outbound", false);
}

function validateOwnerStepUpRefused(value: unknown): void {
  const evidence = exactRecord(value, OWNER_STEP_UP_REFUSED_FIELDS);
  validateCommon(evidence, "owner-step-up-refused", "owner_step_up_refused");
  if (
    evidence.terminalState !== "rejected"
    || evidence.authenticatedTurns !== 0
    || evidence.ownerStepUpOutcome !== "refused"
    || evidence.ownerStepUpPromptCount !== 3
    || evidence.ownerStepUpAttemptCount !== 3
    || evidence.modelRequests !== 0
    || evidence.personalContextReads !== 0
    || evidence.fixedRefusalSentToProvider !== true
    || evidence.cleanEndFrameSent !== true
    || evidence.rejectionRowCount !== 1
    || evidence.ownerAlertCount !== 1
  ) unsafe();
  validateOwnerStepUp(evidence, "inbound", false);
}

function validSafeErrorCategories(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === SAFE_ERROR_CATEGORIES.size
    && value.every((category) => SAFE_ERROR_CATEGORIES.has(category))
    && new Set(value).size === value.length;
}

function validateFailureCallbacks(value: unknown): void {
  const evidence = exactRecord(value, FAILURE_FIELDS);
  validateCommon(evidence, "failure-callbacks", "voice_failure_callbacks");
  if (
    evidence.terminalState !== "failed"
    || evidence.modelFailureHandled !== true
    || evidence.websocketFailureHandled !== true
    || evidence.callbackFailureHandled !== true
    || evidence.unauthorizedCallbackCreated !== false
    || evidence.statusCallbackSchema !== "verified"
    || evidence.relayEndedCallbackSchema !== "verified"
    || evidence.modelFailureCode !== TASK_5_MODEL_FAILURE_CODE
    || evidence.modelFailureCategory !== TASK_5_MODEL_FAILURE_CATEGORY
    || !validSafeErrorCategories(evidence.safeErrorCategories)
  ) unsafe();
  validateTask5VoiceTurn(evidence.conversationTurnResult, evidence.eventIds, TASK_5_MODEL_FAILED);
}

export function validateEvidence(value: unknown): true {
  try {
    switch (scenarioOf(value)) {
      case "inbound":
        validateInbound(value);
        break;
      case "unauthorized-caller":
        validateUnauthorizedCaller(value);
        break;
      case "outbound-answer":
        validateOutboundAnswer(value);
        break;
      case "outbound-no-answer":
        validateOutboundNoAnswer(value);
        break;
      case "owner-step-up-refused":
        validateOwnerStepUpRefused(value);
        break;
      case "failure-callbacks":
        validateFailureCallbacks(value);
        break;
      default:
        unsafe();
    }
    return true;
  } catch {
    return unsafe();
  }
}

function missingConfiguration(record: Readonly<Record<string, unknown>>): readonly string[] {
  const missing: string[] = [];
  for (const name of REQUIRED_LIVE_CONFIGURATION) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(record, name);
      if (descriptor === undefined || !("value" in descriptor)) {
        missing.push(name);
      } else if (
        name !== OWNER_VOICE_IDENTITY_CONFIGURATION
        && (typeof descriptor.value !== "string" || descriptor.value.trim().length === 0)
      ) {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }
  return Object.freeze(missing);
}

export function validateSecretPresence(record: Readonly<Record<string, unknown>>): readonly string[] {
  const missing: string[] = [];
  for (const name of REQUIRED_LIVE_SECRETS) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(record, name);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== true) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return Object.freeze(missing);
}

async function persistEvidence(store: EvidenceStore, evidence: unknown): Promise<string> {
  validateEvidence(evidence);
  const scenario = scenarioOf(evidence) as VoiceSmokeScenario;
  const correlationId = dataField(evidence as object, "correlationId");
  if (typeof correlationId !== "string" || !ULID.test(correlationId)) unsafe();
  const finalName = `${scenario}.json`;
  const temporaryName = `.${scenario}.${correlationId}.tmp`;
  let writeFailed = false;
  try {
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    await store.writeTemporary(temporaryName, serialized);
    await store.commitTemporary(temporaryName, finalName);
  } catch {
    writeFailed = true;
  } finally {
    try {
      await store.remove(temporaryName);
    } catch {
      throw new Error("evidence_cleanup_failed");
    }
  }
  if (writeFailed) throw new Error("evidence_write_failed");
  return `tests/acceptance/live/evidence/${finalName}`;
}

export async function runVoiceSmoke(
  input: VoiceSmokeGateInput,
  dependencies: Readonly<{ driver?: VoiceSmokeDriver; store?: EvidenceStore }>,
): Promise<VoiceSmokeRunResult> {
  if (!VOICE_SMOKE_SCENARIOS.includes(input.scenario)) throw new Error("invalid_smoke_request");
  if (!input.executeLive) return Object.freeze({ status: "skipped", reason: "live_execution_not_authorized" });
  if (input.confirmation !== LIVE_VOICE_SMOKE_CONFIRMATION) {
    return Object.freeze({ status: "blocked", reason: "live_confirmation_required" });
  }

  const missingLocalConfiguration = missingConfiguration(input.configuration);
  const missingSecrets = validateSecretPresence(input.secretPresence);
  if (missingLocalConfiguration.length > 0 || missingSecrets.length > 0) {
    return Object.freeze({
      status: "skipped",
      reason: "missing_required_prerequisites",
      missingConfiguration: missingLocalConfiguration,
      missingSecrets,
    });
  }
  if (input.doctorExitCode !== 0) return Object.freeze({ status: "blocked", reason: "doctor_not_ready" });
  if (dependencies.driver === undefined) return Object.freeze({ status: "blocked", reason: "live_driver_unavailable" });
  if (dependencies.store === undefined) return Object.freeze({ status: "blocked", reason: "evidence_store_unavailable" });
  try {
    if (await dependencies.store.exists(`${input.scenario}.json`)) {
      return Object.freeze({ status: "blocked", reason: "evidence_already_retained" });
    }
  } catch {
    return Object.freeze({ status: "blocked", reason: "evidence_store_unavailable" });
  }

  let evidence: unknown;
  try {
    evidence = await dependencies.driver.run(input.scenario);
    validateEvidence(evidence);
  } catch {
    throw new Error("live_smoke_failed");
  }
  if (scenarioOf(evidence) !== input.scenario) throw new Error("live_smoke_failed");
  return Object.freeze({
    status: "passed",
    evidencePath: await persistEvidence(dependencies.store, evidence),
  });
}

export function auditVoiceEvidence(records: readonly unknown[]): true {
  try {
    if (!Array.isArray(records) || records.length !== VOICE_SMOKE_SCENARIOS.length) throw new Error();
    const scenarios = new Set<unknown>();
    const commitShas = new Set<unknown>();
    for (const record of records) {
      validateEvidence(record);
      scenarios.add(scenarioOf(record));
      commitShas.add(dataField(record as object, "commitSha"));
    }
    if (scenarios.size !== VOICE_SMOKE_SCENARIOS.length || commitShas.size !== 1) throw new Error();
    for (const scenario of VOICE_SMOKE_SCENARIOS) {
      if (!scenarios.has(scenario)) throw new Error();
    }
    return true;
  } catch {
    throw new Error("release_voice_evidence_incomplete");
  }
}

export async function cleanupVoiceEvidence(store: EvidenceStore): Promise<void> {
  let failed = false;
  for (const scenario of VOICE_SMOKE_SCENARIOS) {
    try {
      await store.remove(`${scenario}.json`);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("evidence_cleanup_failed");
}

export function parseSmokeArguments(arguments_: readonly string[]): Readonly<ParsedSmokeArguments> {
  try {
    const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
    let scenario: VoiceSmokeScenario | undefined;
    let executeLive = false;
    let confirmation: string | undefined;
    for (let index = 0; index < normalizedArguments.length; index += 1) {
      const argument = normalizedArguments[index];
      if (argument === "--scenario") {
        const candidate = normalizedArguments[index + 1];
        if (scenario !== undefined || candidate === undefined || !VOICE_SMOKE_SCENARIOS.includes(candidate as VoiceSmokeScenario)) throw new Error();
        scenario = candidate as VoiceSmokeScenario;
        index += 1;
      } else if (argument === "--execute-live") {
        if (executeLive) throw new Error();
        executeLive = true;
      } else if (argument === "--confirm-live") {
        const candidate = normalizedArguments[index + 1];
        if (confirmation !== undefined || candidate === undefined) throw new Error();
        confirmation = candidate;
        index += 1;
      } else {
        throw new Error();
      }
    }
    if (scenario === undefined || (confirmation !== undefined && !executeLive)) throw new Error();
    return confirmation === undefined
      ? Object.freeze({ scenario, executeLive })
      : Object.freeze({ scenario, executeLive, confirmation });
  } catch {
    throw new Error("invalid_smoke_arguments");
  }
}

export function formatRunResult(result: VoiceSmokeRunResult): string {
  return `${JSON.stringify(result)}\n`;
}
