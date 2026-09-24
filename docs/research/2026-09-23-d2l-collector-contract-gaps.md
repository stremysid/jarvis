# Collector / receiver contract findings

Receiver inspected: PR #169, `codex/d2l-ingest-run` at
`5abba944d76c92616b65255b6823435d44780d47`. These findings come from its source,
not a live gateway or a D2L request. The collector task adds Durham, news and
quizzes after the receiver's initial design. Do not load this collector until
the gateway origin is pinned and the following wire incompatibilities are resolved.

| Finding | Source on #169 | Consequence / required receiver decision |
|---|---|---|
| Only `ldsb.elearningontario.ca` is accepted | `collector-protocol.ts`, `SCHOOL_HOST` / `parseSchoolBatch` | Durham cannot be relabeled as LDSB. Accept and persist both literal hosts. |
| Only myItems, toc, folders, submissions and grades routes are accepted | `collector-protocol.ts`, route regex | News and quizzes make even an LDSB batch invalid. Extend the allowlist and define their projection. The collector retains these observations; it does not silently drop requested tools. |
| myItems is mapped as an array | `collector-mapping.ts` | The real probe observed `{Objects:[...],Next:null}`. Support that envelope before projecting the new batches. |
| Course source IDs omit host | `collector-repository.ts`, `d2l-api:${course.id}` | Equal course IDs on different boards can collide. Namespace sources by the actual host. The collector uses a separate read ID for each host but cannot fix receiver projection identity. |
| A batch requires a nonempty course manifest | `collector-protocol.ts` | A first-run session failure before any courses are known has no valid envelope. The collector reports it locally; cached known courses can receive explicit failure batches. A host-level failure contract is needed to push the first case without inventing a course. An oversized enrollment manifest has the same gap. |
| Any refused tool makes the course projection fail | `collector-mapping.ts` | Per-tool 403/404 is normal on this account. The collector continues other reads and preserves each status. Receiver must decide how to retain usable partial evidence without claiming whole-course completeness. |
| Body, depth and structural limits all apply | `signed-request.ts` | Below 64 KiB alone is insufficient: at most 32 container levels and 4,096 structural items. Oversized courses become compact failure batches. Chunking or lossy success was not invented. |

The gateway's literal HTTPS origin was not found in checked-in public config or
docs. `PUBLIC_ORIGIN` is a secret-config name, not its value. The only real Worker
origin found belongs to the watchdog. It was not used to guess the gateway, and
no secret was read. The manifest readiness test deliberately fails until the
actual origin is supplied and pinned in source, CSP, permissions and its test.

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
The batch envelope and route evidence field names match #169; incompatible
host/route values above remain explicit blockers.

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
