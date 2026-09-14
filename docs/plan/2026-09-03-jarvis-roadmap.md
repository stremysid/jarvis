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
  the first goes quiet; and one small always-on server, the **home node**,
  that runs Hermes Agent (tools, browser, skills, scheduled work) and Jarvis's
  memory work (archive replication, distillation, search, the Obsidian vault).
- **On his machines, when they are on:** a thin device agent on the laptop,
  the home gaming PC and the St. Remy office PC that carries out commands on
  that machine: open and fix things, run reports, read logs, relay
  instructions to the Claude Code session that maintains the St. Remy apps.
- **On the iPhone:** Telegram, phone calls, a dashboard, Siri shortcuts and
  location. iOS cannot be remote-controlled, so the phone is a window into
  Jarvis rather than something Jarvis drives.

It remembers everything it is told and everything it reads, permanently and
with receipts, and shows that memory as notes in Obsidian on every device.
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
| Location-aware reminders via Telegram or a Shortcut | Sid, Sep 3 | absent | R6 |
| "When should I leave": departure time from live traffic, car preheated to match | Sid, Sep 3 | absent | R6 |
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
| Append-only raw archive of every message and everything read, deduplicated | plan §7, §8 | built and live for cloud events | R2 moves the replica to the home node |
| Distilled fact store Jarvis reasons from | plan §7 | built on the laptop | R2 runs it on the home node |
| Promotion rules: only Sid's words and Jarvis's observations become facts | plan §8 | built | done |
| Facts available from the phone with every PC off | Sid, Sep 3; foundation §8.3 | absent | **R2** |
| "Why do you think that" with receipts; `/why`, `/forget` | plan §7; addition | partial | R7 |
| Personal profile: stated versus observed, confidence through repetition, behaviour follows it | plan §7 | absent | R7 |
| Fact confirmation through the decision queue | addition | absent | R7 |
| Full-text search over the archive | plan §7 | built | done |
| Semantic search with a self-hosted embedding model on the home node, nothing sent to a third-party API | plan §8 | partial | R2 |
| Obsidian vault as the readable, editable window into memory | Obsidian design | built, stage one | R2 |
| Vault synced to iPhone, laptop, gaming PC and office PC through a git-backed vault; Jarvis commits from the home node, devices pull with the Obsidian Git plugin | Sid, Sep 3 | absent | R2 |
| Facts, daily ledgers and project pages projected into the vault as write-once notes | Obsidian design §7.1; addition | partial | R2 |
| Vault notes become proposals Sid can confirm into facts | Obsidian design §7.3 | absent | R7 |
| Ingestion of emails, pages, documents; binaries by pointer with extracted text | plan §7; addition | absent | R7 |
| Encrypted nightly backup of the home node's databases | plan §6 | built, unscheduled | R2 |
| Retroactive re-mining of the archive | plan §7 | possible, no command | R7 |
| Data export as one encrypted bundle | addition | absent | R9 |

### 4.3 Managing: what Jarvis keeps track of

| Feature | Source | State | Milestone |
|---|---|---|---|
| Poll every tracked repo's four status documents; stalled-project detector | plan §2, §5 | built | R0 |
| Real-time ping when KNOWN_ISSUES or DECISIONS changes | plan §2 | absent | R7 |
| Google Classroom deadlines | plan §3 | unwired | R5 |
| Brightspace deadlines by polite scrape in a browser on the home node, MFA via Telegram | plan §3 | absent | R5 |
| One deadline store, conflict flagging, effort-scaled reminders, exam quiet hours | plan §3, §5 | built, empty | R0, R5 |
| Grade and missing-work watch | plan §5 | absent | R5 |
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
| Hermes Agent on the home node: tools, skills, browser, terminal, subagents, cron | Sid's direction; Hermes design | absent | **R3** |
| Full control of the laptop and the gaming PC when they are on: apps, files, settings, diagnostics | Sid, Sep 3; plan §4 | absent | R3 |
| Full control of the St. Remy office PC and all St. Remy systems on command, with a permission tap for anything risky | Sid, Sep 3 | absent | **R4** |
| Claude Code bridge: Jarvis relays an instruction to the Claude Code session on the office PC that maintains the St. Remy apps, and reports back | Sid, Sep 3 | absent | R4 |
| Fix-it for Sid's parents: default apps, refresh problems, news apps, on Sid's command from anywhere | Sid, Sep 3 | absent | R4 |
| Queue-and-sync: a machine-bound request while that machine is off waits with an honest reply | plan, multi-device | absent | R3 |
| `/panic`: stop everything at once | addition | absent | R3 |
| Errands with the tier-3 confirm flow in a real browser; ticketing as monitor-and-assist | plan §9 | absent | R8 |
| Tesla: preheat at tier 2, unlock and start at tier 3, unasked preheat from calendar and weather | plan §9 | absent | R8 |
| Standing watches through Hermes cron and subagents; a repository-owned skills library | addition | absent | R8 |
| Calendar changes at tier 2, protected focus blocks | plan §3, §4 | absent | R7 |
| Global kill switch | foundation §5.2 | built for calls | R3 extends |

### 4.5 Platform: what keeps it running

| Feature | Source | State | Milestone |
|---|---|---|---|
| Always-on Cloudflare gateway with D1 event log and R2 archive | plan, foundation | live | done |
| The home node: one small Linux server running Hermes and the memory work, heartbeating to the watchdog | Sid, Sep 3 | absent | **R2** |
| Thin device agents on laptop, gaming PC and office PC: outbound connection to the home node, command execution, health; under 300 MB resident | plan §6; Sid, Sep 3 | absent (the current local agent is the seed) | R3, R4 |
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
  vault. Rotation straight into `wrangler secret put` or the home node's
  secret store.
- Money, contacting anyone who is not Sid, deleting data, and touching
  production systems always need a tap, in every mode, whatever the model's
  confidence. This now includes St. Remy production.
- No tier-2 action before shadow mode has run on that device.
- Brightspace scraping is polite: a few runs a day, alert rather than
  silently fail, a human in the loop for MFA.
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

## 5. Decisions Sid made on September 3

These override any earlier plan where they conflict. DECISIONS.md carries
the durable record.

### 5.1 Phone first, PC optional

Jarvis must work from the iPhone with every computer off. Everything that
is not tied to a specific machine runs in the cloud: the gateway and
watchdog as today, plus one small always-on server, the home node, for
Hermes and the memory work. Roughly $6 to $15 a month. The laptop, the home
gaming PC and the office PC run thin device agents and are optional.

### 5.2 Hermes is the hands, on the home node

Sid's instinct was Hermes as the base with Jarvis's features on top. The
cheaper path that delivers the same thing: Hermes runs on the home node as
the part of Jarvis that does work with tools, a browser, skills and
scheduled jobs; the Cloudflare gateway stays the always-on front door
because it already answers the phone and Telegram with audited memory; the
device agents are Hermes's reach into each machine. The Codex sidecar plan
is retired. Hermes never replaces Jarvis's Telegram.

### 5.3 Models

DeepSeek stays until the prepaid balance is spent. Then Opus 5 or GPT-5.6
Terra for reasoning and calls, with GPT-5.6 Luna for distillation, triage,
classification and quick turns, routed per task. GPT-5.6 Luna is OpenAI's
low-cost tier released July 9, 2026; the gateway's model client already
speaks its API format, and the switch needs the API base URL made
configurable plus a key.

### 5.4 Memory and Obsidian

Jarvis's own two-tier memory on the home node is the source of truth.
Obsidian is the window: facts, daily ledgers and project pages appear as
notes on every device, and notes Sid writes become sources. Sync is a
git-backed vault: Jarvis commits from the home node, devices pull with the
Obsidian Git plugin. Obsidian Sync would need a PC on for Jarvis's notes to
reach the phone, because only the Obsidian app can write through it. The
stage-one adapter is finished properly; the native bridge is deferred.

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
i5-14400 with 16 GB and hosts the St. Remy apps, so it runs only the thin
device agent; Hermes and the browser stay on the home node.

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
| Obsidian implementation plan | O5 (Rust kernel, privileged broker), O7 (USN reconciliation), O11 (VSS backup), the cloud-ingest half of O2 to O4 | Deferred indefinitely. O8 retrieval, O9 gate and projection, O10 setup and doctor are R2, on the home node. |
| Telegram/memory plan | T9 named-pipe service on the laptop as the memory host; T10 deployment scripts | The memory host is the home node (R2); the laptop keeps a device agent. T10 shrinks to the scripts and runbook in R0. |
| Calling and voice-access plans | C8 limits tests, 8B fake acceptance, C9 live evidence | R1, unchanged. |
| hermes-runtime review-round tests | `source-lock` and `workflow-containment-review5`, fifty minutes each | Out of pull-request CI into a manual workflow. |
| Foundation spec §5.1 eight-digit PIN, the two PIN-verifier scripts, the legacy verifier module | | Delete in R1; the owner/guest design is current. |
| Builder prompt: "never touch St. Remy" | | Overruled by decision 5.7 for on-command, permission-gated control. Reading St. Remy data is still gated by that decision, not open-ended. |

---

## 7. Milestones, in dependency order

Each has an exit test a person can perform. Effort is a rough
builder-session estimate. [BUILDING.md](../BUILDING.md) says which model
builds and reviews each one, and when a stuck session must stop and escalate
rather than grind.

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

### R2. The home node: memory that works with every PC off, v1.1

Two to three sessions. Depends on R0.

1. Provision a small Linux server. Tailscale or equivalent for a private
   network to the devices. Its own secret store.
2. Port the Python agent's memory half to Linux: DPAPI sealing becomes a
   file key under OS permissions, the named pipe becomes a Unix socket, the
   NTFS checks stay no-ops. A `jarvis node` command that opens the stores,
   constructs the replicator, the distillation client, the coordinator and
   the run loop, and runs under systemd.
3. Fact projection: a signed upload of active facts to D1, and the cloud
   context retriever reads facts alongside recent turns. This is what makes
   "Jarvis remembers" true from the phone.
4. Real semantic search on the node: `all-MiniLM-L6-v2` on ONNX Runtime
   through the existing compatibility gate, embeddings as SQLite blobs,
   in-process cosine, retrieval wired to the vector index.
5. The vault on the node: redactor over every observation, the authority
   gate in front of `project()`, facts and daily ledger notes projected as
   write-once files, a private git repo as the vault, commits from the node,
   the Obsidian Git plugin on the iPhone and each PC. `/vault` on Telegram.
6. Nightly encrypted backup of the node's databases; heartbeat to the
   watchdog; the node in the watchdog's must-report list.
**Exit.** Tell Jarvis something on Telegram with every PC off. Wait one
cycle. Ask about it from the phone; it answers from a fact. Open Obsidian on
the phone; the fact is there as a note with its source. Write a note on the
phone; `/vault` finds it within a cycle.

**Cross-milestone onboarding note.** After R1 calling and R2 memory, however
hosted, are both live, run Sid's first-call onboarding session while parked,
never while driving. A device-issued single-use challenge opens a setup-only
segment with no owner authority. Deterministic handlers generate the owner
phrase verifier and write guest PIN records; ordinary authority still requires
speaking the new phrase once. Only then may Jarvis interview Sid and write
owner-confirmed answers to memory. This parked interview must not drive R1 or
R2 implementation.

### R3. Hands: Hermes on the node, device agents on the PCs, v1.2

Three sessions. Depends on R2.

1. Pin and install Hermes on the node with the existing source lock and
   fetch script, in its own Python 3.11 environment; built-in memory and
   background review off; API server on loopback with a key only the node
   agent holds.
2. A Hermes client in the node agent: create a run, follow the event
   stream, stop, answer an approval. Every event into the archive, redacted.
3. The device agent: the current local agent cut down to what a machine
   needs, an outbound connection to the node, a command executor
   (PowerShell, app launch and close, file operations, settings, screenshots
   on request), health reporting. Starts at logon on the laptop and the
   gaming PC. Enrolled over HTTP as second and third devices with explicit
   routing, default the laptop.
4. The task path: a Telegram command becomes a decision-queue item; the node
   picks it up, runs it through Hermes with a toolset chosen by the autonomy
   tier, executes machine-bound steps through the device agent, and posts
   the result. A machine that is off means an honest wait.
5. Tier 3 through the decision queue: Hermes's approval request becomes a
   Telegram button; the tap is the approval. `/panic` stops every run, every
   tier-2 action, and every pending outbound call, and says what it stopped.
6. Shadow mode for one to two weeks per device before tier 2 turns on.

**Exit.** From Telegram, with the laptop on: "open the jarvis repo and tell
me what NEXT_STEPS says". It runs on the laptop and answers on the phone.
"Delete the temp folder": a button first, nothing happens until tapped.
Laptop off: the same command waits and Telegram says so.

### R4. St. Remy, v1.3

Two to three sessions. Depends on R3.

1. The device agent on the office PC as a Windows service, because nobody is
   logged in; under 300 MB resident; Hermes and the browser stay on the node.
2. The Claude Code bridge: a "tell Claude" command that runs a headless
   Claude Code turn in the St. Remy repository on the office PC with the
   instruction Sid gave, captures the result, and reports back; any deploy or
   production change behind a tier-3 tap. If Claude Code's remote sessions
   prove simpler, the bridge targets those instead; the command surface is
   the same either way.
3. Fix-it skills: default app associations, restarting an app or service,
   the news-app and refresh problems Sid's parents hit, diagnostics that
   read back what is wrong before changing it.
4. Error-log reader: the St. Remy apps' logs tailed by the device agent,
   classified by severity, urgent entries texted, severe ones phoned.
5. Uptime watch: the node pings the apps every few minutes, alerts on
   failure, restarts as a tier-2 action after shadow mode, and records every
   restart.
6. DECISIONS.md: the on-command, permission-gated St. Remy rule.

**Exit.** From Telegram, away from the office: "the PDFs open in Claude
again, fix the default". Jarvis fixes it and says what it did. An app is
stopped by hand; Jarvis alerts within minutes and restarts it. "Tell Claude
to change the invoice footer": Claude Code makes the change, Jarvis asks
before deploying, and deploys after the tap.

### R5. Deadlines, v1.4

Two sessions. Depends on R0 and R2.

1. Google Classroom OAuth; the hourly job calls ingestion. One real
   assignment settles UTC versus local; delete the setting.
2. Brightspace as a Hermes browser task on the node, a few runs a day, MFA
   routed to Telegram as a decision.
3. Deadline status setters and the decision-expiry sweep. Grade and
   missing-work watch.

**Exit.** The morning digest lists a real deadline from each source, at the
right local time.

### R6. Reach: send on command, Siri, location, v1.5

Two sessions. Depends on R3.

1. Send on command: Gmail API for email, the Twilio number for texts, an
   iMessage handoff link for Sid's own number. Read-back and a confirm before
   anything goes to another person, on Telegram and on a call.
2. An iOS Shortcut that posts to Jarvis, so Siri can relay a message, and a
   location Shortcut Sid can trigger.
3. "When should I leave": for calendar items with a place, departure time
   from a maps routing API, a reminder at the right moment, the car preheat
   aligned when Tesla arrives in R8.

**Exit.** From the car, on a call: "email the supplier and tell them the
order is confirmed". Jarvis reads the draft back, sends after "yes". A
meeting across town at 3: Jarvis says "leave by 2:20" at 2:05.

### R7. A real assistant's memory and manager, v1.6

Three to four sessions. Depends on R2, R5.

1. The personal profile as a shape; a nightly job proposing observed
   patterns; fact confirmation through the decision queue; `/why`; `/forget`.
2. Profile-driven behaviour: digest time, quiet hours, style.
3. The model switch: base URL configurable, per-task routing, Luna for the
   cheap tier, Opus 5 or GPT-5.6 Terra for reasoning, a local model as an
   outage fallback.
4. Prep briefs. Gmail triage. Workload line. Cost tracker, Jarvis first.
   Real-time pings on KNOWN_ISSUES and DECISIONS changes.
5. Document ingestion: Gmail, Drive, PDFs. Calendar writes at tier 2 with
   focus blocks. The minimisation policy.

**Exit.** "Why do you think I hate mornings?" gets an answer with a dated
source. A brief arrives before a class. The Sunday retro has a workload
line and a cost line.

### R8. Hands, extended, v1.7

Three sessions. Depends on R3, R5, R6.

1. Errands with the tier-3 confirm flow in a real browser on the node;
   ticketing as monitor-and-assist.
2. Tesla Fleet API: preheat at tier 2, unlock and start at tier 3, unasked
   preheat from calendar, weather and "when should I leave".
3. Standing watches through Hermes cron and subagents; the
   repository-owned skills library.
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
| Home node server | about $6 to $15 a month | R2 |
| Twilio number and calls | about $1.15 a month plus per-minute usage | R1 |
| Model usage | DeepSeek prepaid, then Luna plus a strong model, metered | R7 for the switch |
| Cloudflare Workers Paid | already active | now |
| Obsidian Git plugin | free | R2 |
| Maps routing API | free tier covers personal use | R6 |
| Obsidian Sync | not needed; optional $4 to $5 a month | never required |

---

## 9. Keeping this file honest

This roadmap replaces the "Next" half of HANDOFF.md and the structure of
NEXT_STEPS.md. NEXT_STEPS.md stays as the short list of the current
milestone's open items. When a milestone's exit test passes, record the date
here and move NEXT_STEPS.md to the next one.

| Milestone | Delivers | Status | Date |
|---|---|---|---|
| R0 Green and deployed | | not started | |
| R1 Calling | v1.0, first release | not started | |
| R2 Home node and memory | v1.1 | not started | |
| R3 Hands | v1.2 | not started | |
| R4 St. Remy | v1.3 | not started | |
| R5 Deadlines | v1.4 | not started | |
| R6 Reach | v1.5 | not started | |
| R7 Memory and manager | v1.6 | not started | |
| R8 Hands extended | v1.7 | not started | |
| R9 Windows into Jarvis | v1.8 | not started | |
| R10 Later | | | |
