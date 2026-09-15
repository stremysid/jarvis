# PR #39 adversarial review: `0016_cloud_memory.sql` (head c2fcc96)

Scope: `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` (2157 lines; line numbers below are that file on `origin/codex/r2-memory-schema-0016`), checked against `docs/plan/2026-09-14-r2-memory-design.md` sections 3, 5, 6 and 8. Read-only static trace; no tests were run.

Placeholders: `P` = the human principal. `E<n>` = a live `conversation.user_committed` or `conversation.assistant_delivered` event of `P` at sequence n. `A*` = any `conversation.user_committed` event of `P`. `...` = the remaining NOT NULL columns, filled validly.

Status: **CONFIRMED** means the exact SQL path was traced through every CHECK, FK and trigger. **SUSPECTED** means it depends on something not provable from the file.

Counts: **High 5, Medium 9, Low 9, D1/Info 3.**

---

## HIGH

### H1. The `rules` actor can undo an owner `/forget` or `rejected` without owner authorization. CONFIRMED
- **Where:** `0016:1224-1233` (lifecycle matrix), `0016:1234-1242`, view `0016:879-897`.
- **Invariant broken:** only an owner lift or correction can restore a forgotten item. The design (§9) says rules and reprocessing "cannot overwrite an owner correction, confirmation or forget transition".
- **Why it happens:**
  - The matrix lets `forgotten|rejected|superseded|expired -> proposed|active` whenever the next version number is higher.
  - The only actor restriction is that `rules` cannot write `rejected`, `superseded` or `forgotten`. Nothing stops `rules` writing `active` out of `forgotten`.
  - The retrievable view anti-joins only the **new** version's sources. A new version with no sources, or with different sources, is visible.
- **SQL:**
```sql
-- item I: T1 active (V1, source on E15, actor rules); T2 forgotten (owner, A1) + suppression S on E15
INSERT INTO memory_item_versions (version_id, principal_id, item_id, version_number, text, text_normalization,
  text_hash, basis, origin, uncertain, sensitivity, extractor_version, created_at)
VALUES ('V2','P','I',2,'<same wording>','NFC','<h>','observed','deterministic_observation',0,'normal','x','2026-09-14T10:00:00.000Z');
INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id,
  lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('T3','P','I',3,'V2','active','auto','rules','p1',NULL,'2026-09-14T10:00:00.000Z');
SELECT item_id FROM memory_retrievable_item_versions WHERE item_id='I';  -- returns V2; placements unchanged, so topic walks return it too
```
- **Fix:** add `OR (NEW.actor <> 'owner' AND EXISTS (SELECT 1 FROM memory_item_state s WHERE s.principal_id=NEW.principal_id AND s.item_id=NEW.item_id AND s.lifecycle_state IN ('forgotten','rejected')))` to the transition guard.

### H2. `INSERT OR REPLACE` bypasses every immutability and delete guard: un-hide, state rewind, reservation shrink, cursor reset. CONFIRMED (SQLite semantics; D1's `recursive_triggers` setting is SUSPECTED off)
- **Where:**
  - Immutable triggers `0016:969-1147`.
  - Projection delete guards `0016:1309`, `1925`, `1751`, `2120`.
  - Insert guards `0016:1276`, `1315`, `1379`, `1860`, `1687`, `2074`.
  - `memory_cursors` has no insert guard at all.
- **Invariant broken:** append-only ledgers, and projections that change only through events.
- **Why it happens:**
  - Under REPLACE conflict resolution, SQLite deletes the conflicting row **without firing DELETE triggers** unless `PRAGMA recursive_triggers` is on. It is off by default, and it is a per-connection setting that a migration cannot pin.
  - BEFORE INSERT guards validate only the new row. None of them checks that the key is unused.
  - FK `RESTRICT` and `CASCADE` into guarded children block some cases: lifted suppressions, and versions or transitions that have children. The cases below have no such children.
- **SQL (a): un-hide an active suppression.**
```sql
-- S1 is active (no lift) and targets E15
INSERT OR REPLACE INTO memory_event_suppressions (suppression_id, principal_id, target_event_id,
  owner_authorizing_event_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at)
VALUES ('S1','P','E16','<A_any_old>','x',0,1,'2026-09-14T10:00:00.000Z');
SELECT 1 FROM memory_visible_recent_events WHERE event_id='E15';  -- visible again; no lift row, audit trail gone
```
- **SQL (b): rewind the item-state projection to an older active transition.**
```sql
-- T1 active V1 (sources on E10), T2 active V2 (sources on E20), T3 forgotten V2 + suppression on E20
INSERT OR REPLACE INTO memory_item_state (principal_id,item_id,current_version_id,lifecycle_state,
  last_transition_id,last_transition_number,updated_at)
SELECT principal_id,item_id,version_id,lifecycle_state,transition_id,transition_number,occurred_at
FROM memory_item_transitions WHERE transition_id='T1';   -- insert guard passes, since T1 matches
-- V1 is retrievable; next transition number becomes 2 -> UNIQUE clash -> the item's ledger is wedged
```
- **SQL (c): shrink an in-flight reservation.**
```sql
INSERT OR REPLACE INTO memory_cost_ledger (cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
  provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at)
VALUES ('R1','P','RUN1','reservation',NULL,'deepseek','deepseek:deepseek-v4-pro','normal_monthly',NULL,1,'PR1','2026-09-14T10:00:00.000Z');
```
- **SQL (d): rewind a cursor, forcing re-distillation and double spend.**
```sql
INSERT OR REPLACE INTO memory_cursors VALUES ('P','distillation',0,'2026-09-14T10:00:00.000Z');
```
- **Other REPLACE effects:**
  - Rewind a moved or merged `memory_topics` row to its create values. It must have no RESTRICT children. The sibling-name unique index can also delete another active topic.
  - Rewind `memory_item_placement_state` to its original `place`.
  - Swap one `memory_event_suppression_lifts` row for another via `lift_id`.
- **Tests:** none of the tests exercise REPLACE.
- **Fix:** add `OR EXISTS (SELECT 1 FROM <table> WHERE <pk/unique key> = NEW.<key>)` to every ledger insert guard, and add a matching insert guard for `memory_cursors`. For `memory_item_state`, split `apply_state` into `INSERT … WHERE NOT EXISTS` plus a plain `UPDATE`, then add the same guard.

### H3. A lift can reuse a stale owner correction or authorization, un-hiding raw turns with no new owner action. CONFIRMED
- **Where:** `0016:1386-1416`.
- **Invariant broken:** a lift needs a fresh owner correction that comes after the forget (§3.3, §8).
- **Why it happens:**
  - The correction transition only needs to be for the same item, with `actor='owner'`, state `proposed|active`, and the same authorizing event as the lift.
  - It is never required to come **after** the `forgotten` transition, or to be the item's current transition.
  - For raw suppressions, the lift may reuse the suppression's own authorizing event.
- **SQL:**
```sql
-- T2: owner 'active' (auth A0) on item I, earlier; T3: owner 'forgotten' (auth A1); S: forgotten_transition_id=T3, target E15
INSERT INTO memory_event_suppression_lifts (lift_id, principal_id, suppression_id, owner_authorizing_event_id,
  correction_transition_id, reason, created_at)
VALUES ('L1','P','S','A0','T2','x','2026-09-14T10:00:00.000Z');
-- passes; E15 is back in recent turns, history chunks and episodes while item state is still 'forgotten'
-- raw variant: correction_transition_id NULL, owner_authorizing_event_id = S.owner_authorizing_event_id -> passes
```
- **Fix:** require `correction_transition.transition_number > forgotten_transition.transition_number` and `= state.last_transition_number`. Also require the lift's authorizing event sequence to be greater than the suppression's authorizing event sequence.

### H4. A topic UPDATE can replay an old move or merge event, creating a cycle; the recursive CTE then never terminates. CONFIRMED
- **Where:**
  - Update guard `0016:1705-1749`, move branch `1721-1728`, merge-child branch `1735-1741`.
  - CTEs `0016:1519-1530` and `1560-1571`.
- **Invariant broken:** "Topic moves reject cycles; merge redirects are bounded and cycle-free" (§3.3, §6.1).
- **Why it happens:**
  - The guard accepts any existing event whose id differs from `OLD.last_topic_event_id`.
  - The cycle check runs only when an event is inserted, never when an old event is replayed.
  - The merge-child branch does not check `OLD.parent_topic_id` at all.
- **SQL:**
```sql
-- root R; P0, P1 under R; T under P0
-- e1: move T P0->P1 ; e2: move T P1->P0 ; e3: move P1 R->T   (all accepted by the insert guard)
UPDATE memory_topics SET parent_topic_id='P1', last_topic_event_id='e1',
  updated_at=(SELECT occurred_at FROM memory_topic_events WHERE topic_event_id='e1')
WHERE topic_id='T';   -- passes: e1.previous_parent P0 IS OLD.parent
-- now T.parent=P1 and P1.parent=T: a cycle, detached from root, so subtree walks from root miss both
-- then: INSERT a 'move' of T to any topic outside the cycle -> `descendants` with UNION ALL loops forever
--       (EXISTS never finds the target) -> the statement hits the D1 time limit for every later move or merge of T or P1
```
- **Fix:**
  - Require `NEW.last_topic_event_id` to be the topic's newest event (e.g. `NOT EXISTS (later event for this topic_id)`), and have the apply trigger be the only writer.
  - Use `UNION`, not `UNION ALL`, with a depth bound in both CTEs.

### H5. The episode view trusts a missing or partial source set, so a summary of a hidden turn stays retrievable. CONFIRMED
- **Where:** view `0016:899-918`, source guard `0016:1931-1953`.
- **Invariant broken:** "Episodes … whose source set intersects an active suppression are ineligible" (§3.3). §8 says hidden text disappears from every retrieval path.
- **Why it happens:**
  - Visibility is decided only by `memory_episode_sources` rows.
  - Nothing requires those rows to exist or to be complete, or to fall inside `[start_event_sequence, end_event_sequence]`.
  - An episode is also visible in the window between its INSERT and a later batch that adds sources.
- **SQL:**
```sql
INSERT INTO memory_episodes (episode_id, principal_id, local_day, start_event_sequence, end_event_sequence, text,
  content_hash, summarizer_version, summarizer_model_id, created_at)
VALUES ('EP1','P','2026-09-13',10,20,'...summary incl. turn 15 detail...','<h>','s1','deepseek:deepseek-v4-pro','2026-09-14T00:00:00.000Z');
-- zero source rows (or only E10, E20)
INSERT INTO memory_event_suppressions (... target_event_id='E15', total_covered_turn_count=1 ...);
SELECT episode_id FROM memory_retrievable_episodes;  -- EP1 returned
```
- **Fix:** add `source_count INTEGER NOT NULL` to `memory_episodes` and have the view require `count(sources) = source_count`. Make the source guard reject `event_sequence` outside the episode's range.

---

## MEDIUM

### M1. A settlement can exceed its reservation, and a release is unbounded, so net spend can go negative. CONFIRMED
- **Where:** `0016:811-814`, `0016:2083-2105`.
- **Why it happens:** the guard checks lineage and single-terminal only. It never compares the settlement or release `amount_micros` to the reservation amount.
- **SQL:**
```sql
-- reservation R1 amount 1000
INSERT INTO memory_cost_ledger (..., entry_type='settlement', reservation_entry_id='R1', amount_micros=5000000000, ...);  -- accepted
-- or: entry_type='release', amount_micros=999999999999 -> accepted; reserved minus released goes deeply negative
```
- **Fix:** add `OR (NEW.entry_type='release' AND NEW.amount_micros <> r.amount_micros) OR (NEW.entry_type='settlement' AND NEW.amount_micros > r.amount_micros)`. Record any true overrun as a separate, explicit entry type.

### M2. Normal runs can bill the reprocessing budget, and job spend limits are never enforced. CONFIRMED
- **Where:** `0016:797`, `815-818`, `2076-2082`.
- **Why it happens:**
  - `budget_class='reprocessing'` only needs some `reprocess_job_id`.
  - It is not tied to `run.job='reprocessing'`, to job status (pending, running, cancelled or failed), to `dry_run=0`, or to the sum of `spend_limit_micros`.
- **SQL:**
```sql
-- RUN1.job='distillation'; J1 is any job, even cancelled or dry_run=1, spend_limit 1
INSERT INTO memory_cost_ledger (..., run_id='RUN1', entry_type='reservation', budget_class='reprocessing',
  reprocess_job_id='J1', amount_micros=900000000, ...);  -- accepted; escapes the USD 5 monthly pool
```
- **Fix:** add to the guard:
  - `(NEW.budget_class='reprocessing') <> (run.job='reprocessing')`;
  - job `status IN ('pending','running') AND dry_run=0`;
  - open reservations for the job plus `NEW.amount_micros` must not exceed `spend_limit_micros`.

### M3. Third-party or inferred basis can be stored as certain first-person and activated by rules. CONFIRMED
- **Where:** `0016:38-42`, `67-68`, `1234-1242`.
- **Why it happens:** the CHECKs constrain `origin`, never `basis`. `basis='confirmed'` needs no owner event either.
- **SQL:**
```sql
INSERT INTO memory_item_versions (..., basis='third_party', origin='authenticated_first_person', uncertain=0,
  extractor_model_id='deepseek:deepseek-v4-pro', ...);
INSERT INTO memory_item_transitions (..., lifecycle_state='active', actor='rules', ...);  -- accepted, now a certain fact
```
- **Fix:** `CHECK (basis NOT IN ('inferred','third_party') OR uncertain=1)` plus `CHECK (basis <> 'third_party' OR origin='third_party')`. Require `actor='owner'` to activate a `basis='confirmed'` version.

### M4. `memory_history_chunks` is fully mutable, so narrowing a chunk's range or relabelling its principal re-exposes hidden text. CONFIRMED
- **Where:** table `0016:536-570` (no update or delete guard), view `0016:920-940`, FTS `2144-2157`.
- **Why it happens:** the view trusts each chunk's self-declared range and principal, and nothing binds either to the chunk's text.
- **SQL:**
```sql
-- chunk C1 [10,20] contains turn 15; active suppression on E15
UPDATE memory_history_chunks SET start_event_sequence=16 WHERE chunk_id='C1';  -- no trigger blocks it; FTS keeps the text
SELECT chunk_id FROM memory_retrievable_history_chunks;  -- C1 returned with turn-15 text
-- or: UPDATE ... SET principal_id='<service principal>'  -> P's suppressions no longer apply
```
- **Fix:** add a `BEFORE UPDATE` RAISE, so a rebuild is a delete plus insert. Make the insert guard require a matching `memory_history_coverage` receipt for the range.

### M5. A live coverage row can claim any range if it contains one event, giving a false "complete, nothing found". CONFIRMED
- **Where:** `0016:1957-1964`.
- **Invariant broken:** coverage is "the proof behind a complete no-hit answer" (§3.2, §5.1).
- **SQL:**
```sql
INSERT INTO memory_history_coverage VALUES ('C','P','live',1,9007199254740991,NULL,'indexed','<h>',NULL,'2026-09-14T10:00:00.000Z');
```
- **Fix:** require `NEW.end_event_sequence <= (SELECT max(sequence) FROM events)` and `NOT EXISTS (archive_segment_events in range)` for `live`.

### M6. A placement-state UPDATE can replay an old refile, rewinding the counter, filing into a merged topic and wedging the placement. CONFIRMED
- **Where:** `0016:1880-1923`.
- **Why it happens:**
  - The placement branch never requires `NEW.last_placement_event_number = OLD + 1`.
  - It never requires the new topic to be active.
- **SQL:**
```sql
-- PL: place T1 (#1), refile T1->T2 (#2, PE2), refile T2->T1 (#3); later T2 merged into T3
UPDATE memory_item_placement_state SET topic_id='T2', last_event_id='PE2', last_placement_event_number=2,
  updated_at=(SELECT occurred_at FROM memory_item_placement_events WHERE placement_event_id='PE2')
WHERE placement_id='PL';  -- passes; active in merged T2; next event #3 collides with UNIQUE -> wedged
```
- **Fix:** add `NEW.last_placement_event_number = OLD.last_placement_event_number + 1` to the placement branch, and `NEW.last_event_id <> OLD.last_event_id` to the topic branch.

### M7. A merge can record no alias, a move cannot record one, and an alias can point at an unrelated topic. CONFIRMED
- **Where:** merge `0016:1536-1605` (no alias rule), move `1533` (aliases forbidden), alias shape `1606-1614` and `1757-1773` (`topicId` unconstrained).
- **Invariant broken:** a merge "preserves the old path as an alias"; historical names and paths resolve after rename, move or merge (§3.2, §6.3).
- **SQL:**
```sql
INSERT INTO memory_topic_events (..., operation='merge', topic_id='A', merge_target_topic_id='B',
  reparented_child_ids_json='[<exact>]', moved_placement_ids_json='[<exact>]', added_aliases_json='[]', ...);  -- accepted
INSERT INTO memory_topic_events (..., operation='rename', topic_id='A', added_aliases_json=
  '[{"aliasId":"<ulid>","topicId":"<UNRELATED>","displayName":"St. Remy","normalizedName":"st. remy","pathAlias":"/St. Remy"}]', ...);  -- accepted: alias hijack
```
- **Fix:**
  - Merge must carry at least one alias.
  - Allow aliases on move.
  - Add `OR EXISTS (SELECT 1 FROM json_each(NEW.added_aliases_json) e WHERE json_extract(e.value,'$.topicId') IS NOT COALESCE(NEW.merge_target_topic_id, NEW.topic_id))`.

### M8. Versions with no sources, and item creation events, are immune to event suppression; first-person origin needs no owner source. CONFIRMED
- **Where:** `0016:10-16` (`creation_event_id` and sequence are never validated or anti-joined), view `879-897`, `1164-1192`, `1234-1242`.
- **Why it happens:**
  - An active version with zero `memory_item_sources` rows cannot be hidden by any suppression.
  - An `authenticated_first_person` version can be activated when it has zero sources, or when its only sources are `assistant_delivered` or system events.
- **SQL:** insert V1 `origin='authenticated_first_person'` with no sources, then a rules `active` transition. Next, suppress the `/remember` turn (`memory_items.creation_event_id`). V1 is still in `memory_retrievable_item_versions`.
- **Fix:**
  - The transition guard must reject `active` unless the version has at least one source.
  - For first-person origin, at least one source must be a live `user_committed` event of `P`.
  - Validate `creation_event_id` and add it to the anti-join.

### M9. Owner authorization is any historical owner message, reusable without limit. SUSPECTED (design-level)
- **Where:** `0016:1243-1254`, `1317-1325`, `1386-1394`, `1435-1446`, `1814-1825`, `2031-2039`.
- **Why it happens:** any `conversation.user_committed` event of the human principal, of any age (for example "hi"), authorizes all of these, as often as a caller likes:
  - forget and lift;
  - owner topic operations;
  - owner filing;
  - a reprocessing job of up to USD 1,000 (`spend_limit_micros <= 1e9`).
- **Fix:** bind authorization to a dedicated owner-command event type whose payload hash names the operation, and require it to be newer than the target row's authorizing event.

---

## LOW

### L1. Archived receipts are not principal-scoped. CONFIRMED (impact limited while there is one human principal)
- **Where:** `0016:1181-1189`, `1336-1338`, `1346-1348`, `1942-1950`.
- **Detail:** `archive_segment_events` has no subject column, so an item or episode source, or a suppression target, can cite another principal's archived event.
- **Fix:** add a verified `(event_id, subject_id)` map for archived events and join to it.

### L2. The price record is never checked against the run's model. CONFIRMED
- **Where:** `0016:2076-2082`, `705-706`.
- **Detail:** an `anthropic:*` run can settle against a DeepSeek `price_id`.
- **Fix:** add `EXISTS (memory_model_prices p WHERE p.price_id=NEW.price_id AND p.model_id=NEW.model_id AND p.effective_at <= NEW.occurred_at)`.

### L3. The reprocessing checkpoint can move backwards via NULL. CONFIRMED
- **Where:** `0016:2058-2059`.
- **Detail:** `SET checkpoint_event_sequence=NULL`, then `=0`, both while running→running.
- **Fix:** add `OR (OLD.checkpoint_event_sequence IS NOT NULL AND (NEW.checkpoint_event_sequence IS NULL OR NEW.checkpoint_event_sequence < OLD.checkpoint_event_sequence))`.

### L4. Ledger timing is free. CONFIRMED
- **Where:** `0016:801`, `2076-2082`.
- **Detail:** `occurred_at` can be backdated into a previous month, which the month-index cap sums miss. Reservations are accepted on terminal runs.
- **Fix:** require `NEW.occurred_at >= run.started_at` and, for reservations, `run.outcome='running'`.

### L5. `memory_runs` token and cost columns are free-form. CONFIRMED
- **Where:** `0016:675-691`; there is no run insert guard.
- **Detail:** the columns are not reconciled to the ledger, and a run can be inserted already terminal.
- **Fix:** add an insert guard `NEW.outcome='running'`, and derive reported costs from the ledger.

### L6. Suppression receipt counts are not exact. CONFIRMED
- **Where:** `0016:1351-1355`.
- **Detail:** `newly_hidden_turn_count` is unchecked, and `total_covered_turn_count` is only bounded by the range span. §8 promises an "exact number".
- **Fix:** compute and compare the live conversation-event count for the range in the guard.

### L7. External-content FTS5 tables are directly writable. CONFIRMED
- **Where:** `0016:834-853`.
- **Detail:** `INSERT INTO memory_item_fts(memory_item_fts) VALUES('delete-all')`, or injected rowid/text rows. These are derived, so every hit must be rechecked. They are not enforcement.
- **Fix:** keep the hit recheck mandatory, and add a tripwire test for the rebuild.

### L8. Projection and cursor tables are not STRICT. CONFIRMED
- **Where:** `0016:147-166`, `450-468`, `821-832`.
- **Detail:** these are `WITHOUT ROWID` only, so text-key columns accept non-text values.
- **Fix:** use `WITHOUT ROWID, STRICT`.

### L9. The topic update guard does not pin `created_at` or `principal_id`. CONFIRMED
- **Where:** `0016:1705-1746`.
- **Detail:** combined with an H4-style replay, `created_at` can be rewritten.
- **Fix:** add `NEW.created_at = OLD.created_at AND NEW.principal_id = OLD.principal_id`.

---

## D1 compatibility and info

- **I1. `WITH RECURSIVE` inside trigger WHEN subqueries.** SUSPECTED.
  - **Where:** `0016:1519`, `1560`.
  - **What was checked:** there is no `CASE … RAISE` and no window function anywhere, and every RAISE sits behind `WHEN` or is unconditional. That part matches §3.3.
  - **Risk:** the recursive CTEs inside triggers are accepted by local SQLite (Miniflare), but remote D1 acceptance is unproven.
  - **Also:** they use `UNION ALL`, so they loop forever on any cycle (see H4).
  - `ON CONFLICT DO UPDATE` inside a trigger (`1262-1273`) and `json_each` in triggers are standard SQLite. They need the same proof against a scratch remote database.
  - `PRAGMA foreign_keys = ON` matches 0001, 0005 and 0014, so it is not a finding.
- **I2. `events` itself has no UPDATE or DELETE guard in 0001–0015.** SUSPECTED, pre-existing and outside 0016.
  - Only insert triggers exist on `events`. `archive_segment_events` is guarded.
  - Every 0016 suppression view and guard trusts `events.subject_id`, `sequence` and `event_type`. For example, `UPDATE events SET subject_id=…` un-hides a turn in `memory_visible_recent_events`.
  - **Fix:** a separate reviewed migration that guards `events` (the purge path permitting).
- **I3. No canonical retrievable view for topic walks or vectors.** Info.
  - Placements and `memory_vectors` have no anti-joined view, so §3.3's "every retrieval path joins it" rests entirely on application code for those two paths.
  - **Fix:** add `memory_retrievable_placements`, joining `memory_item_placement_state` to `memory_retrievable_item_versions`.

Checked and not broken:
- Assistant turns carry the owner's principal as `subject_id` (`conversation-repository.ts`), so the recent-turn view's principal join covers them.
- Inclusive `BETWEEN` range handling is correct in all three views.
- NULL handling for target-only and range-only suppressions is correct.
- A double lift is blocked by `UNIQUE (suppression_id)`.
- Cross-principal lifts are blocked by FK `(principal_id, suppression_id)`.
- Double release is blocked by the terminal-row EXISTS check.
- Plain UPDATE/DELETE on the ledger tables are blocked; the gap is REPLACE (H2).
- UPSERT `DO UPDATE` fires the update guards.
- A model-origin version cannot reach `active`.
