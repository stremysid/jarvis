# PR #39 re-review probes — S1-S4 on 0016_cloud_memory.sql

Probes that ASSERT THE BUG EXISTS: each PASSES on buggy code and FAILS on a correct fix.

## Heads
- 8b62e80: worktree at c34ab17 (code == 8b62e80), round-3 changes-requested; the four holes present.
- 30219fd: fix head (SQL byte-identical to d24f997 / 689e984); S1-S4 fixed: 0016 tables WITHOUT ROWID, topic/transition/ledger guards tightened.

Worktree C:\Users\Sid\jarvis-pr39 (Windows 11). Harness apps/cloud-gateway/test/persistence/migration.ts -> applyCloudMemoryMigration(); runtime PRAGMA recursive_triggers = 0 (REPLACE-driven deletes do NOT fire BEFORE DELETE guards). One vitest process at a time. SAVEPOINT unsupported in D1 test binding, so the sweep classification pass is non-destructive and every executed delete uses its own isolated principal.

Run command (per file):
    cd C:/Users/Sid/jarvis-pr39
    npx.cmd vitest --config ./vitest.workspace.ts run apps/cloud-gateway/test/persistence/<probe>.test.ts --reporter=verbose

## Result summary
| Probe | File | 8b62e80 | 30219fd | Fix-head refusal |
|---|---|---|---|---|
| S1 | zz-reviewer-pr39-s1-sweep.test.ts | 4/4 PASS (17 EXPOSED; 6 executed deletes) | 3 fail / 1 pass (0 EXPOSED; deletes refused) | no such column: rowid (WITHOUT ROWID) + clean matrix |
| S2 | zz-reviewer-pr39-s2-topic-sibling.test.ts | PASS (sibling deleted) | fail (sibling survives) | RAISE memory_topic_event_invalid |
| S3 | zz-reviewer-pr39-s3-future-expiry.test.ts | PASS (future expiry + reactivation accepted) | fail (expiry rejected) | RAISE memory_item_transition_invalid |
| S4 | zz-reviewer-pr39-s4-ledger-month.test.ts | PASS (next-month reservation accepted) | fail (reservation rejected) | RAISE memory_cost_entry_lineage_invalid |

No REPLACE form deletes or changes a guarded row on 30219fd. No residual finding beyond S1-S4.

---

## Probe 1 — S1 generic REPLACE sweep
Independent of the builder's own sweep. Derives all 23 base tables from sqlite_master (excludes memory_fact_projection*, FTS virtual+shadow; asserts enumerated set == known 23), classifies each table's rowid model and what its insert/update guards pin, prints S1_SWEEP_MATRIX, then executes destructive forms on isolated legitimately-seeded rows.

Four tests: (1) classify + assert unguarded-implicit-rowid set == the 17 STRICT TEXT-PK tables; (2) INSERT OR REPLACE explicit rowid on prices/coverage/cost_ledger; (3) UPDATE OR REPLACE SET rowid on runs/reprocess_jobs/vectors; (4) natural-key INSERT OR REPLACE control (non-destructive).

8b62e80 PASS (4/4): S1_INSERT_EXPLICIT_ROWID_EXPOSED = the 17 tables (cost_ledger, episode_sources, event_suppression_lifts, event_suppressions, history_coverage, item_links, item_placement_events, item_sources, item_transitions, items, model_prices, reprocess_jobs, runs, topic_aliases, topic_events, topics, vectors). Executed: deleted=true for prices/coverage/cost_ledger; victim_deleted=true for runs/vectors/reprocess_jobs. No immutable-delete/delete guard fired.

Proves: every STRICT TEXT-PK 0016 table keeps an implicit rowid no insert guard checks (NEW.rowid is -1 unless supplied), so INSERT OR REPLACE (rowid, ...) deletes a guarded row. runs/reprocess_jobs/vectors additionally allow UPDATE OR REPLACE SET rowid (conditional guards 0016:2695/2767/2597 don't pin rowid).

30219fd 3 fail / 1 pass (fixed): matrix clean — S1_INSERT_EXPLICIT_ROWID_EXPOSED = []; 20 tables now without_rowid, 3 remain integer_pk_alias. Executed forms refused with "no such column: rowid at offset 7: SQLITE_ERROR" (schema-level refusal from WITHOUT ROWID). Natural-key control passes on both heads.

### Sweep matrix (side by side). Full JSON: matrix-8b62e80.txt, matrix-30219fd.txt
| Table | 8b62e80 rowidModel | insert-explicit-rowid | UPDATE-OR-REPLACE-rowid | 30219fd rowidModel |
|---|---|---|---|---|
| memory_items | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_item_sources | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_item_transitions | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_event_suppressions | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_event_suppression_lifts | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_item_links | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_topics | implicit_rowid | EXPOSED | EXPOSED (conditional, unpinned) [dagger] | without_rowid |
| memory_topic_events | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_topic_aliases | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_item_placement_events | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_episode_sources | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_history_coverage | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_vectors | implicit_rowid | EXPOSED | EXPOSED (conditional, unpinned) | without_rowid |
| memory_model_prices | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_runs | implicit_rowid | EXPOSED | EXPOSED (conditional, unpinned) | without_rowid |
| memory_reprocess_jobs | implicit_rowid | EXPOSED | EXPOSED (conditional, unpinned) | without_rowid |
| memory_cost_ledger | implicit_rowid | EXPOSED | blocked (immutable update) | without_rowid |
| memory_item_versions | integer_pk_alias:version_rowid | guarded | blocked (immutable update) | integer_pk_alias:version_rowid |
| memory_episodes | integer_pk_alias:episode_rowid | guarded | blocked (immutable update) | integer_pk_alias:episode_rowid |
| memory_history_chunks | integer_pk_alias:chunk_rowid | guarded | blocked (immutable update) | integer_pk_alias:chunk_rowid |
| memory_item_state | without_rowid | n/a | n/a | without_rowid |
| memory_item_placement_state | without_rowid | n/a | n/a | without_rowid |
| memory_cursors | without_rowid | n/a | n/a | without_rowid |

[dagger] topics: structurally conditional+unpinned, but memory_topics_update_guard (0016:2175) requires last_topic_event_id to advance, so a bare SET rowid is already blocked by memory_topic_update_requires_event. Only runs/jobs/vectors URR-rowid are executed and asserted. WITHOUT ROWID closes topics regardless.

---

## Probe 2 — S2 topic sibling deletion via REPLACE-carried apply UPDATE
Root R with active leaves alpha (A) and beta (B, empty). INSERT OR REPLACE INTO memory_topic_events renames A alpha->beta; rename branch (0016:1895-1911) checks no sibling name (only create does, 0016:2154-2157), so accepted; the AFTER-INSERT apply UPDATE (0016:2099-2105) inherits REPLACE, collides with memory_topics_sibling_name (0016:304-306) and deletes B; memory_topics_delete_guard (0016:2244) does not fire.
- 8b62e80 PASS: S2_SIBLING_COUNT 0, A normalized_name = beta, no error.
- 30219fd fail (fixed): memory_topic_event_invalid; S2_SIBLING_COUNT 1; A stays alpha.
- Expected fix-head failure: RAISE memory_topic_event_invalid.

## Probe 3 — S3 rules future-date an expiry over an owner-confirmed fact
Owner-confirmed active item; current version valid_to = now+30d. rules writes expired with occurred_at = now+31d (>= valid_to). Owner-lock exception (0016:1381-1386) compares valid_to to caller-supplied NEW.occurred_at with no real-time bound -> premature expiry accepted, actor becomes rules, then a rules active on a new version is accepted over the owner's confirmation.
- 8b62e80 PASS: expiry + reactivation accepted; final lifecycle_state = active on the rules version while valid_to (2026-10-15) > now (2026-09-15).
- 30219fd fail (fixed): memory_item_transition_invalid; expiry rejected, owner active preserved.
- Expected fix-head failure: RAISE memory_item_transition_invalid.

## Probe 4 — S4 ledger reservation stamped next month escapes the cap
Running distillation run (started_at = now); normal_monthly reservation with occurred_at = now+45d. Ledger guard bounds occurred_at only below (>= run.started_at, 0016:2810), no upper bound -> accepted into next month's memory_cost_ledger_month_lookup bucket (0016:1044), missing this month's cap. Control: a run with next-month started_at is already refused (memory_runs bounds +/-5 min, 0016:2649-2650).
- 8b62e80 PASS: reservation accepted, 1 row at 2026-10-30; future-run control refused memory_run_initial_state_invalid.
- 30219fd fail (fixed): memory_cost_entry_lineage_invalid; 0 next-month rows; run path still closed.
- Expected fix-head failure: RAISE memory_cost_entry_lineage_invalid.

## Observations / holes beyond S1-S4
- None that survive the fix. Every executed REPLACE form is refused on 30219fd; sweep matrix clean (0 EXPOSED).
- memory_topics UPDATE-OR-REPLACE-rowid: informational only (see [dagger] above), not a new finding.
- Fix-head refusal style: S2/S3/S4 fail via genuine guard RAISEs; S1's rowid forms fail via "no such column: rowid" (natural consequence of WITHOUT ROWID). The S1 structural matrix assertion (17 -> 0 EXPOSED) is the meaningful, non-schema-error kill.
