Of the 18 prior findings, 12 are fixed (H1, H3, M1–M8, L3, L9), 6 are partly
fixed, and none are unfixed. `cloud-memory-trigger-contract.test.ts` is now an
honest name inventory plus lint, and the database behavior lives in real tests.
The fixes also opened new gaps. The reviewer read the cited trigger text for
every blocker below.

**R1 (N1, High). `UPDATE OR REPLACE` bypasses the projection guards.**
`memory_item_state_update_guard` (1454–1469) never requires
`NEW.item_id = OLD.item_id` or `NEW.principal_id = OLD.principal_id`.
`memory_item_placement_state_update_guard` (2159–2208) has the same gap for
placement, item and relation, and `memory_topics_update_guard` has it for
`topic_id`. REPLACE fires no delete trigger, and round 1 showed
`recursive_triggers` = 0 at runtime. So
`UPDATE OR REPLACE memory_item_state SET item_id='J', …` moves item I's state
onto item J. J's `superseded` or `forgotten` state row is silently deleted, a
superseded fact comes back, and both items are wedged. Fix: pin every key column
in those three update guards, and add key-changing `UPDATE OR REPLACE` tests.

**R2 (N8). `INSERT OR REPLACE` through the rowid aliases is unguarded.** The
aliases are `version_rowid`, `episode_rowid` and `chunk_rowid`. A chunk replaced
this way skips `memory_history_chunks_fts_delete`, which leaves stale hidden
tokens in FTS. Fix: add rowid-exists checks to those three insert guards.

**R3 (N5). Rules can still overwrite an owner confirmation or supersession.**
The owner lock (1335–1343) covers only `forgotten` and `rejected`. The matrix
(1327–1331) lets `rules` write `active → expired`, and
`superseded|expired → active` on a higher version, over an owner transition.
Design §9 forbids that. Fix: refuse non-owner transitions while the current
transition's actor is `owner`, allowing only a time-bounded `expired` at
`valid_to`.

**R4 (N2 and N3). The new reprocessing money checks break the legitimate
path.**
- Day-range jobs can never reserve cost. The run guard (2411–2413) requires
  non-null run sequences, but the ledger guard (2552–2553) requires them to
  equal the job's NULL sequences.
- Once a job is cancelled or finished, its open reservation can never be
  settled or released, because 2550 gates every entry type on
  `pending|running`. Real spend then goes unrecorded.

Fix both, and add day-range and cancel-then-settle tests.

**R5 (H5, partly fixed). Partial episode sources.** An episode that declares
only some of its sources stays retrievable after an undeclared turn inside its
range is hidden. For example, it declares E10 and E20 for range 10–20, and E15
is then hidden. Fix: also anti-join the episode's range against active
suppressions, as the history-chunk view does.

**Should-fix (full SQL in the report).**
- N4: the depth-64 cycle check fails open on trees deeper than 64. Walk the new
  parent's ancestors, or cap depth when a topic is created.
- N6: owner commands bind the operation and target, but not the operands
  (lifecycle state or version, merge target, destination topic, suppression
  range). Nothing restricts who may insert a `memory.owner_command` event.
  Bind the operands now. Add an `events` source/type allowlist in a separate
  reviewed migration.
- N7: a far-future `occurred_at` on a topic event wedges that topic.
- L4: `memory_runs.started_at` can still be backdated.
- L6: range suppression counts are unchecked.
- N9 and N10: two design questions to settle before the runtime PR. First-person
  items sourced only from archived turns can never activate. True provider
  overruns cannot be recorded.

Remote D1: there is still no `CASE … RAISE` and no window function. The two
recursive CTEs remain unproven on remote D1.
