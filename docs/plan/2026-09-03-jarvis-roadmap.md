# Jarvis roadmap and plan

Written 2026-09-03 against `main` at `aadd5b2`, then revised the same day
around Sid's decisions (section 5). This is a planning document. It changes
no code. Every statement about the code was checked against the pushed
repository, the CI history, and a local run of every suite on that commit;
where a document in this repository says otherwise, the code is what was
checked.

Read [README.md](../../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md) and
[KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) first. This file answers what they
do not: what Jarvis is meant to be, everything it is meant to do, what it
does today, the decisions Sid has made, and in what order to finish it.

---

## 1. What Jarvis is

Sid's private assistant, reachable from his iPhone whether or not any of his
computers is on. It lives in the cloud and reaches into his machines when he
asks.

- **In the cloud, always on:** a Cloudflare Worker that answers the phone and
  Telegram, runs the digest, the decision queue, the deadline store and the
  project poller; a second, deliberately isolated Worker that notices when
  the first goes quiet; and R2 memory services. D1 is the authoritative memory
  ledger and topic tree, with FTS5 and Vectorize as rebuildable indexes. No
  home node is involved.
- **On his machines, when they are on:** a thin device agent on the laptop,
  the home gaming PC and the St. Remy office PC that carries out commands on
  that machine: open and fix things, run reports, read logs, relay
  instructions to the Claude Code session that maintains the St. Remy apps.
- **On the iPhone:** Telegram, phone calls, a dashboard, Siri shortcuts and
  location. iOS cannot be remote-controlled, so the phone is a window into
  Jarvis rather than something Jarvis drives.

It keeps every accepted conversation with receipts, automatically distils and
files useful memory into a topic tree, and can search the complete live and R2
archive history for small details. A later optional one-way Obsidian-format
export may mirror that tree; Obsidian is not an R2 dependency.
It acts within tiers Sid set, and it never spends money, contacts another
person, deletes data, or touches production without a tap from Sid first.
**Version 1.0, the first release, is the day Sid can phone it from the car
with everything already built deployed.**

The [expansion plan](2026-08-jarvis-expansion-plan.md) remains the source
of truth for scope; section 5 records where Sid has extended it.

---

## 2. Three plans, one codebase

Jarvis has been planned three times by three builders, and each plan is
still in the repository as if it were current.

| Plan | Written by | Date | What it decides |
|---|---|---|---|
| [Expansion plan](2026-08-jarvis-expansion-plan.md) and [builder prompt](2026-08-jarvis-builder-prompt.md) | Opus 5, with Sid | Aug 2026 | **Product scope.** Everything in section 4 traces to it. Brain is Claude. The existing `jarvis` and `sid-assistant` code was to be imported first. |
| [Foundation design](../superpowers/specs/2026-08-29-jarvis-foundation-design.md), then the calling, Telegram/memory and voice-access plans | The first builder session | Aug 29 to 31 | **Cloud architecture and security.** Cloudflare Worker, D1 event log, R2 archive, Twilio ConversationRelay, device-signed sync, PIN gates, provenance rules. It changed the brain to DeepSeek without recording why and started from an empty repository instead of importing the legacy code. |
| [Hermes runtime design](../superpowers/specs/2026-08-30-jarvis-hermes-runtime-design.md) and [Obsidian memory design](../superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md), with their plans | Codex, unsupervised | Aug 30 to Sep 1 | **Two amendments.** Hermes as a zero-tool token sidecar behind a "Brain Bridge". Obsidian as a vault adapter guarded by a Rust extension and a privileged Windows service. |

The September 2 to 3 session then built most of the expansion plan's
cloud-side features on the foundation, added a pure-Python stage one of the
Obsidian adapter, and rewrote the entry-point docs.

**Which one wins.** The expansion plan decides *what* Jarvis does. The
foundation design decides *how the cloud is built* and stays. The Codex
amendments are the problem: approved on paper, mostly unbuilt, and each
turns a product feature into a security programme several times the size
of the feature. Section 6 says what to keep from them.

---

## 3. Where the project is today

### 3.1 Suites and CI

Every suite was run locally on `aadd5b2` for this document.

| Suite | Local result | CI on `main` |
|---|---|---|
| cloud-gateway, contracts, acceptance | 1,935 tests, 105 files, green | green |
| watchdog | 113 tests, green | green |
| local-agent on Windows | not runnable here | **red**: one named-pipe DACL test asserts the raw SID of the runner's user; the GitHub runner is the built-in Administrator, whose entry reads back as the `LA` alias |
| local-agent on Linux | ruff clean; pytest 500 green, 3 red, 10 skipped; mypy 25 errors in `dpapi.py`, `pipe_server.py`, `vault/setup.py` | **red**: the same Windows-only symbols |
| hermes-runtime on Windows | not runnable here | **red** since Sep 2: a containment test rejects the runner's temp path because it contains an 8.3 short name |

CI has been red on every push to `main` since September 2. None of the
failures is a product defect. All are tests that encode assumptions about
the machine they run on. Until they are fixed, a red check tells nobody
anything.

### 3.2 Capability by capability

Vocabulary: **live** means running in production today; **built** means code
and tests exist on `main` and it is not deployed; **unwired** means built and
nothing calls it; **partial** and **absent** mean what they say.

| Capability | Plan | State | The gap, precisely |
|---|---|---|---|
| Telegram text with memory of the conversation | §1, build 1 | **live**, on a Worker from before Sep 1 | Rate limiter and circuit breaker are per-isolate. |
| Slash commands, decision queue with buttons, tiered autonomy, shadow mode | §4, §6, §8 | **built** | Not deployed. Needs migrations 0008 to 0013, `OWNER_PRINCIPAL_ID`, rotated secrets. |
| Project manager: GitHub poller, stalled-project detector | §2, §5 | **built** | Not deployed. Optional `GITHUB_TOKEN` gates the job. |
| Daily digest, Sunday retro, exam quiet windows, cron routing | §3, §5 | **built** | Not deployed. Deadline half is empty until Classroom is wired. |
| Deadline store and Google Classroom client | §3 | **unwired** | Hourly job never calls ingestion; no OAuth credentials. UTC-versus-local due times unverified. Nothing closes a deadline. |
| Brightspace scrape | §3 | **absent** | Needs a real browser session. |
| Watchdog Worker | §6 | **built** | Not deployed. Needs its own bot. Nothing watches the watchdog. |
| Device-signed sync into an append-only archive | §7, §8 | **live** | 48 events replicated end to end on Sep 2, to the laptop. |
| Distillation of archive into fact proposals | §7 | **built**, routed on both sides | No process runs the cycle. `agent.py` and `RunLoop` exist; nothing constructs a replicator, a distiller, or the loop. No `jarvis service` command, no console-script entry. |
| Jarvis recalls distilled facts from the phone | §7 | **absent** | The cloud context retriever reads committed turns only. No fact projection to D1. Facts are promoted on the laptop and never leave it. |
| Personal profile: stated and observed facts, corrections with receipts | §7 | **partial** | Promotion rules and supersession exist locally. No profile shape, no observed-pattern miner, no "why do you think that", no way to confirm a proposed fact. |
| Semantic search over the archive | §7, §8 | **partial** | The embedder is a hashed lexical vector, "deliberately not a semantic model" by its own docstring. The vector index exists and retrieval never calls it. Full-text search works. |
| Obsidian vault: read, search, add notes | Codex amendment; §7 in spirit | **built**, stage one, laptop only | No redactor over observations. `project()` has no authority gate. Real vault not created. No sync to other devices. |
| Encrypted backup and restore | §6 | **built** | Never scheduled. |
| Live calling, inbound and outbound | §1, build 3 | **built and switched off** | About 4,200 source and 5,900 test lines, all green. The Worker mounts a fail-closed placeholder, so every voice request returns an error. No real call has ever been placed. Sid already owns the Twilio number and credentials. `wrangler.toml` still requires a retired secret and declares none of the real ones. |
| Health and readiness endpoint | foundation F8, F9 | **unwired** | Implemented and tested, never routed. |
| R2 archival of aged events | foundation F7 | **unwired** | No cron calls it. D1 grows without bound. |
| Second-device enrollment over HTTP | foundation F6 | **unwired** | The laptop was enrolled by hand. |
| Deployment scripts, runbooks, release audit | Telegram/memory plan T10 | **absent** | Every deploy so far was typed by hand. The last session could not authenticate wrangler. |
| Hermes Agent integration | Codex amendment | **absent in effect** | About 15,000 lines of locks, SBOM tooling and attestation tests verifying artifacts never fetched. The Brain Bridge service is 0 lines. The gateway adapter is dead code. Nothing has ever executed Hermes. |
| PC control, St. Remy help, send-on-command, voice notes, PWA, HUD, knock, inbox triage, briefs, grade watch, errands, Tesla, cost tracker | §1, §4, §5, §6, §9 and Sid's decisions | **absent** | Not started. |

### 3.3 Compromised or stale

- Three peppers, the DeepSeek key and the PIN verifier were pasted into a
  chat and must be rotated before anything else is deployed.
- The foundation spec still mandates an eight-digit owner PIN; the code uses
  the owner/guest four-digit peppered model. Both are in the tree.
- `hermes-profile-lock.json` carries a stale source-lock hash and its schema
  pins the same stale value, so the suite cannot notice.
- The voice-integration plan and the H0 evidence record cite six commit SHAs
  that no longer exist after the September 1 consolidation.
- The builder prompt forbids touching St. Remy systems. Sid has overruled
  that for on-command, permission-gated control (section 5.7); DECISIONS.md
  records it.

---

## 4. The feature catalogue

Everything Sid asked for across every plan and in the decisions of
September 3, plus the additions Sid accepted. Each row says where it came
from, its state, and the milestone in section 7 that delivers it.

### 4.1 Channels: how Sid reaches Jarvis

| Feature | Source | State | Milestone |
|---|---|---|---|
| Telegram text, two-way, with memory | plan §1 | live | R0 redeploy |
| Slash commands and inline decision buttons | plan §6 | built | R0 |
| Live inbound call with PIN step-up, multi-turn, interruptible | plan §1, foundation §5 | built, switched off | **R1, v1.0** |
| Live outbound call to Sid on `/call` | foundation §5.2 | built; no `/call` command | R1 |
| Guest callers with per-number capabilities and a guest PIN | voice-access design | built | R1 |
| Send on command: "email X and tell them Y", text from Jarvis's number, iMessage handoff for Sid's own number; from Telegram or a call; confirm before anyone else is contacted | Sid, Sep 3; plan §1 | absent | R6 |
| iOS Shortcuts and Siri: "Hey Siri, tell Jarvis..." | Sid, Sep 3 | absent | R6 |
| Location-aware reminders through Sid's one Jarvis-run personal calendar, covering school deadlines, St. Remy and personal plans | Sid, Sep 3 and 15 | absent; provider is unknown until R6 starts | R6 |
| "When should I leave": departure time from location and live traffic, with the Tesla used for alerts and preheating when its integration arrives | Sid, Sep 3 and 15 | absent | R6, R8 |
| PWA pocket dashboard: decisions, deadlines, projects, St. Remy status | plan §1 | absent | R9 |
| Telegram deep links into the PWA; Web Push as a secondary channel | plan §1 | absent | R9 |
| Voice notes over Telegram: hold to talk, transcribe, spoken reply | plan §1 | absent | R9 |
| On-demand HUD with a "today" view on the laptop and gaming PC | plan §6 | absent | R9 |
| Local voice with a `hey_jarvis` wake word on a PC, through Hermes voice mode | Hermes design §8.3 | absent | R8 |
| Desk-knock input | plan §6 | absent | R10 |
| Third-party calls with a one-time confirmation | foundation §5.2 | absent | R10 |
| Local CLI as a development and recovery surface | foundation §2 | partial | R2 |

### 4.2 Memory: what Jarvis knows

| Feature | Source | State | Milestone |
|---|---|---|---|
| Append-only raw record of every accepted conversation, live in D1 then archived in verified R2 segments | plan §7, §8; R2 requirement | live record exists; full-history recall does not | R2 adds complete recall |
| Distilled knowledge with provenance and state | plan §7; reviewer decision `951675e` | local implementation exists; D1 ledger design selected | **R2** |
| Promotion rules: only evidence-authorized items become facts; guesses stay uncertain | plan §8; Sid, Sep 14 | local rules exist, but ordinary chat publishes zero facts | **R2** closes the path |
| Memory available from the phone with every PC off | Sid, Sep 14; foundation §8.3 | absent | **R2** |
| "Why do you think that" with deterministic receipts; `/remember`, `/why`, `/forget` | plan §7; Sid, Sep 14 | absent | **R2** |
| Personal profile: stated versus observed, confidence through repetition, behaviour follows only eligible facts | plan §7 | absent | R2 foundation; R7 expansion |
| Optional per-item owner confirmation through the decision queue, never routine curation | addition | absent | **R2** |
| Full-history recall across live D1 and R2 archive segments, independent of distillation or filing | Sid, Sep 14 | absent | **R2** |
| Hybrid keyword and meaning search through rebuildable indexes | plan §8; research | local lexical vector prototype only | **R2** |
| Hierarchical topic tree with automatic filing and reversible rename, move and merge history | Sid, Sep 14 | absent | **R2** |
| Optional Obsidian-compatible view of the topic tree | Sid, Sep 14 | compatibility required; no view chosen | later, not R2 |
| Vault notes become proposals Sid can confirm into facts | Obsidian design §7.3 | absent | later, only if an editable view is chosen |
| Ingestion of emails, pages, documents; binaries by pointer with extracted text | plan §7; addition | absent | R7 |
| Custom nightly, hashed, restorable cloud-memory export; never production `wrangler d1 export` | research; fact-check | absent; row-level NDJSON to locked R2 selected | **R2** |
| Owner-triggered bounded reprocessing of older conversations with a configured model and its own one-time owner-approved cap | plan §7; Sid, Sep 14 | absent | **R2** |
| Data export as one encrypted bundle | addition | absent | R9 |

### 4.3 Managing: what Jarvis keeps track of

| Feature | Source | State | Milestone |
|---|---|---|---|
| Poll every tracked repo's four status documents; stalled-project detector | plan §2, §5 | built | R0 |
| Real-time ping when KNOWN_ISSUES or DECISIONS changes | plan §2 | absent | R7 |
| Google Classroom deadlines | plan §3 | unwired | R5 |
| Brightspace deadlines through a private calendar feed in Cloudflare first; school-approved OAuth as the grades/submissions upgrade; browser automation held for terms review, with MFA via Telegram if ever approved | plan §3; corrected Sep 15 | absent; board feed availability unverified | R5 |
| One deadline store, conflict flagging, effort-scaled reminders, exam quiet hours | plan §3, §5 | built, empty | R0, R5 |
| Per-course catch-up plan | Sid, Sep 15; [school plan](2026-09-15-school-university-plan.md) | started | **R5** |
| Proactive study coach: regular coursework check-ins, weak spots from memory, grades and deadlines, automatic quizzes, flashcards, spoken car quizzing and free-tool discovery | Sid, Sep 15 | started; first slice merged | **R5a** |
| Grade and missing-work watch | plan §5; Sid, Sep 15 | absent | R5 |
| University applications: programs, requirements, deadlines, writing, documents, scholarships and required marks | Sid, Sep 15; [school plan](2026-09-15-school-university-plan.md) | absent | **R5** |
| Morning digest and Sunday retro | plan §3, §5 | built | R0 |
| Workload-trend line; API and cost tracker, Jarvis first | plan §6, §8 | absent | R7 |
| Decision queue: one ranked list, always "other" and "explain more" | plan §6 | built | R0 |
| Taps route back to whatever was waiting, including a Claude Code session | plan §6 | partial | R3, R4 |
| Meeting and class prep briefs; inbox triage for Gmail | plan §5 | absent | R7 |
| St. Remy app uptime watch: ping every few minutes, alert, restart as a tier-2 action | Sid, Sep 3 | absent | **R4** |
| St. Remy error-log reading: severity-classified, text for urgent, phone call for severe | Sid, Sep 3 | absent | **R4** |
| Voice quick-capture to a repo's NEXT_STEPS | plan §5 | absent | R8 |

### 4.4 Acting: what Jarvis does on Sid's behalf

| Feature | Source | State | Milestone |
|---|---|---|---|
| Tiered autonomy: observe, reversible and logged, always confirmed | plan §4, §8 | built | R0 |
| Shadow mode before tier 2 | plan §8 | built | R3 |
| Retrieved content is data, never instructions | plan §8 | built | done |
| Hermes/task execution through a host and path Sid chooses when R3 starts | Hermes design; corrected Sep 14 | absent; host/path undecided | **R3** |
| Full control of the laptop and the gaming PC when they are on: apps, files, settings, diagnostics | Sid, Sep 3; plan §4 | absent | R3 |
| Full control of the St. Remy office PC and all St. Remy systems on command, with a permission tap for anything risky | Sid, Sep 3 | absent | **R4** |
| Claude Code bridge: Jarvis relays an instruction to the Claude Code session on the office PC that maintains the St. Remy apps, and reports back | Sid, Sep 3 | absent | R4 |
| Fix-it for Sid's parents: default apps, refresh problems, news apps, on Sid's command from anywhere | Sid, Sep 3 | absent | R4 |
| Queue-and-sync: a machine-bound request while that machine is off waits with an honest reply | plan, multi-device | absent | R3 |
| `/panic`: stop everything at once | addition | absent | R3 |
| Errands with the tier-3 confirm flow in a real browser; ticketing as monitor-and-assist | plan §9 | absent | R8 |
| Tesla: preheat at tier 2, unlock and start at tier 3, unasked preheat from calendar and weather | plan §9 | absent | R8 |
| Standing watches through Hermes cron and subagents; a repository-owned skills library | addition | absent | R8 |
| One Jarvis-managed personal calendar, with reversible tier-2 changes and protected focus blocks | plan §3, §4; Sid, Sep 15 | absent | R6 |
| Global kill switch | foundation §5.2 | built for calls | R3 extends |

### 4.5 Platform: what keeps it running

| Feature | Source | State | Milestone |
|---|---|---|---|
| Always-on Cloudflare gateway with D1 event log and R2 archive | plan, foundation | live | done |
| Linux home node | planning-session choice, not Sid's | historical; never provisioned or authorized | none |
| Thin device agents on laptop, gaming PC and office PC: outbound cloud connection, command execution, health; under 300 MB resident | plan §6; corrected Sep 14 | absent (the current local agent is the seed) | R3, R4 |
| Self-waking daily rhythm for the gaming PC: BIOS boot, work, sleep | plan, multi-device | absent | R8 |
| Standalone watchdog Worker; something watching the watchdog | plan §6; known issues | built; absent | R0 |
| Health and readiness endpoints; R2 archival with capacity alerts | foundation §8.3, §9 | unwired | R0 |
| Deploy, migrate, rollback and rotation scripts and runbooks | Telegram/memory plan T10 | absent | R0 |
| Second-device enrollment over HTTP | foundation §4.3 | unwired | R3 |
| Model switch: DeepSeek until the prepaid balance is spent, then Opus 5 or GPT-5.6 Terra for reasoning with GPT-5.6 Luna for cheap high-volume work, routed per task | Sid, Sep 3 | absent (base URL is hard-coded) | R7 |
| Release evidence: live call, Telegram round trip, backup drill | foundation §11.2 | partial | R1 |
| A CI whose red means something | this document | red | R0 |
| Hermes pinned to an exact upstream version, never self-updating | Hermes design §6 | built (locks, fetch script) | kept, R3 |
| Third-party data minimisation policy | addition | absent | R7 |

### 4.6 Rules every milestone inherits

- Credentials never in source, commits, transcripts, logs, memory or the
  vault. Rotation goes straight into `wrangler secret put` or the enrolled
  device's reviewed secret store.
- Money, contacting anyone who is not Sid, deleting data, and touching
  production systems always need a tap, in every mode, whatever the model's
  confidence. This now includes St. Remy production.
- No tier-2 action before shadow mode has run on that device.
- Brightspace browser extraction is not authorized until the published D2L
  EULA and the board's licence/acceptable-use terms are cleared. If a login
  route is later approved, it runs only at a low rate, alerts rather than
  silently failing, and keeps a human in the loop for MFA through Telegram.
- Voice audio is never stored. PIN digits never reach a transcript, a model,
  a log or an event.
- Hermes holds its own model key and nothing else. Its built-in memory files
  are disabled or scratch, never a source of facts. Tier 3 is enforced by
  Jarvis, not by Hermes' approval mode.
- A release is never declared from unit tests alone.

### 4.7 Offered and not chosen

Proposed on September 3 and left out at Sid's choice. Cheap to add later;
each has a natural milestone in parentheses.

- Parents' helpline: a second phone identity with a limited fix-only
  capability set (R4).
- Office PC backups with a monthly verified restore (R4).
- Screen-aware help from a screenshot (R4).
- Morning briefing call (R6).
- Receipt and expense capture by photo (R7).
- End-of-day report across machines and projects (R7).

---

## 5. Direction recorded on September 3, corrected September 14

This planning session mixed Sid's requirements with implementation choices it
made for him. DECISIONS.md carries the corrected durable record. The phone-first
requirement remains Sid's; the Linux home node and git-backed Obsidian route do
not.

### 5.1 Phone first, PC optional

Jarvis must work from the iPhone with every computer off. Everything that
is not tied to a specific machine runs in the cloud. D1 is R2 memory's
authoritative ledger and topic tree; FTS5 and Vectorize are rebuildable search
indexes. The laptop, home gaming PC and any confirmed office PC run thin device
agents only when available.

### 5.2 Hermes is the hands when a device is available

Hermes remains a candidate tool-using component, not the always-on front door
and not the memory host. The Cloudflare gateway keeps answering phone and
Telegram. Sid chooses the R3 execution host and path when that milestone
starts. No R3 step depends on a Linux node, and this roadmap does not select a
Windows port or cloud executor. The Codex sidecar plan remains retired.

### 5.3 Models

R2's extraction model is a provider-qualified setting supporting DeepSeek,
Anthropic and OpenAI. Start with `deepseek:deepseek-v4-pro`; before finalizing
it, re-check the provider ids and compare the same sanitized sample
conversations with `deepseek:deepseek-v4.1-flash`. Sid selected quality, not a
model name, and a paid comparison requires his explicit OK. Normal DeepSeek
memory-model spend has a configurable hard monthly cap of USD 5.00 by default.
Before switching to Claude or GPT, show Sid the projected monthly cost and have
him set the new cap. The broader per-task reasoning and calling model route
remains R7.

### 5.4 Memory, topic organization and an optional Obsidian export

Memory works in the cloud with every PC off, keeps full conversation history
searchable, and organizes distilled items into a topic tree. D1 is
authoritative for the conversation ledger, versioned memory items, receipts
and topic tree. FTS5 and Vectorize are rebuildable indexes. Obsidian may later
receive a one-way Markdown export that mirrors the tree as folders and linked
notes; the export is never read back. No Obsidian client, sync route, editable
view or exporter is part of R2. Sid approved a future private-GitHub copy with
tested exclusion of sensitive categories; he did not approve repository
creation, credentials, a paid plan or a live push.

### 5.5 Calling is in the first release

Sid already owns the Twilio number and credentials. Version 1.0 is the
first deploy plus live calling.

### 5.6 Four devices

iPhone (window only), laptop, home gaming PC, St. Remy office PC. Full
control of each PC when it is on, on command, with a permission tap for
risky actions.

### 5.7 St. Remy, on command with permission

Full control of the office PC and all St. Remy systems on Sid's command,
with a tap for anything that touches production, money or other people.
This overrules the builder prompt's rule that St. Remy systems are off
limits. Concretely: relay instructions to the Claude Code session on the
office PC that maintains the apps; fix things for Sid's parents (default
apps, refresh problems, news apps) when Sid is not there; read the apps'
error logs and text Sid for urgent entries or call for severe ones; watch
the apps' uptime and restart them as a tier-2 action. The office PC is an
i5-14400 with 16 GB and hosts the St. Remy apps. Decide the R4 execution host
and path with Sid when that milestone starts; no home node, Windows port,
cloud executor or browser placement is selected here.

### 5.8 Send on command

"Hey Jarvis, email X and tell them Y" works from Telegram and from a call:
email through Gmail, texts from Jarvis's own number, an iMessage handoff for
Sid's own number. Anything to another person is read back and confirmed
before it goes.

### 5.9 Additions accepted

All of section 4's additions: fact confirmation, `/why`, `/forget`, the
daily ledger note, `/panic`, data export, the minimisation policy, standing
watches, the skills library, per-task model routing, document ingestion,
explicit device routing. Plus the St. Remy uptime watch, error-log alerts,
and "when should I leave".

---

## 6. What to stop carrying

Approved documents whose remaining work should not be executed as written.
Mark each superseded by this file rather than deleting it.

| Document | Remaining tasks | Disposition |
|---|---|---|
| Hermes H1 plan | Tasks 5 to 7 (ledger, Runs client, bridge service), 10 to 13 (Windows services, gateway join, certification) | Superseded by R3. Keep tasks 0 to 3 (locks, fetch script, profile) as the pinning mechanism. |
| Obsidian implementation plan | O5 (Rust kernel, privileged broker), O7 (USN reconciliation), O11 (VSS backup), the cloud-ingest half of O2 to O4 | Historical implementation based on an unconfirmed editable-notes premise. Keep the code, but build no Obsidian path in R2. Only compatibility with a later one-way export remains current. |
| Telegram/memory plan | T9 named-pipe service on the laptop as the memory host; T10 deployment scripts | The device-hosted memory service is historical. R2 is cloud-available; T10 remains the R0 scripts/runbook scope. |
| Calling and voice-access plans | C8 limits tests, 8B fake acceptance, C9 live evidence | R1, unchanged. |
| hermes-runtime review-round tests | `source-lock` and `workflow-containment-review5`, fifty minutes each | Out of pull-request CI into a manual workflow. |
| Foundation spec §5.1 eight-digit PIN, the two PIN-verifier scripts, the legacy verifier module | | Delete in R1; the owner/guest design is current. |
| Builder prompt: "never touch St. Remy" | | Overruled by decision 5.7 for on-command, permission-gated control. Reading St. Remy data is still gated by that decision, not open-ended. |

---

## 7. Milestones, in dependency order

Each has an exit test a person can perform. Effort is a rough
builder-session estimate. [BUILDING.md](../BUILDING.md) records the review and
stop rules; the current builder-model note is in `NEXT_STEPS.md`.

### R0. Green and deployed

Nothing new. Make what exists true in production. About two sessions.

1. Fix the three CI failures so red means something; move the two
   fifty-minute Hermes tests to a manual workflow.
2. Rotate the compromised secrets straight into `wrangler secret put`.
3. Make `wrangler.toml` honest: declare every secret `env.ts` reads, drop
   `PIN_VERIFIER_JSON`, delete the two scripts that generate it.
4. `scripts/deploy.ps1`, `scripts/deploy-watchdog.ps1`, and a runbook
   naming the secrets. Every deploy so far was typed by hand.
5. Apply migrations 0008 to 0013. Deploy the gateway. Deploy the watchdog
   with its own bot. Set `OWNER_PRINCIPAL_ID`, `DIGEST_TIMEZONE`,
   `TELEGRAM_BOT_USERNAME`.
6. Route the health handler. Point an uptime monitor at the watchdog. Give
   the watchdog a must-report list.
7. Add R2 archival to the hourly job.

**Exit.** CI green on `main`. `/status` and `/queue` answer in Telegram. A
cron fires and the watchdog records the heartbeat. The morning digest
arrives, saying "nothing due".

### R1. Phone Jarvis from the car: v1.0, the first release

One to two sessions. Depends on R0. The number and credentials exist.

1. Load the five Twilio secrets. Replace the fail-closed voice placeholder in
   the Worker with the real dependencies; the construction function exists.
2. Write the fake acceptance scenarios both calling plans require: inbound
   with two turns and an interruption, outbound answer and no-answer,
   oversize frame, model timeout, owner, guest, unknown caller, revoked
   grant. Add the Telegram `/call` command.
3. Add the decided owner passphrase before authority on every inbound and
   outbound owner call, with three tries and no persistent lockout. The
   reviewed design chooses three Worker-generated words, durable attempt
   ordinals, and a 60-second alarm-backed window. Keep the exact Passed-A
   waiver implemented but switched off. Then run the live smoke per the
   runbook and commit the redacted evidence.
4. Delete the legacy eight-digit PIN verifier; fix the foundation spec.

**Exit.** The foundation design's permanent gate, §5.3: a real inbound call
with two turns and an interruption, a real outbound call with answer and
no-answer paths, transcript recall afterwards, a rejected unknown caller, and
an owner call rejected after three wrong passphrases with no authority, model
request or personal-context read.
**This is v1.0.**

### R2. Cloud memory that works with every PC off, v1.1

Multiple small review-gated PRs. Depends on R0 and the recorded D1 decision.

1. Implement the reviewed D1-authoritative ledger, topic-tree and rebuildable
   search-index contract. Migration `0016` remains the reserved schema number;
   Sid applies it only after its separate PR passes Claude max review.
2. Run automatic extraction and consolidation in the cloud. The extraction
   model is provider-qualified and configurable across DeepSeek, Anthropic and
   OpenAI, starting at `deepseek:deepseek-v4-pro`. Before finalizing it, compare
   the same sanitized conversations with `deepseek:deepseek-v4.1-flash` and use
   whichever extracts memories best; re-check both API ids before the paid run.
   Paid evaluation needs Sid's explicit OK. The hard configurable USD 5.00
   monthly default is for DeepSeek; before a Claude or GPT switch, show Sid the
   projected monthly cost and have him set the new cap.
3. Preserve evidence and uncertainty: stated and confirmed items may inform
   behavior; guesses stay visibly uncertain and never become instructions or
   authorization. Add bounded owner-triggered reprocessing for older history
   with its own one-time owner-approved spend limit, separate from hourly work.
4. Add the hierarchical topic tree, automatic filing, reversible moves and
   merges, and subtree answers. Filing never controls whether raw history is
   findable.
5. Add hybrid keyword and meaning recall across facts, summaries and the full
   live-D1 plus archived-R2 conversation history. Voice meaning search has a
   hard 750 ms memory-retrieval timeout and recorded fallback that preserves
   the R1 latency gate; R2 logs coordination before touching `voice/**`.
6. Add `/remember`, deterministic `/why` receipts, and `/forget` hide semantics
   backed by the event-level suppression ledger across live and archived recall.
7. Add a custom hashed nightly export and restore drill appropriate to the
   chosen store. Never run `wrangler d1 export` against production because the
   existing database contains FTS5 virtual tables.
8. Keep the Linux node, 0014 device projection and existing home-node runbook as
   historical artifacts. Build no Obsidian export or view in R2.

**Exit.** With every PC off, normal conversation is automatically distilled
and recalled from the phone with a deterministic `/why` receipt. `/remember`
works immediately; a small detail sourced only from an archived R2 segment is
found by explicit full-history recall; a topic-area question walks descendants;
an ambiguous inference is labeled uncertain; and `/forget` hides the item from
all retrieval paths while accurately saying the source event remains retained.
The full live procedure is in the R2 memory design.

**Cross-milestone onboarding note.** After R1 calling and R2 memory, however
hosted, are both live, run Sid's first-call onboarding session while parked,
never while driving. A device-issued single-use challenge opens a setup-only
segment with no owner authority. Deterministic handlers generate the owner
phrase verifier and write guest PIN records; ordinary authority still requires
speaking the new phrase once. Only then may Jarvis interview Sid and write
owner-confirmed answers to memory. This parked interview must not drive R1 or
R2 implementation.

### R5. School and university, v1.2

This starts now alongside the active R1 and R2 work, ahead of R3 and R4. The
first catch-up and university slices use the live Telegram/gateway stack and
wait for neither R2 nor a platform connector. Deadline ingestion depends on
the deployed R0 gateway; weak-area provenance and conversational forget
controls integrate with R2 when it lands without gating the early work. The
complete scope and official-source rules are in the
[school and university plan](2026-09-15-school-university-plan.md).

1. On the live bot, gather courses, platform coverage and missed work through
   conversation, never a homework form. Keep one current catch-up plan and
   next action per course without waiting for R2 or OAuth.
2. On the live bot, gather a program shortlist and build the minimal university
   tracker from current official sources: requirements, dates and required
   marks, each verified or visibly unverified. This also does not wait for R2.
3. Poll Sid's private Brightspace iCal feed from Cloudflare if his board exposes
   it, with school-approved OAuth as the later grade/submission upgrade. Wire
   Classroom behind explicit configuration. Put deadlines, source health and
   "check D2L now" in the digest. Classroom timed fields are UTC; the current
   instant-only schema maps date-only items to local end-of-day and cannot
   preserve date-only semantics without a separately numbered migration.
4. The first study-coach slice is merged: it records evidence-backed weak
   areas, allows at most one quiet coursework check-in per day, generates cited
   quizzes and flashcards, and supports plain-speech correction and forgetting.
   The broader proactive coach follows this milestone.
5. Add submission/grade observations and explicitly derived missing-work
   alerts. Classroom has no authoritative `missing` state. Use Brightspace
   grade/feedback notifications or API data only through an approved route.
6. Expand the application track to OUAC, supplements, scholarships, essays and
   personal statements, references, transcripts, offers and controlled
   contact/submission steps. Never copy a prior-cycle date or call an unsourced
   date verified. Payments, transcript releases and contact always need a tap.
7. Feed verified commitments into the later personal calendar: R6 supplies
   one managed agenda, reversible writes, protected focus blocks and departure
   reminders. Do not create a second school calendar.

**Exit.** Conversation alone produces a current catch-up action for every
course and a sourced target-program tracker. The morning digest shows one
live-accepted deadline from Classroom and one from Brightspace at the correct
Toronto time, with failed/stale sources named. A grade/submission change drives
the missing-work and weak-area flow, and Jarvis creates a sourced quiz and
flashcard set. Application, supplementary and scholarship dates remain visibly
verified or unverified; required-mark calculations use verified prerequisites.
Nothing is submitted, purchased, signed up for or sent to another person
without Sid's tap.

### R5a. Proactive study coach

Started: the first slice is merged. The complete coach depends on R2 memory
and R5 grades and deadlines.

1. Check in regularly about coursework and use R2 memory plus R5 grade,
   deadline and weak-area evidence to learn where Sid struggles.
2. Automatically make useful study material without waiting to be asked:
   cited quizzes, flashcards and spoken quizzing in the car once calls are live.
3. Find free tools that fit the current weak spot without waiting to be asked.
   Spending, account sign-ups and contacting another person always require
   Sid's explicit tap.

**Exit.** A recorded weak spot and approaching course deadline cause a regular
check-in with an appropriate quiz, flashcard set or spoken quiz and a relevant
free tool. Nothing is purchased, signed up for or sent to another person
without Sid's tap.

### R3. Hands: task execution and device capabilities, v1.3

Three sessions. Depends on R2.

1. Decide the execution host and path with Sid when R3 starts. Preserve the
   existing Hermes source lock and fetch script, but this roadmap authorizes no
   Linux node, Windows port, Hermes installation or cloud executor in advance.
2. On the selected path, implement a reviewed task/runtime contract: create a
   run, follow the event stream, stop, answer an approval, and archive every
   redacted event.
3. Provide machine-bound capabilities through the device path Sid selects:
   PowerShell, app launch and close, file operations, settings, screenshots on
   request, explicit device routing and health reporting.
4. Route a Telegram task through the decision queue to the selected execution
   path and post the result. A required machine that is off means an honest
   wait.
5. Tier 3 through the decision queue: Hermes's approval request becomes a
   Telegram button; the tap is the approval. `/panic` stops every run, every
   tier-2 action, and every pending outbound call, and says what it stopped.
6. Shadow mode for one to two weeks per device before tier 2 turns on.

The historical Linux node and `docs/runbooks/home-node.md` are not an R3
dependency or deployment option. They remain in the repository for provenance
only; the replacement execution path is intentionally undecided.

**Exit.** From Telegram, with the laptop on: "open the jarvis repo and tell
me what NEXT_STEPS says". It runs on the laptop and answers on the phone.
"Delete the temp folder": a button first, nothing happens until tapped.
Laptop off: the same command waits and Telegram says so.

### R4. St. Remy, v1.4

Two to three sessions. Depends on R3.

The execution host and path are decided with Sid when R4 starts. These are
capability outcomes, not approval for a Windows service, cloud executor or
particular browser/Claude runtime.

1. Provide controlled access to the office PC when machine-bound work is
   needed, within the agreed resource bound and only while that path is
   available.
2. Add a "tell Claude" command for the St. Remy repository that captures the
   result and reports back; any deploy or production change stays behind a
   tier-3 tap.
3. Fix-it skills: default app associations, restarting an app or service,
   the news-app and refresh problems Sid's parents hit, diagnostics that
   read back what is wrong before changing it.
4. Error-log reader: the St. Remy apps' logs read through the chosen path,
   classified by severity, urgent entries texted, severe ones phoned.
5. Uptime watch: the chosen reviewed path pings the apps every few minutes,
   alerts on failure, restarts as a tier-2 action after shadow mode, and records
   every restart.
6. DECISIONS.md: the on-command, permission-gated St. Remy rule.

**Exit.** From Telegram, away from the office: "the PDFs open in Claude
again, fix the default". Jarvis fixes it and says what it did. An app is
stopped by hand; Jarvis alerts within minutes and restarts it. "Tell Claude
to change the invoice footer": Claude Code makes the change, Jarvis asks
before deploying, and deploys after the tap.

### R6. Reach: personal calendar, send on command, Siri, location, v1.5

Depends on R3; the calendar's school and St. Remy coverage also depends on R5
and R4.

1. Send on command: Gmail API for email, the Twilio number for texts, an
   iMessage handoff link for Sid's own number. Read-back and a confirm before
   anything goes to another person, on Telegram and on a call.
2. An iOS Shortcut that posts to Jarvis, so Siri can relay a message, and a
   location Shortcut Sid can trigger.
3. Run one personal calendar for school deadlines, St. Remy and personal
   plans, with reversible tier-2 changes and protected focus blocks. Whether
   Sid's calendar is iCloud or Google is unknown; ask when R6 starts and do not
   assume.
4. Upgrade "when should I leave" from a standalone reminder into that calendar.
   For an item with a place, combine location and live traffic for the leave-now
   alert, and use the Tesla for the alert and aligned preheat when its R8
   integration arrives.

**Exit.** From the car, on a call: "email the supplier and tell them the
order is confirmed". Jarvis reads the draft back, sends after "yes". A
meeting across town at 3: Jarvis says "leave by 2:20" at 2:05. The same
managed agenda shows the school, St. Remy and personal commitments that drove
the alert.

### R7. A real assistant's memory and manager, v1.6

Three to four sessions. Depends on R2, R5.

1. The personal profile as a shape; a nightly job proposing observed
   patterns; optional per-item confirmation through the decision queue when
   Sid asks or authority requires it, never routine taps; `/why`; `/forget`.
2. Profile-driven behaviour: digest time, quiet hours, style.
3. The model switch: base URL configurable, per-task routing, Luna for the
   cheap tier, Opus 5 or GPT-5.6 Terra for reasoning, a local model as an
   outage fallback.
4. Prep briefs. Gmail triage. Workload line. Cost tracker, Jarvis first.
   Real-time pings on KNOWN_ISSUES and DECISIONS changes.
5. Document ingestion: Gmail, Drive, PDFs. The minimisation policy.

**Exit.** "Why do you think I hate mornings?" gets an answer with a dated
source. A brief arrives before a class. The Sunday retro has a workload
line and a cost line.

### R8. Hands, extended, v1.7

Three sessions. Depends on R3, R5, R6.

1. Decide the errands browser host/path with Sid when R8 starts; preserve the
   tier-3 confirm flow and ticketing as monitor-and-assist.
2. Tesla Fleet API: preheat at tier 2, unlock and start at tier 3, unasked
   preheat from calendar, weather and "when should I leave".
3. Standing watches through the reviewed execution path chosen at milestone
   start; the repository-owned skills library.
4. Local voice with `hey_jarvis` on the laptop; voice quick-capture to a
   repo's NEXT_STEPS.
5. The gaming PC's self-waking rhythm: BIOS boot, work, sleep.

**Exit.** "Dinner Monday somewhere that fits my schedule" produces a
confirmation with a restaurant, time and table, and a booking after the tap.
The car is warm before the departure time Jarvis computed.

### R9. Windows into Jarvis, v1.8

Two to three sessions. Depends on R1, R2.

1. The PWA dashboard on the existing D1 state, Telegram deep links, optional
   Web Push.
2. Voice notes over Telegram with transcription and a spoken reply.
3. The on-demand HUD on the laptop and gaming PC. Data export.

**Exit.** A decision tapped on the PWA is the same decision the Telegram
button would have answered. A voice note gets a spoken reply.

### R10. Later, pulled by friction

Desk-knock input; Wake-on-LAN; third-party calls; the Obsidian native
bridge only if a real loss motivates it; the Hermes proposal protocol only if
the decision-queue path proves insufficient; the Telegram limiter and
breaker into a Durable Object; the 117 test type errors, then the test
typecheck as a gate; and the six offered-not-chosen items in 4.7.

---

## 8. Running costs

| Item | Cost | From |
|---|---|---|
| Twilio number and calls | about $1.15 a month plus per-minute usage | R1 |
| R2 extraction model | DeepSeek starts with a hard USD 5.00 monthly cap; a Claude or GPT switch shows Sid projected cost and requires his new cap | R2 |
| R2 D1 ledger, FTS5, Workflows, Workers AI embeddings and Vectorize | expected inside existing included amounts at the researched personal volume; measure and alert before limits | R2 |
| General model usage | DeepSeek prepaid, then a reviewed per-task route | R7 for the broader switch |
| Cloudflare Workers Paid | already active | now |
| Maps routing API | free tier covers personal use | R6 |
| Optional one-way Obsidian-format export | private GitHub copy approved for later, with tested sensitive-category exclusions; no R2 build, paid plan, repository creation, credentials or live push approved | later |

---

## 9. Keeping this file honest

This roadmap replaces the "Next" half of HANDOFF.md and the structure of
NEXT_STEPS.md. NEXT_STEPS.md stays as the short list of the current
milestone's open items. When a milestone's exit test passes, record the date
here and move NEXT_STEPS.md to the next one.

| Milestone | Delivers | Status | Date |
|---|---|---|---|
| R0 Green and deployed | | passed | 2026-09-11 |
| R1 Calling | v1.0, first release | active; draft PR #40 open | |
| R2 Cloud memory | v1.1 | active; 0016 schema merged, not applied | |
| R5 School and university | v1.2 | plan revision ready for re-review | |
| R5a Proactive study coach | | started; first slice merged | |
| R3 Hands | v1.3 | not started | |
| R4 St. Remy | v1.4 | not started | |
| R6 Reach and personal calendar | v1.5 | not started | |
| R7 Memory and manager | v1.6 | not started | |
| R8 Hands extended | v1.7 | not started | |
| R9 Windows into Jarvis | v1.8 | not started | |
| R10 Later | | | |
