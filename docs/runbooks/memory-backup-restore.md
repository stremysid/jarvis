# Restore the nightly memory backup

This runbook restores the latest verified R2 backup into a new D1 database.
It is a disaster recovery procedure. Keep application traffic stopped until
the final checks pass and the owner approves promotion of the new database.

The implementation is
`apps/cloud-gateway/src/backup/memory-backup-restore.ts`. Use
`readLatestVerifiedMemoryBackup` to resolve `memory-backup/latest.json`, verify
the manifest hash and every data object, and then use
`restoreVerifiedMemoryBackupRows` for the database rebuild. Do not replay the
NDJSON objects with ad hoc `INSERT` commands. Production insert guards reject
old and completed rows, and insert triggers can create duplicate projections.

## Consistency boundary

A backup set is not one exact point in time. The service records each table's
upper key and expected row count when the run starts, then reads mutable rows
when their page is exported. A row deleted after the cut is absent from the set;
the manifest records that absence as `shortfallRowCount`. A mutable row can
contain a value written after the cut. Restore rebuilds cursors and archive marks
from the rows that are actually present instead of trusting exported marks.

Only the most recent 48 hours of `scheduled_runs` are included. The following
short lived or backup control tables are intentionally absent:

- `identity_challenges`, `sync_snapshots`, `request_nonces`, and
  `authentication_attempt_reservations`
- `memory_backup_runs`, `memory_backup_row_ordinals`,
  `memory_backup_table_cuts`, `memory_backup_objects`, and
  `memory_backup_alerts`

The set also omits projections that the restore code rebuilds: item and
placement state, history chunks and coverage, vector receipts, memory cursors,
and the four FTS indexes. Component liveness and notice drain leases start from
their migrated initial state. The historical device fact projection must be
republished through its signed source procedure if it is still in use; its D1
staging and publication cache is not an authoritative cloud memory source.

The R2 set never contains Worker secrets. The replacement deployment must use
the same approved peppers and provider secrets through the normal secret
recovery process.

## Preconditions

1. Record the `latest.json` object version and preserve the complete named set.
2. Create a new, empty D1 database. Do not point a Worker or cron at it.
3. Apply the repository's migrations in order through the manifest's
   `databaseSchemaVersion`. Migration `0031_memory_backup.sql` is still
   unapplied at the time this runbook was written; applying any migration is a
   separate owner authorized production action.
4. Prepare the existing literal history rebuild job and the deployed Vectorize
   writer. Both callbacks must run to completion. The restore API fails closed
   if either callback rejects. The current repository does not contain a
   Vectorize writer, so a production restore cannot be promoted until the
   deployed writer or its reviewed replacement is available and proves that
   Vectorize agrees with the rebuilt `memory_vectors` ledger.

## Restore

Run the following sequence from a controlled operator program with the target
D1 and backup R2 bindings. Keep the migration SQL in filename order.

1. Call `readLatestVerifiedMemoryBackup(BACKUP)`. Stop if the pointer, manifest,
   manifest hash, object hash, object byte count, row count, table
   classification, or recorded shortfall is invalid.
2. Confirm that the target's newest `d1_migrations.name` exactly equals
   `set.manifest.databaseSchemaVersion`.
3. Call `restoreVerifiedMemoryBackupRows` with:
   - the fresh target D1 binding;
   - the manifest schema version and `set.rowsByTable`;
   - every migration file as raw SQL in filename order;
   - the existing literal history and vector rebuild jobs;
   - the manifest shortfalls keyed by table.

The restore function then performs the guarded sequence:

1. It derives the final trigger definitions from the ordered migration SQL and
   drops every trigger in the fresh target.
2. It enables deferred foreign keys and inserts the authoritative rows in
   dependency order. Rows seeded by migrations must match exactly.
3. It checks foreign keys and recreates the full final trigger set from the
   migration SQL.
4. It derives `archive_state.sealed_through` only from contiguous verified
   manifests, segments, and segment event receipts. An exported open circuit is
   restored as open.
5. It rebuilds `memory_item_state` from the latest transition and
   `memory_item_placement_state` from the latest placement and later topic merge
   events.
6. It runs the literal history and vector rebuild jobs, then issues the FTS5
   `rebuild` command for `memory_fact_projection_fts`, `memory_item_fts`,
   `memory_episode_fts`, and `memory_history_fts`.
7. It recreates each `memory_cursors` position from authoritative receipts:
   distillation receipts, episodes, item and episode sources, history coverage,
   vector ledger rows, and archive manifests. This prevents a restored system
   from paying to distill events that already have receipts.
8. It checks every authoritative table count and runs
   `PRAGMA foreign_key_check` again.

If insertion fails after triggers are dropped, the implementation recreates
the trigger set before returning the error. Discard the failed target and begin
again with a fresh D1 database; do not continue from a partly investigated
target.

## Validation before promotion

Save the restore report and the manifest beside the recovery record, without
copying private row contents. Check:

```sql
SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1;
PRAGMA foreign_key_check;
SELECT type, count(*) FROM sqlite_schema
WHERE type IN ('table', 'trigger') GROUP BY type ORDER BY type;
SELECT cursor_name, current_event_sequence FROM memory_cursors
ORDER BY principal_id, cursor_name;
SELECT singleton, sealed_through, circuit_state FROM archive_state;
```

For each manifest table, compare the target count with `exportedRowCount`, not
`expectedRowCount`. Review every nonzero `shortfallRowCount`. Compare sampled
row hashes for events, completed memory runs, costs, topic events, passphrase
verifiers, guest notices, search jobs, reprocess jobs, and school evidence.
Verify the rebuilt item and placement state, history coverage, Vectorize lookup,
and literal retrieval through the application interfaces.

Promotion, Worker deployment, secret changes, and migration application remain
separate owner authorized actions.
