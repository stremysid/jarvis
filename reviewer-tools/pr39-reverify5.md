# PR #39 round-6 re-verification: `0016_cloud_memory.sql` at `5ef0ce5` (fix `2fc8dc6`)

## Scope and method

- **Scope:** `git diff 4189a2e 5ef0ce5`: 13 SQL lines, 408 test lines, 29 design-doc lines, plus the AGENT_LOG entry.
- **Line numbers:** SQL lines are `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` at `5ef0ce5`. "test N" is `apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts` at `5ef0ce5`. Compared with round 5, SQL lines 427 to 2343 moved by +5 and lines after 2346 by +2.
- **Worktree:** a detached worktree of `5ef0ce5` (`jarvis-pr39-verify6`), removed afterwards. Windows 11, one vitest process at a time.
- **Baseline:** `cloud-memory-migration.test.ts` passed **133/133**, with no timeouts.
- **Probes:** `pr39-reverify5-probe.test.ts` (beside this file) passed **10/10**.
  - P1–P3 assert behaviour at head.
  - P4a–c each remove one pin from `memory_vectors_update_guard` and restore it in `finally`.
  - P4d is the head control.
- **Clause mutations:** `pr39-reverify5-mutate.mjs` edits one clause, runs the whole migration test file, and restores the SQL byte-for-byte.
  - The log is `pr39-reverify5-mutations.jsonl`, with per-run JSON reports in `pr39-reverify5-mut/`.
  - **30 runs (BASE plus 29 mutants), 0 timeouts.** The runner printed `restored-ok`, and `git status` showed only the untracked probe file.
- **Not duplicated:** the earlier probes (V1–V10, P1b–P4b, H2, NF1) and the whole-trigger removals. The reviewer reruns those.

**Status:** S1, S2 and S4 are fixed. S3 is fixed for the six named mutants but only partly fixed against its general request (N2).
**New findings:** 2 Low (N1, N2). No High or Medium.

---

## 1. Items

| Item | Verdict | SQL evidence | Test that fails if reverted |
|---|---|---|---|
| **S1** alias tuple UNIQUE wedged renames | **FIXED** | See §1.1. <ul><li>The tuple UNIQUE is gone from `memory_topic_aliases` (408–425).</li><li>A non-unique `memory_topic_aliases_resolution` index was added (427–431).</li><li>The insert guard now pre-checks only `alias_id` (2343–2346).</li><li>The design doc states live path first, then newest alias, then merge redirect (97, 170–174, 331–335).</li></ul> | <ul><li>**A4b** (restore the tuple UNIQUE) fails test 1104 ("retains repeated natural rename aliases…") and test 1338 (own-parent merge, then the child's natural rename), with `UNIQUE constraint failed … normalized_alias, path_alias`.</li><li>**A4c** (restore only the guard's tuple clause) fails the same two tests with `memory_topic_alias_requires_event`.</li><li>RUNTIME-PROVEN.</li></ul> |
| **S2** non-reservation rows could be backdated | **FIXED** | 2893: `NEW.occurred_at < now - 5 minutes` now applies to every entry type. The upper bound (2892) and `>= run.started_at` (2900) are unchanged. | **test 2956** kills each partial revert: **C1** removes the bound, **C2** restores reservation-only, and **C3/C4/C5** exempt overrun, release or settlement. Each entry type is isolated, because the settlement, release and overrun rows are otherwise lineage-valid (seeded reservations 36 d back, and a full settlement 35 d minus 60 s back before the overrun). RUNTIME-PROVEN. |
| **S3** sweep missed single pins and partial indexes | **FIXED for the six named mutants; PARTIAL overall** | <ul><li>New same-principal collision tests: 4400 (`cursor_name`), 4420 (vector `item_id`), 4453 (`run_key`).</li><li>Carried `OR REPLACE` create and place collisions: 4500.</li><li>The table inventory now comes from `PRAGMA table_list` `type = 'table'`, minus exact pre-0016 names, and asserts `insertGuards` table set == schema set (4595–4608).</li><li>Only those three pins were given one-column collisions. Other single pins still survive (N2).</li></ul> | <ul><li>**A1** (3025) fails test 4400. **A2** (2693) fails 4420. **A3** (2789) fails 4453.</li><li>**A5** (the sibling clause, 2245–2248) and **A6** (the one-primary clause, 2463–2465) each fail 4500.</li><li>**A4** (the alias_id duplicate clause 2343–2346, which replaces round 5's name/path clause now removed by design) fails "memory_topic_aliases_insert_guard rejects INSERT OR REPLACE of an existing key" and sweep 4586.</li><li>RUNTIME-PROVEN. See §2 for the full table.</li></ul> |
| **S4** OR IGNORE with a 300-byte normalized name | **FIXED** | The `memory_topic_events.new_normalized_name` CHECK (341–344) is now isolated by the added case at test 1199–1215 (`"n".repeat(300)` at 1208). | **test 1155.** **D1** (drop 341–344) fails it with `expected { count: 1 } to deeply equal { count: +0 }`: the event commits while apply skips the topic update. RUNTIME-PROVEN. |

### 1.1 S1 in detail

**Is resolution deterministic?** Yes. The documented order is `created_at DESC, created_by_topic_event_id DESC, alias_id DESC`, and it ends in the primary key, so the order is total. For aliases of the **same** topic, event time also matches commit order, because the per-topic monotonic checks (1840–1851 and update guard 2281–2296) require each event to be later. Across **different** topics, event time can disagree with commit order. See N1.

**Is the REPLACE/IGNORE class closed on the aliases table after the constraint change?** Yes, by trace and at runtime (P1).
- **Unique constraints:** only the primary key `alias_id` and `UNIQUE (principal_id, alias_id)` remain. Both reduce to `alias_id`, which the nested guard RAISE at 2343–2346 pre-checks. That covers a collision with an existing alias of another topic and a duplicate id inside one event's array.
- **The new index** is not unique, so it has no conflict resolution to carry.
- **CHECK and NOT NULL** are pre-checked by the topic-event guard: text types at 2149–2154, and id, length and topicId at 2155–2162.
- **Foreign-key failures** abort regardless of the outer conflict clause.
- **Updates and deletes** are refused outright by 1189–1199.
- **P1 (runtime):**
  - an alias-id collision under outer `OR REPLACE` and under `OR IGNORE` is refused with `memory_topic_alias_requires_event`, leaving the original alias and topic B unchanged;
  - an intra-event duplicate id under `OR REPLACE` is refused;
  - `INSERT OR REPLACE … SELECT *` of an existing alias row is refused;
  - two same-tuple aliases with distinct ids in one event are both kept (count 2), which is by design.

**Can an alias shadow a live path, or a live path resolve to a merged topic?** Not from the SQL.
- The SQL cannot encode precedence. It is a runtime rule, stated in design 170–174 and 331–335.
- Test 1390's `livePath ?? historicalAlias` is a JavaScript restatement of that rule, not a schema property. **The resolver in the runtime PR must implement live-first.**
- A live-path walk filters `status = 'active'`, and merged topics must have zero active children (2090–2098), so a live path cannot pass through a merged topic.
- An alias that points at a merged topic follows `redirect_to_topic_id`, whose cycles are prevented (round 5 §1.2).

**Equivalent and weak mutants (not findings):**
- **B1** (the nested one-root clause, 2242–2244) survives. The topic-event guard already refuses a second root (1876–1882), which is why test 4500 expects `memory_topic_event_invalid`. A direct topics INSERT needs a create event whose apply already inserted that topic, so the `topic_id` clause fires first.
- **E2** (the vector `embedding_model` pin) survives because the column CHECK allows only one value (639).

### 1.2 S2: does the new lower bound break anything legitimate?

No. Checked at runtime with P3 (run started 2 h ago, reservations seeded 1 h ago):
- **P3a:** settling a one-hour-old reservation now is accepted, and a following overrun now is accepted.
- **P3b:** a settlement stamped now minus 4 min is accepted; a release stamped now minus 6 min is refused.
- **P3c:** after the run moves to `succeeded`, releasing an outstanding reservation now is accepted, and a new reservation is refused (2901).

Checked by trace:
- **Reprocessing jobs:** settlement or release after the job is terminal is allowed. The status and spend-limit checks apply to reservations only (2915, 2925).
- **Coverage:** reprocessing and history coverage use sequence or day, not ledger time.
- **Overrun after a full settlement:** allowed, provided `occurred_at >= settlement.occurred_at` (2988).

**Note (pre-existing, not introduced by S2):** P3d stamps a settlement at now plus 4 min (inside the upper bound), then an overrun at now. The overrun is refused by 2988 until the clock passes the settlement's stamp. It fails closed and is transient. The runtime PR should stamp from one clock, or retry.

---

## 2. Single-clause removals (whole migration file, 133 tests)

| Mutant | Clause | SQL line(s) | Result |
|---|---|---|---|
| BASE | none | n/a | 133/133 pass |
| A1 | cursor `cursor_name` pin | 3025 | **killed**, test 4400 |
| A2 | vector `item_id` pin | 2693 | **killed**, test 4420 |
| A3 | run `run_key` pin | 2789 | **killed**, test 4453 |
| A4 | alias `alias_id` duplicate clause (round 5's name/path clause no longer exists) | 2343–2346 | **killed**: "memory_topic_aliases_insert_guard rejects INSERT OR REPLACE of an existing key" and sweep 4586 |
| A4b | restore `UNIQUE (principal_id, normalized_alias, path_alias)` | 420 | **killed**, tests 1104 and 1338 |
| A4c | restore the guard's (name, path) duplicate clause | 2345 | **killed**, tests 1104 and 1338 |
| A5 | topic-create sibling clause | 2245–2248 | **killed**, test 4500 |
| A6 | one-primary placement clause | 2463–2465 | **killed**, test 4500 |
| B1 | topic-create one-root clause | 2242–2244 | survived: **equivalent** (§1.1) |
| C1 | ledger lower bound removed | 2893 | **killed**, test 2956 |
| C2 | ledger lower bound for reservations only (the round-5 code) | 2893 | **killed**, test 2956 |
| C3 | lower bound exempts overrun | 2893 | **killed**, test 2956 |
| C4 | lower bound exempts release | 2893 | **killed**, test 2956 |
| C5 | lower bound exempts settlement | 2893 | **killed**, test 2956 |
| D1 | event `new_normalized_name` CHECK | 341–344 | **killed**, test 1155 |
| E1 | vector `item_kind` pin | 2692 | **survived**: non-equivalent, destructive under REPLACE (P4b) |
| E2 | vector `embedding_model` pin | 2694 | survived: **equivalent** (CHECK at 639) |
| E3 | vector `content_hash` pin | 2696 | **survived**: non-equivalent, destructive under REPLACE (P4a) |
| E4 | vector `mutation_id` pin | 2697 | **killed**, sweep 4586 |
| E5 | vector `vector_ledger_id` pin | 2690 | **killed**: sweep plus 2 guard tests |
| E6 | vector `principal_id` pin | 2691 | **survived**: non-equivalent, cross-principal destructive (P4c) |
| E7 | run `run_id` pin | 2787 | **killed**, sweep (named-error mismatch, FK error) |
| E8 | run `principal_id` pin | 2788 | **survived**: non-equivalent by trace (below) |
| E9 | cursor `principal_id` pin | 3024 | **killed**: sweep plus 2 guard tests |
| E10 | reprocess `job_id` pin | 2857 | **killed**: sweep plus 2 guard tests |
| E11 | reprocess `principal_id` pin | 2858 | **survived**: non-equivalent but not a REPLACE deletion (below) |
| E12 | item-state `item_id` pin | 1567 | **killed**: "pins item-state keys against UPDATE OR REPLACE" |
| E13 | topics `topic_id` pin | 2269 | **killed**: "pins topic keys against UPDATE OR REPLACE" |
| E14 | placement-state `placement_id` pin | 2488 | **survived**: non-equivalent by trace (below) |

---

## 3. New findings

### N1. LOW: alias resolution orders by writer-stamped event time, and topic events accept any past time, so an alias can lose to an earlier write. RUNTIME-PROVEN (P2)
- **Where:**
  - Resolution order: design 331–335 and index 427–431.
  - `memory_topic_events_insert_guard` has only an upper bound (`occurred_at <= now + 5 minutes`, 1839) and per-topic monotonicity (1840–1851).
  - Create events have no lower bound, and neither do renames or merges on a topic whose last event is old.
- **P2:**
  1. Topic A ("X") is renamed to Y now, adding alias (`x`, `Root/X`) to A.
  2. Topic B is then created as "X" under Root, stamped 2 h ago. This is accepted, because the name is free at commit time.
  3. B is renamed to Z, stamped 1 h ago, adding alias (`x`, `Root/X`) to B.
  - No live topic holds `Root/X`. Newest-first resolution returns **A**, although B held the path last in commit order.
- **Impact:** fail-soft misresolution of a historical path. It happens only when two topics held the same path and a writer stamps late, for example a retried or queued topic operation replayed with its original stamp. There is no data loss, no privacy impact and no money impact.
- **Fix (one line, trigger-only, so it can also land later):** add `OR NEW.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')` to 1839, matching runs and the ledger. Alternatively, have the runtime PR stamp topic events at write time, re-stamp on retry, and write that down in design §6.

### N2. LOW (the S3 residual, test-only): one-column same-principal collisions were added only for the three named pins, and other destructive single-pin removals still survive. RUNTIME-PROVEN for E1, E3, E6 (P4a–c)
- **P4a (E3, content_hash pin removed):** two same-principal vectors share `item_id` and differ in hash. `UPDATE OR REPLACE … SET content_hash = <other>, deleted_at = now` succeeds and **deletes the other vector ledger row**. A forget could then leave an orphan Vectorize vector (the round-5 V7 class).
- **P4b (E1, item_kind pin removed):** `SET item_kind = 'episode'` onto an existing episode row with the same item and hash deletes that row.
- **P4c (E6, vector principal pin removed):** `SET principal_id = <other principal>` deletes **the other principal's** vector row, which is cross-principal.
- **P4d (control at head):** all three collisions are refused with `memory_vector_delete_transition_invalid`, and all 4 rows survive.
- **E8 (run principal pin), by trace:**
  - Take an unreferenced run with `price_id IS NULL` (nullable, 705; pinned at 2795).
  - Moving it to principal B, which holds a run with the same `run_key` (UNIQUE 735), would REPLACE-delete B's run.
  - Ledger foreign keys (RESTRICT) block this when B's run has cost rows.
- **E14 (placement-state placement_id pin), by trace:**
  - The merge branch of the update guard (2520–2537) does not tie `NEW.placement_id` to OLD's history.
  - Take a `removed` placement row whose `topic_id` is a merged source (removed rows are not in `moved_placement_ids_json`).
  - It could be rewritten onto another placement id of the same item and relation, REPLACE-deleting that active state row.
- **E11 (reprocess principal pin), by trace:** `job_id` is a global primary key, so there is no REPLACE deletion. The job would instead be reassigned to another principal while nothing references it.
- **Why the sweep misses these:** key-group collisions still target another principal's fixture (4586). The principal pin, or a different column's pin, fires first.
- **Status of the SQL:** correct at head. This is regression protection only.
- **Fix:** extend the pattern of 4400/4420/4453 to `memory_vectors` (`item_kind`, `content_hash`, and `principal_id` with a same-tuple row owned by another principal), `memory_runs.principal_id`, `memory_reprocess_jobs.principal_id` and `memory_item_placement_state.placement_id`. Better, generate one-column collisions per unique key in the sweep.

---

## 4. Remote D1 rules
- **No `CASE … RAISE`.** The only `CASE` is the value expression at 1489. It is enforced by `remote-d1-migration-syntax.test.ts:35`.
- **Recursive CTEs are unchanged.** There are 5 definitions in 3 trigger statements:
  - 1896 (create `ancestors`);
  - 1985–2000 (move `ancestors`, `subtree`);
  - 2046–2061 (merge `ancestors`, `descendants`).
- **New sites in 2fc8dc6, for the Sid-attended scratch proof:**
  1. `CREATE INDEX memory_topic_aliases_resolution` with three `DESC` keys on a `STRICT, WITHOUT ROWID` table (427–431). DESC index keys already exist in deployed `0005:96` and at `0016:1046/1067`, so this is the same family at a new site.
  2. 2893 is now an unconditional `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')` in the ledger WHEN, the same form as 2737.
  - No new functions or syntax.
- **The round-5 list still applies, at head line numbers.** Verified at head: 1839, 1865–1866, 2737–2738 and 2892–2893. Moved by the offset only: 1345, 1417 and 1502–1503.
  - `STRICT, WITHOUT ROWID` on 17 tables;
  - `strftime(…'now'…)` in trigger WHEN at 1345, 1417, 1839, 2737–2738 and 2892–2893;
  - `json(json_extract(…)) = json(…)` at 1865–1866;
  - scalar `max()` inside `COALESCE` at 1502–1503.

---

## 5. Clearance

**No High or Medium issue, and nothing I see is a reason not to clear the SQL.**
- S1, S2 and S4 are fixed, with reverting tests proven at runtime.
- All six round-5 surviving mutants that still exist are now killed. The alias name/path clause they included was removed by design, and its replacements A4, A4b and A4c are killed.
- The legitimate ledger paths still work.
- **Two Lows remain:**
  - **N1** is a one-line trigger bound, or a runtime stamping rule. It is trigger-only, so it is cheap to fix later.
  - **N2** is test-only. The SQL is correct, as the P4d control shows.
- **The reviewer's call:** if the reviewer's bar requires round-5 S3's "one column at a time" request to be met in full, N2 is the only item that falls short. Otherwise both Lows can be carried as notes for the runtime PR.
- **Runtime-PR obligations (not findings):**
  - live-path-first resolution;
  - write-time stamping with re-stamp on retry, for topic events, transitions and every ledger row;
  - one clock source for settlement and overrun (P3d).
