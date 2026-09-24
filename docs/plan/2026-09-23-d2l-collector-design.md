# D2L collector: final receiving design

Approved by Sid, 2026-09-23. The Opera GX collector on PC and laptop uses the existing session to **GET Valence JSON** from `ldsb.elearningontario.ca`, LP 1.43 / LE 1.82. No password, cookie export, DOM reader or school write. The [P2 login-and-scrape reader](../briefs-p2-d2l-read.md) is **parked**.

**Separate authority.** Migration `0040_school_collector_keys.sql` creates Ed25519 collector keys (label, pending/active/revoked, timestamps), their nonces, reads, batches and immutable evidence. Reciprocal database guards prevent key reuse in `device_keys`. An active collector still fails `/sync/pull`, `/sync/ack`, `/memory/distill` and `/sync/memory/project`, including signatures with their ordinary audience. Shared signing helpers confer no authority.

**Pair and revoke.** Canonical `POST /school/pairing/start` takes `{publicKeyBase64,deviceLabel}` and returns `{collectorId,principalId,challenge,code,expiresAt}`. The configured owner cannot be chosen by the caller; four starts per ten minutes bound this public entry. The extension displays its eight-character code and signs `/school/pairing/prove` with `{challenge}`. Proof is single-use. The existing decision queue and Telegram keyboard show that code to Sid; only his matching, unexpired Confirm tap activates the immutable key. Delivery is recorded after notification succeeds. Signed `/school/pairing/status` with `{}` returns key status. The owner tool `school_collector_revoke` uses the existing tier-3 confirmation gate; revocation is terminal.

**Signed wire.** Use `x-jarvis-signed-request`, SignedRequestV1 canonical body/hash/path, audience `jarvis-school-collector`, a random 32-byte nonce and the five-minute signature window. Its `deviceId` is the collector ID. `POST /school/observations` accepts one course, at most **65,536 bytes**:

```text
{schemaVersion:"1.0", host, readId, startedAt,
 courseIds:[all courses attempted], enrollmentComplete:boolean,
 course:{id,name}, routes:[{route,status,fetchedAt,complete,body}]}
```

The immutable manifest accompanies every course, including failures. Timestamps are UTC with milliseconds; `status:0` means transport failure and `complete:false` means unfinished paging. Limits: 128 courses, 256 route results. Never truncate an oversized course into success. Identical-byte retries need a new nonce and retain the original receipt. Folders, toc, grades and each folder's submissions result are required. Optional `content/myItems/` uses `?orgUnitIdsCSV=<course>`, not a course path segment. Only allowlisted relative routes for the batch's course are accepted.

**Evidence before projection.** Persist route, course, status, fetched time, completeness, shape and raw JSON. Retain undated work. Date priority is **content/myItems → assignment DueDate → topic/module EndDateTime**, with the last labelled **availability end**. Every projected date identifies its source. Existing `DeadlineIngestion` safeguards remain; disappearance does not erase dates and older evidence cannot rewind newer deadlines. One failed course fails the whole read; missing courses leave it incomplete.

**Jarvis judges.** `school_d2l_status` exposes last good whole read, current state, refusals, collectors and paged evidence to Telegram/voice. Jarvis supplies freshness tolerance; the digest uses the existing twelve-hour convention and shows a protected gap for failed, incomplete, stale, never-read or unavailable status. It cannot say “nothing due” in those states. Empty 200 submissions, absent grades and denied `-1` counts are evidence; only positive own-submission status can mean submitted. Code never labels work missed. Signed source content remains untrusted data.

**Verification limits.** [#161](https://github.com/stremysid/jarvis/pull/161) observed folders/toc, null DueDate, denied counts, empty grades and `/submissions/`; it did not observe `/mysubmissions/`, populated grades/submissions or myItems. Their fixtures are explicitly synthetic; unfamiliar shapes fail the read. [#163](https://github.com/stremysid/jarvis/pull/163) establishes the probe's query route contract, not live transport success. Notification failure leaves a queued decision, not activation; public pairing can be rate-limit exhausted. Zero-course enrollment cannot prove an empty-school claim here. Live acceptance and authorized rollout are in [OWNER-ACTIONS](../OWNER-ACTIONS.md). No deployment or real database migration was performed. #159's earlier migration collision was corrected to 0039 at `ebd02ca1f5e6e3a0a0f881abcb0547e5bca1cd0d`.
