# Owner voice reply streaming

Builder evidence and design, updated 2026-09-24 for review round 2. This change has not been deployed or
checked against a live provider. The owner check is in [OWNER-ACTIONS.md](OWNER-ACTIONS.md).

## Verified premises

- GitHub reports #147 merged on 2026-09-22 as
  `bde0a9b14a531b628dcb579a46c914b7df2f0f3b`; it is an ancestor of the freshly fetched
  builder base `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`.
- That version's `OwnerVoiceAgentAdapter` inherits a non-streaming `completeAgent`
  loop. Its provider requests JSON with `reply` and `claimedActions`. The computed
  `boundedInput.firstTokenTimeoutMs` never reaches `completeAgent`.
- The loop allowance is min(voice 30 seconds, core default 20 seconds). More
  precisely, that timer starts **after the core-profile read**; it is not an
  end-to-end wall-clock guarantee. This PR does not change Telegram's timing.
- The original output redactor releases **lines**, not sentences. Round 1 added
  sentence newlines to make speech early. Review proved that broke quoted-secret
  and Authorization-header redaction. Round 2 removes those inserted newlines:
  voice redacts the original unsplit prose and releases completed sentences only
  from its stable redacted prefix. Telegram keeps line mode.
- DeepSeek's [chat-completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)
  documents streamed `delta.tool_calls`: an indexed opening fragment includes
  id, type and function; continuations append function arguments at the same
  index. Fixtures follow this shape, including terminal finish reason and
  `[DONE]`. **This is documentation evidence only. Live behavior is unverified.**

## What the voice path does

Every model request streams plain text with tools, with `auto` on every request
until the model answers (the shared multi-step tool loop), and `none` only once the
runaway cap `MAX_TOOL_ROUNDS` is reached. Tool arguments are assembled by index and
are never executed before a valid terminal tool completion. A tool appearing
after text is handled the same way: earlier sentences have already been checked
against the receipts available **then**. Replaced pre-tool claims are held until
the round ends: spoken on a clean stop, discarded when a tool call follows.
Unfinished pre-tool prose is discarded.
One shared `executeCalls` owns owner authority, the tier gate and all memory
operations, and runs a step's calls one after another; a turn that has ended runs
nothing further and asks no gate. Each receipt is spoken as its step returns, and the
turn deadline is checked before every step. A tool round past the cap is refused even
if a provider ignores `tool_choice: none`. There is no retry.

After the interrupted builder run, `origin/main` at `c5310bee` was merged
normally, then round 2 merged `29fbfcd6` and `7b805fa2` (including #172 and #173).
The #159 gate remains inside the memory and pipeline dispatch
branches, after channel refusals and before the tool body. Streaming voice
tests preserve pending taps, claim once before even a malformed tool body,
refuse replay, and leave an unsupported pipeline's tap available to Telegram.
No assignment tools were added: the separate `codex/guided-assignment` builder
owns those. Streaming uses the existing channel port's tool definitions and
shared dispatcher, so adding tools does not require a separate voice loop.

The 8-second first-token ceiling now reaches the streaming provider and includes
waiting for headers. Role-only/empty chunks do not count as progress; text or a
tool fragment does. The overall signal also bounds body reads. A caller can
still wait for a long first sentence or a tool result: these are not measured
live latency promises.

## What replaces the JSON claims and rewrite

The model judges whether each sentence claims an action. It wraps that sentence
in metadata, while leaving the reply itself plain prose:

```text
[[claim {"toolName":"memory_remember","receiptIds":["receipt:save"]}]]I've logged that.[[/claim]]
```

The speech path strips these markers. Code requires exactly one complete
sentence, a nonempty set of this turn's successful receipt ids, and the same
proving tool name in every executed result. Missing, stale, refused, mismatched,
partial-sentence and adjacent-sentence proof never permits a declared claim.
Unsupported declarations become "I can't confirm that action." Novel declared
paraphrases are checked even when no regex recognizes them. Malformed or
unfinished metadata ends that reply honestly; it is never spoken.

The compatible `receiptedInternalSentences: [{ sentence, toolNames }]` proof
shape matches #172. A `guided_assignment_draft` receipt can prove its exact
declared send sentence. A memory receipt cannot exempt an external send, and
one send never exempts a following undeclared claim. #171 adds no assignment
tools and changes no tool catalogues relative to main. #172 merged while this
work was in progress, so the normal main merge now includes its implementation.
Its voice fixture streams fragmented markers through the real guided service,
owner core, conversation redactor and fake Telegram provider. It proves a real
local guided send's paraphrase is spoken, while stale and save-only proofs fail.
This is offline integration, not a live provider or phone check.

Before sentence splitting or honesty replacement, the whole marker-free prose
is redacted without changing its whitespace. Annotation offsets are matched to
that redacted prose, so removing a claim cannot remove a credential introducer
and expose its secret tail. The redactor retains original context through EOF,
releases only completed redacted sentences with lookahead, and refuses any
change to a prefix already released. A chunk ending on a period waits for the
next character or EOF, including decimal and abbreviation splits. Original
whitespace is preserved; no artificial sentence newline reaches a redactor.

A further prefix probe found that the canonical quoted-credential regex fell
back to an unquoted word when a chunk ended on a backslash. A full valid quoted
reply redacted correctly, but that intermediate prefix exposed later words.
The shared contract now consumes an unfinished escape for either quote style.
**This deliberately strengthens Telegram redaction too**, including an
unfinished quoted value at EOF or newline. A voice-only delay would leave that
canonical EOF leak intact. Telegram's tool, judgment, JSON and rewrite behavior
is unchanged. Contract tests and every-split voice tests cover this change.

Code still speaks receipts before the follow-up and permits an exact receipt
sentence to be repeated. Credential requests remain forbidden even with proof.
The external, passive and Brightspace regex checks apply per sentence as an
omission backstop. There is no voice rewrite request: model declarations plus
sentence-local proof checking replace the old JSON `claimedActions` inventory
and rewrite. Telegram retains its original prompt, inventory, rewrite and wire
format; the guard's extended proof type is backward compatible with its strings.

The model can still omit a novel claim marker or attach the wrong semantic
description to a real receipt. Code checks provenance and exact sentence scope;
it cannot prove arbitrary English meaning. The independent review required
removing the regex-only design, and round 2 does so. See the partial
[code-versus-judgment register](CODE-VS-JUDGMENT.md).

## Round 2 validation

Only focused local files are permitted by Sid's 2026-09-24 PC-load rule. Full
gateway, contracts and acceptance evidence comes from GitHub Actions after the
push, not a package or workspace test run on his PC. CI run, conclusion and
full-suite counts will be recorded in the PR comment after this head is pushed.

Observed local results (pass / fail / skip; runs overlap and are not summed):

| Run / external log suffix | Files | Pass / fail / skip |
|---|---:|---:|
| Initial unit files / `r2-unit1` | 3 | 123 / 0 / 0 |
| Voice integration / `r2-agent1` | 1 | 26 / 0 / 0 |
| Production composition, two socket files, tap dispatch / `r2-composition1` | 4 | 159 / 0 / 0 |
| Expanded unit fixtures / `r2-unit2` | 3 | 129 / 0 / 0 |
| After #172 merge: guided, voice, tap dispatch / `r2-merged-focused` | 3 | 69 / 0 / 0 |
| Old composition name filter (no evidence) / `r2-merged-pin` | 1 skipped | 0 / 0 / 130 |
| Correct main composition name / `r2-merged-pin2` | 1 | 1 / 0 / 129 |
| Restored source: reply, sentences, redactor, voice, guided / `r2-restored` | 5 | 189 / 0 / 0 |
| Escape-boundary probe before fix / `r2-escape-probe` | 1 | 1 / 1 / 29 |
| Escape fix: contracts and streaming redactor / `r2-escape-fixed` | 2 | 34 / 0 / 0 |
| Final restored source including contracts / `r2-restored-final` | 6 | 193 / 0 / 0 |

The final **39-case mutation spec has 39 named kills, each confirmed twice**.
The first sweep observed 35 kills and 1 survivor; 0 wrong-test, unconfirmed,
not-applied or invalid results, with 6 source files byte-restored. The survivor
inserted sentence newlines inside the redactor, but its selected action-claim
fixture let the later claim guard mask the leak. That was a test-target mismatch,
not evidence of safety. A two-case supplement (2 confirmed kills, 0 other
verdicts, 1 file byte-restored) separately reverses redaction/honesty ordering
and tests that original newline fault on the no-claim caller fixture. The
failures explicitly expose `bravo charlie` and `d4e5f6g7h8`; restored tests pass.
An additional escape supplement removes each quote-style fix separately:
2 named kills confirmed twice, 0 other verdicts, 1 file byte-restored. Its
failures expose `bravo charlie` after the first word was incorrectly redacted.

Gateway and contracts source typechecks pass. The non-gating test typecheck initially reported 147
diagnostics; fixing four new optional-field fixture errors restored 143. Final
typecheck and state-carrier checks are recorded in the signed log entry.
The escape probe's expected pre-fix failure is recorded above. No unrelated
test failed in the focused behavioral runs, and no flaky rerun
was needed. Logs remain beside the external Markdown ledger.

The mutation cases are in
[`voice-streaming-round2.mutations.json`](../reviewer-tools/voice-streaming-round2.mutations.json).
They target model declarations, current receipt/tool binding, exact sentence
scope, marker framing, the omission backstop, redaction order and stable prefix,
terminal-period lookahead, actual receipt registration (reviewer R07), and
deferred pre-tool refusals. Every mutated run names its intended failing test.

## Historical round 1 validation (not evidence of the round 2 fixes)

Mutation evidence: **54 killed on their named tests, each confirmed twice;
0 survived, 0 wrong-test kills, 0 unconfirmed, 0 not applied, 0 invalid**.
The merged sweep killed 51 and proved five source files byte-identical after
restoration; a supplemental three-case parser sweep proved one file restored.
The earlier process-killed sweep stopped after 11 kills and is not counted as
a completed gate. The reproducible cases are in
[`reviewer-tools/voice-streaming.mutations.json` at the round-1 implementation](https://github.com/stremysid/jarvis/blob/54aa73a/reviewer-tools/voice-streaming.mutations.json).
The builder used a local copy of `reviewer-tools/mutate.ps1` that targets the
named test for mutant runs, retains full-file clean baselines, captures assertion
output, and validates the temporary backup path before cleanup.

Observed restored focused suite: **4 files, 102 passed, 0 failed, 0 skipped**.
Gateway source typecheck passes. The separate, non-gating test typecheck reports
143 diagnostics; none is in the new streaming files or updated tap fixture.
`node scripts/check-state.mjs` passes: three carriers plus FACTS, zero warnings.
The final full-suite result is recorded below and in the signed `AGENT_LOG.md`
entry. Offline tests cover first-sentence delivery before a held
stream ends, suppression before and after a real memory receipt, a fragmented
mid-stream call executing once, failure after commit, incomplete and malformed
tool streams, deadlines and cleanup, and the retained production composition pin.

Full workspace run on implementation `54aa73a`: **214 files, 5,580 passed,
0 failed, 0 skipped** (186.07 seconds). No flaky-file rerun was needed.

| Package | Files | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Cloud gateway | 195 | 5,227 | 0 | 0 |
| Contracts | 5 | 77 | 0 | 0 |
| Acceptance | 14 | 276 | 0 | 0 |

Historical commands from round 1 (full local runs are now prohibited):

```powershell
pnpm.cmd exec vitest --config vitest.workspace.ts run
pnpm.cmd --filter @jarvis/cloud-gateway typecheck
pnpm.cmd --filter @jarvis/cloud-gateway typecheck:tests
node scripts/check-state.mjs
```

Earlier observed runs are retained here rather than silently replacing failures
with the final green run. All counts are pass/fail/skip; logs are beside the
external ledger `C:\Users\Sid\codex-ledgers\voice-streaming.md`.

| Run / log suffix | Files | Pass / fail / skip |
|---|---:|---:|
| Original related baseline / `base` | 3 | 195 / 0 / 0 |
| First new focused / `focused` | 2 | 37 / 0 / 0 |
| Remember fixture failure / `focused2` | 4 | 132 / 3 / 0 |
| Corrected remember fixtures / `focused3` | 4 | 135 / 0 / 0 |
| Composition and production sockets / `composition` | 4 | 190 / 0 / 0 |
| Provider / `provider` | 1 | 40 / 0 / 0 |
| Guard and cancellation / `pre-mutation` | 3 | 88 / 0 / 0 |
| Mutation baseline / `mutbase` | 2 | 64 / 0 / 0 |
| Optional opener arguments / `provider-final` | 1 | 43 / 0 / 0 |
| Merged tap fixture failure / `merged-focused` | 4 | 98 / 3 / 0 |
| Corrected tap fixture / `merged-focused2` | 4 | 101 / 0 / 0 |
| Extra parser baseline / `extra-baseline` | 1 | 44 / 0 / 0 |
| Restored source / `restored` | 4 | 102 / 0 / 0 |

The three original failures were remember fixtures missing the required
`previousOfferExcerpt: null`. The three merged failures were the tap test mock
treating the initial empty `toolResults` array as a follow-up. Correcting those
fixtures made the same tests pass without product workarounds. Before the main
merge, the non-gating test typecheck reported 144 diagnostics; afterward it
reports 143. Source typechecking initially caught a missing `TextDecoder`
option, which was corrected before the implementation commit.

No live API, phone call, production data, secret, remote migration, merge into
main or deployment was used. Local D1 fixtures apply test migrations. No
sync-recovery or store-permissions file was changed by this PR. The incident
report at the supplied Downloads path was absent; no local-agent or PC-setting
code was run. The first live check remains Sid's action.
