# R2 memory design

**Status: D1-authoritative design draft for review.** The reviewer recorded the
storage decision in `docs/AGENT_LOG.md` at `951675e`: D1 is the authoritative
memory ledger and topic tree; D1 FTS5 and Vectorize are rebuildable indexes;
Obsidian is only a later optional one-way export. This document defines the
planned table contract but does not add or authorize migration `0016`.

The research and fact-check in `docs/research/` remain the evidence base. This
document carries Sid's later requirements where they supersede the original
recommendation.

## 1. Outcome

Jarvis behaves like a personal assistant whose memory is always available from
the phone, including while every PC is off.

R2 must deliver all four outcomes together:

1. **Keep every conversation.** Every accepted, redacted owner and assistant
   turn is retained, including accepted owner voice-call transcripts and the
   assistant turns in those calls. Importance may affect distillation and
   ranking, never retention. Authentication/passphrase material rejected by
   the existing voice boundary is not a conversation event.
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
  verified, content-addressed R2 segments for archived events. D1 is
  authoritative for distilled knowledge, receipts and topic organization.
- Telegram and voice continue to share the context retriever. R2 must not
  weaken the R1 voice release gate: p95 first-audible latency stays at or below
  four seconds.
- Retrieved text is quoted untrusted data. It cannot become a tool instruction
  or grant authority, even when it is Sid's old text.
- FTS5 and Vectorize are derived data and never the only copy of a memory, raw
  event or receipt. Every retrieved hit is rechecked against D1 state.
- Obsidian is not built in R2. Stable ledger and topic identities permit a later
  optional one-way Markdown export without making that export a runtime
  dependency or an input to memory.

## 3. Chosen storage and planned `0016` contract

### 3.1 Authority and write path

D1 is the source of truth for memory-item identity and wording, versions,
evidence, lifecycle state, topic identity and filing history. Existing live D1
events and sealed R2 archive segments are the source of truth for what was
said. A distillation write commits the item, version, sources, initial state and
initial filing in one D1 batch; its cursor advances only after that batch
succeeds.

FTS5 provides literal recall. Vectorize provides meaning candidates generated
with Workers AI `@cf/baai/bge-m3`. Both are disposable projections. Telegram
and voice fetch the canonical D1 item or exact D1/R2 event after ranking, and
discard any item hit whose current `memory_item_state` is ineligible. A raw
history hit is checked against the current D1 forget/suppression policy before
its exact event is returned, so an archived segment cannot bypass `/forget`.

The optional Obsidian-shaped copy is deliberately outside this write path. It
may later render D1 state to Markdown, but it is never read back into D1, search
or prompts. The exporter is not part of R2.

### 3.2 Planned D1 tables

The later additive migration remains named `0016_cloud_memory.sql`. Its planned
tables are:

| Table | Purpose and critical fields |
|---|---|
| `memory_items` | Stable ULID `item_id`, `principal_id`, kind and creation receipt. Identity never depends on mutable wording or topic path. |
| `memory_item_versions` | Immutable `version_id`, item version, NFC text and hash, basis, code-assigned origin, uncertainty, sensitivity, validity window, extractor version and creation time. Rewording creates a new row. |
| `memory_item_sources` | Stable `source_id` plus ordered sources for one version: event id and sequence, live-or-archived location, optional R2 segment id, verified excerpt and hash, channel and UTC time. |
| `memory_item_transitions` | Append-only lifecycle events (`proposed`, `active`, `rejected`, `superseded`, `forgotten`, `expired`) with reason, actor, policy version and required owner authorizing event when applicable. |
| `memory_item_state` | Trigger-maintained current version and lifecycle state. Every retrieval path joins it; it is rebuildable from transitions. |
| `memory_event_suppressions` | Append-only owner-authorized raw-history suppression ledger: stable suppression id and principal; exactly one target (`event_id` or inclusive event-sequence range); owner authorizing event; reason and UTC time; and, for an item forget, the `forgotten` transition plus each `memory_item_sources.source_id` whose excerpt must be hidden. |
| `memory_item_links` | Immutable `supersedes`, `duplicate_of`, `contradicts` and `related` edges, with the transition that authorized the edge. |
| `memory_topics` | Stable topic id, principal, current parent, normalized display name and active/merged state. The single root is immovable. |
| `memory_topic_events` | Append-only create, rename, move and merge history with old/new parents and names, reason, actor and authorizing receipt. Each merge also records the exact reparented child topic ids, moved placement/assignment ids and aliases added to the survivor so reversal uses ledger data rather than model reconstruction. |
| `memory_topic_aliases` | Historical names and paths resolving to stable topic ids after rename, move or merge. |
| `memory_item_placement_events` | Append-only primary/related filing, refiling and removal events with source (`owner`, `rule`, `model`), confidence and reason. |
| `memory_item_placement_state` | Trigger-maintained current primary and related placements, rebuildable from placement events. |
| `memory_episodes` | Immutable bounded daily summaries with event-sequence range, content hash and summarizer version. Summaries have no authority; replacements link by supersession. |
| `memory_episode_sources` | Exact ordered source-event ids for each daily summary, retained so an event suppression invalidates the summary candidate and queues a replacement that omits hidden text. |
| `memory_history_chunks` | Rebuildable bounded text chunks spanning all live and archived conversations, with exact event range, content hashes and R2 segment receipt where applicable. |
| `memory_history_coverage` | Per-principal live high-water mark plus every sealed R2 range and its indexing outcome. This is the proof behind a complete no-hit answer. |
| `memory_vectors` | D1 ledger of Vectorize mutations: item kind (`item`, `episode`, `history_chunk`), id, embedding model, dimensions, content hash, mutation id, upsert time and delete time. |
| `memory_runs` | Idempotent run key, job, range, provider-qualified model id, counts, token/cost figures, price-ledger version, outcome, timestamps and failure. Nothing-new, budget-blocked, provider-credit-blocked and failed are distinct. |
| `memory_reprocess_jobs` | Owner-authorized bounded range, event cap, provider-qualified model, separate one-time spend limit, dry-run flag, checkpoint, status and final receipt. |
| `memory_model_prices` | Versioned reviewed price records per provider and exact API model id, with effective time, input/output/cache unit prices, currency and source receipt. Old runs retain the price version used for settlement. |
| `memory_cost_ledger` | Append-only worst-case reservations, settlements and releases in integer USD micros, keyed by provider, model run and budget class (`normal_monthly` or one owner-approved reprocessing job). |
| `memory_cursors` | Named consumer high-water marks for distillation, summaries, FTS coverage, embeddings and export. |

The external-content FTS5 projections are `memory_item_fts`,
`memory_episode_fts` and `memory_history_fts`, using the repository's literal
term builder and `unicode61 remove_diacritics 2`. `memory_history_chunks` keeps
archived conversation text searchable without pretending the derived row is
the raw receipt; results are verified against the R2 segment before use.

### 3.3 Invariants and migration rules

- The migration is additive and leaves the existing 0014 projection tables and
  their triggers untouched.
- IDs are ULIDs; timestamps are UTC ISO-8601 milliseconds; money is stored as
  integer micros; bounded text refuses redaction-changing or control-character
  input rather than silently rewriting it.
- Immutable ledger tables reject UPDATE and DELETE. Owner correction,
  supersession and forget append a version or transition.
- A raw-history candidate is eligible only when no matching
  `memory_event_suppressions` row covers its event id or sequence. Fast recall,
  exhaustive archive walks, topic answers and history-chunk rebuilds all apply
  that D1 join. A forgotten item's source rows are linked to its suppression
  records in the same batch as the `forgotten` transition; Vectorize deletion
  is queued from that ledger but is never the enforcement boundary. Episodes
  or chunks whose source set intersects a suppression are ineligible until a
  replacement is rebuilt without the hidden event.
- A model-proposed version is always `origin = model` and uncertain. It cannot
  set lifecycle state, claim owner origin, self-confirm or authorize a topic
  operation.
- Principal scope is present on every root row and enforced through foreign
  keys and trigger checks. Cross-principal sources, topics and links fail.
- Topic moves reject cycles; sibling names are unique after normalization;
  merge redirects are bounded and cycle-free.
- State and placement projections change only through their append-only event
  triggers. Later migration tests must mutate every trigger and prove refusal.
- Use remote-D1-compatible `WHEN ... BEGIN SELECT RAISE(...)` trigger guards or
  CHECK constraints. Do not use `SELECT CASE ... RAISE`, which remote D1 does
  not accept reliably.
- Sid applies migration `0016` only after its separate PR passes Claude Opus 5
  max review. This docs PR creates no SQL and performs no migration.

### 3.4 Index freshness and rebuild

FTS5 updates in the same D1 transaction as its content row. Vectorize updates
are asynchronous: the reviewed planning bound is under 30 seconds at median and
up to two minutes at p99. Therefore a fresh exact memory is available through
FTS5 immediately, and every Vectorize result is filtered through
`memory_item_state`; `/forget` never waits for vector deletion.

A rebuild walks active D1 item versions and summaries, then all live events and
verified R2 segments for history chunks. It writes to an embedding-model-specific
index, records each mutation in `memory_vectors`, verifies coverage, and swaps
the configured index only after counts and sampled hashes pass. Embedding models
are never mixed in one index.

## 4. Memory layers

The D1-authoritative design has these logical layers:

| Layer | Contents | Authority |
|---|---|---|
| Working context | Recent turns plus retrieved items for one response | None; ephemeral |
| Full history | Every accepted redacted conversation event in live D1 or an R2 archive segment | Receipt only; old text is never an instruction |
| Distilled items | Atomic facts, preferences, plans, decisions, relationships and bounded summaries with provenance | D1 ledger; authority depends on evidence and state |
| Topic tree | Stable areas and assignments used to browse and aggregate distilled items | D1 ledger; organization only, so filing never changes truth |
| Search indexes | Keyword and meaning candidates for history, distilled items and topic summaries | None; rebuildable |

Daily summaries are context, not fact. Topic paths are organization, not
identity. Moving an item must not rewrite the item, its evidence, or the raw
event that supports it.

## 5. Full-history recall

### 5.1 Completeness contract

An explicit recall request searches all accepted owner and assistant
conversation history, not only recent context, distilled facts, daily summaries
or the current topic. The searchable range is the union of:

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
5. join distilled candidates to current item state and raw candidates to
   `memory_event_suppressions`, dropping every hidden event before text enters
   context;
6. re-read each selected source from canonical knowledge content or the exact
   D1/R2 event and verify its hash before presenting it;
7. pack quoted items into the existing item and byte budgets.

Explicit requests such as "search everything" or "what did I say about X?"
use the exhaustive path when the fast path misses, reports an index gap, or
cannot establish completeness. A bounded cloud job walks every uncovered live
range and R2 segment, checkpoints progress, and sends the result when complete.
It may take longer; it must not silently degrade to recent history or a fact-only
answer. Retries resume from a checkpoint and a duplicate job key cannot produce
two answers. Every walked event is anti-joined with
`memory_event_suppressions` before its excerpt can be returned.

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
  assignments, reparents its children, and preserves the old path as an alias.
  The merge event records every reparented child id, moved placement/assignment
  id and alias added to the survivor.
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

### 6.5 Later one-way Obsidian-format export

The optional future one-way projection maps each active topic to a folder and a
same-named area note. Each memory is one list item ending in a stable block id;
confirmed items and guesses appear in separate sections; sources are linked by
receipt; related topics become links; merged topics become redirect notes. File
names are sanitized display names, while stable ids prevent a rename from
creating a different topic or memory.

That mapping is a compatibility requirement only. R2 creates no exporter,
Obsidian vault, sync account, plugin, container, git repository or two-way edit
path. A future export is never read back. Sid approved a private GitHub
repository as its later destination, with health, money, passwords and
credentials, and other people's personal details excluded through tested
category rules rather than best effort. He did not authorize an R2 exporter,
repository creation, GitHub App installation, token, paid plan or live push;
the one-repository access step remains his operation after separate review.

## 7. Automatic memory and uncertainty

The extractor proposes atomic memories with exact source ids and excerpts.
Deterministic code, never the model, assigns evidence class and authority:

- `/remember <text>` and an exact first-person owner sentence are `stated`
  only when the quote is word-bounded and equals the whole sentence;
- an owner confirmation is `confirmed`;
- repeated behavior may be `observed` but stays uncertain until the policy or
  owner promotes it;
- a model conclusion is `inferred` and always uncertain;
- borrowed material is `third_party` and never becomes a fact about Sid by
  repetition.

An owner question, conditional (`if`, `unless`, `whether`, `when`), negated or
hedged statement, or reported speech never receives trusted first-person origin;
it falls to `inferred` and uncertain while remaining searchable.

Eligible uncertain items enter ordinary conversational context with an explicit
uncertain label, so Jarvis can use likely preferences or plans without hiding
them from the answer. They may not shape proactive behavior or authorize
reminders, schedules, tools, messages, money, deletion or production work.
The confirmation queue is an optional owner control for a particular item, not
routine tapping or memory-curation homework. Confidence is ranking metadata,
not authority.

The extractor receives no previously distilled memory when judging new source
events. This prevents a guess from citing and reinforcing itself.

## 8. Owner controls and receipts

- **`/remember`** stores Sid's supplied text immediately without a model call,
  after the normal redaction and bounds checks, and files it into the tree.
- **`/why <words>`** is deterministic. It shows matching memory state,
  uncertainty, topic path, source date/channel, verified excerpt and stable
  event id. A model never composes the receipt.
- **`/forget`** hides by transition and event suppression; it is not erasure.
  The owner-authorized batch appends the item's `forgotten` transition and one
  suppression record for every linked source excerpt (or a bounded sequence
  range for an explicit raw-history request). Hidden text disappears
  immediately from ordinary context, topic walks, keyword results, meaning
  results and full-history answers, including results rebuilt from R2 archive
  segments. The raw event remains in the retained record, and Jarvis says so.
  An owner audit can show that a hidden receipt exists without silently
  restoring or reusing its text.

A later tier-3 erasure design must handle live events, content-addressed R2
segments, indexes and locked backups. R2 does not imply that hiding has erased
the original.

## 9. Distillation, model, cost cap and reprocessing

The existing hourly cron claims `memory-distill:<UTC hour>` and starts one
Cloudflare Workflow instance. The Workflow:

1. reads events after the distillation cursor through the tiered reader, from
   live D1 and then verified R2 archive segments;
2. records `nothing_new` and stops if the range is empty;
3. bounds and frames at most the configured event and byte limits;
4. reserves worst-case cost in `memory_cost_ledger`, then calls the configured
   extractor only if the monthly cap permits it;
5. validates source ids, exact excerpts, redaction, output shape and topic
   proposals, while assigning origin, uncertainty and promotion in code;
6. writes item versions, sources, transitions and placements in one D1 batch;
7. advances the cursor only after that batch succeeds;
8. updates FTS5 immediately and queues `bge-m3` embeddings for Vectorize; and
9. settles the cost reservation and records a terminal run outcome.

The nightly consolidation Workflow writes a bounded daily summary with no
authority, expires time-bounded memories, refreshes topic summaries and runs
the custom backup in section 10. A failed model call never blocks raw-event
retention and never advances the distillation cursor.

The extraction provider/model and hard monthly memory-model spend cap are
configuration, not source constants. Initial DeepSeek settings are:

- model candidate: `deepseek:deepseek-v4-pro`;
- comparison candidate: `deepseek:deepseek-v4.1-flash`;
- default hard monthly cap for normal DeepSeek distillation and consolidation:
  **USD 5.00**.

The planned non-secret settings are `MEMORY_EXTRACTION_MODEL` (default
`deepseek:deepseek-v4-pro`) and `MEMORY_MONTHLY_SPEND_CAP_USD` (default `5.00`).
`MEMORY_EXTRACTION_MODEL` accepts reviewed provider-qualified ids for DeepSeek,
Anthropic Claude and OpenAI GPT (`deepseek:<api-id>`, `anthropic:<api-id>`, or
`openai:<api-id>`); the prefix selects the adapter and provider-specific price
ledger. The provider, exact API model id and price version are stamped on every
run and item version; changing them does not rewrite old rows.

Start with `deepseek:deepseek-v4-pro`. Immediately before the owner-approved
paid comparison, re-check that `deepseek:deepseek-v4.1-flash` is still the
provider's real API id. Compare both candidates on the same
sanitized sample conversations. Score exact-source citation, atomic-memory
recall, unsupported-memory rate, uncertainty labeling, topic filing quality,
conflict handling, prompt-injection resistance, latency and measured cost. Use
the model that extracts memories best; Sid selected quality rather than a model
name. The comparison is an owner/reviewer-run provider operation, not a live
call by this builder.

Every paid run reserves a worst-case amount before dispatch so concurrent jobs
cannot cross the cap. Completion reconciles the reservation against observed
tokens and the matching provider/model price record. Before a DeepSeek dispatch,
Jarvis checks fresh prepaid credit against the next worst-case reservation and
the configured warning headroom. It sends a durable owner warning before the
credit is expected to run out; unavailable credit or provider refusal records a
visible blocked outcome and backlog rather than failing quietly. Rejection,
timeout and no-new-events runs are recorded distinctly. At the normal monthly
cap, raw conversation retention, `/remember`, `/why`, `/forget` and
existing-memory recall continue; model distillation and summarization pause
with an owner-visible backlog and reason.

The USD 5 default was sized for DeepSeek and is not silently carried to Claude
or GPT. Before enabling an Anthropic or OpenAI model, Jarvis uses the offline
evaluation's measured token volume plus that provider's reviewed price record
to show Sid an expected monthly range. Sid then explicitly selects the
provider-qualified model and sets its monthly cap; changing the cap is a money
decision, not automatic failover.

The owner-triggered reprocessing path is bounded by an explicit event-sequence
or date range, maximum event count, provider-qualified model id, dry-run mode,
and its own one-time USD spend limit that Sid approves for that job. Its
reservations use that one-time budget class rather than consuming the normal
USD 5 monthly pool, so re-distilling old history cannot starve hourly memory.
Normal distillation has dispatch priority if both queues contend for provider
credit. Reprocessing checkpoints progress, is idempotent, never rewrites raw
history, and creates versioned proposals or supersession links rather than
mutating old memories. A receipt reports the range read, model/version, tokens,
cost, created/unchanged/rejected counts and remaining backlog. It cannot be
triggered by retrieved text or another user. It does not advance the ordinary
hourly cursor and cannot overwrite an owner correction, confirmation or forget
transition.

## 10. Custom nightly backup and restore

Production already contains FTS5 virtual tables, so **never run
`wrangler d1 export` against production**. Wrangler refuses such databases;
the documented workaround drops virtual tables, and an export can block other
database requests. Neither behavior is acceptable on Jarvis's live store.

The nightly Workflow performs a custom logical export:

1. claim an idempotent export run and record immutable high-water marks for
   event sequence, item transition, event suppression, topic event, placement
   event and cost-ledger entry;
2. page each authoritative, append-only table only through its recorded mark,
   writing bounded NDJSON objects to a staging prefix in a separate backup R2
   bucket;
3. exclude FTS5 tables, history chunks, current-state projections and
   Vectorize data because they are rebuilt from the exported ledger and raw
   history;
4. calculate SHA-256 for every object, read it back, and record table name,
   schema version, row count, byte count, first/last key and hash;
5. write the manifest last, with the complete object list and coverage marks;
   only a verified manifest makes an export restorable; and
6. retain the verified set under a bucket lock. A failed or partial staging set
   is never advertised as the latest backup.

Append-only boundaries make the multi-object export a consistent logical cut:
derived current state is replayed from transitions through the same marks. The
existing sealed R2 conversation archive remains the backup for older raw
events; the nightly set includes memory-ledger tables and recent live events
not yet covered by a sealed archive segment.

A monthly restore drill is an owner-run account operation using a pre-created,
non-production scratch D1 database. Sid creates/configures that scratch target
only after the restore procedure is separately reviewed; no scheduled Worker
creates databases. The drill imports the latest verified set, replays state
projections, rebuilds all FTS5 tables, rebuilds or dry-runs the Vectorize ledger,
and compares counts, coverage and sampled source hashes with the manifest.
Restoring production is a separate destructive owner operation with a Time
Travel bookmark and rollback; no scheduled job performs it.

## 11. Voice latency

Voice uses the same memory semantics with a stricter execution policy:

1. recent context and bounded keyword results are always available;
2. meaning search shares the calling PR's hard **750 ms memory-retrieval
   timeout** inside the existing turn budget;
3. deadline, index or archive failures fall back to the bounded path and record
   a redacted fallback reason;
4. exhaustive archive walking is never placed before first audio—it becomes a
   follow-up result;
5. focused latency tests must prove the fallback and the unchanged p95
   first-audible gate before meaning search is enabled for voice.

Silence is not success: an unavailable memory layer is named in observability
and, when it could change the answer, in the response.

Before any R2 implementation edits `apps/cloud-gateway/src/voice/**`, the R2
builder posts the intended files and retrieval change in `docs/AGENT_LOG.md` so
the calling work can coordinate first.

## 12. R2 exit test

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
   search, its topic walk, and an exhaustive rebuild/walk of the source event's
   R2 archive segment. The suppression receipt links the forgotten item to the
   exact source excerpt while accurately stating that the original event
   remains retained.
8. The acceptance receipt records that the cloud path completed while all PCs
   were off, which indexes were searched, their coverage watermarks, any
   fallback, and end-to-end latency.

`LOCAL PASS`, independent Claude review, and this live owner acceptance are
separate gates.
