# Collector / receiver contract findings

Receiver inspected: PR #169, `codex/d2l-ingest-run` at
`dfc284e6780b243f1b010e5434fa7f8e450a6b26`, the authority Sid specified for this
round. Its fix round changes refusal mapping but not the upload contract.
The gateway is now pinned to the exact origin Sid supplied:
`https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev`.
Sid verified GET /health returned 200 at 23:31 EDT on 2026-09-23; the builder did
not repeat that live request. A healthy endpoint does not establish school-route
deployment or acceptance.

**Ready for code review after local gates, not for complete two-board rollout.**
The extension now holds batches with unsupported hosts/routes in its durable queue,
unchanged, and surfaces `receiver-contract-host-unsupported`,
`receiver-contract-route-unsupported` and `receiver-contract-incompatible`.
It never sends a known invalid batch or silently removes news/quizzes. This means
all current full course batches are held because they include news/quizzes; Durham
also requires a host allowlist change. The reviewer must relay the receiver items
below to #169 before claiming working school ingestion.

| Finding | Source on #169 | Consequence / required receiver decision |
|---|---|---|
| Only `ldsb.elearningontario.ca` is accepted | `collector-protocol.ts`, `SCHOOL_HOST` / `parseSchoolBatch` | Durham cannot be relabeled as LDSB. Accept and persist both literal hosts. |
| Only myItems, toc, folders, submissions and grades routes are accepted | `collector-protocol.ts`, route regex | News and quizzes make even an LDSB batch invalid. Extend the allowlist and define their projection. The collector retains these observations; it does not silently drop requested tools. |
| myItems is mapped as an array | `collector-mapping.ts` | The real probe observed `{Objects:[...],Next:null}`. Support that envelope before projecting the new batches. |
| Successful student submissions must be an object | `collector-mapping.ts`, `record(submission.body)` | The real probe observed `200 []`. The receiver rejects this even though it carries no positive submission status. Accept the observed empty array as unknown evidence; the extension must not rewrite it into a guessed object or unsubmitted status. |
| Course source IDs omit host | `collector-repository.ts`, `d2l-api:${course.id}` | Equal course IDs on different boards can collide. Namespace sources by the actual host. The collector uses a separate read ID for each host but cannot fix receiver projection identity. |
| A batch requires a nonempty course manifest | `collector-protocol.ts` | A first-run session failure before any courses are known has no valid envelope. The collector reports it locally; cached known courses can receive explicit failure batches. A host-level failure contract is needed to push the first case without inventing a course. An oversized enrollment manifest has the same gap. |
| A 404 still fails a course | `collector-mapping.ts`, statuses other than 200/403 | A missing optional tool can be normal on this account. The extension records the actual 404 and continues other tools; whether complete 404 evidence can be accepted needs a receiver decision. Complete 403s are now accepted by both sides. |
| Body, depth and structural limits all apply | `signed-request.ts` | Below 64 KiB alone is insufficient: at most 32 container levels and 4,096 structural items. Oversized courses become compact failure batches. Chunking or lossy success was not invented. |
| Single-use pairing proof is consumed before notification | `collector-pairing.ts`, `prove`; `school-routes.ts`, prove branch | If decision creation/notification fails after `proved_at` is set, a retry cannot repeat proof or notification. Keeping the key/code handles an ambiguous response, but cannot repair this receiver-side delivery gap. Make notification retryable for the same proved key; until then, expiry/new pairing may be required. This finding is from source inspection, not a live failure. |

## Resolved in the extension

- The source constant, host permissions and CSP pin the supplied gateway, without
  a path or wildcard subdomain. A literal independent test and mutations cover it.
- JSON 403 is now `status:403, complete:true`, with its original body retained.
  `complete` describes receipt/paging, not HTTP success. Versions and enrollments
  still require 200; refused folder listings do not overwrite the folder cache.
  Read/refusal counts remain separate. A complete 403 after Durham's one renewal
  attempt remains a refusal, never a fabricated session failure or empty list.
- HTML, redirects and malformed JSON still mean session expired. Non-JSON 403 is
  a session failure too; it cannot masquerade as a complete tool refusal.
- Unsupported host/route batches are retained and reported locally instead of
  being repeatedly sent against the known incompatible contract. Compatible
  batches use the exact existing envelope and can continue through the queue.

## Confirmed matching pieces

The implementation uses the receiver's four exact POST paths:
`/school/pairing/start`, `/school/pairing/prove`, `/school/pairing/status`,
`/school/observations`. Start sends the raw 32-byte public key as standard base64
and a device label. Prove signs the returned challenge and uses the returned
collector/principal IDs. Pairing approval remains the receiver's Telegram tap.

Signed headers use `x-jarvis-signed-request`, schema `1.0`, audience
`jarvis-school-collector`, an RFC3339 timestamp with milliseconds, a fresh
32-byte base64url nonce, lowercase SHA-256 of canonical UTF-8 bytes and an
Ed25519 signature in standard base64. The signed text has eight newline-separated
fields: POST, path, device, principal, audience, timestamp, nonce, body hash.
The batch envelope and route evidence field names match #169. Tests run its actual
parser, mapper and `verifyCollectorRequest` against extension bytes and signatures.
The parser/mapper snapshots under `test/receiver` are from the pinned head; shared
signing/canonical helpers are loaded read-only from the repository (the signing
file differs from that head only in three export keywords). The database adapter
is mocked: this is no claim about actual D1, HTTP dispatch or live pairing.
The same tests reproduce host/route rejection, both observed-shape rejections,
complete-403 acceptance and the nonempty-manifest requirement.

## Account evidence and limits

Sid supplied the shapes on 2026-09-23. The builder read the provided relay notes,
without accessing an account. Enrollments paginate; most org units are not readable
courses. Only active accessible course offerings are attempted. Sparse folder
DueDate and empty student submissions remain raw evidence. Null means no date
known, not not-due; refusal means refused, not unsubmitted. Earlier module-date
observations are not assumed to describe every current course.

Background reads in Opera GX, Durham federation, non-extractable CryptoKey
persistence in Opera GX, Telegram approval and actual gateway ingestion remain
unverified. Positive submission responses were not observed. If a tool returns
another page, its evidence is explicitly incomplete; untrusted Next URLs are
never fetched. Enrollment pagination is fully followed.

Folder lists are refreshed each sync and cached per host/course for submission
ID traversal when the next listing is refused. Old metadata is never presented
as a fresh successful read. The extension closes only fallback tabs it created.
