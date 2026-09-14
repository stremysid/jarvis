# Jarvis Foundation Design

**Status:** Approved
**Approved:** 2026-08-29
**Initial version:** 0.1.0

## 1. Purpose

Jarvis is Sid's always-available personal assistant. Its first release must be useful from a phone, retain durable memory, and establish secure boundaries for later PC control, scheduling, school integrations, errands, and vehicle control.

Live calling is foundational. Version 0.1.0 and every later release must support both inbound calls to Jarvis and outbound calls from Jarvis. A release that cannot complete both real call paths is not shippable.

## 2. Approved product decisions

- Start from a clean modular repository because no legacy source code was supplied. If the old `jarvis` or `sid-assistant` code appears later, import only components that pass review and fit the published interfaces.
- Use a hybrid architecture: an always-on cloud control plane plus a Windows local agent.
- Use DeepSeek V4 Pro as the primary model for all Jarvis reasoning. Model access stays behind a provider interface so outages or future model changes do not require rewriting channels or tools.
- Use Twilio ConversationRelay for live speech-to-text and text-to-speech.
- Support audio only through live phone calls. Do not implement voice notes, audio uploads, Whisper, or stored call audio.
- Support text through Telegram in version 0.1.0. A local CLI is a development and recovery surface. A PWA is deferred.
- Keep a permanent two-tier memory: an append-only raw archive plus distilled, searchable memory.
- Start with all autonomous device and external-action tools disabled. Outbound calls to Sid's verified number are the sole proactive action in version 0.1.0.
- Do not store credentials in source files, Git history, transcripts, logs, or memory.

## 3. Version 0.1.0 scope

### 3.1 Required capabilities

1. Sid can call the Jarvis phone number, complete step-up authentication before any personal context is loaded, and hold a multi-turn, interruptible conversation.
2. Jarvis can initiate a call to Sid's verified phone number after an authenticated `/call` command or local CLI command.
3. Sid can exchange text messages with Jarvis through an allowlisted Telegram account.
4. Calls and Telegram use the same conversation service and memory context.
5. Every post-redaction user message, assistant response, call lifecycle event, and memory operation is recorded as a versioned event without storing raw call audio, authentication digits, or credentials.
6. The local agent replicates cloud events into a permanent archive, distills facts with source references, and provides full-text plus semantic retrieval.
7. Jarvis continues handling calls and Telegram while the Windows machine is off because accepted events are retained in cloud storage. If durable cloud persistence is unavailable or near exhaustion, Jarvis fails closed before accepting a conversation rather than responding without an auditable record.
8. Missing credentials are reported by `jarvis doctor`, which names missing variable identifiers without printing values or derived fingerprints. It exits 0 when ready, 2 for missing credentials, 3 for invalid configuration, and 4 for failed dependency checks.
9. The Windows local agent exposes the two-tier memory through the required, dedicated, root-confined Obsidian adapter defined in `docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md`. That adapter is version 0.1.0 memory infrastructure, not a model-visible filesystem tool. The Obsidian desktop process may be closed at runtime, but adapter implementation, setup, diagnostics, and acceptance evidence are release requirements.

### 3.2 Explicit non-goals

- PC control, general or arbitrary file editing outside the dedicated Obsidian memory adapter, browser errands, payments, customer or vendor communication, calendar mutation, school scraping, Tesla control, and autonomous project changes.
- Telegram voice notes or arbitrary audio/file ingestion.
- A fullscreen HUD, tray UI, mobile PWA, hotword, or knock detection.
- Calling arbitrary third parties without a separately approved policy and confirmation flow.
- Migrating unavailable legacy databases or code.

## 4. Architecture

### 4.1 Repository layout

```text
jarvis/
  apps/
    cloud-gateway/       # TypeScript Cloudflare Worker and Durable Objects
    local-agent/         # Python Windows background service and CLI
  packages/
    contracts/           # Versioned JSON Schemas and generated types
  tests/
    acceptance/          # Cross-component and live smoke-test harnesses
  docs/
    superpowers/specs/   # Approved design specifications
    superpowers/plans/   # Executable implementation plans
  scripts/               # Safe setup, diagnostics, and verification commands
```

The cloud and local applications communicate only through versioned event and command contracts. Neither imports the other's implementation. Contract fixtures are shared across TypeScript and Python tests.

### 4.2 Cloud gateway

The TypeScript cloud gateway runs on Cloudflare and contains:

- HTTP endpoints for Twilio voice webhooks, Twilio status callbacks, Telegram webhooks, health checks, and local-agent synchronization.
- A Durable Object per active voice session for WebSocket state, ordering, interruption, and streamed model output.
- A globally ordered D1 operational event log, transactional outbox, idempotency records, recent conversation context, distilled memory replica, and per-device sync cursors.
- An R2 immutable archival tier for hash-addressed event segments and manifests after they age out of D1's operational window.
- A DeepSeek model adapter that supports streaming, configurable reasoning effort, timeouts, and a future fallback provider.
- A policy service that authenticates callers, recipients, devices, and Telegram users; authorizes outbound calls; enforces quiet hours, budgets, and rate limits; and rejects unsupported actions.

Cloud code performs no direct PC action. A future device command must go through the policy service and an explicit versioned queue contract.

### 4.3 Windows local agent

The Python local agent runs as a background process under Sid's Windows user account. Version 0.1.0 provides:

- Durable replication from the cloud event log using monotonic cursors and idempotent writes.
- The append-only raw archive and distilled memory databases.
- Content hashing and duplicate-document handling.
- Full-text and local embedding search.
- Periodic memory distillation and synchronization of approved distilled facts back to D1.
- A local CLI for diagnostics, text chat, sync status, archive search, and safe credential checks.

Device enrollment creates an Ed25519 key pair on the Windows machine. The private key is non-exportable when the Windows cryptography provider supports it and otherwise is encrypted with DPAPI for Sid's Windows account. The first device uses a 256-bit bootstrap token created during cloud setup, accepted once, and expired after 15 minutes. That token authorizes exactly one atomic bootstrap transaction: create Sid's canonical `principal_id`, bind the first device, and register the initial phone and Telegram identities in `pending_verification` state. The phone becomes verified only after a neutral activation call in which Sid enters the one-time DTMF challenge displayed by the signed local CLI flow. Telegram becomes verified only when the pending account sends `/enroll` with a one-time challenge displayed locally. No personal context or normal channel action is available while an identity is pending. The bootstrap token is consumed whether the transaction succeeds or fails after commit begins; recovery requires a newly generated setup token. Later enrollment, guest-access changes, and identity changes require confirmation through an already enrolled channel. Enrollment binds the public key to a `device_id` and Sid's canonical `principal_id`. Sync requests include an audience, UTC timestamp, nonce, body hash, and signature. The gateway enforces device status, subject binding, a five-minute clock window, one-time nonces, key rotation, and immediate revocation. A device cannot supply or advance another device's cursor.

The local agent exposes no model-visible PC-control or general filesystem tools in version 0.1.0. Its dedicated Obsidian memory adapter is confined to one configured vault, exposes no arbitrary path argument, and follows the separate approved design. Future tools must be separate adapters registered through the policy layer.

### 4.4 Shared contracts

Every cross-boundary message uses an envelope with:

- schema version;
- globally unique event or command identifier;
- source and subject identifiers;
- UTC occurrence and receipt timestamps;
- correlation and causation identifiers;
- content type and content hash;
- payload;
- redaction metadata;
- producer version.

Identifiers are lowercase ULIDs, timestamps are RFC 3339 UTC with millisecond precision, and text is normalized to Unicode NFC. Canonical JSON follows RFC 8785 and content hashes use SHA-256 over the canonical post-redaction payload. D1 assigns each accepted event a monotonically increasing `event_sequence`. The event, idempotency record, and outbox row commit in one transaction. A consumer cursor is the highest contiguous durable sequence for one named consumer.

Consumers reject unsupported major schema versions, tolerate documented additive fields, and record only redacted payloads in an access-controlled dead-letter stream without executing them. Dead letters expire after 30 days and may be replayed only through an authenticated operator command that revalidates schema, policy, and idempotency. Contract fixtures must produce identical canonical bytes and hashes in TypeScript and Python.

## 5. Voice calling

### 5.1 Inbound flow

1. A caller dials the Twilio number.
2. Twilio requests the cloud voice endpoint.
3. The gateway validates the Twilio signature and evaluates the caller policy. Unknown or blocked numbers are rejected before ConversationRelay starts.
4. The gateway returns TwiML connecting the call to ConversationRelay over `wss://`.
5. A per-call Durable Object validates the WebSocket handshake, accepts structured speech and DTMF events, and enforces the access kind bound by the signed webhook and current database state. The exact active owner identity enters without a recurring PIN. A pending owner identity may enter only an activation-only session, and a provisioned guest begins in `pre_auth` with a neutral greeting and PIN prompt.
6. A guest enters the four-digit PIN bound to that guest's current grant. Its versioned verifier is stored with the grant and keyed by the configured guest pepper; a PIN from another grant or version cannot mint conversation authority. Three failures terminate the call. An activation-only owner session accepts only its separate, short-lived, device-bound six-digit challenge and ends after the activation result. All DTMF candidates bypass the transcript, model, event payloads, and logs. Unknown and active-but-ungranted callers stop before ConversationRelay, and no personal memory or purpose is loaded before the applicable authority is established.
7. After authentication, the model adapter streams relevant context and the transcript to DeepSeek V4 Pro. Live calls use low or non-thinking mode unless a turn explicitly needs deeper reasoning.
8. Text tokens stream back to ConversationRelay for speech synthesis. Barge-in marks unplayed output `cancelled`, stops it, and starts the next turn without rewriting committed history.
9. Post-redaction transcript turns and lifecycle events enter the shared event log. Raw audio is not recorded by Jarvis.

The provider-observed caller number selects only a candidate identity. Owner authority additionally requires the exact configured active owner identity and current singleton; guest authority requires the current grant and its four-digit verifier; activation authority requires the exact pending identity and challenge. Authentication failures produce no model request and no personal disclosure. Failure throttles apply to the current `CallSid`, a short rolling composite source bucket, and a global abuse budget; they expire within five minutes and never disable Sid's canonical identity. Sid can clear throttles through authenticated Telegram or local CLI recovery. Tests must prove a spoofed caller cannot create a persistent lockout.

Call sessions follow `created -> connecting -> pre_auth -> authenticated -> active -> ending -> completed` with terminal alternatives `rejected`, `failed`, and `expired`. Provider callbacks may advance but never reverse a terminal state. Transcript turns are `partial`, `committed`, or `cancelled`; only committed user text and actually delivered assistant text enter conversational history. Events deduplicate on provider event type plus `CallSid`, sequence, and provider message identifier.

### 5.2 Outbound flow

1. Version 0.1.0 accepts outbound-call commands only from Sid's authenticated Telegram `/call` command or an authenticated local CLI `jarvis call-me` command. Normal model output, retrieved content, webhooks, memory, and failure handlers cannot create or dispatch a call command.
2. The command contains a purpose code, Sid's stored destination identity, authorization expiry, urgency, and idempotency key. The policy service emits an immutable allow or deny decision.
3. The policy service permits calls only to Sid's enrolled verified number. It checks the global kill switch immediately before submission and before every retry, plus quiet hours, authorization expiry, concurrency, daily limits, and retry limits.
4. Before placing the call, the gateway creates an expected-call record with a cryptographic one-time relay nonce and five-minute expiry. The Twilio call URL carries an opaque command reference, not the purpose or subject. On Twilio's signed TwiML request, the gateway atomically claims the pending record and binds its `CallSid`, verified destination, Sid's subject, and nonce. The REST response and status callbacks reconcile against that binding, avoiding a race between call creation and TwiML retrieval.
5. The TwiML connects to the same ConversationRelay implementation used for inbound calls. The relay setup must match the bound `CallSid`, subject, and unused nonce before transcript or model traffic begins. Missing, expired, replayed, or mismatched bindings are rejected.
6. When answered, Jarvis gives only a neutral identity statement. The exact claimed owner destination and relay binding establish PIN-free owner authority; no global verifier is consulted. Jarvis does not disclose the call purpose or memory-derived content to voicemail or an unbound relay session. Voicemail receives only: "Jarvis called for Sid. No private message was left."
7. After the bound owner session is established, Jarvis states the authorized purpose and continues. Busy, no-answer, rejected, and failed outcomes become events. A retry retains the original authorization, correlation, and idempotency lineage and is blocked after expiry.

Calls to third parties are outside version 0.1.0. A later version must require a one-time confirmation naming the person, number, purpose, and allowed outcome. Jarvis must identify itself as Sid's AI assistant and may not create purchases, legal commitments, or sensitive disclosures without a separate confirmation.

### 5.3 Permanent release gate

Every release candidate must complete:

- a real inbound call with at least two user turns, one interruption, and a clean hangup;
- a real outbound call to Sid with answer and no-answer paths;
- transcript persistence and later recall;
- authentication rejection for a non-allowlisted caller;
- graceful handling of model, WebSocket, and callback failure.

Version 0.1.0 defaults are configurable only toward stricter limits: two concurrent calls, 30 minutes and 100 committed turns per call, three authentication attempts, one retry per outbound command, six outbound calls per day, 64 KiB per WebSocket frame, 8,000 transcript characters per turn, a 32,000-token voice context budget, eight seconds to first model token, and 30 seconds total per model turn. The live release sample is 20 authenticated turns with p95 time to first audible response at or below four seconds and p95 interruption stop at or below 1.5 seconds. A measured exception requires a decision record; later releases may not regress more than 20 percent from the accepted baseline.

## 6. Text interaction

Bootstrap creates one canonical Sid `principal_id` and registers the E.164 phone number and Telegram user identifier as pending identities bound to the first enrolled device. The neutral phone and Telegram challenges defined in the bootstrap flow prove channel control before either becomes active. Binding another identity or changing an active identity requires an authenticated local enrollment command plus confirmation through an already enrolled channel. Channel identifiers are never accepted from model output.

Telegram accepts text messages only. The webhook validates Telegram's secret header and allowlists Sid's bound Telegram user identifier. The handler may inspect update metadata but never calls Telegram file-download APIs for unsupported media. It persists only a minimal rejection event without file identifiers, captions, or media metadata and returns one deterministic explanation per update idempotency key.

Each call, Telegram chat, and CLI session has its own ordered conversation. They share the same authenticated principal, event store, and authorized memory-retrieval scope rather than one mutable cross-channel transcript. Concurrent turns cannot overwrite one another; global `event_sequence` provides audit order while each session preserves its own causal order. Channel formatting remains separate: voice favors short, interruptible sentences; Telegram may return structured text and links.

The local CLI talks to the background agent through a Windows named pipe whose ACL permits only Sid's Windows SID and the service identity. Commands that create an external effect, including `jarvis call-me`, require an interactive console owned by Sid's current local Windows session plus an explicit confirmation flag. Non-interactive shells, redirected input, scheduled tasks, service sessions, and Remote Desktop sessions are denied by default. The agent converts an accepted command into a short-lived request containing command intent, device identity, Windows session evidence, nonce, expiry, and body hash; it signs the request with the enrolled device key. The cloud policy service revalidates all fields and emits the immutable decision. The CLI is never a privileged bypass around cloud authentication or policy.

Telegram defaults are 30 accepted text messages per minute, 200 per day, and 32 KiB UTF-8 text per message. Two calls and one Telegram turn may use the model concurrently; additional work queues with a visible overload response. Provider circuit breakers open after five qualifying failures in 60 seconds and probe recovery after 30 seconds.

## 7. Model routing

DeepSeek V4 Pro is the default model. The cloud gateway uses the current supported chat interface rather than depending on a deprecated model alias. Model name, API base URL, reasoning effort, timeouts, and token budgets are configuration, not hard-coded business logic.

- Live voice turns default to low or non-thinking mode for responsiveness.
- Ordinary Telegram turns use low or medium reasoning based on classifier output.
- Memory distillation and complex background reasoning may use high or maximum effort.
- Tool arguments are validated against local schemas even when the provider offers structured tool calls.
- The raw archive is never placed wholesale into a prompt. Retrieval selects relevant, source-linked excerpts within a defined context budget.

Sid has approved sending his Jarvis context to DeepSeek. Credentials remain excluded because they grant account access rather than merely containing personal data. Data belonging to customers, vendors, classmates, teachers, or other third parties remains subject to minimization and future integration-specific rules.

## 8. Memory and synchronization

### 8.1 Raw archive

All durable text passes through deterministic classification and redaction before event creation. `Raw archive` means immutable canonical post-redaction source text, never an unfiltered capture. DTMF authentication digits, authorization headers, configured credential formats, private keys, high-entropy bearer tokens, and explicitly marked secret fields are replaced with typed redaction markers before hashing, model input, logging, dead-lettering, or persistence. If the redactor fails, the system stores only an `ingest_redaction_failed` event with safe metadata and asks the user to retry; it does not persist or forward the original content.

The local raw archive is a dedicated SQLite database with append-only enforcement in both application code and database triggers. It stores canonical post-redaction text, metadata, source identifiers, timestamps, and hashes. Update and delete operations are not part of the archive API.

Repeated documents are content-addressed: unique content is stored once, while every observation creates a small `content_seen` event. Conversation turns remain distinct events even when their text matches.

The D1 event log is the cloud operational source for calls and Telegram. The local archive permanently replicates those events. Large future documents and binaries are out of scope for version 0.1.0.

### 8.2 Distilled memory

A separate SQLite database contains facts, preferences, project state, summaries, and search indexes. Every distilled item references one or more raw event identifiers and records a stable fact identifier, typed source, derivation chain, sensitivity label, confidence, distiller version, creation time, promotion state, and supersession state.

Distillation creates facts in `proposed` state. Version 0.1.0 auto-promotes only explicit first-person statements from Sid's authenticated turns and deterministic observations defined in code. Model-inferred observations remain proposed, cannot affect policy or proactive behavior, and are not synchronized to D1 until Sid confirms them. Corrections create immutable supersession edges; deterministic selection chooses the newest authenticated active fact without rewriting the raw archive. Third-party text cannot become a personal preference, instruction, or policy fact solely because it states one.

Full-text search is mandatory. Semantic search uses a local embedding model and local vector index so archive indexing does not require another cloud provider. Search results retain source identifiers for explanation and audit. Before memory implementation begins, a compatibility gate must select and pin a Windows-compatible embedding runtime and SQLite-compatible vector strategy that passes deterministic install, index, query, rebuild, and offline tests. If no candidate passes, version 0.1.0 uses a pinned local embedding model with embeddings stored as SQLite blobs and deterministic in-process cosine search; semantic retrieval is not dropped.

The local agent is the distillation coordinator but never stores the DeepSeek key. It selects canonical post-redaction excerpts and submits a signed, versioned, idempotent `memory.distill.request` to the cloud gateway. The gateway verifies device, principal, excerpt hashes, source sequences, and budget before invoking DeepSeek at high reasoning effort. Returned fact proposals contain source identifiers and the distiller version; the local agent validates and durably stores them before applying deterministic promotion rules. A separate signed `memory.fact.project` upload sends only active facts and allowed short source excerpts to D1. The gateway revalidates provenance and idempotency and atomically publishes a new projection version. Failed or duplicate requests cannot expose a partial projection, advance a source cursor, or cause a model proposal to become active directly.

### 8.3 Offline behavior

Calls and Telegram continue with D1 recent context and the latest synchronized active facts while the Windows agent is offline. The cloud projection contains post-redaction committed turns, active facts, source identifiers, short source excerpts, sensitivity labels, and distillation timestamps. It supports deterministic full-text retrieval; semantic retrieval is local-only and degrades to full-text while the agent is offline. The model receives at most the channel context budget and only records authorized for Sid's authenticated principal.

D1 retains at least 90 days of operational events plus every event not yet archived to R2. An archival worker reads contiguous sequence ranges through the transactional outbox, writes canonical compressed segments under content-addressed R2 keys, verifies object hash and count, and commits an immutable D1 manifest before events become purge-eligible. Purging never removes manifests, active context, active facts, or unarchived events. Sync can read old ranges from verified R2 segments when they no longer reside in D1.

Capacity alerts fire at 70, 85, and 95 percent of the configured D1 and R2 budgets. At 95 percent the gateway refuses new call sessions and Telegram turns with a clear unavailable response before accepting content; it does not create unpersisted conversation turns. Archival failures prevent purge and open a circuit breaker. A forced-low-capacity acceptance test must roll events from D1 to R2, sync them into an empty local archive, and prove sequence continuity, canonical hashes, and zero loss across crashes at every archive-manifest boundary. On ordinary reconnection, the local agent reads snapshot-consistent pages by `event_sequence`, verifies canonical hashes, writes idempotently, and advances its highest-contiguous cursor only after durable commit.

Cloud acceptance has RPO 0 for an acknowledged event. The local replica exposes its sync lag. Acceptance tests keep the local agent offline for 24 hours while 1,000 events accumulate, then require complete hash-verified catch-up and rebuilt indexes within five minutes on the reference development machine. Archive backups are encrypted with a randomly generated key protected by DPAPI and include a versioned manifest and integrity hashes. Restore must recover to the last committed local event, and derived full-text and vector indexes must be rebuildable from the raw archive.

## 9. Security and safety

- Store DeepSeek, Twilio, Telegram, and Cloudflare credentials in provider secret stores or Windows-protected local storage. Commit only variable names and setup instructions.
- Validate Twilio HTTP and WebSocket signatures and Telegram webhook secrets before reading payloads.
- Authenticate local-agent sync with the enrolled device key, subject binding, signed requests, short replay window, and revocable device status.
- Use opaque internal subject identifiers rather than phone numbers or Telegram identifiers in logs and model metadata.
- Redact secrets and authorization headers from errors, traces, transcripts, and event payloads.
- Enforce outbound-call idempotency, quiet hours, one retry, six calls per day, two-call concurrency, authorization expiry, and an immediate global disable switch.
- Structurally separate retrieved content from system instructions. Retrieved text cannot authorize an action or change policy.
- Treat model outputs as untrusted proposals. Retrieval checks principal, channel authentication state, record sensitivity, and requested purpose before returning any memory. Pre-auth call sessions receive no personal retrieval.
- Keep all future external actions behind an explicit policy decision and immutable audit event.
- Run version 0.1.0 with PC and browser tools absent, not merely hidden by prompting.

Public liveness returns only `ok` or `unavailable` and is rate limited. Detailed readiness, health, queues, and metrics require an enrolled operator identity. Logs use an allowlisted schema and prohibit raw message text, transcripts, phone numbers, Telegram identifiers, secrets, provider bodies, and authorization data by type. Operational logs retain for 30 days; audit and policy-decision events follow the append-only event policy.

## 10. Failure handling and observability

Every external call has a timeout, bounded retry policy, correlation identifier, and classified error. Retries apply only to operations known to be idempotent or protected by an idempotency key.

- If DeepSeek fails during a call, Jarvis speaks a brief failure message when possible, records the event, and ends cleanly. A callback occurs only as the single policy-evaluated retry of an unexpired outbound command; an inbound-call failure never creates a new outbound authorization.
- If the call WebSocket disconnects, the Twilio completion callback records the outcome; reconnection is bounded and cannot create duplicate turns.
- If Telegram delivery fails, the outbox retries with backoff and records terminal failure.
- If the local agent is offline, cloud interactions continue and synchronization resumes from the last committed cursor.
- If distillation fails, raw events remain durable and retryable. No guessed memory is written.
- Health endpoints expose component status without secrets or personal content.

Structured logs include event ID, correlation ID, component, operation, duration, outcome, and safe error category. Metrics cover call setup, first-response latency, interruptions, model latency, token use, delivery outcomes, sync lag, and distillation backlog.

Retry defaults are one retry for an authorized outbound call, three delivery attempts for an idempotent Telegram outbox item, and three sync-page attempts with exponential backoff capped at 30 seconds. WebSocket reconnection is attempted once within the existing authenticated call binding. Authentication and policy denials never retry automatically. A provider circuit breaker returns a channel-specific safe failure until its recovery probe succeeds.

## 11. Testing strategy

### 11.1 Automated tests

- Contract tests run the same fixtures through TypeScript and Python validators.
- Unit tests cover authentication state transitions, policy decisions, idempotency, event ordering, canonical hashing, redaction, memory promotion, corrections, and retry bounds.
- Integration tests use fake Twilio, Telegram, and DeepSeek adapters; no test requires paid credentials.
- Cloud tests exercise Worker, Durable Object, and D1 behavior in the provider-supported local runtime.
- Local tests exercise crash recovery, duplicate sync, append-only enforcement, full-text retrieval, and embedding-index rebuilds.
- Security tests verify spoofed caller IDs disclose nothing and cannot lock Sid out; owner identity and singleton binding stays PIN-free and fail-closed; guest PINs remain grant-bound, versioned, attempt-limited, and absent from durable or model-visible data; activation challenges remain short-lived, device-bound, single-use, and isolated from normal conversation; mismatched or replayed relay nonces and device signatures fail; non-interactive or remote CLI commands cannot place calls; untrusted content cannot become instructions or exfiltrate retrieved memory; model observations cannot promote themselves; secrets never enter events, dead letters, logs, traces, exports, or backups; inbound floods stay within cost/concurrency budgets; and unauthorized callers, recipients, devices, or Telegram users are rejected.
- Transaction-fault tests crash between each event, outbox, idempotency, archive, and cursor boundary, then prove no accepted event is lost and no external effect executes twice.

### 11.2 Deployment tests

Credentialed smoke tests are separate, explicitly named, and skipped when credentials are absent. Before a release they verify the real inbound call, outbound call, Telegram round trip, persistence, recall, and failure callbacks.

The release process also runs formatting, linting, static typing, dependency audit, secret scanning, migration checks, and a clean-environment setup test. A release manifest retains commit SHA, configuration schema version, migration plan and rollback result, SBOM, dependency-audit output, secret-scan evidence for worktree/history/build artifacts, automated test reports, live-call evidence, Telegram evidence, backup/restore drill, and approved exceptions. Known critical or high vulnerabilities block release unless a time-bounded decision record documents non-applicability and compensating controls.

## 12. Repository and delivery discipline

The repository is private and uses `main` as the stable branch. Work occurs on focused feature branches. Required root documentation includes `README.md`, `AGENTS.md`, `VERSION`, `CHANGELOG.md`, `NEXT_STEPS.md`, `KNOWN_ISSUES.md`, `DECISIONS.md`, `REQUIREMENTS.md`, and `TESTING.md`, plus `docs/HANDOFF.md`.

Semantic versioning begins at `0.1.0`. No release is declared solely from unit tests; the permanent call gate is mandatory. Each merged change updates the relevant requirements, decisions, tests, changelog, and handoff state.

The local repository can be created without external credentials. Creating the private GitHub remote requires authenticated browser or CLI access and remains a setup task until that authentication is available.

## 13. Implementation sequence

1. Repository standards, toolchains, shared contracts, and fake external adapters.
2. Cloud event log, policy service, model gateway, and deterministic integration tests.
3. Inbound ConversationRelay call path.
4. Outbound call command and Twilio call path.
5. Telegram text path.
6. Local archive replication, distilled memory, and retrieval.
7. Cross-channel context and offline synchronization.
8. Root-confined Obsidian adapter, versioned vault contracts, local-only retrieval, safe setup, backup/restore, and synthetic plus credential-free acceptance tests.
9. Production secret setup, Cloudflare deployment, Twilio/Telegram configuration, and real smoke tests.
10. Version 0.1.0 release audit against every acceptance criterion, including the Obsidian evidence defined by its approved implementation plan.

This sequence keeps paid credentials out of the critical path until the same flows pass against fakes, while ensuring calling is implemented before Telegram and remains the defining release gate.

## 14. Current external dependencies

- DeepSeek API model: `deepseek-v4-pro` through its supported chat-compatible API.
- Twilio Programmable Voice and ConversationRelay.
- Cloudflare Workers, Durable Objects, D1, and R2.
- Telegram Bot API.
- Python runtime and SQLite for the Windows agent.
- A local embedding model and SQLite-compatible vector extension selected during implementation planning after compatibility tests.
- Obsidian desktop for setup and human note editing on Windows; the local adapter itself remains functional when the Obsidian process is closed.

Provider versions are pinned during implementation and upgraded only through tested dependency changes. No provider-specific object crosses the internal model, channel, memory, or policy interfaces.
