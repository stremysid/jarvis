import { validateEvidence, auditVoiceEvidence } from "./voice-smoke.ts";

const turn = { outcome: "voice_sent", committedUserEventId: "01j00000000000000000000001", sentAssistantEventId: "01j00000000000000000000004", deliveryId: null, deliveredAssistantEventId: null };
const inbound = {
  schemaVersion: "1.3", generatorVersion: "0.1.0", status: "passed", scenario: "inbound", manifestKey: "inbound_call",
  commitSha: "a".repeat(40), correlationId: "01j00000000000000000000000", startedAt: "2026-08-29T12:00:00.000Z", endedAt: "2026-08-29T12:01:00.000Z",
  terminalState: "completed", eventIds: [turn.committedUserEventId, turn.sentAssistantEventId], authenticatedTurns: 20,
  authenticationMode: "owner_passphrase", ownerStepUpOutcome: "verified", ownerStepUpPromptCount: 1, ownerStepUpAttemptCount: 1,
  callerIdAttestation: "passed_a", ownerCallerIdPolicy: "passphrase_always", ownerAuthorityGranted: true, ownerStepUpBeforeFirstModelTurn: true,
  interruptions: 1, firstAudibleMs: Array(20).fill(3000), interruptionStopMs: [900], persistenceVerified: true, recallVerified: true, cleanHangup: true,
  sttProvider: "Deepgram", sttModel: "nova-3-general", ttsProvider: "Google", ttsVoice: "en-US-Journey-O", signedWssHandshake: "exact-configured-url",
  dtmfDelivery: "verified", statusCallbackSchema: "verified", relayEndedCallbackSchema: "verified", assistantOutputEvidence: "sent_to_provider_only",
  assistantHistoryCommitted: false, conversationTurnResult: turn,
};
const common = { schemaVersion: "1.3", generatorVersion: "0.1.0", status: "passed", commitSha: "a".repeat(40), correlationId: "01j00000000000000000000002", startedAt: "2026-08-29T13:00:00.000Z", endedAt: "2026-08-29T13:01:00.000Z", eventIds: ["01j00000000000000000000003"] };
const unauthorized = { ...common, scenario: "unauthorized-caller", manifestKey: "unauthorized_caller", terminalState: "rejected", authenticatedTurns: 0, authenticationAttempts: 0, conversationRelaySessions: 0, pinPromptCount: 0, pinAttemptCount: 0, modelRequests: 0, personalContextReads: 0 };
const outAnswer = {
  ...common, scenario: "outbound-answer", manifestKey: "outbound_answer", terminalState: "completed", authenticatedTurns: 1,
  authenticationMode: "owner_passphrase", ownerStepUpOutcome: "verified", ownerStepUpPromptCount: 1, ownerStepUpAttemptCount: 1,
  callerIdAttestation: "absent", ownerCallerIdPolicy: "waive_on_passed_a", ownerAuthorityGranted: true, ownerStepUpBeforeFirstModelTurn: true,
  recipientAuthenticated: true, neutralGreetingBeforeAuthentication: true, purposeDisclosedAfterAuthentication: true,
  sttProvider: "Deepgram", sttModel: "nova-3-general", ttsProvider: "Google", ttsVoice: "en-US-Journey-O", signedWssHandshake: "exact-configured-url",
  dtmfDelivery: "verified", statusCallbackSchema: "verified", relayEndedCallbackSchema: "verified", assistantOutputEvidence: "sent_to_provider_only",
  assistantHistoryCommitted: false, eventIds: ["01j00000000000000000000003", "01j00000000000000000000005"],
  conversationTurnResult: { outcome: "voice_sent", committedUserEventId: "01j00000000000000000000003", sentAssistantEventId: "01j00000000000000000000005", deliveryId: null, deliveredAssistantEventId: null },
};
const outNoAnswer = { ...common, scenario: "outbound-no-answer", manifestKey: "outbound_no_answer", terminalState: "no-answer", authenticationMode: "owner_passphrase", ownerStepUpOutcome: "refused", ownerStepUpPromptCount: 0, ownerStepUpAttemptCount: 0, callerIdAttestation: "absent", ownerCallerIdPolicy: "passphrase_always", ownerAuthorityGranted: false, callAttempts: 1, recipientAuthenticated: false, purposeDisclosed: false, privateMessageLeft: false, modelRequests: 0, personalContextReads: 0, statusCallbackSchema: "verified" };
const refused = { ...common, scenario: "owner-step-up-refused", manifestKey: "owner_step_up_refused", correlationId: "01j00000000000000000000006", terminalState: "rejected", eventIds: ["01j00000000000000000000007"], authenticatedTurns: 0, authenticationMode: "owner_passphrase", ownerStepUpOutcome: "refused", ownerStepUpPromptCount: 3, ownerStepUpAttemptCount: 3, callerIdAttestation: "other", ownerCallerIdPolicy: "waive_on_passed_a", ownerAuthorityGranted: false, modelRequests: 0, personalContextReads: 0, fixedRefusalSentToProvider: true, cleanEndFrameSent: true, rejectionRowCount: 1, ownerAlertCount: 1 };
const failure = { ...common, scenario: "failure-callbacks", manifestKey: "voice_failure_callbacks", terminalState: "failed", modelFailureHandled: true, websocketFailureHandled: true, callbackFailureHandled: true, unauthorizedCallbackCreated: false, statusCallbackSchema: "verified", relayEndedCallbackSchema: "verified", safeErrorCategories: ["model_unavailable", "relay_closed", "callback_rejected"], conversationTurnResult: { outcome: "failed", committedUserEventId: "01j00000000000000000000003", sentAssistantEventId: null, deliveryId: null, deliveredAssistantEventId: null }, modelFailureCode: "model_failed", modelFailureCategory: "provider" };

const J = (v) => JSON.parse(JSON.stringify(v));
function v(label, value) { try { validateEvidence(J(value)); console.log(`ACCEPT  validate  ${label}`); } catch (e) { console.log(`REJECT  validate  ${label} (${e.message})`); } }
function a(label, set) { try { auditVoiceEvidence(set.map(J)); console.log(`ACCEPT  audit     ${label}`); } catch (e) { console.log(`REJECT  audit     ${label} (${e.message})`); } }

const six = [inbound, unauthorized, outAnswer, outNoAnswer, refused, failure];
a("baseline six", six);
a("duplicate inbound + missing refused (length 6)", [inbound, inbound, unauthorized, outAnswer, outNoAnswer, failure]);
a("seven records incl. duplicate", [...six, inbound]);
a("five records", six.slice(0, 5));

const waivedInbound = { ...inbound, authenticationMode: "owner_attested_waiver", ownerStepUpOutcome: "waived_passed_a", ownerStepUpPromptCount: 0, ownerStepUpAttemptCount: 0, callerIdAttestation: "passed_a", ownerCallerIdPolicy: "waive_on_passed_a" };
const refusedAlways = { ...refused, ownerCallerIdPolicy: "passphrase_always", callerIdAttestation: "passed_a" };
a("MIXED POLICY: waived inbound (no phrase) + refused under passphrase_always", [waivedInbound, unauthorized, outAnswer, outNoAnswer, refusedAlways, failure]);
v("refused under waiver policy with attestation passed_a", { ...refused, callerIdAttestation: "passed_a" });

v("refused with one format reprompt (prompts 4, attempts 3)", { ...refused, ownerStepUpPromptCount: 4 });
v("refused with two format reprompts (prompts 5, attempts 3)", { ...refused, ownerStepUpPromptCount: 5 });
v("verified impossible counts: prompts 1, attempts 3", { ...inbound, ownerStepUpPromptCount: 1, ownerStepUpAttemptCount: 3 });
v("verified impossible counts: prompts 5, attempts 1", { ...inbound, ownerStepUpPromptCount: 5, ownerStepUpAttemptCount: 1 });
v("verified legit: prompts 3, attempts 3 (two misses then success)", { ...inbound, ownerStepUpPromptCount: 3, ownerStepUpAttemptCount: 3 });
v("outbound-answer verified prompts 4 attempts 2", { ...outAnswer, ownerStepUpPromptCount: 4, ownerStepUpAttemptCount: 2 });

a("refused reuses inbound correlationId and eventIds", [inbound, unauthorized, outAnswer, outNoAnswer, { ...refused, correlationId: inbound.correlationId, eventIds: [inbound.eventIds[0]] }, failure]);
a("all six share one correlationId", six.map((r) => ({ ...r, correlationId: "01j00000000000000000000000" })));
v("refused call lasting 3 hours (60 s step-up window)", { ...refused, endedAt: "2026-08-29T16:01:00.000Z" });
v("refused dated in the future (2099)", { ...refused, startedAt: "2099-01-01T00:00:00.000Z", endedAt: "2099-01-01T00:01:00.000Z" });
v("outbound-no-answer claiming waive_on_passed_a policy (binding forces passphrase_always)", { ...outNoAnswer, ownerCallerIdPolicy: "waive_on_passed_a" });
v("owner-step-up-refused with policy 'invalid' (runtime binding value)", { ...refused, ownerCallerIdPolicy: "invalid" });

try { validateEvidence(JSON.parse(JSON.stringify(refused).replace("{", '{"__proto__":{"status":"passed"},'))); console.log("ACCEPT  validate  __proto__ own key"); } catch (e) { console.log(`REJECT  validate  __proto__ own key (${e.message})`); }
try { validateEvidence(JSON.parse(JSON.stringify(refused).replace('"ownerAlertCount":1', '"ownerAlertCount":1,"ownerAlertCount":1'))); console.log("ACCEPT  validate  duplicate JSON key (last wins)"); } catch (e) { console.log(`REJECT  validate  duplicate JSON key (${e.message})`); }
v("ownerAlertCount 1.0 float literal", JSON.parse(JSON.stringify(refused).replace('"ownerAlertCount":1', '"ownerAlertCount":1.0')));
v("refused: authenticatedTurns -0", { ...refused, authenticatedTurns: -0 });
