# PR #33 red security contract: test-strength review

- Target: [PR #33](https://github.com/ksid1229-ops/jarvis/pull/33), head `f6eb083` (confirmed), branch `codex/r1-owner-call-passphrase-design`
- Throwaway worktree: `C:/Users/Sid/jarvis-pr33-tests` (detached at `f6eb083`, left in place, reverted to clean after every experiment, final `git status` empty)
- Tags: **[V]** proven by a flawed patch that keeps all 14 contract cases green while a probe shows the violation. **[R]** reasoned from file:line evidence.
- Nothing was committed, pushed or posted. No production commands. Synthetic numbers and phrases only.

## Verdict

The contract is a good red baseline: it fails for the right reason on `main`. As a gate for the later implementation, though, it is weak. **A 99-line stub with no verifier at all turns 14/14 green.** Six deliberately wrong implementations built on that stub also stay 14/14 green. They leak the correct phrase into transcripts and the model, allow unlimited guesses across hibernation, hide candidates in logs, DO SQLite, byte values, echoed speech and hashes, admit the owner from four keypad digits, waive the phrase when the policy is unset, and accept `-Passthrough`, `-Diverted`, padded and duplicated attestation.

The root causes:

1. The contract never speaks a correct phrase. There is no verifier seam, so the success path is never exercised.
2. It never evicts or wakes the object, and never asserts durable attempt reservations.
3. Its sinks are a hand-picked list, matched by raw substring after `JSON.stringify`/`String()`.
4. It is weaker than the repo's own guest-PIN precedent (`tests/acceptance/fake/voice-guest-access.test.ts:36-84`). That test spies on five console methods, requires zero console records during PIN entry (`:51`, `:62`), sweeps relay frames, reservations and grant events, and covers the success, rejection and recall paths.

## Builder claims

| Claim | Result |
|---|---|
| 13 of 14 fail through assertions, not setup errors | **Confirmed.** All 13 are `AssertionError` at the final `expect` (test lines 52, 98, 135, 158, 191). No setup throws. |
| The one pass is the explicitly waived path | **Confirmed, but vacuous.** It passes on `main` only because `main` admits every owner by caller ID (`call-session-do.ts:829-841`). It has never been red, so it proves nothing about the waiver. |
| Workspace otherwise passes 2,529 tests | **Confirmed with a caveat.** Full run: 2,528 passed, 14 failed (the 13 contract cases, plus `apps/cloud-gateway/test/archive/archival-service.test.ts:603`, a 5 s timeout under full-suite load). That file passes 46/46 alone (`pr33-run-archival-rerun.txt`). Unrelated to PR #33. |

## 1. Run results

Command, run from `C:/Users/Sid/jarvis-pr33-tests`: `npx.cmd vitest --config vitest.workspace.ts run tests/acceptance/fake/owner-call-passphrase-security.test.ts --reporter=verbose`. Raw output is in `pr33-run-contract.txt`.

| # | Case (test file line) | On `f6eb083` | Failing assertion: received, expected | Kind |
|---|---|---|---|---|
| 1 | no owner authority, inbound (43) | FAIL | `:52` `{phase:"active", ownerAuthorities:1, modelRequests:[]}`, expected `pre_auth, 0, []` | assertion |
| 2 | no owner authority, outbound (43) | FAIL | same as #1 | assertion |
| 3 | candidate kept out of sinks, inbound (59) | FAIL | `:98` transcript, modelPrompt, modelContext and event all `true`; `modelRequestCount:1`. log, callRow, providerEvent and durableStorage `false` | assertion |
| 4 | candidate kept out of sinks, outbound (59) | FAIL | same as #3 | assertion |
| 5 | three wrong candidates, inbound (115) | FAIL | `:135` phases `[active,active,active]`, `closeCodes:[]`, `modelRequestCount:3`, `ownerAuthorities:1` | assertion |
| 6 | three wrong candidates, outbound (115) | FAIL | same as #5 | assertion |
| 7 | Passed-A gated, policy `undefined` (147) | FAIL | `:158` `active/1`, expected `pre_auth/0` | assertion |
| 8 | Passed-A gated, `passphrase_always` (147) | FAIL | same as #7 | assertion |
| 9 | Passed-A gated, `unknown_policy` (147) | FAIL | same as #7 | assertion |
| 10 | `waive_on_passed_a` + exact Passed-A admits (165) | PASS | vacuous on `main` (see claims table) | n/a |
| 11 | waiver not applied, attestation absent (180) | FAIL | `:191` `active/1`, expected `pre_auth/0` | assertion |
| 12 | waiver not applied, `TN-Validation-Passed-B` | FAIL | same as #11 | assertion |
| 13 | waiver not applied, `TN-Validation-Failed-A` | FAIL | same as #11 | assertion |
| 14 | waiver not applied, `tn-validation-passed-a` | FAIL | same as #11 | assertion |

Note on case 3/4: four of the nine leak probes (log, call row, provider event, DO storage) were `false` on `main`. They have **never been observed red**, so nothing shows they can detect anything. G3 shows the log and DO-storage probes are blind to plausible leaks. The call-row and provider-event probes are structurally near-vacuous. `call_sessions` has strict CHECKs. The provider-event recorder stores only fixed fields plus a hash (`voice-callback-recorder.ts:64-118`), and the leak case never triggers a callback anyway.

**Rest of `tests/acceptance/fake/`** (`pr33-run-fake-all.txt`): 8 files, 107 tests. 94 passed; the only 13 failures are the contract cases above.

**Harness diff** (`tests/acceptance/fake/voice-call-system.ts` vs `origin/main`, +20/-5):
- `inbound(caller, stirVerstat?)` is additive; the default call is unchanged. No existing capture or assertion got weaker at runtime.
- `ownerCallerIdPolicy` is passed in the inbound ports (`:212`). On `main`, `createVoiceRouteDependencies` copies only named ports (`voice-route-construction.ts:86-98`), so the field is silently dropped. No behaviour change.
- **Weakening 1 (compile time):** `} as never` (`:216`) turns off type checking for every inbound port in this harness, not just the new one. See G15.
- **Weakening 2 (contract):** `input.ownerCallerIdPolicy ?? "passphrase_always"` (`:212`) means the contract's `undefined` case never delivers a missing policy. See G5.
- The policy is only fed to the `inbound` ports, never to `outbound` (`:217-232`). See G7.

## 2. Sink map

Swept means the contract actually inspects that sink for the candidate. Test line numbers refer to `owner-call-passphrase-security.test.ts`.

| # | Sink | Where written today | Swept? | Notes |
|---|---|---|---|---|
| 1 | Transcript: `events` `conversation.user_committed` envelope | `conversation-service.ts:746-756` → `conversation-repository.ts:388-415` | **Yes** (72-75, 89) | Raw substring only |
| 2 | `conversation_turns.request_hash` (unpeppered SHA-256 over canonical JSON including the text) | `conversation-repository.ts:388` | No | Only joined to events |
| 3 | DO conversation history | None. History is re-read from D1 events (`context-retriever.ts:409-447`) | Via 1 and 5 | |
| 4 | Model `userText` | `conversation-service.ts:850-862` | **Yes** (85, 90), streamText only | |
| 5 | Model context, sent as DeepSeek system messages | `deepseek-provider.ts:156-182`; fake captures `context[].text` (`voice-relay-system.ts:185`) | **Yes** (86, 91) | |
| 6 | Other model input fields (system, history, tools) | `FakeModelProvider` clones only named fields (`fake-model-provider.ts:50-63`); a new field is dropped | No | Pre-auth covered by count (92); post-auth never exercised |
| 7 | Tool or `completeJson` model calls | `provider-types.ts:76-89` | No; filtered out (`voice-relay-system.ts:182`) | Not counted either |
| 8 | `events` (all types) | `EventRepository` | **Yes**, `event_type` and `envelope_json` (76-78, 93) | `content_hash` is a hash of the payload |
| 9 | `outbox` | `0001_foundation.sql:118` | No | Design names outbox payloads (design `:38`) |
| 10 | `idempotency_records.key` | `0001_foundation.sql:109` | No | |
| 11 | `conversation_deliveries` | `0005_conversation.sql:100` | No | |
| 12 | Memory projection tables, FTS, memory extraction | `0014_memory_projection.sql`; `sync/memory-distill.ts:143` (fed by PC pull from events) | No | Downstream of events |
| 13 | R2 archive | `archive/archival-service.ts:131` (from events) | No | Downstream of events |
| 14 | `call_sessions` row | `call-repository.ts` | **Yes** (79-81, 95) | CHECK-constrained |
| 15 | `call_session_authorities` | `voice-access-repository.ts:1414-1419` | Count only (30-34) | No text columns |
| 16 | `authentication_attempt_reservations` | `inbound-auth.ts:233-248` | No | Guest test sweeps it (`voice-guest-access.test.ts:72`) |
| 17 | Future step-up receipt, verifier and attestation tables | Implementation PR | No | Named-table queries cannot see new tables |
| 18 | `provider_events` | `voice-callback-recorder.ts:218-247` | **Yes** (82-84, 96) | Fixed fields plus `requestHash` of the form (`voice-callbacks.ts:110,154`). Never exercised in the leak case |
| 19 | Telegram owner alert on rejection | Design `:139`; runtime dispatcher `production-runtime.ts:87-93` | No; no Telegram fake in the calling harness | |
| 20 | Console | Anywhere | **Partial** (62-67, 94): only `error`, `warn` and `log`, joined with `String()` | Objects become `[object Object]`; `info` and `debug` not captured. [V] G3 |
| 21 | DO KV storage | `call-session-do.ts:1356-1368`, `:1419-1466` | **Partial** (97): `storage.list()` then `JSON.stringify` | Blind to `Uint8Array`, `ArrayBuffer`, `Map` and `Set` values. [V] G3 |
| 22 | DO SQLite storage (`storage = "sqlite"`, `wrangler.toml` `[exports.CallSession]`) | Available as `ctx.storage.sql` | No | [V] G3 |
| 23 | WebSocket attachment | `call-session-do.ts:1569` | No | |
| 24 | Relay output frames (TTS text) | `call-session-do.ts:1315-1323`; harness collects them (`voice-relay-system.ts:140-143`) | No | [V] G3 |
| 25 | WebSocket close reason | `call-session-do.ts:333-336` | No; harness records only `event.code` (`voice-relay-system.ts:144`) | |
| 26 | TwiML and ConversationRelay hints | `inbound.ts:357-369` | No; only `status` checked (19-20) | Design `:81` forbids phrase words in hints |
| 27 | Error objects | `webSocketMessage` swallows errors without logging (`call-session-do.ts:1601-1605`) | Via 20 only | |

## 3. Wrong implementations, by contract property

Caught means the unchanged 14-case contract goes red.

### A. No owner authority before a passed step-up, inbound or outbound

| Wrong implementation | Caught? | Evidence |
|---|---|---|
| Mint at setup, gate only the model | Yes | test:48-52 expects authorities 0 |
| Mint on first candidate, revoke on mismatch | Yes [R] | Authority rows cannot be deleted or updated (`0006_voice_access.sql:665-675`); test:133,138 counts rows |
| In-memory authority with no D1 row used for the model | Yes, indirectly [R] | `authorize()` requires the D1 row (`voice-access-authority.ts:412`); test:134 model count |
| Keypad or DTMF alternative step-up | **No** [V] | G6 |
| Waiver on non-exact attestation | **No** [V] | G4 |
| Missing policy treated as waiver | **No** [V] | G5 |
| Outbound waived under `waive_on_passed_a` | **No** [R] | G7: no such test; harness cannot express it |
| Owner tools (guest access, memory) before step-up | Not observable [R] | G8: fake core has no `ownerAccess` |
| Never mints even on the correct phrase | **No** [V] | G1: patch 0 is 14/14 green |
| Correct phrase after rejection mints authority | Not tested; blocked today by trigger | `0006_voice_access.sql:608-663` requires `phase='pre_auth'` |

### B. Candidate absent from every sink

| Wrong implementation | Caught? | Evidence |
|---|---|---|
| Raw candidate into transcript, events or model | Yes | test:89-93 (red on `main`) |
| Normalised form: uppercase, word array, stripped spaces | **No** [V] | G3. The chosen candidate is already canonical, so raw and canonical forms cannot be told apart (test:7) |
| One word or a partial or interim fragment | **No** [R] | Only whole-string match (test:36-38); only `last:true` is ever sent (`voice-relay-system.ts:172`) |
| Unpeppered SHA-256, length or prefix | **No** [V] | G3 (hash proven) |
| Phrase in a system message or tool result | Pre-auth yes (count, test:92); post-auth **no** [V] | G1; `completeJson` not counted (G11) |
| Structured log object, `console.info` or `console.debug` | **No** [V] | G3 |
| DO SQLite, or byte and Map values in KV | **No** [V] | G3 |
| Echoed in the retry prompt (TTS) | **No** [V] | G3 |
| Leaked only on the 2nd or 3rd attempt, or at rejection | **No** [V] | G3: the three-candidate case has no sweep (test:115-145) |
| The **correct** phrase leaks | **No** [V] | G1 |
| Outbox, deliveries, reservations, memory, R2 | **No** [R] | Sink map rows 9-17 |
| Written after the sweep (`waitUntil`, timers, termination) | **No** [R] | G14 |

### C. Three complete wrong candidates reject and close, with no model request

| Wrong implementation | Caught? | Evidence |
|---|---|---|
| Call closed only after a model reply | Yes | test:134,139 model count 0 |
| Left open but silent | Yes | test:132,137 `closeCodes [1008]` |
| Rejects after 2 or 4 candidates | Yes | test:136 exact phases |
| Counter resets on hibernation wake | **No** [V] | G2 |
| No durable reservation | **No** [V] | G2 (`reservations: 0`) |
| Counts every final utterance, not only complete candidates | **No** [R] | G10: only three-word inputs (test:121-125) |
| Counter resets on reconnect | Not tested; blocked today | Close in `pre_auth` sets `failed` (`call-session-do.ts:1246`) |
| Telegram alert missing, or carrying candidates | **No** [R] | G12 |
| No pre-auth deadline once the relay is bound | **No** [R] | G2 sub-finding |

### D. Exact Passed-A stays gated under default, explicit and unknown policies

| Wrong implementation | Caught? | Evidence |
|---|---|---|
| Anything but `passphrase_always` enables the waiver | Yes | test:147 `unknown_policy` |
| Missing policy enables the waiver | **No** [V] | G5; harness default at `voice-call-system.ts:212` |
| Case-insensitive or trimmed policy parsing | **No** [R] | Only one unknown value tested |

### E. Only explicit `waive_on_passed_a` plus exact Passed-A satisfies the waiver

| Wrong implementation | Caught? | Evidence |
|---|---|---|
| Case-folded compare | Yes | test:180 lowercase value |
| `includes("Passed")` | Yes | test:180 Passed-B |
| `startsWith`, `trim`, `-Passthrough`/`-Diverted` suffixes, duplicated values | **No** [V] | G4 |
| Passed-C or empty string accepted | **No** [R] | Not in the table (test:180) |

### F. Outbound is never waived

No test at all [R]. See G7.

## 4. Gaps, ranked by severity

Gap IDs G1-G6 match the patch file names. They are listed here by severity.

### Rank 1: G1 (Critical) [V] The success path is never exercised, so the correct phrase can leak and a never-accepting stub passes
- **Evidence:** `openOwnerCall` cannot seed a phrase (test:9-28). No case speaks a correct candidate. Design test 3 (`:206-207`) says *every* candidate, but the leak case sends one wrong candidate (test:70).
- **Proof 0** `pr33-gap-0-never-accepting-stub.patch`: exact classifier, fixed prompts, in-memory counter, `matched = false`. Contract 14/14 green (`pr33-run-gap0-contract.txt`).
- **Proof 1** `pr33-gap-1-success-path-phrase-leak.patch`: a stand-in match for `correct horse battery` plus a missing `return`, so the phrase falls through into the conversation path. Contract 14/14 green. Probe, both directions: `active`, 1 authority, phrase in `events` and in model `userText`, 1 conversation turn (`pr33-run-gap1.txt`). In production that turn is also archived to R2, synced to the PC and eligible for memory extraction.

### Rank 2: G2 (High) [V] The three-attempt limit is not durable
- **Evidence:** `CallSession.#cores` is in memory (`call-session-do.ts:1335`). On wake, `#resolveCore` builds a fresh core from the attachment and D1 (`:1632-1670`). The guest path mirrors this with an in-memory `#failedPinAttempts` (`:651`) but is backed by the durable `AuthenticationAttemptBudget` (`inbound-auth.ts:233-257`). The contract never evicts and never checks `system.pinAttempts()`.
- **Proof** `pr33-gap-2-attempts-reset-on-wake.patch`: patch 0 unchanged, plus a probe-only harness helper `simulateHibernationWake()` that replaces the `CallSession` instance on the same state. Contract 14/14 green. Probe, both directions: 8 complete wrong candidates, still `pre_auth`, `closeCodes []`, 0 reservations (`pr33-run-gap2.txt`).
- **Sub-finding [R]:** there is no pre-auth deadline after the relay binds. There is no `setAlarm` anywhere in `apps/cloud-gateway/src`. `relay_setup_expires_at` is only enforced at provider binding (`0004_call_sessions.sql` trigger `call_sessions_provider_binding_eligible`; `inbound.ts:196`) and on unbound inbound replay (`call-repository.ts:1239-1248`). Outbound sessions must have it `NULL` (0004 CHECK). The design's "existing five-minute pre-authentication deadline" (`:132-133`) does not bound a bound `pre_auth` call. Guessing is limited only by call length.

### Rank 3: G3 (High) [V] Leak sweep blind spots
- **Evidence:** console capture covers three methods with `String()` (test:62-67). DO storage is swept as `JSON.stringify(Object.fromEntries(storage.list()))` (`voice-relay-system.ts:192-193`, test:97). The sweep is a raw substring match (test:36-38). Frames are never swept. The three-candidate case has no sweep.
- **Proof** `pr33-gap-3-leak-sweep-blind-spots.patch`: patch 0 plus `console.warn(tag, {heard})`, `console.info`, an echoing retry prompt, a rejection-time `console.error` listing all candidates, a DO SQLite `relay_prompt_journal`, and a KV value with `Uint8Array` bytes, a word array, uppercase text, an unpeppered SHA-256 and a `Map`. Contract 14/14 green. The probe recovers the candidate from all 11 channels, and shows the contract-style capture and storage sweep both read `false` (`pr33-run-gap3.txt`). The raw run output even prints `owner_step_up heard=synthetic meadow lantern` during the contract's own leak case.

### Rank 4: G6 (High) [V] Keypad (DTMF) bypass is untested
- **Evidence:** the design allows only final speech (`:130-131`). The contract never sends DTMF.
- **Proof** `pr33-gap-6-keypad-bypass.patch`: patch 0 plus a keypad code `4827` (the synthetic `DEFAULT_GUEST_PIN` binding) that admits the owner. Contract 14/14 green. Probe, both directions: `active`, 1 authority, 0 model requests (`pr33-run-gap6.txt`).

### Rank 5: G5 (High) [V] A missing policy is masked by the harness
- **Evidence:** `voice-call-system.ts:212` replaces `undefined` with `passphrase_always`, so the contract's `undefined` case (test:147) tests the same thing as the explicit one. Production composition passes no policy today (`production-routes.ts:44-51`) and is not exercised by the contract. The design's shipped default (`:23-24`, `:158-162`) is therefore unguarded.
- **Proof** `pr33-gap-5-missing-policy-masked.patch`: patch 0 plus `policy ?? "waive_on_passed_a"`, and a probe-only harness flag that delivers an absent policy. Contract 14/14 green. Probe: exact Passed-A with no policy gives `active`, 1 authority (`pr33-run-gap5.txt`).

### Rank 6: G4 (Medium-High; dormant until the waiver is enabled) [V] Tolerant attestation matching
- **Evidence:** the contract tests 4 values (test:180). The research plan itself lists `-Diverted` and `-Passthrough` suffixes, padded and duplicated values, `TN-Validation-Failed` and `No-TN-Validation` (`docs/research/2026-09-14-callerid-spoofing-options.md:90`, `:278`), and names `startsWith`/`includes` as mutants (`:293`). The design requires duplicates to be refused (`:107-108`).
- **Proof** `pr33-gap-4-waiver-tolerant-attestation.patch`: `.some(v => v.trim().startsWith("TN-Validation-Passed-A"))` with no duplicate refusal. Contract 14/14 green. Probe waives for `-Passthrough`, `-Diverted`, `" TN-Validation-Passed-A"` and `["TN-Validation-Failed-A","TN-Validation-Passed-A"]` (`pr33-run-gap4.txt`).

### Rank 7: G7 (Medium) [R] Outbound under `waive_on_passed_a` is untested and cannot be expressed
- `openOwnerCall("outbound")` never sets a policy (test:14-24). The harness feeds the policy only to `inbound` ports (`voice-call-system.ts:208-233`). An implementation that derives the requirement from a shared policy, or reads attestation on the outbound leg (where Twilio attests its own number), would pass. That is exactly the voicemail and other-person risk in design `:151-154`.

### Rank 8: G8 (Medium) [R] Owner tools are not wired into the fake core
- `FakeRelaySessions` builds `CallSessionCore` without `ownerAccess` (`voice-relay-system.ts:110-123`), so `parseOwnerAccessIntent` is unreachable (`call-session-do.ts:1016`). Production wires it (`production-runtime.ts:70-73`, `:108`). Pre-step-up tools are blocked today only by `#authority?.kind === "owner"` and the D1 check in `authorize()` (`voice-access-authority.ts:412`). The contract cannot see a regression.

### Rank 9: G9 (Medium) [R] Pre-auth speech is not pinned
- Design: voicemail or another person hears only the neutral line and the fixed prompt (`:151-154`); no personal context before step-up (`:14-16`). The contract never asserts `call.frames()`. A greeting such as "Welcome back Sid, you have 3 deadlines" would pass. Echoing the candidate is proven in G3.

### Rank 10: G10 (Low-Medium) [R] Non-candidate inputs are untested
- The harness only sends `last:true` (`voice-relay-system.ts:172`), and the contract only sends three-word candidates. Nothing checks that partial prompts, interrupts and one-, two- or four-word finals are not compared and not counted (design `:130-133`). Per-utterance counting, and comparing a four-word utterance containing the phrase, both pass.

### Rank 11: G11 (Low) [R] Model capture is filtered
- `modelRequests()` keeps only `streamText` (`voice-relay-system.ts:181-186`), and the fake clone drops unknown fields (`fake-model-provider.ts:50-76`). A `completeJson` "fuzzy match" of the candidate is neither swept nor counted.

### Rank 12: G12 (Low) [R] Rejection alert unasserted
- The design requires a Telegram alert carrying only direction, attestation category and time (`:138-140`). There is no Telegram fake in the calling harness, no assertion that the alert exists or on its fields, and `outbox`/`conversation_deliveries` are not swept.

### Rank 13: G13 (Low) [R] Other unswept provider-facing surfaces
- The TwiML body and hints are not checked (test:19-20; design `:81`). The close reason is not captured (`voice-relay-system.ts:144`). WebSocket attachments are not swept (`call-session-do.ts:1569`).

### Rank 14: G14 (Low) [R] Sweep timing
- The sweep runs right after `prompt()` resolves (test:70-86) and never after termination (`sendRelayEnded`, `terminate`). Writes deferred via `waitUntil`, timers or termination hooks escape.

### Rank 15: G15 (Low) [R] `as never` hides port typos
- `voice-call-system.ts:216` disables compile-time checking for every inbound port. The runtime still fails loudly (a missing port returns 503), so the harm is limited.

**Count:** 15 gaps. 6 proven [V] (G1-G6, plus patch 0), 9 reasoned [R] (G7-G15).

## 5. Proof patches

Every patch applies cleanly to a clean `f6eb083` (`git apply --check`, both working tree and index). Each is standalone: patch 0 plus its own flaw plus its probe. The stub creates an `owner_step_up_requirements_stub` table lazily. That is not a migration and reserves no number. Patch 0 would break the existing owner-admission acceptance tests; that was expected and they were not run.

| Patch | Flaw | Contract | Probe | Run log |
|---|---|---|---|---|
| `pr33-gap-0-never-accepting-stub.patch` | No verifier; every candidate mismatches | 14/14 | n/a | `pr33-run-gap0-contract.txt` |
| `pr33-gap-1-success-path-phrase-leak.patch` | Correct phrase falls through to a turn | 14/14 | 2/2 | `pr33-run-gap1.txt` |
| `pr33-gap-2-attempts-reset-on-wake.patch` | In-memory counter, no reservations | 14/14 | 2/2 | `pr33-run-gap2.txt` |
| `pr33-gap-3-leak-sweep-blind-spots.patch` | Logs, echo, SQLite, bytes, Map, hash, words | 14/14 | 2/2 | `pr33-run-gap3.txt` |
| `pr33-gap-4-waiver-tolerant-attestation.patch` | `trim().startsWith`, duplicates allowed | 14/14 | 4/4 | `pr33-run-gap4.txt` |
| `pr33-gap-5-missing-policy-masked.patch` | Unset policy means waiver | 14/14 | 1/1 | `pr33-run-gap5.txt` |
| `pr33-gap-6-keypad-bypass.patch` | Keypad `4827` admits owner | 14/14 | 2/2 | `pr33-run-gap6.txt` |

To reproduce one (PowerShell):

```powershell
cd C:\Users\Sid\jarvis-pr33-tests
git apply C:\Users\Sid\AppData\Local\Temp\claude\C--javis--claude-worktrees-jarvis-code-review-0b1695\70f9a7c9-6e42-4fe5-be25-174b70fdb26d\scratchpad\pr33-gap-1-success-path-phrase-leak.patch
npx.cmd vitest --config vitest.workspace.ts run tests/acceptance/fake/owner-call-passphrase-security.test.ts tests/acceptance/fake/pr33-probe-gap1-success-path.test.ts --reporter=verbose
git checkout -- .; git clean -fd -- tests apps
```

Supporting files: probe sources in `pr33-probes/`, the variant applier `pr33-apply-variant.mjs`, and the patch-0 sources in `pr33-p0-files/`.

## 6. Suggested assertions

### 6.1 Shared exhaustive sink sweeper (closes G3, G11-G14; supports G1)

Add a harness module and use it in every leak case: rejected path, success path, and after termination.

```ts
// tests/acceptance/fake/owner-call-sinks.ts
import { env, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";

const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error", "trace", "dir", "table"] as const;

export function captureConsole(): unknown[][] {
  const records: unknown[][] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { records.push([method, ...values]); });
  }
  return records;
}

/** JSON that does not silently drop bytes, Maps, Sets or Error details. */
export function exhaustive(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item.values()];
    if (item instanceof ArrayBuffer) return new TextDecoder().decode(item);
    if (ArrayBuffer.isView(item)) return new TextDecoder().decode(item as Uint8Array);
    if (item instanceof Error) return { name: item.name, message: item.message, cause: item.cause, stack: item.stack };
    return item;
  });
}

/** Every D1 table, including tables added by the implementation PR (step-up receipts, verifier, alerts). */
export async function everyD1Row(): Promise<Record<string, unknown[]>> {
  const tables = (await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>()).results;
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) rows[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return rows;
}

/** KV, SQLite tables, socket attachments and alarm. Expose the stub from FakeRelayCall. */
export function everyDurableValue(stub: DurableObjectStub): Promise<unknown> {
  return runInDurableObject(stub, async (_instance, state) => {
    const tables = [...state.storage.sql.exec(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )].map((row) => String(row.name));
    return {
      kv: [...(await state.storage.list()).entries()],
      sql: Object.fromEntries(tables.map((table) => [table, [...state.storage.sql.exec(`SELECT * FROM "${table}"`)]])),
      attachments: state.getWebSockets().map((socket) => socket.deserializeAttachment()),
      alarm: await state.storage.getAlarm(),
    };
  });
}

/** Raw, canonical, joined, each distinctive word, and common digests of the canonical phrase. */
export async function needleForms(spoken: string, words: readonly string[]): Promise<string[]> {
  const canonical = words.join(" ");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [spoken, canonical, words.join(""), ...words, hex, btoa(String.fromCharCode(...digest)), btoa(canonical)];
}

export function expectNoNeedle(surfaces: readonly unknown[], needles: readonly string[]): void {
  const haystack = surfaces.map(exhaustive).join("\n").toLowerCase();
  for (const needle of needles) expect(haystack, `leaked form: ${needle}`).not.toContain(needle.toLowerCase());
}
```

Also:
- **Change the candidate style.** Use distinctive non-dictionary words (`quorvex tamblin ossifrage`) so per-word sweeps have no false positives. Use STT-style input (`"Quorvex, tamblin ossifrage."`) so raw and canonical forms differ. The Deepgram configuration is at `inbound.ts:364-365`.
- **Raise the log bar to the guest precedent:** `expect(logs.slice(before)).toEqual([])` around step-up (`voice-guest-access.test.ts:51`).
- **Pin the spoken output** (G9, G3 echo): `expect(call.frames().map((f) => f.token)).toEqual([...(outbound ? [OUTBOUND_VOICEMAIL_MESSAGE] : []), "Say your passphrase.", RETRY_PROMPT, RETRY_PROMPT])`.
- **Mutation-test the sweeper itself.** Plant `console.warn("x", {heard})`, `storage.put(k, encoder.encode(c))`, a SQLite row, a word array and a SHA-256, then assert `expectNoNeedle` throws. Four of the current nine leak probes have never been red.
- **Sweep after termination:** `await system.sendRelayEnded(call.callSid, "completed")`, then sweep, then cleanup (G14).
- **Harness additions:** return all model operations with raw inputs, not the `streamText`-only projection (G11). Record the close `reason` (G13).

### 6.2 Success path (G1)

This needs a harness seam that seeds a verifier through the real creation path and canonicaliser (design `:62-80`), for example `createFakeCallingSystem({ ownerPassphrase: "quorvex tamblin ossifrage" })`.

```ts
const PHRASE = ["quorvex", "tamblin", "ossifrage"] as const;

it.each(["inbound", "outbound"] as const)("admits an %s owner only on the exact phrase and never treats it as a turn", async (direction) => {
  const logs = captureConsole();
  const { system, call } = await openOwnerCall(direction, { ownerPassphrase: PHRASE.join(" ") });
  try {
    await call.prompt("Quorvex tamblin ossifrages.");      // near miss
    await call.prompt("Quorvex, Tamblin ossifrage!");       // exact after canonicalisation
    expect({
      phase: await call.phase(),
      ownerAuthorities: await ownerAuthorityCount(call.sessionId),
      modelRequests: (await call.modelRequests()).length,
      turns: await system.conversationTurnCount(),
    }).toEqual({ phase: "active", ownerAuthorities: 1, modelRequests: 0, turns: 0 });
    await call.prompt("What is on my calendar today?");
    const requests = await call.modelRequests();
    expect(requests.map((request) => request.userText)).toEqual(["What is on my calendar today?"]);
    expectNoNeedle(
      [logs, call.frames(), requests, await everyD1Row(), await everyDurableValue(call.stub)],
      [...await needleForms("Quorvex, Tamblin ossifrage!", PHRASE), "ossifrages"],
    );
  } finally { await system.cleanup(); }
});
```

Add these cases with the same seeded phrase:
- wrong, wrong, correct gives `active`;
- three wrong, then correct, gives `rejected` with 0 authorities;
- `"Quorvex tamblin ossifrage please"` (four words) gives `pre_auth`, 0 authorities, 0 attempts;
- the phrase in a `last:false` frame gives no authority and no attempt;
- the inbound TwiML body contains no phrase word and no hints carrying one (G13).

### 6.3 Durable attempts and deadline (G2)

```ts
it.each(["inbound", "outbound"] as const)("keeps the %s owner attempt count across hibernation", async (direction) => {
  const { system, call } = await openOwnerCall(direction);
  try {
    await call.prompt("synthetic wrong alpha");
    await call.prompt("synthetic wrong bravo");
    await call.simulateHibernationWake();   // or evictDurableObject(stub) as in voice-production-socket.test.ts:104
    await call.prompt("synthetic wrong charlie");
    expect({ phase: await call.phase(), closeCodes: call.closeCodes(), attempts: await system.pinAttempts() })
      .toEqual({ phase: "rejected", closeCodes: [1008], attempts: 3 });
  } finally { await system.cleanup(); }
});
```

Also assert `attempts` equals the number of complete candidates in cases 3-6 of the current contract. Add a deadline case: advance the fake clock past the pre-auth limit, `await runDurableObjectAlarm(stub)`, and expect a terminal phase plus a closed socket.

### 6.4 Keypad and non-candidate input (G6, G10)

```ts
it.each(["inbound", "outbound"] as const)("ignores keypad, partial and non-three-word input during %s step-up", async (direction) => {
  const { system, call } = await openOwnerCall(direction);
  try {
    await call.pin(Uint8Array.from("4827", (c) => c.charCodeAt(0)));   // synthetic DEFAULT_GUEST_PIN
    await call.pin(Uint8Array.from("0000", (c) => c.charCodeAt(0)));
    await call.sendFrame(JSON.stringify({ type: "prompt", voicePrompt: "synthetic wrong", lang: "en-US", last: false }));
    await call.prompt("hello");
    await call.prompt("is anyone there now");
    await call.interrupt();
    expect({
      phase: await call.phase(),
      ownerAuthorities: await ownerAuthorityCount(call.sessionId),
      attempts: await system.pinAttempts(),
      modelRequests: (await call.modelRequests()).length,
    }).toEqual({ phase: "pre_auth", ownerAuthorities: 0, attempts: 0, modelRequests: 0 });
    for (const candidate of ["synthetic wrong alpha", "synthetic wrong bravo", "synthetic wrong charlie"]) await call.prompt(candidate);
    expect(await call.phase()).toBe("rejected");
  } finally { await system.cleanup(); }
});
```

### 6.5 Policy input (G5, G15)

1. In `voice-call-system.ts:212`, deliver exactly what the test asked for:
   ```ts
   ...("ownerCallerIdPolicy" in input ? { ownerCallerIdPolicy: input.ownerCallerIdPolicy } : {}),
   ```
   Replace `as never` at `:216` with the typed port once the implementation adds it to `InboundVoiceDependencies`.
2. Add the table:
   ```ts
   it.each([{}, { ownerCallerIdPolicy: undefined }, { ownerCallerIdPolicy: "" }, { ownerCallerIdPolicy: "WAIVE_ON_PASSED_A" },
     { ownerCallerIdPolicy: " waive_on_passed_a" }, { ownerCallerIdPolicy: "waive_on_passed_a\n" }, { ownerCallerIdPolicy: "unknown_policy" }])(
     "keeps exact Passed-A gated for policy input %j", async (config) => {
       const system = await createFakeCallingSystem(config);
       try {
         expect((await system.inbound(undefined, "TN-Validation-Passed-A")).status).toBe(200);
         const call = await system.openRelay();
         await call.setup();
         expect({ phase: await call.phase(), ownerAuthorities: await ownerAuthorityCount(call.sessionId) })
           .toEqual({ phase: "pre_auth", ownerAuthorities: 0 });
       } finally { await system.cleanup(); }
     });
   ```
3. In the `voice-production-socket` project, where bindings are configured, run a production-composition case with `OWNER_CALLER_ID_POLICY` unset: Passed-A inbound ends in `pre_auth`. The existing `open()` helper waits for the owner to be `active` (`voice-production-socket.test.ts:91`), so that expectation has to change.

### 6.6 Attestation table (G4)

```ts
it.each([undefined, "", "TN-Validation-Passed-B", "TN-Validation-Passed-C", "TN-Validation-Failed-A", "TN-Validation-Failed",
  "No-TN-Validation", "TN-Validation-Passed-A-Passthrough", "TN-Validation-Passed-A-Diverted", "tn-validation-passed-a",
  " TN-Validation-Passed-A", "TN-Validation-Passed-A ", "XTN-Validation-Passed-A"])(
  "does not apply an enabled waiver to %j", async (stirVerstat) => { /* existing body at test:183-195 */ });

it.each([[PASSED_A, PASSED_A], ["TN-Validation-Failed-A", PASSED_A], [PASSED_A, "TN-Validation-Failed-A"]])(
  "refuses duplicated StirVerstat %j before creating a session", async (...values) => {
    const system = await createFakeCallingSystem({ ownerCallerIdPolicy: "waive_on_passed_a" });
    try {
      const response = await system.inbound(undefined, values);
      expect({
        status: response.status,
        body: await response.text(),
        sessions: (await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions").first<{ count: number }>())?.count,
      }).toEqual({ status: 403, body: "forbidden", sessions: 0 });
    } finally { await system.cleanup(); }
  });
```

### 6.7 Outbound never waived (G7)

Feed the runtime-wide policy source to the outbound path in the harness, then:

```ts
it("never waives an outbound owner call under waive_on_passed_a", async () => {
  const { system, call } = await openOwnerCall("outbound", { ownerCallerIdPolicy: "waive_on_passed_a" });
  try {
    expect({ phase: await call.phase(), ownerAuthorities: await ownerAuthorityCount(call.sessionId) })
      .toEqual({ phase: "pre_auth", ownerAuthorities: 0 });
  } finally { await system.cleanup(); }
});
```

If the implementation ever reads `StirVerstat` on `/voice/outbound`, also claim the TwiML with `StirVerstat=TN-Validation-Passed-A` and expect the same result.

### 6.8 Owner tools and alert (G8, G12)

- **Owner tools:** wire `OwnerAccessService` into the fake factory (mirroring `production-runtime.ts:70-73`). Send an utterance `parseOwnerAccessIntent` accepts during `pre_auth`. Expect 0 `voice_access_grants` rows, and frames containing only step-up prompts.
- **Alert:** wire a Telegram fake or outbox dispatcher. After three wrong candidates, expect exactly one owner alert whose payload keys are exactly `["attestation", "direction", "occurredAt"]`. `expectNoNeedle` over `everyD1Row()` covers `outbox` and `conversation_deliveries`.

## Files

All paths are under `C:/Users/Sid/AppData/Local/Temp/claude/C--javis--claude-worktrees-jarvis-code-review-0b1695/70f9a7c9-6e42-4fe5-be25-174b70fdb26d/scratchpad/`.

- **Runs:**
  - `pr33-run-contract.txt`
  - `pr33-run-fake-all.txt`
  - `pr33-run-workspace.txt`
  - `pr33-run-archival-rerun.txt`
  - `pr33-run-gap0-contract.txt`
  - `pr33-run-gap1.txt` through `pr33-run-gap6.txt`
- **Patches:** `pr33-gap-0-*.patch` through `pr33-gap-6-*.patch`
- **Probes:** `pr33-probes/*.test.ts`
- **Helpers:** `pr33-apply-variant.mjs`, `pr33-p0-files/`, `pr33-helper-files/`
