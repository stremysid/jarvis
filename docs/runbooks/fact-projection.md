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

On POSIX direct/manual runs, the archive and memory SQLite database, WAL and SHM
files are created owner-only. Existing owner-held store files with broader mode
bits are tightened before SQLite opens them, and symbolic links or foreign/non-
regular files are refused. The systemd unit's `UMask=0077` and state-directory
mode remain the outer deployment boundary.

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
