# Decisions

- D1 is the authoritative operational store; bootstrap-token hashes are consumed atomically with initial principal and device creation.
- R2 is the archive store.
- Authentication state does not use eventually consistent KV.

## Voice gets tools behind `ModelAdapter`, not by widening it (2026-09-20, builder decision — awaiting review)

**The problem.** Telegram and voice are two separately composed assistants. Voice
cannot call a tool at all, so none of Phase 5's `call_place`, `pin_verify`,
`guest_create` or `guest_revoke` can exist yet. Two seams were on the table:
widen `ModelAdapterStreamInput` to carry `tools`, or move the voice path onto
`ModelAgentProvider`.

**The decision: neither, as stated.** Keep `ModelAdapter` as the boundary every
channel's conversation path already speaks, and put the agent loop *behind* it
in a voice adapter, mirroring what Telegram already does. Extract the
channel-neutral parts of the loop so both channels share one brain.

**Why the third option is the existing shape, not a new one.** Telegram's owner
agent is *already* a `ModelAdapter`: at `ca88bf4`,
`OwnerTelegramAgentAdapter implements ModelAdapter`
(`src/channels/telegram/owner-telegram-agent.ts`), and its `stream` method calls
`ModelAgentProvider.completeAgent`, runs the tool call, and yields one
`ModelToken`. The tool-calling brain is already inside a `ModelAdapter`, so a
voice adapter that does the same is the same design applied once more — not a
new seam. Both channels then reach the loop through the same
`DefaultConversationService.handleTurn`
(`src/conversation/conversation-service.ts`), which is already shared: Telegram
composes it at `src/index.ts` and voice at
`src/voice/production-runtime.ts`.

**What is not shared, and it is worse than the adapter gap.** Sharing the loop
does *not* share the memory. Telegram composes `TelegramMemoryRetriever`
(`src/index.ts:233` at `0611803`) and voice composes `D1ContextRetriever`
(`src/voice/production-runtime.ts:110`), and those read **different tables**:
`memory_item_fts`/`memory_item_versions` against
`memory_fact_projection_fts`/`events`. The sharper form, because it is a type and
not a habit: `D1ContextRetriever implements ContextRetriever` **only**, while
`TelegramMemoryRetriever` also implements **`TelegramMemoryTargetFinder`**. Voice
therefore cannot name a specific memory to act on at all, which is why every
memory tool taking an `itemId` has nothing to resolve one from on that channel.
**An earlier version of this section said "both channels use
`D1ContextRetriever`" — that was wrong and it is corrected here.** The voice
adapter has to bring the finder with it, or the tools it enables will be
unusable.

**Why not widen `ModelAdapterStreamInput`.** Four measured obstacles, in
increasing order of cost:

1. The streaming interface is validated by an exact key set, not by a type:
   `INPUT_FIELDS` in `src/model/model-adapter.ts` enumerates all eleven legal
   fields and `exactDataRecord` rejects anything with a different key count.
   Adding `tools` is a change to two `snapshot*` functions, the deepseek
   provider, and every fixture that constructs this input.
2. `ModelStreamTextInput` has no field for a system prompt, and
   `buildMessages` in `src/providers/deepseek-provider.ts` hard-codes
   `SYSTEM_PROMPT`. The roadmap's core profile, current channel and voice
   speaking style all have to reach the model as system text. This is a
   separate gap from tools and it blocks the same Phase 5 items.
3. `ModelToken` is `{ index, text }` with no variant for a function call, so
   the stream cannot express one. It would need a new member, and the stream's
   strict ordering contract (`expectedIndex`, contiguous from zero) with it.
4. The cost that decides it: `DefaultConversationService.handleTurn` runs
   **exactly one model request and settles the turn once**. A tool turn is two
   requests with an execution between them, and voice has no text to speak
   after the first. `finish(finalText)` requires non-empty text and
   `createVoiceStreamDelivery` requires `pieces.join("") === finalText`
   (`src/conversation/conversation-types.ts`), so a turn that ends on a tool
   call has no legal way to finish either. Widening the interface does not
   avoid this; it moves it into a service whose whole settlement contract is
   built on one request per turn.

Because (4) is unavoidable either way, the only real choice is where the
multi-request loop lives. The adapter confines it to one place and leaves the
conversation service's invariant alone.

**What the follow-on work must do, and it is more than 200 lines.** Recorded
here so the next session does not rediscover it:

- Extract the channel-neutral core of `OwnerTelegramAgentAdapter`: the
  `completeAgent` call shape, tool execution, the tool-allowance cap, and the
  `claimedActions`/receipt guard. `executeCall` (`owner-telegram-agent.ts`)
  currently refuses unless `input.channel === "telegram"`; that is the
  provenance and enforcement boundary (roadmap: "Enforce its own decision
  against a later prompt"), and voice needs its own — the owner authority on
  the session — rather than a widened Telegram check.
- Tool **definitions** must not live in either adapter. `memory-tools.ts` is
  already channel-neutral and both channels can import it; the voice-only
  definitions (`call_place`, `pin_verify`, `guest_create`, `guest_revoke`)
  belong beside it. Only dispatch is per-channel.
- Voice step-up is already implemented in the core as a synchronous
  interaction (`CallSessionCore` prompts, verifies, and holds authority before
  any conversation turn). Phase 5 asks for `pin_verify(pin)` as a *tool*, which
  is the model deciding to ask. Those are two mechanisms for one gate, and
  real-time voice makes a mid-turn multi-round tool loop expensive: the relay's
  strict token stream has nothing to say while the call waits. The likely
  resolution is session-scoped — the model requests the step-up, the turn
  ends, the existing core path prompts and verifies, and the next turn carries
  the authority — but that is a design to argue, not a decision taken here.

**Scope note.** This session did not build the adapter. `DECISIONS.md` records a
decision; the extraction is the next session's first commit, and it is larger
than the 200-line bound in `BUILDING.md` before it is reviewable.

**Built on branch `goal/item4-5-voice`, and the two open questions answered.**
`OwnerAgentCore` (`src/agent/owner-agent-core.ts`) is the extracted core and
`OwnerVoiceAgentAdapter` (`src/voice/voice-agent.ts`) is the voice adapter. The
channel-specific parts are a port — authority, reply composition, prompt
addition, tool catalogue, and the two channel-owned pieces of evidence (the
durable owner turn and the previous assistant text) — so the two composition
sites remain and the *loop* does not.

The two answers worth recording, because each was an argument above:

1. **`executeCall`'s `channel === "telegram"` refusal did not become a flag.**
   A call's authority is that the turn's principal is the configured owner, on a
   session that required the owner passphrase before the turn existed. Both
   checks live in the channel's own adapter; the core only asks whether it may
   act.
2. **A tier-3 capability on a call is raised and spoken, not tapped.** The
   question is raised durably in the existing decision queue and the reply says
   the tap has to be given in Telegram, because a call has no keyboard. This is
   not a new gate: `D1ToolConfirmationStore.consumeStandingDecision` claims a tap
   by capability and argument fingerprint with no channel in the query, so one
   tap authorizes the same call on either door. The `pin_verify(pin)` question
   above — mid-turn multi-round step-up over a relay — is still open and was not
   decided here.

## Applied migration text was rewritten for fresh-database replay (2026-09-16, reviewer decision)

Production applied migrations `0001`, `0002` and `0006` with trigger guards in
the earlier `SELECT CASE WHEN ... THEN RAISE(...) END` form. Remote D1 rejects
that statement form, so the recorded migration sources now use the semantically
identical `SELECT RAISE(...) WHERE ...` form already proven by migrations `0014`
and `0015`. Production was not re-migrated; this source-only rewrite exists so a
fresh database can replay every migration and rebuild the schema from scratch.

The reviewer took this decision rather than the owner because preserving the
earlier applied-migration text would leave the database permanently impossible
to rebuild, while D1 records applied migration names rather than their source
contents and the rewritten guards preserve the same predicates and errors.

## Answered outbound calls require refusal evidence (2026-09-16, owner decision)

Sid approved adding `outbound-step-up-refused` as the seventh retained R1 live
voice scenario and accepted the additional paid outbound call, estimated at
roughly one cent. The scenario must prove that an answered call whose listener
does not say the owner passphrase ends without owner authority, an authenticated
turn, a model request, a personal-context read, purpose disclosure or a private
message. Its outcome is `refused` because step-up started and failed;
`not_started` remains exclusive to an outbound call that nobody answered.

This expands the reviewed evidence contract. It does not itself authorize a
call, open inbound calling, enable outbound controls, deploy, change secrets or
bypass the attended operator gates.

## School and university are the next product priority (2026-09-15, owner decision)

Sid is in Grade 12 in Ontario, has two missed weeks to catch up, and expects to
begin university applications soon. R5 therefore starts now in parallel with
active R1 calling and R2 cloud-memory work, and is ordered ahead of R3 hands
and R4 St. Remy. Its early catch-up conversation and minimal university tracker
do not wait for R1, R2 or either school platform integration.
Its deadline-only name is superseded by the school and university milestone in
`docs/plan/2026-09-19-jarvis-roadmap.md`, Phase 3.

Jarvis gathers Sid's courses, school context and target programs through
conversation, not homework forms. It provides a per-course catch-up plan,
Classroom and Brightspace deadlines, grades and missing-work watch, proactive
study coaching, quizzes and flashcards, and a complete university-application
track. Exact application dates and requirements stay unverified until read
from a current official source. Spending, sign-up, submission, transcript
release and contact with another person always require Sid's tap.

The Brightspace route starts with Sid's private calendar-subscription feed in
the always-on Cloudflare gateway, if his board exposes it; Sid taps to place the
feed URL directly in secrets. A school-approved, least-privilege OAuth API is
the later upgrade for grades and submissions. Browser automation is held until
the board/EULA terms question is cleared; a Windows browser also waits for R3,
and Cloudflare Browser Run additionally needs security review and a cost tap.

## R2 cloud memory direction and corrected attribution (2026-09-14, delegated design decision)

Sid's requirement is the outcome: Jarvis keeps every accepted conversation,
automatically remembers what matters, can recall even small unimportant details
by searching full history including R2 archives, and labels guesses as uncertain
rather than presenting them as facts or instructions. Memory must work from the
phone with every PC off.

The small Linux home node recorded below and in the 3 September roadmap was a
planning-session implementation choice that Sid never made. He owns no Linux
host and did not authorize one. The home-node plan and runbook are historical;
keep their code and documentation for provenance, but do not provision, port,
deploy or make R2/R3 depend on that node.

Sid asked for the best cloud memory and delegated the design. The reviewer
recorded the decision at `951675e`: **D1 is authoritative** for the conversation
ledger, versioned memory items, receipts and topic tree. D1 FTS5 and Vectorize
are rebuildable search indexes; Workers AI `bge-m3` supplies embeddings. Live
D1 events plus verified R2 archive segments remain the complete conversation
record.

Memory is automatic and does not assign Sid a curation job. Every accepted,
redacted conversation remains searchable regardless of importance, including
after it moves into an R2 archive segment. Distillation and filing happen on
their own; Sid uses ordinary authenticated speech or text when he wants Jarvis
to remember something immediately, explain its evidence, hide it or use it
again. Slash commands may exist only as hidden fallbacks and are not taught,
listed in help or required by acceptance. On calls, those intents cannot act or
reveal memory until the owner step-up has passed.

Backup verification is automatic too. Sid performs one reviewed setup of a
non-production scratch target. Scheduled restore drills then run without a
monthly owner task, record successful receipts quietly, and alert Sid only on
failure or required repair. A production restore remains a separate destructive
owner operation.

Obsidian is not the memory store and is not built in R2. The ledger and topic
tree stay compatible with a later optional **one-way** Obsidian-format Markdown
export: folders mirror areas, stable block ids identify memory lines, and
guesses have a separate section. An export is never read back into memory or
prompts. Sid later approved a private GitHub repository as the destination for
that future copy, excluding health, money, passwords and credentials, and other
people's personal details through tested category rules. That approval does not
authorize building the exporter in R2, creating the repository, installing an
app, supplying a token, buying a plan or making a live push; Sid performs the
single-repository access step only after the exporter is separately reviewed.

The 2026-08-30 Obsidian spec and its rejection of a read-only export assumed
Sid wanted a notes interface he could edit. That premise was never confirmed
with him. The 3 September git-backed editable-vault entry below repeated the
same unconfirmed attribution. Both are **superseded as product decisions** by
the D1-authoritative design; retain their documents and code only as historical
work. Do not describe either choice as Sid's decision.

D1 must support the topic tree Sid requested: areas, sub-areas and deeper
levels; automatic filing; reversible rename, move and merge history; subtree
answers; and full-history search independent of filing. Migrations `0016` and
`0019` are merged on main but remain unapplied. This documentation decision
creates and reserves no migration; any later schema slice checks every open PR
branch and its `docs/AGENT_LOG.md` before choosing a number.
The extraction setting is provider-qualified and supports reviewed DeepSeek,
Anthropic Claude and OpenAI GPT adapters. It starts with
`deepseek:deepseek-v4-pro`. Before finalizing it, compare the same sanitized
conversations with `deepseek:deepseek-v4.1-flash`, re-checking both real API ids
immediately before the paid run; extraction quality decides, and that run needs
Sid's explicit OK. The price ledger is versioned per provider and exact model.
Normal DeepSeek memory-model spend has a configurable hard monthly cap of USD
5.00 by default. Jarvis warns Sid before prepaid DeepSeek credit is expected to
run out and records a visible backlog instead of failing quietly. Before a
Claude or GPT switch, Jarvis shows Sid the projected monthly cost and Sid sets
the new cap; no automatic failover changes a money limit. Reprocessing older
conversations is owner-triggered and bounded by its own separately approved
one-time spend limit so it cannot consume the hourly-memory budget.

## Owner calls require a spoken step-up (2026-09-14, owner decision)

Sid chose a spoken phrase at the start of every inbound and outbound owner
call, three tries before the call ends, no persistent lockout, and an exact
Passed-A waiver that is built but switched off. Jarvis must not mint owner
authority, read personal context, invoke a model, or accept an owner-only
command until the phrase has passed.

This reverses the 2026-08-30 design statement that “[t]he owner accepts Caller
ID possession risk for the PIN-free owner experience.” That statement was
recorded as an owner decision but was never confirmed with Sid. A valid Twilio
signature authenticates Twilio's delivery, not the person represented by the
`From` number, and outbound answer does not establish that Sid rather than
voicemail or another person is listening.

The reviewed design chooses three generated words from a versioned 2,048-word
list, yielding 33 bits, and requires attended real-call evidence before the
dormant waiver can be considered. Those are research-derived security choices,
not decisions attributed to Sid. The default and every missing or unknown
policy value require the phrase. Outbound calls always require it. Sid may
separately enable the waiver only after the evidence establishes the
attestation behavior and he accepts the residual SIM-swap and carrier
mis-attestation risk.

Only a salted, peppered verifier is stored. A device-signed CLI asks the Worker
to generate the phrase; the Worker stores the verifier and returns the words
once for terminal display. Jarvis keeps phrase candidates out of its
transcripts, model context, events, logs, call records, and Durable Object
storage. Twilio and the configured speech-to-text processor necessarily see
the spoken candidate before Jarvis receives it; the product must state that
limit rather than claim end-to-end secrecy.

## Capacity admission stops at the configured limit (2026-09-13, owner decision)

The owner does not enable provider auto-recharge. Voice calls and turns may
continue until a fresh capacity report reaches 100% of any configured D1, R2,
model or Twilio limit, or until a provider refuses the request. This is **stop
at the configured limit or provider refusal**, not a reserved-spend guarantee.
An admitted call can end mid-conversation when credit runs out. Actual usage
can exceed the last accepted report because interrupted and concurrent requests,
reporting delay and other consumers can still add charges.

Keep `CapacityEstimate` unchanged: prepaid providers use the configured
allocation as `budget` and allocation minus remaining credit as `used`;
postpaid providers use an owner-configured cap and provider-reported spending.
These are different observation types normalized for the same threshold test,
not a reconstructed charge ledger. Reject failed, incomplete, malformed or
stale observations. Monetary configuration has no source-code default.

Only voice calls and voice turns use this capacity gate. Telegram text and
`/sync/distill` do not. Every measured resource emits best-effort owner
Telegram warnings at 85% and 95% of its configured limit. Failed and leased
sends retry through the existing durable receipt path but never decide
admission. A resource that falls below a threshold rearms that crossing.
There is no 70% warning, separate $1 DeepSeek notice, reserve margin, provider
switch, top-up accounting or new metering product in R1. Existing
watchdog/Telegram delivery remains the alert channel.

## Historical migration numbering divergence (2026-09-02; superseded for R2)

`docs/superpowers/plans/2026-08-30-jarvis-obsidian-memory-implementation.md`
reserves migrations `0008`, `0009` and `0011` for vault state and `0010` for
baseline memory. Those numbers were taken first by the autonomy, decision
queue, project, deadline, liveness and scheduled-run schemas, which are built
and committed.

Renumbering the built migrations would rewrite files that already applied to
the test database and are referenced by name in the test migration list, to
free numbers nothing occupies. The vault migrations take `0014` onward
instead. Migration numbers carry no meaning beyond order, and the plan's file
table is the thing that is now out of date rather than the code.

This remains an explanation of existing files, not the current cloud-memory
plan. R2's new D1 ledger uses migration `0016`, now merged but unapplied.

## The Obsidian adapter shipped in two stages (2026-09-02; historical)

The plan's design is one capability -- a vault Jarvis can read, search and add
notes to, confined to its own root and never overwriting a file -- wrapped in
a second layer of Windows-specific hardening: a pinned Rust/PyO3 bridge for
NTFS object identity and namespace fences, USN journal replay, Cloud Files
reparse detection, and VSS-backed backup.

The hardening is not decoration. It is what makes "never replaced a file the
owner wrote" a property rather than a hope, and it is on the critical path for
the release audit. But it is also several times the work of the capability it
protects, and holding the capability back until it lands means the memory
system the rest of the plan depends on does not exist in the meantime.

So the adapter ships first in pure Python against the same contracts, with
write-once enforced by create-new file modes and the vault root checked before
every operation, and the native bridge replaces those checks afterwards
without changing the interface above them. Until it does, the adapter must not
be described as meeting the plan's write-once guarantee -- it meets a weaker
one, and the difference is recorded in KNOWN_ISSUES.md.

The 2026-09-14 D1 decision supersedes this as an R2 direction. Keep the adapter
and its tests for provenance; do not resume the native bridge or make local
vault state part of cloud memory.

## Planning-session record from 2026-09-03 (unconfirmed and superseded in part)

Recorded from a planning session; the reasoning is in
`docs/plan/2026-09-19-jarvis-roadmap.md`. The Linux home node and
git-backed editable Obsidian implementation in this historical list were
planning choices, not choices Sid made. The 2026-09-14 decision above
supersedes both.

- **Phone first, PC optional.** Jarvis must work from the iPhone with every
  computer off. Everything not tied to a machine runs in the cloud: the
  gateway and watchdog, plus one small always-on server (the home node) for
  Hermes and the memory work. The laptop, home gaming PC and St. Remy office
  PC run thin device agents and are optional.
- **Hermes is the hands, not a caged sidecar and not a replacement.** It runs
  on the home node with tools, browser, skills and cron; the Cloudflare
  gateway stays the front door; the Codex sidecar plan is retired.
- **Models.** DeepSeek until the prepaid balance is spent, then Opus 5 or
  GPT-5.6 Terra for reasoning with GPT-5.6 Luna for cheap high-volume work,
  routed per task.
- **Memory and Obsidian — unconfirmed, superseded.** This planning session
  recorded an editable git-backed vault without confirming that Sid wanted to
  edit notes. D1 is now the source of truth; only a later optional one-way
  export may mirror the topic tree, and it is not part of R2.
- **Calling is in the first release.** The Twilio number and credentials
  already exist.
- **St. Remy is no longer off limits.** Full control of the office PC and all
  St. Remy systems on Sid's command, with a tap for anything touching
  production, money or other people. This overrules the builder prompt's
  rule. The office PC runs only the thin device agent.
- **Send on command.** Email, texts from Jarvis's number, and an iMessage
  handoff, with read-back and a confirm before anyone else is contacted.

## 2026-09-11

- **The gateway heartbeat is deferred to the end of the project.** It has
  failed every cron since deployment with a 404 from the watchdog, and
  diagnosing it further was consuming more attention than it is worth. Sid's
  call, and the right one: the watchdog is inherited scope from an earlier
  plan rather than something he asked for, its own health is fine, and it has
  already proved it can reach his phone. **It is removed from R0's exit test**
  so it cannot block R1. Fix it once Jarvis is finished.

