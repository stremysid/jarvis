# Home-node fact projection

The home node publishes its complete active-fact view as a signed, versioned
snapshot. Cloud retrieval continues to use the previously published version
until every page of its replacement has been validated and the commit is
accepted. Publishing an empty snapshot retracts the device's earlier facts.

This draft contains the cloud endpoint, cloud retrieval, and local uploader
library. The foreground node does not call the uploader until PR 13 is merged
and the node-composition patch lands. Do not treat the uploader library's
presence as running publication.

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

## Bounds and retry behavior

A snapshot is limited to 1,024 active facts in at most 32 pages. Each page is
at most 65,536 canonical UTF-8 bytes and 32 facts, with at most eight sources
per fact and 32 distinct source sequences per page. Exceeding a bound refuses
the whole local snapshot; it does not silently omit facts.

The node persists the complete page set before the first request. A stopped or
restarted upload resends every immutable page with fresh signed-request nonces,
then retries the commit. Duplicate receipts are safe only when their version,
manifest, page coordinate, and page hash match exactly. A malformed receipt or
upload failure leaves the local pending snapshot unchanged.

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
byte budget is initially left available for recent history, and unused space is
then reclaimed by the next matching facts. Retrieval needs only D1 after a
projection is published, so archived source events may remain in R2 while the
home node is offline.

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
