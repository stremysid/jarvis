# PR #39 re-verification: `0016_cloud_memory.sql` at `eb70b70`

Scope: static trace of the fix commits `6055a93` and `a2a2329` against the adversarial report on `4f2c1c0`. Line numbers are `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` at `eb70b70` (2663 lines) unless another file is named. Read only; no tests run.

Placeholders are as in the prior report. `CMD(op, target)` = a `memory.owner_command` event that passes `memory_valid_owner_commands` (878-898) with that payload operation and targetId.

**Counts (18 findings re-checked): FIXED 12, PARTIALLY FIXED 6, NOT FIXED 0.**
**New findings: 1 High, 5 Medium, 4 Low.**

---

## 1. Finding status

| Finding | Status | Evidence |
|---|---|---|
| **H1** rules undo owner forget/reject | **FIXED** | 1335-1343 rejects any non-owner transition while state is `forgotten`/`rejected`. The original T3 (`rules`, `active`, from `forgotten`) now raises `memory_item_transition_invalid`. An owner exit needs `CMD('item.correct', NEW.transition_id)` (1386-1404). Residual beyond H1's scope (rules can still overwrite owner confirmation/supersession): see **N5**. |
| **H2** REPLACE bypasses guards | **PARTIALLY FIXED** | Every natural PK/UNIQUE key is now checked in its insert guard, and `memory_cursors` has a guard (2613-2622). `apply_state` is split into insert-if-absent plus a guarded UPDATE (1409-1432). Original (a)-(d) now raise: (a) 1480; (b) 1436-1439; (c) 2527; (d) 2615. **Still exposed:** (1) `UPDATE OR REPLACE` on `memory_item_state`, `memory_item_placement_state` and `memory_topics`, because their update guards do not pin key columns (**N1**, High); (2) `INSERT OR REPLACE` through the rowid-alias PKs `version_rowid`, `episode_rowid` and `chunk_rowid`, which no guard checks (**N8**). Per-table matrix in section 1a. |
| **H3** stale correction lifts a forget | **FIXED** | 1617-1625 requires the correction to be the item's owner transition with `transition_number > forgotten.transition_number`, and it must equal `current_state.last_transition_number`/`last_transition_id`. 1586 requires the lift command's sequence to be greater than the suppression command's. Original: T2 (number 2) < T3 (number 3), so it raises. Raw variant: it reuses S's authorizing event, so `command.sequence > suppression_command.sequence` is false, and the operation must be `history.lift` with `targetId = lift_id` (1588-1590), so it raises. |
| **H4** topic replay cycle, CTE never terminates | **PARTIALLY FIXED** | Replay is closed. 1947 rejects an unchanged `last_topic_event_id`. 1953-1962 requires the event to be newer than OLD's event. 1963-1972 requires it to be the topic's newest event. The original `UPDATE … last_topic_event_id='e1'` fails all three. The CTEs now terminate (`UNION` plus `depth < 64`, 1740-1751, 1782-1793). **But cycle rejection is now bounded:** a move or merge onto a descendant deeper than 64 is not detected, and topic depth is uncapped, so a cycle can still be created (**N4**). |
| **H5** episode visible with missing/partial sources | **PARTIALLY FIXED** | `source_count` (488-490). The view requires `count(sources) = source_count` (961-965), and the source guard requires the sequence to be in range (2242). Zero sources and the insert-then-sources window are now hidden. **Still open:** the "(or only E10, E20)" variant. `INSERT memory_episodes(... start=10, end=20, source_count=2, text=<turn-15 detail>)`, then sources E10 and E20, then a suppression on E15: the view returns EP1. Nothing requires the source set to cover the principal's conversation events in `[start,end]`, and the view does not anti-join the range. Fix: have the view also reject episodes whose `[start,end]` overlaps an active suppression (as `memory_retrievable_history_chunks` does, 982-998), or require `source_count` = the live conversation-event count in range. |
| **M1** settlement/release unbounded | **FIXED** | 2596-2599: a settlement must be `<= reservation.amount_micros`, a release `=` it. Side effect: see **N10**. |
| **M2** reprocessing budget misuse | **FIXED** | 2538-2579: `budget_class` ⇔ `run.job`. The job must be `pending|running` and `dry_run=0`, with matching range and model. Cumulative settled plus open reservations plus NEW must stay `<= spend_limit_micros`. Splitting reservations cannot bypass this: the sum is per `reprocess_job_id` across all runs, released reservations drop out, and settlements are capped by M1. The original (`distillation` run, `budget_class='reprocessing'`) fails at 2544. **New breakages from this fix:** **N2** and **N3**. |
| **M3** third-party/inferred stored certain | **FIXED** | CHECKs at 69-70, and `confirmed` activation requires `actor='owner'` (1358-1364). The original row fails CHECK 70 (`third_party` basis with a first-person origin). |
| **M4** history chunks mutable | **FIXED** | `memory_history_chunks_immutable_update` (2289-2293). The insert guard needs an exact-range `indexed` coverage receipt whose `content_hash = source_receipt_hash` (2266-2287). Both original UPDATEs raise. Residual: a REPLACE via `chunk_rowid` skips the FTS delete trigger (**N8**). |
| **M5** live coverage claims any range | **FIXED** | 2309: `end <= max(events.sequence)`. 2310-2313: no archived event in range. 2304-2308: at least one principal event. The original `end=9007199254740991` raises. |
| **M6** placement replay | **FIXED** | 2173 and 2184 require `NEW.number = OLD.number + 1`. 2176-2181 requires an active target topic. 2195 requires `last_event_id` to change on the topic branch. The original (number 2 over OLD 3) raises. A cross-key variant via `UPDATE OR REPLACE` remains (**N1**). |
| **M7** alias rules | **FIXED** | A merge needs at least one alias (1828). A move may carry aliases (the move branch 1722-1757 does not restrict them). An alias `topicId` must be `COALESCE(merge_target, topic_id)` (1839-1840). Both original inserts raise. Minor residual: alias names/paths are not bound to the topic's previous name or path. |
| **M8** sourceless versions, creation event | **FIXED** | `active` needs at least one source (1347-1351). A first-person version needs a live `user_committed` source of P (1365-1383). `creation_event_id`/sequence is validated on insert (1028-1047), and the view requires sources (923-927) and anti-joins the creation event (940-951). The original sequence raises at the transition. Possible legit-path cost: **N9**. |
| **M9** owner authority = any owner message | **PARTIALLY FIXED** | Authority is now a dedicated `memory.owner_command` (view 878-898) whose `targetId` must equal the new row's unique id, so each command is single-use (1392, 1490/1493, 1590/1593, 1665, 2095, 2479). Suppressions must be newer than their target (1500-1505), and lifts newer than the suppression command (1586). The original "hi" message no longer authorizes anything. **Still open (SUSPECTED, design-level):** (a) only `reprocess.create` binds operands (2480-2487). Transition state/version, topic new name/parent/merge target, placement topic and `history.suppress` target/range are not bound, so a command for target X authorizes any mutation with id X. (b) `event_type`/`source` are not allowlisted anywhere. `validateEnvelope` (`packages/contracts/src/envelope.ts:191`, field check at `+18`) only requires strings, and `event-repository.ts:201` inserts any type. No producer of `memory.owner_command` exists in `src`. Authenticity therefore rests entirely on future application code. See **N6**. |
| **L3** checkpoint rewinds via NULL | **FIXED** | 2507-2509. |
| **L4** ledger timing free | **PARTIALLY FIXED** | 2536: `occurred_at >= run.started_at`. 2537: a reservation needs `run.outcome='running'`. But `memory_runs.started_at` is unconstrained (insert guard 2384-2419), so backdating still works: `INSERT memory_runs(... outcome='running', started_at='2026-08-01T00:00:00.000Z')`, then `INSERT memory_cost_ledger(... entry_type='reservation', occurred_at='2026-08-01T00:00:01.000Z')` is accepted in September and missed by the September cap. Fix: bound `started_at` to within a small window of `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in the run insert guard. |
| **L6** suppression counts not exact | **PARTIALLY FIXED** | A target suppression now requires `total_covered_turn_count = 1` (1533). A range suppression is still only bounded above by its span (1534-1537), and `newly_hidden_turn_count` is still unchecked. `(start=10, end=20, total_covered_turn_count=1, newly_hidden_turn_count=0)` is accepted over 11 turns. |
| **L9** topic update doesn't pin created_at/principal | **FIXED** | 1945-1946. `topic_id` is still unpinned (see **N1**). |

### 1a. H2 per-table REPLACE matrix

"Natural keys covered" = the insert guard raises on any existing PK/UNIQUE value other than a rowid alias. "UPDATE OR REPLACE" = whether an UPDATE can move a row onto another row's key. It is closed when the update trigger is unconditional or pins every key column.

| Table | Natural keys covered (lines) | Rowid alias unguarded | UPDATE OR REPLACE |
|---|---|---|---|
| memory_items | yes (1031-1033) | - | closed (1049) |
| memory_item_versions | yes (1231-1237) | **`version_rowid`**: only childless versions (CASCADE into guarded sources/transitions aborts) | closed |
| memory_item_sources | yes (1253-1259) | - | closed |
| memory_item_transitions | yes (1290-1296) | - | closed |
| **memory_item_state** | yes (1436-1439) | - | **OPEN**: key not pinned (1454-1469) |
| memory_event_suppressions | yes (1479-1482) | - | closed |
| memory_event_suppression_lifts | yes (1568-1571) | - | closed |
| memory_item_links | yes (1634-1641) | - | closed |
| **memory_topics** | yes (1916-1926) | - | **OPEN**: `topic_id` not pinned (1943-2006); narrowed by FK RESTRICT on children, aliases and placements |
| memory_topic_events | yes (1654-1657) | - | closed |
| memory_topic_aliases | yes (2019-2025) | - | closed |
| memory_item_placement_events | yes (2044-2050) | - | closed |
| **memory_item_placement_state** | yes (2134-2140) | - | **OPEN**: `placement_id`/`item_id` not pinned (2159-2208) |
| memory_episodes | yes (2221-2224) | **`episode_rowid`**: only episodes with no sources or successors (CASCADE/RESTRICT) | closed |
| memory_episode_sources | yes (2231-2237) | - | closed |
| memory_history_chunks | yes (2268-2271) | **`chunk_rowid`**: any chunk; skips the FTS delete trigger | closed (2289) |
| memory_history_coverage | yes (2297-2300) | - | closed |
| memory_vectors | yes (2333-2342) | - | closed (2347-2360 pins all keys) |
| memory_model_prices | yes (2373-2379) | - | closed |
| memory_runs | yes (2386-2390) | - | closed (2425-2427) |
| memory_reprocess_jobs | yes (2456-2459) | - | closed (2495-2496) |
| memory_cost_ledger | yes (2526-2529) | - | closed |
| memory_cursors | yes (2615-2619) | - | closed (2626-2627) |

---

## 2. New findings (most severe first)

### N1. HIGH: `UPDATE OR REPLACE` rewinds another item's lifecycle, or an old placement, because projection update guards don't pin the key. CONFIRMED (SQLite REPLACE semantics; D1 `recursive_triggers` assumed off, as in H2)
- **Where:** `memory_item_state_update_guard` 1454-1469, `memory_item_placement_state_update_guard` 2159-2208, `memory_topics_update_guard` 1943-2006.
- **Why:**
  - The guards validate NEW against a ledger row for NEW's key and check a `+1` against OLD's counter. They never require `NEW.<key> = OLD.<key>`.
  - With `OR REPLACE`, the PK conflict deletes the victim row without firing `*_delete_guard`.
- **SQL, item state.** J has T1 `proposed`, T2 `active` V1 (live user source) and T3 `superseded` or `expired` (no suppression). Item I has exactly one transition (last=1).
```sql
UPDATE OR REPLACE memory_item_state
SET item_id='J', current_version_id='V1', lifecycle_state='active',
    last_transition_id='T2', last_transition_number=2,
    updated_at=(SELECT occurred_at FROM memory_item_transitions WHERE transition_id='T2')
WHERE principal_id='P' AND item_id='I';
-- guard: 2 = OLD(1)+1 ok; the T2 row matches NEW -> passes. J's T3 state row is deleted silently.
SELECT version_id FROM memory_retrievable_item_versions WHERE item_id='J';  -- V1: owner-superseded fact is back
-- I's state row is gone; I's next transition must be number 1 (1303-1307) and collides with the existing T1 -> I wedged; J's next is 3 -> collides with T3 -> J wedged
```
  - For a `forgotten` J, the rewind corrupts and wedges both items. V1 becomes retrievable wherever its sources are not all suppressed.
- **SQL, placement.** PL2 had #1 place T1, #2 refile T1→T2 (PE2) and #3 remove. PL1 is active in T1 with last=1.
```sql
UPDATE OR REPLACE memory_item_placement_state
SET placement_id='PL2', item_id='I2', topic_id='T2', last_event_kind='placement', last_event_id='PE2',
    last_placement_event_number=2, updated_at=(SELECT occurred_at FROM memory_item_placement_events WHERE placement_event_id='PE2')
WHERE placement_id='PL1';   -- passes 2172-2182; PL2 un-removed, PL1 deleted; the partial primary index can also delete I2's other primary
```
- **Topics:** the same move for a leaf B, where B has no aliases, children or placements, and A is a leaf under B's previous parent. Topic A disappears.
- **Tests:** `guardedUpdates` (test 1923-1940) only runs `SET key = key`. No `UPDATE OR REPLACE` or key-change test exists.
- **Fix:** add `NEW.principal_id <> OLD.principal_id OR NEW.item_id <> OLD.item_id` to 1456. Add `NEW.principal_id <> OLD.principal_id OR NEW.placement_id <> OLD.placement_id OR NEW.item_id <> OLD.item_id OR NEW.relation <> OLD.relation` as an OR-ed raise condition in 2159. Add `NEW.topic_id <> OLD.topic_id` to 1945.

### N2. MEDIUM: day-range reprocessing jobs can never reserve or settle cost (legit write path broken). CONFIRMED
- **Where:** runs insert guard 2411-2413; ledger guard 2552-2553.
- **Why:**
  - For a `start_day` job, the run must have non-null `start_event_sequence`/`end_event_sequence`.
  - The ledger requires `run.start_event_sequence IS job.start_event_sequence`, which is NULL for day jobs. The two conditions are contradictory.
- **SQL:**
```sql
-- J: start_day='2026-09-01', end_day='2026-09-02', status 'running', dry_run 0, authorized
INSERT INTO memory_runs (... job='reprocessing', reprocess_job_id='J', start_event_sequence=100, end_event_sequence=200, outcome='running' ...);  -- accepted
INSERT INTO memory_cost_ledger (... run_id=<run>, entry_type='reservation', budget_class='reprocessing', reprocess_job_id='J', amount_micros=1000 ...);
-- raises memory_cost_entry_lineage_invalid (100 IS NULL is false). With NULL run sequences the run insert raises instead.
```
- **Also:** day-job run sequences are never bound to the job's day window.
- **Tests:** every test job uses `startDay: null` (test 374, 994, 1278, 1297, 1384, 1447).
- **Fix:** replace 2552-2553 with `AND (job.start_day IS NOT NULL OR (run.start_event_sequence = job.start_event_sequence AND run.end_event_sequence = job.end_event_sequence))`, and bind day-job run ranges to events inside `[start_day, end_day]`.

### N3. MEDIUM: an open reprocessing reservation cannot be settled or released once its job leaves `pending|running`. CONFIRMED
- **Where:** 2546-2551. The job `status IN ('pending','running') AND dry_run = 0` check applies to every entry type. Only the limit sum is gated on `reservation`.
- **Effect:**
  - Cancelling a job, or marking it failed or succeeded (2511-2512), while a provider call is in flight leaves the reservation permanently open.
  - The real spend can never be recorded, so the reprocessing pool is misstated. Stuck reservations count as spend if caps sum open reservations; the true cost is lost if caps sum settlements.
- **SQL:**
```sql
-- reservation R1 on job J (running); then:
UPDATE memory_reprocess_jobs SET status='cancelled', final_receipt_hash='<h>', updated_at='...' WHERE job_id='J';
INSERT INTO memory_cost_ledger (... entry_type='settlement', reservation_entry_id='R1', budget_class='reprocessing', reprocess_job_id='J', amount_micros=900 ...);  -- raises
```
- **Fix:** wrap the job status and `dry_run` checks as `(NEW.entry_type <> 'reservation' OR (job.status IN ('pending','running') AND job.dry_run = 0))`.

### N4. MEDIUM: the depth-64 bound turns cycle rejection into cycle permission for deep trees. CONFIRMED
- **Where:** the move CTE at 1739-1753 and the merge CTE at 1781-1795. Design §6.1 (`2026-09-14-r2-memory-design.md:260`) promises "arbitrary useful depth". No create, move or merge caps tree depth. `actor='model'` needs no owner command (1658-1667).
- **SQL:**
```sql
-- model creates chain R -> C1 -> C2 -> ... -> C66
INSERT INTO memory_topic_events (... topic_id='C1', operation='move', previous_parent_topic_id='R', new_parent_topic_id='C66', actor='model' ...);
-- descendants of C1 stop at C65 (depth 64); C66 (depth 65) is not found -> accepted
-- C1..C66 now form a cycle detached from root; subtree walks from root silently miss 66 topics and their placements
```
- **Merge:** the same bypass works. Merging C1 into C66 reparents C2 under C66, which closes a cycle.
- **Legit deep trees:** valid moves still succeed. The bound only fails open, not closed.
- **Fix:** walk ancestors of `NEW.new_parent_topic_id` (or `merge_target_topic_id`) upward. Reject if the walk reaches `NEW.topic_id`, or if it hits the 64 cap before reaching root. Enforce the same max depth on create.

### N5. MEDIUM: rules can still overwrite an owner confirmation, correction or supersession. CONFIRMED against design §9 (`:486`)
- **Where:**
  - The actor ban at 1334 covers only `rejected|superseded|forgotten`.
  - The owner-state lock at 1335-1343 covers only `forgotten|rejected`.
  - The matrix at 1327-1331 lets rules write `active→expired`, and `superseded|expired→active` with a higher version.
- **SQL:**
```sql
-- T2 owner 'active' on V2 (basis 'confirmed', CMD('item.transition','T2'))
INSERT INTO memory_item_transitions (... transition_number=3, version_id='V2', lifecycle_state='expired', actor='rules', owner_authorizing_event_id=NULL ...);   -- accepted
INSERT INTO memory_item_versions (... version_id='V3', version_number=3, basis='observed', origin='deterministic_observation', uncertain=0 ...);  -- plus a source row
INSERT INTO memory_item_transitions (... transition_number=4, version_id='V3', lifecycle_state='active', actor='rules' ...);  -- accepted; the owner-confirmed V2 is replaced
-- likewise: owner 'superseded' (from active) -> rules 'active' on a higher version
```
- **Fix:** add `OR (NEW.actor <> 'owner' AND EXISTS (SELECT 1 FROM memory_item_state s JOIN memory_item_transitions t ON t.principal_id = s.principal_id AND t.transition_id = s.last_transition_id WHERE s.principal_id = NEW.principal_id AND s.item_id = NEW.item_id AND t.actor = 'owner'))`. If rules must expire time-bounded owner facts, allow only `expired` when `valid_to <= NEW.occurred_at`.

### N6. MEDIUM: owner commands bind operation and target id, but not operands; authenticity is unenforced. SUSPECTED (design-level, M9 residual)
- **Where:** 1386-1404, 1487-1497, 1587-1598, 1659-1667, 2088-2097; view 878-898; `packages/contracts/src/envelope.ts:191`; `apps/cloud-gateway/src/persistence/event-repository.ts:201`.
- **Why:**
  - `CMD('item.transition', T)` authorizes transition T with any `lifecycle_state` or `version_id`.
  - `CMD('topic.merge', E)` authorizes any merge target.
  - `CMD('placement.refile', E)` authorizes any destination topic.
  - `CMD('history.suppress', S)` authorizes any target or range, and `CMD('item.forget', T)` does not bind which source turns its suppressions hide.
  - Any code path that appends an envelope with `eventType='memory.owner_command'` and `source='memory-control'` mints authority. There is no event-type allowlist and no producer yet.
- **SQL:**
```sql
-- owner asked to confirm item I -> CMD('item.transition','T9') issued
INSERT INTO memory_item_transitions (transition_id='T9', ..., lifecycle_state='expired', actor='owner', owner_authorizing_event_id=<CMD>) ;  -- accepted
```
- **Fix:** add payload fields per operation and compare them in each guard (`$.payload.lifecycleState`/`versionId`, `newParentTopicId`/`mergeTargetTopicId`/`newDisplayName`, `newTopicId`, `targetEventId`/`startEventSequence`/`endEventSequence`). Also add an `events` BEFORE INSERT guard (in a separate reviewed migration) that allows `memory.owner_command` only from `source='memory-control'` with `producerVersion='memory-control-v1'`.

### N7. LOW: a far-future `occurred_at` on any topic event permanently wedges that topic and blocks merges of its parent. CONFIRMED
- **Where:** update guard 1953-1972 orders history by caller-supplied `occurred_at`. The topic event insert guard (1652-1844) never bounds `occurred_at` or checks it against the topic's last event.
- **SQL:**
```sql
INSERT INTO memory_topic_events (... topic_id='T', operation='rename', actor='model', occurred_at='2099-01-01T00:00:00.000Z' ...);  -- accepted and applied
-- every later event for T has occurred_at < 2099 -> the apply UPDATE fails "newer than previous" -> the event insert aborts forever
-- merge of T's parent: the child reparent UPDATE of T fails the same check -> the whole merge aborts
```
- Clock skew between a model create and an owner merge fails closed in the same way.
- **Fix:** order topic history by an insert-assigned sequence (or ULID `topic_event_id`) and require `NEW.occurred_at >=` the topic's current last-event `occurred_at` and `<= strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')`.

### N8. LOW: `INSERT OR REPLACE` through rowid-alias PKs bypasses delete guards and FTS maintenance. CONFIRMED (SQLite semantics)
- **Where:** `version_rowid` (22; guard 1229-1249), `episode_rowid` (477; guard 2219-2227), `chunk_rowid` (542; guard 2266-2287).
- **SQL:**
```sql
-- C1 [10,20] contains turn 15 (rowid 7); a coverage receipt exists for [21,30]
INSERT OR REPLACE INTO memory_history_chunks (chunk_rowid, chunk_id, principal_id, start_event_sequence, end_event_sequence, text, content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at)
VALUES (7, 'C2', 'P', 21, 30, 'benign', '<h>', 'live', NULL, '<cov hash>', '...', '...');
-- C1 is deleted without memory_history_chunks_fts_delete; FTS keeps turn-15 tokens on rowid 7, which now joins to C2 (a false hit; later 'delete' corrupts the index)
```
  - A childless version (between insert and its sources or transition) or a sourceless episode can be deleted the same way.
- **Tests:** the REPLACE tests (test 1912-1921) only replay the natural key via `SELECT *`.
- **Fix:** add `OR (NEW.<rowid_col> IS NOT NULL AND EXISTS (SELECT 1 FROM <table> WHERE <rowid_col> = NEW.<rowid_col>))` to the three insert guards.

### N9. LOW: first-person activation requires a live source, so first-person versions citing only archived turns can never become active. SUSPECTED (legit-path)
- **Where:** 1372-1382 (`source.source_location = 'live'`, joined to `events`). The design (`:30`) includes archived conversation history.
- **Effect:** after archival, a reprocessing job or correction that re-extracts `authenticated_first_person` claims from R2 segments produces versions that stay `proposed` forever.
- **Fix:** also accept `source_location='archived'` with a verified `archive_segment_events` receipt and a principal mapping. That mapping depends on L1.

### N10. LOW: the M1 fix makes true provider overruns unrecordable. SUSPECTED
- **Where:** 2597, where a settlement must be `<= reservation.amount_micros`. There is no overrun entry type.
- **Effect:** if a reservation is an estimate rather than a hard ceiling, actual spend above it cannot be written, and monthly caps under-count.
- **Fix:** add `entry_type='overrun'` linked to a settled reservation, and count it in the monthly and job-limit sums.

---

## 3. Remote D1 rules

- **No `CASE … RAISE`.** Every `RAISE(ABORT, …)` sits in an unconditional trigger body gated by `WHEN`.
- **New `CASE` expression** in the `memory_item_transitions_insert_guard` WHEN (1393-1402), holding an `EXISTS` subquery. It is not a RAISE form, so it complies. The contract-test regex (`SELECT\s+CASE … RAISE(`) would not catch a future `CASE WHEN … THEN RAISE` outside a `SELECT`.
- **Recursive CTEs:** no new ones. The same two remain at 1740 and 1782 (formerly 1519 and 1560), changed to `UNION` plus a `depth` column. Remote D1 acceptance of `WITH RECURSIVE` inside trigger WHEN subqueries is still unproven (I1 stays SUSPECTED). The attended scratch remote run proposed in AGENT_LOG is still required.
- **No window functions.**
- **Removed:** `ON CONFLICT … DO UPDATE` inside a trigger (old 1268). This reduces remote-compat risk.
- **New, standard SQLite, same remote proof needed:**
  - compound `UNION`/`UNION ALL` inside `EXISTS` in trigger WHEN (1040, 1528);
  - `json_each(x, '$.path')` with a path argument (1495, 1595).

## 4. Tests

- **`cloud-memory-trigger-contract.test.ts` is still string-only.** It checks the trigger-name inventory and runs a `SELECT CASE … RAISE` regex lint, and it touches no database. It is no longer a mutation tautology:
  - the self-deleting "removal contract" is gone;
  - it is renamed "trigger SQL inventory" (diff at `4f2c1c0..eb70b70`).
  - It is honest lint, but not behavioral evidence.
- **Database behavior is now in `cloud-memory-migration.test.ts`.** It runs on Miniflare D1 (`env.DB`), with named adversarial tests (test 1079-1728) and per-trigger immutability, insert, update, delete and apply tests (1871-2014). These exercise real DB behavior. Codex reports that a reviewer mutation run killed 75 of 75.
- **Gaps that let the new findings through:**
  - **REPLACE:** only natural-key `INSERT OR REPLACE … SELECT *` (1913-1920); no `UPDATE OR REPLACE` and no rowid alias (N1, N8).
  - **Update guards:** tested only with `SET key = key` (1936), so key changes are never tried (N1).
  - **Reprocessing:** no day-range job (N2); no settlement after job cancel (N3).
  - **Topics:** no depth-65 move or merge (N4).
  - **Items:** no rules transition after an owner confirmation or supersession (N5).
  - **Episodes:** no declared-partial episode source set (H5).
  - **Local only:** `PRAGMA recursive_triggers` is never set or asserted, and nothing proves remote D1.
