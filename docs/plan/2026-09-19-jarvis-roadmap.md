# Jarvis Roadmap

**This is the owner's own document, written by Sid on 2026-09-19, and it is the
authoritative plan.**

Read this before any other plan in this repository. Where a design document, a
milestone, a handoff or an existing implementation disagrees with it, **this
document wins and the other one is stale.** Say so in the pull request that
fixes the other one rather than working around the contradiction.

This document is organised around one brain with tools. The milestone roadmaps
that preceded it are deleted, not archived: each milestone had its own wiring, so
capabilities landed wherever their milestone lived, which is how the phone and
Telegram became two separately composed assistants. **There are no `R` numbers.**
Anything citing one is reading something that no longer exists.

---

## We are not building the brain

**Jarvis is the brain. We build the body.**

Every hour spent here goes into four things, and only four:

- **Hands** — tools. Small, concrete, single-purpose. Save this fact. Read this
  email. Place this call. A tool performs. It never decides whether to perform.
- **Senses** — wake-ups and provenance. A cron, an alarm, a webhook saying
  *something happened*, or *it's time*. And the facts the model cannot see for
  itself: is this forwarded? is this the owner's own text? is this a private chat?
- **Memory** — storage, the ledger, backups, the indexes.
- **Proof** — receipts, enforced taps, audit rows. If Jarvis says it happened,
  code must be able to show it happened.

Everything else is judgment, and judgment is Jarvis's.

What is worth remembering. What an email means. Whether a deadline is new or
updated. How long a fact lasts. When to call rather than text. How to speak on a
phone. When to stay quiet.

We do not write those. We write the surface it decides from — the tool
description, the system prompt — and then we get out of the way.

### Why it has to be this way

Because a model's judgment has four hard limits, and each one is a harness, not a
competitor to it:

1. **It cannot know what the channel said.** Provenance lives outside the
   conversation.
2. **It cannot enforce its own decision against a later prompt.** It can decide an
   email needs a tap; it cannot stop the next message talking it out of that. This
   is the entire reason tier 3 exists — not distrust of the judgment, but the
   judgment's inability to enforce itself.
3. **It cannot remember, and it cannot wake up.**
4. **It cannot prove anything.** A receipt the model writes is a claim. A receipt
   code writes is evidence.

So code does those four and nothing more. Not because the model is untrusted —
because those are the things it structurally cannot do.

The body parts map onto the limits exactly: **Senses** answer limit 1, **Proof**
answers limits 2 and 4, **Memory** answers limit 3, and **Hands** are how the
judgment reaches the world at all.

### The check, and it is one question

> **Am I writing code that decides, or code that enables?**

If you catch yourself writing an `if` that makes a judgment call — how many
results, what counts as relevant, whether to act at all — stop. That `if` is a
decision, and decisions belong in the prompt or a tool description.

A sharper form of the same check, for settling an argument: **if a chat model
could do it, assuming every permission were granted, there is no need to code it.**
The question is always whether the model *can* do it at all — never whether it
*might get it wrong*. Being occasionally wrong is what judgment is, and code does
not win the job back by being more predictable.

There are already nine recorded instances of this in the codebase. Each one is a
piece of Jarvis's brain that got written in the wrong language. A tenth is not
progress. (They are inventoried in the memory redesign spec, PR #122 — unmerged
at the time of writing, and its first entry describes a path that exists in the
tree but is not wired in production.)

### What Jarvis is, in one line

A personal chat model outside the sandbox, with memory that does not end at a
context window and permissions its owner has actually granted. It can send the
email, book the table and use the card **because it was asked to and is
authorized**, not because a safety rule was removed. The gates in Phase 4 exist
so the owner knows before money moves — the same courtesy a human assistant
would extend — and not because the model is distrusted.


## Architecture

- **Twilio:** your phone number for texts and calls
- **Worker (router):** receives Twilio webhooks, email, and HTTP requests, then passes them to Jarvis
- **Durable Object (Jarvis):** one persistent instance that holds conversation state, runs the model loop, and calls tools. Texts, calls, emails, and wake-ups all go to this same brain.
- **DeepSeek V4.1 Flash:** the intelligence, with tool calling. See **The model** below
- **D1:** structured data (facts, courses, deadlines, receipts, settings)
- **Vectorize:** meaning search over memory
- **Workers AI:** embeddings for Vectorize
- **R2:** raw emails, conversation archive, backups
- **Queues:** hand-off for slow work like email processing
- **Cron Triggers and DO alarms:** wake-ups
- **External watchdog:** Healthchecks.io or UptimeRobot
- **PC script:** Obsidian vault sync

## The model

**DeepSeek V4.1 Flash, everywhere.** Decided by Sid on 2026-09-20. Earlier drafts
of this document said "Claude API"; the code has always called DeepSeek, and this
resolves the contradiction in favour of the code.

**The reasoning, so nobody re-opens it.** Frontier models differ on deep
reasoning, long-context coding and heavy analysis. Jarvis does none of those
daily. Answering a question, writing an email, reading a D2L notification,
deciding what is worth remembering -- any modern model does these the way any
competent assistant would. Once capability is equivalent, the decision is cost
and latency, and nothing matches Flash on either.

**Do not "fix" this back.** A session that reads "Claude" in an older document
and changes the code is making the repository disagree with its owner.

**The one place this could matter, and how to settle it.** This roadmap moves
judgment out of code and into the model: attribution, what is worth remembering,
how long a fact lives, which tier an action falls into. Those decisions are rare
and they fail *silently* -- a wrong fact, not a crash. If that ever proves to be
a problem, the seam already exists: `MEMORY_EXTRACTION_MODEL` (`env.ts`, read at
`index.ts`) defaults to `DEEPSEEK_MODEL` and can point at a stronger model for
extraction alone, with no code change. Settle it by observing real extractions
after a deploy, not by argument.

## Phase 1: The Brain

**Goal:** text Jarvis any time and have a real conversation with it.

**Code builds:**

- Cloudflare Workers project with the domain, D1, R2, Vectorize, and Queues set up
- Jarvis email address on the domain with school emails auto-forwarding to it, received by an Email Worker
- Twilio number with the SMS webhook pointed at the router Worker
- Twilio request signature check on every webhook
- The Jarvis Durable Object with the model loop: receive an event, build context, call the model, run any tool calls, repeat until it replies, send the reply
- `send_text(message)`: sends you an SMS through Twilio
- Conversation storage in the DO: recent messages kept in full, older ones summarized when context gets long (code triggers the summary, Jarvis writes it)
- Tool-call logger: every tool call recorded with time, tool, input, result, and what triggered it (text, call, email, wake-up). This becomes Receipts.
- Current date, time, and your timezone injected into every turn

**Jarvis decides:**

- How to respond, how long, what tone
- Which tools to call and in what order

**Done when:** you can text at 2am and get a sensible reply that remembers earlier in the conversation.

## Phase 2: Memory

**Goal:** Jarvis knows you without ever being told to remember.

**Code builds:**

- D1 `facts` table: `id`, `text`, `kind` (durable or temporary), `confidence` (stated, inferred, confirmed), `source_type` (conversation, call, email), `source_ref` (link to the exact message or email), `created_at`, `expires_at`, `superseded_by`, `hidden`, `pinned`
- Embeddings for every fact through Workers AI, stored in Vectorize with the fact ID
- Tools:
  - `memory_save(text, kind, confidence, source, expires_at?)`: Remember
  - `memory_correct(fact_id, new_text, reason)`: Correct, creates a new version and links the old one to it, never overwrites
  - `memory_forget(fact_id)`: Forget, sets `hidden`, excluded from all recall
  - `memory_restore(fact_id)`: Restore, unhides it
  - `memory_confirm(fact_id)`: Confirm, marks an inferred fact as confirmed
  - `memory_explain(fact_id)`: Explain, returns every version with its dated source
  - `memory_search(query)`: Meaning search, searches Vectorize, drops hidden and expired facts, returns matches
  - `memory_pin(fact_id)` and `memory_unpin(fact_id)`: marks facts as part of your core profile
- Core profile: all pinned facts injected into the system prompt on every single turn
- Temporary facts automatically drop out of recall after `expires_at`
- Auto-extraction wake-ups:
  - after a conversation goes quiet for a while, an alarm wakes Jarvis with "review this conversation"
  - hourly cron wakes Jarvis with "review the last hour of activity"

**Jarvis decides:**

- What's worth remembering, without being asked ("I hate mornings" gets saved the moment you say it)
- Whether something is durable or temporary ("I'm tired today" expires tonight)
- Whether it was stated or inferred
- When a new fact contradicts an old one and should be a correction
- What belongs in your core profile
- When to search memory and what to search for
- When to ask you to confirm something it's unsure about
- What to save during reviews and what to ignore

**Done when:** you mention you hate mornings once, and a week later it acts on that without being reminded.

## Phase 3: School

**Goal:** Jarvis knows your academic life better than you do.

**Code builds:**

- D1 tables:
  - `courses`: code, name, term, instructor, notes
  - `assignments`: course, title, due date with explicit timezone, weight, status, source
  - `grades`: course, item, score, out of, weight, date
  - `applications`: program, school, status, deadline, requirements, notes
  - `study_items`: course, topic, question, answer, times seen, times correct, last seen
- D2L email ingest pipeline:
  1. Email Worker receives the forwarded email
  2. Raw email saved to R2, row added to an `emails` table as unprocessed
  3. Message pushed onto a Queue
  4. Queue consumer wakes Jarvis with "new email arrived"
- Tools:
  - `email_read(email_id)`: returns sender, subject, date, and clean body (parsed with `postal-mime`)
  - `email_list_unprocessed()` and `email_mark_processed(email_id, note)`
  - `course_upsert(...)`, `assignment_upsert(...)`, `assignment_list(filters)`
  - `grade_record(...)`, `grades_get(course)`
  - `application_upsert(...)`, `applications_list()`
  - `study_item_create(...)`, `study_items_get(course, topic?)`, `study_result_log(item_id, correct)`
- Optional: if Brightspace gives you a calendar feed URL, `d2l_calendar_fetch()` to pull it

**Jarvis decides:**

- What an email means: new assignment, changed due date, grade posted, announcement, or noise
- Whether an assignment already exists and should be updated instead of duplicated
- The exact due date and time, with the right timezone
- School update: what changed and whether it matters enough to tell you now
- University update: where each application stands and what's coming up
- Study coach: what to quiz you on, when to make flashcards, which topics are weak spots based on your results, how hard to push

**Done when:** a D2L email arrives and the deadline appears correctly with nothing from you.

## Phase 4: Control

**Goal:** Jarvis can act on its own safely before it starts calling and scheduling.

**Code builds:**

- Tiers: described in the system prompt as guidance:
  - Free: reading, remembering, reminding, answering, updating school data
  - Ask first: spending money, contacting anyone other than you, deleting things, anything irreversible
  - Jarvis judges which tier a new situation falls into
- Confirmations:
  - `request_confirmation(action, details)`: stores the action in a `pending_actions` table and texts you a short summary
  - Your YES or NO reply resumes or cancels it
  - Tools that move money, contact other people, or hard-delete always route through `pending_actions`, so Jarvis's decision to ask actually holds
- Receipts:
  - Built from the Phase 1 tool log
  - `receipts_query(time_range, filter?)`: so you can ask "what did you do today?" and get proof
- Shadow mode:
  - `settings` table with a global shadow flag and per-feature flags
  - When shadow mode is on, action tools don't execute; they log "would have done X" as a receipt and return that to Jarvis
  - Current shadow state injected into the system prompt so Jarvis knows it's practicing
  - `settings_update(key, value)`: so you can just tell Jarvis to turn it on or off

**Jarvis decides:**

- Which tier each action falls into
- When something needs your tap
- How to summarize the action clearly for your confirmation
- How to report what it would have done in shadow mode

**Done when:** any new feature can run in shadow mode for a few days, then go live with one message.

## Phase 5: Calling

**Goal:** call Jarvis and have Jarvis call you, with one shared brain.

**Code builds:**

- Twilio voice webhook returns TwiML that connects the call to ConversationRelay, pointing at a WebSocket on the Jarvis Durable Object
- Speech comes in as text, Jarvis replies as text, Twilio speaks it
- Current channel (voice or text) injected into the prompt
- Call transcripts saved to the conversation history so memory review picks them up
- Inbound: caller identified by phone number
- Outbound: `call_place(reason)`: starts a Twilio call to you that connects to the same WebSocket
- Voice PIN:
  - Your PIN stored as a hash
  - `pin_verify(pin)`: returns true or false
- Guest calls:
  - `guests` table: name, phone, PIN hash, what they're allowed to access, expiry
  - `guest_create(name, access, expiry)` and `guest_revoke(guest_id)`
  - The guest's access description is injected into the prompt for that call

**Jarvis decides:**

- How to talk on the phone: shorter, spoken naturally, no lists
- When to ask for your PIN before something sensitive
- When calling you is better than texting
- What a guest can hear based on their access
- What from the call is worth remembering

**Done when:** you call and ask what's due this week and get the same answer you'd get by text.

## Phase 6: Daily Rhythm

**Goal:** Jarvis runs your week without being asked.

**Code builds:**

- `schedule_wakeup(time, reason)`, `list_wakeups()`, `cancel_wakeup(id)`
  - A Durable Object only holds one alarm at a time, so code keeps a list of wake-ups in storage and always sets the alarm to the earliest one
- Cron Triggers for fixed checks (note: Cloudflare cron runs in UTC, so account for Eastern time and daylight saving)
- Hourly poll: cron wakes Jarvis with "hourly check" (unprocessed emails, calendar feed, anything scheduled)
- Hourly run also pings the watchdog (Phase 7)

**Jarvis decides:**

- Morning digest: what time to send it based on what it knows about you (not 7am if you hate mornings), what's worth including (what's due, what changed), and whether to text or call
- Sunday retro: what happened this week, what went well, what slipped, what's coming next week
- Hourly poll: whether anything found is worth interrupting you for or can wait for the digest
- When to schedule its own future wake-ups ("remind them the night before the essay is due")

**Done when:** you get a useful digest every day at a time that suits you, without asking.

## Phase 7: Plumbing

**Goal:** Jarvis is reliable, backed up, and visible.

**Code builds:**

- Nightly backup: cron exports all D1 tables to dated JSON files in R2 (D1 also has Time Travel for point-in-time recovery as a second layer)
- Archive:
  - Every conversation (texts and call transcripts) saved to R2 by date
  - `archive_search(query, date_range?)`: so Jarvis can look back further than memory
- Watchdog:
  - Jarvis's hourly run pings a Healthchecks.io URL
  - If the ping stops, Healthchecks.io texts or emails you
  - Runs outside Cloudflare so it still works if Jarvis is down
- Vault sync:
  - `/vault/export` endpoint protected by a secret token, returns facts, courses, deadlines, and applications
  - Small Python script on your PC runs on a schedule, pulls the export, and writes markdown files into your Obsidian vault with frontmatter
  - One-way: Jarvis is the source of truth, the vault is a mirror

**Jarvis decides:**

Nothing here needs judgment, which is why it's the only phase that's all code.

**Done when:** Jarvis could run a month untouched and still be alive, backed up, and mirrored to your vault.

## Where the Real Work Is

Since Jarvis makes every decision, two things determine how good it is:

**The system prompt should include:**

- Who Jarvis is and that it's your personal assistant
- Your core profile (pinned facts, injected automatically)
- Its job: notice and remember things about you without being asked, keep your school life on track, act like a thoughtful person, not a command system
- Tier guidance: what it does freely vs. what it asks about first
- Current time, timezone, channel (text or voice), and shadow mode state
- How to behave on each channel

**Tool descriptions should say:**

- What the tool does
- When it's useful, with a short example
- What each input means

A clear tool description gets used well. A vague one gets misused or ignored. Most of the "feels like a real person" quality comes from these two places, not from code.
