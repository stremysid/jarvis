# Home-node fact projection

The home node publishes its eligible active-fact view as a signed, versioned
snapshot. Cloud retrieval continues to use the previously published version
until every page of its replacement has been validated and the commit is
accepted. Publishing an empty snapshot retracts the device's earlier facts.

The foreground node retries an owed immutable snapshot after event sync and
before new distillation work. It captures and publishes the current active-fact
snapshot only after promotion finishes. A stop between requests leaves the
pending snapshot durable for the next node process.

## Rollout order

**Before deploying either component or applying migration 0014**, inspect the
immediate parent of every SQLite store this host uses, as the service account.
Existing parents must be owned by that account and private (mode **0700**).
The new node refuses a permissive existing parent instead of changing it. A
host still using a 0755 or 0750 parent will fail startup after this upgrade.

Load the deployed environment and inventory all four store types: archive,
memory, vault and vector index. `jarvis node` currently opens the first two;
`jarvis vault` uses `JARVIS_ARCHIVE_PATH` too. `VaultRepository.open(path)` and
`VectorIndex.open(path, provider)` can also receive explicit paths from other
callers. There is no vector-index environment setting in this node yet. Inspect
any deployed caller or wrapper for those paths; do not infer a default filename.
If a store type is unused on this host, record that instead of inventing a path.

Run this in Bash as the service account, adding any separately configured vault
and vector-index store files to `store_paths` before the loop:

```bash
: "${JARVIS_ARCHIVE_PATH:?load the node environment first}"
: "${JARVIS_MEMORY_PATH:?load the node environment first}"
store_paths=("$JARVIS_ARCHIVE_PATH" "$JARVIS_MEMORY_PATH")
# For each additional configured store, add its actual absolute path:
# store_paths+=("/actual/path/to/vault-store.sqlite3")
# store_paths+=("/actual/path/to/vector-index.sqlite3")
preflight_failed=0
for store_file in "${store_paths[@]}"; do
  store_parent=$(dirname -- "$store_file")
  stat -L -c 'mode=%a owner_uid=%u directory=%n' -- "$store_parent"
  test "$(stat -L -c '%a:%u' -- "$store_parent")" = "700:$(id -u)" || {
    printf 'STOP: fix ownership/permissions of %s before deployment\n' "$store_parent"
    preflight_failed=1
  }
done
test "$preflight_failed" -eq 0
```

For an existing directory that should be private, the manual repair is
`chmod 0700 -- '/actual/store/parent'`; then repeat the complete check above.
Do not chmod a home directory or shared directory blindly. Move the store into
a dedicated directory owned by the service account and update its configured
path if the current parent must remain shared. Do not proceed to migration or
deployment until every configured parent passes. This preflight is required
even for systemd: `UMask=0077` does not repair an existing directory's mode.

Apply cloud migration `0014_memory_projection.sql` and deploy the updated
gateway before starting a node version that uploads fact projections. These
are owner operations. Do not start the updated node against an older gateway:
the local pending snapshot is durable and will keep retrying until it receives
an exact page and commit receipt.

Each projection belongs to one principal and enrolled device. Replacing a home
node does not transfer that ownership. Publish from the replacement device,
then revoke the retired device so its older projection immediately stops
appearing in context. Do not edit projection rows or cursor versions by hand.

The database requires a matching immutable commit receipt before a version
becomes published or its head advances. Receipt insertion and publication are
one statement, so failed publication rolls back both. Published pages and facts
reject direct edits, additions, deletion and replacement. Once a newer commit
advances the head, deleting the superseded version cascades through its pages,
facts and FTS entries. Expired or rotated-key staged versions can still be
discarded and uploaded again.

## Bounds and retry behavior

A snapshot is limited to 1,024 active facts in at most 32 pages. Each page is
at most 65,536 canonical UTF-8 bytes and 32 facts, with at most eight sources
per fact and 32 distinct source sequences per page. Fact text is limited to
4,096 UTF-8 bytes. Fact text rejects C0/C1 controls (including tabs and newlines)
and Unicode line/paragraph separators in both producers, upload validation and
the D1 constraint. Projection provenance excerpts and conversation history may
remain multiline.
Both distillation producers enforce the byte/source limits
and reject text requiring redaction before recording a proposal. Python and the
gateway run the same redaction vectors, including all ECMAScript whitespace
characters, while retaining ASCII word boundaries. They do not
truncate or rewrite claims. Aggregate snapshot/page bounds still fail the
snapshot explicitly.

Distillation inputs have a stricter framing rule: every excerpt has a lowercase
ULID source id and control-free text. The gateway validates this before rendering
the model prompt, including direct calls to the distiller. The node skips archive
excerpts that fail either rule, leaving the archived event intact. Skipped events
do not consume the 32-excerpt limit. Progress advances past an ineligible-only
batch without calling the model; a batch with eligible excerpts advances only
after its proposals are durable. Multiline archive entries remain available for
history and provenance but are not submitted for automatic distillation.

An existing active fact that cannot be represented is excluded individually
and recorded in local `memory_projection_quarantine`; other facts continue to
publish. Its local text, provenance and active state are retained. Local memory
migration `0004_projection_quarantine.sql` adds this record and the durable
pending-rejection marker. Completed projection cycles report the active count
as `quarantined=32` in the cycle status line, including later cycles while
those active facts remain excluded. A cycle that published everything eligible
remains `ok` and returns to the normal cadence; quarantine is durable owner-
action state, not a retryable network failure. Other stage failures retain
their own failure status.

Superseding a quarantined fact removes it from the active count on the next
completed projection cycle. Its quarantine record remains for inspection; the
record alone does not keep the cycle in a failed state.

The node persists the complete page set before the first request. A stopped or
restarted upload resends every immutable page with fresh signed-request nonces,
then retries the commit. Duplicate receipts are safe only when their version,
manifest, page coordinate, and page hash match exactly. A malformed receipt or
transient upload failure leaves the local pending snapshot unchanged. A generic
HTTP 400 is also retryable: the older route can use that status for internal
database/archive failures. Only the exact authenticated content-rejection
response starts abandonment.

On explicit content rejection, the node records which pending page was refused,
then signs an `abandon` request for the exact manifest, version and counts. The
gateway atomically records an immutable abandonment receipt and removes only
that matching staged version. This also prevents delayed old requests from
restaging the abandoned manifest, including after key rotation. Existing
published memory remains available. If publication already won the race, the
gateway returns the exact published receipt and the node reconciles its cursor.

Only an exact abandonment receipt clears the pending snapshot without advancing
the cursor. The rejected page's facts are quarantined locally, and the next
capture can publish the remaining facts at the same version. The rejection
response does not identify which fact caused the failure, so every fact on that page
is quarantined. Per-fact retry isolation is not implemented. The count in status
makes the size of this exclusion visible; inspect the metadata below to identify
which facts need review.
An interrupted recovery retries abandonment after restart, not the old pages.
Status reports `projection: permanent rejection; recovery pending` until the
recovery receipt arrives. Authentication failures still stop the service.

Inspect quarantine metadata on the node without copying fact text into logs:

```sql
SELECT q.fact_id, q.reason, q.created_at, f.state
FROM memory_projection_quarantine q JOIN fact f ON f.fact_id = q.fact_id
WHERE q.principal_id = '<owner-principal>' AND q.device_id = '<home-device>';
```

Review the rejected page locally. Correcting a claim creates a new fact identity
and can be projected normally; superseding an excluded fact clears its active
warning. To retry an unchanged fact after fixing its source or the gateway,
first allow a healthy or empty replacement snapshot to commit, then run:

```console
jarvis retry-quarantined fact_<32-lowercase-hex-characters>
```

The owner-only control channel removes only that exact fact's quarantine row,
scoped to gateway origin, principal and device, and requests a new cycle. An
unknown or malformed fact id is refused. Do not alter pending pages, publication
cursors or cloud abandonment receipts. Retrying an unchanged poison will
quarantine it again. An abandoned manifest cannot be reused at its old version;
the committed replacement is what makes the next version available.

The command queues the delete for the node's cycle thread. An `ok` response
means that scoped row is gone and a new cycle was requested. If the cycle thread
is busy, the command answers `queued` within a bounded wait, with CLI exit code
0 and the explicit message **not yet applied**. This is acceptance, not proof of
a delete or a cloud publication. `jarvis status` stays available during a cloud
call and shows `projection_retry <fact_id> <outcome>`: every pending `queued`
retry plus the latest 20 completed results (`applied`, `not_quarantined`,
`failed`, or `cancelled`), each with a distinct `request_id`. Local migration
`0005_projection_retries.sql` adds the durable command journal in the memory
store. Acceptance is committed before `queued` is returned; the scoped delete
and its outcome commit together. Startup reloads pending and recent results.
After an abrupt exit, complete the stale-endpoint recovery sequence below
before restarting; then the node resumes work left queued. History keeps all pending
requests and the latest 20 completed receipts for each gateway/principal/device.
Pruning runs when that owner completes a request. Status and processing cover
only the configured owner tuple; records for retired device or gateway identities
remain untouched. This is a per-owner retention bound, not a global database-size
bound across re-enrollments. Take a backup and review retained identities locally
before any owner-directed archival or cleanup; the current node never deletes
another identity's retry history automatically.
Failures contain no database or fact text. Status serves a memory copy of those
durable records, so it never needs to wait on a database read.

Each gateway/principal/device may have up to 256 pending requests. At that
limit, a new fact returns `retry_queue_full` and is not accepted; retrying an
already-pending fact keeps its existing request ID. Admission is atomic in
SQLite. This limit keeps all accepted pending requests and recent results
within the control client's response bound, including after a restart; status
does not silently omit pending requests. Wait for a pending request to finish
before submitting another new fact.

A refused retry wakes only local command processing, preserving the existing
cadence/backoff deadline without a cloud or paid distillation cycle. Only a
successful delete requests a cycle. Pending retries are cancelled when the
node stops, leaving their quarantine rows intact. A delete completed before
stop may still need the next node start to publish its replacement snapshot.
The short enqueue connection uses a 100 ms SQLite lock timeout. If the journal
cannot accept the command, the CLI returns `retry_failed`, not `queued` or
service unavailable. That unaccepted request does not set a persistent storage
banner, including after a transient lock race. If an outcome cannot be saved for
already accepted work, status reports
`projection_retry_storage unavailable; queued requests remain durable` and the
row remains queued for recovery after storage is repaired. The timeout bounds
lock contention and the completion wait; a stalled filesystem can still delay
the synchronous durable enqueue. This is not a hard deadline on disk I/O.

### Recover after an abrupt exit

SIGKILL or power loss may leave the control socket inode behind. Startup refuses
every existing endpoint and does not probe-and-unlink it automatically. An abrupt
exit therefore preserves the journal but may require this endpoint step before
the process can restart:

1. Stop automatic restarts with `sudo systemctl stop jarvis-node`. Check
   `systemctl show jarvis-node -p ActiveState -p SubState -p MainPID` and
   `pgrep -af '[j]arvis.*node'`; stop any manually launched node using this
   endpoint too. Inspect `ss -xlpn` for listeners. Do not remove a live endpoint.
2. Use the **exact endpoint printed by the startup error**. It includes any
   `--socket-path` override; do not guess a default or use a wildcard. As the
   service account, inspect that path and remove it only after confirming it is
   an owner-held stale socket, not a symlink or a regular file. For example,
   replacing the assignment with that exact path:

   ```bash
   socket_path='/exact/endpoint/from/the/startup/error'
   test ! -L "$socket_path" && test -S "$socket_path" &&
     test "$(stat -c '%u' -- "$socket_path")" = "$(id -u)" &&
     rm -- "$socket_path"
   ```

3. Leave the SQLite files and queued retry rows intact. Complete the store-parent
   preflight above, then `sudo systemctl start jarvis-node` (or relaunch the same
   manual command). Run `jarvis status` with the same socket configuration to
   observe restored request IDs and their eventual outcomes. If startup fails
   for another reason, diagnose that error instead of deleting more files.

If the installed node predates this
thread-safe command or the control channel is unavailable, keep this stopped-node
fallback: stop `jarvis-node`, take the normal memory-store backup, and delete only
the exact four-column owner tuple with SQLite before restarting the service:

```sql
BEGIN IMMEDIATE;
DELETE FROM memory_projection_quarantine
WHERE gateway_origin = '<exact-gateway-origin>'
  AND principal_id = '<exact-owner-principal>'
  AND device_id = '<exact-enrolled-device>'
  AND fact_id = 'fact_<32-lowercase-hex-characters>';
SELECT changes();
COMMIT;
```

Require `changes()` to return exactly `1`. Leave the node stopped and restore the
backup if it does not; do not broaden the predicate. Restart the node and request
one cycle only after the scoped delete succeeds.

On POSIX direct/manual runs, SQLite database, WAL and SHM files are created
owner-only (0600). New immediate store directories are created as 0700.
Existing directories are validated, never chmodded: see the required preflight
before rollout above. Existing owner-held store files with broader mode bits are
tightened before SQLite opens them, and symbolic-link store files or foreign/non-regular
files are refused. A symlinked directory is permitted, but the final archive and
memory files must not themselves be symlinks. Before the first upgraded live-node
start, load the configured environment and verify both with:

```console
test ! -L "$JARVIS_ARCHIVE_PATH" && test ! -L "$JARVIS_MEMORY_PATH"
```

The systemd unit's `UMask=0077` and state-directory mode remain the outer
deployment boundary.

A `device_key_changed` response means the enrolled key changed between the
gateway's verification read and nonce write, so it is returned as retryable 409.
If the next request sees the same key it can succeed; if rotation completed, the
next signature check gives the durable authentication result. By contrast,
`device_key_invalid` means the gateway's stored enrolled key is malformed or its
fingerprint does not match. Retrying the same bytes cannot repair that data, so
401 deliberately stops the node until the enrollment record is repaired.

## Retrieval behavior

Cloud context reads only the published head of an active principal and active
device. Staged, older, foreign, disabled, and revoked projections are excluded.
Fact text and provenance are checked again against their stored canonical JSON,
content hash, primary source ULID, and redaction rules before model use. Normal
facts become `personal` context and sensitive facts become `restricted`; a
duplicate from another active device cannot lower the sensitivity.

Full-text search treats at most 16 bounded words from the current request as
literals. Matching facts and recent conversation history share the existing
32,000-byte and 64-item context limits, with at most 32 fact items. Half of the
byte budget is initially left available for recent history. History is a
contiguous suffix of eligible turns: selection stops at the first newest-to-oldest
turn that does not fit, rather than joining turns across a missing middle turn.
Deferred matching facts can use the remaining space after that boundary. Facts
are independent candidates, so an oversized fact can be skipped for a later fact
that fits. Retrieval needs only D1 after a
projection is published, so archived source events may remain in R2 while the
home node is offline.

The provider quotes each context entry as a JSON string and escapes controls
and Unicode line separators. This applies to facts and legitimate multiline
history: each item occupies one rendered line and ends with its verified source
event id. Quoting preserves the original content as reference data; it is not a
claim that a model can never follow an instruction found in that data.

## Owner acceptance

After migration `0014_memory_projection.sql`, the updated gateway, and the
node-composition patch are deployed, publish a harmless test fact sourced from
a real archived event and allow one node cycle to complete. Record the UTC
time and the published head metadata without copying fact text into the
operator record:

```sql
SELECT principal_id, device_id, published_version, manifest_hash, published_at
FROM memory_fact_projection_heads
WHERE principal_id = '<owner-principal>' AND device_id = '<home-device>';
```

Stop the node and query a literal term from the harmless fact. Confirm that the
fact is available while the node is offline and that its `sourceEventId` is the
real primary archived event ULID. Restart the node, change only the fact's
sensitivity, and confirm that a newer head is published and retrieval marks it
`restricted`. Finally, supersede the fact or publish the appropriate empty or
replacement snapshot, confirm that the head advances, and confirm that the old
fact no longer appears.

These steps are live owner acceptance. Unit tests and CI do not establish that
the production migration, gateway, home node, or archived-source path worked.
