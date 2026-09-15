# PR #39 round-5 re-verification: `0016_cloud_memory.sql` at `4189a2e` (fix `c4923bf`)

## Scope and method

- **Scope:** `git diff 30219fd 4189a2e`: 52 SQL lines, 408 test lines, 11 design-doc lines, plus the AGENT_LOG entry.
- **Line numbers:** SQL lines are `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` at `4189a2e`. "test N" is `apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts` at `4189a2e`. Round-4 SQL lines above 318 are unchanged; lines below it moved by +20.
- **Worktree:** a detached worktree of `4189a2e` (`jarvis-pr39-verify5`), now removed. Windows 11, one vitest process at a time.
- **Baseline:** `cloud-memory-migration.test.ts` passed **128/128 in 7 s**, with no timeouts.
- **Probes:** `pr39-reverify4-probe.test.ts` (beside this file) passed **10/10 in 1.95 s**. V1–V5 assert behaviour at head. V6–V10 drop one clause from one trigger, recreate it from the migration text with a uniqueness-checked anchor, and restore it in `finally`.
- **Clause mutations:** `pr39-verify5-mutate.mjs` (beside this file) edits one clause in the SQL file, runs the file (or the named test), and restores the file byte-for-byte (checked afterwards with `git status`). Results are in `mutations.jsonl`.
  - **12 runs, 0 timeouts.**
  - **Named-test mutants** (6), each killed: M20, M21, M22, M23, M25, M26.
  - **Full-file mutants** (6), each surviving with 128/128 passing: M1, M2, M4, M5, M16, M18.
- **Not duplicated:** the reviewer's round-4 probes (P1b, P2a–c, P3, P4a–b) and the whole-trigger removals.

**Status:** S1, S2 and S3 are fixed. S4 is partial (a test gap only; the SQL is correct). F5, F6 and F7 are fixed.
**New findings:** 3 Low (N1, N2, and N3, the S4 residual). No High or Medium.

---

## 1. Items

| Item | Verdict | SQL evidence | Test that fails if reverted |
|---|---|---|---|
| **S1 (F1)** carried `OR IGNORE` skips apply rows | **FIXED** | See §1.1 for the full apply-path enumeration. <ul><li>The `memory_topic_events` `previous_*` and `new_*` CHECKs (321–344) are textually identical to `memory_topics` 274–280.</li><li>The alias pre-check (2150–2155) mirrors `memory_topic_aliases` 409–417: ULID id, name and alias ≤256 bytes, path ≤2048 bytes.</li><li>Missing or null alias keys give NULL in 2150–2155, but are still aborted: `topicId IS NOT` (2156) or the nested alias guard's binding RAISE (2345–2356).</li></ul> | <ul><li>**test 1095.** **M22** (drop the `new_display_name` CHECK) fails it: `expected {count:1} to equal {count:0}`. **M25** (drop the `pathAlias` length pre-check) fails it: `promise resolved instead of rejecting`. Both runtime-proven.</li><li>The builder reports that the alias-id revert also fails 1095 (not rerun).</li><li>**Runtime at head (V4):** `INSERT OR FAIL` of a 300-byte create is refused with no event row, and `OR FAIL` with alias `not-a-ulid` is refused with the topic unchanged.</li></ul> |
| **S2 (F2)** NF4 test could not fail | **FIXED** | 1497–1507 is the freshness check. At T4 the state is `expired` (test 3463–3468), so the CASE at 1484–1493 requires `item.transition`, and test 3452 now seeds exactly that. | **test 3399**, by trace. The revert-acceptance of this exact scenario was runtime-proven by round-4 P1b. Not rerun here, because the reviewer reruns P1b. |
| **S3 (F4)** +5 min transition bound unisolated | **FIXED** | 1340. The design doc's invariants now require runtime stamps of `max(now, memory_item_state.updated_at)` and name the five-minute refusal. | **test 3324** (new case 3387–3392: `valid_to = timestamp <= now`, stamp now+10 min). **M26** (drop 1340) fails 3324 with `promise resolved instead of rejecting`. RUNTIME-PROVEN. |
| **S4 (F3)** sweep narrower than its name | **PARTIAL** (test gap; SQL correct) | <ul><li>Fixed: the inventory comes from `sqlite_schema` (test 4219–4226); fresh-PK clones against each secondary unique (4304–4323); key collisions against a second fixture with legal next states (4324–4332); named errors throughout.</li><li>Removing the vector `mutation_id` pin (2695) is caught, as the builder claimed.</li><li>**Removing a single pin or clause is not generally caught.** Details in N3.</li></ul> | Full-file runs with one clause removed, **128/128 passing** each (nothing kills them): **M1** `cursor_name` pin (3024), **M2** vector `item_id` pin (2691), **M4** `run_key` pin (2787), **M5** alias (name, path) duplicate clause (2341–2343), **M16** topic create sibling clause (2240–2243), **M18** one-primary placement clause (2461–2463). |
| **F5** merge into own parent | **FIXED** | <ul><li>The sibling exclusion is at 2101.</li><li>Apply now retires the source (2199–2205) before reparenting children (2207–2216) and moving placements (2218–2228).</li></ul> | **test 1260.** **M20** (drop 2101) fails it with `memory_topic_event_invalid`. **M21** (restore the old apply order) fails it with `UNIQUE … memory_topics_sibling_name`. RUNTIME-PROVEN. |
| **F6** reservation backdated across a month | **FIXED** as scoped | 2891–2892 applies to `reservation` only, within ±5 min of D1 now. | **test 2837.** **M23** (drop 2891–2892) fails it with `promise resolved instead of rejecting`. RUNTIME-PROVEN. |
| **F7** module-load stamps against the run window | **FIXED** | Run and reservation inserts now use call-time `runtimeTimestamp()` (fixture 466/483; tests at ~1364/1380, 2604, 2615, 2629, 2670 and the day-range/insertCost helpers). The remaining `timestamp`/`laterTimestamp` uses are for columns with no wall-clock bound. | n/a. The baseline ran 128/128 in 7 s. |

### 1.1 S1: every apply-bearing path under an outer `OR IGNORE`, `REPLACE`, `FAIL` or `ROLLBACK`

**Mechanism.** The outer statement's conflict policy governs trigger-body INSERTs and UPDATEs. Three things are not subject to it:
- `RAISE(ABORT)` always aborts;
- foreign-key failures abort;
- a BEFORE trigger on a nested row fires before that row's constraint check.

**`memory_topic_events_apply`** (2163–2230):
- **Topics INSERT.**
  - CHECKs are now mirrored.
  - The PK `topic_id` is global, while the event guard at 1867–1870 is principal-scoped. The one-root and sibling partial indexes are also in play. All three are covered by the nested `memory_topics_insert_guard` RAISE (2234–2243).
  - `updated_at >= created_at` holds because both equal the event's occurred_at.
- **Aliases INSERT.**
  - CHECKs are pre-checked at 2150–2155.
  - PK, the tuple UNIQUE (421) and intra-array duplicates are covered by the nested alias guard RAISE (2338–2344).
  - NOT NULL holds because `json_type` is `text` (2145–2149).
- **Rename and move UPDATEs.**
  - The sibling index is pre-checked at 1933–1944 and 1967–1978.
  - `updated_at >= created_at` follows from 1835–1846.
  - The move's new parent is NOT NULL (event CHECK 393–395), so `one_root` cannot fire.
- **Merge source UPDATE.**
  - `redirect <> topic_id` is enforced by 2020.
  - A merged row leaves the partial sibling index.
  - The topics update guard (2308–2313) is a RAISE.
- **Children UPDATE.**
  - Sibling collisions are pre-checked at 2094–2107, and children cannot collide with each other.
  - `updated_at >= created_at` follows from 2108–2122.
- **Placement UPDATE.** relation, status and item are unchanged, so `memory_item_one_primary_placement` cannot newly conflict. The foreign key to the target is live.

**`memory_item_transitions_apply_state`** (1514–1537):
- The `memory_item_state` CHECKs (153–160) mirror the transition CHECKs (123–136).
- The PK is protected by `WHERE NOT EXISTS`.
- The state insert and update guards are RAISEs.

**`memory_item_placement_events_apply_state`** (2426–2454):
- The state CHECKs (477–484) mirror 445 and 456.
- A `place` row always has a non-null `topic_id` (event CHECK 466).
- The PK and one-primary index are covered by the nested RAISE (2458–2464).

**FTS AFTER INSERT** (3037–3053):
- fts5 has no CHECK or NOT NULL.
- The rowid comes from an AUTOINCREMENT alias whose explicit reuse is guarded (1270, 2549, 2600).

**UPDATE OR IGNORE/REPLACE:** 0016 has **no AFTER UPDATE trigger**, so a conflict clause on an UPDATE of a mutable table cannot carry into another table. The one AFTER DELETE trigger (3055) is not reachable by a conflict clause, because REPLACE deletes fire no triggers without `recursive_triggers`.

**Equivalent mutants and weak tests (not findings):**
- The new `previous_*` CHECKs (321–332) cannot be the sole rejection: the guard requires `previous_*` to equal the live topic's names (1924–1930, 2033–2039), and those already satisfy 274–280. They are harmless defence that no test can kill.
- Test 1181 refuses rows by their own CHECK or guard rather than through a guard-passes/apply-skips path. That is acceptable, because no such path exists for transitions or placements.

### 1.2 F5: does retiring the source first open an inconsistency?

No, by trace and at runtime.
- **The exclusion at 2101 is narrow.** It changes the outcome only when the source is itself an active child of the target.
- **Cycles:** still refused, because the target's ancestors include the source (2071).
- **Redirect cycles:** impossible. A merged topic can never be a merge target (2027–2032) or a create/move parent (1880–1885, 1960–1965).
- **No visible intermediate state.** Everything happens in one trigger with pre-checked, non-skippable constraints, so the children are never left under a merged parent.
- **Placement updates** (2518–2536) do not read topic status.
- **Unique sibling index:** the source leaves the partial index before the children join it. That is exactly why M21 fails with the old order.
- **Runtime (V3):** an own-parent merge whose child collides with a different active child of the target is still refused, both plain and as `OR REPLACE`. The sibling and the source stay unchanged.
- **Side effect:** it newly reaches N1 in one step.

### 1.3 F6: does the reservation bound break anything legitimate?

No.
- Only `reservation` rows are bounded (2891).
- `settlement`, `release` and `overrun` keep only `>= run.started_at` (2899) and `<= now+5 min` (2890). A reservation of any age can therefore be settled or released later; V5 settles a reservation on a 40-day-old run.
- Reprocessing reservations are stamped at dispatch, and job/run coverage is by sequence or day (2909–2921), not by `occurred_at`. Archived-history reprocessing is unaffected.
- Runtime note: a retried reservation write must be re-stamped, not replayed with its original stamp.

---

## 2. New findings

### N1. LOW: the alias tuple UNIQUE wedges renames and merges, and F5 now reaches this in one step. RUNTIME-PROVEN (V1, V2)
- **Where:**
  - `UNIQUE (principal_id, normalized_alias, path_alias)` (421);
  - rename and merge require ≥1 added alias (1947, 2139);
  - the nested alias guard aborts on an existing tuple (2341–2343);
  - the topic-event guard never pre-checks alias existence.
- **V1 (pre-existing class):** rename X→Y (alias `x`, `Root/X`), then Y→X, then X→Y with the natural alias `x`, `Root/X`. The third is refused with `memory_topic_alias_requires_event`, and the topic stays "X".
- **V2 (enabled by F5):** after merging "Shared" into its own parent, alias (`shared`, `Root/Parent/Shared`)→Parent coexists with the live child whose path is also `Root/Parent/Shared`.
  - The path therefore names two topics.
  - The child's natural rename is refused with the same error.
  - Before c4923bf this merge itself failed closed.
- **Impact:** fail-closed. No data loss and no privacy or money impact. Rules or the model can wedge a topic until the runtime invents a non-natural alias. The design (§6.3/§6.4) does not say whether a live path or an alias wins.
- **Fix:** make the tuple index non-unique with latest-alias-wins resolution (or skip identical tuples in apply and exempt them from the ≥1 rule), and document live-path-before-alias precedence.

### N2. LOW: settlement, release and overrun can be stamped into a prior month on a month-crossing run. RUNTIME-PROVEN (V5)
- **Where:** 2899 `occurred_at >= run.started_at` is the only lower bound for non-reservation rows. Runs have no maximum lifetime (2781–2806).
- **V5:** a run left `running` for 40 days (seeded the same way as the builder's test 2837) and a reservation stamped now. A settlement stamped 35 days back is **accepted**, and an overrun stamped 35 days back is **accepted**. The reservation stamped 35 days back is refused (F6 works).
- **Impact:** a real overrun can land in a closed month and escape the current month's cap. Ledger writers are runtime-only, so this needs a stamping bug. A settlement can also predate its own reservation.
- **Fix:** apply `occurred_at >= now - 5 minutes` to every entry type, not just reservations. Writers stamp at write time, so settling an old reservation still works.

### N3. LOW (the S4 residual, test-only): single key-pin and clause removals survive the whole file. RUNTIME-PROVEN (M1, M2, M4, M5, M16, M18; V6–V10)
1. **Composite groups are masked.** Each key group is assigned whole against a second fixture owned by *another principal* (test 4324–4332), so the `principal_id` pin fires first and masks a dropped pin elsewhere in the group.
   - **V6:** with the `cursor_name` pin (3024) removed, the sweep's exact statement still throws `memory_cursor_transition_invalid`. A same-principal `UPDATE OR REPLACE … SET cursor_name='fts_episodes'` then deletes the episodes cursor and jumps it from 5 to 9, so events 6–9 are never FTS-indexed.
   - **V7:** with the vector `item_id` pin (2691) removed, a same-principal composite-tuple collision deletes another vector ledger row. A forget could then leave an orphan Vectorize vector.
   - `run_key` (M4) is the same class, by trace.
2. **Insert clones pass by accident.** The named-error regex is satisfied by an unrelated clause of the same guard.
   - The alias tuple clone (4304–4323) is refused by the JSON binding (2345–2356), not the duplicate clause.
   - **V8:** with 2341–2343 removed, a carried `INSERT OR REPLACE` topic rename deletes another topic's alias.
3. **Partial and expression unique indexes are skipped** (4291–4297). These are `memory_topics_one_root` (300), `memory_topics_sibling_name` (304) and `memory_item_one_primary_placement` (492), the class behind round-3 NF2. Their create/place pre-checks exist only in nested guards (2240–2243, 2461–2463): the event guards at 1864–1911 and 2361–2424 do not check them.
   - **V9:** with 2240–2243 removed, a carried REPLACE create deletes an existing same-named sibling.
   - **V10:** with the one-primary clause removed, a carried REPLACE `place` deletes the item's active primary placement state.
4. **The inventory is not tied to the iteration.** The loop still iterates the literal `insertGuards` (4174–4198), and nothing asserts that its table set equals `EXPECTED_TABLES`. The name-prefix exclusions (4221–4224) would also hide a real table named `memory_item_fts_*`.
- **Fix:**
  - collide one column at a time against same-principal second rows that share the rest of each tuple;
  - add crafted create/place collisions for the three partial/expression indexes under `OR REPLACE`;
  - assert the `insertGuards` table set equals the schema set, using `PRAGMA table_list` type (not name globs).

### Notes (not findings)
- **Clock skew.** `max(now, updated_at)` and every ±5 min bound compare the Worker's clock with D1's `now`. A skew of more than 5 minutes refuses writes. The failure is closed and unlikely on Cloudflare.
- **Stamp retries.** Runtime writers must stamp at write time and re-stamp on retry. This applies to the reservations at 2891 and the transitions at 1340.

---

## 3. Remote D1 rules
- **No `CASE … RAISE`.** The only `CASE` is the value expression at 1484–1493. `remote-d1-migration-syntax.test.ts:35` and `cloud-memory-trigger-contract.test.ts:92` enforce this.
- **Recursive CTEs are unchanged.** There are 5 definitions in 3 trigger statements: 1890 (create `ancestors`), 1980–2004 (move `ancestors`, `subtree`) and 2041–2069 (merge `ancestors`, `descendants`).
- **New in c4923bf, add to the Sid-attended scratch proof:** `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')` in the ledger guard WHEN (2891–2892). It is the same family as 2735, but a new site.
- **Not new constructs:** the column CHECKs at 321–344 reuse the `CAST AS BLOB`/`instr`/`GLOB` with `char()` forms already at 274–280. The alias checks at 2150–2155 use `length`, `substr` and `GLOB` on `json_extract`, all already present.
- **The round-4 list still applies, at head line numbers:**
  - `STRICT, WITHOUT ROWID` on 17 tables;
  - `strftime(…'now'…)` in trigger WHEN at 1340, 1412, 1834, 2735–2736, 2890 and 2891–2892;
  - `json(json_extract(…)) = json(…)` at 1860–1861;
  - scalar `max()` inside `COALESCE` at 1497–1498.
