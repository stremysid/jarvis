# PR #39 round-3 re-verification: `0016_cloud_memory.sql` at `8b62e80`

## Scope and method

- **Scope:** a static trace of fix commit `8d1a910`, compared with round-2 report `pr39-reverify.md` at `eb70b70`. `6e23e33` and its revert `b002958` are ignored.
- **Line numbers:** `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` at `8b62e80` (2971 lines). "test N" means `apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts` at `8b62e80` (3297 lines).
- **Read only.** The test suite was not run.
- **Probe:** SQLite semantics were checked with an in-memory Python `sqlite3` probe (SQLite 3.45.3, `recursive_triggers=0`) on toy schemas that copy the relevant guard shapes. The probe used no repository files. It showed:
  - **P1:** `INSERT OR REPLACE INTO t(rowid, …)` on a STRICT TEXT-PK rowid table silently deletes the row that owns that rowid. BEFORE DELETE and BEFORE UPDATE guards do not fire. In a BEFORE INSERT trigger, `NEW.rowid` is `-1` unless the caller supplies it.
  - **P1b:** an FK `ON DELETE RESTRICT` child still blocks that delete.
  - **P2:** an outer `INSERT OR REPLACE` carries into a trigger body's `UPDATE`. A partial unique index conflict there deletes the other row, again with no delete guard. An FK RESTRICT child blocks it.
  - **P3:** `x <> NOT EXISTS(…)` parses as `x <> (NOT EXISTS(…))`.
  - **P4:** `UPDATE OR REPLACE t SET rowid = <other>` deletes the other row when the update guard does not pin `rowid`.

**Status (12 items): FIXED 9, PARTIALLY FIXED 3, NOT FIXED 0.**
**New findings: 1 High, 2 Medium, 7 Low.**

---

## 1. Status table

| Item | Status | Evidence (trace of the round-2 sequence on `8b62e80`) |
|---|---|---|
| **R1 (N1)** `UPDATE OR REPLACE` via unpinned keys | **FIXED** (as scoped) | **The three named tables are now pinned:** <ul><li>`memory_item_state`: `principal_id`, `item_id` (1537-1538).</li><li>`memory_topics`: `topic_id` (2178), plus `principal_id` and `created_at` (2177, 2179).</li><li>`memory_item_placement_state`: `principal_id`, `placement_id`, `item_id` and `relation` (2399-2402).</li></ul> The round-2 item-state sequence (`SET item_id='J' … WHERE item_id='I'`) now raises `memory_item_state_requires_transition` at 1538. The placement and topic variants raise at 2400 and 2178.<br>**Every other UPDATE guard in the file:**<ul><li>Unconditional immutable (closed): items, versions, sources, transitions, suppressions, lifts, links, topic_events, aliases, placement_events, episodes, episode_sources, coverage, prices, ledger (1068-1243), and chunks (2539).</li><li>Conditional but pinning every PK/UNIQUE column: runs (2699-2701), jobs (2769-2770), vectors (2602-2609, including `mutation_id`) and cursors (2934-2935).</li><li>No state-table partial unique index can be hit by a guarded update. `memory_item_one_primary_placement` (472) is safe because item and relation are pinned and status can only move active→removed (2424, 2429, 2443).</li></ul>**Residuals outside the named defect:**<ul><li>the implicit `rowid` is not pinned in the conditional guards for runs, jobs and vectors (**NF1**);</li><li>the partial unique index `memory_topics_sibling_name` can still delete through a REPLACE carried into a trigger (**NF2**).</li></ul> |
| **R2 (N8)** `INSERT OR REPLACE` via rowid aliases | **FIXED** (as scoped) | Every `INTEGER PRIMARY KEY` alias in the file is guarded: `version_rowid` (22; guard 1250-1253), `episode_rowid` (477; 2463-2466), `chunk_rowid` (542; 2514-2517). The round-2 chunk sequence (`INSERT OR REPLACE … chunk_rowid=7, chunk_id='C2'`) raises `memory_history_chunk_receipt_invalid` at 2514. There are no other alias columns. `item_state`, `placement_state` and `cursors` are `WITHOUT ROWID`. **Residual:** the other 17 tables have TEXT primary keys, so they still carry an implicit `rowid` that can be replaced explicitly. That is the same hole class (**NF1**, High). |
| **R3 (N5)** rules overwrite owner state | **PARTIALLY FIXED** | 1367-1388: a non-owner transition raises while the current transition's actor is `owner`, unless it is `expired` on the same version with `valid_to <= NEW.occurred_at`. **Round-2 sequences:**<ul><li>Rules `expired` over owner-`active` V2 with `valid_to` NULL: raises at 1384.</li><li>Rules `active` V3 over owner `superseded`: raises at 1380.</li></ul>**Bypass:** `NEW.occurred_at` is caller-supplied and unbounded. Rules can future-date the expiry past `valid_to`, which moves the actor to `rules`, and then re-activate a rules version (**NF3**, Medium). |
| **R4 (N2 + N3)** reprocessing money paths | **FIXED** | **N2:**<ul><li>The day-job run guard binds first, last and every in-range owner event to `[start_day, end_day]` (2663-2687).</li><li>The ledger skips the sequence-equality check for day jobs (2828-2832).</li><li>Round-2 sequence: the run (100-200 inside the day) is accepted, and the reservation now passes 2829.</li></ul>**N3:** the job `status`/`dry_run` check is reservation-only (2824-2827). Settlement after `cancelled` passes, and 2811 still requires `run.outcome='running'` only for reservations. **Residual:** day jobs cannot cover purged or archived days (**NF5**, Low). |
| **R5 (H5 partial)** partial episode source set | **FIXED** | `memory_retrievable_episodes` now anti-joins every active suppression that overlaps `[start,end]`, including target suppressions resolved through `events` or `archive_segment_events` (979-996). Round-2 sequence (EP1 [10,20], sources E10 and E20, suppression on E15) is hidden at 986-989. **Side effect (fail-closed, design):** a replacement episode over the same range is also hidden, so a re-summary has to split the range around the hidden turn. |
| **N4** depth-64 cycle check fails open | **FIXED** | **Create:** rejects a parent whose ancestor chain reaches depth 64 (1861-1880), so the maximum depth is 64 with root = 1.<br>**Move:** walks the new parent's ancestors (1931-1944) and rejects:<ul><li>any ancestor equal to `NEW.topic_id`, which is a cycle (1956);</li><li>an unfinished walk at 64 (1957-1959);</li><li>`depth(new parent) + subtree height > 64` (1960-1961).</li></ul>**Merge:** the same checks against the target, using the source's descendants (1992-2026).<br>Round-2 sequence (C1 moved under C66 in a 66-chain) cannot exist, because C65 is rejected at create. Checked against a hand-built chain, the check fails closed, and valid moves up to the boundary still succeed. |
| **N6** owner-command operands and authenticity | **PARTIALLY FIXED** | **Operands now bound:**<ul><li>transitions: `itemId`/`versionId`/`lifecycleState` (1467-1469);</li><li>history suppress: target, range and both counts (1574-1578);</li><li>forget: per-suppression entries including `sourceId` and counts (1583-1590);</li><li>lifts: `suppressionId` (1741, 1746-1749);</li><li>topics: `topicId`/`newParent`/`newDisplayName`/`newNormalizedName`/`mergeTarget` (1831-1835);</li><li>placements: `placementId`/`itemId`/`previous`/`newTopic`/`relation` (2329-2333).</li></ul>Round-2 sequence (`CMD('item.transition','T9')` for confirm, used for `expired`) raises at 1469.<br>**Still open:**<ul><li>(a) The ingress allowlist (who may append `memory.owner_command`) is deferred to a separate `0019` PR, per the reviewer's 02:31 AGENT_LOG direction. Authenticity is still unenforced in #39.</li><li>(b) `added_aliases_json` is not bound to owner topic commands. An owner rename can carry arbitrary alias names or paths for the topic (Low).</li></ul> |
| **N7** far-future topic `occurred_at` wedge | **FIXED** | 1810 rejects `occurred_at > now + 5 minutes`. 1811-1822 rejects a non-create event older than the topic's current last event. The round-2 `occurred_at='2099…'` rename raises at 1810. The residual wedge is at most 5 minutes. **Legit-path cost:** merge children are not checked in the insert guard (**NF8**, Low). |
| **L4** backdated timing | **PARTIALLY FIXED** | Runs: `started_at` must be within ±5 minutes of now (2649-2650); the round-2 backdated run raises. **Ledger `occurred_at` is still bounded only below (`>= run.started_at`, 2810):**<br>`INSERT INTO memory_cost_ledger (… entry_type='reservation', budget_class='normal_monthly', occurred_at='2026-10-01T00:00:00.000Z' …)` from a September run is accepted, lands in October's month bucket (index 1044), and misses September's cap.<br>Fix: add `OR NEW.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')` to the ledger guard. |
| **L6** suppression counts not exact | **FIXED** | **Target suppression:** `total = 1`, and `newly_hidden = NOT EXISTS(active covering suppression)` (1627-1644; P3 confirms the parse). **Range suppression:** `total` = the count of live owner conversation turns ∪ archived events in range, and `newly_hidden` = that set minus actively hidden rows (1645-1687). Round-2 `(10,20,total=1,newly=0)` over 11 turns raises. **Note (Low, SUSPECTED):** the archived half (1658-1660, 1673-1675) cannot filter by principal or event type, because `archive_segment_events` (`0001_foundation.sql:288`) has neither column. The live and archived halves therefore count different things, and app code must replicate that asymmetry exactly. |
| **N9** archived-only first-person never activates | **FIXED** (design resolution) | 1428-1446: it stays `proposed` unless an owner transition activates a `basis='confirmed'` version with a verified archived receipt. Test 2614 covers this. **Note (Low):** the archived branch never checks that the source is a `conversation.user_committed` turn of this principal, because the archive has no type or subject. It is owner-gated, so the risk is low. |
| **N10** overruns unrecordable | **FIXED** | `entry_type='overrun'` (801, 826). It is allowed only after a full settlement at exactly the reservation amount, dated at or after that settlement, once per reservation (2888-2916). It counts toward the job-limit sum (2842), which matches design §9 (`docs/plan/2026-09-14-r2-memory-design.md:476-484`). |

---

## 2. New findings (most severe first)

### NF1. HIGH: explicit implicit-`rowid` REPLACE on the 17 TEXT-PK tables bypasses every delete and immutability guard. CONFIRMED (SQLite semantics, probes P1/P1b/P4; not run on the real migration)
- **Where:** these tables are STRICT rowid tables with a TEXT primary key and no `WITHOUT ROWID`, and no insert guard checks `NEW.rowid`:
  - `memory_items` (3), `memory_item_sources` (73), `memory_item_transitions` (114);
  - `memory_event_suppressions` (170), `memory_event_suppression_lifts` (222);
  - `memory_item_links` (245);
  - `memory_topics` (267), `memory_topic_events` (308), `memory_topic_aliases` (388);
  - `memory_item_placement_events` (408), `memory_episode_sources` (511);
  - `memory_history_coverage` (577), `memory_vectors` (606), `memory_model_prices` (628);
  - `memory_runs` (657), `memory_reprocess_jobs` (731), `memory_cost_ledger` (794).
- **Update guards too:** the conditional guards on `memory_runs` (2695), `memory_reprocess_jobs` (2767) and `memory_vectors` (2597) do not pin `rowid`.
- **Why:** the rowid is the table's real B-tree key. `INSERT OR REPLACE … (rowid, …)` with an existing rowid deletes that row before the insert. With `recursive_triggers=0`, `*_immutable_delete` and `*_delete_guard` do not fire. Only FK RESTRICT children block it (P1b). This is round 1's H2 and round 2's N8 through a column nobody named.
- **SQL (privacy: resurrect a hidden memory):**
```sql
-- V is active with sources SA (turn 10, pos 0) and SB (turn 20, pos 1).
-- The owner then runs history.suppress on turn 20 (source_id NULL, so no FK points at SB).
SELECT count(*) FROM memory_retrievable_item_versions WHERE version_id='V';   -- 0 (hidden by 929-940)
INSERT OR REPLACE INTO memory_item_sources (rowid, source_id, principal_id, item_id, version_id,
  source_position, event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
  channel, occurred_at, created_at)
VALUES ((SELECT rowid FROM memory_item_sources WHERE source_id='SB'), 'SC', 'P', 'I', 'V', 2,
  '<turn30 id>', 30, 'live', NULL, 'x', '<hash>', 'telegram', '<t>', '<t>');
-- guard 1276-1306 passes (new id, free position and event, live receipt); the rowid conflict deletes SB;
-- memory_item_sources_immutable_delete (1098) does not fire
SELECT count(*) FROM memory_retrievable_item_versions WHERE version_id='V';   -- 1: the memory drawn from hidden turn 20 is back
```
- **Money: erase a recorded overrun or settlement.** Neither row has FK children.
```sql
INSERT OR REPLACE INTO memory_cost_ledger (rowid, cost_entry_id, principal_id, run_id, entry_type, …, occurred_at)
VALUES ((SELECT rowid FROM memory_cost_ledger WHERE cost_entry_id='<overrun id>'), '<new id>', 'P', '<running run>', 'reservation', …);
-- a valid normal_monthly reservation passes 2798-2916; the overrun row is deleted and real spend disappears from the monthly sum
```
- **Vector ledger: lose a live vector's deletion tracking.** The Vectorize entry for a later-forgotten item can then never be reconciled.
```sql
UPDATE OR REPLACE memory_vectors
SET rowid = (SELECT rowid FROM memory_vectors WHERE vector_ledger_id='<other live vector>'), deleted_at='<now>'
WHERE vector_ledger_id='<mine>';   -- passes 2597-2613 (rowid not pinned); the other ledger row is deleted
```
- **Also possible:**
  - delete an unlifted owner suppression (it needs any other valid `history.suppress` command, which is N6-minted);
  - delete an empty pending job or a run with no ledger rows;
  - delete an unreferenced topic event, alias, placement event or coverage receipt.
- **Tests:** none. The generic REPLACE tests (test 3167) reuse the natural key, and test 2281 only covers the three aliases.
- **Fix:**
  - **Preferred:** declare the 17 tables `WITHOUT ROWID`. They all have TEXT primary keys and nothing references their rowid; only the three FTS content tables need a rowid, and they already have aliases.
  - **Otherwise:** add `OR EXISTS (SELECT 1 FROM <t> x WHERE x.rowid = NEW.rowid)` to each insert guard (`NEW.rowid` is `-1` when not supplied, P1), and `OR NEW.rowid <> OLD.rowid` to the runs, jobs and vectors update guards.

### NF2. MEDIUM: a REPLACE carried into topic apply UPDATEs deletes a same-named sibling through `memory_topics_sibling_name`. CONFIRMED (probe P2)
- **Where:**
  - partial unique index 304-306;
  - apply UPDATEs 2099-2123;
  - no sibling-name check for rename (1895-1911), move (1912-1966) or merge child reparenting (1967-2062).
- **Why:** SQLite applies the outer statement's conflict policy to statements inside triggers, so `INSERT OR REPLACE INTO memory_topic_events` runs the apply UPDATE with REPLACE. The topic insert guard checks sibling names on create only (2154-2157).
- **SQL:**
```sql
-- A and B are active leaves under R; B has no children, aliases, placements or redirects
INSERT OR REPLACE INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation,
  previous_display_name, previous_normalized_name, new_display_name, new_normalized_name,
  reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('E', 'P', 'A', 'rename', 'a', 'a', 'b', 'b', '[]', '[]', '[{"aliasId":"AL","topicId":"A",…}]', 'x', 'model', '<now>');
-- the guard passes; the apply UPDATE hits the sibling index and REPLACE deletes B; memory_topics_delete_guard (2244) does not fire
```
- **Same via move and merge:** a move under a parent that has a same-named leaf, or a merge whose reparented child collides with a leaf of the target.
- **Narrowed by FK RESTRICT:** it only works on topics with no children, aliases, placements or redirect references. Every renamed topic has an alias (1909).
- **Legit-path cost, even without REPLACE:** a merge into a target that has a same-named child fails with a raw `UNIQUE constraint failed` instead of a named guard error, and the owner has to rename first.
- **Tests:** none.
- **Fix:** add a sibling-name collision check to the rename, move and merge (per reparented child) branches of `memory_topic_events_insert_guard`.

### NF3. MEDIUM: rules can future-date an expiry to escape the owner lock, then re-activate over the owner's confirmation. CONFIRMED (trace)
- **Where:** 1381-1386 compares `valid_to` with caller-supplied `NEW.occurred_at`. No transition guard bounds `occurred_at` against now or the previous transition. Once the actor is `rules`, 1380 no longer applies.
- **SQL:**
```sql
-- T2: owner 'active' on V2 (basis 'confirmed', valid_to '2026-12-01T00:00:00.000Z'); today is 2026-09-14
INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id,
  lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('T3', 'P', 'I', 3, 'V2', 'expired', 'expiry', 'rules', 'policy-v1', NULL, '2026-12-01T00:00:00.000Z');  -- accepted
-- V3: version 3, basis 'observed', origin 'deterministic_observation', uncertain 0, plus one live source
INSERT INTO memory_item_transitions (… 'T4', 'P', 'I', 4, 'V3', 'active', 'rules', …, NULL, '<now>');           -- accepted (1352-1354; the actor on T3 is rules)
-- the owner-confirmed V2 was replaced 11 weeks early, contrary to design §9 (:486, :521-522)
```
- **Side effect:** `memory_item_state.updated_at` is left in the future.
- **Tests:** test 2406 only uses `valid_to` NULL and an exactly-due `occurred_at`. No future-dated or not-yet-due negative exists, so reversing the `<=` direction also goes undetected.
- **Fix:** in the transition insert guard, raise when `NEW.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')` or when `NEW.occurred_at <` the current state's `updated_at`. Also require `current_version.valid_to <= strftime(… 'now')` in the 1381-1386 exception.

### NF4. LOW: the owner-command freshness baseline resets to item creation after any rules transition. SUSPECTED
- **Where:** 1470-1483. The baseline is the command of the *current* transition only. When that transition was made by `rules`, the join yields nothing, and `COALESCE` falls back to `creation_event_sequence`.
- **Effect:** an unused owner command issued before a later owner decision is valid again once a rules transition, such as a due expiry, becomes current. Example:
  - CMD_A (seq 100): `item.transition`, target T4, `active` on V2 — never applied;
  - T2: owner `active` via CMD_B (seq 110);
  - T3: rules `expired`;
  - T4 now accepts CMD_A (100 > creation sequence).
- **How narrow:** each command is single-use and binds version and state (NF6-style operands), so exploiting this needs a pre-issued command naming a future transition id.
- **Fix:** use `max(command.sequence)` over *all* owner transitions of the item as the baseline, not just the last one.

### NF5. LOW: date-range reprocessing cannot run over purged or archived days, and uses UTC days. CONFIRMED (trace)
- **Where:**
  - the run guard requires live `events` rows for the first and last event (2666-2679) and checks only live events in range (2680-2687);
  - `archive_segment_events` has no `occurred_at` (`0001_foundation.sql:288-296`);
  - the job insert cap counts only live events (2740-2747).
- **Effect:**
  - Once `archive_purge_receipts` rows exist, a `start_day` job over those days passes its event cap with a count of 0, but no run can ever be inserted, so the job stays pending until cancelled.
  - Design §9 (`:506-510`) presents reprocessing as re-distilling old history.
  - Days are `substr(occurred_at,1,10)` in UTC, while episodes use `local_day`.
  - Sequence-range jobs still work (a workaround).
- **Fix:**
  - reject a `start_day` job when any archived sequence falls inside the day window's live sequence span, and document sequence ranges for archived history; or
  - store `occurred_at` in the archive receipt;
  - in either case, state that day ranges are UTC.

### NF6. LOW: owner-created items whose creation event is the authorizing command can never take an owner transition. SUSPECTED (depends on the unbuilt producer)
- **Where:** the strict `command.sequence > creation_event_sequence` at 1470 and 1480-1482. `memory_items_insert_guard` (1054-1063) accepts any principal event as the creation event.
- **Effect:** if `/remember` creates the item with `creation_event_id` equal to the `memory.owner_command` event and then authorizes the first transition with that same command, the transition raises.
- **Fix:** allow equality when `command.event_id = item.creation_event_id`, or document that the creation event must be the user turn.

### NF7. LOW: a merge fails when any reparented child's last event is later than the merge timestamp. CONFIRMED (trace, fail-closed)
- **Where:**
  - the insert guard's ordering check covers only `NEW.topic_id` (1811-1822);
  - each child's reparent UPDATE must be newer than *that child's* last event (2186-2195);
  - equal-millisecond ties fall back to ULID order (2192-2193).
- **Effect:** clock skew of up to 5 minutes between the model writer and the owner handler makes the whole merge abort with `memory_topic_update_requires_event`. Retrying with a fresh timestamp succeeds.
- **Fix:** add a named pre-check in the merge branch that rejects when any active child's last event `occurred_at > NEW.occurred_at`, or order topic history by an insert-assigned sequence.

### NF8. LOW: `added_aliases_json` is not bound by owner topic commands. SUSPECTED (N6 residual)
- **Where:** 1831-1835 bind the names, parent and merge target, but not aliases. 2063-2073 only check each alias's `topicId`.
- **Effect:** a genuine `topic.rename` command can be applied with arbitrary alias names or paths for that topic, which misroutes future filing.
- **Fix:** bind `$.payload.addedAliases` to `NEW.added_aliases_json`, or bind each alias's names to the topic's previous names or path.

### NF9. LOW: range suppression counts include archived events of any principal or type. SUSPECTED
- **Where:** 1657-1660 and 1672-1675.
- **Effect:** `total_covered_turn_count` and `newly_hidden_turn_count` are not "turns of this owner" once a range spans archived history. App code must replicate this exactly or the insert fails, and the owner-visible counts are inflated.
- **Fix:** carry the principal and event type in the archive receipt, or define the count as "events" and rename it.

### NF10. LOW: rules may still demote an owner fact through `memory_item_links` if retrieval honours `supersedes`. SUSPECTED (pre-existing, not introduced)
- **Where:** 1784-1802 need only *some* transition of the source item, by any actor.
- **Effect:** if the future recall path hides `supersedes` targets, a rules-created item can shadow an owner-confirmed one without touching the lock at 1367-1388.
- **Fix:** when the target item's current transition actor is `owner`, require the link's authorizing transition to be an owner transition.

---

## 3. Remote D1 rules

- **No `CASE … RAISE`.**
  - Every `RAISE(ABORT, …)` sits in an unconditional trigger body gated by `WHEN`.
  - The only `CASE` is the pre-existing value expression at 1457-1466, with no RAISE.
- **No window functions.** No `OVER (` anywhere.
- **New recursive CTEs** (inside trigger WHEN subqueries; remote D1 acceptance is unproven):
  - 1864-1877: create depth-cap `ancestors`. New.
  - 1930-1954: move now uses **two** CTEs in one `WITH RECURSIVE` (`ancestors` is new, `subtree` replaces `descendants`).
  - 1991-2019: merge now uses **two** CTEs (`ancestors` is new, `descendants` is retained).
  - That is 5 recursive CTE definitions in 3 statements, up from 2. The multi-CTE `WITH RECURSIVE a AS (…), b AS (…)` shape, and scalar `max(depth)` over CTEs inside `EXISTS` (1960-1961, 2025-2026), are new shapes for D1.
- **Other new constructs that need the scratch remote proof:**
  - `strftime('%Y-%m-%dT%H:%M:%fZ','now', ±'5 minutes')` in trigger WHEN (1810, 2649-2650). Standard SQLite forbids `'now'` only in CHECK, index and generated columns.
  - `count(*)` over a derived `UNION` subquery with a correlated `NOT EXISTS` (1648-1686).
  - `NOT EXISTS` used as a comparison value (1631; P3 confirms the local parse).
  - `json_each(x, '$.payload.suppressions')` / `'$.payload.lifts'` with `json_extract(entry.value, …)` (1583, 1746).
- **Removal-contract lint:** the `SELECT CASE … RAISE(` regex would still miss a future `CASE WHEN … THEN RAISE` outside a `SELECT`. Unchanged from round 2.

---

## 4. Test gaps (would a behavioural test fail if the fix were reverted?)

| Item | Killing test (test line) | Gaps |
|---|---|---|
| R1 | Yes: **"pins item-state keys against UPDATE OR REPLACE"** (2118), **"pins topic keys against UPDATE OR REPLACE"** (2150), **"pins placement-state keys and relation against UPDATE OR REPLACE"** (2200). Traced: left's `last=1`, right's T2/move/refile rows match NEW, and `occurred_at` equals `updated_at` (helpers at test 139-143, 184, 273), so only the pin blocks each attempt, and a revert drops the count to 1. | The `principal_id` pins and the placement `relation` pin are not isolated. No test for REPLACE carried through a trigger into the sibling index (NF2), or for `UPDATE OR REPLACE SET rowid` (NF1). |
| R2 | Yes: **"rejects INSERT OR REPLACE through every FTS content rowid alias"** (2281). Each attempt uses fresh natural keys, so only the new rowid clause blocks it, for all 3 aliases. | Implicit rowid on the 17 TEXT-PK tables: none (NF1). |
| R3 | Yes: **"prevents rules from overwriting owner state except due time-bounded expiry"** (2406). A revert lets both rules transitions through. | No future-dated `occurred_at` or not-yet-due `valid_to` negative (NF3). The `<=` direction is untested because the positive case uses equality. |
| R4 | Yes: **"supports bounded day-range cost and records terminal-job settlement plus overrun"** (1982). It kills the N2 revert (the day reservation raises), the N3 revert (settlement after cancel raises) and day binding (the outside-day run). | No day job over archived or purged days (NF5). No overrun before a full settlement. Overrun counting in the job-limit sum is not exercised. |
| R5 | Yes: **"hides an episode when an undeclared turn inside its range is suppressed"** (1493), via the target branch at 986-989. | The range-overlap branch (983-984) and the archived-target branch (990-994) are not exercised: none. |
| N4 | Partial: **"caps active topic depth at 64 so cycle checks fail closed"** (2763) kills the create cap. | Its move and merge cases are true cycles that the ancestor cycle clause also catches, so the depth-sum and unfinished-walk clauses (1957-1961, 2022-2026) are unkilled. No deep *valid* move or merge success test. |
| N6 | Partial: **"binds owner commands to transition, suppression, topic, and placement operands"** (1716) kills the `lifecycleState`, `targetEventId`, `newParentTopicId` and `newTopicId` bindings. | `versionId`, `itemId`, range and count bindings, forget entry fields, lift `suppressionId`, `mergeTargetTopicId`/names and placement `relation`/`previousTopicId` are not isolated. No ingress test (deferred to 0019). |
| N7 | Partial: **"rejects far-future topic events before they can wedge topic history"** (2827) kills 1810. | The older-than-last-event clause (1811-1822): none. |
| L4 | Partial: **"rejects backdated run starts before they can evade the current spend window"** (2090) kills the −5 minute bound. | The +5 minute run bound: none. Ledger future `occurred_at`: none (still open). |
| L6 | Yes: **"requires exact total and newly-hidden counts for range suppressions"** (1559) kills the total-count check. | `newly_hidden` with a pre-existing overlapping suppression, and a target suppression with `newly_hidden=0`: none. |
| N9 | Yes: **"keeps archived-only first-person claims proposed until owner confirmation"** (2614). | None material. |
| N10 | Yes: covered inside test 1982 (the second overrun is rejected, and the settlement+overrun total is 110). | Overrun without a full settlement: none. |
| Remote/runtime | none | `PRAGMA recursive_triggers` is not asserted in this file (it was asserted in the reviewer's separate H2 probe). No remote-D1 evidence. The Sid-attended scratch run remains required. |
