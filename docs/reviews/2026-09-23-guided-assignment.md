# Guided assignment: tools and voice scribe

Sid approved this school feature on 2026-09-23. The model chooses the questions,
decomposition, examples, scribing and draft order. Code does none of those things.

## Interfaces

- `guided_assignment_read(assignmentId)`: null lists source records and saved
  assignment snapshots. An id reads one record plus every saved raw answer,
  model-supplied scribed answer and step note. Source ids are `fact:`, `action:`
  or `deadline:` followed by the existing record id. No relevance filter is applied.
- `guided_assignment_save(assignmentId, scribed, stepNotes)`: captures the
  authenticated current turn as raw, without trimming, normalizing or stripping
  fillers. Scribed and stepNotes are exactly the model arguments. One answer per
  assignment per turn; replay returns the original texts rather than overwriting
  them. The SQL write returns the answer used for the saved receipt. Database
  triggers reject updates, deletion and replacement through either answer or turn
  identity; a retry reads the original immutable row.
- `guided_assignment_draft(assignmentId, answerIds)`: joins only those saved
  scribed texts, in the supplied order, with blank lines. Resolves the configured
  owner's unique active verified Telegram identity. No recipient, document,
  submission or third-party transport is exposed. A provider acknowledgement
  produces a send receipt; a failed acknowledgement produces an unconfirmed notice.

All three use the existing tier-1 `school.track` capability and the same owner
agent core on Telegram and voice. Channel authority, direct-owner authority,
durable turn evidence and the capability gate run before dispatch. The shared
prompt gives the model the accommodation instructions and tells it to remember
Sid's learning preferences with the existing memory tools.

## Current source limits and verified premises

Started from freshly fetched `origin/main` at `c5310bee`. #147 was merged.
#164 (pasted school data), #169 (collector receiver), and #162 (honesty guard)
were still open. The branch was subsequently rebased onto `0b63b916` when #164 merged, retaining
both source-paste handling and guided assignment tools. #169 remained open.
The final source base also includes #165 at `0d695563`.
The code uses main's existing school facts, catch-up actions,
deadlines and original retained owner-paste text. Main has no separate assignment
instructions/rubric columns: the fact statement and retained source text are
returned as evidence, while a separate rubric is null. An action's planned work
date is deliberately not represented as a deadline. Unknown due dates say
`no date known`. Main's deadline table is single-owner and has no principal
column, so its reader is reached only after configured-owner authorization.

`AssignmentEvidenceReader` is the collector seam. **Follow-up:
guided-assignment-d2l-evidence**, ready after #169 merged during round 1: add its typed, scoped evidence
to the reader with source ids and provenance intact. Do not infer missing rubric
content or scrape D2L from a guided tool.

Migration `0043_guided_assignment.sql` adds one table. It is registered in all
three fixture migration lists, the restore-operator list, the syntax inventory,
and authoritative backup tables. `0039` is already on main despite the old
abandoned-branch note in the task. Merged #169 owns `0040`; open #168 owns `0041`.
`0042` remains reserved for the expected PIN rebuild. No real migration was run.

## Choices and limits

Dedicated answer storage keeps model edits separate from raw evidence. General
memory deduplication is not used for assignment answers. Snapshotting the source
with an answer permits resumption even after the school tracker removes a fact.
The save tool takes no raw argument, so a model cannot substitute its own raw
transcript. It records the text received by the owner agent after existing ingress
security processing, not an audio recording or a pre-ingress transcript.

One draft send is bounded by Telegram's 4096-character message limit; it is refused
before sending if it exceeds that limit. The model can choose ordered sections.
No automatic splitting or editing decides where Sid's paragraphs belong. A
retry after an unconfirmed Telegram delivery may duplicate a message; the tool
tells Sid to check before retrying. No exactly-once network-delivery guarantee is
claimed. Existing one-tool-per-turn behavior is unchanged. Tool results are not
retained between turns on main. A compact reference catalogue (all stored ids,
titles and courses, including saved source snapshots) therefore reaches each
direct owner prompt. This allows the model to save the next answer without
asking Sid to recite an id, or to read Macbeth's progress on a later call. The
catalogue makes no assignment selection and contains no generated next prompt.

These tests use a scripted model and local workerd/D1. They establish tool
behavior, composition, storage and permissions. They do not establish live model
scribe quality, live Telegram delivery, a live phone call, or remote D1 execution.
The test named `remote-d1-migration-syntax` is an offline static syntax check.
Owner-authorized remote rehearsal remains necessary before rollout.

## Evidence

### Round 1 revision

The [independent review](https://github.com/stremysid/jarvis/pull/172#issuecomment-5807157980)
found that a successful draft send's model-declared claim was contradicted by
the external-completion guard. The revision carries the proving tool names from
this turn's executed receipt ids into the sentence guard. An exact declared
sentence proved by `guided_assignment_draft` survives; a save-only receipt,
unknown or stale id, substring, or neighbouring sentence cannot borrow it.
Code checks proof; the model still chooses and declares its claim. No extra
linguistic send-word exception or whole-reply repair was introduced.

`receiptedToolClaims` is an exported proof-binding seam and
`ReplyClaimGuardOptions.receiptedInternalSentences` accepts typed sentence/tool
proof alongside existing internal strings. It works when checking one sentence
before delivery. This deliberately preserves the existing internal-action
behavior for older callers.

**Streaming integration conflict:** #171 at `eb2263c6` removes voice
`claimedActions` and accepts only exact code-owned receipt sentences. Its plain
text protocol cannot prove a paraphrased send claim. The
[handoff on #171](https://github.com/stremysid/jarvis/pull/171#issuecomment-5807272216)
requests a sentence-local declaration/receipt binding, not a blanket exemption
after sending. No streaming code was changed, and this branch's end-to-end
voice tests exercise main's current protocol, not unmerged #171.

The first fresh main `0d695563` was already included, so the normal merge was a
no-op. A later fetch found #169 merged at `29fbfcd698f4ac7de947f076e43d0098e6bcc296`.
Normal merge `f4dd9f24` retains both tool catalogues, migrations 0040 and 0043,
both parents' log entries, and 0043 as the highest backup schema. The collector
was open at the start of both build and revision; the named evidence-reader
follow-up above is now ready, not implemented by this four-finding revision.
The channel-parity builder has not merged; Telegram's actual first request is
now pinned against the shared guided definition constant, matching voice.
The scribed fixture includes `um`, `like`, doubled spaces, boundary whitespace
and a newline, with a UTF-8 byte equality assertion against the stored row.
The offline remote-D1 syntax file pins all three 0043 trigger names and complete
definitions, including the insert collision condition and plain `SELECT RAISE`.

Observed: reproduction **31/2/0** (both channel send-claim tests), then focused
behavior **101/0/0**, and after merging main **153/0/0** across seven files.
All **18 new faults** were killed twice. The first sweep reported **17 killed,
1 killed-wrong-test** because Vitest truncated the expected mixed-receipt name;
shortening that test name and rerunning the same fault gave **1 killed, 0 other
outcomes**. This was an observed matcher failure, not a surviving fault. After
the main merge, **3 composition checks** (voice offering, Telegram offering and
receipt proof dispatch) each killed twice. Every sweep restored files byte for
byte. Specs remain runnable after the merge, including the refreshed voice-list
literal in the original spec. Added faults live in
`reviewer-tools/mutation-specs-guided-round1.json`.

Source typecheck passes. Non-gating test typecheck reports **143 diagnostics**,
none in the new receipt, guided assignment or syntax tests. The requested single
full gateway run observed **5286 passed / 2 failed / 0 skipped**, 201 files
(199 passed, 2 failed), 759.03 seconds. Both failures were timeouts in unchanged
tests: the 30-second bge-m3 cap test in `meaning-search.test.ts`, and the
15-second bytewise exact-cap frame test in `hermes-token-adapter.test.ts`.
Both timeout cases have earlier AGENT_LOG evidence. Isolated file reruns passed:
meaning-search **70/0/0** (50.55 seconds), Hermes **71/0/0** (3.01 seconds).
No cause is inferred and no second full run is claimed. All named guided,
receipt and migration tests passed after restoration. The full result remains
5286/2/0, not a green full-suite claim.
The final state check passed for three carriers and FACTS with **0 warnings**;
whitespace and merge-tree checks against fresh main passed. No rollout ran.

A read-only merge-tree simulation against unmerged #171 `eb2263c6` additionally
found textual conflicts in `owner-agent-core.ts`, `voice-agent.ts`,
`call-session-do.test.ts`, `OWNER-ACTIONS.md` and `QUEUE.md`. These require merge
coordination alongside the protocol decision; they are not conflicts with main.

### Original builder evidence

The single full gateway run observed **5,215 passed, 1 failed, 0 skipped**. The
failure was a backup-manifest assertion still naming `0039`; after changing only
that expectation to `0043`, the backup file passed **27/0/0**. The new guided file
passed **28/0/0**; production voice composition passed **1/0/129**. All **34
distinct mutation faults** failed their named tests twice and restored cleanly.
Production typecheck passed; test typecheck reported **143 diagnostics**, none in
the new guided test. No second full gateway run is claimed.

Further observed counts are recorded in the PR and the signed AGENT_LOG entry.
The reproducible fault set is
`reviewer-tools/mutation-specs-guided-assignment.json` plus
`reviewer-tools/mutation-specs-guided-references.json`; run them with
`reviewer-tools/mutate.ps1` from a clean worktree. Each fault must apply, fail its
named behavioral test twice, restore byte-for-byte, and pass after restoration.
