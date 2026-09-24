# Owner voice reply streaming

Builder evidence and design, 2026-09-23. This change has not been deployed or
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
- A further buffering premise was wrong: `StreamingOutputRedactor` releases
  **lines**, not sentences. Voice now delimits checked sentences with newlines,
  so the real redactor can release them before EOF. Its secret-handling contract
  and final transcript equality check stay in place.
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
against the receipts available **then**. Unfinished pre-tool prose is discarded.
One shared `executeCalls` still owns the one-action cap, owner authority, tier
gate and all memory operations. A second tool round is refused even if a provider
ignores `tool_choice: none`. There is no retry.

After the interrupted builder run, `origin/main` at `c5310bee` was merged
normally. Its #159 gate remains inside the memory and pipeline dispatch
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

Voice buffers each sentence, then applies the existing external-action,
credential-request, passive-completion and Brightspace recognizers to that
sentence only. Internal memory completion forms also cover bare and passive
phrasing. A newline inside an unfinished claim is whitespace, not an exemption.
The model still chooses whether and which tool to call.

Code speaks tool receipts before requesting the follow-up. Without the model's
`claimedActions` declaration there is no sound binding between an arbitrary
paraphrase and a particular action/target. Voice therefore accepts **only exact
code-owned receipt sentences** as supported action wording. A model-generated
completion claim outside those receipts is replaced by the fixed line
"I can't confirm that action." A successful memory save never licenses an email,
a different memory save or an unpin claim. Credential requests retain their
specific refusal and cannot be exempted by a receipt or draft.

This is deliberately stricter than allowing any action sentence whenever a
receipt exists: that alternative would authorize claims about different targets.
The fixed line avoids claiming a rollback when an actual receipt was spoken.
There is no voice rewrite call, and no voice `claimedActions` envelope. Telegram
retains both, along with its original prompt and JSON request format.

These recognizers are bounded language checks, **not proof of arbitrary English
semantics**. The tests establish the named forms and real speech boundary. A
novel paraphrase can still evade a lexical detector; losing the model's explicit
claim inventory is a real tradeoff, not an equivalent semantic guarantee. See
the partial [code-versus-judgment register](CODE-VS-JUDGMENT.md).

## Validation

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

Commands, from the checkout in PowerShell:

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
