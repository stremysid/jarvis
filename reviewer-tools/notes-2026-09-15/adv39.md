**Adversarial pass.** One Opus agent traced the SQL statically. The reviewer
checked each High against the trigger text. The full report, with SQL
sequences and one-line fixes, is `reviewer-tools/pr39-adversarial.md` on
`claude/reviewer-tools`.

**B2 (H1). Rules can bring back a forgotten or rejected item.** The transition
guard (about lines 1224–1233) lets any actor move an item from
`forgotten|rejected|superseded|expired` back to `proposed|active` whenever the
version number rises. `rules` is barred only from writing
`rejected|superseded|forgotten`. So a rules-written `active` transition on a
new source-less version brings a forgotten memory back into retrieval. That
breaks §9: rules and reprocessing "cannot overwrite an owner correction,
confirmation or forget transition". Fix: require `actor = 'owner'` to leave
`forgotten` or `rejected`.

**B3 (H2). `INSERT OR REPLACE` bypasses the immutability and delete guards.**
{{H2}} REPLACE deletes the conflicting row without firing DELETE triggers
while `recursive_triggers` is off. No insert guard checks that the key is
unused. That allows:
- pointing an active suppression at a different event, which un-hides the
  original with no lift row;
- rewinding `memory_item_state` to an older active transition;
- shrinking an in-flight cost reservation;
- resetting a cursor to 0.

Fix:
- add `OR EXISTS (row with NEW's key)` to every ledger and projection insert
  guard;
- give `memory_cursors` an insert guard;
- write `memory_item_state` as insert-if-absent plus a guarded UPDATE.

**B4 (H3). A lift can reuse stale owner authority.** The lift guard (about
1386–1416) never requires the correction transition to come after the
`forgotten` transition, or to be the item's current transition. A raw-history
lift may even reuse the suppression's own authorizing event. Fix:
- the correction's `transition_number` must be greater than the forgotten
  transition's, and equal to the current state's;
- the lift's authorizing event must be newer than the suppression's.

**B5 (H4). A topic update can replay an old move or merge.** The update guard
(about 1705–1749) accepts any historical event that matches `OLD.parent`, so
replaying a move creates a parent cycle. Both descendant CTEs (1519 and 1560)
use `UNION ALL`, so the next move or merge on those topics never terminates.
Fix:
- require the topic's newest event, with the apply trigger as the sole writer;
- use `UNION` with a depth bound.

**B6 (H5). Episodes with missing or partial source rows stay retrievable after
a covered turn is hidden.** `memory_retrievable_episodes` decides visibility
only from existing `memory_episode_sources` rows. Fix: store `source_count`,
require complete source rows inside the episode's sequence range, and have the
view check the count.

**B7 (M9 and M2). Money and owner authority.** Any historical owner
`conversation.user_committed` event, such as an old "hi", authorizes forget,
lift, owner topic operations and a reprocessing job with `spend_limit_micros`
up to USD 1,000. It can be reused without limit. Normal distillation runs can
also bill the `reprocessing` budget class, which escapes the USD 5 monthly pool,
and job spend limits are never enforced. The design says each reprocessing
limit is a one-time amount Sid approves. Fix:
- bind owner authority to a dedicated owner-command event that names the
  operation (and, for a job, the approved limit), newer than the target;
- tie `budget_class='reprocessing'` to `run.job='reprocessing'` and to a
  pending or running, non-dry-run job;
- enforce the sum of the job's reservations against its limit.

**Should-fix (see the report for SQL and fixes).**
- M1: a settlement can exceed its reservation and a release is unbounded, so
  net spend can go negative.
- M3: `basis` can say `third_party` or `inferred` while `origin` claims certain
  first-person, and rules can activate it.
- M4: `memory_history_chunks` has no UPDATE guard, so narrowing a chunk's range
  re-exposes hidden text.
- M5: one live coverage row can claim any range, giving a false "complete,
  nothing found".
- M6: placement state can be rewound by replaying an old refile.
- M7: a merge can record no alias, and an alias can point at an unrelated topic.
- M8: source-less versions and `/remember` creation events are immune to
  suppression.

Lows L1–L9 are in the report.

**D1 note (I1).** The recursive CTEs inside trigger WHEN clauses pass local
Miniflare, but remote D1 acceptance is unproven. Prove the migration on a
pre-created scratch remote database, Sid-attended, before applying it to
production.

**Pre-existing, outside 0016 (I2).** `events` has no UPDATE or DELETE guard, and
every 0016 suppression join trusts `events.subject_id` and `sequence`. Track it
as a separate reviewed migration.
