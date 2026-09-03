# Jarvis Expansion Plan — Phone Updates, AI Project Manager, Scheduling

## Where this picks up

Jarvis already has a foundation built and sitting unrun on your PC: a Claude brain with SQLite memory, PC-control tools, a voice stack, and a HUD. The Telegram-bot front end (Cloudflare Worker + D1 + Claude API) was built in Phase 1 and shelved in favor of the desktop version. Calendar, YouTube upload, and the St. Remy business panel were never built.

This plan doesn't replace any of that — it adds three capabilities on top of it, plus resolves a multi-device question your new "laptop and maybe home PC" framing raises.

What Jarvis is, concretely — same shape as the St. Remy system: a Windows program on the PC (local agent: HUD, voice, PC control, scraper, archive), a Cloudflare Worker + D1 backend (always-on: Telegram, pollers, queue, Tesla, voice number), and phone front ends (Telegram now, PWA later — windows into Jarvis, not Jarvis itself).

One open gap not yet addressed anywhere below: Jarvis itself has been built ad hoc so far (delivered as a zip, never run) rather than under the README/AGENTS.md/CHANGELOG/NEXT_STEPS/release-gate discipline you require on every other project. Worth deciding whether it gets that same treatment before this expansion starts — it's about to hold API keys, school credentials, and (per §7) a permanent archive of everything, which raises the cost of it being the one project without that discipline.

---

## 1. Phone updates

**Recommendation: revive the Telegram bot rather than building a new channel.**

You already picked Telegram over SMS after comparing cost, and the Phase-1 bot is written. Reasons to keep it:
- Free (vs. Twilio SMS, which charges per message)
- Two-way by default — matches your existing preference for replying from your phone and having that reply feed back to Claude as your response
- Already has a Cloudflare Worker + D1 backend that can double as the sync layer for capability #4 below

What it needs to actually work: deploy it (never happened), decide what triggers a message (see decision points), and connect it to whichever brain instance is authoritative once you have two devices.

Alternatives if you want true SMS or a push-notification feel instead: Twilio (costs money, real SMS), Pushover or ntfy.sh (free/cheap, app-based, one-way unless you build a reply webhook yourself). None of these beat "already built and free" without a specific reason.

**PWA — the pocket dashboard, not the pager.** A PWA doesn't replace Telegram for instant alerts: Telegram's push is more reliable than Web Push (on iPhone a PWA only gets push once installed to the home screen, and delivery still runs below a native app), needs zero front-end work, and is already two-way. What a PWA is right for is the mobile HUD — decision queue, deadlines, St. Remy stats, project statuses as real views instead of chat messages. The Cloudflare Worker + D1 backend is already the shared state layer, so the PWA is just a front-end on it, hosted free on Cloudflare Pages. Best hybrid: Telegram pings carry deep links opening the PWA straight to the relevant view — instant alerts plus a real dashboard, no dependence on Web Push. Optionally add Web Push later as a secondary channel once it's on your home screen; it stays secondary.

**Voice — live calling is the v1.0 flagship.** Jarvis gets a Twilio phone number wired into a realtime speech pipeline: you call Jarvis from the Tesla over Bluetooth like calling a person, fully hands-free by design. Cost: ~$1.15/mo for the number, under a cent/min telephony, ~$0.02–0.05/min for the AI pipeline. Ship-fast path: build v1.0 on Twilio ConversationRelay (managed pipeline, +$0.07/min) to release in days, then swap in the DIY streaming pipeline as a cost-down follow-up once real usage is known — the stage stays swappable. Voice notes over Telegram (hold-to-talk, Whisper transcribes, spoken reply back) ship alongside for near-free since the bot deploys anyway — they're the debugging fallback and the cooking-mode interface, not a separate phase. A live WebRTC voice session inside the PWA remains an optional later add (no per-minute telephony, more front-end work, can't be dialed from the car).

Pipeline components (decided): STT for voice notes = OpenAI Whisper API ($0.006/min — file-shaped input, ideal for Telegram voice messages). STT for live calls = ConversationRelay's built-in initially; if/when going DIY, pick a streaming-native provider (Deepgram class). TTS = cost differences are pennies at this scale, so choose by listening to voice samples at build time — pick Jarvis's voice by ear. Brain stays Claude; mixed-vendor pipeline is intentional, each stage swappable.

**Outbound texts to other people:** iOS doesn't allow any app to programmatically send SMS from your personal number. Rule: messages you authored → your number via a one-tap pre-filled Messages handoff; messages Jarvis initiates → sent from Jarvis's own Twilio number, zero taps, clearly labeled. (iOS Shortcuts automations can auto-send from your number but are fragile — don't make them load-bearing.)

---

## 2. AI project manager (managing your other AI-driven projects)

The problem: you're running several AI-touched projects in parallel (stock intelligence work, trading tools, St. Remy's efficiency/FOE/marketing efforts, product tracking, etc.) across separate Claude and GPT threads, and none of them currently report status anywhere central.

**Recommendation: don't build a new tracking system — point Jarvis at the one you already mandate.**

Your software-development standard already requires NEXT_STEPS.md, KNOWN_ISSUES.md, DECISIONS.md, and CHANGELOG.md on every project, sourced from a private GitHub repo. That means:
- Jarvis can poll each repo's these files via the GitHub API on a schedule
- No new discipline required from you — if a project is following your own standard, it's already reporting
- A daily/weekly digest becomes: "read N repos' NEXT_STEPS + KNOWN_ISSUES, summarize, flag anything blocked or awaiting your decision"
- Real-time pings (rather than digest-only) trigger when a KNOWN_ISSUES or DECISIONS file changes, or a repo hasn't been touched in X days when it should have been

**Gap:** GPT-based projects (e.g., anything built outside your GitHub/Claude Code discipline) won't have this convention unless you add it. Cheapest fix is the same four files, even for a solo script — costs you one commit, saves Jarvis from custom scraping per project.

**Open design question:** does this live inside Jarvis's existing brain (one unified assistant that also does HUD/voice/PC control), or as a separate lightweight poller that just feeds Jarvis a summary? Separating it means it can run headless on a cheap always-on box (even a Cloudflare Worker on a cron trigger) instead of depending on your PC being on. Given you want phone alerts specifically, I'd lean toward the poller being cloud-based and independent of whether your laptop is open.

---

## 3. Schedule / time management

You're weighing 12th grade against running St. Remy at a CEO level — that's two full workloads competing for the same calendar, which is exactly the kind of thing worth automating rather than holding in your head.

**Recommended shape:**
- Pull school deadlines from Google Classroom + D2L Brightspace (see below), and St. Remy commitments from wherever those already live, into one store
- A daily digest (delivered via the Telegram channel from #1) each morning: top 3 St. Remy items, nearest school deadlines, and open focus-time blocks
- A priority pass that flags conflicts before they become a problem — e.g., a St. Remy deadline landing the same week as exams, surfaced with enough lead time to actually move something
- Optional: protected blocks the assistant won't schedule St. Remy pings into (exam weeks, class hours) unless something is flagged urgent

This is the piece the Jarvis file already marks as "not built yet" — it's the natural next build target once the notification channel exists to deliver it through.

**School deadline sources:**

*Google Classroom* — public Classroom API, OAuth against your own Google account, no school approval needed. Pulls courses and coursework with due dates directly.

*D2L Brightspace (LDSB "Minds Online")* — no personal Calendar/iCal export is available. Confirmed: LDSB's Brightspace homepage has an embedded Google Calendar widget instead of D2L's native Calendar tool, and it isn't populated with assignment due dates (just whatever's on the actual Google Calendar — currently empty). The iCal-subscribe path doesn't exist here. Deadlines need to come from an authenticated scrape instead:
1. Jarvis logs into Brightspace through LDSB's SSO flow (same credentials as Outlook/Teams) using browser automation (Playwright)
2. Once logged in, it visits each course's Content/Assignments pages and parses due dates directly from the page — no official API, more fragile than a feed, breaks if LDSB changes the page layout
3. Session/cookies persist between runs rather than logging in every time; credentials stored in a local encrypted store rather than plaintext in code
4. Same "alert rather than go silent" pattern as the planned St. Remy error-log feed — an empty or failed scrape pings you rather than quietly assuming nothing's due
5. Sessions will expire — and if LDSB's SSO demands MFA on re-login (plausible; they hardened auth after their 2025 cyber incident), Jarvis pings you on Telegram to complete it rather than silently failing. Poll a few times a day, not continuously — a sane cadence keeps a hardened tenant's security monitoring uninterested in you

Confirmed: coverage is split — some teachers run their whole class on D2L, others solely on Google Classroom. So both sources are load-bearing; the Brightspace scraper isn't a lower-priority afterthought, it's equally necessary for full deadline coverage.

Both feeds land in the same deadline store that feeds the daily digest and conflict-flagging above — Jarvis doesn't need to treat them differently once ingested.

---

## 4. Access model — full PC/network access

This is legitimate for what you're building: a local agent running under your own OS permissions isn't going through a hosted sandbox, so "full access" is just how local software works, not something unusual to ask for.

The one design choice worth making deliberately, given some of what Jarvis touches (St. Remy data, potentially customer-facing systems down the line): a tiered autonomy model rather than uniformly unrestricted, even though you've said you want it fully autonomous overall:

- **Auto, no confirmation:** reading logs, monitoring, sending you notifications, status polling
- **Auto but logged and reversible:** file edits in designated project folders, opening apps, calendar changes
- **Requires your explicit go-ahead even in autonomous mode:** anything moving money, anything communicating with customers/vendors on your behalf, deleting data, touching live St. Remy production systems

This isn't a walk-back of "fully autonomous" — it's scoping *what* autonomy covers so a bug or a bad model call can't silently touch things that are expensive to undo. Your call on where the lines sit; the above is a starting point, not a requirement.

---

## Multi-device: laptop + maybe home PC

The earlier plan targeted the home PC only. If the laptop becomes primary (or both stay active), you need a shared brain rather than two independent Jarvis instances with separate memory:

- Use the Cloudflare Worker + D1 backend (already built for the Telegram bot) as the shared state layer
- Each machine runs a local agent for device-specific actions (voice, HUD, local file/PC control)
- The cloud layer holds memory, project status, and schedule — so a notification or digest is the same regardless of which device triggered it
- PC-control actions ("open this app," "upload this video") need to route to whichever device can actually do it — worth deciding now whether that's always the home PC, always whichever is active, or explicit per-command

**What runs where — nothing has to stay on:**
- *Cloud (Cloudflare Worker, always on):* Telegram in/out, decision queue, GitHub poller, heartbeat, Tesla API commands, Classroom polling, and the voice-call pipeline — host it here so calling Jarvis works with every machine shut
- *Local (needs that machine awake):* HUD, voice stack, PC control, file ops, D2L/Outlook scraping (real browser profile), errand execution, raw archive + distillation processing
- *Self-waking — decided daily rhythm:* fully off overnight; BIOS "Power On by RTC Alarm" boots the PC at 7:30am from full shutdown (Windows wake timers can't fire from power-off — this BIOS setting can). Boot sequence: scrape D2L → distillation → digest to Telegram → sleep. Daytime: sleep + polling wakes every ~20–30 min for queued jobs. Evening: normal use. Night: Jarvis shuts it fully down ("goodnight" or auto at a set time). Cloud side (Telegram, voice, Tesla, pollers) runs 24/7 regardless. Instant Wake-on-LAN remains an optional later add (needs a Pi-class relay in the LAN)
- *Queue-and-sync:* machine-bound requests while it's asleep get queued in D1 with an honest reply ("PC's asleep — queued for 6:30, or wake it now?"), never silently dropped
- *Cached state:* last scrape results live in cloud state, so deadlines and digests always answer from the most recent pull even with all machines off

---

## Decisions — resolved, override any you disagree with

1. ~~Phone channel~~ — resolved: Telegram. Already free, already built, already two-way — no reason to pay for Twilio or lose reply-back with a push app.
2. ~~AI-project-manager location~~ — resolved: separate cloud poller (Cloudflare Worker on a cron), not inside Jarvis's brain. It needs to run whether or not your laptop/PC is on.
3. ~~Autonomy tiers~~ — resolved: adopt the tiered model from §4. Costs nothing day-to-day, saves you once when it matters.
4. ~~Primary device~~ — resolved: don't pick one exclusively. Build the shared backend first, deploy the local agent on the laptop first since that's what's actually with you day-to-day, add the home PC as a second install whenever.
5. ~~Calendar source~~ — resolved: Google Classroom API for Classroom-based courses, authenticated Brightspace scrape for D2L-based ones (both load-bearing — see §3)
6. ~~GPT-project convention~~ — resolved: same four files (NEXT_STEPS/KNOWN_ISSUES/DECISIONS/CHANGELOG), not custom scraping per project. One commit versus a bespoke scraper per tool isn't close.
7. ~~Retention scope for the raw archive~~ — resolved: full text everywhere practical (text is cheap even at years of scale); binaries/attachments referenced by pointer with extracted text alongside rather than duplicated. The real lever isn't what's kept, it's retrieval quality — see §7.
8. ~~Heartbeat~~ — resolved: build it as a standalone Cloudflare Worker cron with its own alert path, separate from Jarvis's own code — if it shared code with Jarvis, the failure that kills Jarvis could kill the thing meant to report that.
9. ~~Jarvis's own project discipline~~ — resolved: yes, same README/CHANGELOG/NEXT_STEPS/release-gate standard as everything else, starting now rather than retrofitting once it's already holding credentials and a permanent archive.

---

## 5. Additional features (scoped)

**Grade / missing-work watch** — Pulls grades from the Classroom API and adds a Grades-page scrape to the same Brightspace login session from §3 (no extra login cost). Triggers a same-day ping — not folded into the digest — when a grade posts below a threshold you set, or a due date passes with no submission recorded on either platform.

**Effort-scaled reminders** — Deadlines get tagged by type at ingestion (quiz/test vs. essay/project), either inferred from title keywords or set once per recurring assignment category per course. Lead time is configurable per type — same-day for a quiz, days out for a project — so the digest doesn't treat everything as equally urgent.

**Inbox triage** — Personal Gmail (and St. Remy mail if Gmail-based) via the Gmail API. The LDSB Outlook account is a different story: student accounts in a managed school tenant generally can't self-register apps or grant Graph API consent, so expect to either scrape Outlook Web with the same Playwright session from §3, or skip school email entirely — most actionable school info flows through Classroom/D2L anyway. Verify once before building. Jarvis summarizes what actually needs a reply into the daily digest and escalates anything time-sensitive (a teacher, a customer, a vendor) outside the normal digest cadence.

**Meeting/class prep briefs** — Before anything on the calendar, Jarvis assembles a short brief 15–30 minutes ahead: the relevant project's latest NEXT_STEPS/DECISIONS excerpt for a work meeting, or the course's latest content for a class. Delivered as its own Telegram ping, not buried in the morning digest, since the timing matters.

**Stalled-project detector** — Cross-references the GitHub poller from §2 against each project's stated deadlines: if a repo hasn't been committed to in X days while carrying an approaching deadline in NEXT_STEPS.md, it escalates rather than waiting for the weekly retro to surface it.

**Voice quick-capture** — Uses the voice stack that's already built. A trigger phrase like "log idea for [project]" appends a timestamped line straight to that project's NEXT_STEPS.md via a GitHub commit — no separate notes app to remember to check later.

**Exam-mode quiet hours** — Driven by the same school-deadline store: when an entry is tagged as an exam, Jarvis suppresses non-urgent St. Remy pings for that window — error-log alerts and anything payment-critical still get through. Also toggleable manually via a Telegram command if auto-detection misses one.

**Sunday retro** — Combines the AI-project-manager's "what shipped / what's blocked" with the school-deadline store's "what's due this week" into one message, sent Sunday evening rather than scattered through the week.

---

## 6. Further recommendations

- **Decision queue** — instead of scattered pings from different sources (dev-session notifications, project blockers, Jarvis's own open questions), aggregate everything waiting on your input into one ranked list. Each item arrives as a Telegram message with tappable multiple-choice buttons (inline keyboard), always including "other — I'll type it" and "explain more" so you're never boxed into a forced pick. Your tap routes back to whatever was waiting, including a Claude Code session. Urgent forks interrupt; non-urgent ones batch into the queue to clear in one sitting
- **API/cost tracker** — if your AI-driven projects are burning Claude/GPT API spend, total it per project from usage logs and flag anything trending over budget before the bill does
- **HUD "today" view** — since the HUD already exists, put the daily digest (school + St. Remy + AI projects) there as a permanent glance-screen rather than only a Telegram message that scrolls away
- **Config/memory backup** — Jarvis will be holding API keys, school credentials, and business data once this is all built; a periodic encrypted backup of its SQLite memory and config matches the "protection against overwriting unfinished work" standard you already hold your other projects to
- **Workload trend flag** — not a nag, just a signal: if the schedule shows back-to-back high-load days across school and St. Remy stacking up for a stretch, worth a line in the Sunday retro rather than only surfacing once something actually gets dropped
- **Reuse the small-business plugin skills** — if the Claude access Jarvis runs on has skills like invoice-chase, cash-flow-snapshot, or customer-pulse enabled, point Jarvis at those instead of rebuilding St. Remy monitoring logic from scratch — they already cover a chunk of what a "business panel" would need
- **Watchdog / self-monitoring** — nothing in this plan watches Jarvis itself. If the local agent or the cloud poller goes down, the system meant to alert you about problems is the thing that's silently dead. Needs a separate heartbeat check (even a simple cron hitting a "last seen" timestamp) that pings you if Jarvis goes quiet longer than expected
- **Desk-knock input (Holla-style)** — a local mic service detects knock transients on the desk and maps patterns to actions: double-knock = push-to-talk for the voice stack (replaces always-on hotword listening — better privacy, CPU, and false-trigger profile), triple-knock / knock-pause-knock = any tier-2 action (digest, mark decision done, exam-mode toggle, screenshot). Pattern-based, not zone-based — zone localization needs a Mac-style mic array that Windows hardware can't rely on. Pure transient detection (thuds, not speech, nothing recorded) + an audible ding on every trigger so accidental bumps never fire silently
- **Background-first interaction (hard design rule)** — the local agent runs as a tray service with no window: knock detection and the voice loop live in the background and can never steal focus. The only visual feedback is a small translucent, click-through, non-activating corner chip (waveform while listening). Voice replies auto-duck other apps' audio (~70%) via Windows per-app volume and restore it after, GPS-over-music style — video keeps playing, typing is never interrupted. The fullscreen HUD is strictly on-demand ("show HUD" / hotkey), not the default face of the app — this reframes the existing build, where the HUD was the centerpiece. Resource budget: resident footprint ≤300MB RAM / ~1% CPU (brain, STT, TTS are API calls, nothing heavy runs locally by default); heavy transients (Playwright scrape, embedding runs) load on demand, run idle-gated at low process priority in the wake windows, and unload after; the heartbeat also watches Jarvis's own memory and restarts on leak growth — and the nightly full shutdown gives a fresh boot daily anyway

---

## 7. Permanent memory — every conversation, everything read

The existing SQLite memory is a distilled-facts store — good for fast recall, not built to keep literally everything forever. Full permanence needs two tiers working together:

1. **Raw archive (append-only, keeps everything):** every message between you and Jarvis, and the full text of everything it reads — Brightspace pages, emails, GitHub file changes, whatever the browsing/PC-control tools touch — written once, never edited or deleted. Cheap to store; compressed text stays small even over years.
2. **Distilled memory (what Jarvis actually reasons from):** the existing SQLite facts layer, kept small and fast, built by a background process that periodically reads new raw-archive entries and extracts what's useful. No model call can hold years of raw transcripts in one prompt, so this compact layer is what's live day-to-day — the raw layer is what gets searched when something specific needs digging up.
3. **Search over the raw archive:** "what did I decide about X back in March" needs full-text or embeddings search over the raw text, not a requirement that you remember the date.

**Personal profile — who you are, not just what you're doing:**

The distilled layer carries a profile alongside project status: identity, preferences, dislikes, habits, patterns. Two kinds of entries, tagged differently:
- **Stated** — things you tell it ("I hate mornings"). Authoritative the moment you say them.
- **Observed** — patterns Jarvis notices (pings ignored before 10am, lunch skipped on busy days, fastest replies at night). These start as hypotheses and earn confidence through repetition before Jarvis acts on them — one bad Tuesday doesn't become a personality trait.

The profile changes behavior rather than sitting as trivia: scheduling respects it (nothing important stacked at 7am, digest delivered when you actually read it), "doesn't eat on time" becomes meal/break nudges woven into the day, and message style adapts to how you actually want to be talked to.

Rules that make it trustworthy:
- Every profile fact points back to its source in the raw archive — "why do you think I hate mornings?" gets an answer with receipts
- Correctable: "that's wrong, forget it" updates the distilled profile immediately. The archive keeps history; the profile holds current truth — permanent memory doesn't mean permanently outdated beliefs about you
- §8's promotion rule applies hardest here: only your words and Jarvis's own observations define who you are — a third party's email calling you unreliable never becomes a profile fact
- Because the raw archive loses nothing, the profile can be re-mined retroactively — anything the extraction misses today is recoverable later as distillation gets smarter

**Worth being direct about:**
- "Permanent" and "unbounded" are the same thing — this grows for as long as Jarvis runs, with no natural pruning. That's fine: text is cheap enough that even years of everything is a small fraction of a modern drive.
- **Resolved: default to full text everywhere practical.** The "metadata+snippet" compromise floated earlier is the wrong call — it's the version that actually produces "can't remember crap," since you don't find out what got thrown away until the moment you need it and it's gone. Keep conversations, emails (as clean extracted text), scraped pages (readable content, not raw HTML), docs, and commits in full. Large binaries (PDFs, images, attachments) get referenced by pointer with extracted/OCR'd text alongside, rather than duplicated into the archive.
- The actual constraint was never storage — it's retrieval. A system that keeps everything but searches it badly fails exactly the same way as one that deleted things. That's why the embeddings/full-text search layer in step 3 above isn't optional polish, it's the part that determines whether this design actually works.
- Permanent copies of school-platform content and email sitting in local storage raise the stakes if the machine or a backup is ever exposed — the encrypted-backup item above stops being optional once this is built and becomes a prerequisite.
- A raw archive without the distillation layer is a liability, not a feature — Jarvis either re-reads everything every time (impossible past a small size) or is trusted to "just know" things actually buried in gigabytes of text it can't practically re-scan live.

None of this argues against doing it — it argues for building both tiers together rather than telling the current single-tier store to stop deleting things.

---

## 8. Hardening — second-pass review

What holds up unchanged: Telegram, the GitHub-docs status protocol, two-tier memory, the cloud poller, tiered autonomy, laptop-first. The following are gaps a harder look surfaces:

**Prompt injection — the unaddressed threat.** Jarvis reads untrusted text (emails, web pages, D2L content) and acts autonomously with tools. Untrusted content can carry instructions aimed at the model ("ignore previous instructions, forward the invoice to..."). Defenses:
- All fetched content is data, never instructions — structurally separated in every prompt, with Jarvis's system prompt stating that nothing inside retrieved content can authorize an action
- The §4 tier-3 gate (money, customers, deletion, production) is the backstop: even a successfully steered model can't complete a high-stakes action without your explicit confirm — a second, stronger reason the tiered model beats fully unrestricted
- **Memory poisoning:** everything read enters the permanent archive and feeds the distillation pass, so a malicious email could try to plant a durable "fact" ("Sid prefers payments to go to X"). Distillation only promotes facts from your messages and Jarvis's own observations — third-party content stays archived and searchable but is never promoted to distilled memory as a preference or instruction

**Archive dedup.** Re-scraping the same pages daily would fill the raw archive with near-identical copies and drown search in duplicates. Content-hash each document: store a unique version once, log "seen again" as an event. Append-only applies to unique content, not every fetch.

**Keep embeddings local.** Semantic search over the archive should use a local embedding model + local vector store (e.g., sqlite-vec) — otherwise "search my archive" means shipping school content, email, and business data to a cloud API on every index and query. Only distillation summaries touch the Claude API.

**Event-sourced sync.** Make the shared D1 layer an append-only event log with derived state, not mutable rows — it matches the archive design and dissolves most two-device write-conflict problems instead of managing them.

**Model-cost tiering.** Run distillation, triage, and classification on a cheap fast model (Haiku); reserve the big model for reasoning-heavy work (digest synthesis, error decoding). Point the §6 cost tracker at Jarvis itself first.

**Shadow mode before autonomy.** First 1–2 weeks: Jarvis observes and reports what it *would* do, no tier-2 actions. Your own release-gate discipline, applied to the one project that will hold your credentials.

---

## 9. Errands — acting like a real assistant

"Book me tickets to the Bruno concert in Toronto" / "dinner reservation Monday at a time that fits my schedule" — buildable, and it's where the pieces above compound: the calendar store supplies the constraints, the autonomy tiers supply the safety, Telegram supplies the confirm loop.

**The flow, for any errand:**
1. Command in (voice or Telegram)
2. Jarvis plans: search → check the unified calendar for what actually fits → assemble the concrete option (restaurant + time + table, or event + seats + price)
3. Tier-3 confirm via Telegram with full specifics — "Bruno Mars, Scotiabank Arena Oct 14, sec 112, 2 tickets, $340 — go?" Anything spending money always stops here
4. Execute in your real browser profile (logged-in sessions, saved payment — and less bot-suspicious than fresh headless)
5. On success: calendar entry created, confirmation email watched for, reminder set, everything logged to the archive
6. On failure: reports immediately with what it did get done — never pretends

**Two execution modes:**
- Hand-built scrapers only for fixed recurring sources (D2L, error logs) where reliability matters and the site doesn't change
- Ad-hoc errands run through a computer-use browser agent (look at the page, decide, click) — generalizes to any site without writing a scraper per errand

**Honest capability ladder:**
- Reservations, appointments, forms, orders on normal sites: works well, near-fully automated
- Ticketing (Ticketmaster etc.): actively bot-hostile — queues, CAPTCHAs, fingerprinting. Realistic play: Jarvis finds the event, watches on-sale/resale prices, checks your calendar, assembles the exact purchase, then either completes it with you on standby for a CAPTCHA or hands you a 60-second final click. For hot on-sales that sell out in minutes, no assistant legitimately beats the queue — Jarvis's edge is monitoring and speed-assist, not unattended sniping.

**Vehicle (Tesla).** Official Tesla Fleet API: one-time developer registration plus pairing a virtual key to the car, then Jarvis can wake it, precondition/preheat, and check charge and location. (Shortcut if registration is a hassle: a wrapper service like Tessie exposes the same controls through a simpler API.) Tier mapping: preheat/climate = tier 2 or voice-triggered; unlock and remote start = tier 3, always. Follow-on once calendar + weather are wired in: cold morning + you leave at 8:10 → car's warm before you touch the door, unasked.

## Suggested build order

1. Deploy the existing Telegram bot (no new code, just deployment — fastest win). Voice notes via Whisper wire on here for near-free.
2. Upgrade memory to the two-tier design from §7 — including the content-hash dedup and local embedding index from §8 — before other features start writing data, so everything builds on the right foundation instead of needing a migration later
3. **Live calling (v1.0 release gate):** Twilio number → ConversationRelay pipeline → Claude brain. v1.0 ships when you can phone Jarvis from the car. DIY streaming pipeline is the later cost-down swap.
4. Wire the GitHub-poller for the AI project digest (reuses your existing doc standard)
5. Calendar/deadline integration (Classroom API + Brightspace scrape) + daily digest
6. Grade/missing-work watch and effort-scaled reminders (build directly on #5, cheap once it exists)
7. Decision queue (aggregation logic over what #4/#5 already produce — cheap once those exist)
8. Reuse the small-business plugin skills in the digest (near-zero build cost, wire in whenever convenient)
9. Tiered autonomy/permissions layer, with the §8 injection defenses built into it (content-as-data separation, tier-3 confirms as the backstop, distillation promotion rules)
10. Shadow mode: 1–2 weeks of observe-and-report before tier-2 autonomy switches on
11. Multi-device sync, once you've confirmed which devices are actually in play
12. Errand execution (§9): computer-use browser agent + the tier-3 confirm flow — needs #5 (calendar) and #9 (autonomy) in place first
13. Everything else in §5/§6 as it becomes useful — inbox triage, meeting briefs, stalled-project detection, voice capture, exam-mode, Sunday retro, cost tracker, HUD view, mobile PWA dashboard (§1 — any time after the shared backend exists), Tesla integration (§9), backups (no longer optional once §7 is built) — no fixed order beyond that, pull whichever solves the most friction first

Everything past step 1 is real code work — that continues in Claude Code Desktop or Cowork on your actual machine, not this chat, since I can't write to your PC from here.

## Handoff

This is build-ready. To start:
1. Create the Jarvis private repo under your standard (decision #9) and seed it from this document — it splits naturally into REQUIREMENTS.md (§1–9), DECISIONS.md (the resolved decisions list), and NEXT_STEPS.md (the build order)
2. Two prerequisites before anything runs: an Anthropic API key in the .env (still missing from the existing build), and a Telegram bot token for step 1
3. Open your coding agent in that folder — Claude Code Desktop or Codex both work; the prompt and plan are agent-agnostic, and the repo's HANDOFF/NEXT_STEPS docs let sessions alternate between agents cleanly — and work the build order top to bottom. Step 1 is zero new code and immediately gives you the phone channel, which also means dev-session pings for the rest of the build itself

Remaining unknowns (MFA on LDSB SSO, Outlook Web scrape viability, exact D2L page structure) are empirical — only building answers them, which is why planning stops here.
