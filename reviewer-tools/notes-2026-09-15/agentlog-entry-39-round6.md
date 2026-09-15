## 2026-09-15 05:32 UTC — Claude Opus 5, PR #39 round-6 re-review at 5ef0ce5: cleared with follow-ups F1–F3

This round reviewed fix `2fc8dc6`. The head is `5ef0ce5`, and the branch merges cleanly with main at `2619f02`. Every round-5 request is fixed and proven at runtime. The whole-trigger coverage is complete, and no High or Medium issue remains. **The 0016 SQL is cleared.** The remaining items are one Low time bound and some test-isolation gaps. None can matter before the memory runtime exists, so they go into the already-planned `0019` PR as F1–F3. Sid may merge #39. Merging applies nothing.

**Local checks on 5ef0ce5** (Windows 11, `jarvis-pr39`): lint and typecheck pass. `pnpm test` passed **2,910 of 2,910** with 0 timeouts. `apps/local-agent` is unchanged, so pytest was not rerun.

**Earlier probes on 5ef0ce5:**
- Round-5 V1 (X→Y→X→Y wedge), V2 (own-parent merge path collision) and V5 (month-crossing settlement and overrun back-dating) now **fail**. The renames and the child rename resolve, and the back-dated rows are refused with `memory_cost_entry_lineage_invalid`.
- V8 now fails with `probe_mutation_anchor_not_unique`, because the alias duplicate clause it mutated was deliberately removed with the tuple UNIQUE.
- V3 and V4 (head behaviour) still hold.
- Round-4 P2a–c still fail, and the round-3 probes plus H2 and NF1 give the expected 8 failures and 4 control passes.

**Targeted reverts** (`mut39g-targeted.json`; BASE passed, 0 timeouts). Each of the 8 round-5 fixes, reverted one at a time, **is killed by a named test**:
- restoring the alias tuple UNIQUE ("retains repeated natural rename aliases and resolves the newest alias", plus the own-parent merge test);
- a reservation-only ledger bound ("rejects every backdated ledger entry type…");
- the `cursor_name`, vector `item_id` and `run_key` pins (the three new same-principal collision tests);
- the topic-create sibling and one-primary placement clauses ("rejects carried OR REPLACE collisions for every partial unique index");
- the event `new_normalized_name` CHECK (the OR IGNORE test).

**Extra single-pin removals, the reviewer's choice.** The item-state `item_id` pin and the cursor sequence monotonic check are killed. Six pins still survive the whole file (133/133): vector `content_hash` and `embedding_model` (0016 2694–2696), run `job` and `started_at` (2790, 2796), and placement-state `item_id` and `relation` (2489–2490).
- **Vector `content_hash` is a real gap** (runtime-proven by the reviewer): with that pin removed, a same-principal `UPDATE OR REPLACE … SET content_hash = <B's>` deletes vector B.
- **Vector `embedding_model` is harmless:** its column CHECK allows a single value, so no collision can be built.
- **Run `job` and `started_at`** are not unique-key columns, so REPLACE cannot delete rows through them. They are untested bookkeeping pins.
- **Placement-state `item_id` and `relation`** are re-pinned by the guard's event match (2498–2499), so they are equivalent mutants.

**Trigger coverage** (`mut39g-c1..c4.json`, regenerated from this SQL). Each of the 75 trigger blocks was removed, and only `cloud-memory-migration.test.ts` was run. BASE passed in every chunk. **75 of 75 killed, 0 survived, 0 invalid, 0 timeouts.** 63 kills were matched to a named test. The 12 unnamed kills were checked by hand; each failed relevant behavioural tests in milliseconds.

**Re-verification** (Opus pass, `reviewer-tools/pr39-reverify5.md`). The reviewer reran all 10 of its runtime probes on `5ef0ce5` (10/10). The pass ran 30 clause removals, each restored byte-for-byte.
- **S1, fixed.** The alias UNIQUE is gone (408–425), and the new resolution index is non-unique with a total order ending in `alias_id` (427–431). Carried REPLACE and IGNORE, duplicate ids within one event, and a verbatim REPLACE are all refused (P1). Restoring the UNIQUE fails tests 1104 and 1338. The design now says a live path wins over an alias.
- **S2, fixed.** The −5 minute bound covers every ledger entry type (2893), and test 2956 fails if any type is exempted. Old reservations can still be settled or released now, including after the run completes (P3a–c).
- **S4, fixed.** Test 1155 fails without the 341–344 CHECK.
- **S3, fixed for the six named removals.** Of 14 further single-pin removals, 7 survive: 2 are harmless by construction, and the rest are covered by F2.

**F1 (Low, runtime-proven; SQL in `0019`). Topic events accept any past time.** 1839 bounds `occurred_at` only above, so an alias written later but stamped earlier loses newest-first resolution to an older write (P2). Add `occurred_at >= now − 5 minutes` to the topic-event guard, matching the ledger and transition bounds, with a test.

**F2 (Low, tests only). Some key pins are not isolated by any test.** With these pins removed, the migration file still passes, yet destructive `UPDATE OR REPLACE` works: vector `item_kind`, `content_hash` and `principal_id` (P4a–c, plus the reviewer's own `content_hash` probe; the SQL at head refuses all three, P4d), and by trace run `principal_id` and placement `placement_id`. Replace the per-pin tests with one generic loop: for every unique key of every 0016 table, collide each column singly against a same-principal row and assert the named guard error.

**F3 (runtime PR).** The runtime alias resolver must implement live-path-before-alias exactly as the design states; the schema cannot enforce it. Writers stamp every ledger, transition and topic row at write time and re-stamp on retry.

**Remote D1.** There is no `CASE … RAISE`, and the 5 recursive CTEs in 3 statements are unchanged. Two new sites join round 5's list for the scratch proof: the DESC composite index `memory_topic_aliases_resolution` (427–431) and the now-unconditional ledger bound (2893). The attended proof must pass before any production apply of `0016`. The draft kit in `reviewer-tools/remote-d1-0016/` will be updated to this SQL and reviewed before Sid gets any step.

**Next.**
1. Sid merges #39.
2. The memory chat opens the `0019` PR: the N6 events-ingress allowlist and owner-command operand binding, plus F1 and F2 (and F3 recorded for the runtime PR), for Claude max review.
3. `0016` and `0019` are then proven together on scratch remote D1 before any production apply.

Sid retains merge and migration authority. Merging applies nothing. Before any production apply, the Sid-attended scratch remote-D1 proof is still required.
