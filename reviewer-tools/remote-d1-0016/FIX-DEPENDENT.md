# Fix-dependent probes and expectations (PR #39, S1–S4)

Everything in this folder was validated locally against `8b62e80` (branch
head `c34ab17`, which only adds an AGENT_LOG entry). The items below change
once the builder lands S1–S4. Update them on the fix head before Sid runs
anything.

## Procedure on the fix head

1. In `tools/generate-probes.mjs`, set `const FIX_HEAD = true;`. That moves
   probes 80–94 into the `main` phase and switches each one to its
   `expectAfterFix`. Then run `node tools/generate-probes.mjs`.
2. Regenerate `expected/inventory-after-0015.json`, `-0016.json` and `-0017.json`
   with the commands in LOCAL-VALIDATION.md, section "Regenerating the expected
   inventories". Do not hand-edit them. S1–S4 change trigger SQL lengths, and
   S1 changes the index list.
3. Re-run the full local flow (LOCAL-VALIDATION.md, "Full flow"). It must print
   `ALL PROBES PASSED` with only `-Phase main`.
4. Re-run the clause-isolation mutants for any trigger whose line numbers
   moved. The line ranges in LOCAL-VALIDATION.md are for `8b62e80`.
5. Put the reviewed commit in RUNBOOK step 1 (`<REVIEWED_SHA>`). Also correct
   the object counts quoted in steps 5, 6 and 8 (309 / 494 / 520).

## S1: `WITHOUT ROWID` on the 17 TEXT-key tables

| Item | At `8b62e80` (validated) | After S1 |
|---|---|---|
| `80-s1-seed-unreferenced-price` | success | success (unchanged) |
| `81-s1-replace-price-explicit-rowid` | **success**: the REPLACE deletes guarded price Y4 and inserts Y5 (the hole) | fails. Expect `errregex:rowid`. Locally, a WITHOUT ROWID table gives `no such column: rowid at offset …: SQLITE_ERROR` for this subquery form, and `table … has no column named rowid` when the column list names `rowid`. |
| `82-s1-check-price-survives` | `ok = 0` (Y4 is gone) | `ok = 1` |
| `expected/inventory-after-0016.json` and `-0017.json` | 494 / 520 objects; 0016 adds 66 indexes | a WITHOUT ROWID table has no separate `sqlite_autoindex_<table>_1` for its primary key. Expect about 17 fewer indexes, and some autoindex names may renumber. Regenerate. The 17 table `sql_len` values change. |
| `32-replace-version-rowid-alias` | raises `memory_item_version_lineage_invalid` | unchanged (`memory_item_versions` keeps its INTEGER rowid alias for FTS) |
| `33-replace-item-state-copy` | raises `memory_item_state_requires_transition` | unchanged (already WITHOUT ROWID) |

Worth adding if the builder's generic sweep leaves room: one explicit-rowid
REPLACE on `memory_item_sources` (the hidden-memory consequence) and one on
`memory_cost_ledger` (the spend consequence). Neither is written yet.

## S2: named sibling-name checks for rename, move and merge

| Item | At `8b62e80` (validated) | After S2 |
|---|---|---|
| `83-s2-seed-siblings` | success | success |
| `84-s2-rename-onto-sibling-plain` | fails on the index, not a guard: `UNIQUE constraint failed` (`errregex`) | `raise:memory_topic_event_invalid` |
| `85-s2-move-onto-sibling-replace` | **success**: the REPLACE carried into the apply deletes sibling G04 | `raise:memory_topic_event_invalid` |
| `86-s2-rename-onto-sibling-replace` | **success**: deletes sibling G02 | `raise:memory_topic_event_invalid` |
| `87-s2-check-siblings-survive` | `ok = 0` (two siblings deleted) | `ok = 1` |
| Merge per reparented child | not written | Add one: merge a source whose child has the same normalized name as an active child of the target, via `INSERT OR REPLACE`. Expect `memory_topic_event_invalid`, then check both children survive. |
| `41-owner-topic-move-deep`, `42-merge-deep` | success | must stay success. All names under A45 and A60 are unique. Re-check if the new check compares display names rather than normalized names. |

## S3: transition `occurred_at` bounds and `valid_to <= now` in the owner-lock exception

| Item | At `8b62e80` (validated) | After S3 |
|---|---|---|
| `88-s3-seed-owner-locked-items` | success | success. Seed times are monotonic (00:04 then 00:05) and in the past. |
| `89-s3-rules-expire-future-dated` | **success**: rules expire owner-confirmed M2 by dating it 2026-11-01, past its valid_to of 2026-10-01 | `raise:memory_item_transition_invalid` |
| `90-s3-owner-transition-backdated` | **success**: dated 00:04:30, before the state's updated_at of 00:05 | `raise:memory_item_transition_invalid` |
| `91-s3-rules-expire-now-plus-10` | **success** | `raise:memory_item_transition_invalid`. This is a new `strftime('now')` bound, so it joins the remote-only coverage. |
| `92-s3-rules-expire-now` | raises, but only because 91 already expired M4 | success (control: valid_to is in the past and the probe is dated now) |

Watch for:
- **Seed dates.** The seeds (11, 20, 24, 88) use fixed 2026-09-14 times. If S3 adds a lower bound relative to `now`, not just "not before the state's updated_at", switch those `occurred_at` values to `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` in the generator.
- **Run date.** Probe 89 is meaningful only while M2's `valid_to` (2026-10-01) is still in the future. If the proof runs on or after 2026-10-01, move `validTo` and the 89 date later.

## S4: ledger `occurred_at <= now + 5 minutes`

| Item | At `8b62e80` (validated) | After S4 |
|---|---|---|
| `93-s4-ledger-reservation-now` | success | success (control) |
| `94-s4-ledger-reservation-future` | **success**: the reservation lands in a later month's bucket | `raise:memory_cost_entry_lineage_invalid` |

Like S3, S4 adds a `strftime('now')` bound inside a trigger WHEN clause, so
93/94 become part of the remote-only coverage.

## Should-fix items that would also change probes, if landed in the same head

- **NF8** (`added_aliases_json` bound to owner topic commands). Command C3 in
  `10-seed-owner-events-commands` has no alias field. If the guard requires
  one, add it to the C3 payload (for example `addedAliases: []`) or
  `41-owner-topic-move-deep` will fail with `memory_topic_event_invalid`.
- **NF4** (freshness baseline after a rules transition). `23` measures
  owner→owner freshness and is unaffected. If the semantics change, add a probe
  with a rules transition between two owner commands.
- **NF7** (a merge aborts when a child event is newer). The children in `42` have
  older events, so it is unaffected. If the rule changes, add a newer-child
  merge probe.
- **Any new RAISE name, new trigger, or new use of `WITH RECURSIVE` or
  `strftime('now')` in a trigger.** Update `expect` values and add one accepted
  and one rejected probe for it. The remote run exists to prove those
  constructs.
- **The `CASE … END` inside `memory_item_transitions_insert_guard`'s WHEN
  clause** (line 1457 at `8b62e80`). It is exercised by 20/22/23/24. If the fix
  moves it into a `SELECT CASE … RAISE` statement form, remote D1 will reject
  the migration. The syntax test should catch that first.
