# PR #59 round 2 — second-reviewer adversarial pass at 7fd25ff

**Verdict: changes requested.** 7 of 8 round-1 items fixed in code, M1 only partly fixed. New: **1 High, 3 Medium, 5 Low.** The High is M1's leftover: a forwarded Telegram message still gets filed as Sid's own confirmed words.

Probes, scripts and output are in `scratchpad/pr59/agent/`: `m1-probe.ts/.out`, `m1-overdemote.ts/.out`, `sql-probe.mjs/.out`, `r1/probe-r1.mjs`, `redact-probe.ts`. The functions were copied from `git show 7fd25ff:` and the migrations 0001–0026 were applied to `node:sqlite` with the repo's `splitMigration`.

## Round-1 items

| Item | Status | Evidence |
|---|---|---|
| H1 wedge on over-budget text | **FIXED** | The production caller (`job-table.ts:420`) passes only `runKey`, so the defaults apply and narrowing runs. `automatic-distillation.ts:577-592` halves the eligible count: 8→4→2→1 always reaches one event by attempt index 3 (the cap is 4 attempts). A single event over budget is skipped with `text_budget_exceeded` and the cursor advances (`:578-585`). **64 KiB is fine:** accepted Telegram text is capped at 32 KiB (`telegram-types.ts:14,226`), so no single Telegram message can ever be skipped for size. Only a voice or other event over 64 KiB can be. |
| H2 throughput | **FIXED** (see N3, N4) | Only eligible events count (`:371-381`), 40 raw events are scanned per step, and there are 8 steps per poll (`job-table.ts:64,419`). A delivered Telegram turn is 5 events (accepted, user_committed, dispatch_checked, assistant_staged, assistant_delivered). That gives 8 turns per step and **64 turns/hour**, or 56/hour at 6 events per turn. A 150-turn evening keeps up if spread over 3 hours or more, and clears within 3 polls if bunched into one hour (round 1 managed 1.6/hour). **Keys:** `memory-distill:<UTC hour>:<step>`, plus `:nK` for narrowing and `:rK` for retry. These are distinct, never truncated, and a same-hour re-run collides at `:0` and throws, which is safe. The loop is bounded at 8 steps × 4 attempts × (1+3) key retries. Every step the loop continues past has advanced the cursor, except N7. |
| M1 third-party speech as owner fact | **PARTIAL** | The round-1 input and the four named cases are now refused. **31 of 42 attack inputs are still accepted**, and a forwarded message needs no wording at all (N1, N2). The fix also demotes Sid's own sentences (N5). |
| M2 >4 proposals terminal | **FIXED** (see N3) | Narrows at `:661-677`, and skips a single event with `proposal_budget_exceeded`. |
| M3 stranded `running` | **FIXED** | Proven in SQL: after a rolled-back receipt batch, the `failRunningRun` UPDATE passes both run guards and stores `failed / distillation_finalization_failed / 0`. The same key is then refused (`memory_run_initial_state_invalid`) and `:r1` is accepted. Retries are bounded at 3 (`:66,738-772`). In production the next hour's key does the retry anyway. Duplicate risk: N8. |
| M4 terminal rewrite | **FIXED** | Code: both UPDATEs carry `AND outcome = 'running'` (`:981`, `:1021`). Trigger: with 0016's guard dropped, 0026 alone aborts failed→nothing_new and any touch of a terminal run (`memory_distillation_run_counts_invalid`). Note that 0016's `memory_runs_update_guard` also aborts on its own (`memory_run_transition_invalid`), so on the full migration chain this was already closed at the schema level in round 1. |
| M5 archive eligibility without subject | **FIXED** (see N9) | Code: the subject is compared to the envelope, whose hash must equal the archive's `envelope_sha256` (`:811-826`). Trigger `0026:147`: an eligible archived receipt with owner subject is OK; with another subject or a NULL subject it aborts; a skipped receipt with another subject is OK. All proven. |
| L3 cursor backwards | **FIXED** | `0026:339` alone aborts 5→3 (`memory_distillation_cursor_advance_invalid`). 0016's `memory_cursors_monotonic_update` also aborts on its own. On the full chain, DELETE, `INSERT OR REPLACE` to 0 and renaming the cursor away all abort. |

## New findings

### N1 — High — A forwarded Telegram message becomes Sid's own confirmed words
- **Where:** `conversation/conversation-repository.ts:400` commits every user turn with `historyEligible: true`. The forward flag `isDirectText` (`channels/telegram/telegram-types.ts:238`) is used only by the school and study-coach adapters (`index.ts:125,137`) and is never stored in the event. `memory/automatic-distillation.ts:849-867,925` then trusts any source whose text contains the quoted sentence, marks it `active` and files it at the root.
- **Proven:** executed `isAuthenticatedFirstPersonQuote` at 7fd25ff with source `"I am moving to Calgary in June."`, meaning the whole event, as a forward arrives. It returns **true**. That the forward reaches the event log unflagged is by reading.
- **Effect for Sid:** he forwards Mum's text "I am moving to Calgary in June." to Jarvis. If the model quotes it with confidence of 0.8 or more, Jarvis stores it as something Sid said himself: active, not marked uncertain, at the top of his memory. The same happens with a two-message paste ("Look what Mum sent" and then her text), because each source message is checked separately (`:849-855`).
- **Fix:** carry direct vs forwarded/external-reply into the committed turn (a payload field or `schemaCode` 2), and never grant `authenticated_first_person` to a non-direct turn. This is the same signal `ownerTurnAuthoritative` already uses. Test: a forwarded update with a first-person sentence must end up `model`, `uncertain`, `proposed`, in the Inbox.

### N2 — Medium — The attribution fix is a verb list, and 30 more realistic phrasings get past it
- **Where:** `memory/extraction-policy.ts:56-57` (the list) and `:163-164` (only a *preceding* listed verb blocks trust).
- **Proven:** executed the real function on 42 attack inputs (`m1-probe.out`). **Accepted as Sid's own words** (30, plus the bare forward in N1 = 31):
  - A verb missing from the list: `Mum sent this. I am moving to Calgary in June.` / `Got a text from Mum. …` / `Forwarding Mum's message. …` / `Mum called. …` / `Mum replied. …` / `Mum writes. …` / `Mum tells me. …` / `Mum texts. …` / `Mum posted on Facebook. …` / `Mum DM'd me. …` / `Mum asked me to share this. …` / `Dad forwarded this. …` / `According to Mum. …` / `From Mum. …` / `Mum's WhatsApp. …` / `Here's Priya's email. …` / `Mum's voicemail! …` / `Mum keeps saying. …` / `Mum was telling me. …` / `Mum is texting. …` / `Copying what Dad sent me. I have been diagnosed with diabetes.`
  - A pasted chat log: `Mum: Hi sweetie. I am moving to Calgary in June.` / `Mum 9:41 PM\nHi sweetie.\nI am moving to Calgary in June.` / `Mum\n\nHi love.\nI am moving to Calgary in June.\nLove you xx`
  - Attribution after the sentence: `I am moving to Calgary in June. That's what Mum said.` / `… Mum just texted that.` / `… -- Mum` / `…\n\nsent by Dad` / `… (from Mum's text)` / `… Not me, Mum.`
  - Correctly refused: a colon or dash in the same sentence, quote marks, `From Mum:\n…`, `My friend's message: …`, a listed verb one or two sentences earlier, and same-sentence reported speech.
- **Effect for Sid:** anything he pastes from someone else can still be stored as his own statement. The list can never be complete. This is the enumeration trap the #52 review told builders to avoid.
- **Fix:** make the rule structural rather than lexical. Grant `authenticated_first_person` only when the quote is the **whole direct turn**, ignoring whitespace. Any multi-sentence turn goes to the Inbox as `model`/uncertain, so nothing is lost; it just waits for Sid's confirmation. Then drop the new verb list (see N5).

### N3 — Medium — A message packed with facts is forgotten entirely, and the 4-proposal cap makes narrowing the normal path
- **Where:** `automatic-distillation.ts:62` (`MAX_PROPOSALS = 4` per step, for an 8-message window) and `:661-670` (with one eligible event and more than 4 proposals, the whole event is skipped with 0 items). The repo's own test `narrows a proposal-heavy window and skips only the irreducible event before advancing` asserts `createdItemCount: 0` for one message that yields 5 facts.
- **Proven:** by reading and from that test's assertions.
- **Effect for Sid:** a message like "I'm in grade 12, applying to Waterloo and UofT, physics is my favourite, surgery was in August, deadline is end of September" is **dropped completely**, after up to 4 model calls. That is exactly the shape of the planned onboarding interview. On an ordinary chat day, 8 messages will often yield more than 4 facts, so steps narrow to 4 or 2 messages. That roughly halves throughput and doubles model calls.
- **Fix:** never skip a single event for having too many facts. Commit the proposals in chunks of `MAX_PROPOSALS` across successive runs over the same one-event window, and advance the cursor after the last chunk. Or re-ask once with an explicit cap and record how many were dropped. Separately, size the per-step proposal cap to the window (for example 2 per eligible event) so narrowing is the exception.

### N4 — Medium (latent until a provider is configured) — 8 steps now run before the school polls with no time limit
- **Where:** `jobs/job-table.ts:419-426`, which loops up to 8 steps inside `poll()`, and `:452-461`, where memory runs **before** Classroom and Brightspace. Each step allows `timeoutMs: 120_000` (`automatic-distillation.ts:608`), plus up to 3 more narrowing calls.
- **Proven:** by reading. Cloudflare's Workers limits page gives Cron Triggers a 15-minute duration limit. Eight slow-but-successful calls near the timeout (8 × 120 s = 16 min) or narrowed steps go past it. A plain timeout does break the loop, because the outcome becomes `failed`.
- **Effect for Sid:** the day a real model is switched on, a slow model hour can use up the hourly job before the Brightspace and Classroom checks run. His school deadlines then silently skip that hour, and the in-flight run is left `running`.
- **Fix:** run memory after the school polls, and stop starting new steps once a wall-clock budget is spent (for example about 5 minutes), alongside the 8-step cap.

### N5 — Low — The new verbs demote Sid's own sentences
- **Where:** `extraction-policy.ts:66` now puts texted/wrote/messaged/emailed/reported/claimed/mentioned/quoted inside the quote check, and `:163` applies them to the whole prefix.
- **Proven:** `m1-overdemote.out` shows 5 of 5 demoted at 7fd25ff and 5 of 5 trusted at ebd41f9. Examples: `I wrote my Western essay.` / `I emailed my counsellor today. I am applying to Waterloo.` / `I mentioned it to Dad. My surgery was in August.`
- **Effect for Sid:** his own plain statements land in the Inbox for confirmation. That's more homework, but nothing false gets stored.
- **Fix:** handled by N2's whole-turn rule. Restore the round-1 in-quote list (`says|said|told`).

### N6 — Low — Skips and backlog aren't shown anywhere Sid would see them
- **Where:** skip steps return `nothing_new` (`automatic-distillation.ts:582,666`). The poll summary (`job-table.ts:430`) reports neither skipped events nor skip reasons. The backlog is `latest − cursor` in raw events (`:1085`), about 5× the number of messages, and it appears only in the scheduled-run detail.
- **Proven:** by reading. The reasons can be queried in `memory_distillation_event_receipts.skip_reason`.
- **Effect for Sid:** "Memory nothing_new, 0 created" can mean one of his messages was dropped, and "300 events pending" is really about 60 messages.
- **Fix:** add `skippedEventCount` (by reason) to the step result and the summary, and report pending *eligible* messages as well as raw events.

### N7 — Low — A step can report `succeeded` while the cursor hasn't moved
- **Where:** `automatic-distillation.ts:698-714`. If `advanceCursor` throws after a successful finalize (a race, or a transient D1 error), the catch calls `finalizeRun(failed)`. That batch fails because the run is no longer `running`, `failRunningRun` does nothing, and `readRun` returns `succeeded` with the cursor unchanged. `job-table.ts:425` then continues to the next step on the same window.
- **Proven:** by reading.
- **Effect for Sid:** a misleading summary, and with a paid model a second paid call on the same messages.
- **Fix:** base `result.outcome` on whether the cursor actually advanced (or return a distinct `cursor_unavailable`), and have the loop stop when `cursorEventSequence` didn't move.

### N8 — Low — A retry after a finalization failure can duplicate facts
- **Where:** items are committed (`:686-697`) before the receipt batch (`:992-996`). On batch failure the items stay, with no item receipt, and the retry re-asks the model.
- **Proven:** by reading. Item IDs are deterministic per proposal hash, so identical output replays cleanly. A real model's paraphrase gets a new hash and a new item.
- **Effect for Sid:** after a rare failure, the same fact can appear twice, and the first copy isn't linked to any run.
- **Fix:** on retry, feed the window's existing items (via `memory_item_sources` for those event sequences) back as already covered, or record orphaned items at failure so reconciliation can find them.

### N9 — Low — The archive subject is write-once, but the database accepts any value on the first write
- **Where:** `0026:20-35`.
- **Proven:** `UPDATE archive_segment_events SET subject_id='someone-else'` on a NULL row succeeds. Rewriting it afterwards aborts.
- **Effect for Sid:** none today. The only writers are the hash-checked code path and the migration backfill. The binding lives in code, not in the schema.
- **Fix:** record this in `KNOWN_ISSUES.md` or a comment. The database can't check R2 content.

## Checked and sound
- **No spend path:** `completeJson` is reached only through the injected provider (`automatic-distillation.ts:603`), and `memoryDistillation` is set nowhere in `src/`. The fix diff has no fetch or credential reads.
- **Scope:** the PR-owned commits `eb58894` (vs `9237bd8`) and `9a3474a` touch no `voice/**`, `calls/**`, `D1ContextRetriever` or `production-runtime.ts`.
- **SQL forms:** 0026 has no `CASE`, no `OR REPLACE` / `OR IGNORE` / `ON CONFLICT`, and neither does the fix code.
- **Archive update trigger:** it covers all 6 original columns plus `subject_id`. Changing `segment_id` or `created_at` while setting the subject aborts (proven).
- **`skip_reason` CHECK:** skipped with NULL reason aborts, and eligible with a reason aborts (proven).
- **Redactor:** the redactor is idempotent on already-redacted text (6 inputs), so the `checked.text !== text` revalidation doesn't wedge on messages that contained secrets.
- **Archive hash:** the archive `envelope_sha256` uses the same `sha256Hex(canonicalJson(envelope))` scheme (`archival-service.ts:307`). No `SELECT *` reader of `archive_segment_events` breaks from the added column.
- **Bounded loops:** narrowing, key retries and poll steps are all bounded, and there's no progress-free loop apart from N7.

## Unverified
- **D1 query limit:** whether D1 counts a batch as one query toward any per-invocation cap, and whether Sid is on Workers Paid. Cloudflare's 2026-02-11 changelog raised Paid to 10,000 subrequests; Free stays at 1,000 to internal services. The step's self-declared ceiling of 548 × 8 = 4,384, plus archival and polls, would exceed 1,000. `docs/research/2026-09-14-jarvis-memory-research.md:144` still cites 1,000.
- **No end-to-end run:** neither vitest nor the full workflow was run. The M1 end-to-end filing (active, root) is by reading `commitInput`; only the gate function was executed.
- **Real-model behaviour:** unknown — how often a real model echoes first-person sentences verbatim, or returns more than 4 facts per 8 messages.
- **Migration backfill:** the 0026 backfill UPDATE was not run against a production-sized archive table.
- **Round-1 Lows:** the three unnamed round-1 Lows remain unavailable.
