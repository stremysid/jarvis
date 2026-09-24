# D2L receiver compatibility follow-up

Signed: Codex GPT-6, receiver builder, 2026-09-24. This is a new PR after #169,
not a rewrite of its reviewed history. #169 was verified merged at
`29fbfcd698f4ac7de947f076e43d0098e6bcc296` before the isolated branch was created.
Read the entire #170 description and its contract-gap report at
`5420836ece76a199c3541cfba9f27fa094e3f53a`. No school account or deployed gateway
was queried. [Design](../plan/2026-09-23-d2l-collector-design.md).

Normally merged documentation-only main `54c1b67b80421e540161714e666cec1b81e3f189`
(#173) in `e48149e3`, preserving its full owner probe report and corrected owner
action. The extension advanced to `f8f11a4f90c96dc05cb72811e880cd8715944aed` during
this work. Inspected its runtime diff: queue limits/session fallback changed,
but `protocol.js`, signed paths and course batch fields did not. No rebase or
force push occurred.

Main advanced again with #172 during the full gate. A read-only merge simulation
proved migration-list conflicts. Normally merged
`7b805fa2eb79ba97cd7a8eebbc289dfbd3313957` in
`396ace56c9d23a4682f1fa1288d7362e35e9fa0c`, retaining guided assignments and 0043
before the then-numbered 0044, also the backup schema at that checkpoint. This
changed executable code, so the combined code received a fresh full gate; the
first run is preserved below.

At the final allocation check, #174 had newly claimed
`0044_owner_channel_parity.sql`. Renumbered this migration to **0045** and updated
every registration and specification. The SQL body is unchanged (Git blob
`96f93e3c32f9ce3c8655207107c41a0406616b03`). Main also advanced with the extension's
#170 merge at `f56f279dd90ddce69d3885c63c4c9fbf2c19b850`; normally merged in
`0edd8c5e`. That merge changed no gateway code or collector tests. The allocation
rename received fresh collector, upgrade, backup, parity and syntax checks plus all
four migration mutation rechecks; the full suite is not repeated for an unchanged
SQL body and filename-only registration updates.

## Extension handoff: every contract change

Paths, SignedRequestV1, canonical UTF-8 body bytes, body SHA-256, audience,
signature text, signed header, nonce requirements and schema version remain
unchanged. Existing LDSB course batches and all pairing field names still work.

| Additive change | Collector use |
|---|---|
| Durham hostname accepted and persisted | Send `host:"durham.elearningontario.ca"`, exactly as #170 already constructs it. No relabelling |
| Course `news/` and `quizzes/` routes accepted | Send the full existing batch. News remains raw evidence; dated quizzes project |
| myItems `{Objects,Next}` and query-bearing page routes accepted | Retain each raw page under its actual route. Next must resolve to an observed page of the same tool; absent, cyclic or different-tool links fail coverage. Legacy arrays still work |
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
failure variant. Its queue's `batch.course.id` access must support null for that
variant. Its local `normalEvidence` status also needs to recognize complete 404s.
This PR changes no extension-owned file and makes no live-ingest claim.

## Decisions and evidence semantics

- Store each board's literal host and use `d2l-api:<host>:<course>` sources.
  Migration 0045 preserves legacy deadline IDs, revisions, status and reminders;
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
- `school_d2l_status` does not consume an action tap after direct-private authority
  succeeds. The refusal now runs before that read; whether evidence should bypass
  it remains open for Sid because the earlier attributed instruction is unconfirmed.
  Revocation, pairing activation, key isolation, signed-request verification and
  replay protection stay.
- Pairing retries recover after proof persistence, decision creation and failed
  notification. A scoped unique decision index resolves racing creation. Delivery
  remains at-least-once if a process dies after Telegram accepted it but before
  recording delivery; duplicate messages still refer to the same decision/key.

## Observed verification

Counts below are observed, with pass/fail/skip throughout. Logs and the continuity
ledger are retained outside the repo at
`C:\Users\Sid\codex-ledgers\d2l-ingest-run.md`. Neither red full run is described
as green; the named timeout files passed separately. Final filename-only allocation
changes received focused checks rather than a third whole-suite run.

| Final check | Observed result |
|---|---|
| Collector, backup, upgrade, parity and syntax after allocation | **161/0/0**, 9 files, 103.79 seconds |
| Collector subset | **69/0/0**, 6 files |
| Static remote-D1 syntax / migration parity | **60/0/0** / **5/0/0**; local only |
| Full gateway before allocation-only rename | **5304/2/0**, 202 passed / 2 failed files |
| Timed-out files rerun separately on that head | Meaning-search **70/0/0**; Hermes **71/0/0** |
| Source / test typing after allocation | **0 diagnostics** / **143 outside collector, 0 collector** |
| State carriers | **3 carriers + FACTS passed, 1 warning**: #170's explicitly unverified background/Durham-session fact still requires owner acceptance |
| Whitespace | **0 errors** |

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
- Own review found a specific paging bug after that checkpoint. Named test
  **does not count a different tool response as the next myItems page** was
  **0/1/0** before the fix: a grades result satisfied a myItems Next link. Requiring
  the same tool pathname produced **1/0/0**. The new guard and the affected missing
  and cyclic page guards were mutation-checked after the fix.
- Collector run after the #173 documentation merge: **69/0/0**, six files,
  17.58 seconds.
- First full gateway run on executable head `e48149e3`: **5256/2/0**, 200 passed
  and 2 failed files, 378.29 seconds. The unchanged Hermes exact-cap delimiter-free
  frame test hit 15 seconds; the unchanged meaning-search bge-m3 cap test hit
  30 seconds. Both timeouts are also recorded in #172's evidence. Reran each file
  alone: Hermes **71/0/0**, 3.29 seconds; meaning-search **70/0/0**, 43.76 seconds.
  No cause beyond the observed timeout is claimed, and the red full run stays red.
- Focused integration after #172: **204/0/0**, 11 files, 105.32 seconds. This
  includes all **69/0/0** collector tests plus guided assignments, receipt claims,
  backup, migration parity **5/0/0** and static remote-D1 syntax **60/0/0**.
  Refreshed source typing:
  **0 diagnostics**. Refreshed test typing: **143 outside / 0 collector**.
- Full combined gateway run on `396ace56`: **5304/2/0**, 202 passed and 2 failed
  files, 425.22 seconds. The same two unchanged tests timed out. On that head,
  each file then passed alone: meaning-search **70/0/0**, 37.83 seconds; Hermes
  **71/0/0**, 3.54 seconds. No whole-suite rerun to seek a green result.

Mutation evidence: **63 distinct cases killed in 71 confirmed attempts** (62 initial,
3 paging follow-ups, 2 owner-tool rechecks after #172, 4 allocation rechecks).
**0 survived,
0 wrong-test kills, 0 unconfirmed,
0 NOT APPLIED, 0 invalid**. Each named fault failed twice, then the named restored
test passed. Initial sweep restored **8 files** byte-identically; follow-up restored
**1 file**, the main recheck restored **1 file**, and allocation restored **1 file**.
Initial baselines were
**15/0/0**, **21/0/0**, **1/0/0** and **9/0/0**; paging follow-up baselines were
**15/0/0** and **1/0/0**; main recheck baseline was **9/0/0**; allocation baselines
were **1/0/0** and **15/0/0**.
Every named run selected one
test: red **0/1** twice and restored **1/0**, with **14**, **20**, **8** or **0** other
tests skipped depending on the selected file. Logs: `d2l-receiver-fix-mutations.txt`,
`d2l-receiver-fix-page-mutations.txt`, `d2l-receiver-fix-main-mutations.txt` and
`d2l-receiver-fix-allocation-mutations.txt`
beside the external ledger. All other mutation target files and collector tests
are unchanged by #172; their confirmed proof was not rerun.

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
