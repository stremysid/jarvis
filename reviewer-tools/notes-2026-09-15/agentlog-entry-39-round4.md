## 2026-09-15 03:58 UTC — Claude Opus 5, PR #39 round-4 re-review at 30219fd: changes requested (small)

This round reviewed fix `689e984` and the test-only `a958020`. The head is `30219fd`, and its SQL and `src/` are byte-identical to `d24f997`. The branch merges cleanly with main at `2619f02`. S1–S4 are fixed and proven at runtime. One new Medium issue in the same carried-conflict class is left, plus three test gaps. Each is small.

**Local checks** (Windows 11, `jarvis-deploy`). These ran while other reviewer jobs shared the machine.
- On `d24f997`: lint and typecheck pass. `pnpm test` passed 2,896 of 2,900.
- The 4 failures were all "Test timed out" in `voice-guest-access`, `archival-service`, `hermes-token-adapter` and `call-session-do`. Rerun alone, each file passed: 9/9, 46/46, 71/71 and 112/112.
- On `30219fd`: `cloud-memory-migration.test.ts` passed 124 of 124 as the BASE of each trigger-removal chunk.
- `apps/local-agent` is unchanged since `8b62e80`, so pytest was not rerun.

**Old probes, which must now FAIL:**
- `pr39-h2-probe` fails with `memory_cursor_duplicate`.
- `pr39-nf1-probe` fails with `no such column: rowid`.

**Independent probes** (`reviewer-tools/pr39-probes/`). These are the reviewer's own and separate from the builder's sweep. They classify all 23 tables from `sqlite_master`, then attempt explicit-rowid REPLACE, natural-key REPLACE and `UPDATE OR REPLACE` on keys and rowid, plus the S2, S3 and S4 exploits.
- On `8b62e80`, all 4 probes pass, confirming the holes: exactly 17 tables exposed, the sibling topic deleted, a future-dated rules expiry that re-activates over an owner fact, and a next-month reservation accepted.
- On `30219fd`, reviewer rerun: 6 of 7 tests fail. The one pass is the natural-key control, which passes on both heads. The matrix now shows 0 exposed forms, and the rowid forms are refused with `no such column: rowid`. S2, S3 and S4 are refused by the real guard RAISEs (`memory_topic_event_invalid`, `memory_item_transition_invalid`, `memory_cost_entry_lineage_invalid`).

**Trigger coverage** (`mut39e-c1..c4.json`, regenerated from this SQL with `gen-trig.mjs`; chunk 1 ran on `d24f997`, chunks 2–4 on `30219fd`). Each of the 75 trigger blocks was removed and only `cloud-memory-migration.test.ts` was run. BASE passed in every chunk. **75 of 75 killed, 0 survived, 0 invalid.** 63 kills were matched to a named test. All 12 unnamed kills were checked by hand: relevant behavioural tests failed in milliseconds, and `timed out` appears 0 times.

**Re-verification** (Opus pass, `reviewer-tools/pr39-reverify3.md`). The reviewer reran all 8 of its runtime probes on `30219fd` (8/8) and read the cited SQL.
- **Fixed:** S1 (17 tables `STRICT, WITHOUT ROWID`, nothing reads their rowid), S2 (sibling checks on rename, move and merge), S3 (≤ now+5 min, monotonic against `updated_at`, `valid_to <= now`), S4, N4 (new test 3587 isolates the merge unfinished-walk clause; the move clause is an equivalent mutant), N6, NF7 and NF8.
- **Documented:** NF5, NF6 and NF9.
- **Partial:** NF4. The SQL is fixed, but its test cannot fail on a revert (S2 below).

**S1 (Medium, runtime-proven). A carried `OR IGNORE` commits a topic event while the topic change is silently skipped.**
- SQLite applies the outer `OR IGNORE` to the `memory_topic_events_apply` body (2136–2202), the same mechanism as round 3's NF2. A CHECK violation inside apply then skips just that inner row, after every guard has passed.
- `memory_topic_events.new_display_name` and `new_normalized_name` (323–324) have no CHECKs. `memory_topics` does (274–280): 1–256 bytes, no control characters.
- Added aliases are checked only for JSON type (2121–2131), while `memory_topic_aliases` requires a ULID `alias_id` and bounded lengths (389–397).
- Proven on the real migration:
  - A plain INSERT rename to a 300-byte name is refused with `CHECK constraint failed`.
  - The same row with `INSERT OR IGNORE` commits the rename event, but the topic keeps its old name and `last_topic_event_id` does not advance.
  - An `OR IGNORE` create with a 300-byte name commits the event with no `memory_topics` row.
  - An `OR IGNORE` rename with `aliasId: "not-a-ulid"` applies but drops its required alias, so the old name and path stop resolving.
- `actor = 'model'` may write topic events. The item-transition and placement apply paths are not affected, because their state CHECKs mirror the event CHECKs.
- Fix: mirror the `memory_topics` name CHECKs on `memory_topic_events` `new_*` and `previous_*`, and validate every added alias in the insert guard (ULID `aliasId`, name ≤ 256 bytes, path ≤ 2048 bytes). Any violation then rejects the outer row.
- Test: an `OR IGNORE` case for each apply-bearing table (topic events, item transitions, placement events) asserting the event row is refused.

**S2 (runtime-proven). The NF4 test cannot fail.** "rejects a preissued owner command after any newer owner transition" (3171) seeds the stale command as `item.correct` (3224). At that point the state is `expired`, so the guard's CASE (1464–1473) requires `item.transition`, and the row is refused on the operation mismatch whatever the freshness baseline is. With 1477–1487 reverted to the `8b62e80` baseline, the same scenario using `item.transition` is accepted. Fix: seed the stale command as `item.transition`.

**S3 (runtime-proven). The +5-minute transition bound (1320) has no isolating test.**
- With 1320 removed, both future-expiry negatives in test 3103 still reject, because `valid_to` is only now+2 min.
- Without 1320, one far-future rules stamp would wedge the item indefinitely through the monotonic clause.
- At head, a rules write stamped now+4 min makes an owner forget stamped now fail until the clock catches up.
- Fix: add a test with `valid_to <= now` and `occurred_at = now + 10 min`. Also record in the design doc that the runtime stamps transitions `max(now, state.updated_at)`.

**S4 (runtime-proven in part). The generic sweep (3983) catches only the wholesale removal of a guard.**
- It iterates the hard-coded `insertGuards` list, and the inventory checks `name IN (EXPECTED_TABLES)`, so a 24th `memory_*` table would go unswept and unnoticed.
- Its key updates set non-colliding values with a regex-less `toThrow()`, so unrelated CHECKs fire first.
- Proven: with `OR NEW.mutation_id <> OLD.mutation_id` removed from `memory_vectors_update_guard`, the sweep's statement still throws, but a colliding `UPDATE OR REPLACE … SET mutation_id = <B's>, deleted_at = now` deletes vector B.
- Fix:
  - enumerate `sqlite_schema` (`memory\_%` tables, excluding FTS virtual and shadow tables) and assert it equals the list;
  - collide each key update against a second fixture row, with the other columns set to a legal next state, and assert the named guard error;
  - add the `OR IGNORE` cases from S1.

**Lows.** Fix now if cheap, otherwise record in KNOWN_ISSUES:
- **F5:** merging a topic into its own parent fails when it has an active child with its own name (2074–2086 counts the still-active source). This fails closed; fix or document.
- **F6:** the ledger lower bound is the run's `started_at` (2869), and runs have no maximum lifetime, so a run left `running` across a month boundary books reservations into the prior month. Add `occurred_at >= now - 5 min` for `reservation` rows, or bound the run lifetime.
- **F7:** the test file's module-load `timestamp` (test line 6) feeds run `started_at`. If about 4 minutes pass before those inserts under load, they fail with `memory_run_initial_state_invalid`, an assertion that looks real. Stamp run inserts at call time.

**Remote D1.** There is still no `CASE … RAISE` (the only `CASE` is a value expression at 1464) and no window function. The 5 recursive CTEs in 3 statements are unchanged. The Sid-attended scratch proof must now also cover:
- the `STRICT, WITHOUT ROWID` combined option on 17 tables;
- `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', …)` in trigger WHEN clauses (1320, 1392, 2862, 1814, 2707–2708);
- `json(json_extract(…)) = json(…)` (1840–1841);
- scalar `max()` inside `COALESCE` (1478).

**Next.** Fix S1–S4 and add the tests, then request re-review. The re-review reruns the reviewer probes (P1b, P2a–c, P3, P4b must fail), the sweep matrix and the trigger removals. The scratch remote-D1 steps are being prepared now, so they can be given to Sid as soon as the SQL clears. The N6 ingress allowlist stays the separate `0019` PR.

Sid retains merge and migration authority. Nothing is applied or deployed.
