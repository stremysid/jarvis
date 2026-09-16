# PR #76 adversarial review, head 446ea2d

**Verdict: do not merge yet. 1 High, 4 Medium, 6 Low.** The $5 cap holds on every path I found. Nothing reaches DeepSeek without a reservation. The problem is memory itself: once it runs against a real, non-deterministic model and real hourly timing, it can duplicate memories, get stuck on one batch, and pay for the same messages again and again.

The evidence is `<scratchpad>/pr76/agent/tree/apps/cloud-gateway/test/zz-pr76-adversarial.test.ts` (F1a–F7, all pass at 446ea2d, so each defect reproduces). The mutation script is `<scratchpad>/pr76/agent/mutate.sh`, with its logs in `mut-*.txt`. Run logs are `run3.txt`, `run5.txt`, `run6.txt`, `run7.txt` and `run8.txt`. I did not run the full suite. I made no real DeepSeek call.

---

## High

### H1. Continuation asks DeepSeek again, stores duplicates, and the cursor never moves
- **Where:**
  - `memory/automatic-distillation.ts:719-760`: when more than 4 proposals come back, the step commits 4 and leaves the cursor where it was.
  - `jobs/job-table.ts:516`: `continue` makes a new, paid provider call on the same batch.
  - `automatic-distillation.ts:501-507` and `:703`: a proposal counts as "already saved" only if its hash matches exactly, and that hash includes `confidence`, `sensitivity` and the excerpt.
  - `providers/deepseek-provider.ts:360-375`: the request sets no temperature, so DeepSeek uses its default sampling.
- **Proven (F2):** five one-sentence owner Telegram facts. The fake DeepSeek returns the same 5 proposals, with confidence 0.01 lower on each call. One hourly Worker run gave:
  - 2 paid calls (2 settlements).
  - Report text `Memory succeeded, 8 created ... D1 statement allowance reached`.
  - Four facts each stored twice.
  - The fifth ("I am applying to Waterloo.") never stored.
  - Distillation cursor still `null`.

  The next hour starts from the same cursor and repeats all of this.
- **Effect for Sid:** when he says 5 or more memorable things within about 8 messages (the onboarding interview, a school catch-up), Jarvis saves a fresh set of near-duplicate memories every hour. It pays DeepSeek twice an hour for the same messages. It learns nothing newer until a call happens to repeat a previous answer byte for byte. This alone can use up most of the $5 month while memory stays frozen.
- **Fix:**
  - Don't ask DeepSeek again on continuation. Commit the remaining validated proposals from the response already paid for, either carried to the next step or by raising the per-step commit count within the D1 allowance.
  - Key "already saved" on sorted `sourceEventIds` + NFC text, not on confidence or sensitivity.
  - Send `temperature: 0` for extraction.
  - Add a test where each call's wording drifts.

## Medium

### M1. The scheduled clock is frozen, and D1 rejects any memory write more than 5 minutes after the cron fired
- **Where:**
  - `index.ts:505`: `clock.now` is `new Date(controller.scheduledTime)` for the whole run. The budget, the workflow and history indexing all use it.
  - Real-time D1 guards: `0016_cloud_memory.sql:2737-2738` (`memory_runs.started_at`), `:2892-2893` (`memory_cost_ledger.occurred_at`), and `0019_memory_ingress.sql:45` (topic events).
  - The 4-minute wall-clock checks at `job-table.ts:495` and `:563` read the same frozen clock, so they always see 0 ms elapsed.
- **Proven:**
  - **F1a:** a scheduled time 6 minutes in the past gives `Memory distillation failed (memory_distillation_failed)`, and DeepSeek is never called.
  - **F1b:** a scheduled time 288 s in the past with a DeepSeek reply that takes 15 s:
    - DeepSeek is called once (so paid).
    - 1 reservation and 0 settlements.
    - Run `failure_code = memory_extraction_settlement_failed`.
    - No memory saved.
- **Effect for Sid:** any memory work that starts more than about 5 minutes after the top of the hour is refused. A DeepSeek call that crosses that line is paid for, thrown away, and redone (and paid for again) next hour. This happens during slow DeepSeek periods or a backlog catch-up. The cap still holds, because the unsettled reservation counts at its ceiling. The "4-minute budget" protection described in AGENT_LOG does not work.
- **Fix:** give the memory budget, workflow and history service a real clock (`() => new Date()`). Keep `scheduledTime` only for run keys. Add a test with a past `scheduledTime` and a slow provider.

### M2. One bad proposal throws away the whole paid batch, and the same batch is retried forever
- **Where:**
  - `automatic-distillation.ts:697-718`: any invalid proposal fails the whole step.
  - `:667-677`: errors thrown after settlement fail the step too. That includes `finish_reason: "length"` (`deepseek-provider.ts:434`).
  - The loop stops on failure, and nothing narrows the window or skips on output errors, so the next hour sends the identical window again.
- **Proven (F3):** two owner messages. DeepSeek returns one valid proposal and one whose excerpt `I'm in grade 12.` swaps the iPhone curly apostrophe in the source `I’m in grade 12.` for a straight one. Three consecutive hourly steps all ended `failed / distillation_provider_output_invalid`:
  - 3 paid calls (540 micros settled).
  - Cursor stuck at 0.
  - The valid "My favourite subject is math." never saved.
- **Effect for Sid:** if DeepSeek keeps making the same small slip on one of his messages, automatic memory stops for good at that message and pays for a failed call every hour. Likely slips: iPhone smart quotes, a slightly reworded "exact" excerpt, or more facts than 2,048 output tokens can hold. A forwarded message with planted instructions could do the same on purpose. How often the real model does this is unverified.
- **Fix:**
  - Drop invalid proposals one by one and keep the valid ones.
  - On `output_limit` or repeated output failure for the same window, halve the window.
  - At a single event, write a visible skip receipt and advance.

### M3. Every reservation and 80% check scans the whole ledger, so it gets slower and costlier every month
- **Where:**
  - `memory/memory-extraction-budget.ts:369-407` (reserve).
  - `:528-563` (`monthSpend`). In production it runs on every settlement, because `notice` is wired.
  - The only ledger index is `(principal_id, budget_class, occurred_at)` (`0016:1069-1070`). The correlated settlement, release and overrun lookups are not limited to the month.
- **Proven (F6):**
  - EXPLAIN QUERY PLAN shows each correlated subquery is `SEARCH ... USING INDEX memory_cost_ledger_month_lookup (principal_id=?)`, which is a scan of all of the owner's rows.
  - Reserve took 11/45/99/190 ms at 206/406/606/806 ledger rows (3 stable samples each). That is quadratic.
  - D1 `rows_read` for the month-spend query was 64,066 at 206 rows and 248,066 at 406 rows (about 3 × month reservations × all rows).
- **Effect for Sid:** each month of use makes every memory call slower and heavier on D1, and last month's rows keep adding to the cost. At an assumed 500–1,000 calls a month, that reaches seconds per call and billions of D1 row reads a month within about a year. D1 bills those reads outside the $5 cap once his plan's included reads are used. The slower queries also eat into M1's 5-minute window.
- **Fix (no migration needed):** compute month spend in one pass over month-bounded rows. Settlements, releases and overruns always happen at or after `monthStart`, so add `occurred_at >= monthStart` to those lookups, group by `reservation_entry_id`, and LEFT JOIN to this month's reservations. Add a `rows_read` ceiling test.

### M4. No warning before DeepSeek credits run out
- **Where:**
  - The existing `DeepSeekCreditReader` 85/95% owner alerts are built only in voice (`archive/production-capacity.ts:29`, imported only by `voice/production-routes.ts` and `voice/production-runtime.ts`), and voice is not live.
  - The JSON provider maps HTTP 402 to `authentication` (`deepseek-provider.ts:323`).
  - That becomes run outcome `provider_credit_blocked`, with no code and no owner message (`automatic-distillation.ts:523-525`).
- **Proven:** by reading.
- **Effect for Sid:** he asked for a warning before the cap *or credits* run out. He gets the 80% cap warning. If the DeepSeek prepaid balance runs low, memory (and Telegram chat) just stop without warning.
- **Fix:** run the existing credit reader and `D1CapacityAlertSink` from the hourly job (both are already built and send each alert once), or confirm with Sid that the cap warning is enough.

## Low

### L1. An empty `MEMORY_EXTRACTION_MODEL` stops every cron job
- **Where:** `index.ts:521`, `:535`; `deepseek-provider.ts:341`.
- **Proven (F7):** the 5-minute drain cron throws `TypeError: deepseek_json_configuration_invalid` before any job runs. No `scheduled` log line is written and no heartbeat is sent. An empty `DEEPSEEK_MODEL` does the same.
- **Effect for Sid:** one empty setting silently stops the digest, the outbox drain and every hourly job.
- **Fix:** treat an empty value as unset (`||`), and build the provider inside `distilMemory` so a config error only fails the memory job.

### L2. History indexing is capped at 16 events an hour
- **Where:** `memory/literal-history.ts:51-52`; `job-table.ts:567-574`.
- **Proven (F5):**
  - A 2-event step really uses 19 D1 statements, and an 8-event step (`maxTextBytes 262,144`) uses 37–38.
  - The loop still charges 64 per 2-event step, so it does 8 steps × 2 events.
  - Every event type counts. A Telegram turn writes 3 events (`conversation-repository.ts:435`, `:582`, `:901`).
- **Effect for Sid:** past about 128 turns a day, or with any existing backlog, "what did I say about…" misses recent chat.
- **Fix:** use 8 events and 262,144 bytes per step, pinned at ≤64 statements.

### L3. Run receipts can show zero cost for a paid call
- **Where:** `automatic-distillation.ts:667-677` finalizes the run without usage when the provider throws after settling (`deepseek-provider.ts:427`, then `:434`).
- **Proven (F4):** the ledger settlement is 180 micros, but `memory_runs` settled and reserved costs are 0.
- **Effect for Sid:** cost reports undercount. The cap is unaffected.
- **Fix:** carry usage on the failure, or read the ledger by `run_id`.

### L4. Some guards no test catches
Each mutation survived and each file was restored afterwards:
- **A:** removing the JSON provider timeout abort (`deepseek-provider.ts:386`): provider tests 48/48 pass. A hung DeepSeek call would run until the Worker's 15-minute kill.
- **B:** dropping the month-start bound in the reserve SQL (`memory-extraction-budget.ts:405`): 52/52 pass. The cap would silently become a lifetime $5.
- **C:** dropping the price-id binding (`:356`): 52/52 pass.
- **E:** deleting `notice: delivery` (`index.ts:529`): hourly-archive and budget tests 8/8 pass. Sid would never get the production warning.

### L5. The two prompts disagree on the output format
- **Where:** `automatic-distillation.ts:452` says "return a JSON array", while `deepseek-provider.ts:366` asks for one object with a `proposals` array.
- There is no example format, which DeepSeek's JSON mode docs ask for, and no temperature is set.
- **Proven:** by reading. The effect is unverified, but it likely makes H1 and M2 more frequent.
- **Fix:** one consistent instruction with an example object, and `temperature: 0`.

### L6. Every call is billed at peak rates
- **Where:** `memory-extraction-budget.ts:31-50` both reserves and settles every call at peak rates.
- DeepSeek's peak hours are only 01:00–04:00 and 06:00–10:00 UTC on weekdays, at 2× the off-peak price. I checked the pricing page today.
- **Effect for Sid:** no overspend, but off-peak calls are recorded at twice their real cost, so he gets roughly $2.50–$5 of real extraction a month instead of $5.
- **Fix:** reserve at peak, but settle at the higher of the rates at the call's start and end.

---

## Checked and sound
- **Price table:** matches DeepSeek's pricing page today. `deepseek-flash` peak is 0.006 / 0.30 / 1.20 and `deepseek-v4-pro` peak is 0.044 / 1.32 / 3.96 (cache hit / input / output, USD per million tokens). Unknown or legacy ids (for example `deepseek-v4-flash`) are refused with `memory_extraction_model_unknown`.
- **No call without a reservation:**
  - `prepare` then `reserve` happen before `fetch`, and a refusal throws.
  - The capped `INSERT…SELECT` is a single statement, so it is atomic under D1's write serialization.
  - Settlement ≤ reservation is enforced in both code and the trigger.
  - Failed or unsettled calls count at the full reservation.
- **Reservation ceilings:** input is at most request bytes + 512 tokens, output at most `max_tokens` 2048, and every input token is reserved at the cache-miss price. Reported usage is checked: `hit + miss` must equal `prompt`.
- **Cap setting:** an invalid cap (`0`, `""`, `five`, more than 6 decimals) refuses all extraction. The default is 5.
- **Toronto month boundaries:** correct across UTC and DST.
- **Request and response handling:**
  - The JSON-mode request shape (`response_format json_object`, `thinking {type: disabled}`) matches DeepSeek's docs.
  - Redirects are manual.
  - Requests are bounded at 131,072 bytes and streamed responses at 262,144 bytes.
  - Failure codes are fixed, and no body, header or key is logged.
- **Authority:** only a direct-owner Telegram event whose entire text equals the proposal becomes `authenticated_first_person`. Forwarded, guest, assistant and staged text cannot, and the model cannot set origin or state.
- **80% notice:** goes only to the owner's verified Telegram chat, with fixed text, one claim per owner per month. A failed notice doesn't block extraction.
- **History indexing:** handles 6-field `user_committed` events, skips staged `memoryItemIds` events, and advances (F2 run).
- **Failure isolation:** distillation and history are each wrapped in `safeSourcePoll`.
- **Scope:** the diff touches no `voice/**`, `calls/**` or migrations, and the Telegram reply path is unchanged.

## Unverified
- **Real DeepSeek behaviour:** how often it rewords excerpts, straightens `’`, uses a different JSON key, returns empty content, or exceeds 2,048 tokens.
- **Active memories:** whether real extractions ever become authenticated active memories. The prompt never asks for Sid's exact sentence, so most will probably be proposed/uncertain (still retrieved). Only a fake verbatim reply was tested.
- **Production settings and scale:** the actual `DEEPSEEK_MODEL` (a legacy id would be refused), the D1 plan and its included reads, the current event backlog, and typical DeepSeek latency.
- **Duplicate 80% notice:** possible if Telegram accepts the message but the D1 "sent" update fails; it would be resent next hour.
