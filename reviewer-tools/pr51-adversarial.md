# PR #51 adversarial review — head a25a5fd, base deea39c

Scope: `codex/school-brightspace-step3`. The diff was read in full, along with the code around it at a25a5fd
(`git archive` into the scratchpad): `job-table.ts`, `scheduled-run-repository.ts`, `school-catchup-model.ts`,
`index.ts`, `conversation-service.ts`, `telegram-webhook.ts`/`telegram-types.ts`, `deadline-ingestion.ts`,
`deadline-repository.ts`, `digest-job.ts`, `brightspace-ical-client.ts`, migration `0013`, and the new tests.
Nothing was run, and no repo was edited, committed or pushed.

**Verdict: no High.** Three Mediums (M1–M3) should be fixed before the Brightspace secret is set. The Lows can be fixed or recorded.

---

## Medium

### M1. Truncation keeps up to 14 days of past items ahead of upcoming ones, and the wording says "next"
- **Where:** `apps/cloud-gateway/src/jobs/job-table.ts:157-164`
  ```ts
  const inWindowItems = result.items.filter((item) => inside(item.dueAt));
  const items = [...inWindowItems]
    .sort((left, right) => left.dueAt < right.dueAt ? -1 : ...)
    .slice(0, BRIGHTSPACE_WINDOW_ITEM_LIMIT);
  ```
  The window is `[now-14d, now+120d)` (`:151-156`). An ascending sort therefore puts the *oldest past* items first.
  The digest then says `showing the next ${BRIGHTSPACE_WINDOW_ITEM_LIMIT} Brightspace items` (`digest-job.ts:90-91`), and the
  on-demand reply says `${n} later in-window items were omitted` (`job-table.ts:286`).
- **Scenario:** N6 is still open (one assignment may produce separate availability and due entries).
  - With 70 in-window items already past due and 250 still to come, Jarvis keeps the 70 past items plus only the soonest 110 upcoming ones, and drops 140 upcoming.
  - If ≥180 in-window items fall between now−14d and some upcoming instant, every upcoming item after it is dropped. That includes new deadlines inside the digest's 7-day horizon (`digest-job.ts:33`) when the count reaches 180 by now+7d.
  - The digest meanwhile reports "showing the next 180".
- **Consequence:** capacity goes to work that is already due while upcoming work goes missing, and the gap line claims the opposite.
- **Test gap:** the new 250-item test (`brightspace-poll-job.test.ts`, `inWindowFeed`) uses only upcoming items (`NOW + (index+1)h`), so it cannot detect this.
- **Fix:**
  - Rank items due at or after `now` first, ascending by `dueAt`. Fill any remaining slots with past items, most recent first. Tie-break on `externalId` as now.
  - Keep "next" in the wording only if the upcoming side is what gets truncated; otherwise say "showing 180 of N".
- **Test:** a feed with 60 items due in the past 14 days and 200 upcoming. Assert:
  - the kept set contains the 180 soonest upcoming items;
  - `truncatedCount` = 80 and the omitted items are the 60 past plus the 20 latest upcoming;
  - with 200 past plus 10 upcoming, all 10 upcoming items are kept.

### M2. The truncation marker hides "last successful sync is stale", undoing the PR #49 staleness guarantee for large feeds
- **Where:** `apps/cloud-gateway/src/jobs/digest-job.ts:89-99`
  ```ts
  if (source.lastFailure !== null) {
    if (source.kind === "brightspace" && /^source_items_truncated:\d+$/u.test(source.lastFailure)) {
      return `showing the next ${BRIGHTSPACE_WINDOW_ITEM_LIMIT} Brightspace items`;
    }
    return source.lastFailure;
  }
  ...
  return age > DEADLINE_SOURCE_STALE_AFTER_MS ? "last successful sync is stale" : null;
  ```
  Every truncated success writes the marker into `last_failure` (`deadline-ingestion.ts:354-358`, `deadline-repository.ts:299-307`).
  For exactly the owner whose feed exceeds 180, the age check below is therefore never reached.
- **Scenario:** a large feed, so every sweep leaves `source_items_truncated:N`. Hourly syncing then stops without writing a failure:
  - `safeSourcePoll` swallows a D1 fault in `ensureSource`/`readSource` and records nothing (`job-table.ts:302-313`);
  - or the cron trigger or poll claim stops firing;
  - or a `waitUntil` cancellation cuts an on-demand sweep (L6).

  Before this PR, a success cleared `last_failure`, so after 3 h the digest would say "last successful sync is stale". Now it keeps saying "showing the next 180 Brightspace items" indefinitely.
- **Consequence:** frozen deadlines read as live. This is the "silent source reads as nothing new" failure that PR #49 F1 closed.
- **Fix:** for the truncation marker, fall through to the `lastSuccessAt` age check. Report both, e.g. `showing 180 items; last successful sync is stale`. Better still, store truncation in its own column or report field rather than overloading `last_failure`, though that needs a migration and Sid's approval.
- **Test:** a source row with `last_success_at = now−5h` and `last_failure = 'source_items_truncated:70'`. The digest gap must contain `stale`.

### M3. In-window cancellations are now uncapped, so the D1 statement budget from PR #49 S2 can be exceeded (suspected; the realistic feed shape is unverified)
- **Where:**
  - `job-table.ts:165`: `const cancelled = result.cancelled.filter((item) => inside(item.dueAt));`. The old guard `items.length + cancelled.length > 180` was removed.
  - Each id costs one `UPDATE … RETURNING` (`deadline-repository.ts:479-484`, called per id at `deadline-ingestion.ts:330-343`).
  - The parser allows up to 2,000 components (`brightspace-ical-client.ts:16, 245`), and `STATUS:COMPLETED` VTODOs count as cancellations (`:455`).
- **Scenario:** 180 live items plus about 1,500 in-window `CANCELLED`/`COMPLETED` components.
  - The first load is about 180×5 statements (unchanged UPDATE, `#readRow`, a 2-statement batch, `#requireDeadline`) plus 1,500 cancellation UPDATEs.
  - That is about 2,400 statements, against the `< 800` budget the PR #49 test pins (`brightspace-poll-job.test.ts:343`). It is probably also above the Workers per-invocation D1 query limit; I could not confirm the current number from Cloudflare docs this pass.
  - In the cron invocation this shares a budget with archival, Classroom and the project poll. On the on-demand path it shares one with the conversation-turn writes.
- **Consequence:** the sweep can abort midway. The source-failure write can be refused too, which leaves M2's silent-staleness state, and later polls in the same cron can fail.
- **Fix:** do either of these:
  - cap in-window cancellations as well (for example 180, nearest to now) and add the remainder to the truncation count; or
  - resolve cancellations with one `SELECT external_id FROM deadlines WHERE source_id=? AND status='open' AND external_id IN (…)` in chunks, then UPDATE only the ids that match.
- **Test:** a counted DB with 180 live plus 1,000 in-window cancellations. Assert the total stays under the pinned budget and that the cancellations matching open rows still close.

---

## Low

### L1. Reply timestamps are UTC ISO, not America/Toronto
- **Where:** `job-table.ts:246` (`from ${lastSuccessAt}`) and `:287` (`refreshed at ${result.report.observedAt}`).
- **What Sid sees:** "Brightspace refreshed at 2026-09-15T18:58:00.000Z" when it is 14:58 in Toronto. A snapshot four hours old can look current, or look to be from the future.
- **Fix:** format with `env.DIGEST_TIMEZONE ?? "America/Toronto"`, e.g. `Sep 15, 2:58 PM`.
- **Test:** assert the local string for a fixed `NOW` in both reply forms.

### L2. The catch-all replies falsely say no snapshot exists
- **Where:** `job-table.ts:298` and `school-catchup-model.ts:429-432` both return `No last-known Brightspace snapshot is available.` without reading the source.
- **Scenario:** a `readSource`/claim/`finish` D1 error after years of good syncs still tells Sid there is no snapshot.
- **Fix:** say "I couldn't read the last-known snapshot", or attempt `readSource` inside the catch.
- **Test:** make `runs.finish` throw after a successful refresh. The reply must not claim a missing snapshot. Note that it also currently says "refresh failed" after a refresh that actually succeeded, which is misleading too.

### L3. Near-miss phrasings reach the model, which has no Brightspace data and no guard against claiming it checked (suspected model behaviour)
- **Where:** `school-catchup-model.ts:48` requires the exact shape `(jarvis,)? (can you|please)? check|refresh|update (my)? d2l|brightspace (calendar|deadlines|feed)? (right)? now (please)?`.
- **Not matched** (goes to the model): "check d2l", "check D2L now thanks", "hey jarvis check d2l now", "Jarvis: check D2L now", "check d2l pls", "did you check d2l?", "any new D2L stuff?".
- **Why it matters:** the school prompt carries no source-health or deadline data (grep of `src/school` finds none outside the matcher). Unlike plan saves, which have `PLAN_SAVE_COMPLETIONS`, nothing stops a reply like "I just checked D2L, nothing new."
- **False positives:** negligible. The regex is anchored `^…$`, so quoted teacher text, a pasted digest or "did you check d2l?" never trigger it. A forwarded message whose entire text is "check D2L now" does (L5).
- **Fix:** add a completion guard. Replace any model reply matching `(checked|refreshed|synced|looked at).{0,40}(d2l|brightspace)` with a fixed line: "I haven't checked D2L. Say 'check D2L now'." Optionally allow "thanks|pls", "hey", `:` and an optional "now" in the matcher.
- **Test:** the model returns "I checked D2L just now" for input "did you check d2l?". The reply must be the fixed hint, and `refreshBrightspace` is not called.

### L4. Nothing coordinates with the hourly poll
- **Where:** the cooldown only looks at `job = 'brightspace_on_demand'` (`scheduled-run-repository.ts:74`).
- **Scenarios:**
  - A manual request at :00:05 plus the cron at :00 means two feed fetches seconds apart. Worst case is 12 on-demand plus 1 cron per hour, which is bounded and acceptable.
  - When the two overlap, sweeps interleave:
    - `last_success_at` can move backwards (whichever `recordSourceSuccess` lands last);
    - the later sweep's `listOpenNotSeenSince` can count items only the other sweep touched as "absent" (report-only);
    - one sweep's transient failure overwrites the other's success until the next hourly run;
    - upsert contention can raise `deadline_upsert_contended` and record a failure.
- **Fix, optional:** also refuse when `source.lastSuccessAt` is under 5 minutes old and answer with that fresh snapshot. Or make `recordSourceSuccess` monotonic.
- **Test:** cron success at T, then an on-demand request at T+1 min. No second fetch, and the reply names T.

### L5. Group chats and forwarded messages are not excluded
- **Where:** `telegram-types.ts:195-229` has no `chat.type` check and does not reject `forward_origin`. Principal comes from `from.id` only.
- **Scenario:** Sid says "check D2L now" in a group with the bot (or replies to the bot there), or forwards someone's message whose whole text is that phrase. A refresh runs, and counts, failure codes and timestamps are posted into the group.
- **Why Low:**
  - non-owner members cannot trigger it (`index.ts:113`, `school-catchup-model.ts:423`);
  - the cooldown bounds it;
  - the same class already applies to every school or model reply, so it is not new.
- **Fix, if wanted:** restrict the refresh (and ideally the school adapter) to private chats. That needs chat type carried on `AcceptedTelegramUpdate`.

### L6. The on-demand first load runs inside `waitUntil`'s 30-second limit (suspected, not measured)
- **Where:** `index.ts:382` (`ctx.waitUntil(replyTo(...))`). Cloudflare docs: `waitUntil()` "can extend execution for up to 30 seconds after the response is sent".
- **Cost of a first load:** a fetch of up to 10 s (`DEFAULT_TIMEOUT_MS`), up to about 900 D1 statements for 180 creations (plus M3's cancellations), then conversation staging and Telegram dispatch.
- **If it is cancelled:**
  - the sweep stops partway and no failure is recorded;
  - the turn is left `model_claimed`;
  - Sid gets no reply;
  - the claim row stays, so the feed is not hammered.
- **Fix:** bound the on-demand ingestion, e.g. stop and record `brightspace_ingestion_failed` after ~20 s, or hand it to a Queue.
- **Test:** hard to do under vitest. Record it in KNOWN_ISSUES if not fixed.

### L7. Reply wording
- **`N items are current` (`job-table.ts:283, 287`):**
  - it counts `unchanged` rows, including a row that is still `cancelled` but has returned live with the same content (N8), which the digest will never show;
  - it omits the rejected count, so unreadable entries are silent in the reply (they do appear in the cron detail).
- **Digest placement:** the truncation line is listed under the heading "Could not be read" (`digest-composer.ts:219`) and counted as a gap ("sent with 1 gaps"). This is cosmetic.

---

## Checked and sound

**Trigger (item 1)**
- Only the owner's turn reaches it. The adapter is built only for `accepted.principalId === ownerPrincipalId` (`index.ts:112-128`) and re-checks `input.principalId === ownerPrincipalId` (`school-catchup-model.ts:423`).
- Telegram only: `input.channel !== "telegram"` returns early (`:416-419`). Voice cannot trigger it, and a test covers that.
- It runs before the model, on the redacted user text (`conversation-service.ts:854`, `school-catchup-model.ts:421-435`). The model is never called on this path, and model output is never parsed for the intent, so assistant or model-generated text cannot trigger it.
- Slash commands split off earlier (`index.ts:368-381`); `/check D2L now` is not the intent, and a test covers that.
- Telegram replays are deduplicated before `onAccepted` (`telegram-webhook.ts:344`).
- `edited_message`/`channel_post` are rejected (`telegram-types.ts:192-196`). Text-plus-attachment is rejected, and quoted reply content is not part of `text`.

**Rate limit (item 2)**
- Durable and atomic: a single `INSERT … SELECT … WHERE NOT EXISTS (… started_at > ?) ON CONFLICT DO NOTHING` (`scheduled-run-repository.ts:66-82`). The claim is a single SQL statement, so different isolates and concurrent requests cannot both be admitted, and the race test admits exactly one of three.
- The claim is written before any fetch (`job-table.ts:271-280`) and never deleted. A failure calls `fail`, which keeps the row (`:294-297`, `scheduled-run-repository.ts:102-115`), so failing retries still wait out the 5-minute cooldown.
- A killed isolate leaves an unfinished row, but admission depends only on `started_at`, so no permanent lock is possible.
- Column CHECKs pass: `job` is 21 characters and `run_key` (ISO) is 24, both ≤32 (`0013_scheduled_runs.sql:15-18`).
- A 5-minute window is sensible.
- No request and no claim when the URL is absent or the source is disabled (`job-table.ts:259-264`), and a test covers that.

**Secret (item 3)**
- `BrightspaceFeedError` messages are fixed codes (`brightspace-ical-client.ts:36-41`, `super(code)`), and anything else maps to `brightspace_ingestion_failed` (`job-table.ts:141-144`).
- The reply contains only codes, ISO instants and counts: no URL, body or upstream text.
- `runs.fail` stores a fixed code. `replyTo` logs only the outcome (`index.ts:159-172`). Cron detail holds counts only.
- The reply is stored as normal assistant history; it contains nothing secret.
- Pre-existing and unchanged: ingestion's `ingest_write_failed: ${describe(error)}` (`deadline-ingestion.ts:349`) stores a raw D1 error message until `refreshBrightspace`'s catch overwrites it. The feed URL is never in SQL, so that is not a URL leak.

**Truncation (item 4)**
- The count is persisted (`source_items_truncated:N`, bounded by `truncateFailure`) and reported in the reply and the cron detail.
- The id tie-break is deterministic.
- Cancellations stay additive and still close dropped rows that were previously ingested.
- A dropped row whose date moves earlier comes back into the kept set and gets updated, so stale open rows correct themselves; if they cannot, they sit past the kept range and outside the 7-day digest.
- Ordering (M1), staleness (M2) and budget (M3) are the problems.

**Snapshot (item 5)**
- The failed branch reports `source.lastSuccessAt` read before the fetch (`job-table.ts:196-201, 234`), i.e. the last success, not the last attempt.
- The cooldown branch re-reads it (`:276`).
- A failed refresh never claims success, except in the L2 `finish`-throws case, where the wording errs the other way.
- The timezone is wrong (L1).

**PR #49 guarantees (item 6)**
- `redirect: "manual"` plus refusal of 3xx, `opaqueredirect` and status 0, with the body cancelled, is intact (`brightspace-ical-client.ts:584-599`).
- Component isolation is intact (`:493`).
- Window bounds are unchanged (`job-table.ts:151-156`).
- Cancellation still closes only open rows (`deadline-repository.ts:482`), and the new F3 test pins it.
- Archive isolation in `poll` is unchanged (`job-table.ts:327-334`).
- The F2 malformed-component test is present.
- **Regressed:** the staleness gap for truncated sources (M2).
