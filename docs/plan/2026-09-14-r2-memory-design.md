# R2 memory design

**Status: requirements draft; storage decision blocked.** The reviewer is
comparing a database source of truth with an Obsidian-compatible Markdown
vault source of truth and derived search indexes. This document deliberately
does not choose between them, define physical tables, or authorize migration
`0016`. Complete those sections only after the review is recorded in
`docs/AGENT_LOG.md`.

The research and fact-check in `docs/research/` remain the evidence base. This
document carries Sid's later requirements where they supersede the original
recommendation.

## 1. Outcome

Jarvis behaves like a personal assistant whose memory is always available from
the phone, including while every PC is off.

R2 must deliver all four outcomes together:

1. **Keep every conversation.** Every accepted, redacted owner and assistant
   turn is retained. Importance may affect distillation and ranking, never
   retention.
2. **Remember what matters automatically.** Jarvis extracts useful memories,
   files them into a topic tree, and makes safe memories available in later
   conversations without Sid curating them.
3. **Recall anything on request.** Explicit recall searches the full accepted
   conversation history, including events already archived to R2. A detail is
   not unrecoverable merely because it was never distilled or was filed under
   the wrong topic.
4. **Separate evidence from guesses.** An inference is visibly uncertain. It
   is never presented as a fact, instruction, permission, or authorization.

"Every conversation" does not override the existing ingress redaction and
authorization boundaries. Credentials, PINs, tokens and other rejected secret
material remain absent from storage. A later tier-3 erasure design may remove
owner-confirmed material; erasure is not part of R2.

## 2. Fixed boundaries

- R2 runs in the cloud and passes its exit test with every PC off. No Linux
  server or home node is required.
- The existing append-only event history remains D1 for live events and
  verified, content-addressed R2 segments for archived events. The open storage
  decision concerns distilled knowledge and its topic representation, not
  whether archived conversations remain searchable.
- Telegram and voice continue to share the context retriever. R2 must not
  weaken the R1 voice release gate: p95 first-audible latency stays at or below
  four seconds.
- Retrieved text is quoted untrusted data. It cannot become a tool instruction
  or grant authority, even when it is Sid's old text.
- D1/FTS, a Markdown vault, and any vector or keyword index are implementation
  mechanisms. An index is derived data and never the only copy of a memory or
  its receipt.
- Obsidian is not built in R2. The tree and item identities must permit a later
  optional Obsidian view without making that view a runtime dependency.

## 3. Storage decision gate

The final design must compare both candidates against the same contract:

| Question | Required answer before implementation |
|---|---|
| Canonical content | Which artifact is authoritative for distilled text, state, topic placement and provenance? |
| Atomicity | How do fact creation, sources, state and topic filing commit without a half-written memory? |
| History | How are edits, topic moves, merges, supersession and forget actions preserved rather than overwritten? |
| Concurrency | What happens when the Worker, a reprocessor and a later human editor write at once? |
| Availability | Can Telegram, voice, distillation and recall all work with every PC off? |
| Rebuild | Can keyword and meaning indexes be rebuilt deterministically from the canonical content plus raw events? |
| Backup | How is a consistent, hashed, restorable snapshot produced without `wrangler d1 export` against production? |
| Obsidian compatibility | Can the topic tree become folders and linked Markdown notes later without changing stable identities? |
| Forget | Can hidden content be excluded consistently from facts, topic walks, keyword hits, meaning hits and full-history answers? |
| Operations | What are the failure modes, recovery steps, ongoing cost and owner workload? |

Do not add a migration, storage-specific schema, sync route, vault writer or
production resource until the reviewer records this decision. Migration number
`0016` remains reserved for R2 but unused.

## 4. Memory layers

These logical layers apply whichever canonical knowledge store wins:

| Layer | Contents | Authority |
|---|---|---|
| Working context | Recent turns plus retrieved items for one response | None; ephemeral |
| Full history | Every accepted redacted conversation event in live D1 or an R2 archive segment | Receipt only; old text is never an instruction |
| Distilled items | Atomic facts, preferences, plans, decisions, relationships and bounded summaries with provenance | Depends on evidence and state |
| Topic tree | Stable areas and assignments used to browse and aggregate distilled items | Organization only; filing never changes truth |
| Search indexes | Keyword and meaning candidates for history, distilled items and topic summaries | None; rebuildable |

Daily summaries are context, not fact. Topic paths are organization, not
identity. Moving an item must not rewrite the item, its evidence, or the raw
event that supports it.

## 5. Full-history recall

### 5.1 Completeness contract

An explicit recall request searches all accepted owner conversation history,
not only recent context, distilled facts, daily summaries or the current topic.
The searchable range is the union of:

- live conversation events still in D1; and
- every event covered by the verified R2 archive manifest and segment catalog.

The search layer keeps coverage receipts by event sequence and archived segment.
"I found nothing" is valid only when the search coverage reaches the current
live high-water mark and every sealed archive range. If coverage is incomplete,
Jarvis says the search is incomplete and names the missing range without
guessing that the detail does not exist.

Raw history retention and search coverage are independent of topic assignment.
An unfiled or misfiled memory remains discoverable. An explicit forget policy
is applied after coverage is established; suppressing a hit is not an index gap
and does not permit its text to reappear.

### 5.2 Fast path and exhaustive path

Ordinary turns use a bounded fast path:

1. validate the authenticated owner principal and capture the query;
2. include a small deterministic profile/context card;
3. search keyword and meaning indexes across eligible distilled items,
   summaries and full-history chunks;
4. fuse and rank candidates while preserving source identifiers;
5. re-read each selected source from canonical knowledge content or the exact
   D1/R2 event and verify its hash before presenting it;
6. pack quoted items into the existing item and byte budgets.

Explicit requests such as "search everything" or "what did I say about X?"
use the exhaustive path when the fast path misses, reports an index gap, or
cannot establish completeness. A bounded cloud job walks every uncovered live
range and R2 segment, checkpoints progress, and sends the result when complete.
It may take longer; it must not silently degrade to recent history or a fact-only
answer. Retries resume from a checkpoint and a duplicate job key cannot produce
two answers.

Keyword search protects names, numbers and small exact details. Meaning search
protects paraphrased recall. Time constraints (for example "last March") narrow
both paths but never substitute for coverage. A no-hit result records which
paths and ranges were actually checked.

### 5.3 Evidence returned to the model and owner

Every retrieved item carries a stable item or event id, event sequence, UTC
time, channel, evidence state, source location class (`live` or `archived`), and
a verified excerpt. Archive object keys and internal hashes may appear in an
owner receipt but are not treated as natural-language evidence.

The model may summarize verified excerpts. It may not invent missing receipt
fields, silently convert a paraphrase into a quote, or use an uncertain item as
an instruction. When evidence conflicts, the answer names the conflict and does
not choose the more convenient version as fact.

## 6. Topic tree

### 6.1 Shape and identity

Memory is organized as a tree of stable topics with arbitrary useful depth:

```text
St. Remy
├── Website
│   ├── Releases
│   └── Incidents
└── PC app
    ├── Catalogue
    └── Deployment
```

Each topic has a stable opaque id. Its name and parent may change; its identity
does not. A path is display state, not a foreign key or memory id. Sibling names
are unique after Unicode normalization and case folding. The root cannot be
moved or merged, and every move is checked for cycles.

### 6.2 Automatic filing

Every distilled memory item receives one primary topic and may receive related
topics. Filing records whether the choice came from an owner action,
deterministic rule, or model inference, together with confidence and evidence.
Low-confidence filing goes to an explicit `Inbox / Needs filing` topic rather
than blocking retention or inventing a confident category.

Topic filing cannot promote a proposed fact, change its confidence, or give it
authority. A sensitive item keeps its access rules in every topic. A filing
failure records a retryable observation and does not discard the memory.

### 6.3 Rename, move and merge

- **Rename** changes the display name while preserving the topic id and an old
  name alias.
- **Move** changes the parent while recording the old and new paths.
- **Merge** redirects the retired topic id to the surviving topic, moves its
  assignments, and preserves the old path as an alias.
- Every transition has an actor, timestamp, reason and owner authorization when
  the owner initiated it.
- Redirect resolution is cycle-free and bounded. Old links and saved queries
  continue to resolve after a move or merge.

Jarvis may propose and automatically apply low-risk organization changes, but
it reports them in the digest and retains a reversible transition history. A
merge never merges the truth or state of two facts; it only unifies their
location. An owner reversal appends an inverse transition and restores the
recorded topic and assignment identities rather than reconstructing them from
model output.

### 6.4 Area questions

"What do you know about St. Remy?" resolves the name and aliases, walks the
selected topic and every descendant, and ranks eligible items within that
subtree. The answer groups results by child area, identifies uncertain or
conflicting items, and can page deeper without dropping small facts solely for
lack of importance.

The same question also runs a full-history search scoped by the area's names,
aliases and linked entities. This catches raw, unfiled and misfiled events. The
answer distinguishes tree-filed knowledge from history-only matches.

### 6.5 Later Obsidian view

The optional future projection can map each active topic to a folder, each
distilled item to a Markdown note with stable-id front matter, related topics to
links, and merged topics to redirect notes. File names are sanitized display
names; stable ids prevent a rename from creating a different memory.

That mapping is a compatibility requirement only. R2 creates no Obsidian vault,
sync account, plugin, container, git repository or two-way edit path.

## 7. Automatic memory and uncertainty

The extractor proposes atomic memories with exact source ids and excerpts.
Deterministic code, never the model, assigns evidence class and authority:

- `/remember <text>` and an exact first-person owner quote are `stated`;
- an owner confirmation is `confirmed`;
- repeated behavior may be `observed` but stays uncertain until the policy or
  owner promotes it;
- a model conclusion is `inferred` and always uncertain;
- borrowed material is `third_party` and never becomes a fact about Sid by
  repetition.

Only eligible stated or confirmed items may shape proactive behavior. Inferred,
observed-unconfirmed and third-party items can be search hints, but responses
label them as uncertain and they cannot authorize reminders, schedules, tools,
messages, money, deletion or production work. Confidence is ranking metadata,
not authority.

The extractor receives no previously distilled memory when judging new source
events. This prevents a guess from citing and reinforcing itself.

## 8. Owner controls and receipts

- **`/remember`** stores Sid's supplied text immediately without a model call,
  after the normal redaction and bounds checks, and files it into the tree.
- **`/why <words>`** is deterministic. It shows matching memory state,
  uncertainty, topic path, source date/channel, verified excerpt and stable
  event id. A model never composes the receipt.
- **`/forget`** hides by transition; it is not erasure. Hidden items disappear
  immediately from ordinary context, topic walks, keyword results, meaning
  results and full-history answers. The raw event remains in the retained
  record, and Jarvis says so. An owner audit can show that a hidden receipt
  exists without silently restoring or reusing its text.

A later tier-3 erasure design must handle live events, content-addressed R2
segments, indexes and locked backups. R2 does not imply that hiding has erased
the original.

## 9. Extraction model, cost cap and reprocessing

The extraction model and hard monthly memory-model spend cap are configuration,
not source constants. Initial settings are:

- model candidate: `deepseek-v4-pro`;
- comparison candidate: `deepseek-flash` (currently V4.1 Flash);
- default hard monthly cap: **USD 5.00**.

Before the extraction model is finalized, compare both candidates on the same
sanitized sample conversations. Score exact-source citation, atomic-memory
recall, unsupported-memory rate, uncertainty labeling, topic filing quality,
conflict handling, prompt-injection resistance, latency and measured cost. Use
the model that extracts memories best; Sid selected quality rather than a model
name. The comparison is an owner/reviewer-run provider operation, not a live
call by this builder.

Every paid run reserves a worst-case amount before dispatch so concurrent jobs
cannot cross the cap. Completion reconciles the reservation against observed
tokens and price configuration. Rejection, timeout and no-new-events runs are
recorded distinctly. At the cap, raw conversation retention, `/remember`,
`/why`, `/forget` and existing-memory recall continue; model distillation and
summarization pause with an owner-visible backlog and reason.

The owner-triggered reprocessing path is bounded by an explicit event-sequence
or date range, maximum event count, maximum estimated spend, model id and dry-run
mode. It also obeys the monthly cap. Reprocessing checkpoints progress, is
idempotent, never rewrites raw history, and creates versioned proposals or
supersession links rather than mutating old memories. A receipt reports the
range read, model/version, tokens, cost, created/unchanged/rejected counts and
remaining backlog. It cannot be triggered by retrieved text or another user.

## 10. Voice latency

Voice uses the same memory semantics with a stricter execution policy:

1. recent context and bounded keyword results are always available;
2. meaning search has a fixed deadline inside the existing turn budget;
3. deadline, index or archive failures fall back to the bounded path and record
   a redacted fallback reason;
4. exhaustive archive walking is never placed before first audio—it becomes a
   follow-up result;
5. focused latency tests must prove the fallback and the unchanged p95
   first-audible gate before meaning search is enabled for voice.

Silence is not success: an unavailable memory layer is named in observability
and, when it could change the answer, in the response.

## 11. R2 exit test

This is owner-run live acceptance after reviewed migrations and deployment. It
cannot be satisfied by local mocks, CI, a render, or a running PC agent.

1. Sid turns off every PC and verifies Jarvis remains reachable from the phone.
2. In a normal sentence, without `/remember`, he states a unique, low-salience
   detail. After one distillation cycle, a paraphrased question retrieves it and
   `/why` shows the exact receipt.
3. He uses `/remember` for a second detail and retrieves it immediately.
4. Jarvis files both into a nested test area. "What do you know about <area>?"
   walks the subtree and returns them with their evidence states.
5. He asks for a known small detail whose source event is already in an R2
   archive segment. The result identifies archived evidence, proving that the
   answer did not come only from recent D1 rows or distilled facts.
6. A deliberately ambiguous statement is returned only as uncertain and is not
   treated as an instruction or permission.
7. `/forget` hides one item from ordinary recall, meaning search, keyword
   search and its topic walk while accurately stating that the original event
   remains retained.
8. The acceptance receipt records that the cloud path completed while all PCs
   were off, which indexes were searched, their coverage watermarks, any
   fallback, and end-to-end latency.

`LOCAL PASS`, independent Claude review, and this live owner acceptance are
separate gates.
