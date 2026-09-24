# D2L collector local evidence — 2026-09-23

## Unblock round — gateway supplied, receiver head dfc284e

The gateway readiness failure is cleared. #170 is ready for code review after
the green local gates below; [receiver findings](2026-09-23-d2l-collector-contract-gaps.md)
still block complete two-board rollout. Full batches with news/quizzes or Durham
are visibly held in the queue. No working live ingestion is claimed.

| Gate | Observed result |
|---|---|
| Final full extension suite | **42 pass / 0 fail / 0 skip**, 0 cancelled, 0 todo |
| Final full mutation sweep | **115 killed / 0 unconfirmed / 0 NOT APPLIED** |
| Each mutation | Named baseline **1/0/0**, two named fault failures **0/1/0**, byte-exact restoration **1/0/0** |
| `node scripts/check-state.mjs` | **3 carriers and FACTS pass / 0 failures / 1 advisory**, Opera background/Durham federation remain unverified |
| Runtime `node --check` | **10 pass / 0 fail** |
| Runbook PowerShell parsing | **2 blocks / 0 parse errors / 0 executed** |

Tests execute #169's actual `parseSchoolBatch`, `mapSchoolCourse` and
`verifyCollectorRequest` against extension bytes and synthetic Ed25519 signatures.
The receiver source snapshots are pinned to
`dfc284e6780b243f1b010e5434fa7f8e450a6b26`; shared helpers are identical except
three exports in the signing helper. SQL and browser/network APIs are mocked.
These tests establish complete-403 acceptance and reproduce the receiver's host,
route, observed myItems/submission-shape and empty-manifest rejections. They do
not exercise HTTP dispatch, real D1, Telegram, Opera GX or actual gateway ingest.

Observed iterations, including failures:

- Related tests: **7/0/0**. The receiver test initially failed to load a helper
  because its relative path escaped the repository (**0/1/0**); corrected path,
  receiver file **2/0/0**.
- Focused mutations: **15 killed / 0 unconfirmed / 0 NOT APPLIED**.
- First full mutation run: **114 killed / 1 unconfirmed / 0 NOT APPLIED**, out of
  115. The new queue compatibility error masked the popup-body mutation. A
  successful-delivery assertion made that path reachable: focused rerun **1 killed**,
  then the full sweep **115 killed**. The complete runner output records each
  named baseline, two failures and restoration; every row matched source exactly.
- First full suite: **41/1/0** out of 42. The second-course queue fixture still
  contained first-course routes and was correctly blocked by the compatibility
  gate. Corrected the fixture's routes; named test **1/0/0**; final full suite
  **42/0/0**. Runtime source did not change after the passing mutation sweep.

The mutation specification in `apps/d2l-extension/test/mutations.js` names all
115 witnesses. New cases cover the literal gateway, manifest host and minimal
permissions, version/enrollment HTTP success, refused-folder caching and shape,
normal 403/Durham refusal evidence, receiver host/route checks, holding incompatible
batches with visible errors, and acceptance by the real signature verifier.
No failed gate is described as flaky or skipped. The original draft results below
are historical and are retained rather than rewritten.

## Original draft checkpoint — before the gateway was supplied

**Historical blocked draft.** The full suite had one known failure because
the gateway's literal origin has not been supplied. Receiver #169 also rejects
required host/routes; see [contract findings](2026-09-23-d2l-collector-contract-gaps.md).

| Gate | Observed result |
|---|---|
| Full extension suite, run once at final checkpoint | 37 tests: **36 pass / 1 fail / 0 skip**, 0 cancelled, 0 todo |
| Full named mutation sweep after fixes | **101 killed / 0 unconfirmed / 0 NOT APPLIED** |
| Each final mutation | Baseline **1/0/0**, two faulted runs **0/1/0**, byte-exact restored **1/0/0** |
| `node scripts/check-state.mjs` | **3 carriers pass**, no failures; advisory says background/federation fact remains unconfirmed |
| Runbook PowerShell parsing | **2 blocks, 0 parse errors, 0 blocks executed** |
| Runtime `node --check` | **10 pass / 0 fail** |

The failing test is **It grants only the two literal D2L hosts, the pinned
gateway, alarms, and storage.** Its actual value is the deliberately empty gateway
constant. This is a missing required input, not an unrelated flaky test. It was
not removed or skipped to make the suite green.

Focused iterations initially observed collector/session 16/0/0, protocol 9/0/0,
and wiring 7/1/0. The first mutation sweep was 88 killed and 6 unconfirmed out
of 94; route/MIME/redirect/pairing tests accepted later generic errors and masked
the removed guard. Specific error and no-send assertions killed all six on
recheck. Additional pairing, pagination and tab-failure tests/mutations were
added before the final full sweep above. No lost-match mutation was called killed.

Tests use mocked fetch and extension APIs. Signature tests generate synthetic
non-extractable keys and use Node's independent Ed25519 verifier against the
exact eight-line signature text from #169 at
`5abba944d76c92616b65255b6823435d44780d47`. The receiver has no fixed public test
vectors in the inspected school fixture; it generates keys. This is wire-layout
and cryptographic interoperability evidence, **not** a live or D1 receiver test.

No actual D2L request, browser installation, account session, key persistence
in Opera GX, Telegram approval or gateway push was tested. No unrelated package
suite, production operation or permissions code was run.

Commands (PowerShell 7, from `C:\w\d2l-collector`):

```powershell
node --test apps/d2l-extension/test/*.test.js
node apps/d2l-extension/test/mutate.js
node scripts/check-state.mjs
```

Full sanitized outputs are retained beside the continuity ledger, outside the
repository: `d2l-collector-suite.txt`, `d2l-collector-mutations-final.jsonl`.

## Final mutation witnesses

Every row below has the same observed 1/0/0 → 0/1/0 → 0/1/0 → 1/0/0 sequence.

| Fault | Named test |
|---|---|
| Literal LDSB host | It pins both literal D2L origins and every generated route to their allowlist. |
| Literal Durham host | It pins both literal D2L origins and every generated route to their allowlist. |
| D2L host allowlist | It pins both literal D2L origins and every generated route to their allowlist. |
| D2L route allowlist | It pins both literal D2L origins and every generated route to their allowlist. |
| D2L identifiers | It pins both literal D2L origins and every generated route to their allowlist. |
| Student submissions route | It pins both literal D2L origins and every generated route to their allowlist. |
| Required org-unit CSV | It pins both literal D2L origins and every generated route to their allowlist. |
| Enrollment bookmark query | It pins both literal D2L origins and every generated route to their allowlist. |
| Hard-coded GET | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| D2L session credentials | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| D2L manual redirects | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| D2L no cache | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Opaque redirect | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Followed redirect | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| HTTP redirect | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| JSON MIME | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| JSON parse failure | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Unauthorized session | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Refusal stays incomplete | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Network failure | It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON. |
| Accessible course | It accepts only active accessible course offerings and excludes the Durham orientation. |
| Active course | It accepts only active accessible course offerings and excludes the Durham orientation. |
| Course offering type | It accepts only active accessible course offerings and excludes the Durham orientation. |
| Orientation exclusion | It accepts only active accessible course offerings and excludes the Durham orientation. |
| Pinned LP and LE versions | It requires both observed API versions and pushes version loss as failed course evidence. |
| Missing version failure | It requires both observed API versions and pushes version loss as failed course evidence. |
| Version read failure | It refuses malformed enrollment manifests and never invents a course after a first-run login failure. |
| Complete enrollment shape | It refuses malformed enrollment manifests and never invents a course after a first-run login failure. |
| Enrollment course name | It refuses malformed enrollment manifests and never invents a course after a first-run login failure. |
| Pagination completion | It follows enrollment bookmarks and reads every required tool for each unique course. |
| Pagination cycle and missing bookmark | It stops repeated or missing bookmarks without claiming complete enrollments. |
| Course manifest bound | It bounds the enrollment manifest and labels Durham batches with their own host. |
| Failure batch status | It requires both observed API versions and pushes version loss as failed course evidence. |
| Folder-list shape | It refuses malformed folder listings and retains valid folder evidence in the cache. |
| Invalid folder remains incomplete | It refuses malformed folder listings and retains valid folder evidence in the cache. |
| Last good read requires no refusals | It preserves null dates and submission refusals while continuing through optional tools. |
| Cached folders do not hide refusal | It keeps cached folder IDs without relabeling a failed listing as fresh evidence. |
| Request throttle | It spaces actual requests by one second and leaves the background test free of fallback tabs. |
| Background test never falls back | It spaces actual requests by one second and leaves the background test free of fallback tabs. |
| Refusals trigger fallback | It falls back to an isolated LDSB tab and closes only tabs it created. |
| Close only collector-created tabs | It falls back to an isolated LDSB tab and closes only tabs it created. |
| Durham renewal only once | It renews Durham only after LDSB is live and retries once through the stored hop. |
| LDSB first | It reports failed federation and never attempts Durham login without a live LDSB session. |
| Missing hop failure | It reports failed federation and never attempts Durham login without a live LDSB session. |
| Failed renewal stays failed | It reports failed federation and never attempts Durham login without a live LDSB session. |
| Hop origin and credentials | It rejects hop URLs outside the two approved origins and URLs with credentials. |
| Unicode well-formedness | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| Structural item limit | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| Container depth | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| Finite JSON numbers | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| NFC key collision | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| Wire byte limit | It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds. |
| Non-extractable private key | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Signing audience | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Signature method binding | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Signature route binding | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Signing route allowlist | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Fresh nonce | It generates a non-extractable Ed25519 private key and signs the receiver exact envelope. |
| Gateway route allowlist | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway request bound | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway POST | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway omits credentials | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway manual redirect | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway no cache | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway redirect rejection | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Gateway HTTP rejection | It sends only pinned gateway POSTs without ambient credentials or redirect following. |
| Too many route evidences | It replaces oversized course bodies with explicit failure evidence under sixty-four KiB. |
| Oversize batch remains failed | It replaces oversized course bodies with explicit failure evidence under sixty-four KiB. |
| Device label contract | It refuses invalid pairing labels, malformed responses, and invented pairing states. |
| Pairing response contract | It refuses invalid pairing labels, malformed responses, and invented pairing states. |
| Pairing status contract | It refuses invalid pairing labels, malformed responses, and invented pairing states. |
| Existing key preservation | It persists the key before pairing and proves only the server-issued challenge. |
| Persist before public pairing | It persists the key before pairing and proves only the server-issued challenge. |
| Active key before push | It requires active pairing and a valid receipt before removing queued evidence. |
| Receipt before dequeue | It requires active pairing and a valid receipt before removing queued evidence. |
| Keep failed queue entries | It retains failed batches across restarts and retries identical bytes with fresh nonces. |
| Popup fetch gap | It allows one D2L read call site and one gateway push call site across every runtime asset. |
| Popup HTML network gap | It allows one D2L read call site and one gateway push call site across every runtime asset. |
| Remote code | It allows one D2L read call site and one gateway push call site across every runtime asset. |
| Duplicate D2L call site | It allows one D2L read call site and one gateway push call site across every runtime asset. |
| Cookie access | It allows one D2L read call site and one gateway push call site across every runtime asset. |
| Worker sender identity | It rejects control messages from content scripts and from non-popup extension pages. |
| Worker tab sender | It rejects control messages from content scripts and from non-popup extension pages. |
| Worker popup sender | It rejects control messages from content scripts and from non-popup extension pages. |
| Content sender identity | It restricts content reads to worker messages for the current D2L origin. |
| Content tab sender | It restricts content reads to worker messages for the current D2L origin. |
| Content current origin | It restricts content reads to worker messages for the current D2L origin. |
| Content read message type | It restricts content reads to worker messages for the current D2L origin. |
| Hourly cadence | It wires hourly alarms and browser startup to the collector without widening permissions. |
| Named alarm | It wires hourly alarms and browser startup to the collector without widening permissions. |
| Trusted status storage | It wires hourly alarms and browser startup to the collector without widening permissions. |
| Sync serialization | It serializes sync runs and persists only course names and fixed status fields for the popup. |
| Popup body isolation | It serializes sync runs and persists only course names and fixed status fields for the popup. |
| Transaction commit before success | It waits for IndexedDB transaction completion and rejects rollback instead of claiming durable storage. |
| Tool pages stay incomplete | It marks an unfinished tool page incomplete instead of claiming the first page is everything. |
| Proof response may be lost | It retains an ambiguous proof for retry and stops pushing after a refused status check. |
| Proof is idempotent locally | It retains an ambiguous proof for retry and stops pushing after a refused status check. |
| Status refusal blocks push | It retains an ambiguous proof for retry and stops pushing after a refused status check. |
| Preserve previously approved keys | It preserves an approved key through temporary receiver failures and later setup retries. |
| Fallback listener retry bound | It records failed tab creation and bounds retries when the content listener never arrives. |
| Tab failure becomes evidence | It records failed tab creation and bounds retries when the content listener never arrives. |
