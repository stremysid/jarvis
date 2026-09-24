# D2L receiver compatibility follow-up

Signed: Codex GPT-6, receiver builder, 2026-09-24. This is a new PR after #169,
not a rewrite of its reviewed history. #169 was verified merged at
`29fbfcd698f4ac7de947f076e43d0098e6bcc296` before the isolated branch was created.
Read the entire #170 description and its contract-gap report at
`5420836ece76a199c3541cfba9f27fa094e3f53a`. No school account or deployed gateway
was queried. [Design](../plan/2026-09-23-d2l-collector-design.md).

## Extension handoff: every contract change

Paths, SignedRequestV1, canonical UTF-8 body bytes, body SHA-256, audience,
signature text, signed header, nonce requirements and schema version remain
unchanged. Existing LDSB course batches and all pairing field names still work.

| Additive change | Collector use |
|---|---|
| Durham hostname accepted and persisted | Send `host:"durham.elearningontario.ca"`, exactly as #170 already constructs it. No relabelling |
| Course `news/` and `quizzes/` routes accepted | Send the full existing batch. News remains raw evidence; dated quizzes project |
| myItems `{Objects,Next}` and query-bearing page routes accepted | Retain each raw page under its actual route. Include all Next-linked results before claiming complete; unfetched/cyclic Next links fail coverage. Legacy arrays still work |
| `200 []` student submissions accepted | Send the original array. Submission status remains unknown |
| Complete optional-tool 404 accepted | Keep actual status/body and complete:true, like JSON 403. Missing tools remain visible |
| **New host-only failure variant** | Same root fields, but `course:null`, `courseIds:[]`, `enrollmentComplete:false`. At least one versions/enrollment route result. Always outcome failed; no invented course |
| Retryable proof/delivery | Re-sign the same `{challenge}` for `/school/pairing/prove` with a fresh nonce before expiry. It reuses the decision; successful ordinary retries return the existing 202 receipt |
| Read-tool result additions | `hosts`, `unmappedRoutes`, `evidence.host`, `unmapped_json`, nullable evidence/refusal course, and refusal host/disposition. Upload receipt fields are unchanged |

Example first-run session failure, signed through the existing observations path:

```json
{
  "schemaVersion": "1.0",
  "host": "durham.elearningontario.ca",
  "readId": "synthetic-host-read",
  "startedAt": "2026-09-24T00:00:00.000Z",
  "courseIds": [],
  "enrollmentComplete": false,
  "course": null,
  "routes": [{
    "route": "/d2l/api/versions/",
    "status": 0,
    "fetchedAt": "2026-09-24T00:00:00.000Z",
    "complete": false,
    "body": {"collectorFailure": "session-expired"}
  }]
}
```

For an oversized manifest use the enrollment route, actual HTTP status,
complete:false, and `{collectorFailure:"course-manifest-too-large",courseCount:N}`.
The collector's actual timestamps/read ID replace those synthetic example values.
Limits remain 64 KiB, 128 course IDs, 256 routes, 32 levels and 4,096 structural
items. A host failure is a compact failure report, never truncated success.

#170 still holds unsupported batches locally at its reviewed head. Its builder
must update that compatibility hold after receiver rollout and emit the new host
failure variant. This PR changes no extension-owned file and makes no live-ingest claim.

## Decisions and evidence semantics

- Store each board's literal host and use `d2l-api:<host>:<course>` sources.
  Migration 0044 preserves legacy deadline IDs, revisions, status and reminders;
  old LDSB source rows remain inactive history. No guessing which board owned old
  rows: #169 accepted only LDSB.
- Unknown JSON is evidence with unknown projection, not a failed receipt. Other
  known projections continue. Ambiguous content links and duplicate folder dates
  retain raw evidence and do not select an arbitrary date. Digest gaps expose
  unknown projections so a partial adapter cannot claim nothing due.
- News publication/expiry dates are not inferred assignment deadlines. Quizzes
  project explicit due dates and availability ends separately when they differ.
  These synthetic populated fixtures use the documented
  [QuizReadData](https://docs.valence.desire2learn.com/res/quiz.html#Quiz.QuizReadData)
  and [ScheduledItem](https://docs.valence.desire2learn.com/res/content.html#Content.ScheduledItem)
  fields; they are not owner-observed positive payloads. The owner's empty envelope
  and submission array come from #170's report.
- Health is calculated per reported host. A newer good LDSB read cannot conceal
  Durham's failed or stale read. The top-level last-good timestamp is the older of
  their latest good times, or null if a reported host has none. Evidence pagination
  keeps all history; latest-read refusal sampling remains bounded.
- Per Sid's newer explicit instruction, `school_d2l_status` does not consume an
  action tap or depend on pipeline direct-text authority. Revocation, pairing
  activation, key isolation, signed-request verification and replay protection stay.
- Pairing retries recover after proof persistence, decision creation and failed
  notification. A scoped unique decision index resolves racing creation. Delivery
  remains at-least-once if a process dies after Telegram accepted it but before
  recording delivery; duplicate messages still refer to the same decision/key.

## Observed verification

Verification is in progress. Exact final gate and mutation totals will replace
this paragraph before publication. Logs and the continuity ledger are retained
outside the repo at `C:\Users\Sid\codex-ledgers\d2l-ingest-run.md`.

Iteration history, pass/fail/skip:

- First focused run: **59/3/0**, four files. Two failures compared canonical JSON
  against pre-canonical key order; one retained the superseded strict-shape rule.
- Second: **100/1/0**, six files. The new upgrade test called nonexistent
  `getSource`; inspected the repository and corrected it to `readSource`.
- Third: **35/1/0**, three files. A proposed undelivered-but-withdrawn decision
  fixture violated the existing database CHECK equating open with null delivery.
  Removed the redundant notification status condition and the impossible fixture.
- Complete collector checkpoint: **68/0/0**, five files, 37.57 seconds.
  Afterwards strengthened the empty-submission and ambiguous-date assertions and
  removed a redundant page-completeness check already enforced for every route.
- Static remote-D1 syntax: **55/0/0**. Migration-list parity: **5/0/0**.
  These are local tests, not a remote D1 rehearsal.
- Source typing: **0 diagnostics**. Test typing: **143 diagnostics outside
  collector files, 0 inside**, the existing non-gated debt.

The new mutation specification is
[`mutation-specs-d2l-receiver-fix.json`](../../reviewer-tools/mutation-specs-d2l-receiver-fix.json).
The old #169 specification is historical: several strict-shape/read-gate mutations
describe behavior explicitly superseded here. The new specification witnesses the
changed behaviors rather than pretending those old restrictions remain approved.

## Not verified and owner-only work

No deployment, real database migration, remote D1 rehearsal, secret operation,
production request, live Telegram notification, real extension/gateway ingestion,
Opera GX restart or Durham federation was performed. Public documentation was read;
school accounts were not accessed. Positive own-submission shapes remain unverified.
The requested PC incident document was absent at its supplied path. No permissions,
services, tasks, registry, logon or local-agent code/test was touched. The #157-owned
sync files remain unchanged. Owner rollout and two-board acceptance are recorded
once in [OWNER-ACTIONS](../OWNER-ACTIONS.md).
