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

Exact final gate and mutation results are recorded in this PR and its signed
`AGENT_LOG.md` entry. Offline tests cover first-sentence delivery before a held
stream ends, suppression before and after a real memory receipt, a fragmented
mid-stream call executing once, failure after commit, incomplete and malformed
tool streams, deadlines and cleanup, and the retained production composition pin.

No live API, phone call, production data, secret, remote migration, merge into
main or deployment was used. Local D1 fixtures apply test migrations. No
sync-recovery or store-permissions file was changed by this PR. The incident
report at the supplied Downloads path was absent; no local-agent or PC-setting
code was run. The first live check remains Sid's action.
