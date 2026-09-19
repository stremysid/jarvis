# Gap: the roadmap against what is actually built

**Companion to [`2026-09-19-jarvis-roadmap.md`](2026-09-19-jarvis-roadmap.md).**
Every row was checked against the code on `main` on 2026-09-19, not against a
document. Where a row says something is missing, the check that establishes it is
given, so it can be falsified rather than believed.

This exists so a builder does not rebuild something that already works, and does
not assume something works because a milestone document once said so.

**Verdicts:** ✅ built and matches · ◐ built but differs · ⛔ not built

---

## The shape, before the phases

The single biggest difference is not in any phase. The roadmap puts **one
persistent Jarvis Durable Object** at the centre: texts, calls, emails and
wake-ups all reach the same brain, which holds conversation state and runs the
Claude loop.

What exists is **one stateless Worker for Telegram and a separate `CallSession`
Durable Object for voice**, each composing its own model adapter, its own memory
retriever and its own tool set.

```
wrangler.toml declares exactly one DO binding:
  [[durable_objects.bindings]]
  name = "CALL_SESSION"
  class_name = "CallSession"
```

There is no Jarvis DO. Everything below inherits that: a capability added to one
path does not reach the other, which is how voice ended up with zero tools.

Also structural, and worth saying once rather than in every row:

| Roadmap says | Reality |
|---|---|
| Claude API | DeepSeek. `DeepSeekModelAdapter`, `DEEPSEEK_MODEL`, `DEEPSEEK_API_KEY` |
| Text is **SMS via Twilio** | Text is **Telegram**. Twilio is voice-only — `git grep twilio` hits voice routes, callbacks and the outbound call dispatcher, and nothing that sends a message |
| Queues for slow work | No Queues binding in `wrangler.toml` |
| External watchdog (Healthchecks.io) | An internal `apps/watchdog` Worker. Nothing pings an outside service — `git grep -E "healthcheck|uptimerobot|hc-ping"` returns nothing |

---

## Phase 1: The Brain

| Item | Verdict | Detail |
|---|---|---|
| Workers project, D1, R2, Vectorize | ✅ | `DB`, `ARCHIVE`, `BACKUP`, `AI`, `MEMORY_VECTORS` all bound |
| Queues | ⛔ | No binding |
| Jarvis email address, Email Worker | ✅ | `email()` handler → `handleD2lNotificationEmail`. **Not live**: the Cloudflare routing rule for `school@onesid.ca` still points at Gmail |
| Twilio number + SMS webhook | ⛔ | Twilio is wired for voice only. No SMS send or receive path exists |
| Twilio signature check | ✅ | `TwilioSignatureVerifier`, on every voice webhook |
| One DO running the Claude loop | ◐ | Two separate paths, neither of them a Jarvis DO. See above |
| `send_text(message)` | ⛔ | No SMS sender. The equivalent today is the Telegram sender |
| Conversation storage + summarisation | ✅ | Committed turns in D1, archive segments to R2 (`archival-service.ts:138`) |
| Tool-call logger → Receipts | ◐ | Receipts exist widely (59 files) and gate decisions are recorded. There is no single `tool_calls` table logging every call with trigger, input and result |
| Time, date, timezone every turn | ◐ | Not verified this pass. Check before building |

## Phase 2: Memory

The storage exists and is more elaborate than the roadmap asks for. **The
promotion rule is the defect**, and it is the reason memory feels absent.

| Item | Verdict | Detail |
|---|---|---|
| `facts` table with the listed columns | ◐ | `memory_item_state` / `memory_item_versions` cover text, source, versioning, hidden and superseded |
| `kind` durable vs temporary, `expires_at` | ⛔ | `git grep -E "expires_at\|expiresAt"` over `src` returns **nothing**. Temporary facts do not exist |
| `confidence` stated / inferred / confirmed | ◐ | An `uncertain` flag plus an origin of `authenticated_first_person` or `model`. Not the three-value field |
| `pinned` and a core profile in the prompt | ⛔ | `git grep -E "pinned\|core profile"` returns **nothing**. Nothing is injected into every turn |
| Embeddings → Vectorize | ✅ | Workers AI + `jarvis-memory-bge-m3`, indexed by the hourly job |
| `memory_save` / `correct` / `forget` / `restore` / `confirm` / `explain` / `search` | ✅ | All exist as model-called tools with `toolChoice: "auto"` |
| `memory_pin` / `memory_unpin` | ⛔ | Not built |
| Auto-extraction on a quiet-conversation alarm | ⛔ | No DO alarms anywhere — `git grep -E "setAlarm"` returns nothing |
| Hourly auto-extraction | ✅ | Runs. Production shows 36 runs |
| **Facts are usable without being asked** | ⛔ | **This is the one that matters.** Live D1: `proposed: 5, active: 0`. `memory_retrievable_item_versions` is `WHERE lifecycle_state = 'active'`, so recall returns nothing. Auto-promotion exists but requires the fact to be your **entire message verbatim** (`extraction-policy.ts:158`), which conversation never satisfies |

**Phase 2's "done when" is not met and will not be met by adding anything.** It
needs the promotion threshold changed and, per the roadmap, Jarvis deciding when
to ask rather than code requiring a tap.

## Phase 3: School

The strongest phase. Nearly all of it works.

| Item | Verdict | Detail |
|---|---|---|
| `courses`, `assignments`, `grades`, `applications`, `study_items` | ✅ | All present |
| Email → R2 → `emails` table → Queue → wake Jarvis | ◐ | Email arrives and is handled synchronously. No R2 raw-email store, no `emails` table, no Queue |
| `postal-mime` parsing | ✅ | `school/d2l-email-handler.ts` |
| Course / assignment / grade / application tools | ✅ | `school_update`, `university_update` |
| Study coach tools | ✅ | `study_coach`, with a practice model |
| Brightspace calendar feed | ⛔ | **Impossible.** The board's Brightspace exposes no iCal feed. Never ask for one |
| Google Classroom | ⛔ | **Impossible.** Microsoft 365 school account cannot reach Cloud Console |

## Phase 4: Control

Exists, but as the hardcoded version of what the roadmap wants as judgement.

| Item | Verdict | Detail |
|---|---|---|
| Tiers as prompt guidance, Jarvis judging | ⛔ | Tiers are a D1 table, `capability_tiers`, looked up per capability. `decideOutcome(tier, mode)` takes no other input. An unregistered capability is denied, not judged |
| `request_confirmation` + `pending_actions` | ◐ | `tool-confirmations.ts` with a decision queue. Two known holes: a confirmation binds `capability:argumentsHash` and **not the tool name** (five tools share `memory.write`), and it is never marked consumed, so it replays for ten minutes |
| Receipts, `receipts_query` | ◐ | Receipts are produced everywhere; no query tool for "what did you do today" |
| Shadow mode, per-feature flags | ◐ | One global `autonomy_mode`. No per-feature flags. `/shadow` toggles it |
| Shadow state in the system prompt | ⛔ | Not verified present. Jarvis is not told it is practising |
| `settings_update(key, value)` | ⛔ | Not a tool. `/shadow` is a slash command |

## Phase 5: Calling

Built, switched off, and missing the thing that makes it worth switching on.

| Item | Verdict | Detail |
|---|---|---|
| TwiML → ConversationRelay → WebSocket on a DO | ✅ | `CallSession` DO, real Twilio wiring |
| Speech in as text, reply spoken | ✅ | |
| Channel injected into the prompt | ◐ | Not verified |
| Transcripts into conversation history | ✅ | Committed as conversation events |
| Inbound caller identified by number | ✅ | Caller ID only — no STIR/SHAKEN |
| `call_place(reason)` | ✅ | `/call <reason> --confirm` |
| Voice PIN, hashed | ✅ | Peppered HMAC + 600,000 chained PBKDF2. **But a spoken 4-digit PIN is not redacted from the transcript** — verified by executing `sanitizeRedaction`; PR #96 fixes the digit case only |
| `guests` table, create / revoke, access in prompt | ✅ | Guest grants, PIN attempts capped at 3, durable |
| **The call shares the brain** | ⛔ | **It does not.** Zero tools, and `D1ContextRetriever` instead of the real retriever — no meaning search, no `/why` |
| A live call has ever happened | ⛔ | Never. Secrets not loaded |

## Phase 6: Daily Rhythm

| Item | Verdict | Detail |
|---|---|---|
| `schedule_wakeup` / `list_wakeups` / `cancel_wakeup` | ⛔ | No DO alarms at all. Jarvis cannot schedule its own future |
| Cron triggers | ✅ | Four: `*/5`, hourly, and two daily pairs |
| Hourly poll | ✅ | Email, deadlines, distillation, meaning indexing |
| Watchdog ping from the hourly run | ◐ | An internal watchdog exists. **It has never once recorded a gateway heartbeat** — every cron logs `status 404` |
| **Jarvis chooses the digest time** | ⛔ | Digest time is a cron expression. Jarvis composes the content, not the timing |
| Sunday retro | ✅ | Content is composed, but carries no workload or cost line |
| Jarvis decides whether to interrupt | ⛔ | The hourly job decides |

## Phase 7: Plumbing

The most complete phase.

| Item | Verdict | Detail |
|---|---|---|
| Nightly D1 backup to R2 | ✅ | Wired into the night cron, with a fail-closed restore path |
| Conversation archive to R2 | ✅ | `archival-service.ts` |
| `archive_search` | ◐ | Archive is queryable; not exposed as a tool |
| External watchdog | ⛔ | Internal Worker only. Nothing outside Cloudflare would notice an outage |
| `/vault/export` + PC script | ◐ | Different design: a Python local agent walks an Obsidian vault. **It cannot see past the first 64 notes**, in any number of runs |

---

## What this says about order

1. **Memory promotion.** Phase 2's "done when" is the sentence the owner has
   repeated most, and it fails today for one reason in one function. Smallest
   change, largest visible difference.
2. **One brain.** Until both doors compose the same agent, every capability
   added lands on one side. This is the defect that generates the others.
3. **Tiers as judgement.** Phase 4 exists as the hardcoded inverse of what the
   roadmap asks for. Changing it is what makes the core rule true rather than
   aspirational.
4. **Wake-ups.** `schedule_wakeup` unlocks most of Phase 6. Nothing else in
   Phase 6 matters while Jarvis cannot schedule itself.
5. **SMS.** The roadmap's front door is a text message and there is no SMS path
   at all. Decide whether Telegram *is* that door before anyone builds one.

Not in this list, and deliberately: Classroom and the Brightspace feed. Both are
impossible on this board, and the roadmap's Phase 3 already routes around them
through notification email.
