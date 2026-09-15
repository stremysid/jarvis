# PR #39 round-4 re-verification: `0016_cloud_memory.sql` at `30219fd`

## Scope and method

- **Scope:** fix commit `689e984` plus the test-only `a958020`. The head is `30219fd`. The SQL is byte-identical to `d24f997` (md5 `5841da4d…`). The comparison base is `8b62e80`.
- **Line numbers:** SQL lines refer to `apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql` at head (3030 lines). "test N" means `apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts` at `30219fd`.
- **Method:** a static trace of every changed clause and test, plus runtime probes.
- **Probes:** `pr39-reverify3-probe.test.ts` sits beside this file. It ran in a detached worktree of `30219fd` (`pnpm exec vitest … zz-verify-r4.test.ts --project default`): **8/8 passed in 2.15 s**.
  - Each probe asserts the behaviour stated in its name.
  - Mutation probes drop one trigger, recreate it from the migration text with a single anchored edit, and restore the original in `finally`. The anchor must match, or the probe throws.
  - The worktree has been removed.
- **Not duplicated:** the other agent's REPLACE matrix and its S2–S4 exploit probes. The S2 and S4 revert-kill verdicts below are traces, not runs.

**Status:** S1–S4 fixed. Should-fixes: N4, N6, NF7 and NF8 fixed; NF4 partial (the SQL is fixed, but its test does not isolate it); NF5, NF6 and NF9 documented.
**New findings:** 1 Medium, 6 Low, and 1 note.

---

## 1. Items

| Item | Verdict | SQL evidence | Test that fails if the fix is reverted |
|---|---|---|---|
| **S1 / NF1** hidden rowid on 17 TEXT-PK tables | **FIXED** | <ul><li>`STRICT, WITHOUT ROWID` at 19, 112, 147, 220, 243, 265, 298, 386, 406, 450, 539, 604, 626, 655, 729, 792, 832.</li><li>`item_state` (168), `placement_state` (470) and `cursors` (845) were already `WITHOUT ROWID`.</li><li>Only `memory_item_versions` (71), `memory_episodes` (509) and `memory_history_chunks` (575) keep rowids. Each has an `AUTOINCREMENT` alias guarded at 1250, 2521 and 2572.</li></ul>Side effects are clean: nothing in `src/` or the triggers reads the rowid of the 17 tables (FTS `content_rowid` names only the three aliases, 850/857/864); there is no `AUTOINCREMENT` on a `WITHOUT ROWID` table; and PK NOT NULL is now enforced (before, a rowid TEXT PK accepted NULL, so this tightens it). | **"sweeps every 0016 table…" (3983)**: `expect(wr).toBe(1)` plus `INSERT OR REPLACE … (rowid)` expecting `/rowid/`. Reverting any one table fails it. The sweep's other limits are in F3. |
| **S2 / NF2** carried REPLACE deletes a same-named sibling | **FIXED** | <ul><li>Rename 1913-1924; move 1947-1958; merge, per active child against the target's children, 2074-2086.</li><li>Consistent with index 304-306: `IS` ≡ `COALESCE(parent,'')`, BINARY `normalized_name`, `status='active'`.</li><li>Children cannot collide with each other (they are already siblings).</li><li>A move or merge into a descendant is still caught by the cycle clauses (1986, 2051).</li><li>Create stays covered by `memory_topics_insert_guard` 2212-2215.</li></ul> | **"rejects carried REPLACE sibling-name collisions…" (1027)**, by trace: each colliding sibling is an unreferenced leaf, so without the check REPLACE deletes it, the insert resolves, and both the `rejects` and the count assertions fail. |
| **S3 / NF3** rules future-date an expiry | **FIXED** | <ul><li>`occurred_at <= now+5min` (1320).</li><li>Monotonic against `state.updated_at` (1321-1326).</li><li>The exception requires `valid_to <= now` (1392).</li><li>The formats match: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` equals the ms-ISO CHECK shape (47, 136), so text comparison is sound.</li><li>No UPDATE bypass: transitions are immutable (1104), and `item_state.updated_at` is pinned to the transition (1552).</li><li>No backfill lockout: transitions are stamped at wall-clock time, and source/event times are unbounded (99, 529, 594).</li></ul> | **"bounds rules expiry by wall clock and the current state timestamp" (3103)**: <ul><li>the +4 min case kills a revert of 1392 back to `<= NEW.occurred_at`;</li><li>the out-of-order case kills 1321-1326.</li></ul>**The +5 min clause at 1320 is not isolated** (F4, runtime-proven). |
| **S4 / L4** ledger time bounded only below | **FIXED** (as scoped) | <ul><li>2862 `occurred_at <= now+5min`.</li><li>The lower bound is still `>= run.started_at` (2869), and a run's `started_at` is ±5 min at insert (2707-2708).</li><li>Residual: F6.</li></ul> | **"rejects cost ledger entries dated more than five minutes in the future" (2636)**, by trace: the same reservation shape succeeds in the fixture (test 459-465; run `running`, same model and price), so only 2862 rejects it. |
| **N4** depth-sum / unfinished walk | **FIXED** | <ul><li>Depth-sum: move 1990-1991, merge 2055-2056.</li><li>Unfinished walk: merge 2052-2054.</li><li>Move 1987-1989 is an **equivalent mutant**: when `ancestors` reaches depth 64, `subtree` always contributes ≥1 (1976, `COALESCE(…,1)` 1991), so depth-sum fires as well. It cannot be the sole cause, so it cannot be killed. It is harmless.</li></ul> | <ul><li>**3509**: move 62+2 accepted, 62+3 rejected; merge 62+2 accepted, 62+3 rejected. This kills both depth-sums.</li><li>**3587** (new at `a958020`): builds a 65-deep chain with the guard dropped, then merges a *childless* source. Ancestors reach 64 with a non-null parent, depth-sum is 64+0 and does not fire, and there is no cycle. Only 2052-2054 rejects, so this kills the merge unfinished-walk clause. It restores the guard in `finally`; topic_events has only this one BEFORE INSERT trigger, so trigger order is unaffected.</li></ul> |
| **N6** operand isolation | **FIXED** (tests; ingress stays `0019`) | Bindings at 1474-1476, 1576-1582, 1587-1594, 1745, 1835-1839 and 2387-2391. | 2032 (item/version), 2060 (range, both counts), 2098 (every forget entry field), 2162 (lift id), 2203 (topic id/parent/names/merge target) and 2300 (placement id/item/previous/new/relation). By trace, each mismatch is the only failing condition. The 2060 baseline of 3/3 is correct: 3 `user_committed` events of a fresh principal, no archive. These tests contain no in-test positive control; they rely on positive tests elsewhere. |
| **NF4** freshness baseline resets after a rules transition | **PARTIAL**: the SQL is fixed, the test does not isolate it | 1477-1487: `max(command.sequence)` over all of the item's owner transitions. | **"rejects a preissued owner command after any newer owner transition" (3171) does NOT kill a revert. RUNTIME-PROVEN (P1a/P1b).** It seeds the stale command as `item.correct` (3224), but at T4 the state is `expired`, so the CASE at 1464-1473 requires `item.transition`. The row is rejected on the operation mismatch whatever the baseline. With 1477-1487 reverted to the `8b62e80` baseline:<ul><li>the same scenario with `item.transition` is **accepted** (P1b);</li><li>the builder's `item.correct` variant is still rejected (P1b).</li></ul>At head, `item.transition` is rejected (P1a). |
| **NF7** merge child newer than merge | **FIXED** | 2087-2101 (includes the equal-ms ULID tiebreak, matching 2248-2252). | **1087**: without the pre-check, apply fails in `memory_topics_update_guard` with `memory_topic_update_requires_event`, which does not match `/memory_topic_event_invalid/`. |
| **NF8** alias JSON binding | **FIXED** | 1840-1841: `json(json_extract(…'$.payload.addedAliases')) = json(NEW.added_aliases_json)`. A missing key gives NULL and rejects (fail-closed). The comparison is key-order and number-format sensitive, also fail-closed, so the runtime must serialize both from one object. | **1954**: `[]` in the command against 1 alias in the row gives a reject, and the exact match is accepted. |
| **NF5 / NF6 / NF9** | **DOCUMENTED** | Design-doc diffs: `WITHOUT ROWID` note (§ invariants), archive-receipt count asymmetry, `/remember` creation receipt = original turn, day-range = UTC live-D1 only, with archived history going through sequence-range jobs. Schema behaviour matches: a day job over purged days still only counts live events (2798-2805) and can never start a run (2724-2745), so it cannot claim archived coverage. | n/a |

---

## 2. New findings

### F1. MEDIUM: carried `OR IGNORE` silently skips apply rows, so the immutable topic event commits while topic state diverges. RUNTIME-PROVEN (P2a, P2b, P2c)

- **Where:** `memory_topic_events_apply` (2136-2202).
  - `memory_topic_events.new_display_name` and `new_normalized_name` (323-324) have **no** CHECKs.
  - `memory_topics.display_name` and `normalized_name` do (274-280): 1..256 bytes, no NUL or control characters.
  - Added aliases are validated only for JSON type (2121-2131), while `memory_topic_aliases` CHECKs `alias_id` as a ULID and bounds the lengths (389-397).
- **Why:**
  - SQLite applies the outer statement's conflict policy to the trigger body, the same mechanism as S2.
  - Under IGNORE, a CHECK / NOT NULL / UNIQUE violation skips just that inner row.
  - `RAISE(ABORT)` guards still abort, but these CHECK failures happen after every guard has passed.
- **Scenarios** (each against the real migration):
  - **P2a:** a plain `INSERT` rename to a 300-byte name fails with `CHECK constraint failed`. The same row with `INSERT OR IGNORE` **commits the rename event**, but the topic keeps `Before`/`before` and `last_topic_event_id` is not advanced.
  - **P2b:** `INSERT OR IGNORE` create with a 300-byte name commits the event, and **no `memory_topics` row exists**. The topic id stays free for a second create event.
  - **P2c:** `INSERT OR IGNORE` rename with `aliasId:"not-a-ulid"` **applies the rename, and the alias row is dropped**. This breaks the invariant that every rename leaves an alias (1927), so the old name and path no longer resolve.
- **Not affected, by trace:**
  - `memory_item_transitions_apply_state`: the `item_state` CHECKs mirror the transition CHECKs (123-136 vs 153-160).
  - `memory_item_placement_events_apply_state` (425-436 vs 457-464).
  - The UNIQUE / partial-index paths are all pre-checked by guards, so IGNORE cannot skip them.
- **Impact:** a silent split between the authoritative topic event log and topic state. `actor='model'` may write topic events. There is no privacy or money impact and no other row is lost.
- **Fix:** mirror the `memory_topics` name CHECKs on `memory_topic_events.new_*` and `previous_*`, and validate each added alias in the insert guard (`aliasId` ULID shape, name ≤256 bytes, path ≤2048 bytes). Then any violation rejects the outer row itself. Add `INSERT OR IGNORE` cases for the three apply-bearing tables to the sweep.

### F2. LOW: the NF4 test cannot fail on a revert. RUNTIME-PROVEN (P1b)
- **Where:** test 3222-3226 uses `"item.correct"`. The guard's CASE (1464-1473) maps an `expired` current state to `item.transition`.
- **Fix:** seed the stale command as `item.transition` (one word).

### F3. LOW: the "generic sweep" (test 3983) is narrower than its name. Pin insensitivity RUNTIME-PROVEN (P3); the rest is a trace

- **Hard-coded, not dynamic:**
  - It iterates `insertGuards`, 23 literal entries.
  - `PRAGMA table_list` is used only to look up `wr`.
  - The schema inventory (test ~562) checks `name IN (EXPECTED_TABLES)`, so a 24th `memory_*` table would go unswept and undetected.
  - `cloud-memory-trigger-contract.test.ts` inventories triggers only.
- **Natural key:** it re-inserts the *identical* row with a regex-less `toThrow()`. That never tries a fresh PK with a colliding secondary UNIQUE. By reading, every secondary UNIQUE is pre-checked, so the protection is real but untested by this sweep:
  - lifts `suppression_id` 1724;
  - links tuple 1793-1796;
  - vectors `mutation_id` / content tuple 2644-2649;
  - prices 2684-2686;
  - runs `run_key` 2697;
  - sources 1279-1281;
  - episode sources 2538-2540;
  - aliases 2313-2315;
  - placement events 2338-2340;
  - transitions 1316-1318;
  - versions 1257-1259.
- **Key update:** each key column is set to a *non-colliding* value (`||':replace-probe'`, `+1e9`), again with no error regex. The throw comes from ULID/IN CHECKs, FKs, or unrelated state clauses, which fire first:
  - vectors `NEW.deleted_at IS NULL` 2658;
  - runs `NEW.outcome='running'` 2756;
  - jobs pending→pending 2842-2845;
  - cursors CHECK/FK.

  So the sweep detects only the wholesale removal of a guard, never a single dropped pin.
  - **P3:** with `OR NEW.mutation_id <> OLD.mutation_id` removed from `memory_vectors_update_guard`, the sweep's exact statement still throws, but `UPDATE OR REPLACE memory_vectors SET mutation_id=<B's>, deleted_at=<now> WHERE id=A` **deletes vector B**.
  - Runs `run_key` (2759) and the jobs/cursors pins are the same by trace. Item-state, topic and placement pins have dedicated round-2 tests (2651, 2683, 2733).
- **Not covered:** the FTS5 virtual tables and their shadow tables (`*_data`, `*_idx`, `*_docsize`, `*_config`), which accept direct writes and `'delete'` commands. This is pre-existing, and they are rebuildable indexes.
- **Fix:**
  - enumerate `sqlite_schema` (`type='table'`, `memory\_%`, excluding virtual and shadow tables) and assert it equals the list;
  - per UNIQUE index, insert a fresh-PK row with a colliding tuple;
  - collide key updates against a second fixture row, setting every other column to a legal next state, and assert the named guard error.

### F4. LOW: the +5 min transition bound (1320) is unisolated, and a near-future stamp refuses owner transitions for up to 5 minutes. RUNTIME-PROVEN (P4a, P4b)
- **P4b:** with 1320 removed, both future-expiry negatives in test 3103 still reject, because `valid_to` is now+2 min > now. Without 1320, one far-future rules stamp would wedge the item through 1321-1326 indefinitely, and nothing tests that.
- **P4a (at head):** a rules `active` stamped now+4 min is accepted. An owner `item.forget` stamped now is then **rejected**; the same forget stamped now+4 min is accepted.
- **Fix:**
  - add a test with `valid_to <= now` and `occurred_at = now+10 min`;
  - the runtime must stamp transitions `max(now, state.updated_at)`. Record this in the design doc next to the monotonic rule.

### F5. LOW: merging a topic into its own parent fails when it has an active child with its own name. TRACE (fail-closed)
- **Where:** the merge collision check (2074-2086) counts the still-active source as the target's child. Apply also reparents children (2172-2181) *before* marking the source merged (2195-2201), so the index would reject it anyway.
- **Effect:** the owner must rename first.
- **Fix:** exclude `sibling.topic_id = NEW.topic_id` from the check *and* move the source's `status='merged'` UPDATE before the child reparent. Or accept and document it.

### F6. LOW: the ledger lower bound is the run's start, so a run left `running` across a month boundary books new reservations into the prior month. NOT PROVEN (trace)
- **Where:**
  - 2869 `occurred_at >= run.started_at`;
  - runs have no maximum duration (2753-2778);
  - the normal monthly cap is enforced in app code (the guard has no `normal_monthly` sum, 2856-2978).
- **Fix:** also require `occurred_at >= now-5 min` for `reservation` rows, or bound the run's lifetime.

### F7. LOW (test harness): module-load `timestamp` against the run −5 min bound (2707). NOT PROVEN
- **Where:** `timestamp = testClock − 60 s` (test 6). The fixture and other run inserts use it as `started_at` (e.g. test 452-456).
- **Effect:** if more than about 4 minutes of this file elapse before those inserts (plausible while mutation runs share the machine), they fail with `memory_run_initial_state_invalid`. That is an assertion failure caused by load, not a timeout, so it can be misread as a real result.
- **Fix:** stamp run inserts with `new Date().toISOString()` at call time.

### Note: `WITHOUT ROWID` with large rows
- `memory_topic_events` can carry about 112 KB of JSON per row (326-343), and `memory_item_sources` up to 8 KB (91-96).
- SQLite recommends `WITHOUT ROWID` for small rows. Large rows overflow sooner in the index-b-tree layout, and interior cells carry key records.
- This affects performance only, not correctness, and is irrelevant at Sid's scale.

---

## 3. Remote D1 rules

- **No `CASE … RAISE`.** The only `CASE` is the value expression at 1464-1473. Contract test line 92 enforces the `SELECT CASE … RAISE(` shape. There are no window functions.
- **Recursive CTEs are unchanged:** 5 definitions in 3 trigger statements, at 1870-1883 (create), 1960-1984 (move: `ancestors`, `subtree`) and 2021-2049 (merge: `ancestors`, `descendants`). The new sibling and ordering checks are non-recursive.
- **Constructs that need the Sid-attended scratch remote-D1 proof, beyond round 3's list:**
  - the `STRICT, WITHOUT ROWID` combined table option on 17 tables (0014 used only plain `WITHOUT ROWID`);
  - `strftime('%Y-%m-%dT%H:%M:%fZ','now', …)` in trigger WHEN, now at 1320, 1392 and 2862 (plus 1814, 2707-2708);
  - `json(json_extract(…)) = json(…)` at 1840-1841;
  - scalar `max()` inside `COALESCE` at 1478.
- `PRAGMA table_list` and the `?raw` trigger-recreate are test-only and never part of the migration.
