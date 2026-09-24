# Jarvis memory research (2026-09-14)

> **Superseded in part by merged [#125](https://github.com/stremysid/jarvis/pull/125) and [#129](https://github.com/stremysid/jarvis/pull/129):** the D1 memory rebuild is on main and [the current roadmap](../plan/2026-09-19-jarvis-roadmap.md#the-model) records Flash as the chosen model; the implementation and model questions below are historical.

Reviewer-commissioned research: Claude Opus 5, read-only. The full report is
below. A separate fact-check is in
`2026-09-14-jarvis-memory-research-factcheck.md`. Nothing in this document
authorizes a migration, deploy, secret or live action.

## Read this first: what supersedes the report

**Sid's requirement, in his words (2026-09-14):** "all that i want is for
jarvis to have the best memory possible, it remebrs eveyr thats remotly
important or like someway for it to store everything ... and if i ask it to
recall somthing it can even if it inst important? ... it jsut should have the
best possible memeory perfeclty like a personal assiants whos sole job is to be
ur assitant". Earlier he asked for memory that preferably runs in the cloud and
is reachable regardless of his PCs. He did not choose among the report's
options. He delegated the design to the reviewer.

The build must deliver four outcomes:

1. **Keep every conversation.** Nothing is dropped as unimportant.
2. **Automatically remember what matters** and use it later, without Sid
   managing it.
3. **Recall anything on request, even unimportant things,** by searching the
   FULL conversation history, including events archived to R2. Distilled facts
   alone are not enough. The report's retrieval design centres on facts,
   summaries and a profile card, so full-history recall is an explicit added
   requirement.
4. **Flag guesses as uncertain.** Never present a guess as fact, and never
   treat one as an instruction or an authorization.

**Reviewer's picks for the report's section 8 questions**, made because Sid
delegated them:

- Memory lives in Cloudflare, per the report. No Linux server.
- No Obsidian for now.
- "Forget" hides the memory; erasure is designed later.
- Guesses don't need Sid to tap to confirm. They are stored and used only as
  flagged, uncertain hints and are never promoted to confirmed facts
  automatically. This supersedes the report's "guesses wait for a tap".
- The extraction model is pending Sid's money answer: DeepSeek V4 Pro at about
  $3.80/month, or Flash at about $1/month. It gets a hard monthly cap.

**Fact-check corrections to the report** (84 claims checked: 77 confirmed,
5 contradicted, 1 outdated, 1 unverifiable). None changes the recommendation,
the $1-6/month range or the backup design.

- Vectorize at five years costs about $0.60/month, not $0.05, because stored
  vectors count toward the queried dimensions each month.
- Workers AI distillation costs about $0, not $0.40; it stays inside the
  10,000 free neurons a day.
- Queues consumer CPU is 30 s by default and up to 5 min. 15 min is wall-clock
  time, not CPU.
- The free Obsidian git route needs no $9.99 app. GitSync by ViscousPotential
  is free for one repository.
- The Anthropic 49% figure is contextual embeddings plus contextual BM25, not
  plain BM25.
- Hetzner now costs $6.49 (CX23) or $6.99 (CAX11) a month excluding IPv4.
- `wrangler d1 export` refuses databases with FTS5 virtual tables, which
  production has. Never run the built-in export against production.
- DeepSeek announced on 2026-09-10 that `deepseek-v4-pro` requests would be
  served by Flash, but its live pricing page says Pro continues. Re-check
  before budgeting.
- Workflows steps get 5 min of CPU only when configured; the default is 30 s.

---

# Jarvis memory: where it should live and how to build it

Research date: 2026-09-14. Repository basis: `ksid1229-ops/jarvis` `origin/main` at `4833b74`.
Read-only research. Nothing in the repository, Cloudflare account, D1, R2 or any
provider was changed, deployed or queried.

How claims are marked:

- **[V Sn]** verified against numbered primary source Sn in section 9 (fetched 2026-09-14).
- **[R]** verified by reading the repository at `4833b74` (file named inline).
- **[E]** my estimate, calculated from verified prices, with the assumptions stated.
- **[U]** unverified. I could not confirm it from a primary source. Treat it as something to check.

---

## 1. Plain-language summary

1. Best option: keep Jarvis's memory in Cloudflare, the online service Jarvis already runs on. No new computer and no Linux server.
2. That makes memory work from your iPhone with every PC switched off, because it lives in the same place that already answers your texts and calls.
3. Extra cost: roughly $1 to $6 a month on top of the $5 Cloudflare plan you already pay. Most of it is the AI that reads your chats to pick out things worth remembering, and it can be capped.
4. Jarvis would keep three things: the full record of every conversation, a list of facts about you where each one shows where it came from, and short daily summaries.
5. It would search memory two ways at once: by matching words and by matching meaning.
6. You stay in charge. "Remember this" saves straight away. "Why do you think that?" shows the proof. "Forget that" hides it. Jarvis's guesses wait for your OK.
7. Obsidian is not a cloud service. It is a free notes app that keeps files on each device. For Jarvis to put notes on your phone while your PCs are off, you'd need Obsidian's paid sync ($4 to $5 a month) or a fiddlier technical setup.
8. So Obsidian should be an optional window you can add later, not the place memory lives.
9. The "small Linux server" in the plan is not needed for memory or for anything else planned right now. Your Windows PCs can still help when they happen to be on.
10. One important finding: even if that server had run, the current design would never have saved a fact from normal chatting. There is no "remember" or "confirm" step yet. The plan below adds one.
11. Nothing has been changed. You pick the direction first (section 8).

---

## 2. Recommended architecture

### 2.0 Starting point: what the code does today

- Every Telegram and voice turn becomes an append-only event in D1 `events`. Events stay in D1 for 90 days, then move to content-addressed segments in the R2 bucket `jarvis-archive`. [R `0001_foundation.sql`; `apps/cloud-gateway/src/archive/archive-repository.ts:78`]
- Telegram and calls share one context retriever: recent turns plus full-text search over *published projected facts*, inside a 32,000-byte, 64-item, 32-fact budget. [R `conversation/context-retriever.ts`; `index.ts:103`; `voice/production-runtime.ts:97`]
- The distillation model call already happens in the cloud: `sync/memory-distill.ts` calls DeepSeek at high reasoning effort with deliberately empty memory context. What runs in Python on a device is the *coordinator*: choose excerpts, validate, store proposals, promote, publish. [R]
- Facts reach the cloud only through the 0014 device projection: a signed, versioned snapshot of one device's *active* facts, capped at 1,024 facts in 32 pages. [R `0014_memory_projection.sql`; `sync/memory-projection.ts`; `jarvis_local/sync/memory_projection.py:320`]
- `jarvis node` refuses to start on anything but Linux. [R `jarvis_local/node.py:239-240`]
- **A second gap, independent of Linux.** The distiller always stamps `origin = model` (`jarvis_local/memory/distillation.py:200-202`). Promotion auto-activates only `authenticated_first_person` and `deterministic_observation` (`promotion.py:28-33`). No product code creates either origin, `PromotionEngine.confirm()` has no callers, and there is no `/remember`, `/why` or `/forget` command. [R, by `git grep` over `apps/local-agent/jarvis_local` and `apps/cloud-gateway/src`] Projection publishes only active facts, so a running node would still have published **zero** facts from ordinary conversation. "Zero published facts" is a design gap as well as a platform problem.
- There is no semantic search. The embedder is a hashed word-feature vector and retrieval never calls the vector index. [R `memory/embeddings.py`; KNOWN_ISSUES.md]
- The Obsidian adapter (stage one, Windows, write-once) has no redactor, so nothing from the vault may be uploaded yet. [R KNOWN_ISSUES.md]

### 2.1 The recommendation in one paragraph

Build cloud-native memory on the Cloudflare account Jarvis already uses. D1 stays the
source of truth: the existing event log plus a new cloud fact store. Vectorize holds
meaning-vectors that can always be rebuilt. Workers AI makes those vectors. A Cloudflare
Workflow, started by the existing hourly cron, runs distillation. The existing gateway reads
memory for Telegram and calls. The home PC becomes an optional helper (an extra encrypted
backup copy, occasional bulk jobs) that nothing depends on. No always-on server.

```
iPhone: Telegram, calls
      |
      v
Cloudflare Worker gateway (exists) ----> model provider (DeepSeek today; AI Gateway optional)
      |   |
      |   +--> D1: events (exists), facts, sources, transitions, episodes, run log   <- source of truth
      |   +--> Vectorize: meaning index (rebuildable from D1)
      |   +--> Workers AI: embeddings, optional reranker
      |
      +-- hourly cron --> Workflow: read new events -> distil -> validate -> decide origin in code
      |                             -> promote -> link duplicates/conflicts -> embed
      +-- nightly -----> daily summaries, expiry, profile card, logical export -> R2 (locked bucket)

Windows PC (optional, only when on) -> pulls the encrypted nightly export; optional bulk jobs
Obsidian (optional, later)          <- notes generated from D1 (section 5)
```

### 2.2 Components

| # | Component | Role | Key facts |
|---|---|---|---|
| 1 | Worker gateway (exists) | Front door: Telegram webhook, Twilio voice, four crons | Unchanged [R `wrangler.toml`] |
| 2 | D1 `events` + R2 `jarvis-archive` (exist) | Raw episodic record; the "receipts" | D1: 10 GB per database, 2 MB max row, 30 s max query, 1,000 queries per invocation on Paid [V S1]. R2: $0.015/GB-month, 10 GB-month free, no egress fee [V S34] |
| 3 | New D1 fact store | Facts, profile, provenance, states, supersession, FTS5 | D1 supports FTS5 [V S3]; production D1 already runs an FTS5 table from 0014 [R HANDOFF.md] |
| 4 | New D1 episode table | One model-written summary per day, linked to its event range | No authority; context only |
| 5 | Vectorize index | Meaning search over facts and summaries | 1,536 dims max, 20 M vectors per index, 10 metadata indexes [V S6]; metadata indexes must exist before inserts [V S8]; writes queryable after "a few seconds" [V S9] |
| 6 | Workers AI embeddings `@cf/baai/bge-m3` | Turn text into 1,024-number vectors | $0.012 per million input tokens [V S10]; 1,024 dims, 100+ languages [V S65]; Cloudflare does not train on Workers AI customer content [V S15]. Same-price alternative `@cf/qwen/qwen3-embedding-0.6b` [V S10, S66] |
| 7 | Workflows | Hourly distillation, nightly consolidation | 5 min CPU per step, unlimited wall clock per step, retries, 10,000 steps per workflow [V S20]; 500,000 steps and 1 GB-month included on Paid [V S21] |
| 8 | Extended `D1ContextRetriever` | Profile card + keyword + meaning search, packed into the existing budget | Section 4.3 |
| 9 | Telegram owner controls | `/remember`, `/why`, `/forget`, confirm/reject buttons on the existing decision queue | Closes the zero-facts gap |
| 10 | Backups | D1 Time Travel + nightly logical export to a locked R2 bucket | Time Travel restores to any minute in the last 30 days, no extra cost, destructive in place [V S4]. `wrangler d1 export` does **not** work on databases containing virtual tables such as FTS5 [V S5], and production D1 already has one [R], so a custom export is required. R2 bucket locks block deletion and overwrite for a set period [V S35] |
| 11 | Optional PC helper | Existing Windows Python agent, repurposed: pull encrypted exports, run bulk jobs | Task Scheduler can run a missed task "at any time after its scheduled time has passed" (default 10-minute delay) [V S70]; nothing waits for it |
| 12 | Optional Obsidian window | Notes generated from D1 | Section 5 |

Note on bge-m3 input size: Cloudflare's model page lists a 60,000-token context [V S12]; the
model card says 8,192 tokens [V S65]. Keep each embedded chunk well under 8,000 tokens.

### 2.3 What each Cloudflare building block is for here

| Building block | Used for | Verified limits and prices |
|---|---|---|
| D1 | Source of truth | 25 B rows read, 50 M rows written, 5 GB storage included; then $0.001/M reads, $1.00/M writes, $0.75/GB-month [V S2] |
| Vectorize | Meaning search | 50 M queried and 10 M stored dimensions included; then $0.01/M queried, $0.05 per 100 M stored [V S7]; topK up to 100, or 50 with metadata [V S6] |
| Workers AI | Embeddings, reranker, optional cheap model | $0.011 per 1,000 neurons, 10,000 neurons/day free on Free and Paid [V S10]; reranker `bge-reranker-base` $0.0031/M tokens [V S14] |
| Cron triggers | Start jobs | 30 s CPU below a one-hour interval, 15 min CPU at one hour or more, 15 min wall clock [V S16] |
| Workflows | Durable multi-step jobs | Steps and storage billing started 10 Aug 2026 [V S21] |
| Queues | Not needed at first; fan-out for big backfills | 1 M operations/month included, $0.40/M after; about 3 operations per message [V S22]; consumers get 15 min CPU [V S16] |
| Durable Objects | Not the memory store; keep for call sessions | SQLite objects: 10 GB each [V S19]; 5 GB-month included then $0.20/GB-month; 1 M requests included [V S18] |
| R2 | Archive and backups | See above [V S34, S35] |
| AI Gateway | Optional: route model calls, logs, caching, fallbacks | Core features free; 10 M logs per gateway on Paid [V S28] |
| Containers and Sandbox | Optional: Obsidian headless sync, bounded agent runs | Instance sizes from 1/16 vCPU and 256 MiB up to 4 vCPU and 12 GiB [V S24]; 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk included [V S23]; CPU billed on active use since 21 Nov 2025 [V S25]; disk is wiped when a container sleeps [V S26, search excerpt of the official FAQ]; Sandbox runs Linux containers on Paid [V S27] |
| Browser Run | R5 and R8 cloud browsing | 10 browser-hours and 10 concurrent browsers included, $0.09/hour after [V S31]; keep-alive up to 10 min [V S32]; human handoff through Live View links valid up to 1 hour [V S33] |
| AI Search | Optional later, for documents | Free in open beta within limits; 4 MB max file; Workers AI and AI Gateway billed separately [V S30]; hybrid keyword plus meaning search [V S29] |

### 2.4 Why this beats the alternatives

1. **It is the only option that meets "works with every PC off" without a machine Sid has to run.** The gateway is already always on and already holds the event log, the model key, R2 and FTS5.
2. **It is the cheapest.** Storage, indexing and job running fit inside allowances already paid for; the only real cost is model tokens, about $1 to $6 a month and cappable [E, section 4.4].
3. **It reuses most of what exists** and has the lowest operating burden: no operating system to patch, no SSH, firewall, disk or service manager.

It also keeps the privacy footprint where it already is: conversation data is already in
Cloudflare D1 and R2, and Sid approved sending Jarvis context to DeepSeek [R foundation design §7].

### 2.5 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cloudflare lock-in | Plain SQL schema; nightly NDJSON export to R2 plus optional PC copy; vectors rebuildable with any model |
| No built-in D1 export for this database [V S5] | Custom export job plus a restore drill into a scratch D1 database |
| Vectorize lag of a few seconds [V S9] | D1 state is re-checked for every hit, so `/forget` takes effect at once |
| Voice latency from an embedding call and a vector query per turn [U, not measured] | Voice always uses profile card plus keyword search; meaning search only inside a fixed time budget, with the fallback recorded. The release gate is p95 first audible response at or below 4 s [R foundation design §5.3] |
| Model cost and a finite prepaid DeepSeek balance | Hard monthly cap enforced per run; cheaper model for distillation |
| Memory poisoning by other people's text | Third-party and model text never auto-activates; facts never authorize actions (tier 3 still needs a tap) |
| Porting and review cost | Python coordinator logic ported to TypeScript and reviewed; one live-data migration at max review [R BUILDING.md] |
| True erasure conflicts with append-only events, archive segments and 30-day Time Travel | Build "retract" first; design "erase" separately as a tier-3 operation (section 4.5) |
| Usage-priced services can change price | Existing capacity alerts cover D1 and R2 [R DECISIONS.md]; extend them to model spend |

---

## 3. Alternatives

Costs are monthly and incremental: the $5 Workers Paid plan is already paid [R roadmap §8].

| Option | Monthly cost | Ops burden for Sid | Works with every PC off | Privacy | Build effort | Lock-in |
|---|---|---|---|---|---|---|
| **A. Cloud-only on Cloudflare (recommended)** | About $0 infrastructure plus about $1 to $6 model [E] | Very low | Yes | Cloudflare and the chat model provider, both already used | Medium: about 4 to 6 builder sessions [E] | Medium, reduced by exports |
| **B. Cloud-first plus optional PC helper (recommended add-on)** | Same as A | Low; helper is optional | Yes; helper jobs wait for the PC | Adds an encrypted copy on Sid's PC | A plus about 1 session [E] | Lowest (off-Cloudflare copy) |
| C. Always-on Linux VPS "home node" (roadmap) | Host $4 (512 MiB) or $6 (1 GiB) at DigitalOcean, backups +20% weekly or +30% daily [V S67]; Hetzner from about $4.50 to $6.50 after 2026 increases [U S68]; roadmap estimate $6 to $15 [R]; plus the same model costs | High for someone who has never used Linux: updates, SSH keys, firewall, systemd, disk and backup checks, private networking, key storage, restarts at 2 a.m. The existing runbook is bash, systemd and chmod steps Sid cannot run [R `docs/runbooks/home-node.md`, CLAUDE.md] | Yes, while healthy; single point of failure | Adds a VPS provider holding decrypted memory | Medium-high: node code exists, but deployment, hardening, monitoring, semantic search, vault and backups remain, and the zero-facts gap still needs fixing | Low |
| C2. A Linux box at home | Not possible without buying hardware; the home PC is off overnight [R CLAUDE.md] | n/a | No | n/a | n/a | n/a |
| D1. Mem0 Platform | Free tier allows 1,000 retrievals/month (too few for recall on every turn); Starter $19 (5,000 retrievals); graph memory needs Pro $249 [V S51] | Low | Yes | A third company stores every extracted memory | Low-medium to integrate, but receipts, promotion and forget rules still have to be built around it | High; the open-source version (Apache-2.0) needs a server [V S52] |
| D2. Zep Cloud | From $125/month (Flex) [V S54]; open-source Graphiti needs Neo4j, FalkorDB or Neptune [V S56] | Low (cloud), high (self-host) | Yes (cloud) | Third party | Medium | High |
| D3. Letta | API plan $20/month plus model usage [V S57]; self-hosted Docker image deprecated [V S58] | Low (cloud) | Yes | Third party | High: it is an agent platform that would compete with Jarvis's control plane | High |
| D4. Supermemory | Free ($5 credits), Pro $19, Max $100; self-hosting only on Scale at $399 and up [V S59] | Low | Yes | Third party | Low-medium | High |
| D5. Cloudflare AI Search | Free in open beta within limits; model use billed [V S30] | Very low | Yes | Cloudflare | Low for documents; it is not a fact store with receipts | Medium (beta) |

About benchmark claims: Mem0 reports 92.5 on LoCoMo and 94.4 on LongMemEval for its managed
platform [V S52, vendor claim]; the Zep paper reports up to 18.5% better accuracy on
LongMemEval with 90% lower latency than baselines [V S55]. These are self-reported and say
nothing about Sid's data. They are not a reason to hand memory to a third party, but they
confirm which techniques matter: extracting facts, handling change over time, and combining
retrieval methods.

---

## 4. Memory structure spec

### 4.1 Tiers

| Tier | Contents | Where | Authority | Written by |
|---|---|---|---|---|
| 0. Working context | Recent turns, profile card, retrieved items for one turn | Not stored | None | Retriever |
| 1. Raw episodes | Every committed turn, later every document read; redacted | D1 `events`, then R2 | Receipts only | Gateway ingress (exists) |
| 2. Episode summaries | One short summary per day | D1 `memory_episodes` + Vectorize | None; context only | Nightly Workflow (model) |
| 3. Facts | One statement each, with sources, state and validity | D1 fact tables + FTS5 + Vectorize | Active facts may inform answers. Only owner-stated or owner-confirmed facts may shape reminders, schedules or other proactive behaviour | Hourly Workflow (model proposes, code decides) and owner commands |
| 4. Profile | Facts about Sid (identity, preferences, habits, routines, relationships), each `stated` or `observed` | Same tables, `kind` column; rendered as a card | Observed patterns stay proposed until confirmed | Nightly Workflow and owner |
| 5. Documents (R7, later) | Emails, pages, PDFs as text chunks | D1 + Vectorize, or AI Search | `third_party`; never auto-promoted | Ingestion jobs |

Procedural memory (how Jarvis behaves) stays in code and configuration. The CoALA framework
separates working, episodic, semantic and procedural memory in the same way [V S62].

### 4.2 Key tables and fields

New migration `0016_cloud_memory.sql`, additive only. It follows the house conventions: ULIDs,
ISO-8601 millisecond timestamps, CHECK constraints, and triggers that enforce invariants
[R ARCHITECTURE.md rule 3].

**`memory_facts`** (immutable)

- `fact_id` = `fact_` + first 32 hex characters of SHA-256 over canonical `{principal_id, sorted source event ids, NFC text}`. This identity is already implemented identically in Python and TypeScript [R `memory/facts.py:74-84`; `context-retriever.ts:290-297`].
- `principal_id`; `text` of 1 to 4,096 UTF-8 bytes, no control or line-separator characters, and refused (not rewritten) if redaction would change it [R `projection_policy.py`; 0014 constraints].
- `kind` in {identity, preference, dislike, habit, routine, relationship, plan, project, decision, schedule, other}.
- `basis` in {stated, observed, imported}.
- `origin` in {authenticated_first_person, deterministic_observation, model, third_party}, the existing enum [R].
- `sensitivity` in {normal, sensitive}, plus `sensitivity_class` in {none, health, financial, other_people, location}.
- `confidence` 0 to 1: informational only, never grants authority by itself.
- `valid_from`, `valid_to` (nullable), for facts that expire, such as a dated exam.
- `entities_json`: a short tag list such as `["person:mom","project:jarvis"]`. This is the "graph-lite" layer; no graph database.
- `distiller_version`, `distilled_at`, `content_hash`, `primary_event_id`, `primary_event_sequence`, `created_at`.
- Triggers: no UPDATE; no DELETE except through the tier-3 erase path.

**`memory_fact_sources`** (immutable): `fact_id`, `position` (0 to 7), `event_id`,
`event_sequence`, `excerpt` (up to 4,096 bytes), `excerpt_verified` (1 only when code has
checked the excerpt against the stored event text; the 0014 gateway already performs a prefix
check [R `memory-projection.ts:316-317`]), `source_kind` in {owner_turn, assistant_turn,
owner_command, vault_note, document}.

**`memory_fact_transitions`** (append-only): `transition_id`, `fact_id`, `from_state`,
`to_state` in {proposed, active, rejected, superseded, retracted, expired, erased},
`reason_code` (for example `auto_rule_v1`, `owner_confirmed`, `owner_rejected`, `owner_forgot`,
`superseded_by_owner`, `validity_ended`), `actor` in {rules, owner}, `authorizing_event_id`
(the owner's Telegram event for every owner action; NULL only when `actor = rules`),
`policy_version`, `created_at`. Allowed moves are trigger-enforced: proposed to active or
rejected; active to superseded, retracted or expired; anything to erased only with a tier-3
receipt.

**`memory_fact_state`** (derived, one row per fact, maintained by trigger from transitions):
`fact_id`, `state`, `last_transition_id`, `updated_at`. Retrieval always joins this table.

**`memory_fact_links`** (immutable): `from_fact_id`, `to_fact_id`, `link_type` in
{supersedes, duplicate_of, contradicts, related}, `created_by` in {rules, model_proposal,
owner}, `authorizing_transition_id`.

**`memory_episodes`** (immutable): `episode_id`, `principal_id`, `period_start`, `period_end`,
`first_event_sequence`, `last_event_sequence`, `summary_text` (bounded), `summarizer_version`,
`sensitivity`, `content_hash`, `created_at`. A re-summary is a new row plus a `supersedes` link.

**`memory_vectors`** (ledger of what is in Vectorize): `item_kind` in {fact, episode,
doc_chunk}, `item_id`, `model_id`, `dimensions`, `content_hash`, `mutation_id`, `upserted_at`,
`deleted_at`. Makes re-embedding idempotent and deletions auditable. A model change means a new
index; models are never mixed, a rule the local vector index already enforces
[R `memory/vector_index.py:149-161`].

**`memory_runs`** (observability and cost cap): `run_id`, `job` in {distill, consolidate,
embed, export, restore_drill}, `run_key` (claimed with `ON CONFLICT DO NOTHING`, rule 5),
`through_sequence`, `excerpts`, `proposals`, `rejected`, `activated`, `model`, `input_tokens`,
`output_tokens`, `estimated_cost_usd`, `started_at`, `finished_at`, `failure`. A run with nothing
new is still recorded, so silence never looks like success [R ARCHITECTURE.md rules 1 and 5].

**Indexes and cursor**: FTS5 tables `memory_fact_fts` and `memory_episode_fts` as external-content
indexes with tokenizer `unicode61 remove_diacritics 2`, as in 0014 [R]; a new `consumer_cursors`
row `memory-distiller` [R 0001].

**Existing 0014 tables**: leave them in place, unused by the main path. Do not drop them;
dropping is a destructive production change.

### 4.3 Retrieval for each turn

1. **Owner only.** Memory is retrieved only for the authenticated owner principal, as today [R foundation design §9].
2. **Profile card.** Deterministic render of up to about 12 active profile facts (at most 1,500 bytes), preferring stated over observed, recent, higher confidence. Always included for the owner.
3. **Keyword search.** FTS5 BM25 over active facts and episode summaries, using the existing literal-term builder (at most 16 terms) [R `context-retriever.ts:218-230`].
4. **Meaning search.** Embed the query with the same model; query Vectorize for the top 20 in the owner's namespace, filtered to active items; drop any hit whose D1 state is no longer active.
5. **Fuse.** Reciprocal rank fusion of the two lists, small boosts for stated facts, recency (episodes) and confidence, and at most two items per entity tag.
6. **Optional rerank** for Telegram and background work with `bge-reranker-base` [V S14].
7. **Time-aware queries.** When the question names a time ("last week", "in March"), filter by period and validity. The LongMemEval authors list time-aware query expansion among three design changes that improved recall [V S60].
8. **Pack** into the existing 32,000-byte and 64-item budget, keeping the existing contiguous-history rule and JSON quoting of every entry [R `context-retriever.ts`; fact-projection runbook].

Why combine methods: Anthropic measured a 49% drop in top-20 retrieval failures when adding
BM25 keyword search to embeddings, and 67% with reranking as well [V S61].

Voice: profile card and keyword search always; meaning search only inside a fixed time budget,
measured before it is switched on [U].

Graph: not now. Temporal knowledge graphs help with facts that change [V S55] but need a graph
database server [V S56]. Supersession links, validity windows and entity tags cover a single
person's scale. Revisit only if measured recall fails.

### 4.4 Distillation when every PC is off

**Who calls the model:** a Cloudflare Workflow in the gateway's account, through the existing
model adapter. DeepSeek today; later any model through configuration or AI Gateway.

**When:** hourly, when the existing `0 * * * *` cron claims `memory-distill:<hour>` and starts
one Workflow instance; immediately for `/remember` (no model needed); nightly, alongside the
existing evening cron pair `30 23,0 * * *` [R `wrangler.toml`].

**Hourly steps**

1. Read events after the `memory-distiller` cursor, from live D1 or the tiered R2 reader [R `archive/tiered-event-reader.ts`], using the existing event-type allowlist [R].
2. If nothing is new, record a `nothing_new` run and stop.
3. Build at most 32 excerpts under the existing bounds and framing rules [R].
4. Call `distil()` with an extended output schema: the existing `text`, `sourceEventIds` and `confidence`, plus `kind`, `basis`, `quote` (Sid's exact words stating the fact), `entities` and `validTo`. Keep the rule that the distiller receives **no** existing memory, so facts cannot reinforce themselves [R `memory-distill.ts:162-165`].
5. Validate with the existing checks: cited ids must be ones supplied, no tool or action keys, byte, control-character and redaction limits [R].
6. **Decide origin in code, never from the model:**
   - `/remember <text>` becomes `authenticated_first_person`, `basis = stated`, text = Sid's words.
   - A proposal whose `quote` is an exact substring of an authenticated owner `conversation.user_committed` event and contains a first-person word (I, I'm, my, me) becomes `authenticated_first_person`, and **the stored text is the quote, not the paraphrase**.
   - Everything else is `model` (or `third_party` for documents) and stays proposed.
   - Health, money and other-people classes always stay proposed, whatever the origin.
7. Write facts, sources and first transitions in one D1 batch. Advance the cursor only after that write, as the Python coordinator does today [R `distillation.py:125-130`]. Re-proposals are idempotent because identity is a content hash.
8. Apply promotion allowlist v1, a port of `promotion.py` [R].
9. Reconcile: exact duplicates get a `duplicate_of` link. A possible contradiction with an active fact becomes a decision-queue item ("Replace X with Y?"); Sid's tap is the supersession. A model inference never supersedes a fact Sid stated.
10. Embed new active facts, upsert to Vectorize, record in `memory_vectors`.
11. Record tokens and estimated cost. When the monthly cap is reached, skip model steps and say so in the digest.

**Nightly steps:** write the day's episode summary (model, no authority); compute simple
patterns from event metadata and propose an observed habit only after repeated evidence (the
plan says observed entries earn confidence through repetition [R expansion plan §7]; suggested
threshold: at least 5 occurrences over at least 2 weeks); expire facts past `valid_to`; refresh
the profile card; add "New things I think I learned: confirm?" with buttons to the morning digest.

**Cost [E].** Assumptions: about 200 conversation events a day (about 15,000 tokens); about 7
distillation calls a day of about 5,500 input tokens and up to 4,000 output tokens including
reasoning; one nightly call of about 20,000 input and 5,000 output tokens.

| Distillation model | Price per M tokens (in / out) | Estimated monthly cost |
|---|---|---|
| `deepseek-v4-pro` (current gateway default [R `deepseek-provider.ts:32`]) | $0.66 / $1.98 off-peak, double at peak [V S64] | About $3 off-peak, up to about $6 at peak |
| `deepseek-flash` | $0.15 / $0.60 off-peak, double at peak [V S64] | About $1 to $2 |
| Workers AI `qwen3-30b-a3b-fp8` | $0.051 / $0.335 [V S10] | About $0.40; distillation quality untested [U] |

Everything else at this volume is effectively free: embeddings about 1.2 M tokens a month, about
$0.015 and within the free daily neurons [V S10]; Vectorize about 20 M stored dimensions in year
one, about $0.01 a month [V S7]; D1 rows and storage, Workflow steps and R2 all inside included
amounts [V S2, S21, S34].

### 4.5 Correct, why and forget

- **`/why <words>`**: deterministic lookup, no model, so receipts cannot be invented. Shows each matching fact, its state, date, channel, the quoted excerpt and the event id. This is the R7 exit test ("Why do you think I hate mornings?") [R roadmap R7].
- **Correct**: "that's wrong, it's X", or tapping "Wrong" under a `/why` answer, proposes a new fact from Sid's correcting message; his tap authorizes `supersedes`; the old fact remains readable as history.
- **Confirm or reject**: decision-queue buttons; the tap is the authorizing event.
- **`/forget` (default: retract)**: transition to `retracted`; gone from retrieval immediately through D1 state; vectors removed with `deleteByIds` within a few seconds [V S9]; any Jarvis-generated Obsidian note replaced with a "forgotten" marker. The original messages stay in the record, and Jarvis says so.
- **Erase (tier 3, later, separate design)**: removing text from `events`, R2 segments and backups conflicts with append-only triggers and the content-addressed archive [R 0001], D1 Time Travel keeps 30 days [V S4], and locked backups keep their retention [V S35]. It needs an owner tap, an erasure receipt that holds only hashes, rewriting of affected archive segments and manifests, and an honest "fully gone after about five weeks" message. Build retract in R2; design erase in R7.

### 4.6 Redaction and privacy

- Keep ingress redaction before any event exists (credentials, PIN digits, tokens) and the redaction test vectors shared by Python and TypeScript [R fact-projection runbook].
- Every memory write re-runs the check and refuses text that redaction would change [R].
- Sensitive classes become `restricted` context and are left out of the profile card and any export by default.
- Other people's content (emails, web pages, Brightspace) is `third_party`: searchable, never auto-promoted [R expansion plan §8, "memory poisoning"].
- Auto-activated facts can inform answers but never authorize actions. Money, contacting people, deleting data and production still need a tap [R ARCHITECTURE.md rule 4]. Residual risk: text Sid pastes into Telegram reads as his own words; the class rules above and the tier-3 backstop limit the damage.
- Processors: DeepSeek (already approved for conversation context [R foundation design §7]) and Workers AI for embeddings (no training on customer content [V S15]). The roadmap's "self-hosted embedding model, nothing sent to a third-party API" [R roadmap §4.2] would become "no processor beyond Cloudflare and the chosen chat model". That needs Sid's agreement (question 5).
- Obsidian notes enter memory only through the gateway's redactor, which closes the vault "no redactor" gap by construction [R KNOWN_ISSUES.md].

### 4.7 Backup and restore

| Layer | Mechanism | Recovery point | Notes |
|---|---|---|---|
| Whole D1 database | Time Travel | Any minute in the last 30 days [V S4] | Destructive in-place restore; owner only |
| Memory tables and recent events | Nightly NDJSON plus SHA-256 manifest to a separate `jarvis-backups` R2 bucket with a 35-day lock [V S35] | 24 hours | Needed because `wrangler d1 export` refuses databases with virtual tables [V S5] |
| Older events | Existing R2 archive segments with verified readback [R HANDOFF.md] | Continuous | Unchanged |
| Copy outside Cloudflare | PC helper pulls the latest export when on and seals it with DPAPI [R `memory/backup.py`] | Next time a PC is on | Protects against losing the Cloudflare account |
| FTS5 and Vectorize | Rebuilt from D1 | n/a | The FTS5 `rebuild` command is already documented [R fact-projection runbook] |

Restore drill once a month: import the latest export into a scratch D1 database, rebuild FTS5,
compare row counts and hashes, and report the result in the digest.

### 4.8 Growth over years [E]

- Events: about 200 a day at about 1.5 KB is about 110 MB a year; D1 holds 90 days (about 27 MB) and R2 holds the rest, with 10 GB free [V S34].
- Facts: a few thousand a year at about 4 KB including sources is under 20 MB a year.
- Summaries: 365 a year at about 2 KB is under 1 MB a year.
- Vectors: about 20,000 a year; after five years about 100,000, roughly 102 M stored dimensions, about $0.05 a month [V S7].
- D1 allows 10 GB per database [V S1]; at these rates that is decades away. If documents grow large in R7, use a second D1 database or R2 with AI Search.
- The 0014 snapshot cap of 1,024 facts [R] disappears.

### 4.9 What to reuse and what to change

| Existing piece | Decision | Why |
|---|---|---|
| D1 `events`, outbox, R2 archival | Keep | Already the permanent record |
| Redactor and shared redaction vectors | Keep | One safety boundary |
| Fact identity hash; 4,096-byte, 8-source, control-character limits | Keep | Identical in both languages already |
| Origin enum and promotion allowlist (`promotion.py`, 77 lines) | Port to TypeScript | Same rules, run in the cloud |
| `distil()`, `validateExcerpts`, `validateProposal` | Keep; extend output schema | Already cloud-side |
| `D1ContextRetriever` budget, literal FTS builder, JSON quoting | Keep; add profile card and vectors | Boundary tests already exist |
| 0014 trigger patterns (immutability, receipt-gated transitions, external-content FTS) | Reuse as templates | ARCHITECTURE.md rule 3 |
| 0014 device projection tables and `/sync/memory/project` | Park; do not drop | Only needed if a device ever contributes facts |
| Python coordinator (`agent.py`, `distillation.py`, `sync/memory_projection.py`) | Park as a reference; repurpose the agent as the PC helper | Coordination moves to Workflows |
| `jarvis node` (Linux) and `home-node.md` | Park; mark historical | Not needed |
| Hashed word-feature embedder and local vector index | Replace with Workers AI and Vectorize | Real meaning search with PCs off |
| DPAPI local backup | Reuse on the PC helper | Copy outside Cloudflare |
| Obsidian stage-one adapter | Keep local-only; a future window is generated from D1 | Section 5 |
| Missing | Add first-person path, `/remember`, `/why`, `/forget`, confirm buttons, cost cap, exports | Closes the zero-facts gap |

---

## 5. Obsidian

### 5.1 What Obsidian actually is

- A free app; no sign-up required [V S37]. Notes are Markdown plain-text files in a folder on the device, with settings in a `.obsidian` folder [V S41].
- It is **not a cloud service** on its own. Obsidian's own guide lists Obsidian Sync (paid), iCloud, OneDrive, Google Drive, Syncthing, and Git or Working Copy as ways to sync [V S40]. On iPhone it recommends Obsidian Sync or iCloud, and says Dropbox, Google Drive, OneDrive and Syncthing are not officially supported on iOS [V S40].
- **Obsidian Sync** costs $4/month billed annually or $5 monthly (Standard), and $8 or $10 (Plus) [V S38]. Standard: 1 GB, 5 MB max file, 1 synced vault, 1 month of history. Plus: 10 GB (upgradable to 100 GB), 200 MB files, 10 vaults, 12 months of history [V S39]. End-to-end encryption is available [V S38].
- **Obsidian has an official headless Sync client** (`obsidian-headless`, open beta). It requires an active Sync subscription and Node.js 22 or later, ships prebuilt binaries for Windows and macOS, supports Linux, offers `merge` or `conflict` handling, and warns not to use both desktop Sync and headless Sync on the same device [V S42, S43]. I found no other official way to write into Obsidian Sync [U].
- **Obsidian Git plugin**: its README says "The Git implementation on mobile is very unstable! I would not recommend using this plugin on mobile," warns of size limits and crashes, and points to a GitSync app instead [V S44]. GitSync.md for iPhone is $9.99 one-time [V S45].
- **Out of date in the roadmap:** §5.4 says Obsidian Sync would need a PC on "because only the Obsidian app can write through it" [R]. The official headless client removes that constraint [V S42, S43].

### 5.2 Source of truth or window?

**Not the source of truth:**

- Markdown files have no transactions, receipts, states or owner scoping. The approved Obsidian design rejected "vault as the only memory store" for exactly these reasons [R `obsidian-memory-design.md` §3.1].
- A phone edit or a sync mishap could silently change or delete a "fact" with no record of who changed it or why.
- Text pasted into a note (an email, a web page) could turn into a "fact" about Sid, the memory-poisoning case the plan forbids [R expansion plan §8].
- Cloud-side Jarvis cannot read a local vault. Memory would depend on a sync bridge being up for every question.

**A good window:**

- Jarvis generates readable notes from D1: a profile page, topic pages of active facts, daily ledgers, "what I learned this week".
- Sid's edits come back as proposals, never as authority, and he confirms them with a tap.

### 5.3 How cloud Jarvis could write notes with every PC off

| Route | How it works | Cost | Phone experience | Risks |
|---|---|---|---|---|
| **A. Obsidian Sync with the official headless client in a short-lived Cloudflare Container** | A Worker starts a container on a schedule. It runs `ob sync` to pull, writes Jarvis's notes, reads Sid's changed notes, runs `ob sync` to push, and exits | Sync Standard $4 to $5 a month [V S38]; container time likely inside Workers Paid allowances [E from V S23, S25] | Best: official iPhone sync, no git [V S40] | Open beta [V S42]; container disk is wiped on sleep, so each run re-downloads the vault [V S26]; the Obsidian login and vault encryption password become Cloudflare secrets; unattended re-login with two-factor sign-in unproven [U]; Standard allows only one synced vault [V S39] |
| B. Private GitHub repository written by the Worker | Worker commits through the REST contents API, or trees plus commit plus ref for multi-file changes [V S46, S47]; phone and PCs pull with a git client | $0 for private repos [V S50] plus a $9.99 iPhone app [V S45] | Workable but manual: open the git app, pull and push; plugin on mobile "very unstable" [V S44] | Merge conflicts are confusing on a phone; a repository-scoped write token lives in Cloudflare (fine-grained tokens can be limited to one repository with contents write [V S49]); limits are ample (5,000 requests/hour, 80 content-creating requests/minute [V S48]) |
| C. iCloud Drive | Native iPhone sync | $0 to Apple storage plan | Native | No server-side way for cloud Jarvis to write into it that I could find [U]; Jarvis's writes would need a PC, failing the PCs-off rule |
| D. No Obsidian for now: Telegram plus a private read-only memory page | Worker serves a page behind Cloudflare Access | $0 (Access free for up to 50 users [U S36]) | Good for reading and confirming; poor for long notes | Nothing new |

**Conflict rules for A or B**

1. Jarvis writes only inside its own `Jarvis/` folder.
2. Jarvis overwrites a file only when its current hash equals what Jarvis last wrote. Otherwise Sid edited it: keep Sid's version, read the edit as a proposal, and write Jarvis's update under a new name. This adapts the approved design's "never lose user text" rule [R `obsidian-memory-design.md` §8].
3. Everything outside `Jarvis/` is read-only to Jarvis and uploaded only from folders Sid opts in, redacted at the gateway.
4. Route A: configure headless conflict handling to keep both copies rather than merge Jarvis-owned files (exact behaviour of the two modes unverified [U]).
5. Route B: never force-push. A 409 or non-fast-forward means re-read and retry. Sid's commits win outside `Jarvis/`.

### 5.4 Recommendation

- **D1 is the memory. Obsidian is an optional window**: not a dependency, and not part of the R2 exit test.
- **Now:** use Telegram (`/why`, `/remember`, `/forget`, confirm buttons), optionally with a private read-only memory page (route D).
- **Later, if Sid wants notes on his phone:** route A, after a one-session trial proving unattended sign-in and conflict behaviour. It is the only route with a smooth, officially supported iPhone experience.
- **Route B** only if Sid wants $0 a month and is comfortable tapping sync in a git app.
- The roadmap's git-backed vault with the Obsidian Git plugin on the iPhone (§5.4, recorded as Sid's decision on 3 September [R]) should be re-confirmed with Sid, because the plugin's own author advises against mobile use [V S44]. Under CLAUDE.md, that attribution is evidence, not proof.

---

## 6. Roadmap impact and the Linux-server question

| Milestone | Moves to the cloud | Runs on a Windows PC when on | Needs an always-on host? |
|---|---|---|---|
| R2 memory | Everything: fact store, distillation, embeddings, retrieval, `/why`, `/forget`, backups | Optional encrypted backup copy; optional bulk re-embedding or imports | **No** |
| R3 Hermes and device agents | Task routing, decision queue, approvals, `/panic`, audit and cron (existing gateway). Cloud-only tasks could run in Cloudflare Sandbox or Containers, billed per use [V S23, S25, S27]; running Hermes there is untested [U] | Hermes itself (its README says it runs natively on Windows [V S69]) and the device agent for machine-bound work. A machine that is off means an honest wait, as the R3 exit test already says [R] | **No** |
| R5 Brightspace | Classroom API client (already cloud [R]); Brightspace via Cloudflare Browser Run with Live View human handoff for MFA [V S31, S32, S33]; a few runs a day fits the 10 included browser-hours [V S31] | Fallback scrape from a PC when on | **No**. Risk: the school sign-in may challenge or block cloud browsers [U] |
| R8 errands and browser automation | Browser Run for ordinary sites, with the tier-3 confirm and human handoff for payment or CAPTCHA [V S33]; Tesla API calls from the Worker [U] | Errands that need Sid's own logged-in browser profile; the local wake word | **No** |
| Backups | Time Travel and locked R2 exports [V S4, S35] | Copy outside Cloudflare | **No** |
| Others | R4 uptime watch as a cloud cron; R6, R7 and R9 are cloud work. R4's office-PC agent needs the St. Remy office machine the roadmap names, which CLAUDE.md's device table does not list; confirm it separately | R4 device agent | No |

**When would an always-on server be justified?** Only when a concrete workload meets all three:

1. It needs a long-running process or local state that Workers, Durable Objects, Workflows, Containers or Browser Run cannot host, such as a self-hosted graph database or a permanently logged-in browser profile.
2. It cannot tolerate "wait until a PC is on".
3. Its full cost (host, backups, monitoring, Sid's time) is written down and Sid approves it.

A site that blocks data-centre addresses would argue for a machine at home, not a VPS, and Sid
has no always-on home machine. If a long-running process is ever needed, try a small Cloudflare
Container first: memory and disk are billed on provisioned size and CPU on active use
[V S23, S25], which puts the smallest size at roughly $2 a month kept running [E], with no
operating system to maintain; long-running stability is untested [U]. Nothing in R2 to R9 meets
the three conditions today.

**Resolution to put to Sid (not done here):**

1. Record the requirement "Jarvis, including memory, works from the phone with every PC off" as Sid's. Record "Cloudflare-hosted" as the chosen implementation. Record that "one small Linux server" was a planning-session choice he did not make. DECISIONS.md currently lists the server under his 3 September decisions [R] and would need that correction.
2. Amend roadmap §1, the §4.5 home-node row, §5.1, §5.2, §5.4, R2 items 1, 2, 4, 5 and 6, R3 item 1, R5 item 2, R8 item 1 and the §8 costs.
3. Mark `docs/runbooks/home-node.md` and the Linux sections of `docs/runbooks/fact-projection.md` as historical. Keep the code; delete nothing.
4. Keep CLAUDE.md's hold on porting the node until Sid decides. Under this plan no port is needed: coordination moves to the cloud and the Windows agent becomes an optional helper.

---

## 7. Migration path

"Prod" means the step touches live D1, R2 or Vectorize or deploys production. Every Prod step
needs owner approval and max-effort review, a D1 Time Travel bookmark before any schema or data
change, and a written rollback. BUILDING.md already requires max review for migrations on live
data [R].

| # | Step | Prod | Rollback and notes |
|---|---|---|---|
| 0 | Sid chooses a direction; record it in DECISIONS.md, CLAUDE.md and the roadmap (documentation only) | No | Only after Sid's explicit decision |
| 1 | Port promotion rules, the deterministic first-person classifier and fact types to TypeScript, with test vectors shared with Python | No | Pure logic |
| 2 | Migration `0016_cloud_memory.sql`: new tables, triggers, FTS5 and cursor row; no backfill; trigger-mutation tests in local D1 | **Yes** | Owner applies; count triggers afterwards, as with 0014's 21-trigger check [R]; tables unused until step 3 |
| 3 | Distillation Workflow, `memory_runs`, monthly cost cap, behind a flag that defaults off | **Yes** (deploy) | Flag off writes nothing |
| 4 | Turn on "proposals only" for about a week: the digest shows proposals, answers do not use them | **Yes** (writes rows) | Flag off; rows are inert |
| 5 | `/remember`, `/why`, `/forget` (retract), confirm and reject buttons | **Yes** (deploy) | Redeploy previous version |
| 6 | Retriever reads active cloud facts and the profile card through FTS5 (the 0014 path stays, empty); measure Telegram and voice latency | **Yes** (deploy) | First "Jarvis remembers" from the phone |
| 7 | Create the Vectorize index and its metadata indexes before any insert [V S8]; embedding step; backfill vectors for existing active facts; hybrid retrieval behind a flag | **Yes** (new resource) | Flag off; index is derived data |
| 8 | Nightly consolidation: daily summaries, expiry, profile card | **Yes** (writes rows) | Flag off |
| 9 | Nightly export to a locked R2 bucket; monthly restore drill into a scratch D1 database | **Yes** (new bucket and lock) | While lock rules are active, locked objects cannot be deleted or overwritten and the bucket cannot be emptied until the rules are removed [V S35]; Sid picks the retention |
| 10 | New R2 exit test with every PC off: tell Jarvis something, wait one cycle, ask from the phone, `/why` shows the receipt, `/forget` hides it | **Yes** (Sid's live acceptance) | Replaces the Linux-based exit test [R roadmap R2] |
| 11 | Documentation: park `jarvis node`, the 0014 projection route and the home-node runbook; update KNOWN_ISSUES.md | No | No code deletion, no table drop |
| 12 | Optional PC helper: Windows Task Scheduler job that pulls the encrypted export | No production writes | Only if Sid wants a home copy |
| 13 | Optional later: Obsidian route A trial, then build | **Yes** (new secrets, container) | Sid chooses the route first |

Steps 1 to 10: about 4 to 6 builder sessions [E].

---

## 8. Open questions for Sid

1. **Where should Jarvis's memory live?** In Cloudflare, with no new computer, and your home PC keeping an extra backup copy when it's on.
   *Suggested default: yes, and drop the Linux server idea.*
2. **What should Jarvis save without asking?** Anything you say with "remember…", and clear statements about yourself in your own words. Anything Jarvis works out on its own waits for a tap in the morning message.
   *Suggested default: yes.*
3. **Do you want Obsidian?** (a) Not yet: see and fix memories in Telegram. (b) Later: Obsidian Sync at about $4 to $5 a month so notes appear on your phone. (c) A free but fiddlier setup that needs a $9.99 phone app.
   *Suggested default: (a) now, (b) later.*
4. **What should "forget that" do?** Hide it from Jarvis but keep the original message as proof, or also erase the original message (needs a confirm tap, and takes about five weeks to disappear from backups).
   *Suggested default: hide now; add erase later.*
5. **Which AI should read your chats to make memories, and what's the monthly limit?** DeepSeek's cheaper model (DeepSeek already reads your chats), or Cloudflare's own models (keeps everything with one company; quality not yet tested). The search index would be made inside Cloudflare either way.
   *Suggested default: DeepSeek's cheaper model, capped at $3 a month.*

---

## 9. Sources

All fetched 2026-09-14. V = verified from the page itself. U = unverified or secondary.

### Cloudflare

| # | Source | Status |
|---|---|---|
| S1 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | V |
| S2 | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) | V |
| S3 | [D1 SQL statements and extensions (FTS5)](https://developers.cloudflare.com/d1/sql-api/sql-statements/) | V |
| S4 | [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) | V |
| S5 | [D1 import and export (virtual tables not exportable)](https://developers.cloudflare.com/d1/best-practices/import-export-data/) | V |
| S6 | [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) | V |
| S7 | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) | V |
| S8 | [Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) | V |
| S9 | [Vectorize client API (async mutations, deleteByIds)](https://developers.cloudflare.com/vectorize/reference/client-api/) | V |
| S10 | [Workers AI pricing (neurons, free allocation, model prices)](https://developers.cloudflare.com/workers-ai/platform/pricing/) | V |
| S11 | [Workers AI text embedding models](https://developers.cloudflare.com/workers-ai/models/?tasks=Text+Embeddings) | V |
| S12 | [Workers AI bge-m3](https://developers.cloudflare.com/workers-ai/models/bge-m3/) | V |
| S13 | [Workers AI qwen3-embedding-0.6b](https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/) | V |
| S14 | [Workers AI bge-reranker-base](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/) | V |
| S15 | [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) | V |
| S16 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | V |
| S17 | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) | V |
| S18 | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) | V |
| S19 | [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) | V |
| S20 | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) | V |
| S21 | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) | V |
| S22 | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) | V |
| S23 | [Containers pricing](https://developers.cloudflare.com/containers/pricing/) | V |
| S24 | [Containers limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/) | V |
| S25 | [Containers CPU billed on active usage (changelog, 2025-11-21)](https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/) | V |
| S26 | [Containers FAQ: disk is ephemeral](https://developers.cloudflare.com/containers/faq/) | V, from an official-docs search excerpt; page not fetched in full |
| S27 | [Sandbox SDK](https://developers.cloudflare.com/sandbox/) | V |
| S28 | [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/) | V |
| S29 | [AI Search overview](https://developers.cloudflare.com/ai-search/) | V |
| S30 | [AI Search limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) | V |
| S31 | [Browser Run pricing](https://developers.cloudflare.com/browser-rendering/platform/pricing/) | V |
| S32 | [Browser Run limits](https://developers.cloudflare.com/browser-rendering/platform/limits/) | V |
| S33 | [Browser Run Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/) | V |
| S34 | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) | V |
| S35 | [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) | V |
| S36 | [Zero Trust free plan, 50 users (blog)](https://blog.cloudflare.com/teams-plans/) | U: search excerpt; the plans page did not show the number |

### Obsidian, git and GitHub

| # | Source | Status |
|---|---|---|
| S37 | [Obsidian pricing](https://obsidian.md/pricing) | V |
| S38 | [Obsidian Sync](https://obsidian.md/sync) | V |
| S39 | [Obsidian Sync plans](https://obsidian.md/help/sync/plans) | V |
| S40 | [Sync your notes across devices](https://obsidian.md/help/sync-notes) | V |
| S41 | [How Obsidian stores data](https://obsidian.md/help/data-storage) | V |
| S42 | [Obsidian Headless Sync (open beta)](https://obsidian.md/help/sync/headless) | V |
| S43 | [obsidian-headless README](https://github.com/obsidianmd/obsidian-headless) | V |
| S44 | [Obsidian Git plugin README](https://github.com/Vinzent03/obsidian-git) | V |
| S45 | [GitSync.md on the App Store](https://apps.apple.com/us/app/gitsync-md/id6758960270) | V |
| S46 | [GitHub REST: repository contents](https://docs.github.com/en/rest/repos/contents) | V |
| S47 | [GitHub REST: Git trees](https://docs.github.com/en/rest/git/trees) | V |
| S48 | [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | V |
| S49 | [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) | V |
| S50 | [GitHub pricing (unlimited private repos on Free)](https://github.com/pricing) | V |

### Memory services and research

| # | Source | Status |
|---|---|---|
| S51 | [Mem0 pricing](https://mem0.ai/pricing) | V |
| S52 | [Mem0 GitHub README](https://github.com/mem0ai/mem0) | V; benchmark figures are vendor claims |
| S53 | [Mem0 paper, arXiv 2504.19413](https://arxiv.org/abs/2504.19413) | V (abstract) |
| S54 | [Zep pricing](https://www.getzep.com/pricing) | V |
| S55 | [Zep paper, arXiv 2501.13956](https://arxiv.org/abs/2501.13956) | V (abstract) |
| S56 | [Graphiti README](https://github.com/getzep/graphiti) | V |
| S57 | [Letta pricing](https://docs.letta.com/letta-code/pricing) | V |
| S58 | [Letta self-hosting](https://docs.letta.com/guides/selfhosting) | V |
| S59 | [Supermemory pricing](https://supermemory.ai/pricing) | V |
| S60 | [LongMemEval, arXiv 2410.10813](https://arxiv.org/abs/2410.10813) | V (abstract) |
| S61 | [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) | V |
| S62 | [CoALA, arXiv 2309.02427](https://arxiv.org/html/2309.02427) | V |
| S63 | [Developers Digest 2026 memory provider comparison](https://www.developersdigest.tech/blog/best-ai-agent-memory-providers-2026) | U: secondary; background only |

### Models, hosting and Windows

| # | Source | Status |
|---|---|---|
| S64 | [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) | V; model names changed during 2026, so re-check before budgeting |
| S65 | [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) | V |
| S66 | [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | V |
| S67 | [DigitalOcean droplet pricing](https://www.digitalocean.com/pricing/droplets) | V |
| S68 | [Hetzner prices (third-party calculator)](https://costgoat.com/pricing/hetzner) | U: secondary; figures differ between sources |
| S69 | [Hermes Agent README](https://github.com/NousResearch/hermes-agent) | V; the project's own claims |
| S70 | [Task Scheduler StartWhenAvailable](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable) | V |
| S71 | [EmbeddingGemma-300m model card](https://huggingface.co/google/embeddinggemma-300m) | V; 768 dims, 2,048-token input; not chosen because of the shorter input |

### Repository files read (`origin/main` at `4833b74`)

`CLAUDE.md` (session instructions), `DECISIONS.md`, `KNOWN_ISSUES.md`, `NEXT_STEPS.md`,
`docs/HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/BUILDING.md`,
`docs/plan/2026-09-03-jarvis-roadmap.md`, `docs/plan/2026-08-jarvis-expansion-plan.md`,
`docs/runbooks/fact-projection.md`, `docs/runbooks/home-node.md`,
`docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`,
`docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md`,
`docs/superpowers/specs/2026-08-30-jarvis-hermes-runtime-design.md` (sections 1, 4, 7),
`docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md` (structure),
`apps/cloud-gateway/wrangler.toml`,
`apps/cloud-gateway/src/persistence/migrations/0001_foundation.sql`, `0005_conversation.sql`,
`0014_memory_projection.sql`, `apps/cloud-gateway/src/sync/memory-projection.ts`,
`apps/cloud-gateway/src/sync/memory-distill.ts`, `apps/cloud-gateway/src/http/sync-routes.ts`,
`apps/cloud-gateway/src/conversation/context-retriever.ts`,
`apps/cloud-gateway/src/archive/archive-repository.ts`, `tiered-event-reader.ts`,
`apps/cloud-gateway/src/providers/deepseek-provider.ts`, `scheduler/cron-router.ts`,
`packages/contracts/src/memory-projection.ts`,
`apps/local-agent/jarvis_local/{agent.py,node.py}`,
`apps/local-agent/jarvis_local/memory/{promotion,facts,distillation,embeddings,vector_index,retrieval,backup,projection_policy}.py`,
`apps/local-agent/jarvis_local/memory/migrations/0001` to `0005`,
`apps/local-agent/jarvis_local/sync/memory_projection.py`,
`apps/local-agent/jarvis_local/vault/{projection,retrieval}.py`.

### Not verified, or needing a trial before building on it

- Voice latency added by an embedding call and a Vectorize query per turn.
- Unattended sign-in for `obsidian-headless` in a container when two-factor sign-in is on, and the exact behaviour of its `merge` and `conflict` modes.
- Whether any official Obsidian Sync write path exists besides the headless client.
- Whether cloud Jarvis could write into iCloud Drive (I found no way).
- Whether a Cloudflare cloud browser can sign in to the school's Brightspace without being blocked.
- Distillation quality of Workers AI's small models.
- Running Hermes inside Cloudflare Sandbox or Containers.
- Tesla API calls from a Worker.
- Current Hetzner prices, and the Cloudflare Access 50-user free limit.
- Long-running stability of an always-on Cloudflare Container.
