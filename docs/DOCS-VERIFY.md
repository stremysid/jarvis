# Documentation verification — 2026-09-23

Audit base: `a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d`, freshly fetched from
`stremysid/jarvis`. This is a code/history audit, not production acceptance.

## Premises and scope

- README exists. The requested `docs/REQUIREMENTS.md`, `docs/TESTING.md` and
  `docs/KNOWN_ISSUES.md` did not exist. Their root counterparts are canonical.
  This change corrects those and adds relative-link entry points at the requested
  paths, avoiding two copies that could drift.
- The supplied older AGENTS text was stale: current AGENTS uses STATE/QUEUE/
  OWNER-ACTIONS and PATH-resolved uv. It no longer says system Python is a stub.
- No local-agent or Hermes test was run, and no permission, service,
  scheduled-task, registry, logon or production operation was performed.
- `check-state.mjs` is in CI (`f9472d1`). It is a structural check, not evidence
  that arbitrary factual statements are true.
- The initial open-PR query returned #96, #122, #154, #155 and #156. The prompt's
  sync-recovery ownership is treated as a reservation, not proof it has an open PR.
  No migration or another builder's source file was edited.
- Recorded production source is `352991e`, Worker upload
  `78cb6e98-7814-4be7-82fb-a795a7e4d0a7`, active version
  `64a184ce-4408-4962-b973-9ec3b6f48c9c`; observation from STATE at
  23:20 UTC on 2026-09-21. No live query was made.
- STATE's implementation prose is also partly stale: its claim that voice
  cannot read the previous assistant turn predates the same-call lookup in
  `bde0a9b`. This audit uses its Production section as the recorded deployment
  boundary and current code for implementation claims.

## Other-document claim checks

| Document | Checks and correction |
|---|---|
| README | Package directories, entry points, bindings, shared core, tool definitions and channel composition checked. Product aspiration labeled as a goal. Removed unsupported “runs nowhere” certainty for brain bridge. Deployment explicitly bounded to recorded source/version. |
| REQUIREMENTS | Compared against the owner's seven-phase roadmap, AGENTS and CODE-VS-JUDGMENT. Requirements separated from implemented guarantees; Windows host fleet distinguished from Ubuntu CI/legacy code; cloud secrets distinguished from local device keys. The gap-table link exists, but its assessment is dated 0611803 and predates shared voice tools. |
| TESTING | Read all workspace package scripts, root and watchdog configs, Python pyprojects, both CI workflows, voice release driver, and script-suite inventory. Corrected scope, counts, Python guidance and release-gate behavior; local-agent command restored to the runnable command on main in round 1. Relative links checked mechanically. |
| KNOWN_ISSUES | Read all 56 previous sections, traced their named implementations and relevant history. Dispositions below retain unresolved limits, remove fixed defects and distinguish unverified external acceptance. No planned feature is promoted to built. |

## Disposition of every previous known-issue section

The numbering is the section order in the audit base, not a priority ranking.
Remaining code evidence is linked in [KNOWN_ISSUES](../KNOWN_ISSUES.md).
Fixing commits are reachable from the audit base; they do not themselves prove
a production rollout.

| # | Previous section | Disposition and evidence |
|---|---|---|
| 1 | Local Workers tests do not enforce every production runtime limit | Retained as a local-test limitation. Current PBKDF2 fixed in `d839cad`; source cap test and chained KDF inspected. |
| 2 | Verified backups do not yet have an owner-enabled R2 bucket lock | Retained as unverified owner configuration, not a freshly observed lack of a lock. |
| 3 | University application details has eight deliberately closed edges | Narrowed: forwarded ingress now gated; paste ambiguity, restrictive wording, checklist gaps, fees, third-party evidence, revision cap and local-time limit retained. |
| 4 | University application workflow has seven deferred integration and presentation limits | Removed missing-receipt claim: `3a76c27` adds deterministic application receipts. Removed pending-0024 rollout as a present production blocker: STATE records 0038. Other evidence/presentation/duplicate limits retained. |
| 5 | Owner memory controls have six deferred integration limits | Narrowed all subitems: marker exists (`45b7b75`), Telegram composition exists (`8b65e21`), confirmation exists (`70dc603`, `28ad6bf`). Caller trust, inbox invariant, delayed replay and non-atomic command acceptance remain. Decision-bound bulk forget disproves the universal single-target statement. |
| 6 | R2 literal history retains two append-only and reindexing tradeoffs | Retained receipt-metadata and deletable-chunk limits. Removed uncomposed-indexer claim: `446ea2d` wires it. |
| 7 | Meaning-history canonical reads lack two supporting indexes | Removed: both indexes and restore inventory added by `95842b3` in migration 0032. |
| 8 | Automatic distillation runs in production, and its proposals were unreachable | Removed unreachable-proposal narrative as an open defect: `70dc603` (merged by `8bd42e7`) enables uncertain recall/confirmation; `f61cd9b` widens source-sentence promotion; `00978ae` adds topic filing. Meaning-proposal gap, paraphrase retry and initial archive attribution retained. |
| 9 | PR #46 notification delivery closes starvation and retains two at-least-once windows | Retained both external-effect crash windows and pending-notice visibility gap. Starvation fixed by `6bd782f`/0028; not carried as open. |
| 10 | A late split passphrase repeat is ordinary conversation (PR #40 N9) | Narrowed to the available-status short-fragment case; `c58463b` fixes spent-status repeat handling. |
| 11 | Owner-call step-up has five deferred failure and concurrency edges | Retained F9/F10/N3/N4 and F11. F11 is admission SQL in call-repository.ts (`2 = COUNT`), not a schema trigger. KDF wording updated for `d839cad`. |
| 12 | Owner-call passphrase boundary awaits rollout and live acceptance | Removed the phone-number-only production assertion: step-up implemented by `8120d44` and included in recorded source 352991e. Retained missing outbound/live-release acceptance. |
| 13 | R1 live voice evidence has two deferred observability limits | Retained per-effect observability and failed-attempt-ledger gaps. Seven-scenario contract verified in source; no paid call performed. |
| 14 | Guest PIN attempt counts reset when a call Durable Object hibernates | Removed: `8120d44` adds durable guest_call_pin_attempts and reserveGuestPinAttempt; no in-memory failedPinAttempts counter remains in the core. |
| 15 | Owner-phone begin can reveal whether a supplied number matches stored state | Retained signed-client response distinguishability; read owner-phone-enrollment.ts. |
| 16 | PR #28 evidence-store guards include deliberate redundancy | Retained overlapping-guard coverage caveat; no historical mutation result re-presented as new evidence. |
| 17 | R1 terminal cleanup retries are bounded | Retained finite-retry/live-delivery boundary; no provider behavior re-verified. |
| 18 | Fact projection revalidates each source event once per citing fact | Retained repeated per-source validation before replay; removed unremeasured timing/untested-cap totals. |
| 19 | Fact projection is filtered on read but not scrubbed or refused on write | Narrowed: suppression filters reads, not writes. Later publication can retire old projection versions (0014); no automatic forgetting rebuild. Windows client is implemented (`ec5ebb5`). |
| 20 | CI type-checks only Windows, so every Linux branch is invisible to mypy | Retained Windows-target-only type coverage. Removed stale Linux error totals and obsolete Linux milestone requirement. |
| 21 | `/status` prints UTC clock times with no label, in a local-time chat | Retained: command handler still slices UTC strings with no zone label. |
| 22 | The gateway heartbeat 404s: cause found, fix pending deployment | Removed: `2ebdece` sets global_fetch_strictly_public; STATE records the heartbeat as of 352991e. |
| 23 | Expect one DOWN alert on a first watchdog deployment | Retained as startup semantics, not evidence of an ongoing delivery failure. |
| 24 | A must-report list cannot be empty | Retained as configuration semantics: empty required-component list is refused. |
| 25 | R0 review follow-up: triaged, one root cause in ten test files | Removed already-fixed test-fixture defects: `edac272` adds shared canonical temp parent, cleanup retries and uv interpreter installation. No new extended-suite pass claimed. |
| 26 | R0 CI corrections pass locally; remote CI remains unverified | Removed historical pending-CI narrative: `d9d59f9` fixes target/DACL fixture assumptions; `edac272` completes canonical temp handling. Current CI is a separate result. |
| 27 | The local agent does not typecheck or fully test on Linux | Removed the stale three-failure/25-error inventory: `d9d59f9` corrects the named platform assumptions. Remaining target-type coverage retained; no Linux suite executed. |
| 28 | `README.md` says vector search; the vector is not semantic | Narrowed to the actual local lexical embedder/FTS limitation; removed stale README attribution and deleted-milestone promise. |
| 29 | hermes-profile-lock.json records a stale sourceLockHash | Retained: canonical source hash comparison returned false; schema/profile still agree on the older binding. |
| 30 | The hermes-runtime suite is excluded from `pnpm test` | Moved command-selection fact to TESTING; not a defect implying absent CI. Historical 245-test total removed. |
| 31 | The hermes-runtime suite is slow | Retained only the extended-suite coverage/duration uncertainty; not a current 50-minute measurement. |
| 32 | Tasks 10-13 are unimplemented | Removed the obsolete task-number checklist. Bootstrap is implemented (`e3e3527`, `ec5ebb5`); no Windows service command, sync success or release certification is inferred. |
| 33 | Rate limiting and the circuit breaker are per-isolate | Retained module-scope limiter/breaker boundary. |
| 34 | The autonomy repository's read-back guards are untested | Retained invalid-read coverage gap; no new mutation performed. |
| 35 | The cloud-gateway tests were never typechecked, and 144 errors remain | Retained and freshly measured: 144 diagnostics / 32 files, exit 1. Removed claim that the set cannot grow. |
| 36 | Google Classroom due dates: UTC contract selected; live display check remains | Retained date-only precision and unverified UI mapping; no repeat request for impossible Classroom consent. |
| 37 | Grade and submission ingestion still has four approval and coverage gaps | Narrowed to actual coverage: no usable Classroom route/feed per STATE; email handler does exist. Undated and recreated-submission gaps plus missing same-day alerts retained. |
| 38 | Only an explicit calendar cancellation moves a deadline out of `open` | Retained status/cancellation/reopen distinctions; 0027 is merged, not a candidate. |
| 39 | Brightspace does not document due-versus-availability iCalendar semantics | Retained lack of verified semantic discriminator as an acceptance gap, not a new survey of D2L documentation. |
| 40 | First on-demand Brightspace load has no Worker-lifetime acceptance evidence | Retained unverified Worker-lifetime acceptance; no usable feed assumed. |
| 41 | Study-coach evidence is not yet integrated with R2 owner controls | Narrowed: `8b65e21` composes Telegram memory controls, but study records are still separate. |
| 42 | Study-coach digest check-ins are claimed before delivery | Retained pre-delivery last_prompted_on claim. |
| 43 | Study-coach retirement and forget controls are one-way | Retained terminal supersession and no undo; grammar also accepts weak area and optional words, so old exact-shape claim corrected. |
| 44 | Must-report gap: deployed, gateway delivery still needs verification | Removed: `aec4734` implements must-report handling; `2ebdece` fixes gateway routing; STATE records gateway heartbeat as of 352991e. |
| 45 | Nothing watches the watchdog | Retained STATE's explicit “No external watchdog” observation; no fresh production query. |
| 46 | The watchdog's alert path can be configured and still broken | Retained configured-versus-delivered distinction. |
| 47 | One shared heartbeat secret for every component | Retained shared-secret component impersonation boundary. |
| 48 | Two transcribed copies must be kept in step by hand | Retained manual-copy drift risk; removed categorical claim that nothing can fail before production. |
| 49 | The named pipe's DACL is proven against anonymous, reasoned about for a second user | Retained second-user acceptance gap; existing anonymous/DACL tests were read, not run. |
| 50 | The Windows agent still has no service host | Narrowed: no Windows service subcommand, but foreground serve and boot chain exist (`ec5ebb5`, `e3e3527`). No Linux host presumed. |
| 51 | Vault observations are NOT upload-ready: no redactor runs | Retained vault-redaction gap; narrowed 'no sync client' to no vault-observation upload path. |
| 52 | Vault write-once is create-new-only, not fenced | Retained create-new-only/TOCTOU/read-bracketing/hash-recovery limits; removed promised future Rust implementation. |
| 53 | Vault: no USN journal, so every sync is a full walk | Retained no USN/durable cursor; added the verified 64-examined-document ceiling. |
| 54 | Vault: `project()` has no authority gate | Retained uncomposed vault projection authority boundary. |
| 55 | Vault: NTFS enforcement is Windows-only, cloud-sync detection is heuristic | Retained Windows probe/heuristic sync detection boundary. |
| 56 | Vault: a file Jarvis published is re-observed as user-authored | Retained default user-authored origin without receipt reconciliation. |

## Verification limits

Documentation only: no package source, test, migration or guard changed.
There is no new guard to mutation-verify; no mutation pass or survival is claimed.
Historical timings, historical test totals and historical mutation outcomes are
not relabeled as this run's evidence. The full root workspace suite was run as
additional confidence; no package-specific full-suite obligation was created by
a package edit. Hermes, Python, live voice, deployment and production checks
were not executed. Independent review follows this PR and was not self-certified.

Observed commands and exact counts are recorded in
[the signed agent entry](AGENT_LOG.md#docs-verify-2026-09-23).
