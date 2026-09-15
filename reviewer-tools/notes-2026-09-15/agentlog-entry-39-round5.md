## 2026-09-15 04:54 UTC — Claude Opus 5, PR #39 round-5 re-review at 4189a2e: changes requested (small)

This round reviewed fix `c4923bf`. The head is `4189a2e`, and the branch merges cleanly with main at `2619f02`. Round 4's S1–S3 and F5–F7 are fixed and runtime-proven, and there is no High or Medium issue. Two Low SQL issues remain. Both are cheaper to fix in `0016` now than in a later migration, because one needs a UNIQUE constraint changed. There are also a few test gaps. If these land cleanly with no new High or Medium, the reviewer expects to clear #39 on the next round.

**Local checks on 4189a2e** (Windows 11, `jarvis-pr39`). Trigger removals and the builder chats' own test runs shared the machine.
- Lint and typecheck pass.
- `pnpm test` passed 2,902 of 2,905. The 3 failures were all 5 s timeouts, in archival-service, voice-call-path and voice-telegram-call. Rerun alone, each passed: 46/46, 18/18 and 44/44.
- `apps/local-agent` is unchanged, so pytest was not rerun.

**Earlier probes on 4189a2e.**
- Round-4 exploit probes P2a, P2b and P2c (carried `OR IGNORE`) now **fail**: the event row is refused with `memory_topic_event_invalid`.
- Round-3 independent probes plus H2 and NF1: 8 fail. The 4 passes are the natural-key controls and the NF1 file's non-exploit checks, which pass on every head.
- P1b, P3 and P4b mutate the SQL and assert the mutant's behaviour, so they pass on every head. Their real check is the targeted reverts below.

**Targeted reverts against the builder's tests** (`mut39f-targeted.json`; BASE passed, 0 timeouts). Each fix was reverted one at a time:
- The NF4 baseline, the +5-minute transition bound, the vector `mutation_id` pin, alias-id validation, alias length validation, the event `new_display_name` CHECK, the reservation lower bound and the own-parent merge exclusion **were each killed by a named test**. For example, "refuses OR IGNORE topic events whose apply rows would be incomplete" caught the alias and display-name reverts, "rejects a backdated reservation on a run that crossed a monthly boundary" caught the reservation bound, and "merges a topic into its own parent before reparenting a same-named child" caught the merge exclusion.
- **Survived:** removing the event's `new_normalized_name` CHECK (0016 341–344). No test sends an over-long normalized name. See N1.

**Trigger coverage** (`mut39f-c1..c4.json`, regenerated from this SQL). Each of the 75 trigger blocks was removed and only `cloud-memory-migration.test.ts` was run. BASE passed in every chunk. **75 of 75 killed, 0 survived, 0 invalid, 0 timeouts.** 63 kills were matched to a named test. The 12 unnamed kills were checked by hand; each failed relevant behavioural tests in milliseconds. Among them, removing the transition insert guard now also fails "refuses OR IGNORE item-transition and placement-event rows before apply".

**Re-verification** (Opus pass, `reviewer-tools/pr39-reverify4.md`). The reviewer reran all 10 of its runtime probes on `4189a2e` (10/10). Its clause-removal results are in `reviewer-tools/pr39-reverify4-mutations.jsonl`.
- **Fixed:**
  - S1: every apply-bearing path under an outer `OR IGNORE`, `REPLACE`, `FAIL` or `ROLLBACK` was traced, and each constraint is either pre-checked or behind a nested RAISE. `INSERT OR FAIL` of an over-long create or a malformed alias is refused whole (V4).
  - S2: the NF4 test now seeds `item.transition`.
  - S3: removing 1340 fails test 3324.
  - F5: removing the exclusion at 2101, or restoring the old apply order, fails test 1260. Retiring the source first opens no cycle or redirect inconsistency.
  - F6: removing 2891–2892 fails test 2837, and settling an old reservation still works.
  - F7.
- **Partial:** S4 (N3 below).

**S1 (verifier N1, Low, runtime-proven). The alias tuple UNIQUE can wedge natural renames, and F5 reaches it in one step.**
- `UNIQUE (principal_id, normalized_alias, path_alias)` (421), plus the rule that every rename or merge adds at least one alias (1947, 2139), plus the nested alias guard aborting on an existing tuple (2341–2343).
- So a topic renamed X→Y→X can never be renamed to Y again with its natural alias: refused `memory_topic_alias_requires_event` (V1).
- After merging "Shared" into its own parent, the alias `Root/Parent/Shared` points at Parent while a live child has the same path. One path now names two topics, and the child's natural rename is refused (V2).
- Fail-closed, with no data loss, but automatic filing can get stuck on ordinary renames.
- Fix: make the tuple index non-unique with latest-alias-wins resolution, or have apply skip an identical existing tuple and exempt it from the ≥1 rule. Also document that a live path wins over an alias. Test both V1 and V2 scenarios.

**S2 (verifier N2, Low, runtime-proven). Settlement, release and overrun rows can be back-dated into a closed month.** Only reservations got the `now - 5 minutes` lower bound (2891). The others are bounded below only by `run.started_at` (2899), and runs have no maximum lifetime. On a run left `running` for 40 days, a settlement and an overrun stamped 35 days back are both accepted (V5), so a real overrun can escape the current month's cap. Fix: apply `occurred_at >= now - 5 minutes` to every ledger entry type. Test each type.

**S3 (verifier N3, test gap, runtime-proven). Single key-pin and clause removals still survive the whole migration file (128/128).** The six are the `cursor_name` pin (3024), the vector `item_id` pin (2691), the `run_key` pin (2787), the alias (name, path) duplicate clause (2341–2343), the topic-create sibling clause (2240–2243) and the one-primary placement clause (2461–2463).
- With the pins removed, same-principal `UPDATE OR REPLACE` deletes a sibling cursor (the FTS cursor jumps 5→9) or another vector row (V6, V7).
- With the clauses removed, a carried REPLACE deletes another topic's alias, an existing sibling, or the primary placement state (V8–V10).
- Causes: key groups collide against another principal's row, so the `principal_id` pin masks the rest; clone inserts match the named error through an unrelated clause; and the three partial/expression unique indexes (`memory_topics_one_root`, `memory_topics_sibling_name`, `memory_item_one_primary_placement`) are skipped.
- Fix:
  - collide one column at a time against same-principal rows;
  - add crafted `OR REPLACE` create and place collisions for the three partial indexes;
  - assert the `insertGuards` table set equals the schema table set, using `PRAGMA table_list` type rather than name globs.

**S4 (reviewer, Low, test gap).** The `memory_topic_events.new_normalized_name` byte-length CHECK has no isolating test. With it removed, all 128 migration tests pass. By the same mechanism proven in round 4's P2a (traced, not separately run), an `INSERT OR IGNORE` rename with a valid display name and a 300-byte normalized name would then commit the event while apply skips the `memory_topics` row (its CHECK at 280). The SQL at head is correct; add that case to the OR IGNORE test.

**Notes for the runtime PR (not findings).** Writers must stamp at write time and re-stamp on retry: reservations (2891) and transitions (1340, `max(now, updated_at)`). A Worker-to-D1 clock skew over 5 minutes fails closed.

**Remote D1.** There is still no `CASE … RAISE`, and the 5 recursive CTEs in 3 statements are unchanged. `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')` at 2891–2892 is a new site for the scratch proof, alongside round 4's list at head line numbers: `STRICT, WITHOUT ROWID`; `strftime(…'now'…)` at 1340, 1412, 1834, 2735–2736 and 2890; `json(json_extract(…)) = json(…)` at 1860–1861; and `max()` inside `COALESCE` at 1497–1498.

**Next.** Fix S1 and S2 in `0016`, add the S3 and S4 tests, then request re-review. The reviewer will rerun V1, V2, V5 and V6–V10 (which must fail or be killed), the targeted reverts and the trigger removals. The scratch remote-D1 steps are drafted (`reviewer-tools/remote-d1-0016/`, not yet reviewed). They go to Sid once the SQL clears. The `0019` ingress allowlist stays separate.

Sid retains merge and migration authority. Nothing is applied or deployed.
