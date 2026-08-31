# Jarvis on Hermes Runtime Design

**Date:** 2026-08-30  
**Status:** Approved; user direction approved and independent scope, security, and runtime-seam reviews passed  
**Approved:** 2026-08-30  
**Scope:** Replace unfinished generic-agent work with a pinned Hermes runtime while preserving Jarvis telephony, authority, durability, and memory guarantees

## 1. Decision

Jarvis will adopt [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent) as its generic agent runtime instead of building a competing agent loop, tool ecosystem, skill system, scheduler, desktop voice stack, wake word, browser automation, and messaging framework from scratch. Adoption is staged so it cannot destabilize the already-approved `0.1.0` calling, Telegram, archive, and memory release.

The first supported upstream is Hermes `v2026.8.27`, package version `0.20.6`, peeled commit `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`. The annotated tag object is `fcebd62163497e77e5de00d26d2ed86cb4ef8761`. Hermes is MIT licensed; Jarvis retains the upstream copyright/license notice, produces an SBOM, and does not imply Nous Research endorsement.

This is an integration, not a wholesale replacement:

- Hermes is a replaceable, untrusted reasoning and tool-execution sidecar.
- Jarvis remains the trusted ingress, identity, policy, telephony, event, audit, and authoritative-memory control plane.
- Existing Jarvis branches, commits, tests, and designs remain preserved. Nothing is deleted during migration.
- The direct model adapter remains available as a feature-flagged deployment rollback and pre-admission provider selection; it is never a mid-turn fallback after Hermes admission begins.
- Jarvis does not track Hermes `main`, run `hermes update`, or accept an unpinned plugin, skill, MCP server, model alias, or dependency set in production.

The milestones are binding:

| Milestone | Runtime | Release effect |
|---|---|---|
| Jarvis `0.1.0` | Cloudflare gateway with the existing direct DeepSeek adapter | Production calls and Telegram continue while the PC is off. Hermes is not a release dependency. The approved foundation, calling, Telegram, archive, memory, Obsidian, backup, and live-smoke gates remain unchanged. |
| Hermes H1 pilot | Windows-only, token-only, no-tool Hermes profile behind the existing `ModelAdapter` | Credential-free and then bounded developer evaluation only. It may run with `wrangler dev --local`; it cannot receive production Twilio or Telegram traffic. |
| Hermes H2 actions | Separate Brain/Proposal protocol and dedicated no-effect proposal tool | Post-`0.1.0`; enables re-authorized actions only after the durable admission, cancellation, and policy gates in this document pass. |
| Hermes H3 production | Reviewed always-on HTTPS Brain Bridge and pinned Hermes runtime | Optional later promotion. Cloud calls or Telegram can use Hermes only after a separately approved host, cost, operations, rollback, and live-latency decision. |

No task in an already-approved Jarvis implementation plan is retired by this design. Only prospective, unimplemented work to build a competing generic agent loop/tool/skill/wake-word framework is retired.

## 2. Why this is the best boundary

Hermes already provides the mature generic capabilities Jarvis had planned but had not built: the agent loop, tools, skills, plugins, MCP, subagents, cron, browser/terminal/code execution, provider routing, native Windows CLI/desktop, Telegram and other messaging gateways, persistent session search, local voice, and wake word. It already supports a `hey_jarvis` wake phrase and DeepSeek provider configuration.

Jarvis already provides material capabilities Hermes does not:

- real-time inbound and outbound PSTN calls through Twilio ConversationRelay;
- a Cloudflare Durable Object call lifecycle and streamed response settlement;
- owner-number PIN bypass, guest PIN capture/attempt limits, and per-number versioned capabilities;
- deterministic policy, kill switches, replay protection, redaction, idempotent event admission, D1 sequencing, and R2 archival;
- signed device enrollment/synchronization boundaries;
- provenance-backed fact authority and the stricter Obsidian design.

Hermes' official telephony skill explicitly does not turn Hermes into a real-time inbound phone gateway. Its memory and Obsidian tooling are useful personal-agent features, but they do not provide Jarvis' immutable source events, exact fact lineage, write-once projections, or filesystem recovery guarantees. Replacing the completed Jarvis control plane with Hermes would therefore be a regression; rebuilding Hermes' generic layer would be waste.

## 3. Trust architecture

```text
Twilio PSTN / SMS / Telegram / local desktop
                    |
             Jarvis control plane
  provider verification, identity, PINs, grants,
  policy, redaction, canonical events, audit, delivery
                    |
        authenticated Brain Protocol v1
                    |
            pinned Hermes sidecar
  reasoning, DeepSeek, skills, selected tools, sessions
                    |
           proposed effects only
                    |
       Jarvis re-authorization and execution
```

Hermes never receives or owns:

- Twilio authentication secrets or raw signed webhooks;
- PIN values or verifier material;
- raw phone numbers when an opaque identity ID is sufficient;
- unrestricted provider, filesystem, browser, payment, email, or account credentials;
- the ability to create/revoke caller grants, approve itself, change policy, promote facts, or mark release evidence passed;
- direct D1/R2 write access or a Worker binding;
- authority derived from model text, a plugin result, an MCP annotation, Markdown, frontmatter, or mutable Hermes memory.

Hermes may propose an action. Jarvis validates the proposal against the current authenticated principal, channel, capability grant, scope, policy version, confirmation, rate/cost budget, and idempotency key immediately before execution. A Hermes approval mode is defense in depth only; it never substitutes for Jarvis policy.

## 4. Runtime topology

### 4.1 Separate process and Python runtime

Hermes requires Python `>=3.11,<3.14`; the planned Jarvis local agent targets Python 3.14. They must not share an interpreter or virtual environment.

Hermes runs from an immutable checkout in its own Python 3.11 environment. The Hermes working directory, configuration, cache, plugins, and mutable session state live outside the Jarvis repository and outside the Obsidian vault.

The H1 development topology is exact: Hermes and the Jarvis Brain Bridge bind separate loopback ports on the reference Windows machine, and the Cloudflare gateway runs on that same machine through `wrangler dev --local`. The local gateway calls the Brain Bridge over loopback; the bridge alone calls the profile-bound Hermes route. A deployed Cloudflare Worker cannot call the laptop's `127.0.0.1`, so H1 is never selected in deployed configuration.

The sole `0.1.0` production topology remains the deployed Cloudflare gateway calling direct DeepSeek. Cloudflare owns the only Twilio routes and the only Telegram webhook. Hermes' Telegram/SMS gateways remain disabled, and no paid host is provisioned by this design.

H3 requires one later, explicit topology decision. Its minimum contract is an always-on Brain Bridge colocated with the pinned Hermes runtime behind a fixed HTTPS origin, TLS 1.3 or the strongest mutually supported TLS version, Ed25519 Brain-envelope authentication, pinned service identity, a Cloudflare egress-origin allowlist, and no public Hermes admin/API listener. Cloudflare receives only a Brain client signing identity; native Hermes API keys remain exclusively inside the bridge host. The Brain Bridge owns the durable request ledger. A VPS, private service, or other host is acceptable only after cost approval and the same clean-install, security, latency, durability, observability, backup, and rollback gates pass. Until then, deployed calls and Telegram never select Hermes.

### 4.2 Profiles

Jarvis defines closed Hermes profiles rather than one unrestricted agent:

| Profile | Channels | Initial tools | Mutable Hermes memory | Purpose |
|---|---|---|---|---|
| `jarvis-voice-safe` | H1 local simulated voice; H3 PSTN only after promotion | none | disabled | Low-latency token-only response; no sessions with authority and no effects. |
| `jarvis-owner-text` | H2 authenticated owner text | only `jarvis_propose` initially | disabled | Complex reasoning and typed no-effect proposals. |
| `jarvis-local` | Post-`0.1.0` local desktop/CLI/wake word | explicit local include list | disabled by default | Hands-free local use and later approved tools. |
| `jarvis-background` | Post-`0.1.0` scheduled internal jobs | only `jarvis_propose` initially | disabled | Bounded asynchronous proposals. |

Each profile has an immutable configuration hash. A request naming an unknown profile, tool, plugin, MCP server, model, or permission fails closed. Voice starts with no tools; capabilities are added only after end-to-end action-proposal tests pass.

Isolation is physical, not prompt-based. Each trusted profile has its own frozen `HERMES_HOME`, Windows/service identity, loopback port, API key, process, working directory, cache, and writable ledger/session root. The Brain Bridge holds the native API keys and selects one endpoint from a closed configuration table; Cloudflare and channel handlers never receive those keys. The bridge derives an opaque Hermes session identifier from Jarvis-minted IDs and a profile key, and supplies the fixed instructions/model/provider/options from the table. It never forwards a caller-supplied native profile, model, provider, instructions, URL, header, tool, or session identifier.

Native Hermes HTTP binds to loopback only and is unreachable from external networks. Trusted profiles start with zero native effectful tools and no MCP. H2 adds only the hash-pinned `jarvis_propose` tool plus a mandatory pre-tool guard that rejects every other resolved tool name before dispatch. Startup readiness independently enumerates and hashes the effective tool schema, pre-tool guard, plugins, MCP registry, model/provider route, full resolved config, source, and dependency lock; any drift or unexpected capability fails readiness before a Brain request is accepted.

### 4.3 Two adapter seams

H1 deliberately remains token-only. `HermesTokenAdapter` implements the existing `ModelAdapter`, accepts only its existing redacted text/context/budget/signal input, creates one isolated no-tool Hermes run per turn, and yields only ordered text tokens. It does not claim session continuity, policy metadata, or action proposals. `DefaultConversationService` retains admission, redaction, context, streaming-output redaction, delivery, and settlement authority.

The H1 wire request is `JarvisTokenBridgeRequestV1`: it copies the existing `ModelAdapterStreamInput` data fields except the in-process `AbortSignal`, sets `schemaVersion: "1.0"`, and sets `requestId` **exactly equal** to the existing ULID `correlationId`. The adapter never generates a second ID. It includes a `requestHash` computed over RFC 8785 canonical JSON of every other body field. The bridge recomputes that hash, keys its ledger by `requestId`, resumes an exact `(requestId, requestHash)` replay, and returns `409 request_conflict` for the same ID with any changed canonical body. H1 uses an authenticated bridge-only `POST /v1/token-runs`; its client credential is distinct from every native Hermes API key.

H2 introduces a different `BrainAdapter` with `run(turn: JarvisBrainTurnV1): AsyncIterable<JarvisBrainStreamEventV1>`. The trusted channel service, not the model adapter, mints the `profile`, `sessionId`, `turnId`, `policyVersion`, `configurationHash`, and allowed proposal kinds after authentication. `ConversationService` is extended in a reviewed change to carry that minted authority context and to hand proposal events to a separate `ProposalService`; it never treats a proposal as a text token or executes it inline. The two interfaces are not cast or treated as interchangeable.

Voice gates are measured over at least 20 deterministic turns after warm-up:

- first safe token p50 <= 800 ms;
- first safe token p95 <= 1,800 ms;
- total adapter overhead excluding model generation p95 <= 250 ms;
- downstream token quiescence after Jarvis abort <= 100 ms;
- Hermes stop-request acceptance <= 500 ms;
- Hermes terminal cancellation p95 <= 5,000 ms and absolute <= 30,000 ms;
- zero out-of-order, duplicate, post-cancel, or unredacted tokens.

Direct fallback is selected before admission only when Hermes is disabled, the readiness circuit is already open, or the Brain Bridge durably returns `not_started`. Once Jarvis begins an H1/H2 admission request, a lost/timeout/ambiguous response, accepted token, accepted proposal, `stopping` run, or unknown terminal state forbids fallback for that turn. Once any Hermes token is delivered, that turn never switches providers. Complex text/background work may use longer profile-specific budgets.

`ModelAdapterErrorCode` gains `model_admission_unknown` and `model_cancel_unknown`. `DefaultConversationService` maps both to its durable `model_outcome_unknown` settlement and will not replay the turn automatically. Ordinary, proven pre-admission unavailability remains `model_provider_failure` and may be routed to direct DeepSeek before a Hermes request exists.

## 5. Brain Protocol v1 (H2/H3)

Jarvis owns a versioned protocol rather than exposing Hermes request formats as domain contracts. H1's token-only adapter is intentionally narrower and cannot use proposal events.

### 5.1 Turn request

```typescript
interface JarvisBrainTurnV1 {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly correlationId: Ulid;
  readonly sessionId: Ulid;
  readonly turnId: Ulid;
  readonly principalId: string;
  readonly channel: "voice" | "telegram" | "local" | "background";
  readonly profile: "jarvis-voice-safe" | "jarvis-owner-text" | "jarvis-local" | "jarvis-background";
  readonly redactedUserText: string;
  readonly context: readonly {
    readonly sourceEventId: Ulid;
    readonly text: string;
    readonly sensitivity: "personal" | "restricted";
  }[];
  readonly allowedProposalKinds: readonly JarvisProposalKind[];
  readonly deadlineAt: string;
  readonly policyVersion: string;
  readonly configurationHash: Sha256Hex;
}
```

The wire envelope adds audience, issued/expiry times, nonce, body hash, key ID, and Ed25519 signature. The sidecar verifies canonical bytes, a five-minute maximum lifetime, exact audience, replay state, profile configuration hash, and request bounds before creating or resuming a Hermes session. Raw caller/provider IDs are not fields.

### 5.2 Stream events

```typescript
type JarvisBrainStreamEventV1 = {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly eventIndex: number;
} & (
  | { readonly type: "token"; readonly tokenIndex: number; readonly text: string }
  | { readonly type: "proposal"; readonly proposal: JarvisActionProposalV1 }
  | { readonly type: "completed"; readonly outputHash: Sha256Hex }
  | { readonly type: "failed"; readonly code: JarvisBrainFailureCode }
);
```

Every SSE event carries request ID and monotonic index and is included in a terminal transcript hash. Jarvis rejects unknown fields/types, invalid UTF-8/NFC, gaps, duplicates, oversized frames, unsafe event ordering, events after terminal/cancel, or a response bound to another request.

`JarvisActionProposalV1` contains only a closed proposal kind, opaque subject IDs, bounded typed parameters, correlation/causation IDs, and a proposal hash. It contains no authority boolean. Jarvis mints a separate execution command only after current-policy evaluation and required confirmation.

### 5.3 Exact Hermes Runs mapping

The only accepted upstream surface is the Runs API at the closed-table endpoint for one isolated profile process: `http://127.0.0.1:<profile-port>/v1/runs`. `/v1/responses`, chat-completions, session-chat, another port/profile, and a client-selected URL are not fallback equivalents. The Brain Bridge supplies the exact body fields `input`, opaque derived `session_id`, fixed `instructions`, fixed `model`, fixed `provider`, and bounded table-selected `model_options`; unknown fields fail the bridge contract. It never sends `X-Hermes-Session-Key` because trusted Hermes long-term memory is disabled and that header scopes memory rather than transcript continuity.

The native contract is split by response source and exact fixtures:

- admission parses only the Runs `POST` 202 body `{ "run_id": string, "status": "started" }`;
- `/v1/runs/{run_id}/events` SSE accepts `message.delta` plus terminal `run.completed`, `run.failed`, and `run.cancelled`; it never accepts `run.started` or `run.stopping` as SSE events;
- stop parses only `{ "run_id": string, "status": "stopping" }` from the native stop response;
- status reconciliation parses `GET /v1/runs/{run_id}` and accepts only `completed`, `failed`, or `cancelled` as terminal.

The bridge ignores UI-only progress and rejects any unexpected tool/subagent/approval event for `jarvis-voice-safe`. Because Hermes run events do not supply Jarvis ordering, the bridge mints contiguous Brain `eventIndex` and `tokenIndex` values after exact parsing and persists the canonical event prefix hash. Admission and stop states are bridge-ledger lifecycle states, not synthetic upstream SSE events.

The Cloudflare gateway never calls a general Hermes admin endpoint. Bridge readiness exposes only release commit, configuration hash, Brain schema major, accepted Runs-event contract hash, enabled profile IDs, and a redacted health state.

### 5.4 Durable admission and replay

The Brain Bridge owns a crash-safe ledger keyed by Jarvis `requestId` with at least: request hash, profile, opaque Hermes `session_id`, state, Hermes `run_id` when known, canonical emitted event frames, highest emitted event index, canonical event-prefix hash, terminal status, timestamps, and cancellation state. For H1 this key is the existing model `correlationId`; for H2/H3 it is `JarvisBrainTurnV1.requestId`. The H1 Windows bridge uses SQLite WAL with full synchronous commits outside the repository/vault. An H3 bridge must provide equivalent durable transactional semantics on its approved host.

The bridge inserts and fsyncs `reserved` before upstream admission. Exact duplicate requests resume the same ledger entry/event prefix; a changed body under the same ID rejects. After the Hermes 202 response, it durably binds the returned `run_id` before acknowledging `started` to Jarvis. Per `(profile, session_id)` execution is serialized.

Hermes Runs has no documented client idempotency key or lookup by Jarvis request ID. Therefore an upstream 202 response lost before `run_id` persistence becomes `upstream_admission_unknown`: the bridge does not start another run, Jarvis settles `model_outcome_unknown`, the isolated session is quarantined, and no direct fallback is permitted. H2 action profiles remain disabled until a reviewed pinned Hermes hook/patch provides durable request-ID-to-run-ID admission or upstream adds an equivalent supported contract. H1 tolerates an abandoned generation only because the profile has no tools, no mutable memory, and a fresh isolated session; it still never delivers or replaces ambiguous output.

### 5.5 Proposal and cancellation semantics

Hermes function-call events describe tools already executed on the Hermes host and are never Jarvis action proposals. H2 exposes exactly one reviewed, hash-pinned `jarvis_propose` plugin/tool initially. It has no provider, filesystem, shell, browser, policy, memory, or network authority except a private authenticated channel to the Brain Bridge; it validates a closed typed payload, writes a proposal record, and returns only a proposal receipt. The bridge converts that record to `JarvisActionProposalV1`. Every generic Hermes tool event is otherwise a protocol violation. Jarvis `ProposalService` independently reloads current principal/grant/policy/confirmation/rate/cost state and mints a separate idempotent execution command; proposal receipt is never execution authority.

Jarvis abort immediately closes downstream delivery and discards every later upstream delta. Adapter-generator `finally` calls an authenticated, idempotent Brain Bridge cancellation operation keyed by H1 `correlationId`/`requestId` or H2/H3 Brain `requestId`; the adapter never learns a Hermes `run_id`, native endpoint, or native API key. The bridge looks up the ledger entry, durably records `cancel_requested`, and, when a bound `run_id` exists, is the only component that posts native Runs `/stop`. A repeated cancel or lost bridge response resumes the same cancellation record and never issues a second logical run.

The bridge records the exact native `{"run_id": ..., "status":"stopping"}` response as stop acceptance and continues terminal polling even when the downstream client disconnected. `stopping` is not terminal. For a still-`reserved` or `upstream_admission_unknown` entry it records the cancellation intent, starts nothing new, and quarantines the session. The bridge keeps the run and session serialized until settlement. Only a later `cancelled` is terminal cancellation success; `completed` or `failed` is recorded honestly, and no terminal state by 30 seconds becomes `model_cancel_unknown`, quarantines the session, forbids fallback/effects/session reuse, and raises an operator-visible safe alert.

## 6. Source, dependency, and update discipline

Jarvis avoids a permanent fork unless an independently reviewed missing hook makes it unavoidable.

- `hermes-source-lock.json` records the official remote, tag object, peeled commit, package version, license SHA-256, source acquisition method, supported API schema, Python version, and upstream dependency-lock hash.
- `fetch-hermes.ps1` clones/fetches only the official remote, detaches the exact peeled commit into a fresh external directory, verifies the lock, refuses submodules/remotes/dirty state that are not declared, and never runs repository code during acquisition.
- `bootstrap-hermes.ps1` creates one fresh isolated Python 3.11 environment per profile, installs from the pinned upstream lock, verifies installed files, sets `HERMES_MANAGED=jarvis`, configures the loopback-only listener, and writes a non-secret runtime receipt.
- An installer identity owns the checkout, environments, locks, plugins, and configuration with read/execute-only ACLs for each runtime service identity. Runtime processes have no permission to mutate them, no VCS credentials, no desktop/TUI updater attachment, and no shell/terminal tool. Upgrade promotion runs under the separate installer identity only.
- `HERMES_MANAGED=jarvis` must make `/update`, CLI `hermes update`, config-mutation paths, and any attempted terminal-invoked updater fail without mutation. Readiness hashes the source tree, dirty state, dependency lock, full resolved configuration, plugin/tool registry, and patch queue and fails on drift.
- Every trusted profile sets `no_mcp` and declares no `mcp_servers`. MCP, dynamic tool refresh, sampling, elicitation, resources, prompts, parallel MCP calls, and MCP-supplied tools are deferred beyond H2 because pinned Hermes has no fail-closed dynamic-refresh disable. Shipping MCP later requires a reviewed pinned patch or upstream control for `dynamic_refresh: false`, exact include names with no globs, `prompts: false`, `resources: false`, `sampling.enabled: false`, `elicitation.enabled: false`, parallel calls disabled, and continuous registry-hash attestation.
- Plugins, the proposal guard/tool, model catalogs, provider routes, and any later read-only backend are separately hash-pinned and include-listed. An unexpected resolved tool, hook, plugin, model route, or configuration value fails readiness.
- An upgrade is a normal Jarvis change: update the lock in a branch, run license/SBOM/dependency/secret/API/security/latency/rollback tests, soak it, and promote the exact artifact. Rollback selects the previous complete lock and runtime directory.

Generic missing hooks should be contributed upstream. Jarvis may temporarily carry a minimal patch queue with exact base commit, patch hashes, tests, and an expiry/removal issue. It never vendors an unreviewed moving copy.

## 7. Memory and Obsidian

Jarvis' archive and fact model remain authoritative. Every trusted Hermes profile explicitly sets `memory.memory_enabled: false`, `memory.user_profile_enabled: false`, and `auxiliary.background_review.enabled: false`, and excludes memory and skills toolsets. Hermes `MEMORY.md`/`USER.md` self-writing, background learning/review, and mutable session memory are not trusted sources.

The later H2 `jarvis-memory` Hermes provider uses the documented `prefetch`, `sync_turn`, `on_pre_compress`, and shutdown hooks:

- `prefetch` returns only current active fact projections allowed for the principal/profile/purpose;
- `sync_turn` submits a proposed observation to Jarvis; it cannot activate a fact;
- `on_pre_compress` checkpoints only through the Jarvis append-only archive and fails closed if persistence fails;
- shutdown drains bounded pending observations without changing authority.

The provider advertises pre-compress checkpoint API v2, and every trusted profile sets `compression.checkpoint_required: true`. Readiness fails unless the selected provider is active and v2-capable. An archive/checkpoint failure preserves the uncompressed transcript, emits a controlled blocked outcome, and neither compresses nor continues best-effort. Tests inject checkpoint failure before compression and prove no transcript or authority loss.

Hermes does not simplify, replace, or defer the approved Obsidian release work. Jarvis `0.1.0` retains the complete design at commit `a0802d445ae86f26fe8024c3c78b5cb1113ed95f`, including:

- the authoritative append-only archive/fact database and exact source lineage;
- one owned local NTFS vault outside Git/worktrees, OneDrive/cloud sync, UNC, reparse, hard-link, ADS, credential, protected-data, and backup-staging roots;
- handle-confined reads and create-new write-once projections with no replace/rename/delete;
- watcher-before-crawl generations plus the minimal privileged, hash-locked USN broker and lossless reconciliation claims only when journal evidence proves them;
- proposal-only user edits, secret quarantine, deterministic local retrieval, fact confirmation/supersession, and cloud projection authority;
- coordinated application-consistent VSS backup/restore, encrypted sealing, exact snapshot/generation/USN fences, crash-delta classification, and the real elevated release gate.

Hermes' general Obsidian skill is disabled for the owned Jarvis vault because it permits ordinary edits and lacks Jarvis authority. The Hermes process and bridge have no vault path or filesystem permission; later memory access occurs only through the bounded Jarvis provider.

## 8. Channel migration

### 8.1 Calling

Keep all current Twilio signature checks, ConversationRelay parsing, TwiML, CallSession Durable Object state, owner/guest authentication, PIN verifier, capability grants, circuit breakers, rate/cost guards, and delivery settlement. Jarvis `0.1.0` uses the direct DeepSeek model provider. H1 tests `HermesTokenAdapter` only through the local gateway. H3 may select it behind `ModelAdapter` in deployment only after every promotion gate passes.

Real-time Twilio audio always remains between Twilio and Jarvis. When H3 is eventually selected, Hermes receives authorized redacted transcripts and returns response text/proposals. It receives no CallSid, AccountSid, relay nonce, phone number, PIN, provider webhook, or channel credential.

### 8.2 Telegram and SMS

The Cloudflare gateway is the sole Telegram webhook owner for `0.1.0` and later releases. Hermes' Telegram gateway stays disabled, so there is no duplicate polling/webhook consumer or parallel identity boundary. Authenticated Telegram turns continue through the shared Jarvis conversation service and direct DeepSeek in `0.1.0`; an H3 promotion may change only the brain adapter after Jarvis authenticity, principal, capability, redaction, event, and delivery admission.

Inbound SMS is not added by this pivot. A later SMS adapter must be a Jarvis-owned Cloudflare ingress with the same provider-authenticity and identity policy; it cannot point the Twilio number directly at Hermes.

### 8.3 Local voice and physical body

After `0.1.0`, H2 may use Hermes native Windows voice and the built-in `hey_jarvis` wake profile. The physical room device sends authenticated commands to the `jarvis-local` profile and receives no broad owner authority merely because it heard a voice. Hardware identity and action capabilities remain separate Jarvis grants. Wake word, PC control, browser errands, and general tools are explicitly not `0.1.0` scope.

## 9. Migration and rollback

### 9.1 Existing-task disposition

`H0` means a new, single voice-consolidation commit that contains reviewed voice-integration head `909098f11886d3a4f4ddd7f0b11272e103717478` and owner/guest head `143af7e67994783f86f8a49f9a5e76cd281688e7`, followed by the complete Jarvis suite. No Hermes implementation branch may become a production base until H0 exists; its resulting commit is recorded in the implementation plan and source lock.

Foundation/cloud plan:

| Task | Disposition | Exact current prerequisite/head | Hermes effect |
|---|---|---|---|
| F1 Workspace and Worker test runtime | Retain | `6073ffd49672c3e81f870b245ef426e213b40de7` | None. |
| F2 Canonical event contracts | Retain | `c20c345934901517ab212c0546d02e828f02b1fe` | Brain contracts are additive, not replacements. |
| F3 D1 ledger/idempotency/outbox/cursors | Retain | `a440d8712cc4c0d2ad3b743045db6da64073bac0` | Later Brain settlements reuse its durability rules. |
| F4 Outbound-call policy core | Retain | `d74bffeec6f58ba30b839f74ce9f3722de348ffe` | Remains sole outbound authority. |
| F5 Deterministic provider fakes | Retain | `8b7c560e24da39ecd4bca0f11c068bfaeb08835d` | H1 adds separate fake Bridge/Runs fixtures. |
| F6 Bootstrap enrollment/device-signed sync | Retain | `950296ed4310819a7605522253364e272af0a9e7` | Hermes receives no enrollment authority. |
| F7 R2 immutable archival | Retain | `b7a2193684bb0f09b8fdd25e2bc50ede64c1f964` | Remains authoritative archive tier. |
| F8 Cloud-core acceptance | Retain | `32fe937c9405b0da1703ef1f020f25cef16c9c0b` | Must stay green. |
| F9 Channel identity/operator authorization | Retain | `3125e9bdb8b5053f18df70a1c0a662654c4c9680` | Remains the trusted ingress/operator boundary. |

Calling plan:

| Task | Disposition | Exact current prerequisite/head | Hermes effect |
|---|---|---|---|
| C1 Call contracts/state machine | Retain | `9be85a25e5b39f93c7c764e7f9ed35e9f3fd260d` plus required config fix `da08cb21db329e630c823941f84f75c6e96b4032` | None. |
| C2 Twilio/ConversationRelay boundary | Retain | `4311f0e6ffc93b42832483141ddbc44c3680ef03` | None. |
| C3 Atomic call persistence/bindings | Retain | `2971265e388f63450ade014917c8319922f8f1e7` | None. |
| C4 Inbound ingress/PIN/enrollment | Retain | `c72bad51488c3610464a53b3d5c986a47d0fcb34` | Owner/guest extensions are consolidated through H0. |
| C5 Streaming conversation/outbox | Retain for `0.1.0`; modify in H1/H2 | `0c81fee573778b4164488808d85b318dfa576bd4` | H1 adds `HermesTokenAdapter` plus explicit unknown settlement; H2 adds the separate `BrainAdapter`/proposal path. |
| C6 Durable relay session/interruption | Retain | `143af7e67994783f86f8a49f9a5e76cd281688e7` | H3 may change only the selected token provider. |
| C7 Outbound authorization/nonce/recipient | Retain | `b2338a30da871c47a9f7966ab8feb16bf58c906a` | None. |
| C8 Worker routes/limits/fake acceptance | Retain | `476bd0e11f1f355fce5c5e0777f6a5f4903f6e5e` | H3 routing remains feature-flagged and pre-admission only. |
| C9 Live smoke/release evidence | Retain | `30b85684d983626319a9767509b74b67b970f62e` | H3 adds separate Hermes evidence; direct-path evidence remains permanent. |

Telegram/local-memory/release plan (not yet implemented on the current heads):

| Task | Disposition | Exact implementation prerequisite | Hermes effect |
|---|---|---|---|
| T1 Telegram/memory-sync contracts | Retain | H0 plus `3125e9bdb8b5053f18df70a1c0a662654c4c9680` | Brain contracts are additive. |
| T2 Authenticated Telegram ingress | Retain | T1 on H0 | Cloudflare remains sole webhook owner. |
| T3 Shared conversation/outbox routing | Retain | T2 plus C5 in H0 | Direct DeepSeek remains `0.1.0`; H3 may change only brain selection. |
| T4 Protected Windows config/device keys/doctor | Retain | H0 plus `950296ed4310819a7605522253364e272af0a9e7` | Hermes gets a separate Python 3.11 runtime/config root. |
| T5 Signed sync/durable cursors | Retain | T4 plus `950296ed4310819a7605522253364e272af0a9e7` | None. |
| T6 Append-only raw archive | Retain | T5 plus `b7a2193684bb0f09b8fdd25e2bc50ede64c1f964` | Later checkpoint provider consumes it. |
| T7 Local semantic retrieval | Retain | T6 | Hermes memory does not replace it. |
| T8 Fact provenance/promotion/retrieval | Retain | T6 and T7 | Remains sole fact authority. |
| T9 Named-pipe service/catch-up/backup | Retain | T4 through T8 | Hermes runs as a separate least-privilege service. |
| T10 Deployment/smoke/release audit | Retain | T1 through T9 plus C9/H0 | Hermes is not required for `0.1.0` certification. |

Obsidian plan at design commit `a0802d445ae86f26fe8024c3c78b5cb1113ed95f`:

| Task | Disposition | Exact implementation prerequisite | Hermes effect |
|---|---|---|---|
| O1 Shared vault contracts | Retain | H0 plus F2 | None. |
| O2 Cloud-ingest grants/decisions | Retain | O1 plus F3/F9 | None. |
| O3 Vault ledger/heads/quotas | Retain | O2 plus F3 | None. |
| O4 Signed vault authority/routes | Retain | O3 plus F6/F9 | None. |
| O5 Native vault kernel/broker/release | Retain | T4 design boundary plus O1 | Hermes has no vault permission. |
| O6 Vault identity/owned-root storage | Retain | O5 plus T4 | None. |
| O7 USN reconciliation/observations | Retain | O3/O5/O6 plus T6 | No simplification. |
| O8 Retrieval/upload recovery/backpressure | Retain | O4/O7 plus T7 | None. |
| O9 Fact lineage/write-once projection | Retain | O2/O3/O8 plus T8 | Hermes proposal cannot bypass it. |
| O10 Detection/setup/doctor/handoff | Retain | O5/O6 plus T4 | None. |
| O11 Coordinated VSS backup/restore | Retain | O7/O9 plus T9 | No deferral. |
| O12 Acceptance/release/live smoke | Retain | O1 through O11 plus T10/C9 | Remains release-blocking. |

The retirement set is therefore empty for F1-F9, C1-C9, T1-T10, and O1-O12. Retired prospective work is limited to a new custom generic agent loop, generic plugin/skill/MCP ecosystem, custom wake-word engine, and parallel Hermes-owned Telegram ingress.

### 9.2 Staged implementation

1. Preserve every current branch and record reviewed heads/test counts; create and verify H0 without deleting a branch.
2. Continue the retained `0.1.0` Telegram/local-memory/Obsidian/release graph. It remains the production critical path.
3. In an isolated branch that can run in parallel after H0, add the exact Hermes source/runtime lock, acquisition bootstrap, license, SBOM, updater/ACL enforcement, config attestation, and fake Runs/Bridge fixtures.
4. Implement the H1 `HermesTokenAdapter` and durable Windows Brain Bridge against a strict fake Runs server, including unknown admission, cancellation, bounds, and no-fallback tests.
5. Bootstrap the exact zero-tool Hermes profile in external runtime directories and run credential-free compatibility, drift, update-denial, and clean-install tests with `wrangler dev --local`.
6. Configure DeepSeek in protected profile configuration and run one bounded local model smoke after every credential-free gate passes.
7. Run 20-turn local voice latency/failure/cancellation tests. Production Cloudflare remains on direct DeepSeek.
8. After `0.1.0`, implement H2 Brain/Proposal protocol, durable upstream admission hook, `jarvis_propose` plus pre-tool guard, checkpoint-v2 memory provider, and one harmless action through Jarvis re-authorization.
9. After H2 passes, adopt local `hey_jarvis` and later explicit toolsets behind separate grants. MCP remains disabled.
10. Only after a user-approved always-on host/cost decision, implement H3 HTTPS identity/operations and run shadow, canary, live-latency, rollback, and direct-path equivalence gates before any production selection.

Rollback sets the brain provider to direct mode, stops the sidecar, and retains every Jarvis event, call, grant, archive record, fact, and Markdown projection. No rollback depends on reversing a D1 migration or deleting Hermes state.

## 10. Required tests

- source/tag/commit/license/dependency-lock and patch-queue verification;
- `HERMES_MANAGED=jarvis`, read-only ACL, dirty/config drift, `/update`, CLI update, config mutation, and runtime-identity write-denial tests;
- one process/identity/home/port/key/writable-state root per profile, loopback-only native bind, bridge-only API-key possession, and closed endpoint-table tests;
- startup attestation of the complete resolved config, model/provider route, tool schema, pre-tool guard, plugin registry, MCP absence, source, and dependency hashes;
- fake and real Hermes readiness/Runs-event-schema compatibility;
- exact source-specific Runs fixtures: admission 202, actual SSE event allowlist, stop acceptance, and terminal GET reconciliation;
- strict turn/request/SSE parsing, hash/signature/replay/audience/expiry checks;
- H1 `requestId === correlationId`, canonical request-hash replay, changed-body conflict, and no adapter-generated replay identity;
- first-token/total timeout, disconnect, malformed stream, duplicate/gap, oversized frame, post-terminal, downstream quiescence, stop acceptance, terminal cancellation, and quarantine cleanup;
- durable request-ledger replay, changed-body rejection, per-session serialization, lost-202 unknown admission, unknown cancellation, and no provider switch after admission begins;
- authenticated idempotent bridge cancellation, native-key/run-ID confinement, lost cancel response, downstream disconnect, and continued terminal polling;
- stable process and opaque session isolation across principal/profile/channel;
- guest callers cannot access owner capabilities through prompts, tools, plugins, MCP, memory, or session reuse;
- H1 resolves zero tools; H2 resolves only `jarvis_propose`, and its mandatory pre-tool guard rejects every other tool before execution;
- `jarvis_propose` has no effect sink/credential/filesystem/network authority, and Hermes/model/plugin output cannot approve actions, mint grants, promote facts, or bypass confirmation;
- no PIN, phone number, provider SID, webhook body, credential, raw path, or secret reaches Hermes/logs/evidence;
- every trusted profile has `no_mcp`, no `mcp_servers`, and readiness fails if any MCP tool/registry/config appears;
- built-in memory/profile/background review and memory/skills toolsets remain disabled; checkpoint API v2 plus `compression.checkpoint_required: true` fail closed while preserving the uncompressed transcript on archive failure;
- voice 20-turn p50/p95 and cancellation budgets under normal and degraded conditions;
- direct-provider fallback and previous-Hermes-release rollback;
- deployed `0.1.0` routes cannot select or reach H1, and only Cloudflare owns the Telegram webhook;
- existing full Jarvis suite, typecheck, lint, audit, secret scan, and release gates unchanged or strengthened;
- clean Windows setup in isolated Python 3.11 without modifying the system Python or Jarvis local-agent runtime.

## 11. Success criteria

### 11.1 Jarvis `0.1.0`

- The current 1,182-test Jarvis baseline remains green and all retained Telegram/local-memory/Obsidian/release gates pass.
- Owner and guest telephone behavior is byte-for-byte compatible at the external Twilio boundary.
- Calls and Telegram work while the PC is off through Cloudflare/direct DeepSeek; Hermes is absent from deployed routing.

### 11.2 Hermes H1

- The exact pinned source runs in isolated Python 3.11 profiles with zero tools, zero MCP, disabled built-in memory/review, enforced update denial, and complete startup attestation.
- DeepSeek V4 Pro works through the pinned Hermes voice-safe profile under the local 20-turn latency/cancellation budget.
- Hermes returns only streamed text and cannot directly execute a Jarvis-controlled effect.
- Unknown admission/cancellation never duplicates a run, switches provider, reuses a quarantined session, or yields ambiguous text.

### 11.3 Hermes H2/H3

- One authenticated owner text request can propose and complete a harmless allowlisted action through `jarvis_propose` and Jarvis re-authorization with full audit lineage.
- `hey_jarvis` activates local Hermes voice on Windows without adding a custom wake-word implementation; this remains post-`0.1.0`.
- An adversarial guest/prompt/plugin/config fixture and any attempted MCP enablement cannot cross the owner, policy, memory, credential, or execution boundary.
- H3 calls meet the production latency/equivalence gates on an approved always-on host, and direct DeepSeek remains the safe selection for the next turn and full deployment rollback.
- Hermes upgrades and rollback are exact, reproducible, and do not follow `main`.
- Jarvis retains its name, personality, telephone number, permissions, memory authority, and future St. Remy separation while gaining Hermes' mature general-agent features.

## 12. Non-goals

- Replacing the completed Jarvis telephony/control plane with Hermes.
- Giving Hermes direct access to D1, R2, Twilio credentials, PIN material, or policy mutation.
- Making Hermes, wake word, PC control, browser errands, general tools, or an always-on Hermes host part of `0.1.0`.
- Tracking Hermes `main` or enabling self-update in production.
- Enabling Hermes terminal/file/browser tools, MCP, mutable built-in memory, or background learning in H1/H2.
- Claiming that local wake word, Discord voice, Twilio `<Say>/<Play>`, Vapi, or Bland is equivalent to Jarvis' inbound ConversationRelay path.
- Spending money on a production host during design or local integration.
- Deleting current branches, redundant plans, or direct-provider code before accepted migration evidence exists.
