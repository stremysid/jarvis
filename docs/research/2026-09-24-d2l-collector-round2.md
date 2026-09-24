# D2L collector — PR #170 round 2 evidence

The full [independent adversarial review](https://github.com/stremysid/jarvis/issues/comments/5807404294)
at `5420836ece76a199c3541cfba9f27fa094e3f53a` was read. This round implements
items 1–6. At both completion of those items and final-gate checks, there was no
open PR on `codex/d2l-receiver-fix`; Sid explicitly allowed this separate push.
The existing [receiver gaps](2026-09-23-d2l-collector-contract-gaps.md) remain.

| Gate | Observed result |
|---|---|
| Focused tests | **10 pass / 0 fail / 0 skip** |
| Final full extension suite, once | **50 pass / 0 fail / 0 skip**, 0 cancelled/todo |
| Full mutation script | **135 killed / 0 unconfirmed / 0 NOT APPLIED** |
| Every final mutation | Named baseline and byte-exact restoration **1/0/0**; both faulted runs **0/1/0** |
| State check | **3 carriers and FACTS pass / 0 failures / 1 advisory**, Opera background/Durham federation unverified |
| Runtime syntax | **10 pass / 0 fail** |
| Runbook PowerShell parsing | **3 blocks / 0 parse errors / 0 executed** |

Node was **v24.19.0**, shell PowerShell 7. Tests use mocked fetch, browser APIs and
storage. The week-long outage simulation generates 2,688 batches for eight courses
on two boards, retains exactly the newest 32 and reports 2,656 evictions. It also
asserts one queue write per run and zero writes per enqueue. The byte-cap test
uses multibyte body text and an already oversized legacy queue. The cap is 1 MiB
of serialized UTF-8 entries, including their metadata and escaping, with the oldest
entries evicted first. This does not reserve disk space or prove an actual Opera
IndexedDB quota; write failures remain explicit.

The mixed held-Durham/sendable-LDSB test kills the reviewer's exact mutation that
splices held evidence before continuing. The GET-only test supplies `method:POST`
and kills `method: args.method ?? "GET"`. The use-time hop test writes an off-origin
URL directly into settings and kills removal of `validateHop(hop)`. A complete
LDSB quiz 403 produces zero created tabs. The removed course-name exclusion is
covered by an inclusion assertion and a mutation that restores the exclusion.

The first focused mutation command selected 22: **20 killed, 0 unconfirmed,
2 NOT APPLIED**. Mixed CRLF/LF source prevented exact multiline matches for
"Queue clears pending after commit" and "Queue clears committed pending".
No fault was applied in those two cases. After normalizing the authored source,
the focused rerun was **2 killed / 0 unconfirmed / 0 NOT APPLIED**, followed by the
complete **135 killed** result. Missing matches were never called survivals or kills.

Queue writes occur after each bounded flush. A caught collection interruption
commits already collected evidence without starting uploads; failed storage commits
keep pending evidence in the current worker. Termination before commit can lose
the newest uncommitted read or repeat a batch whose receipt was already received;
the next sync reads again. These are documented limits of the requested single
queue write, not claims about real service-worker lifetime or receiver deduplication.

Merged #169 exposes `school_collector_revoke` through Jarvis, confirmed in
`collector-tools.ts` and `owner-agent-core.ts`. The runbook names that tool and its
owner confirmation instead of claiming no revocation route exists. Actual device
revocation, federation, key persistence, browser loading and gateway ingestion
remain unverified. No real D2L/gateway request, browser, secret, migration, database,
permission, registry, service or production action was performed.
