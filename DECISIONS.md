# Decisions

- D1 is the authoritative operational store; bootstrap-token hashes are consumed atomically with initial principal and device creation.
- R2 is the archive store.
- Authentication state does not use eventually consistent KV.

## A spoken four-digit PIN gates sensitive actions, not the call (2026-09-17, owner decision)

Sid's recorded decision on 2026-09-17 replaces the three-word spoken passphrase
on every owner call:

- An ordinary owner call has no verification at all. He rings Jarvis and talks
  immediately.
- A spoken four-digit PIN is required only immediately before a sensitive
  action: spending money, sending anything as Sid (message, email, booking),
  deleting, changing security or autonomy settings, and reading out a memory
  marked sensitive (health, money, grades, friends and family).
- Spoken digits are the primary input and keypad DTMF is an equally valid
  alternative. Four digits are easier to recognise than three words, and he
  cannot touch the phone while driving.
- Recognition is forgiving: clear re-prompts, at least five attempts, a plain
  spoken explanation of what is being authorised, and no hang-up on failure.
  A failed attempt is far more likely to be a mis-hearing than an attack.

The same person's own assistant is the context, and the threat being mitigated
is caller-ID spoofing reaching his memory. His judgement, recorded, is that an
always-on gate costs more than it buys; a sensitive action with no proof of
identity is not acceptable either. The credential is therefore demanded at the
action, authorises that action alone through a short receipt window, and is
never a blanket upgrade of the call. The three-word phrase stays valid as an
alternative credential because he already holds it; it is not deleted.

**Correction.** The every-call passphrase was a previous chat's interpretation
of "okay add a phrase", not Sid's instruction. The 2026-09-14 owner-call
passphrase design under `docs/superpowers/specs/` and the answered-outbound
refusal decision below describe that superseded model. The refusal scenario
they added is replaced by the accepted, refused and keypad sensitive-action
scenarios, and outbound evidence now records the ordinary open-admission shape.

Sensitive is one list rather than two: a capability is sensitive because
`capability_tiers` says tier 3, which is the same row the Telegram side already
consults for "outward actions always ask". This decision does not itself apply
migration 0034, deploy, generate a PIN, or change any secret.

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
bypass the attended operator gates. Superseded on 2026-09-17: the every-call
passphrase is replaced by a four-digit PIN demanded only at a sensitive action.

## School and university are the next product priority (2026-09-15, owner decision)

Sid is in Grade 12 in Ontario, has two missed weeks to catch up, and expects to
begin university applications soon. R5 therefore starts now in parallel with
active R1 calling and R2 cloud-memory work, and is ordered ahead of R3 hands
and R4 St. Remy. Its early catch-up conversation and minimal university tracker
do not wait for R1, R2 or either school platform integration.
Its deadline-only name is superseded by the school and university milestone in
[`docs/plan/2026-09-15-school-university-plan.md`](docs/plan/2026-09-15-school-university-plan.md).

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

Superseded on 2026-09-17 by the owner decision above: the gate moved from
admission to the sensitive action, and an ordinary owner call now asks for
nothing at all. The three-word phrase stays valid as one of the two accepted
credentials at the action; the admission rule stated here no longer holds.

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
`docs/plan/2026-09-03-jarvis-roadmap.md`, section 5. The Linux home node and
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

