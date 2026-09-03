# Jarvis roadmap and plan

Written 2026-09-03 against `main` at `aadd5b2`. This is a planning document.
It changes no code. Every statement about the code was checked against the
pushed repository, the CI history, and a local run of every suite on that
commit; where a document in this repository says otherwise, the code is what
was checked.

Read [README.md](../../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md) and
[KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) first. This file does not repeat
them. It answers what they do not: what Jarvis was meant to be, everything it
was meant to do, what it does today, where the plans contradict each other,
and in what order to finish it.

---

## 1. What Jarvis is

Sid's private assistant. It lives in three places with one memory: an
always-on Cloudflare Worker that answers the phone and Telegram whether or
not any of Sid's machines are on; a Windows agent on the laptop, later also
the home PC, that keeps the permanent archive, owns the Obsidian vault, and
does the work that needs a real machine; and a second, deliberately isolated
Worker whose only job is to notice when the first one goes quiet.

It is reachable from a phone by text and by voice. It remembers everything it
is told and everything it reads, permanently and with receipts. It manages
Sid's other projects by reading the status documents they already carry. It
tracks school and business deadlines from the systems that hold them. It
acts on Sid's behalf within tiers Sid set, and it never spends money,
contacts another person, deletes data, or touches production without a tap
from Sid first. Version 1.0 is the day Sid can phone it from the car.

That paragraph is the [expansion plan](2026-08-jarvis-expansion-plan.md) in
short, and the expansion plan is the source of truth for scope.

---

## 2. Three plans, one codebase

Jarvis has been planned three times by three builders, and each plan is
still in the repository as if it were current. Knowing which one is
authoritative for which question removes most of the confusion.

| Plan | Written by | Date | What it decides |
|---|---|---|---|
| [Expansion plan](2026-08-jarvis-expansion-plan.md) and [builder prompt](2026-08-jarvis-builder-prompt.md) | Opus 5, with Sid | Aug 2026 | **Product scope.** Everything in section 4 below traces to it. Brain is Claude. The existing `jarvis` and `sid-assistant` code was to be imported first. |
| [Foundation design](../superpowers/specs/2026-08-29-jarvis-foundation-design.md), then the calling, Telegram/memory and voice-access plans | The first builder session | Aug 29 to 31 | **Cloud architecture and security.** Cloudflare Worker, D1 event log, R2 archive, Twilio ConversationRelay, device-signed sync, PIN gates, provenance rules. It changed the brain to DeepSeek without recording why and started from an empty repository instead of importing the legacy code. |
| [Hermes runtime design](../superpowers/specs/2026-08-30-jarvis-hermes-runtime-design.md) and [Obsidian memory design](../superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md), with their plans | Codex, unsupervised | Aug 30 to Sep 1 | **Two amendments.** Hermes Agent as a zero-tool token sidecar behind a "Brain Bridge". Obsidian as a vault adapter guarded by a Rust extension and a privileged Windows service. |

The September 2 to 3 session then built most of the expansion plan's
cloud-side features on the foundation, added a pure-Python stage one of the
Obsidian adapter, and rewrote the entry-point docs.

**Which one wins.** The expansion plan decides *what* Jarvis does. The
foundation design decides *how the cloud is built* and should stay. The
Codex amendments are the problem: approved on paper, mostly unbuilt, and
each turns a product feature into a security programme several times the
size of the feature. Section 6 says what to keep from them.

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
anything, which is the state a CI must never be in.

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
| Brightspace scrape | §3 | **absent** | Needs a real browser session on the PC. |
| Watchdog Worker | §6 | **built** | Not deployed. Needs its own bot. Nothing watches the watchdog. |
| Device-signed sync into the local append-only archive | §7, §8 | **live** | 48 events replicated end to end on Sep 2. |
| Distillation of archive into fact proposals | §7 | **built**, routed on both sides | No process runs the cycle. `agent.py` and `RunLoop` exist; nothing constructs a replicator, a distiller, or the loop. No `jarvis service` command, no console-script entry point. |
| Jarvis recalls distilled facts from the phone | §7 | **absent** | The cloud context retriever reads committed turns only. No fact projection from the PC to D1. Facts are promoted locally and never leave the machine. |
| Personal profile: stated and observed facts, corrections with receipts | §7 | **partial** | Promotion rules and supersession exist locally. No profile shape, no observed-pattern miner, no `why do you think that` surface, and no way for Sid to confirm a proposed fact. |
| Semantic search over the archive | §7, §8 | **partial** | The embedder is a hashed lexical feature vector, "deliberately not a semantic model" by its own docstring. The vector index exists and retrieval never calls it. Full-text search works. |
| Obsidian vault: read, search, add notes | Codex amendment; §7 in spirit | **built**, stage one, local only | No redactor over observations. `project()` has no authority gate. The real vault is not yet created on the machine. No cloud ingest, correctly, until the redactor exists. |
| Encrypted backup and restore of local databases | §6 | **built** | Never scheduled. |
| Live calling, inbound and outbound | §1, build 3, **the v1.0 gate** | **built and switched off** | About 4,200 source and 5,900 test lines, all green. The Worker mounts a fail-closed placeholder, so every voice request returns an error. No real call has ever been placed. Twilio number and five secrets not purchased. `wrangler.toml` still requires a retired secret and declares none of the real ones. |
| Health and readiness endpoint | foundation F8, F9 | **unwired** | Implemented and tested, never routed. The watchdog has its own. |
| R2 archival of aged events | foundation F7 | **unwired** | Implemented and tested, no cron calls it. D1 grows without bound. |
| Second-device enrollment over HTTP | foundation F6 | **unwired** | The production device was enrolled by hand. |
| Deployment scripts, runbooks, release audit | Telegram/memory plan T10 | **absent** | Every deploy so far was typed by hand. The last session could not authenticate wrangler at all. |
| Hermes Agent integration | Codex amendment | **absent in effect** | About 15,000 lines of lock files, SBOM tooling and attestation tests, verifying artifacts never fetched. The Brain Bridge service is 0 lines. The gateway adapter is dead code. Nothing has ever executed Hermes. |
| Voice notes, PWA, HUD, desk knock, inbox triage, briefs, grade watch, errands, Tesla, cost tracker | §1, §5, §6, §9 | **absent** | Later build-order items. Not started, correctly. |

HANDOFF.md's sentence "everything in the expansion plan is built and tested
except live calling" is true of the cloud-side features in build-order
steps 1, 2, 4, 5, 7, 9 and 10. It is not true of the last three rows, of
Brightspace, or of the four unwired rows.

### 3.3 Compromised or stale

- Three peppers, the DeepSeek key and the PIN verifier were pasted into a
  chat and must be rotated before anything else is deployed.
- The foundation spec still mandates an eight-digit owner PIN; the code uses
  the owner/guest four-digit peppered model. Both PIN systems are in the tree.
- `hermes-profile-lock.json` carries a stale source-lock hash and its schema
  pins the same stale value, so the suite cannot notice.
- The voice-integration plan and the H0 evidence record cite six commit SHAs
  that no longer exist after the September 1 consolidation.

---

## 4. The feature catalogue

Everything Sid asked for, in every plan, plus the additions in 4.7 that no
plan names. Each row says where it came from, what state it is in, and which
milestone in section 7 delivers it. "Proposed" rows are new in this document
and need Sid's yes.

### 4.1 Channels: how Sid reaches Jarvis

| Feature | Source | State | Milestone |
|---|---|---|---|
| Telegram text, two-way, with memory | plan §1 | live | M0 to redeploy |
| Slash commands and inline decision buttons | plan §6 | built | M0 |
| Telegram deep links into the PWA | plan §1 | absent | M8 |
| Voice notes over Telegram: hold to talk, transcribe, spoken reply | plan §1 | absent; the classifier rejects audio by design today | M8 |
| Live inbound call with PIN step-up, multi-turn, interruptible | plan §1, foundation §5 | built, switched off | **M5, v1.0** |
| Live outbound call to Sid's verified number on `/call` | foundation §5.2 | built, switched off; the Telegram `/call` command is absent | M5 |
| Guest callers with per-number capabilities and a guest PIN | voice-access design | built | M5 |
| Third-party calls with a one-time confirmation naming person, number and purpose | foundation §5.2, deferred there | absent | M9 |
| PWA pocket dashboard: decision queue, deadlines, projects, St. Remy stats | plan §1 | absent | M8 |
| Web Push as a secondary channel once the PWA is installed | plan §1 | absent | M8 |
| On-demand fullscreen HUD with a "today" view; never the default face | plan §6 | absent; a legacy HUD exists in the unimported `jarvis` folder | M8 |
| Desk-knock input: double knock for push-to-talk, patterns for tier-2 actions, audible ding | plan §6 | absent; `knock_probe.py` results pending | M9 |
| Local voice on the PC with a `hey_jarvis` wake word, through Hermes' voice mode | Hermes design §8.3 | absent | M7 |
| Outbound texts to other people from Jarvis' own Twilio number, clearly labelled; Sid-authored texts via a one-tap Messages handoff | plan §1 | absent | M9 |
| Local CLI as a development and recovery surface | foundation §2 | partial: `doctor`, `enroll`, `status`, `run-once`, `stop`, `vault` | M1 |

### 4.2 Memory: what Jarvis knows

| Feature | Source | State | Milestone |
|---|---|---|---|
| Append-only raw archive of every message and everything read, content-hash deduplicated | plan §7, §8 | built and live for cloud events | done; extended in M2, M6 |
| Distilled fact store Jarvis reasons from | plan §7 | built locally | M1 wires it |
| Promotion rules: only Sid's words and Jarvis' own observations become facts; third-party text never does | plan §8, foundation §8.2 | built | done |
| Every fact points to its source; "why do you think that" answers with receipts | plan §7 | partial: provenance stored, no surface | M6 |
| Corrections: "that's wrong, forget it" supersedes immediately, history kept | plan §7 | partial: supersession exists, no command | M6 |
| Personal profile: stated facts authoritative at once; observed patterns earn confidence through repetition | plan §7 | absent as a shape | M6 |
| Profile changes behaviour: digest timing, quiet hours, message style | plan §7 | absent | M6 |
| Full-text search over the archive | plan §7 | built | done |
| Semantic search with a local embedding model, nothing sent to a cloud API | plan §8, foundation §8.2 | partial: hash embedder, index unused | M2 |
| Facts available from the phone when the PC is off | foundation §8.3 | absent | M1 |
| Obsidian vault Jarvis reads, searches and adds notes to, never overwriting Sid's files | Obsidian design | built, stage one | M2 |
| Facts projected into the vault as source-linked notes | Obsidian design §7.1 | partial: write path exists, no gate | M2 |
| Vault notes become proposals Sid can confirm into facts | Obsidian design §7.3 | absent | M6 |
| Ingestion of emails, scraped pages, documents; binaries by pointer with extracted text alongside | plan §7 | absent | M6 |
| Encrypted backup of memory and config, nightly | plan §6, foundation §8.3 | built, unscheduled | M1 |
| Multi-device: one memory shared by laptop and home PC through D1 | plan, multi-device | partial: sync protocol exists for one device | M8 |
| Retroactive re-mining of the archive as distillation improves | plan §7 | possible by design, no command | M6 |

### 4.3 Managing: what Jarvis keeps track of

| Feature | Source | State | Milestone |
|---|---|---|---|
| Poll every tracked repo's NEXT_STEPS, KNOWN_ISSUES, DECISIONS, CHANGELOG | plan §2 | built | M0 |
| Real-time ping when a KNOWN_ISSUES or DECISIONS file changes | plan §2 | absent | M6 |
| Stalled-project detector against stated deadlines | plan §5 | built | M0 |
| Google Classroom deadlines | plan §3 | unwired | M4 |
| Brightspace deadlines by authenticated scrape, polite cadence, MFA via Telegram | plan §3 | absent | M4 |
| One deadline store, conflict flagging weeks ahead | plan §3 | built, empty | M4 |
| Effort-scaled reminders: same day for a quiz, days out for a project | plan §5 | built | M0 |
| Exam-mode quiet hours, automatic and manual | plan §5 | built | M0 |
| Grade and missing-work watch with same-day pings | plan §5 | absent | M4 |
| Morning digest: top St. Remy items, nearest deadlines, focus blocks | plan §3 | built | M0 |
| Sunday retro: shipped, blocked, due this week | plan §5 | built | M0 |
| Workload-trend line in the retro | plan §6 | absent | M6 |
| Decision queue: one ranked list, tappable options, always "other" and "explain more" | plan §6 | built | M0 |
| Taps route back to whatever was waiting, including a Claude Code session | plan §6 | partial: recorded, not routed | M3 |
| Meeting and class prep briefs, 15 to 30 minutes ahead | plan §5 | absent | M6 |
| Inbox triage for Gmail; school Outlook only if scraping proves viable | plan §5 | absent | M6 |
| API and cost tracker per project, Jarvis itself first | plan §6, §8 | absent | M6 |
| St. Remy commitments in the same store; small-business plugin skills reused in the digest | plan §3, §6 | absent; how Jarvis reads St. Remy data is an open decision by Sid's rule | M9 |
| Voice quick-capture: "log idea for X" appends to that repo's NEXT_STEPS | plan §5 | absent | M7 |

### 4.4 Acting: what Jarvis does on Sid's behalf

| Feature | Source | State | Milestone |
|---|---|---|---|
| Tiered autonomy: tier 1 observe, tier 2 reversible and logged, tier 3 always confirmed | plan §4, §8 | built | M0 |
| Shadow mode: report what it would do, one to two weeks before tier 2 | plan §8 | built | M3 |
| Retrieved content is data, never instructions; the tier-3 gate is the backstop | plan §8 | built | done |
| A general agent runtime: tools, skills, browser, terminal, subagents, cron | Hermes design, Sid's direction | absent | **M3** |
| PC control: open apps, files, designated project folders | plan §4 | absent | M3 |
| Queue-and-sync: a PC-bound request while the machine sleeps is queued with an honest reply, never dropped | plan, multi-device | absent | M3 |
| Errands: plan, check the calendar, tier-3 confirm with full specifics, execute in Sid's real browser profile, report | plan §9 | absent | M7 |
| Ticketing as monitor-and-assist, never unattended sniping | plan §9 | absent | M7 |
| Tesla Fleet API: preheat at tier 2, unlock and remote start at tier 3; unasked preheat from calendar plus weather | plan §9 | absent | M7 |
| Calendar changes at tier 2, protected focus blocks | plan §3, §4 | absent | M6 |
| Global kill switch for outbound calls | foundation §5.2 | built for calls | M3 extends it |

### 4.5 Platform: what keeps it running

| Feature | Source | State | Milestone |
|---|---|---|---|
| Always-on Cloudflare gateway with D1 event log and R2 archive | plan, foundation | live | done |
| Local agent as a background service, no window, small footprint, heavy work on demand at low priority | plan §6 | absent as a process | M1 |
| Self-waking daily rhythm: BIOS RTC boot at 7:30, scrape, distil, digest, sleep; polling wakes; nightly shutdown | plan, multi-device | absent | M7 |
| Wake-on-LAN relay for instant wake | plan, multi-device | absent, optional | M9 |
| Standalone watchdog Worker with its own alert path | plan §6, decision 8 | built | M0 |
| Something watching the watchdog | KNOWN_ISSUES | absent | M0 |
| Health and readiness endpoints | foundation §9 | unwired | M0 |
| Archival of aged events to R2 with capacity alerts at 70, 85, 95 percent | foundation §8.3 | unwired | M0 |
| Deploy, migrate, rollback and secret-rotation scripts and runbooks | Telegram/memory plan T10 | absent | M0 |
| Second-device enrollment over HTTP | foundation §4.3 | unwired | M8 |
| Release evidence: live call, Telegram round trip, backup drill, SBOM, secret scan | foundation §11.2 | partial | M5 |
| A CI whose red means something | this document | red | M0 |
| Hermes pinned to an exact upstream version, never self-updating in production | Hermes design §6 | built (locks and fetch script) | kept, M3 |

### 4.6 Rules the plan makes non-negotiable

These are not features; they are constraints every milestone inherits.

- Credentials never in source, commits, transcripts, logs, memory or the
  vault. Rotation straight into `wrangler secret put`.
- The St. Remy repository, Worker and D1 are off limits. How Jarvis reads
  St. Remy data is an open decision recorded in DECISIONS.md, not something
  to implement.
- Brightspace scraping is polite: a few runs a day, Sid's real browser
  profile, alert rather than silently fail, a human in the loop for MFA.
- No tier-2 action before shadow mode has run. No tier-3 action without a
  tap, ever, whatever the model's confidence.
- Voice audio is never stored. PIN digits never reach a transcript, a model,
  a log or an event.
- A release is never declared from unit tests alone. Version 1.0 needs the
  real calls in the foundation design's §5.3.

### 4.7 Plus more: proposed additions

None of these is in any plan. Each is cheap once its milestone exists, and
each closes a hole a daily user would hit. They need Sid's yes.

| Proposal | Why | Milestone |
|---|---|---|
| **Fact confirmation through the decision queue.** Model-inferred facts stay "proposed" forever today because nothing asks Sid about them. Batch them into the queue once a day: "Jarvis thinks you prefer evening replies. Keep?" | The only way the observed profile in §7 ever becomes real. | M6 |
| **`/why` and `/forget`.** `/why <thing>` shows the fact and its source excerpt with a date. `/forget <thing>` supersedes it. | The plan promises both; neither has a surface. | M6 |
| **`/panic`.** One command that disables tier 2, stops any Hermes run, cancels pending outbound calls, and says what it stopped. | The foundation has a kill switch for calls only. Once Jarvis has hands it needs one for everything. | M3 |
| **Hermes cron and subagents for standing watches.** "Watch this listing", "summarise this repo every Friday", "tell me when the marks page changes." | Hermes ships both; Jarvis supplies the delivery channel and the archive. | M7 |
| **A skills library owned by the repository.** Repeatable procedures (weekly St. Remy report, term-start deadline import) as Hermes skills under version control, never learned from note text. | Hermes' skills hub is its best feature; keeping skills in the repo keeps them reviewable. | M7 |
| **Provider routing per task.** Cheap model for distillation, triage and classification; the strong model for digest synthesis and hard turns; a local model as an outage fallback. | The plan's model-cost tiering, made concrete. The adapter interface already allows it. | M6 |
| **Document ingestion into the archive.** Gmail, Google Drive, PDFs with text extraction, receipts by photo. Everything searchable, nothing summarised away. | The plan's "everything read" applies to documents too. | M6 |
| **A daily memory ledger note in the vault.** One generated note per day: what was learned, what was proposed, what changed. | Makes the memory system legible in the tool Sid already opens. | M2 |
| **Home PC as a second device with routed PC actions.** Explicit per-command routing, default the laptop. | The plan leaves the routing rule open; picking "explicit, default laptop" unblocks it. | M8 |
| **Data export.** One command producing an encrypted bundle of archive, facts and vault. | The permanent archive raises the cost of lock-in. | M8 |
| **Third-party data minimisation policy.** A retention rule for classmates', teachers' and customers' content, distinct from Sid's own. | The foundation design names it as a future rule; make it a decision now. | M6 |

---

## 5. The decisions that shape everything after

Four forks. Each has a recommendation. Sid's answer to the first changes
milestone 3 completely; the others change scope but not order.

### 5.1 What "build off Hermes Agent" means

Hermes upstream, at the pinned `v2026.8.27`, ships a Telegram, Discord,
Slack, WhatsApp and Signal gateway in one process; voice mode; more than
forty tools with toolsets; MCP; cron; subagents; a skills hub; persistent
memory files; and an OpenAI-compatible API server on loopback with a Runs
API (create a run, stream its events, stop it, answer an approval). It
installs natively on Windows through `uv`, which is already on Sid's machine
at the path TESTING.md names.

What Hermes does not have, and Jarvis does: a phone number with a PIN gate,
an always-on cloud that works when the PC is off, an append-only archive
with fact provenance, a deterministic decision queue, and a watchdog.

| Option | What it means | Verdict |
|---|---|---|
| **A. Sidecar**, Codex's design and the current plan | Hermes is an untrusted process allowed only to return text tokens. Zero tools, zero memory, zero MCP. Locked behind a durable ledger, two Windows services with restricted SIDs, and a certification step. Tools arrive in "H2", after 0.1.0, after an always-on host decision nobody has made. | Its first milestone delivers nothing a user can see: a token stream the cloud already gets from DeepSeek directly. Everything valuable is two milestones and one hosting decision away. **Retire.** |
| **B. Hands**, recommended | Hermes runs natively on the PC as Sid's user and is the local agent's brain and hands: PC control, browser errands, skills, subagents, its own cron. Jarvis cloud stays the always-on front door: Telegram, calls, digest, decision queue, memory of record. The Python local agent stays the trusted layer: sync, archive, vault, and a thin client that hands Hermes a task over its loopback Runs API, streams the transcript into the archive, and routes any tier-3 action through the decision queue that already exists. | Uses what Hermes is good at, keeps every Jarvis guarantee that matters, and reuses the decision queue and autonomy tiers already built. Hermes' approval endpoint maps directly onto a Telegram button. **Do this.** |
| **C. Replacement** | Hermes owns Telegram too; Jarvis shrinks to telephony and storage. | Loses the audited memory and the deterministic digest, and puts two consumers on one bot. **Reject.** |

Under B, the rules from the Hermes design that survive are the cheap ones:
pin an exact upstream version with a hash; never run `hermes update` in
production; Hermes holds its own model key and nothing else; Hermes'
built-in memory files are disabled or treated as scratch, never as a source
of facts; tier 3 is enforced by Jarvis, not by Hermes' approval mode. The
expensive rules do not survive: the 1 GiB request ledger, WinSW services with
restricted service SIDs, attestation of every resolved config hash, SBOM
regeneration on every change, certification by three reviewers. The existing
source lock and fetch script are kept as the pinning mechanism. The
review-round tests that take fifty minutes leave pull-request CI.

### 5.2 Which model is the brain

The expansion plan says Claude, with Haiku for distillation. The foundation
design changed it to DeepSeek V4 Pro without recording why. The code is
DeepSeek direct, and it works in production.

**Recommendation.** Keep DeepSeek in the cloud for now. It is deployed,
cheap, and behind a provider interface. Let Hermes on the PC use whatever
provider Sid configures. Revisit on a concrete quality complaint. Either way
it is configuration, not a milestone.

### 5.3 How deep the Obsidian integration goes

The Codex design demands a Rust extension for NTFS object identity, a
LocalSystem service for the change journal and Volume Shadow Copy, and 189
files. Stage one, already built in pure Python, gives Sid a vault Jarvis can
read, search and add notes to, and never overwrites a file he wrote.

**Recommendation.** Finish stage one properly: redactor, authority gate, the
real vault on the machine, facts projected into it, notes searchable, and
the daily ledger note. Stop there. The native bridge is a hardening project
to schedule only if a real loss occurs. Cloud ingest of notes stays off until
the redactor exists and Sid explicitly turns it on.

### 5.4 What "released" means, and when

The expansion plan is explicit that v1.0 is "Sid can phone Jarvis from the
car". That gate is right and stays. But nothing built since September 1 is
deployed, so the release gate is being applied to a system Sid cannot use
daily either.

**Recommendation.** Name two milestones before v1.0: **v0.2, daily driver**,
everything already built deployed and running unattended; and **v0.3,
hands**, Hermes doing work on the PC from Telegram. Then v1.0 calling.

---

## 6. What to stop carrying

Approved documents whose remaining work should not be executed as written.
Mark each superseded by this file rather than deleting it; the designs hold
reasoning worth keeping.

| Document | Remaining tasks | Disposition |
|---|---|---|
| Hermes H1 plan | Tasks 5 to 7 (ledger, Runs client, bridge service), 10 to 13 (Windows services, gateway join, live certification) | Superseded by M3. Keep tasks 0 to 3 (locks, fetch script, profile) as the pinning mechanism. |
| Obsidian implementation plan | O5 (Rust kernel, privileged broker), O7 (USN reconciliation), O11 (VSS backup), the cloud-ingest half of O2 to O4 | Deferred indefinitely. O8 retrieval, O9 gate and projection, O10 setup and doctor are M2. |
| Telegram/memory plan | T10 deployment scripts and release audit | Shrunk to four scripts and one runbook in M0. |
| Calling and voice-access plans | C8 limits tests, 8B fake acceptance, C9 live evidence | M5, unchanged. |
| hermes-runtime review-round tests | `source-lock` and `workflow-containment-review5`, fifty minutes each | Out of pull-request CI into a manual workflow. |
| Foundation spec §5.1 eight-digit PIN, the two PIN-verifier scripts, the legacy verifier module | | Delete in M5; the owner/guest design is current. |

---

## 7. Milestones, in dependency order

Each milestone has an exit test a person can perform. Effort is a rough
builder-session estimate.

### M0. Green and deployed, v0.2 part one

Nothing new. Make what exists true in production. About two sessions.

1. Fix the three CI failures so red means something: the Linux-only type
   errors, the pipe DACL test's raw-SID assertion, the containment test's
   short-name rejection. Move the two fifty-minute Hermes tests to a manual
   workflow.
2. Rotate the compromised secrets straight into `wrangler secret put`.
3. Make `wrangler.toml` honest: declare every secret `env.ts` reads, drop
   `PIN_VERIFIER_JSON`, delete the two scripts that generate it.
4. Write `scripts/deploy.ps1` and `scripts/deploy-watchdog.ps1` that apply
   migrations and deploy, and a runbook naming the secrets. The smallest
   slice of the T10 task; it stops every deploy being typed by hand.
5. Apply migrations 0008 to 0013. Deploy the gateway. Deploy the watchdog
   with its own bot. Set `OWNER_PRINCIPAL_ID`, `DIGEST_TIMEZONE`,
   `TELEGRAM_BOT_USERNAME`.
6. Route the health handler at `/health`. Point an external uptime monitor
   at the watchdog's health route. Give the watchdog a list of components
   that must report.
7. Add the R2 archival service to the hourly job. It is built and tested;
   this is one job-table entry.

**Exit.** CI green on `main`. `/status` and `/queue` answer in Telegram. A
cron fires and the watchdog records the heartbeat. The morning digest
arrives, saying "nothing due".

### M1. The local agent runs by itself, v0.2 part two

About one session. Unblocks memory, distillation and everything after.

1. A composition root: `jarvis service` that opens the stores, constructs the
   replicator, the HTTP distillation client, the coordinator and the run
   loop, and serves the named pipe. A `[project.scripts]` entry so `jarvis`
   is a command.
2. Start it at logon with a Windows scheduled task, not a Windows service.
   The service host, WinSW and the restricted service SID were the parts of
   the old plan that needed an elevated shell and delivered nothing visible.
3. Fact projection: a signed upload of active facts to D1, and the cloud
   context retriever reads active facts alongside recent turns. This is the
   missing half of the Telegram/memory plan's task 8 and what makes "Jarvis
   remembers" true from the phone.
4. Schedule the encrypted backup nightly from the same loop.

**Exit.** Tell Jarvis something on Telegram. Wait one cycle with the PC on.
Turn the PC off. Ask about it from the phone. It answers from a fact, not
the transcript. **This is v0.2.**

### M2. Obsidian, safely, and search that means something

About two sessions. Depends on M1 for projection.

1. Run the foundation classifier and redactor over every vault observation;
   refuse a note whose secrets cannot be removed. Listed as a prerequisite
   in KNOWN_ISSUES.md.
2. An authority gate in front of `project()`: an active fact plus a
   version-bound export decision, defaulting to Sid's standing approval for
   ordinary personal and project facts and denial for anything restricted.
3. `jarvis vault setup` on the real machine and the one manual "Open folder
   as vault" step in Obsidian.
4. Project active facts into the vault as write-once notes; feed vault
   observations into the local full-text index; expose `/vault` on Telegram
   as a search over what is local. Add the daily ledger note.
5. Replace the hash embedder with a real pinned model through the
   compatibility gate that exists: `all-MiniLM-L6-v2` on ONNX Runtime,
   weights vendored and hash-locked, embeddings as SQLite blobs with
   in-process cosine, exactly the fallback the foundation spec prescribes.
   Make retrieval call the vector index.
6. Leave cloud ingest of notes off. Record it in DECISIONS.md.

**Exit.** Write a note in Obsidian; `jarvis vault search` finds it within a
cycle. Tell Jarvis a preference on Telegram; a note appears under
Preferences with its source link. Ask "what did I decide about X" in
different words than the note; semantic search finds it.

### M3. Hermes as hands, v0.3

Two to three sessions. Depends on M1 and on decision 5.1.

1. Pin and install Hermes natively under Sid's account with the existing
   source lock and fetch script, in its own Python 3.11 environment. Disable
   its built-in memory and background review in the profile. Enable its API
   server on loopback with a key only the local agent holds.
2. A Hermes client in the local agent: create a run, follow the event
   stream, stop a run, answer an approval. Every event goes into the archive
   as a redacted transcript.
3. A task path: a Telegram command becomes a decision-queue item tagged
   "needs the PC"; the run loop picks it up when the machine is awake, hands
   it to Hermes with a toolset chosen by the autonomy tier, posts the result
   to Telegram. If the PC is asleep, Telegram says so and the item waits.
4. Tier 3 through the decision queue: when Hermes asks for approval, the
   local agent posts a decision with buttons; the tap is the approval.
   Hermes never executes a tier-3 tool without that round trip.
5. `/panic`.
6. Shadow mode for the first one to two weeks: Hermes reports what it would
   do, tier-2 tools stay off.

**Exit.** From Telegram: "open the jarvis repo and tell me what NEXT_STEPS
says". The PC runs it through Hermes, the transcript lands in the archive,
the answer arrives on the phone. Then "delete the temp folder": a
confirmation button arrives first and nothing happens until it is tapped.
**This is v0.3.**

### M4. Deadlines for real

About one session for Classroom, one for Brightspace. Depends on M0; the
Brightspace part depends on M3 for a real browser on the PC.

1. Google Classroom OAuth in the gateway; the hourly job calls ingestion.
   Look at one real assignment, settle UTC versus local, delete the setting.
2. Brightspace as a Hermes browser task on the PC, a few runs a day, MFA
   routed to Telegram as a decision.
3. Deadline status setters and the decision-expiry sweep.
4. Grade and missing-work watch once both sources exist.

**Exit.** The morning digest lists a real deadline from each source, at the
right local time.

### M5. Phone Jarvis from the car, v1.0

One to two sessions plus the purchase. Depends on M0. This gate does not
move.

1. Buy the Twilio number and create the five secrets.
2. Replace the fail-closed voice placeholder in the Worker with the real
   dependencies; the construction function exists.
3. Write the fake acceptance scenarios both calling plans require and the
   repository lacks: inbound with two turns and an interruption, outbound
   answer, outbound no-answer, oversize frame, model timeout, owner, guest,
   unknown caller, revoked grant. Add the Telegram `/call` command.
4. Run the live smoke per the runbook and commit the redacted evidence.
5. Delete the legacy eight-digit PIN verifier and fix the foundation spec.

**Exit.** The foundation design's permanent release gate, §5.3: a real
inbound call with two turns and an interruption, a real outbound call with
answer and no-answer paths, transcript recall afterwards, a rejected unknown
caller. **This is v1.0.**

### M6. A real assistant's memory and manager

Three to four sessions. Depends on M1, M2, M4.

1. The personal profile as a shape: stated versus observed, confidence
   through repetition, and a nightly job proposing observed patterns.
2. Fact confirmation through the decision queue; `/why`; `/forget`.
3. Profile-driven behaviour: digest delivery time, quiet hours, style.
4. Meeting and class prep briefs. Inbox triage for Gmail. The workload-trend
   line. The cost tracker, pointed at Jarvis first.
5. Real-time pings on KNOWN_ISSUES and DECISIONS changes.
6. Document ingestion: Gmail, Drive, PDFs with text extraction.
7. Provider routing per task. The third-party minimisation policy.
8. Calendar writes at tier 2 with protected focus blocks.

**Exit.** "Why do you think I hate mornings?" gets an answer with a dated
source. A brief arrives before a class. The Sunday retro has a workload
line and a cost line.

### M7. Hands, extended

Three sessions. Depends on M3 and M4.

1. Errands with the tier-3 confirm flow in Sid's real browser profile;
   ticketing as monitor-and-assist.
2. Tesla Fleet API: preheat at tier 2, unlock and start at tier 3, unasked
   preheat from calendar and weather.
3. Hermes cron and subagents for standing watches. The repository-owned
   skills library.
4. Local voice with `hey_jarvis` through Hermes' voice mode. Voice
   quick-capture to NEXT_STEPS.
5. The self-waking daily rhythm: BIOS RTC boot, scrape, distil, digest,
   sleep, nightly shutdown.

**Exit.** "Dinner Monday somewhere that fits my schedule" produces a
confirmation with a restaurant, time and table, and a booking after the
tap. The car is warm at 8:05 on a cold morning, unasked.

### M8. More devices and more windows

Two to three sessions. Depends on M1 and M5.

1. Second-device enrollment over HTTP; the home PC as a second install with
   explicit action routing, default the laptop.
2. The PWA dashboard on the existing D1 state, with Telegram deep links and
   optional Web Push.
3. Voice notes over Telegram with transcription and a spoken reply.
4. The on-demand HUD with a "today" view.
5. Data export.

**Exit.** A decision tapped on the PWA is the same decision the Telegram
button would have answered. A voice note gets a spoken reply.

### M9. Later, pulled by friction

In no order: desk-knock input once the probe results exist; Wake-on-LAN;
third-party calls with a confirmation; outbound texts from Jarvis' number;
the St. Remy panel once Sid decides how Jarvis reads that data; the
Obsidian native bridge only if a real loss motivates it; the Hermes proposal
protocol only if the decision-queue approval path proves insufficient; the
Telegram limiter and breaker into a Durable Object; the 117 test type
errors, then the test typecheck as a CI gate.

---

## 8. Decisions Sid needs to make

Answer these and the roadmap is executable without further planning.

1. **Hermes role.** Option B, hands, is recommended. Yes retires the sidecar
   plan. No means M3 becomes the Brain Bridge as designed, roughly three
   times the work for no visible feature until H2.
2. **Brain model.** Keep DeepSeek in the cloud for now, recommended, or
   switch to Claude as the expansion plan originally said.
3. **Obsidian depth.** Stage one finished properly, recommended, or the
   native bridge on the critical path.
4. **Local agent start-up.** A scheduled task at logon, recommended, or a
   Windows service.
5. **Twilio purchase timing.** M5 cannot start without the number. Nothing
   before M5 needs it.
6. **Vault notes to the cloud.** Off by default, recommended, until the
   redactor exists and a specific reason appears.
7. **The additions in 4.7.** Each is a yes or no; none blocks anything else.

---

## 9. Keeping this file honest

This roadmap replaces the "Next" half of HANDOFF.md and the structure of
NEXT_STEPS.md. NEXT_STEPS.md stays as the short list of the current
milestone's open items. When a milestone's exit test passes, record the
date here and move NEXT_STEPS.md to the next one.

| Milestone | Delivers | Status | Date |
|---|---|---|---|
| M0 Green and deployed | v0.2 part one | not started | |
| M1 Local agent runs by itself | v0.2 | not started | |
| M2 Obsidian and semantic search | | not started | |
| M3 Hermes as hands | v0.3 | blocked on decision 1 | |
| M4 Deadlines | | not started | |
| M5 Calling | v1.0 | blocked on decision 5 | |
| M6 Memory and manager | | not started | |
| M7 Hands, extended | | not started | |
| M8 Devices and windows | | not started | |
| M9 Later | | | |
