# Receiver contract snapshots

The two `.ts.txt` files are verbatim LF-normalized source from
`stremysid/jarvis` PR #175 at `c66c38709a9774e32546bfd7cbd7766995278a71`:

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

The Durham/news/quizzes acceptance assertions in `receiver-contract.test.js` rest on
this #175 snapshot: `SCHOOL_HOSTS` names `durham.elearningontario.ca` and the course
route regex admits `news/` and `quizzes/`. #175 is what made the extension's
client-side hold obsolete and it was deleted in the same pull request that refreshed
these files.
