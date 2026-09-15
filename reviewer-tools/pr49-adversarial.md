# PR #49 adversarial review — Brightspace iCal deadlines (reviewed 4d511f2)

- Branch `origin/codex/r5-brightspace-deadlines`, base main `1130694`.
- The branch head is now `b630200`. It adds only a `docs/AGENT_LOG.md` hand-off, so the code is identical to `4d511f2`.
- Method: read-only review of the diff and the code it touches: repository, ingestion, composer, scheduler, `index.ts`.
- No test suite was run.
- One probe was run against the repo's own bundled `workerd.exe` 1.20260828.1 using `workerd test`. Its outbound traffic went to a local stub worker, so there was no network access. Probe files are in this scratchpad (`probe.capnp`, `probe-worker.mjs`, `stub-worker.mjs`).

**Verdict: changes requested.** One confirmed High blocks the feature from ever working live. There are five Mediums.

---

## H1 — `redirect: "error"` is rejected by the Workers runtime, so every live poll fails (CONFIRMED)

**Where:** `apps/cloud-gateway/src/deadlines/brightspace-ical-client.ts:485-491`

```ts
const response = await this.#fetch(this.#feedUrl, {
  method: "GET",
  headers: { accept: "text/calendar" },
  redirect: "error",
  cache: "no-store",
  signal: controller.signal,
});
```

Any throw is then flattened at `:504-506`:

```ts
} catch (error) {
  if (error instanceof BrightspaceFeedError) throw error;
  throw failure("brightspace_feed_unavailable", null, true);
```

**Proof.** The probe ran workerd 1.20260828.1 with the PR's `compatibility_date = "2026-08-22"` and `compatibility_flags = ["global_fetch_strictly_public"]`. It used the exact init object above:

```
"fetch PR49 init (redirect=error, cache=no-store)": "THROW TypeError: Invalid redirect value, must be one of \"follow\" or \"manual\" (\"error\" won't be implemented since it does not make sense at the edge; use \"manual\" and check the response status code)."
"new Request cache=no-store": "OK no-store"
"fetch redirect=manual cache=no-store": "OK 200 stub-outbound reached"
"fetch redirect=manual to 302 stub": "OK 302 redirected=false location=https://other.example/login"
```

The same string is in workerd 1.20260815.1, so this is not a new runtime change.

**Scenario.** Sid sets `BRIGHTSPACE_ICAL_URL` and deploys.
- Every hourly poll throws a TypeError before any request leaves the Worker.
- The poll records `brightspace_feed_unavailable`, and no Brightspace deadline is ever ingested.

**Consequence for the owner.**
- Every morning the digest says `Brightspace: brightspace_feed_unavailable`.
- The runbook tells him that code means "a timeout, rate limit, server error, or network failure. The next hourly run retries normally". So the failure looks like a transient network blip forever.
- F1 keeps the failure visible, which is good, but the feature is dead on arrival and the diagnosis points the wrong way.

**Why tests pass.** Every client and job test injects a `vi.fn` fetcher. No test ever passes the init object through workerd's real `Request` or `fetch`. The "302 → redirected" test builds a fake 302 `Response` itself.

**Same bug already on main (outside this diff, same severity):**
- `apps/cloud-gateway/src/deadlines/google-oauth.ts:109` uses `redirect: "error"`. Every Classroom token refresh becomes `google_oauth_unavailable`, so PR #43's Classroom ingestion also cannot work live.
- `apps/cloud-gateway/src/providers/capacity-readers.ts:37` uses the same setting, so the balance readers are always "unavailable".
- By contrast, `twilio-provider.ts:200` and `hermes-token-adapter.ts:421,522` already use `"manual"`.

**Fix.**
- Use `redirect: "manual"`. Line 492 already refuses `response.redirected` and any 3xx, so the refusal semantics stay exactly as the runbook describes.
- Apply the same one-line change in `google-oauth.ts` and `capacity-readers.ts`. In `google-oauth.ts`, also refuse 3xx explicitly, since `!response.ok` already covers it.

**Tests.**
- In the Workers pool, capture the `init` the fake fetcher receives and replay it: `expect(() => new Request(FEED_URL, init)).not.toThrow()`. Do the same for the Google OAuth and capacity readers.
- Better: one test that uses the real global `fetch`, with outbound mocked through the pool's fetch mock, and asserts that a real 302 becomes `brightspace_feed_redirected`.

---

## M1 — One unusual component fails the whole feed (CONFIRMED code path)

Parsing is all-or-nothing. Any one of these throws `brightspace_feed_invalid` for the entire calendar:

| Input | Line |
|---|---|
| A second `CATEGORIES` (or `STATUS`/`SUMMARY`) line in one event. RFC 5545 §3.6.1 explicitly allows `categories` to occur more than once | `:233` (`values.length > 1`) |
| A non-RFC escape common in real producers, e.g. `SUMMARY:Lab\: part 2` or `\"` | `:249` |
| A local time in the spring-forward gap, e.g. `DTSTART;TZID=America/Toronto:20270314T023000` (round-trip mismatch) | `:328-333` |
| A Windows or vendor TZID (`TZID=Eastern Standard Time`, `/mozilla.org/.../America/Toronto`); `Intl` throws | `:285-287` |
| `VALUE=DATE` together with a `TZID`, or `VALUE=PERIOD` | `:353`, `:360` |
| The same UID on two items, e.g. a VEVENT and a VTODO for one assignment, or a UID ending `:<recurrence>` colliding with an exception key | `:416` |
| More than 2,000 VEVENT/VTODO, or more than 1 MiB | `:212`, `:437` |

**Consequence.**
- One teacher's odd event stops every new or moved Brightspace deadline for all courses until someone fixes that event.
- The digest just says `Brightspace: brightspace_feed_invalid`, with no hint of which item.
- It is honest (fail-closed and visible), but it is a single point of failure controlled by third parties. Ingestion already has a per-item rejection channel (`deadline-ingestion.ts:264-267`) that this bypasses.

**Fix.**
- Keep feed-level failure only for envelope, encoding, size and bearer errors.
- Parse each component inside its own try/catch and return `{items, rejectedCount}`. The count is a number only, with no text.
- Take the first `CATEGORIES` when several exist.
- Keep unknown escapes literally.
- Resolve a DST-gap time forward, as RFC 5545 §3.3.5 does.
- An unknown TZID should reject that item only.

**Tests.**
- A feed with one bad event and one good event yields the good item and a rejection count of 1.
- Two `CATEGORIES` lines parse.
- `20270314T023000` in America/Toronto resolves to 03:30 EDT.

---

## M2 — The whole feed is re-upserted hourly, and the D1 per-invocation query budget can break Brightspace and project polling (CONFIRMED path; threshold is a SUSPICION)

**Path.**
- The parser keeps every dated VEVENT and VTODO, past ones included, with no horizon (`:388-406`, `:409-420`).
- `DeadlineIngestion.ingest` upserts every item every hour. The unchanged path costs 3 D1 queries per item (`deadline-repository.ts:373`, `:412-414`, `:417`). The created path costs 1 read, a 2-statement batch and 1 read.
- The same scheduled invocation also runs:
  - archival (`job-table.ts:181-182`);
  - the whole Classroom sweep (`:184`);
  - project polling (`:200`).
- The repo's own fact-check records the D1 limit of **1,000 queries per Worker invocation on Workers Paid** (`docs/research/2026-09-14-jarvis-memory-research-factcheck.md:54`).

**Scenario.**
- A semester's "All Calendars and Tasks" feed plus Classroom items passes roughly 300 items total. That is plausible once past events and availability start/end events are included; the D2L feed contents are unverified.
- Mid-sweep, an upsert throws. `recordSourceFailure` in ingestion's catch (`deadline-ingestion.ts:308`) is also over budget and throws.
- `pollBrightspace`'s catch-side ingest (`job-table.ts:151`) throws again. `safeSourcePoll` swallows it with no durable record.
- The project poller's D1 calls then fail too, so the poll job itself is marked failed.

**Consequence.**
- Brightspace never completes a sweep. It is only visible three hours later as `last successful sync is stale`.
- GitHub project polling is collateral damage every hour.
- It gets worse as the term accumulates events, because nothing ever drops past ones.

**Fix.**
- Before ingest, keep only items with `dueAt >= now − 14d` and `<= now + ~180d`. Absent items are only reported, never written, so this is safe.
- Drop the re-read on the unchanged path (`:417`).
- Update `last_seen_at` for all unchanged ids in one statement.
- Consider running Brightspace after the project poll, or in its own firing.

**Tests.**
- Spy on `D1Database.prepare` or batch while ingesting 400 items, and assert the query count stays under a fixed budget.
- A parser or ingest test that items older than the horizon are not upserted.

---

## M3 — Every calendar event becomes a "Due" deadline (SUSPICION: needs one real, redacted feed sample)

**What the code does.**
- `toDeadline` (`:388-406`) treats every VEVENT's `DTSTART` as a due instant and every title as a deadline title.
- The course is taken only from `CATEGORIES` (`:399`), defaulting to "Brightspace".

**What D2L probably sends (unverified).**
- To my knowledge, D2L calendar feeds emit separate events per activity, such as "Unit 3 Test - Available", "... - Availability Ends" and "... - Due".
- They also include course events and the student's personal events.
- The course may be carried in `LOCATION` or in the summary rather than in `CATEGORIES`.

**Consequence if true.**
- The digest shows up to three entries per test.
- The keyword classifier gives an "Available" event effort `test` or `exam`, with a 2- or 7-day lead, so a start date reads as "due in 1d".
- Every item's course becomes "Brightspace", which disables per-course effort rules.
- Once `deriveExamWindows` is wired, it would create exam quiet windows from "Available" events.

**Fix.**
- During owner-attended live acceptance, capture property names and a few titles only, with no URL or DESCRIPTION.
- Then keep only due or end events, or label start events. Map the course from the right property.

**Test.** Fixture events with D2L-shaped suffixes produce one deadline per activity.

---

## M4 — Cancelled, completed or deleted items stay open forever and look identical to live deadlines (CONFIRMED)

**Where.**
- The parser drops `STATUS:CANCELLED` and `COMPLETED` (`:390-391`), so ingestion sees a disappearance.
- Disappearances are never written (`deadline-ingestion.ts:205-221`).
- The digest renders them as normal due items (`digest-composer.ts:156-160`) and never uses `lastSeenAt`.
- The ingestion comment promises "the digest can say 'not seen since Tuesday'". No code does this.

**Scenario.** A teacher cancels a test. The morning digest keeps showing "SPH4U: Unit 3 Test (in 2d, test)" every day until the old date passes.

**Why it matters.** The "absence is ambiguous" rationale does not cover an explicit `STATUS:CANCELLED` from a successfully parsed feed. That is a positive signal.

**Fix.**
- Carry an explicit cancellation from the adapter, e.g. `cancelled: true` on `RawDeadlineItem`.
- Mark those items `cancelled` only on a successful sweep.
- For absent items, add "(not seen since <local date>)" when `lastSeenAt < source.lastSuccessAt`.

**Tests.**
- An item that later arrives with `STATUS:CANCELLED` leaves the digest.
- An absent item is annotated rather than silently shown as current.

---

## M5 — F1 residual: "not configured" versus "failed" versus "never ran" is incomplete (CONFIRMED)

**(a) Classroom not set up is silent.**
- `job-table.ts:244-247` only ever passes `["brightspace"]`.
- Classroom is not configured in production today. So the digest says `Brightspace: not set up` but nothing about Classroom, which is the "silently no deadlines" failure for a load-bearing source.

**(b) The manual `/digest` path ignores F1's configuration signal.**
- `index.ts:226-243` calls `assembleDigest` without `unconfiguredDeadlineSourceKinds`.
- The on-demand digest says nothing about Brightspace being unset, so it differs from the scheduled one.

**(c) Configured, but no source row, means no gap at all.**
- If `ensureSource` or `readSource` keeps throwing (`job-table.ts:129-134`), `safeSourcePoll` (`:161-167`) swallows it.
- The URL is set, so the source is not "unconfigured". There is no row, so there is no health gap. The digest omits Brightspace completely.

**(d) A removed secret reads as "not set up" while stale Brightspace deadlines are still shown.**
- `digest-job.ts:188-189` skips the stored row because `unconfigured.has(source.kind)`.
- So the recorded `brightspace_configuration_missing` never reaches the digest, and last-known Brightspace items still appear as current.
- The runbook implies the owner sees the configuration-missing state.

**Fix.**
- Compute the expected sources, `{classroom: configured?, brightspace: configured?}`, in one helper used by both `job-table.ts` and `index.ts`.
- Configured with no row: "configured but has never synced".
- Row exists but configuration missing: "configuration removed; showing deadlines last synced <date>".
- Unconfigured with no row: "not set up", for both sources.

**Tests.** One test per case (a)–(d), including the manual `/digest` path.

---

## Low

- **L1 — Archival is still unwrapped before the source polls.**
  - `job-table.ts:181-183`. An R2 or D1 throw in `archive.run` skips Classroom, Brightspace and project polling.
  - F2 as written (the Classroom bootstrap) is fixed, but this is the same class of problem.
  - Fix: wrap it like `safeSourcePoll`. Test: archive throws, and both polls still run.
- **L2 — Failure gaps carry no age.**
  - `digest-job.ts:79` returns the bare code, so a failure three weeks old reads the same as one an hour old. Last-known deadlines shown alongside may be weeks stale.
  - Fix: append "since <local date>" from `lastFailureAt`, or the last success.
- **L3 — Misleading failure codes.**
  - An invalid `DIGEST_TIMEZONE` yields `brightspace_feed_invalid` (`:285-287` via `:466`), and the runbook then tells Sid to re-copy the feed.
  - An invalid `timeoutMs` yields `brightspace_feed_url_invalid` (`:469-471`).
  - Fix: add a distinct `brightspace_timezone_invalid` code.
- **L4 — Recurrence handling.**
  - `RRULE` is ignored, so only the first occurrence of a recurring event is kept.
  - The `RECURRENCE-ID` raw text becomes part of the identity (`:385`). If the provider switches between `TZID=...:20260919T100000` and `20260919T140000Z`, a duplicate deadline is created and the old one never clears (see M4).
  - Fix: normalize `RECURRENCE-ID` through `calendarInstant`.
- **L5 — No path-shape check on the URL.**
  - `requireFeedUrl` (`:71-98`) accepts any https host.
  - The URL is an owner-held secret, `global_fetch_strictly_public` blocks internal routing, no credentials or headers are forwarded, and redirects are refused once H1 is fixed. So SSRF risk is minimal.
  - Optional fix: require `/d2l/le/calendar/feed/` in the path. Don't allowlist hosts, because Ontario boards use custom D2L domains.
- **L6 — Untrusted text can mimic a status line inside "Due".**
  - Course and title are not quote-prefixed (`digest-composer.ts:156-160`). `CATEGORIES:Google Classroom` plus `SUMMARY:classroom_rejected` renders as `Google Classroom: classroom_rejected (in 2d, other)`.
  - Telegram is plain text, control and format characters are stripped, and length is capped at 240. So the impact is confusion only. This already applies to Classroom.
- **L7 — Observability residual (SUSPICION).**
  - `wrangler.toml` has no `[observability]` block today.
  - If Workers tracing or subrequest logging is enabled later, outbound fetch spans may record the full URL, and the token with it.
  - Fix: add a runbook line: don't enable tracing while the feed secret is set, and if you do, reissue the feed in Brightspace.
- **L8 — No content-type check.** An HTML login page still fails because the parser is strict, so this is informational only.

---

## Checked and sound

- **Secret containment.**
  - The URL lives only in a private field.
  - Errors use fixed codes (`:33-43`), and unknown throws are replaced (`:504-506`), so the original fetch error text is dropped.
  - Job detail strings, `console.log("scheduled")` (`index.ts:429`), `deadline_sources.last_failure` and digest gaps carry only codes.
  - The runbook uses Wrangler's interactive secret prompt, not a command argument, and says to clear the clipboard.
  - No model sees deadlines: the digest is deterministic, and no model path reads `DeadlineRepository`.
- **No request without configuration.**
  - A missing or empty URL makes no fetch (`job-table.ts:118-127`).
  - The constructor validates the URL (https only, no userinfo, no fragment, no whitespace or control characters) before any fetch.
  - An inactive source is neither contacted nor reactivated. Tests assert all three.
- **Fetch hygiene** (after the H1 fix).
  - The timeout covers headers and body read. The abort controller is aborted in `finally`.
  - The body is cancelled on non-OK responses.
  - The declared `content-length` and streamed bytes are capped at 1 MiB, and UTF-8 decoding is fatal.
  - `cache: "no-store"` is accepted by workerd at this compat date (probe).
  - A 3xx under `manual` is visible to the existing check (probe).
- **Parser safety.**
  - Linear scans, and every regex is anchored with no nested quantifiers, so no catastrophic backtracking.
  - No recursion. A depth stack is used, properties are capped per component, and nested VALARM content is ignored.
  - `DESCRIPTION` and `URL` are never read or followed.
  - RFC unfolding (one whitespace removed), CRLF/LF/CR and BOM are handled.
  - The quoted-parameter split is correct.
- **Time zones for America/Toronto.**
  - UTC `Z` is exact.
  - `TZID` and floating times resolve through `Intl` round-trips; EDT and EST are verified by tests.
  - The fall-back ambiguous hour resolves to EDT, the earlier instant.
  - `VALUE=DATE` becomes the local end of day, `23:59:59.999` (2026-09-20 → `2026-09-21T03:59:59.999Z`).
  - The digest renders relative hours, so no deadline shifts a day.
- **Untrusted text.**
  - Normalized at ingestion (control and format characters stripped, 512 cap) and again in the composer (`\p{C}` stripped, 240 cap).
  - Telegram sends are plain text; there is no `parse_mode` anywhere in `src`.
  - Gap source names come from the validated kind, not the stored label.
  - External identifiers now reject control and format characters.
- **Idempotency and identity.**
  - `UNIQUE (source_id, external_id)` holds, and `brightspace-ical` is distinct from `google-classroom`, so there are no cross-source collisions.
  - `ensureSource` uses `ON CONFLICT DO NOTHING` and refuses a kind conflict.
  - Unchanged content writes no revision, and duplicate ids within one sweep are rejected.
  - `0011` CHECK allows `brightspace`, and no migration is needed.
- **F1 as originally specified** (`AGENT_LOG.md:509`).
  - Success clears the failure pair (`deadline-repository.ts:300-306`).
  - Active scheduled sources report a failure, "has never synced", or staleness after 3 h, and last-known deadlines stay visible.
  - Boundary tests exist.
- **F2 as originally specified** (`AGENT_LOG.md:511`).
  - Both source polls are wrapped (`job-table.ts:184-189`).
  - A test proves a Classroom bootstrap throw still lets the project poll run, without leaking the D1 message.
- **Cron.**
  - No trigger or `ROUTED_CRONS` change.
  - Brightspace joins the existing hourly poll sequentially after Classroom.
  - When unconfigured it costs one D1 read per hour.
