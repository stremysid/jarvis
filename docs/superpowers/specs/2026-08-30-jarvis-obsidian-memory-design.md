# Jarvis Obsidian Memory Integration Design

**Date:** 2026-08-30
**Status:** Approved; implementation planning in progress
**Scope:** Personal and project knowledge on Sid's Windows machine

## 1. Purpose

Add an Obsidian-compatible knowledge vault to Jarvis without replacing the
existing two-tier memory design. The vault gives Sid a normal notes interface
for reading and editing Jarvis knowledge, while Jarvis retains an immutable raw
archive and a provenance-backed distilled-memory database as its authoritative
stores.

The integration must improve long-term recall and reduce prompt size by
retrieving only relevant, source-linked excerpts. It must not load the whole
vault into a model prompt or let note text grant permissions, authorize tools,
or change policy.

### 1.1 Version and prerequisites

This design is a narrowly scoped amendment to version 0.1.0. It supersedes the
foundation and Telegram/memory-plan file-editing non-goal only for a dedicated
Obsidian memory adapter confined to one configured vault. It does not add a
model-visible filesystem tool or general PC control.

Implementation depends on the planned Windows local-agent configuration,
archive, memory, and service work. Vault ingestion begins only after the local
append-only archive exists; semantic retrieval depends on the compatibility
gate; cloud-channel recall depends on fact promotion and projection; setup and
health checks integrate with the local service and `jarvis doctor`. The
implementation plan must amend the existing Telegram/memory plan explicitly
rather than run a parallel memory project.

## 2. Decisions

- Detect the Obsidian desktop application during local-agent setup and install
  the verified stable package only when it is absent.
- Create a new vault under the Windows Profile known folder, resolving to
  `C:\Users\Ksid1\Jarvis Vault` on the reference machine. Do not use Documents:
  it currently resolves into OneDrive. Setup must reject cloud-synchronized,
  UNC, placeholder, reparse-backed, Git repository, or Git worktree roots and
  offer the fixed local fallback under `%LOCALAPPDATA%\Jarvis\Vault` instead of
  silently changing locality.
- Keep the vault outside the Git repository and outside Jarvis backup keys or
  credential directories.
- The reference machine currently has an Obsidian seed vault at
  `C:\javis\Jarvis`. Setup treats that repository-contained location as an
  unsupported source vault: Jarvis never writes, moves, adopts, imports, or
  deletes it. Setup creates the approved vault at the Profile/fallback location
  and performs an Obsidian handoff only after the application is closed and an
  authenticated local setup confirmation is recorded. Obsidian itself may
  update its own seed-vault metadata while the user keeps that vault open, so
  Jarvis promises non-interference rather than byte immutability against another
  process.
- Treat the local raw archive and distilled-memory database as authoritative.
- Treat Markdown files as an editable projection plus an additional document
  source, not as the database of record.
- Use direct filesystem access; Jarvis does not depend on an Obsidian community
  plugin, a local REST server, or the Obsidian application being open.
- Permit automatic creation of new, collision-free notes. Model Inbox and Daily
  append operations as standalone entry notes so Jarvis never rewrites a file
  that Obsidian may have cached. Existing-note overwrite, rename, move, delete,
  archive, and bulk changes are absent from the first-release adapter.
- Never project or write passwords, API keys, PINs, authentication digits,
  bearer tokens, private keys, or other credentials into the vault. If Sid puts
  secret-looking text in a note manually, preserve his file but quarantine or
  redact that content before archive, indexing, prompting, logging, or export.
- Defer Obsidian Sync, mobile vault synchronization, publishing, and third-party
  Obsidian plugins. The vault files remain local-only. Separately approved,
  canonical post-redaction note observations may enter Jarvis's existing cloud
  event and distillation path under the rules below; Jarvis never cloud-syncs the
  vault directory itself.

## 3. Considered approaches

### 3.1 Vault as the only memory store

This is the simplest visible architecture, but Markdown does not provide the
transactional ordering, immutable provenance, fact promotion, supersession,
principal scoping, or crash recovery required by the accepted Jarvis memory
design. It also makes user edits indistinguishable from policy-authoritative
facts. Rejected.

### 3.2 Read-only vault export

This preserves safety but prevents Sid from correcting, organizing, and adding
knowledge naturally in Obsidian. It delivers too little benefit. Rejected.

### 3.3 Authoritative memory with a two-way Obsidian projection

Jarvis projects approved memory into Markdown and safely ingests user-authored
or edited notes as source observations. This retains auditability while making
memory understandable and editable. Selected.

## 4. Architecture

The planned Windows local agent owns all vault access. Cloudflare Workers never
mount, enumerate, or write the Windows filesystem.

The integration adds four isolated local components:

1. `VaultRepository` confines reads and writes to one resolved vault root,
   parses supported Markdown, and creates new files atomically without an API
   for modifying existing files.
2. `VaultReconciler` treats watcher notifications as hints, performs a durable
   startup and overflow rescan, compares a content-addressed snapshot, and emits
   observations or tombstones without missing offline edits.
3. `VaultProjector` converts active distilled facts and summaries into stable,
   source-linked write-once note revisions without rewriting user-authored prose.
4. `VaultIndexer` feeds canonical post-redaction note text into the existing
   full-text and semantic retrieval pipeline.

These components depend on narrow archive and memory interfaces. They do not
call DeepSeek directly, evaluate permissions, or execute tools.

## 5. Vault layout

The initial vault contains:

```text
Jarvis Vault/
  00 Inbox/
    Entries/
  10 Daily/
    2026-08-30/
  20 People/
  30 Projects/
  40 Decisions/
  50 Preferences/
  90 Archive/
  README.md
```

- `00 Inbox/Entries` receives one standalone note per uncategorized capture or
  explicit "remember this" request.
- `10 Daily/YYYY-MM-DD` receives timestamped standalone entries and summaries.
  Folder order provides append semantics without modifying an existing file.
- `20 People` contains one scoped note per person when enough verified context
  exists; third-party statements remain attributed source material.
- `30 Projects` contains project state, decisions, open questions, and links.
- `40 Decisions` records durable decisions with dates and provenance.
- `50 Preferences` contains active, attributable preferences.
- `90 Archive` is available for Sid's manual organization. Jarvis does not move
  files there in the first release.

Jarvis integration state, watcher cursors, embeddings, locks, and databases stay
in the local agent's protected data directory, not inside the vault.

## 6. Note identity and metadata

Jarvis-created notes use YAML frontmatter with a versioned, allowlisted schema:

```yaml
---
jarvis_schema: 1
jarvis_id: "01..."
kind: project
scope: owner
projected_at: "2026-08-30T20:00:00.000Z"
source_ids:
  - "01..."
---
```

Frontmatter is display metadata, not authority. The local database retains the
canonical identity, source lineage, latest projected content hash, and path.
Editing or forging frontmatter cannot change a principal, permission, policy,
fact promotion state, or source record.

Each generated filename combines an allowlisted kind, stable local ID, and
projection version. A later fact version creates a new note and links to the
prior revision; it never replaces the prior file. Duplicate or forged
`jarvis_id` values in user files remain unbound display text unless the local
database already owns that exact generated path and creation receipt.

User-created Markdown without frontmatter remains valid and receives a local
observation identity in the database. Unsupported or malformed frontmatter is
treated as untrusted note content and reported by `jarvis doctor`; it is never
executed.

### 6.1 Vault observation provenance

Local identity, transport authorization, cloud sequencing, and binding are four
distinct contracts; none may be inferred from another:

All identifiers in these contracts are role-specific lowercase ULIDs. Whenever
a payload crosses a process or network boundary, it is the payload of the shared
foundation envelope with source and subject IDs, occurrence and receipt times,
correlation and causation IDs, content type and SHA-256 hash, redaction metadata,
and producer version. The specialized names below are content types, not
alternatives to that envelope.

1. `vault.note.local_observation.v1` is the payload of a shared local archive
   event envelope appended before any upload decision. It assigns a random,
   stable `observation_id` transactionally with the opaque vault and document
   IDs, document version, operation (`observed` or `tombstoned`), previous
   observation ID, canonical post-redaction text or bounded empty tombstone,
   content hash, observed time, previous content hash, `SensitivityV1`,
   redaction result, and the closed origin
   (`user_authored`, `jarvis_projection`, or `user_edited_projection`). A
   projection origin also carries the exact local operation and projection
   receipt IDs; an edited projection carries the prior receipt ID but not its
   authority. The envelope record ID and hash cover the canonical payload,
   avoiding a self-referential hash. The observation ID and document version
   never change across retries, restarts, policy changes, or a later cloud
   rejoin.
2. `vault.note.submit.v1` is the inner payload of a nonce-protected shared
   command envelope signed by the enrolled Windows device. It carries the
   immutable local observation fields, local archive envelope ID and hash, and
   canonical observation-payload hash. The outer envelope supplies a fresh
   `command_id`, principal/subject, device source, audience, issued/received
   times, correlation/causation IDs, redaction metadata, and producer version.
   Its signature authorizes this one upload attempt but does not assign global
   order. A logical retry uses a fresh command ID, timestamp, nonce, and
   signature while preserving the observation ID and canonical payload hash.
3. After verifying the device, principal, audience, timestamp, nonce, signature,
   signed local-envelope-hash binding, document version and any already-bound
   chain constraints, redaction decision, content hash, and cloud-ingest
   decision, the gateway atomically appends a shared event envelope whose
   content type is `vault.note.observed.v1`. The gateway assigns the envelope's
   lowercase-ULID event ID and global D1 sequence and includes accepted time,
   device ID, accepted command-envelope ID/hash, and canonical observation hash
   in the same transaction as idempotency, source-head, quota, and outbox rows.
4. Binding authority comes from that replicated, sequenced event envelope, not
   from a new network receipt format. After the existing authenticated sync path
   verifies the gateway envelope, sequence continuity, and canonical hash, the
   agent appends a local `vault.note.binding.v1` archive record binding
   `(principal_id, vault_id, observation_id)` and its payload hash to the exact
   gateway event ID, sequence, and event-envelope hash. It records whether the
   event advanced the document source head or joined as a historical
   predecessor and never edits the original observation. If an upload response
   is lost, an equality lookup made with a fresh signed shared command envelope
   returns the same sequenced event through the normal sync verifier; the lookup
   body alone is not authority. A reused observation ID or document version with
   different immutable fields or hashes is rejected.

The adapter determines projection origin only from its protected path mapping,
durable operation, receipt, and exact content hash; frontmatter cannot claim it.
An unchanged Jarvis-generated file closes the matching write operation and may
create an audit observation with `origin: jarvis_projection`, but that
observation is structurally ineligible for cloud ingestion, fact proposal,
distillation, confirmation, or use as an independent source. A later byte change
to that file creates a new `user_edited_projection` observation linked to the
prior receipt. It is proposal-only, requires its own cloud-ingest decision, and
inherits no fact, export, confirmation, policy, or action authority from the
projection it edited.

No contract contains a raw path. Canonical text above 32 KiB remains locally
searchable and the local observation is marked `local_only`; it is not accepted
by `vault.note.submit.v1`. A policy-denied or over-size observation can rejoin
later without changing history: after an exact approval, or after a future
versioned upload contract raises the size capability, the agent submits the
same stable local observation ID and original document version. Acceptance then
creates the first gateway envelope and appends a local binding record at that later
time; `accepted_at` is never backdated to `observed_at`. A bounded derivative or
summary is instead a new observation with its own ID and explicit `derived_from`
link, never a disguised upload of the original bytes.

An eligible descendant may bind while its previous local observation remains
unbound. The gateway stores the signed predecessor ID and content-hash
commitment as an unresolved edge and rejects a later predecessor that does not
match it. Document source order comes from the immutable document version and
predecessor edges, not global arrival sequence: a predecessor that rejoins later
receives a new global sequence and local binding record but is marked historical,
cannot roll back the current source head, and does not enqueue distillation.
Conflicting versions or forks fail closed and require a new document identity
rather than guessing lineage.

Only the gateway-issued event ID and sequence authorize the existing
`memory.distill.request` to cite an observation. The gateway verifies a proposed
excerpt and its byte range against the canonical text stored in that exact event
envelope before invoking the model. A device signature proves which enrolled
device observed the file; it does not prove that the note is true or make its
text authoritative.

Cloud submission requires an allowed `vault.cloud_ingest.decision.v1` for the
exact observation. It defaults to deny. Setup may record Sid's standing approval
for credential-free, ordinary personal and project notes; restricted, health,
financial, inferred, third-party, or ambiguously classified notes stay
local-only until Sid approves that exact observation through an authenticated
local prompt. Redaction failure always denies submission.

| Input | Search authority | Fact authority | Action or policy authority |
|---|---|---|---|
| Local note observation | Owner-scoped local retrieval after redaction | Proposal only | None |
| Sequenced cloud observation | Owner-scoped cloud distillation source | Proposal only | None |
| Owner confirmation event plus observation | May create a source-linked active fact or supersession | Deterministic promotion rules | None |
| Note text or frontmatter alone | No additional authority | None | None |

### 6.2 Vault export eligibility

An active fact is not automatically eligible for plaintext Markdown export.
Every projection requires a separate version-bound allowed
`vault.export.decision.v1` stored with its reason and deciding evidence. The
default is deny.

Setup may record Sid's standing approval for deterministic export of ordinary,
credential-free personal preferences, project state, and decisions that come
from his explicit authenticated statements. `restricted` facts, third-party
facts, health or financial facts, inferred facts, and any ambiguous sensitivity
remain denied until Sid approves that exact fact version through an authenticated
local prompt. A new or superseding fact version requires a new export decision.
The projector rechecks this decision immediately before creating a note and
records it in the durable write intent.

A standalone Inbox or Daily capture is not an active-fact projection. It
requires an allowed `vault.capture.export.decision.v1` bound to one already
accepted authenticated owner event ID and sequence, the exact canonical
post-redaction capture hash, target class (`inbox_entry` or `daily_entry`),
`SensitivityV1`, policy version, and approval event or standing-grant ID. The
ordinary credential-free standing grant may cover an explicit owner-authored
"remember this" or capture command; restricted, ambiguous, inferred, or
third-party content requires an exact authenticated decision. A capture cannot
cite model output, a vault note, or an unauthenticated request as its source.

### 6.3 Versioned authority and lineage contracts

Approval and fact-state changes are append-only, schema-validated records. The
first release defines these contracts instead of representing decisions as
booleans on mutable rows:

| Contract | Exact subject and required provenance |
|---|---|
| `vault.cloud_ingest.decision.v1` | One observation ID, document version, canonical payload hash, sensitivity classification, redaction result, allow/deny result, policy version, and either an authenticated approval event ID or an allowlisted standing-grant ID. |
| `vault.fact.confirmation.v1` | One proposal ID and proposal hash, the exact local observation ID plus gateway event ID and sequence when cloud-backed, the proposed fact value hash, authenticated owner event ID, principal, decision, and decided time. |
| `vault.fact.supersession.v1` | The predecessor fact ID, version and value hash; successor fact ID, version and value hash; supporting observation event IDs; and the exact confirmation ID that authorized the transition. |
| `vault.fact.retraction.decision.v1` | One tombstone observation ID and, when bound, gateway event ID and sequence; one affected fact ID, version and value hash; the proposal ID; authenticated owner event ID; allow/deny result; and reason. |
| `vault.export.decision.v1` | One active fact ID, version and value hash, projection schema and content hash, sensitivity, allow/deny result, policy version, and the exact approval event or standing-grant ID. |
| `vault.capture.export.decision.v1` | One authenticated owner source-event ID and sequence, exact canonical capture hash, target class, sensitivity, allow/deny result, policy version, and the exact approval event or standing-grant ID. |

These contracts originate only from authenticated events already accepted by
the gateway or from a named deterministic policy evaluator and versioned
standing grant. Cross-boundary decisions receive a gateway event ID and sequence
before use; a local cache or caller-provided contract body has no authority on
its own.

Each record has its own immutable decision or transition ID, schema version,
principal, created time, and canonical body hash. A denial, expiration,
revocation, or standing-grant change is another append-only event; no row is
edited in place. Standing grants are versioned, limited to the allowlisted
ordinary-data classes in Sections 6.1 and 6.2, and cannot cover restricted or
ambiguous data.

The gateway and memory materializer enforce lineage rather than trusting a
caller-supplied list of IDs. A confirmation is usable only when its authenticated
principal owns the proposal and every referenced hash and observation binding
matches stored canonical records. Supersession commits only if the named
predecessor is still the active version and the successor is sourced by the
named observation and confirmation. Retraction commits only for the exact fact
version and tombstone named by an allowed retraction decision. Export commits
only while the exact fact version remains active and the exact allowed export
decision is current; the projector stores that decision ID and hash in both the
write intent and projection receipt. Any missing, mismatched, stale, denied, or
revoked dependency fails closed. Note text, frontmatter, filenames, model output,
and local database flags cannot synthesize or substitute for these contracts.

## 7. Data flows

### 7.1 Jarvis memory to Obsidian

1. An authenticated conversation or deterministic observation enters the
   append-only raw archive after redaction.
2. The existing memory pipeline proposes and promotes facts according to the
   accepted provenance rules.
3. `VaultProjector` maps an active fact or summary to a stable note identity and
   write-once projection version.
4. A new versioned note is created atomically and links to the previous version.
   Existing generated or user-authored files are never silently overwritten.
5. The projection receipt records the fact version, path, content hash, and
   source identifiers.

### 7.2 Obsidian to Jarvis memory

1. `VaultReconciler` captures a durable lower change-journal checkpoint, arms
   the filesystem watcher, and commits both to a new generation before starting
   a full bounded crawl at startup, after watcher overflow or error, and
   periodically. Between crawls it waits for notified Markdown files to
   stabilize, then reads bounded UTF-8 content from within the resolved vault
   root.
2. The existing classifier and redactor produce canonical post-redaction text.
3. The local archive appends `vault.note.local_observation.v1` and the database
   stages its stable observation ID, document version, and previous-observation
   link under the current reconciliation generation. The current local source
   head advances only when that generation commits completely.
4. After the complete generation commits, the note becomes searchable through
   full-text indexing and then semantic indexing using that exact local
   observation ID.
5. If the origin is not `jarvis_projection` and
   `vault.cloud_ingest.decision.v1` allows the exact version, the agent sends a
   shared signed command envelope containing `vault.note.submit.v1`. It accepts
   only the matching `vault.note.observed.v1` event after authenticated sync and
   then appends the local `vault.note.binding.v1` record as evidence that the
   observation joined global order.
6. Distillation may propose facts only from the bound gateway event. Note text
   never auto-promotes an inferred preference, policy, permission, identity, or
   action authorization.

Each stable read is performed through one validated file handle. The reconciler
captures file identity, size, last-write/change metadata, and filesystem change
position before reading; reads the complete bounded byte stream; then captures
the same values again after a quiet debounce interval. It accepts the bytes only
when the identity and change evidence are unchanged and no queued change newer
than the captured pre-read change position, but at or before the ending
watermark, targets that document. Otherwise it discards the bytes and retries.
It never archives or indexes a partial or demonstrably mixed-version read.

Each crawl owns a durable reconciliation generation. On the reference NTFS
volume, the ordered lower and upper checkpoints are the volume change-journal ID
and USN; watcher hints are durably queued with that ordering before the
application consumer cursor advances. After enumeration, the reconciler records
an upper checkpoint, replays the complete change-journal interval from lower
through upper, drains every corresponding queued hint, and only then may commit
the candidate heads and processed watermark. Hints after the upper checkpoint
remain queued for the next incremental batch. A supported first-release root
must provide an ordered durable change checkpoint; setup does not claim a
lossless incremental mode from process-local watcher sequence numbers alone.

The durable reconciliation snapshot commits only after every discovered entry
and every queued change through the upper watermark has resolved to a stable
observation or tombstone. An unstable or unreadable candidate leaves the crawl
incomplete, retains the prior complete snapshot and processed watermark, and is
retried; absence in an incomplete crawl can never create a tombstone. Watcher
overflow, journal reset/wrap, root identity change, queue-persistence failure,
or process interruption invalidates the generation and forces a new
watcher-before-crawl baseline. Staged observations from an invalid generation
may remain immutable audit records but cannot advance document heads. Raw
relative paths stay solely in the protected local mapping database. Archive
events, cloud projections, logs, and model prompts use opaque document IDs and
redacted display labels so a secret-bearing filename cannot leak.

The local `vault_document_head` projection identifies exactly one current
observation or tombstone per opaque document ID. Local note retrieval filters to
current non-tombstoned heads even though every historical observation remains in
the immutable archive. The gateway maintains the corresponding sequenced source
head using document order rather than event-arrival order, so a later binding of
an older local-only observation cannot roll it back. A tombstone blocks new
distillation from that version and creates a
retraction proposal for each active fact whose only current source is the
tombstoned note; it never retracts an active fact without owner confirmation.

Rename-over-target and move events are reconciled by durable file identity when
available. If identity is unavailable or ambiguous, Jarvis records a tombstone
and a new observation rather than guessing that two paths are the same note.

### 7.3 Corrections and channel recall

Editing a note creates a source observation and may create a correction or fact
proposal; it does not supersede active memory by itself. Jarvis shows pending
proposals through the authenticated local CLI. Sid confirms a correction through
that CLI or another enrolled channel. The resulting
`vault.fact.confirmation.v1` binds his authenticated decision to the exact
proposal, observation, and value hashes. The materializer may then append the
matching `vault.fact.supersession.v1`; both records and the bound observation
jointly source the new active fact version, after which normal active-fact
projection can publish the correction to D1. A tombstone follows the separate
`vault.fact.retraction.decision.v1` path and cannot reuse a correction
confirmation.

Local CLI retrieval may cite indexed note excerpts directly. Calls and Telegram
continue to retrieve only recent committed turns and active fact projections
from D1. They can recall note-derived knowledge only after the confirmed fact is
active and its projection has synchronized; raw vault text is never uploaded as
an implicit shortcut.

### 7.4 Retrieval

Retrieval searches the existing recent-context, active-fact, full-text, and
semantic indexes. It selects a bounded top set using principal, purpose,
sensitivity, recency, confidence, and diversity rules. Retrieved excerpts
retain opaque document and source identifiers plus a redacted display label,
never a raw path. The authenticated local UI may resolve an opaque ID to a path
after deterministic retrieval. The vault is never concatenated into a prompt, so its
growth does not cause prompt growth.

The retrieval boundary is a discriminated union; a vault hit is never returned
as an active fact. The shared closed sensitivity type is
`type SensitivityV1 = "personal" | "restricted"`; an absent, unknown, or
unsupported value fails closed before indexing or retrieval. The first-release
result shape is:

```typescript
type VaultObservationRetrievalV1 = {
  schema: "vault.observation.retrieval.v1";
  kind: "vault_observation";
  principal_id: string;
  vault_id: string;
  document_id: string;
  observation_id: string;
  document_version: number;
  current_head_observation_id: string;
  operation: "observed";
  excerpt: {
    text: string;
    start_byte: number;
    end_byte: number;
    hash: string;
  };
  canonical_content_hash: string;
  sensitivity: SensitivityV1;
  origin: "user_authored" | "jarvis_projection" | "user_edited_projection";
  authority: "proposal_only";
  local_only: boolean;
  display_label: string;
  provenance: {
    local_archive_record_id: string;
    local_binding_record_id?: string;
    gateway_event_id?: string;
    global_sequence?: number;
  };
};
```

Before returning this type, the retriever verifies that the observation is the
current non-tombstoned local head, the excerpt byte range and hash match its
canonical post-redaction text, and the requesting principal and purpose may see
its sensitivity. A local-only or unbound result is available only to
deterministic `jarvis vault search/show` rendering: the CLI displays the bounded
exact excerpt and source label without invoking DeepSeek or any other reasoning
model. Local text chat, calls, Telegram, model context assembly, fact authority,
and tool authorization cannot consume that result. A bound observation may
reach DeepSeek only through the separately approved, sequenced
`memory.distill.request` path; conversational channels still consume only active
fact projections. A local binding record enriches provenance but does not change
`authority: "proposal_only"`.

### 7.5 Capacity, batching, and backpressure

All counters and limits are keyed by `(principal_id, vault_id)` so one vault
cannot consume another vault's allowance. The reference first-release hard
limits are:

- 1 MiB per local Markdown source file; larger files are preserved but skipped
  with a safe diagnostic;
- 64 changed documents or 4 MiB of raw input per reconciliation transaction
  slice, after which the reconciler commits a durable crawl checkpoint (not a
  completed-snapshot marker) and yields;
- 32 KiB canonical text per cloud observation, 16 observations, 256 KiB of
  total canonical text, and 512 KiB encoded size per submission batch;
- 120 accepted events and 2 MiB canonical text per rolling minute, plus 10,000
  events and 64 MiB canonical text per UTC day, at the gateway; and
- 250,000 retained observation events or 2 GiB canonical event text per vault
  before explicit capacity expansion is required.

Deployment configuration may lower these values but cannot raise them without
a reviewed contract/configuration version. The gateway reserves event and byte
quota in the same transaction that assigns each global sequence. A batch has
an ordered array of independently device-signed `vault.note.submit.v1` request
bodies; batching never changes an observation's identity or payload hash. It has
bounded per-item results (`accepted`, `already_bound`, `retry_after`,
`capacity_exceeded`, or `invalid`); each accepted item is atomic, and an
unaccepted item receives no event ID, sequence, source-head update, or receipt.
An equality retry that returns `already_bound` does not consume event or byte
quota.
Rate exhaustion returns a persisted `retry_after`; retained-capacity exhaustion
returns `vault_capacity_exceeded`. Neither condition evicts or rewrites prior
events.

The protected local upload queue is bounded to 10,000 materialized requests or
256 MiB of canonical request text per vault. At either boundary the adapter
enters `sync_backpressured`: it continues local archive, indexing, and retrieval,
but stops materializing more upload bodies and retains compact dirty-head and
observation-chain cursors backed by the immutable local archive. It does not
advance the cloud source head, coalesce provenance versions, or drop an
observation. After space or gateway capacity is available, it regenerates
requests from the archive and submits each document chain in order with the
original stable observation IDs. Retry state and exponential backoff survive a
restart; permanent capacity errors require an explicit capacity/configuration
change and are surfaced by health checks and `jarvis doctor` rather than hot
looping.

## 8. Write and conflict policy

Jarvis may perform these actions automatically:

- create a new Jarvis-owned note at a collision-free path;
- create a timestamped standalone entry under the current Daily folder;
- create a timestamped standalone capture under `00 Inbox/Entries`;
- create missing approved folders and the vault README.

The first-release adapter always rejects:

- replacing any existing file, including Jarvis-generated notes;
- renaming or moving any note;
- deleting or archiving any note;
- changing vault settings or plugin configuration;
- applying a bulk edit;
- writing outside the configured vault root.

Confirmation does not override these structural denials. Changing the configured
vault root is a separate authenticated local setup operation that re-runs all
root validation before enabling the adapter; a write request can never escape
the currently configured root.

Because the adapter never mutates an existing note, an uncooperative Obsidian
save cannot race a hash-check-and-replace operation and lose user text. If a
target filename exists for any reason, Jarvis preserves it, creates no file at
that path, and records a conflict proposal. A separate versioned proposal note
may be created only at a newly reserved collision-free path.

### 8.1 Durable write journal

Every generated file begins with a SQLite `vault_operation` intent containing a
unique operation ID, expected new-file path ID, content hash, and a closed source
union: either an active fact ID/version/value hash plus exact allowed
`vault.export.decision.v1` ID/hash, or an authenticated source-event ID/sequence
plus exact allowed `vault.capture.export.decision.v1` ID/hash. The
state machine is `prepared -> file_published -> observed -> committed`. The
operation ID is included in the generated note metadata and filename, so
recovery cannot create a second logical note. Recovery revalidates the exact
fact version or authenticated capture source and its decision immediately before
publishing any still-private temporary file.

On startup, recovery reconciles each incomplete intent with the validated file
handle and hash. It may finish publishing a still-private Jarvis temporary file,
synthesize the missing observation for an already-published matching file, or
finish the receipt transaction. A missing or mismatched file becomes a conflict;
recovery never replaces it. Temporary cleanup targets only an exact operation ID
recorded in the journal and still confined to the vault root.

Watcher feedback is never suppressed merely because a process-local flag exists.
The published operation ID and content hash bind the watcher observation to the
durable intent, and the observation plus operation-state transition commit in one
SQLite transaction.

## 9. Filesystem safety

- Resolve the configured vault and every target to absolute normalized paths.
- Open and retain a vault-root directory handle, record its volume serial and
  file ID, and revalidate both identity and canonical final path against the
  ownership receipt before each reconciliation, index, backup, or write. Reopen
  the configured path by handle and require that it resolves to the same retained
  identity; a whole-root rename or move therefore disables the adapter even when
  the underlying file ID survives.
- For every read, create/publish, setup commit, and snapshot-fence critical
  section, hold short-lived root, ancestor, destination-directory, and target
  handles without `FILE_SHARE_DELETE` (or an independently reviewed equivalent
  kernel primitive) from final path/identity validation through the byte read or
  create/publish and durable receipt/transaction commit. This prevents rename or
  deletion after validation from moving the handle-confined operation outside
  the configured namespace. Failure to acquire or retain the fence is a bounded
  retry or safe refusal, never permission to continue on an unfenced handle.
- Open reads by handle before consuming bytes, then verify the final handle path,
  volume, root identity, link count, and reparse state. Reject hard-linked files,
  root replacement, junction swaps, case/short-name aliases that do not resolve
  canonically, long-path namespace tricks, and any final target outside the root.
- Publish new files relative to a retained, validated destination-directory
  handle through a Windows handle-relative create-new primitive. Never perform a
  security-sensitive write through a separately re-resolved string path.
- Reject paths that escape the vault root, reserved Windows device names,
  alternate data streams, unsupported extensions, and unexpected reparse
  points or symlinks.
- Reject a configured root that equals or is nested beneath the Jarvis Git
  repository, any Git worktree, the protected data/credential tree, a backup
  staging tree, or another denied ownership boundary.
- Process `.md` files only in the first release.
- Apply bounded file, note, frontmatter, and line sizes before parsing.
- Derive generated filenames from an allowlisted note kind, stable local ID, and
  projection version. Model or note text may supply a display title but never a
  filesystem path.
- Create a same-directory temporary file with create-new semantics, flush it,
  reserve the collision-free final name, and atomically publish without replace
  semantics. Any existing target is a conflict and remains byte-for-byte intact.
- De-duplicate watcher hints by opaque local document ID, file identity where
  available, content hash, and a bounded debounce window. Run a durable bounded
  rescan on startup, watcher overflow/error, and a fixed periodic interval.
- Start the watcher and durable change-journal capture before every baseline
  crawl. Never advance a processed watermark, infer a deletion, or publish
  candidate heads from a generation that overflowed, lost its journal
  continuity, or did not finish all stable reads.
- Ignore Jarvis temporary files and prevent projection-watcher feedback loops
  through recorded operation identifiers and hashes.
- Keep raw paths only in the protected local mapping database. Use opaque IDs and
  redacted labels in archive events, indexes, diagnostics, sync, and prompts.
- Treat Markdown, links, embeds, HTML, frontmatter, and plugin syntax as data.
  No note content becomes a system prompt or executable instruction.

## 10. Installation and configuration

Setup detects Obsidian first. If absent, the Windows bootstrap script installs
the selected stable Obsidian package through an approved package source, or uses
an explicitly selected local installer only after validating Authenticode and
the expected publisher. It records the non-secret version and package hash and
verifies the installed publisher and executable path. Installation failure does
not corrupt or disable Jarvis memory; it leaves the integration unavailable with
an actionable doctor result.

If Obsidian is already installed or signed in, setup neither records the account
identity nor changes account, Sync, publishing, or plugin settings. The adapter
continues to use the local filesystem and does not depend on Obsidian account
state.

The bootstrap script creates the vault directories and README only after the
resolved target is confirmed local, handle-confined, and not an existing
non-Jarvis directory. It then registers or opens the vault through Obsidian's
supported desktop flow.
The path is stored in protected local configuration as
`JARVIS_OBSIDIAN_VAULT_PATH`; the value is never supplied by model output.

An existing vault beneath the repository is reported as
`vault_unsupported_location` and left untouched. Setup creates and registers the
new owned vault at the approved Profile/fallback root but does not launch,
switch, or control a running Obsidian process. An authenticated closed-app
handoff may open the new vault through Obsidian's supported desktop flow; until
then doctor reports `vault_ready_to_open`. Jarvis does not move, copy, merge,
overwrite, or delete the unsupported vault. A later import, if needed, is a
separate authenticated operation with its own design and is outside this first
release.

Obsidian is optional at runtime. Jarvis continues archiving, distilling, and
retrieving memory if the desktop application is closed.

### 10.1 Root creation and setup recovery

Setup obtains the Profile or LocalAppData location from the Windows Known Folder
API, opens that existing directory by handle, rejects UNC, cloud-placeholder,
and reparse-backed parents, and records the retained parent's volume serial and
file ID. It creates every new root or fallback path component relative to that
retained parent handle with create-new semantics, retaining and validating each
child handle before using it as the parent for the next component. It never
validates a string path and later creates through a separately resolved string
path. The created vault handle remains open and identity-checked until setup
commits. The Known Folder parent and every created ancestor are also held without
delete sharing from final validation through ownership-receipt and configuration
commit; if that fence cannot be held, setup records a conflict and activates
nothing.

Before the first filesystem mutation, SQLite records a `vault_setup_operation`
with a unique setup ID, intended parent identity, relative component names,
selected installer version and hash, and state. Its state machine is `prepared
-> root_created -> layout_created -> ownership_recorded -> configured ->
completed`. After each handle-relative creation, setup durably records the new
object's volume/file identity and expected initial state before proceeding; for
created files that state includes the complete content hash.
Activation of `JARVIS_OBSIDIAN_VAULT_PATH`, watcher startup, and automatic writes
occur only after the ownership receipt and configuration commit together.

The protected ownership receipt binds the setup ID, canonical final path,
parent and root identities, every Jarvis-created directory identity, README
hash, schema version, and completion time. Neither a directory name nor an
in-vault marker proves ownership. On restart, setup resumes only when the
journaled identities and contents still match. It may create a still-missing
component, accept an already-created matching component recorded by the same
operation, or finish the receipt/configuration transaction. An unrecorded,
replaced, nonempty, or mismatched object becomes `vault_setup_conflict`; setup
never adopts, overwrites, moves, or deletes it. A failed or partial setup leaves
the adapter disabled and ordinary Jarvis memory available.

### 10.2 Coordinated backup and restore

The Obsidian adapter participates in the existing local-agent backup as one
coordinated backup unit. A complete unit includes application-consistent copies
of the authoritative local raw archive, distilled-memory database, and protected
adapter database containing opaque path mappings, document heads,
reconciliation generations and queued changes, operation/setup journals,
ownership/projection receipts, policy decisions, pending upload intents, and
protected configuration. It also includes a point-in-time, crash-consistent
shadow copy of vault Markdown and Jarvis-created vault metadata. The manifest
distinguishes Markdown whose identity/hash exactly matches the committed
reconciliation generation (`reconciled_at_fence`) from bytes newer than or
different from that head (`crash_consistent_delta`). Obsidian has no Jarvis VSS
writer, so the latter is preserved user data but is never mislabeled as an
application-consistent observation or fact source.

Rebuildable full-text/semantic indexes, Obsidian application binaries, caches,
workspace UI state, and community-plugin data are excluded. Device private keys
remain governed by the existing encrypted credential backup mechanism and are
never copied into the vault artifact; a restore without the key requires device
re-enrollment before cloud synchronization.

Backup first records a durable `vault_backup_operation` with a unique backup ID
and state machine `prepared -> snapshot_fenced -> artifact_staged -> sealed ->
completed`. It pauses Jarvis projection and adapter-head writers, commits any
complete reconciliation generation, checkpoints SQLite WAL files, and joins the
existing backup service's application-coordinated Windows Volume Shadow Copy
snapshot set for every volume containing an included component. The snapshot
set ID, fence time, committed reconciliation generation, and per-volume
change-journal ID/USN at the shadow-copy fence are recorded before writers
resume. The watcher and live change journal continue queuing edits after that
fence. A no-delete-sharing fence holds the configured root and required
ancestors from their final identity/path validation through successful shadow
snapshot creation and fence metadata commit. If the fence cannot be acquired or
survives neither step, backup fails before labeling a snapshot usable.

The service reads only immutable shadow handles, records each shadow file's
canonical relative path ID, physical identity, size, hash, and change-journal
position, and compares it with the committed document head captured at the
fence. Changed, partially written, malformed, or unmatched bytes are classified
as `crash_consistent_delta`; they do not advance the backed-up head. The manifest
contains the lower committed-generation checkpoint, shadow-copy fence
checkpoint, and exact hash of both the reconciled set and delta set. No live-file
walk or collection of independently timed copies can be labeled coordinated.

If a provider cannot establish one point-in-time snapshot set across the
included volumes, backup fails closed. The artifact succeeds only after every
included component and manifest hash is durably sealed with the same backup ID
and snapshot-set ID by the parent backup service. A local staging copy or a
partially sealed set is not a backup. Recovery may resume an interrupted
staging/seal only while the snapshot set exists and every journaled identity and
hash matches; otherwise it leaves that attempt unsealed and starts a new backup
without changing live files. Post-fence edits belong to the next backup.

The complete artifact is encrypted and authenticated by the existing backup
service before leaving local staging. Because the vault copy may contain text
that redaction intentionally excluded from Jarvis indexes, no plaintext vault
file, filename, manifest label, or derived preview may enter logs, cloud events,
or an unencrypted backup destination.

The target recovery-point objective for local vault edits and adapter state is
24 hours by default and is configurable only to a stricter interval. `jarvis
doctor` reports stale or absent sealed backups once that interval is exceeded.
The guaranteed recovery point is the snapshot fence time of the most recent
sealed coordinated unit, not its later upload or seal-completion time. Edits
after the fence may be lost if the machine or source volume is lost, and the UI
states that boundary explicitly.

Restore verifies one matching backup ID, snapshot-set ID, schema set, committed
generation, and manifest hash across the authoritative stores and adapter state.
Before creating a target it appends a durable `vault_restore_operation` with
state `prepared -> roots_created -> logical_state_restored -> files_restored ->
physical_rebased -> reconciled -> activated -> completed`, the selected backup
hash, retained Known Folder parent identity, and new relative root.

Restore writes only into newly created empty handle-confined data and vault
roots. Logical vault, document, observation, fact, decision, and operation IDs
remain unchanged, but original NTFS identities and USN coordinates are evidence
about the old machine only. The `physical_rebased` transaction rebuilds path and
file-identity mappings from the new handles, creates a new ownership receipt,
appends an immutable restore-binding record from old physical identities to new
ones, and starts a fresh watcher/change-journal baseline. It grants no new cloud
upload, confirmation, export, or action authority.

With cloud sync, projection, and model use disabled, reconciliation first
verifies the restored authoritative generation and every
`reconciled_at_fence` hash. It then stable-reads each
`crash_consistent_delta` file as a new local-only, proposal-only observation; a
malformed or apparently partial file remains preserved and quarantined for local
review. Activation commits the new configuration and ownership receipt
atomically only after all logical hashes, heads, source links, rebase records,
and the new baseline agree. A missing, tampered, partial, or mixed backup
component is `vault_restore_skew` and cannot become active; a vault delta ahead
of the committed head is expected and reconciled under the rule above rather
than treated as authority.

After a crash, restore resumes only when the journaled new-root handles,
identities, operation ID, and written hashes still match; otherwise it marks
`vault_restore_conflict`, preserves every encountered root, and creates or
deletes nothing further. A vault-only recovery may be imported as unowned source
documents through a fresh full crawl, but it recovers no Jarvis ownership,
operation completion, fact authority, or permission to upload. Restore never
overlays, switches to, or deletes the currently active vault.

## 11. Failure handling

- Missing vault: stop vault writes, retain normal memory operation, and report
  `vault_missing` through health and doctor output.
- Read-only vault: keep search over the last indexed version, reject writes, and
  report `vault_read_only`.
- Cloud-synchronized, UNC, placeholder, replaced, or reparse-backed root: disable
  the adapter before reading or writing and require authenticated local
  reconfiguration to a validated root.
- Root final-path or configured-path identity mismatch: disable the adapter and
  report `vault_root_moved`; never follow the retained identity to its new name
  or silently adopt a different object at the configured path.
- Namespace fence unavailable or lost: retry within the bounded operation
  budget, then report `vault_namespace_busy`; create, publish, setup activation,
  and backup fencing remain refused.
- Repository/worktree or protected-data root: report
  `vault_unsupported_location`, preserve it unchanged, and create no adapter
  state or write until setup selects the approved Profile/fallback root.
- Malformed note: quarantine only the observation from distillation, preserve
  the file, and expose a path-safe diagnostic.
- Oversized or non-UTF-8 note: skip it with safe metadata; never partially
  ingest it.
- Index failure: preserve the raw observation and retry indexing idempotently.
- Cloud observation upload failure: keep the note locally searchable, retain the
  canonical idempotent upload intent, and expose sync lag. A retry creates a
  fresh nonce and signature over the same observation ID and payload hash; it
  does not invent a global sequence or submit the observation for distillation.
- Lost cloud binding response: query by principal, vault, stable observation ID,
  and canonical payload hash using a fresh signed shared command envelope; accept
  the existing sequenced event only through authenticated sync, then append the
  derived local binding record before considering the version bound.
- Per-vault rate exhaustion: persist `retry_after`, continue local operation,
  and resume bounded batches without changing observation IDs.
- Local queue or retained-cloud capacity exhaustion: enter
  `sync_backpressured`, preserve local archive/index operation and chain cursors,
  expose exact event/byte counters, and require capacity to drain or be expanded;
  never discard, coalesce, overwrite, or falsely sequence an observation.
- Projection failure: preserve authoritative memory and retry from the recorded
  fact version; never mark the projection successful early.
- Incomplete generated write: recover through the durable operation journal;
  never infer success solely from a filename.
- Deleted user note: record a tombstone observation but do not recreate, move,
  or delete another file automatically.
- Watcher overflow, shutdown, or downtime: mark reconciliation incomplete and
  discard the candidate head update and run a new watcher-before-crawl baseline
  before accepting the next incremental snapshot.
- Interrupted crawl: retain the previous durable snapshot and resume or restart;
  never advance the snapshot past an unstored observation.
- Backup failure or missed RPO: retain the last sealed coordinated backup,
  resume queued reconciliation safely, and report `vault_backup_stale`; never
  label a partial staging set recoverable.
- Restore skew or partial setup: keep the adapter, projection, and cloud upload
  disabled; preserve all encountered files; and expose `vault_restore_skew` or
  `vault_setup_conflict` for authenticated local recovery.

## 12. Testing

Tests use temporary synthetic vaults and never read Sid's real notes.

Required coverage includes:

- vault-root confinement, traversal, reparse-point, reserved-name, and
  alternate-data-stream rejection;
- handle-time root replacement, junction swap, hard-link, case/short-name alias,
  long-path namespace, cloud-placeholder, UNC, and OneDrive-root rejection;
- whole-root rename/move with surviving file identity, configured-path
  replacement, and final-path mismatch detection before read, index, backup, and
  write;
- concurrent root, ancestor, destination-directory, and target rename/delete in
  the interval after final validation but before read completion, publication,
  receipt commit, setup activation, and VSS fence commit, proving the
  no-delete-sharing fence blocks the race or the operation safely refuses;
- Git repository/worktree, credential tree, backup staging tree, and protected
  data-root rejection, including preservation of the reference
  `C:\javis\Jarvis` seed vault with no adoption, import, deletion, or Git write;
- handle-relative Profile and LocalAppData root creation under parent-swap,
  name-squatting, reparse insertion, alias, and concurrent-creator races;
- setup-journal crash recovery at every state transition, idempotent partial
  layout completion, post-create/pre-record ambiguity, ownership-receipt
  identity checks, and refusal to adopt, overwrite, or delete
  foreign/preexisting content;
- atomic create-new publication and write-once Inbox/Daily entry semantics;
- create-new publication with zero existing-file replacement under concurrent
  Obsidian saves;
- durable write-journal recovery after intent commit, temporary-file flush,
  publication, watcher observation, and receipt commit, with no duplicate note
  or feedback misclassification;
- stable reads under mid-read save, truncate, replace, rename, and delete races,
  proving mixed or partial bytes never reach archive or indexes;
- watcher-before-crawl lower/upper watermark ordering for create, edit, rename,
  and delete during enumeration; durable queue replay; journal reset and
  overflow before, during, and after crawl; crash recovery; and proof that an
  incomplete generation advances no head, watermark, or absence-derived
  tombstone;
- malformed frontmatter, hostile Markdown, credential redaction, oversized
  files, and unsupported encoding;
- user-edit versus projection conflicts with no lost user text;
- exact projection-origin classification from protected operation/receipt state,
  unchanged projection-echo exclusion from cloud ingestion/distillation, and
  edited-projection proposal-only lineage with no inherited authority;
- opaque path mapping and secret-bearing filename exclusion from archives,
  indexes, prompts, synchronization, logs, and diagnostics;
- source-linked ingestion, authenticated correction confirmation,
  supersession, D1 projection, and rebuildable full-text/semantic indexes;
- exact `vault.note.submit.v1` device-signature and
  `vault.note.observed.v1` gateway-envelope principal, hash, sequencing,
  equality-on-replay, tombstone, size-cap, and excerpt-provenance validation;
- strict separation of `vault.note.local_observation.v1`, signed
  `vault.note.submit.v1`, gateway `vault.note.observed.v1`, and append-only
  local `vault.note.binding.v1`, including shared-envelope field/ULID validation,
  tampered replicated-event or binding-record rejection, lost-response
  recovery, stable-ID retry, policy-delayed rejoin, and future-schema over-size
  rejoin without backdated acceptance;
- exact-version validation for `vault.cloud_ingest.decision.v1`,
  `vault.fact.confirmation.v1`, `vault.fact.supersession.v1`,
  `vault.fact.retraction.decision.v1`, and `vault.export.decision.v1`, including
  mismatched hashes, stale predecessors, cross-principal reuse, denial,
  expiration, and revocation;
- content-bound `vault.capture.export.decision.v1` enforcement for authenticated
  Inbox/Daily captures, including denial of model, vault-note, unauthenticated,
  restricted, ambiguous, and third-party sources;
- current-head filtering plus confirmed correction and retraction proposals;
- default-deny, version-bound export eligibility for restricted, inferred,
  financial, health, credential-like, and third-party fact fixtures;
- default-deny, observation-bound cloud-ingest eligibility and redaction-failure
  denial for the same sensitivity fixtures;
- deterministic retrieval budgets proving the full vault is never prompted;
- typed `vault_observation` retrieval with current-head, excerpt-range/hash,
  sensitivity, provenance, and principal checks, plus rejection by calls,
  Telegram, fact-authority, and tool-authorization consumers;
- closed `SensitivityV1` validation and fail-closed unknown labels, plus proof
  that local-only/unbound observations use deterministic CLI rendering and cause
  no DeepSeek or other model request;
- reconciliation and submission batch boundaries, concurrent per-vault
  event/byte quota reservation, partial batch results, durable `retry_after`,
  local queue saturation, restart-safe backpressure, ordered drain, and retained
  cloud-capacity exhaustion with no lost or falsely bound observation;
- installation detection, idempotent vault creation, uninstall/missing-app
  behavior, and `jarvis doctor` diagnostics;
- coordinated-backup inclusion and exclusion, exact manifest hashes, 24-hour
  RPO diagnostics from the snapshot fence, one snapshot-set ID across included
  volumes, provider-unavailable failure, completed-generation/USN fencing,
  reconciled-versus-crash-delta classification, queued post-fence edits,
  interruption at every seal phase, encrypted/authenticated artifact enforcement
  with no plaintext vault leakage, and successful restore of a matching logical
  generation plus preserved ahead-of-head delta;
- restore refusal for missing, tampered, partial, or mixed authoritative
  components; durable restore-operation crash recovery at every phase; physical
  identity/USN rebasing into new receipts without changing logical IDs or
  granting upload authority; safe delta reconciliation and vault-only import;
- acceptance: create a note in Obsidian and recall it through local CLI with a
  source; confirm a proposed fact and recall it through a cloud channel after
  projection; capture a Jarvis memory and observe the versioned projected
  Markdown without running Obsidian.

## 13. Rollout

1. Amend the version 0.1.0 scope and existing Telegram/memory implementation
   plan for this exact vault adapter and its prerequisites.
2. Add vault contracts, path confinement, opaque path mapping, parser, durable
   reconciliation snapshot, and synthetic-vault tests.
3. Add read-only reconciliation, redacted archive ingestion, local retrieval,
   and startup/overflow/periodic rescan.
4. Add correction confirmation and cloud fact-projection coverage.
5. Add versioned write-once projection in dry-run mode and compare proposed
   files and hashes.
6. Enable automatic new-note creation and standalone Inbox/Daily entries.
7. Install Obsidian, create the real vault, and run credential-free acceptance.
8. Run one user-approved live capture and recall test using non-sensitive text.

Rollback disables the vault adapter and leaves the authoritative archive and
memory databases unchanged. Files already created in the vault remain ordinary
Markdown and are never removed automatically.

## 14. Success criteria

- Obsidian opens the new Jarvis vault on Windows.
- The configured vault is outside the Git repository and worktrees; Jarvis
  leaves the unsupported `C:\javis\Jarvis` seed contents untouched and
  untracked, and waits for a closed-app handoff before opening the new vault.
- Jarvis functions normally with Obsidian open or closed.
- A stable Markdown edit becomes searchable within five seconds under normal
  local load.
- An explicit remembered fact appears in a source-linked Markdown projection.
- A note-derived correction is unavailable to calls and Telegram until Sid
  confirms it and the resulting active fact projection synchronizes.
- Retrieval remains within the configured context budget as the vault grows.
- User-authored text survives concurrent projection attempts byte-for-byte.
- No credential fixture is written to a Jarvis-generated note. A credential
  fixture placed manually in a synthetic note reaches no archive payload,
  index, prompt, log, export, or error message.
- Disabling the integration requires no memory migration or data loss.

## 15. Non-goals

- Obsidian Sync or mobile synchronization.
- Publishing a vault or sharing notes with other users.
- Installing or managing community plugins.
- General filesystem browsing or editing, including confirmed mutation of an
  existing vault note in the first release.
- Using Markdown as a tool, policy, permission, identity, or authentication
  source.
- Indexing arbitrary binaries, PDFs, images, audio, or canvas files.
- Replacing the immutable raw archive or distilled-memory database.
