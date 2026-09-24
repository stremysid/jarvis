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
guided-assignment-d2l-evidence**, when #169 merges: add its typed, scoped evidence
to the reader with source ids and provenance intact. Do not infer missing rubric
content or scrape D2L from a guided tool.

Migration `0043_guided_assignment.sql` adds one table. It is registered in all
three fixture migration lists, the restore-operator list, the syntax inventory,
and authoritative backup tables. `0039` is already on main despite the old
abandoned-branch note in the task. Open PRs #169 and #168 own `0040` and `0041`.
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
