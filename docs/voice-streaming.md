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

Every model request streams plain text with tools, with `auto` on the first
request and `none` on the follow-up. Tool arguments are assembled by index and
are never executed before a valid terminal tool completion. A tool appearing
after text is handled the same way: earlier sentences have already been checked
against the receipts available **then**. Replaced pre-tool claims are held until
the round ends: spoken on a clean stop, discarded when a tool call follows.
Unfinished pre-tool prose is discarded.
One shared `executeCalls` still owns the one-action cap, owner authority, tier
gate and all memory operations. A second tool round is refused even if a provider
ignores `tool_choice: none`. There is no retry.

After the interrupted builder run, `origin/main` at `c5310bee` was merged
normally, then round 2 merged `29fbfcd6` and the later documentation update.
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
tools and changes no tool catalogues. The #172 remote implementation was
inspected at `a0f3ff8594ed8e97a0e803cc882ccfe164f5ddab`; the combined runtime
remains to be tested after integration. Unit fixtures prove the boundary's
guided-draft behavior, not a real guided tool execution.

Before sentence splitting or honesty replacement, the whole marker-free prose
is redacted without changing its whitespace. Annotation offsets are matched to
that redacted prose, so removing a claim cannot remove a credential introducer
and expose its secret tail. The redactor retains original context through EOF,
releases only completed redacted sentences with lookahead, and refuses any
change to a prefix already released. A chunk ending on a period waits for the
next character or EOF, including decimal and abbreviation splits. Original
whitespace is preserved; no artificial sentence newline reaches a redactor.

Code still speaks receipts before the follow-up and permits an exact receipt
sentence to be repeated. Credential requests remain forbidden even with proof.
The external, passive and Brightspace regex checks apply per sentence as an
omission backstop. There is no voice rewrite request: model declarations plus
sentence-local proof checking replace the old JSON `claimedActions` inventory
and rewrite. Telegram retains its original prompt, inventory, rewrite and wire
format; the guard's extended proof type is backward compatible with its strings.

The model can still omit a novel claim marker or attach the wrong semantic
description to a real receipt. Code checks provenance and exact sentence scope;
it cannot prove arbitrary English meaning. Sid rejected the regex-only design,
and round 2 removes it. See the partial
[code-versus-judgment register](CODE-VS-JUDGMENT.md).

## Round 2 validation

Only focused local files are permitted by Sid's 2026-09-24 PC-load rule. Full
gateway, contracts and acceptance evidence comes from GitHub Actions after the
push, not a package or workspace test run on his PC. Round-2 results will be
recorded here after the focused mutation sweep and in the PR comment with CI.

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
[`reviewer-tools/voice-streaming.mutations.json`](../reviewer-tools/voice-streaming.mutations.json).
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
