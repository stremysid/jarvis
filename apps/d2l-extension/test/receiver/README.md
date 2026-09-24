# Receiver contract snapshots

The two `.ts.txt` files are verbatim LF-normalized source from
`stremysid/jarvis` PR #169 at `dfc284e6780b243f1b010e5434fa7f8e450a6b26`:

- `apps/cloud-gateway/src/school/collector-protocol.ts`
- `apps/cloud-gateway/src/school/collector-mapping.ts`

They are test-only, never loaded by the extension. The Node contract test strips
TypeScript and executes the actual functions with a mocked database adapter.
The shared signing, canonical JSON and deadline text/time helpers are read from
the repository, with no package install, network, migration or database operation.
At this snapshot the shared signing file differs only by three exports; the other
two helper files are identical to #169. No fixture contains an account value or
fixed private key. All keys and signed requests are synthetic and created at test time.

When the receiver contract changes, review and refresh these snapshots deliberately,
then update the extension's upload compatibility check and the documented findings.
Do not change a rejection assertion to acceptance without the corresponding receiver change.
