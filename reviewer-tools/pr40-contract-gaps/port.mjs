// Applies one hand-ported PR33 gap onto the PR #40 tree (6b63d08). Exact-anchor replacements only;
// every anchor must occur exactly once or nothing is written.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "C:/Users/Sid/jarvis-pr33-tests/";
const SVC = "apps/cloud-gateway/src/voice/owner-call-step-up.ts";
const CORE = "apps/cloud-gateway/src/voice/call-session-do.ts";
const L = (...lines) => lines.join("\n");

// ---- anchors (service) ----
const S_verify = "    try { matched = await this.#verifier.verify((await this.#requiredBinding(sessionId)).ownerIdentityId, candidate, this.#record(row)); }";
const S_count = "    const count = await this.#database.prepare(`SELECT count(*) AS count FROM owner_call_step_up_attempts";
const S_return3 = "    return ordinal === 3 ? \"rejected\" : \"mismatched\";";
const S_vcHead = L(
  "    now: Date,",
  "  ): Promise<\"matched\" | \"mismatched\" | \"rejected\" | \"expired\" | \"not_candidate\"> {",
  "    let canonical: Uint8Array;",
  "    try { canonical = canonicalizeOwnerPassphrase(candidate); }",
);
const S_dup = "  if (values.length > 1) return null;";
const S_attest = "  return values[0] === \"TN-Validation-Passed-A\" ? \"passed_a\" : \"other\";";
const S_policy = "  if (value === \"waive_on_passed_a\") return value;";

// ---- anchors (core / DO) ----
const C_field = "  #ownerStepUpVerificationInFlight = false;";
const C_pinField = "  readonly #ownerAccessPin = new FourDigitPinCapture();";
const C_completeSig = "  async #completeOwnerStepUp(candidate: string, observedAt: Date): Promise<void> {";
const C_verify = "      const outcome = await this.#ownerStepUp.verifyCandidate(this.#session.sessionId, candidate, observedAt);";
const C_rejected = L(
  "      if (outcome === \"rejected\") {",
  "        await this.#rejectOwnerStepUp(observedAt, true);",
  "        return;",
  "      }",
);
const C_mismatch = L(
  "      if (outcome === \"mismatched\") {",
  "        await this.#relay.sendNeutralText(OWNER_STEP_UP_RETRY_PROMPT);",
  "        return;",
  "      }",
);
const C_promptHead = L(
  "    if (this.#interaction.kind === \"owner_step_up\" && this.#session.phase === \"pre_auth\") {",
  "      await this.#handleOwnerStepUpPrompt(event);",
  "      return;",
  "    }",
);
const C_repeat = L(
  "    if (this.#authority?.kind === \"owner\" && this.#ownerStepUp !== null) {",
  "      if (await this.#ownerStepUp.verifyRepeat(",
);
const C_dtmf = "  async #handleDtmf(event: RelayDtmfEvent): Promise<void> {";
const C_wsmTry = L(
  "    try {",
  "      await resolved.core.handleRelayEvent(event);",
  "    } catch {",
);
const C_wsmSig = "  override async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {";

// ---- shared snippets ----
const journalMethod = L(
  "  // PR40 GAP 3: journal pre-authentication prompts \"for eviction recovery\".",
  "  async #pr40JournalStub(text: string): Promise<void> {",
  "    const canonical = text.normalize(\"NFC\").toLowerCase();",
  "    const digest = [...new Uint8Array(await crypto.subtle.digest(\"SHA-256\", encoder.encode(canonical)))]",
  "      .map((byte) => byte.toString(16).padStart(2, \"0\")).join(\"\");",
  "    try {",
  "      this.ctx.storage.sql.exec(\"CREATE TABLE IF NOT EXISTS pr40_prompt_journal (received_at TEXT NOT NULL, text TEXT NOT NULL)\");",
  "      this.ctx.storage.sql.exec(\"INSERT INTO pr40_prompt_journal (received_at, text) VALUES (?, ?)\", new Date().toISOString(), text);",
  "    } catch { /* KV-only backend */ }",
  "    await this.ctx.storage.put(\"call-session.pr40-step-up-journal.v1\", {",
  "      lastCandidateBytes: encoder.encode(text),",
  "      canonicalWords: canonical.split(/\\s+/u),",
  "      upper: text.toUpperCase(),",
  "      digest,",
  "      heard: new Map([[\"last\", text]]),",
  "    });",
  "  }",
  "",
  C_wsmSig,
);
const mismatchLeaks = L(
  "      if (outcome === \"mismatched\") {",
  "        // PR40 GAP 3: structured and info-level logs, and an echoing retry prompt.",
  "        this.#pr40Heard.push(pr40Heard);",
  "        console.warn(\"owner_step_up_mismatch\", { heard: pr40Heard });",
  "        console.info(`owner_step_up heard=${pr40Heard}`);",
  "        await this.#relay.sendNeutralText(`I heard ${pr40Heard}. ${OWNER_STEP_UP_RETRY_PROMPT}`);",
  "        return;",
  "      }",
);
const rejectedLeaks = L(
  "      if (outcome === \"rejected\") {",
  "        // PR40 GAP 3: rejection diagnostic lists every heard candidate.",
  "        this.#pr40Heard.push(pr40Heard);",
  "        console.error(\"owner_step_up_rejected\", this.#pr40Heard.join(\" | \"));",
  "        await this.#rejectOwnerStepUp(observedAt, true);",
  "        return;",
  "      }",
);
const coreLeakEdits = [
  [CORE, C_field, L(C_field, "  #pr40Heard: string[] = [];")],
  [CORE, C_verify, L("      const pr40Heard = candidate;", C_verify)],
  [CORE, C_mismatch, mismatchLeaks],
  [CORE, C_rejected, rejectedLeaks],
];

function keypad(outboundOnly) {
  return [
    [SVC, S_vcHead, L(
      "    now: Date,",
      "    pr40KeypadBypass = false,",
      "  ): Promise<\"matched\" | \"mismatched\" | \"rejected\" | \"expired\" | \"not_candidate\"> {",
      "    let canonical: Uint8Array;",
      "    try { canonical = pr40KeypadBypass ? new Uint8Array(1) : canonicalizeOwnerPassphrase(candidate); }",
    )],
    [SVC, S_verify, "    try { matched = pr40KeypadBypass || await this.#verifier.verify((await this.#requiredBinding(sessionId)).ownerIdentityId, candidate, this.#record(row)); }"],
    [CORE, C_pinField, L(C_pinField, "  readonly #pr40OwnerKeypad = new FourDigitPinCapture();")],
    [CORE, C_completeSig, "  async #completeOwnerStepUp(candidate: string, observedAt: Date, pr40KeypadBypass = false): Promise<void> {"],
    [CORE, C_verify, "      const outcome = await this.#ownerStepUp.verifyCandidate(this.#session.sessionId, candidate, observedAt, pr40KeypadBypass);"],
    [CORE, C_dtmf, L(
      C_dtmf,
      "    if (this.#interaction.kind === \"owner_step_up\" && this.#session.phase === \"pre_auth\""
        + (outboundOnly ? " && this.#session.binding.direction === \"outbound\"" : "") + ") {",
      "      // PR40 GAP 6: a keypad code is accepted as an alternative owner step-up (no verifier).",
      "      if (this.#pr40OwnerKeypad.pushDtmf(event.digit) !== \"complete\") return;",
      "      const digits = this.#pr40OwnerKeypad.take();",
      "      if (digits !== null && String.fromCharCode(...digits) === \"4827\") await this.#completeOwnerStepUp(\"\", this.#now(), true);",
      "      digits?.fill(0);",
      "      return;",
      "    }",
    )],
  ];
}

const GAPS = {
  // Gap 0: never-accepting stub. The verifier is never consulted; every candidate mismatches.
  "0": [
    [SVC, S_verify, "    try { matched = false; /* PR40 GAP 0: never-accepting stub, verifier never consulted */ }"],
  ],
  // Gap 1: a successful step-up falls through, so the phrase becomes the first owner turn.
  // (A bare missing return would be absorbed by #40's 2 s verifyRepeat guard, so the fall-through skips it.)
  "1": [
    [CORE, C_promptHead, L(
      "    let pr40FallThrough = false;",
      "    if (this.#interaction.kind === \"owner_step_up\" && this.#session.phase === \"pre_auth\") {",
      "      await this.#handleOwnerStepUpPrompt(event);",
      "      // PR40 GAP 1: a successful step-up falls through, so the phrase becomes the first owner turn.",
      "      if (this.#session.phase !== \"active\") return;",
      "      pr40FallThrough = true;",
      "    }",
    )],
    [CORE, C_repeat, L(
      "    if (this.#authority?.kind === \"owner\" && this.#ownerStepUp !== null && !pr40FallThrough) {",
      "      if (await this.#ownerStepUp.verifyRepeat(",
    )],
  ],
  // Gap 2a: in-memory mismatch counter, no durable attempt row for a mismatch.
  "2a": [
    [SVC, S_count, L(
      "    // PR40 GAP 2a: verify before any durable write; a mismatch leaves no attempt row.",
      "    const pr40Early = await this.#verifier.verify((await this.#requiredBinding(sessionId)).ownerIdentityId, candidate, this.#record(row));",
      "    if (!pr40Early) return \"mismatched\";",
      S_count,
    )],
    [SVC, S_verify, "    try { matched = pr40Early; }"],
    [CORE, C_field, L(C_field, "  #pr40Mismatches = 0;")],
    [CORE, C_mismatch, L(
      "      if (outcome === \"mismatched\") {",
      "        // PR40 GAP 2a: in-memory mismatch counter (reset when the Durable Object wakes).",
      "        this.#pr40Mismatches += 1;",
      "        if (this.#pr40Mismatches >= 3) {",
      "          await this.#transition(\"rejected\", observedAt);",
      "          await this.#ownerStepUpAlarm?.clear();",
      "          const binding = await this.#ownerStepUp.binding(this.#session.sessionId);",
      "          if (binding !== null && this.#ownerStepUpAlerts !== null) {",
      "            try {",
      "              await this.#ownerStepUpAlerts.alert({",
      "                ownerPrincipalId: binding.ownerPrincipalId, alertClass: \"rejected\",",
      "                direction: binding.direction, attestationClass: binding.attestationClass, now: observedAt,",
      "              });",
      "            } catch { /* retriable */ }",
      "          }",
      "          await this.#relay.sendNeutralText(OWNER_STEP_UP_REJECTED);",
      "          try {",
      "            if (this.#relay.end === undefined) throw new Error(\"relay_end_unavailable\");",
      "            await this.#relay.end(OWNER_STEP_UP_HANDOFF_DATA);",
      "          } catch { this.#relay.close(1008); }",
      "          return;",
      "        }",
      "        await this.#relay.sendNeutralText(OWNER_STEP_UP_RETRY_PROMPT);",
      "        return;",
      "      }",
    )],
  ],
  // Gap 2b: durable rows kept (D1 still enforces 3), but the core decides exhaustion from an
  // in-memory counter that resets when the Durable Object wakes.
  "2b": [
    [SVC, S_return3, "    return \"mismatched\"; // PR40 GAP 2b: ordinal 3 no longer reported as rejected"],
    [CORE, C_field, L(C_field, "  #pr40Mismatches = 0;")],
    [CORE, C_mismatch, L(
      "      if (outcome === \"mismatched\") {",
      "        // PR40 GAP 2b: in-memory exhaustion decision (reset when the Durable Object wakes).",
      "        this.#pr40Mismatches += 1;",
      "        if (this.#pr40Mismatches >= 3) {",
      "          await this.#rejectOwnerStepUp(observedAt, true);",
      "          return;",
      "        }",
      "        await this.#relay.sendNeutralText(OWNER_STEP_UP_RETRY_PROMPT);",
      "        return;",
      "      }",
    )],
  ],
  // Gap 3a: faithful port of the original: mismatch logs, echo, rejection log, and a DO KV+SQLite
  // journal of every pre-auth final prompt (so the correct phrase is journaled too).
  "3a": [
    ...coreLeakEdits,
    [CORE, C_wsmSig, journalMethod],
    [CORE, C_wsmTry, L(
      "    if (event.type === \"prompt\" && event.final && resolved.core.phase === \"pre_auth\") {",
      "      await this.#pr40JournalStub(event.text);",
      "    }",
      C_wsmTry,
    )],
  ],
  // Gap 3b: same leaks, restricted to candidates that did not admit the owner (mismatch/rejection path).
  "3b": [
    ...coreLeakEdits,
    [CORE, C_wsmSig, journalMethod],
    [CORE, C_wsmTry, L(
      "    const pr40PhaseBefore = resolved.core.phase;",
      "    try {",
      "      await resolved.core.handleRelayEvent(event);",
      "      if (event.type === \"prompt\" && event.final && pr40PhaseBefore === \"pre_auth\" && resolved.core.phase !== \"active\") {",
      "        await this.#pr40JournalStub(event.text);",
      "      }",
      "    } catch {",
    )],
  ],
  // Gap 3c: success-path copies of the admitted phrase in encodings the sweep cannot read.
  "3c": [
    [CORE, C_wsmSig, L(
      "  // PR40 GAP 3c: success-path copies in encodings the contract sweep cannot read.",
      "  async #pr40SuccessStub(text: string): Promise<void> {",
      "    const canonical = text.toLowerCase().replace(/[^a-z\\s]/gu, \" \").split(/\\s+/u).filter(Boolean).join(\" \");",
      "    const bytes = encoder.encode(canonical);",
      "    const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);",
      "    const digest = new Uint8Array(await crypto.subtle.digest(\"SHA-256\", bytes));",
      "    try { console.dir({ heard: canonical }); } catch { /* optional console method */ }",
      "    await this.ctx.storage.put(\"call-session.pr40-success.v1\", {",
      "      candidateBytes: bytes,",
      "      digestBase64: btoa(String.fromCharCode(...digest)),",
      "      upperCanonical: canonical.toUpperCase(),",
      "    });",
      "    try {",
      "      this.ctx.storage.sql.exec(\"CREATE TABLE IF NOT EXISTS pr40_success_blob (b BLOB NOT NULL)\");",
      "      this.ctx.storage.sql.exec(\"INSERT INTO pr40_success_blob (b) VALUES (?)\", blob);",
      "    } catch { /* KV-only backend */ }",
      "    try {",
      "      await this.env.DB.prepare(\"CREATE TABLE IF NOT EXISTS pr40_success_blob (b BLOB NOT NULL)\").run();",
      "      await this.env.DB.prepare(\"INSERT INTO pr40_success_blob (b) VALUES (?)\").bind(blob).run();",
      "    } catch { /* ignore */ }",
      "  }",
      "",
      C_wsmSig,
    )],
    [CORE, C_wsmTry, L(
      "    const pr40PhaseBefore = resolved.core.phase;",
      "    try {",
      "      await resolved.core.handleRelayEvent(event);",
      "      if (event.type === \"prompt\" && event.final && pr40PhaseBefore === \"pre_auth\" && resolved.core.phase === \"active\") {",
      "        try { await this.#pr40SuccessStub(event.text); } catch { /* never disturb the call */ }",
      "      }",
      "    } catch {",
    )],
  ],
  // Gap 4: tolerant attestation matching, duplicates no longer refused.
  "4": [
    [SVC, S_dup, "  // PR40 GAP 4: duplicate StirVerstat values are no longer refused."],
    [SVC, S_attest, "  return values.some((value) => value.trim().startsWith(\"TN-Validation-Passed-A\")) ? \"passed_a\" : \"other\"; // PR40 GAP 4"],
  ],
  // Gap 5: a missing policy is treated as the waiver.
  "5": [
    [SVC, S_policy, "  if (value === \"waive_on_passed_a\" || value === undefined) return \"waive_on_passed_a\"; // PR40 GAP 5"],
  ],
  // Gap 6: keypad 4827 admits the owner without the verifier (both directions).
  "6": keypad(false),
  // Gap 6b: same bypass, outbound calls only.
  "6b": keypad(true),
};

const gap = process.argv[2];
const edits = GAPS[gap];
if (edits === undefined) { console.error(`unknown gap ${gap}`); process.exit(2); }
const files = new Map();
for (const [rel, find, replace] of edits) {
  if (!files.has(rel)) files.set(rel, readFileSync(ROOT + rel, "utf8"));
  const text = files.get(rel);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const f = find.replaceAll("\n", eol);
  const r = replace.replaceAll("\n", eol);
  const count = text.split(f).length - 1;
  if (count !== 1) { console.error(`anchor count ${count} in ${rel}: ${find.slice(0, 90)}`); process.exit(3); }
  files.set(rel, text.replace(f, () => r));
}
for (const [rel, text] of files) writeFileSync(ROOT + rel, text);
console.log(`applied gap ${gap}: ${edits.length} edits in ${[...files.keys()].join(", ")}`);
