9 of 12 items are fixed (R1, R2, R4, R5, N4, N7, L6, N9, N10) and 3 are
partial (R3, N6, L4). N6's ingress allowlist is correctly deferred to the
separate `0019` PR. For every fixed blocker, a behavioral test fails if the fix
is reverted. The report is `reviewer-tools/pr39-reverify2.md`. The reviewer read
the cited SQL for each item below.

**S1 (NF1, High). The implicit `rowid` is the same REPLACE hole under another
column.** 17 STRICT tables have TEXT primary keys without `WITHOUT ROWID`, so
each keeps a hidden `rowid`. No insert guard checks `NEW.rowid`. As a result,
`INSERT OR REPLACE INTO <table> (rowid, …)` with an existing rowid deletes that
row without firing its immutable-delete or delete guard. The conditional update
guards on `memory_runs`, `memory_reprocess_jobs` and `memory_vectors` don't pin
`rowid` either. {{NF1}}
- **Consequences:** a hidden memory can come back (replace a source row whose
  turn is suppressed), and a settlement or overrun can vanish from the spend
  ledger.
- **Fix:** declare the 17 tables `WITHOUT ROWID`. Nothing references their
  rowid, and the three FTS content tables already use explicit aliases.
- **Test:** add one generic REPLACE sweep over every 0016 table: an explicit
  rowid, the natural key, and `UPDATE OR REPLACE` of every key column and
  `rowid`. This ends the one-column-at-a-time pattern of the last three rounds.

**S2 (NF2, Medium). A REPLACE carried into topic apply deletes a same-named
sibling.** SQLite applies the outer statement's `OR REPLACE` to the apply
UPDATE, so an `INSERT OR REPLACE INTO memory_topic_events` rename, move or
merge that collides with `memory_topics_sibling_name` (304–306) deletes the
empty sibling topic with no delete guard. Only create checks sibling names
(2154–2157). Fix: add a named sibling-name collision check to the rename, move
and merge (per reparented child) branches of the topic-event insert guard.

**S3 (NF3, Medium; R3 is still partial). Rules can future-date an expiry.** The
owner-lock exception (1381–1386) compares `valid_to` against the
caller-supplied `NEW.occurred_at`. Rules can therefore write `expired` with a
future `occurred_at`, which moves the current actor to `rules`, and then
activate a rules version over an owner-confirmed fact months early. Fix: in the
transition insert guard, reject `occurred_at` more than 5 minutes ahead of now
or earlier than the current state's `updated_at`, and require
`valid_to <= now` in the exception.

**S4 (L4, still partial). The ledger `occurred_at` is bounded only below.** A
reservation stamped next month lands in next month's bucket and escapes this
month's cap. Fix: add `occurred_at <= now + 5 minutes` to the ledger insert
guard.

**Should-fix.**
- N4 and N6: the depth-sum and unfinished-walk clauses, and most operand bindings,
  have no isolating test.
- NF4: the owner-command freshness baseline resets after a rules transition.
- NF7: a merge aborts when a child event is newer.
- NF8: `added_aliases_json` is not bound to owner topic commands.
- NF5, NF6 and NF9 are design notes to settle before the runtime PR: date-range
  reprocessing can't reach archived days; command-as-creation-event ordering;
  archived counts carry no principal or type.

**Remote D1.** There is still no `CASE … RAISE` and no window function. The
file now has 5 recursive CTE definitions in 3 statements (up from 2), plus
`strftime('now')` in trigger WHEN clauses. All of these need the Sid-attended
scratch remote-D1 proof before any production apply.
