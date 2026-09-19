# R7 assistant memory and manager slice plan

**Status:** reviewable docs-only plan for v1.6. It changes no runtime,
migration, configuration, account or deployment.

This baseline was checked on 2026-09-15 against `origin/main` at `1cae97b`,
the current GitHub heads for PRs #52 and #53, and the active R2 archive-history
worktree. It was not reconstructed from chat memory. Main ends at migration
`0022`; open PR #53 carries `0023`, open PR #52 carries `0024`, and the
in-progress R2 archive-history slice carries `0025`. R7 reserves none of them
and every schema slice below uses the **next free number at build time** after a
fresh branch, PR and mailbox audit.

## 1. What v1.6 delivers

In plain words, Jarvis gains an evidence-backed picture of how Sid works,
explains where that picture came from, and lets Sid correct or hide it. It can
turn current school, calendar, project and usage evidence into timely prep,
workload and cost views; ingest approved material without treating it as
instructions; triage rather than send mail; and make only reversible,
owner-authorized calendar changes. Model routing becomes a reviewed per-task
choice, never a silent paid failover.

The roadmap exit test, restated exactly:

> **Exit.** "Why do you think I hate mornings?" gets an answer with a dated source. A brief arrives before a class. The Sunday retro has a workload line and a cost line.

That exit is owner-run live acceptance after the relevant reviewed builds and
deployments. Local tests, independent review and live acceptance remain
separate gates.

## 2. Current baseline

| Area | Tree-verified state | What exists, and what does not |
|---|---|---|
| R2 evidence and profile foundation | **Merged, partial:** PRs #35, #38, #39, #47 and #50 | `apps/cloud-gateway/src/memory/extraction-policy.ts` keeps model conclusions uncertain; `memory-repository.ts` supplies canonical item/topic reads and writes; `0016_cloud_memory.sql` supplies versioned items, sources and receipts. There is no R7 profile shape or observed-pattern job. The R2 migrations remain unapplied. |
| R2 explain, forget and restore | **Merged, uncomposed:** PR #50 | `apps/cloud-gateway/src/memory/memory-owner-controls.ts` implements channel-neutral deterministic explain, whole-turn forget and lift receipts. No Telegram or voice adapter exposes them yet, so `/why` and `/forget` are not a product claim. R2's named **Unified Telegram text recall and plain-speech controls** slice remains not started. |
| R2 suppression ledger | **Merged, unapplied:** PRs #39 and #42; runtime writer in PR #50 | `0016_cloud_memory.sql` contains `memory_event_suppressions`, lifts and eligibility views; `0019_memory_ingress.sql` guards exact owner commands. The active R2 **Archive-complete literal history and coverage** slice is **in progress**, includes candidate `0025`, and is not on main or in a PR yet. |
| R5 digest and catch-up | **Merged:** PRs #43, #45, #49 and #51 | `apps/cloud-gateway/src/jobs/digest-job.ts` and `digest/digest-composer.ts` deterministically show deadlines, catch-up actions, project health and unreadable sources. The R0 digest is live; R5 data paths are merged but their unapplied schemas/configuration and owner live checks prevent a live R5 claim. |
| R5 deadlines and university foundation | **Merged, configuration-gated:** PRs #43, #48, #49 and #51 | `deadlines/classroom-client.ts`, `deadlines/brightspace-ical-client.ts`, `school/school-catchup-repository.ts` and `university/university-tracker-repository.ts` exist. **STALE: Classroom OAuth is NOT owner work — it is impossible.** **The Google Classroom API route is DEAD for Sid** — his school account cannot reach Google Cloud Console, so the three `GOOGLE_*` bindings can never be obtained. See `docs/runbooks/google-classroom-oauth.md`. Classroom arrives as notification email instead, and the remaining work is ours, not his. The Brightspace feed secret is likewise unobtainable (that board has no calendar feed). Live deadline acceptance does remain owner work. |
| R5 study and application expansion | **Open:** draft PR #53 with `0023`; draft PR #52 with `0024` | #53 implements the first study-coach slice and #52 implements the first application-workflow slice. Both have review changes requested and neither is baseline for an R7 build until merged. |
| R6 combined read agenda | **Not started** | The contract exists only in `docs/plan/2026-09-03-jarvis-roadmap.md` R6 item 4 and `docs/plan/2026-09-15-school-university-plan.md` step 7: one read view for school, applications and personal commitments. No personal-calendar source module exists. |
| R7 | **Not started** | Existing project polling, digest, capacity telemetry and memory contracts are reusable seams, not an R7 implementation. |

## 3. Review-gated slices

Expected files are a review boundary, not permission to expand scope. Every
slice is one PR, stays in one builder chat through fix rounds, and receives
fresh independent review. W3 and W6 are **max** because they carry migrations
that cannot be eligible for later owner application without that depth. Max is
also recommended for W4 because it combines OAuth scopes with untrusted mail
and document text, and for P2b because it activates paid routes. All remaining
slices are **xhigh**. A discovered schema gap stops the current slice
instead of acquiring a migration incidentally.

The roadmap names only R2 and R5 as R7 dependencies, but the current slice
graph adds a transitive R3/R6 dependency: W5 and W6 consume R6 item 4's
combined read agenda, W7 composes them, and R6 itself depends on R3. Sid must
confirm one roadmap treatment before those slices build; this plan does not
choose it silently:

1. Split R6 item 4 into a cloud-side, read-only personal and school agenda
   slice that does not wait on R3, as an explicit roadmap change; or
2. For W5's first version, source class occurrences from the R5 Classroom and
   Brightspace feeds. This can unblock the pre-class exit proof, but it does
   not remove W6's combined-agenda dependency.

### Can start before R2 finishes

| Slice | Scope and expected files | Migration | Focused proof and exit | Exact upstream dependency |
|---|---|---|---|---|
| P1. Third-party minimisation contract | Add a versioned allowlist, purpose, retention and redaction decision for email, Drive, pages and PDFs. Expected: `src/policy/third-party-data-minimisation.ts`, focused tests and `docs/policies/third-party-data-minimisation.md`. Retrieved text stays quoted data. | **No.** | Tests refuse extra fields, unknown purpose, unbounded text and secret-shaped material. Mutations remove the field allowlist, retention bound, provenance or untrusted-data marker. Exit: fake Gmail/Drive/page/PDF inputs produce only the bounded metadata, pointer, extracted text and receipt the declared purpose needs. | **None:** independent of R2, R5 and R6; it must land before any R7 connector. |
| P2. Provider-neutral per-task routing seam | Add task classes, provider-qualified route descriptors, configurable base URLs and an injected router over fake adapters; do not enable Claude, GPT or a local route. Expected: `src/model/task-router.ts`, `src/model/model-route-policy.ts`, provider factory, fake adapters and focused tests. | **No.** | Tests pin the chosen task class, endpoint, cancellation, timeout, explicit unavailable state and no silent fallback after a paid provider starts. Mutations hard-code DeepSeek, route every task to the expensive tier, change the requested task class or enable fallback without approval. Exit: fakes prove deterministic routing and cost projection without a provider call. | **None:** uses the merged `ModelAdapter` seam; it does not wait for R2. Paid or local activation waits on gates D2 and D5. |
| P2b. Reviewed route activation | After Sid chooses a provider-qualified model and cap, add only the selected adapters and task policy. A local outage route remains absent unless D5 separately authorizes its host. Expected: the P2 factory/composition, chosen provider adapter, `src/env.ts`, owner runbook and focused mocked-HTTP tests. **Max review is recommended** before paid-route activation. | **No.** | Tests refuse missing cap/price/base URL, keep cheap and reasoning tasks distinct, prevent mid-stream failover, and preserve cancellation and output bounds. Mutations drop the cap, projected-cost acknowledgement, task class or provider qualification. Exit: the reviewed configuration selects the approved route under fakes; enabling secrets and live traffic remains owner work. | P2; **no R2/R5/R6 dependency**. Gates D2 and, only for a local route, D5 must be answered first. |
| P3. KNOWN_ISSUES/DECISIONS change pings | Use the existing project poll result to enqueue one owner notification for a later change to either attention document. Expected: `src/projects/project-change-notifier.ts`, `src/jobs/job-table.ts` and focused project/job tests. First observation establishes a baseline rather than paging four files. | **No:** reuse observation ids and the existing delivery/outbox boundary. If it cannot provide durable idempotency, stop and propose a separate next-free migration. | Tests distinguish changed, deleted, unchanged, first-observed and failed polls; retry does not double-notify; excerpts are neutralized. Mutations remove the path filter, first-observation guard, idempotency key or failure distinction. Exit: the same successful poll that records one later `KNOWN_ISSUES.md` or `DECISIONS.md` change queues exactly one owner ping. | **None:** extends the merged R0 `ProjectPoller`; it does not wait for R2, R5 or R6. The notification SLO remains an open question below. |
| P4. Sunday workload and cost lines | Derive workload from existing deadline/catch-up evidence and read current D1, R2, model and voice capacity observations through an injected cost-snapshot port. Extend the existing `retro` digest kind: `src/digest/digest-composer.ts` and `src/jobs/digest-job.ts` already take `kind: "daily" \| "retro"`, so this adds no second weekly job. Expected: `src/manager/workload-trend.ts`, `src/manager/cost-tracker.ts`, those existing digest files and focused tests. Do not call a new provider. | **No:** this first line is a deterministic read over existing records/telemetry, not a new billing ledger. | Tests cover rising/falling/flat workload, stale or partial sources, prepaid balance versus spend, postpaid usage and missing configuration. Mutations remove freshness, invert a trend, turn unavailable into zero or label remaining credit as cost. Exit: the Sunday retro contains one workload line and one cost line, or names exactly which source is unavailable. | R5 step 3, **Deadline feeds and digest** (merged through PRs #43, #49 and #51). R5 step 4 may enrich the line after #53 merges but is not a blocker. R2 memory cost joins only after R2 **Automatic distillation and filing** lands. |

### Must wait for named upstream work

| Slice | Scope and expected files | Migration | Focused proof and exit | Exact upstream dependency |
|---|---|---|---|---|
| W1. Typed profile and observed-pattern proposals | Build a deterministic profile view over eligible memory and a nightly idempotent job that proposes, but does not activate, repeated patterns. Keep stated, observed and inferred entries separate. Expected: `src/memory/profile-types.ts`, `profile-view.ts`, `profile-proposals.ts`, `src/jobs/profile-job.ts` and focused tests. | **No planned migration:** use `0016` items, sources and cursors. A missing invariant stops the slice for a separately reviewed next-free migration. | Tests pin exact evidence, repetition thresholds, proposal idempotency, conflicts, corrections and suppression. Mutations promote one observation, drop uncertainty, accept third-party repetition or ignore a forget. Exit: each profile entry has state and dated sources; observed patterns remain uncertain proposals; shared explain/forget controls work on the item. | R2 **Automatic distillation and filing**, then R2 **Unified Telegram text recall and plain-speech controls**. The merged repository and owner controls are necessary but insufficient. |
| W2. Profile-driven digest time, quiet hours and style | Map only active eligible profile facts to bounded behavior. Expected: `src/memory/profile-behavior.ts`, digest/scheduler composition and focused tests. Style never changes authority or quoted evidence. | **No.** | Tests cover Toronto DST, conflicting/current versions, uncertain/forgotten/suppressed items and owner correction. Mutations remove the eligibility join, suppression check, bound or timezone conversion. Exit: an owner-confirmed change affects the next computed behavior; forgetting it restores the safe default immediately. | W1 plus R2 **Unified Telegram text recall and plain-speech controls**. |
| W3. Provider-neutral page/PDF/document ingestion | Add a canonical document catalog, immutable extraction receipt and bounded text/pointer ingestion. Binaries stay by pointer; D1 remains authoritative for text, provenance, state and suppression. Expected: `src/memory/document-*`, parser/adapter ports, one migration candidate and focused migration/runtime tests. **Review: max.** | **Yes:** one additive migration using the **next free number at build time**; never a number named by this plan. | Tests prove exact source hash/time/pointer, principal isolation, transactional ingestion, re-ingestion, bounds, malicious text handling, suppression and missing-source reporting. Mutate every new trigger plus source hashing and principal filters. Remote-D1 syntax tests are mandatory. Exit: fake page/PDF inputs are searchable with exact receipts and cannot authorize a fact or action. | P1 plus R2 **Archive-complete literal history and coverage** and R2 **Automatic distillation and filing**. It waits for the active `0025` slice to settle its source-reference contract. |
| W4. Gmail/Drive read-only ingestion and inbox triage | Compose least-privilege clients into W3. Triage ranks and explains; it does not send, delete, archive, label or contact anyone. Expected: `src/ingestion/gmail-client.ts`, `drive-client.ts`, `inbox-triage.ts`, scheduled job, owner runbook and focused tests. **Max review is recommended** for the OAuth and untrusted-content boundary. | **No planned migration:** reuse W3. Stop on a schema gap. | Missing/partial configuration makes no request and is visible. Tests cover pagination, redirects, bounded bodies, duplicate messages/files, prompt injection, source deletion and triage evidence. Mutations remove owner/principal binding, scope preflight, minimisation or no-write enforcement. Exit: fakes import and triage bounded items with receipts; live OAuth and account acceptance remain separate. | W3 and R2 **Unified Telegram text recall and plain-speech controls**; owner gate D1 must choose consent and exact scopes first. R5 step 6, **Full application and document workflow**, is a consumer after #52 clears. |
| W5. Class and meeting prep briefs | Produce a deterministic sourced brief ahead of a class or meeting, with missing/stale sources named. Expected: `src/briefs/prep-brief.ts`, brief job/delivery composition and focused tests. A model may polish only an already bounded, quoted record. | **No planned migration:** reuse scheduled-run/outbox idempotency. | Tests cover reschedule/cancel, one brief per occurrence, late source updates, incomplete agenda, suppressed memory and untrusted document text. Mutations drop occurrence identity, freshness, suppression or source labels. Exit: fake time delivers one cited class brief before the event and one meeting brief without sending to attendees. | R5 step 4, **Study coach**; R5 step 6, **Full application and document workflow** where applicable; W4 for mail/document context; and the class-occurrence path Sid confirms above: R6 item 4, **combined read agenda**, or R5 Classroom/Brightspace occurrences for W5's first version. |
| W6. Reversible tier-2 calendar writes and focus blocks | Add a provider-neutral write port, shadow mode, protected-block policy, durable action receipt and explicit inverse operation. Never invite or notify another person automatically. Expected: `src/calendar/calendar-write-service.ts`, provider adapter, policy, runbook, tests and one migration candidate. **Review: max.** | **Yes:** action/reversal/idempotency state uses the **next free number at build time**. | Tests prove shadow mode writes nothing; create/move/cancel reverses; replay is idempotent; protected blocks survive conflicts; stale reads refuse; invitations and non-owner calendars require a tap. Mutations remove tier, owner, protection, inverse or idempotency checks, plus every trigger mutation. Exit: a fake provider shows the proposed change, applies only an approved reversible action and restores the prior state from its receipt. | W6 **is the write half of R5 step 7**, not a dependency on that step. Its read-side prerequisite is R6 item 4, **combined read agenda**; owner gate D3 must choose provider and write tier first. Unless Sid confirms the cloud-side split above, this transitively waits on R3 through R6. |
| W7. Release composition and live exit | Compose only independently cleared heads, update acceptance/runbooks, and run the quoted exit without broadening it. Expected files are limited to composition, acceptance tests and status docs named by the preceding slices. | **No new migration:** all required schema must already be reviewed and owner-applied. | Integrated tests keep evidence, uncertainty, no-send/no-spend and all-PCs-off behavior intact. Mutations remove the dated receipt, pre-class timing, workload line or cost line. Exit: local gates pass, Claude Opus 5 xhigh clears the exact head, then Sid separately runs the verbatim R7 exit. | R2 **Rollout and live acceptance**; R5 steps 4 and 6; R6 item 4; and P1, P2, P2b, P3, P4 and W1-W6 as applicable. W6 supplies R5 step 7's write half. Because W7 composes W5 and W6, this path transitively waits on R3/R6 unless Sid confirms the dependency treatment above. |

## 4. Owner decision gates

These are explicit stops, not defaults. A repository statement attributed to
Sid is evidence to bring to him, never proof of authorization.

| Gate | Sid must decide before the affected activation or build |
|---|---|
| D1. Gmail and Drive | Which Google account, whether to consent at all, the exact reviewed read-only Gmail and Drive scopes, and whether either source may be retained beyond remote pointers. A later mailbox-write scope is a different decision. |
| D2. Paid model route | Which current provider-qualified candidate, tasks allowed to use it, and a hard monthly cap. Compare current candidates on sanitized samples with current reviewed prices before Sid decides; no model is the default. No paid comparison or switch happens from this plan. |
| D3. Calendar | The provider, account/calendar, whether writes are enabled at all, the tier, shadow duration and focus-block rules. Only reversible tier-2 changes are eligible; invitations or notifications to others stay behind an explicit tap. |
| D4. Receipt photos | Whether this offered-but-not-chosen feature enters R7, what originals are stored, where, encryption/retention/deletion rules, extracted fields and whether financial categorization is in scope. |
| D5. Hardware or subscription | Any new hardware, local-model host, paid plan, subscription or quota increase. A prior plan's attribution is not approval. The all-PCs-off cloud path must work without any of them. |

## 5. Boundaries inherited by every slice

- Owner-only authority is checked at ingress and again at the capability.
- Anything stored or presented as fact carries exact, dated evidence; source
  text is quoted untrusted data, never an instruction.
- Guesses and observed patterns stay visibly uncertain and cannot authorize
  behavior, tools, reminders, messages, money, deletion or production work.
- Nothing sends, spends, submits, signs up, releases data or contacts another
  person without Sid's explicit tap.
- Calendar writes are reversible, receipt-backed tier-2 actions only;
  irreversible or attendee-visible effects require a separate tap.
- The product remains phone-first with every PC off. There is no Linux host and
  no R7 dependency may introduce one.
- Cloud memory stays D1-authoritative under the R2 design; indexes and binary
  pointers are rebuildable or external, never the sole fact/receipt copy.
- New remote-D1 trigger guards use only
  `SELECT RAISE(ABORT, '...') WHERE <condition>;`, and every clause is mutation
  tested.
- PC hardware, purchasing, Blender and Roblox content remain outside this
  repository, its commits and its pull requests.
- Migration names are never reserved in a plan. A build slice audits main,
  open PRs, unmerged branches and the mailbox immediately before selecting the
  next free number.

## 6. Catalogue items held outside the authorized build

| Item | Disposition |
|---|---|
| Receipt and expense capture by photo | The feature catalogue says **offered and not chosen**. It gets no slice until D4 is answered. If selected, it follows P1 and W3 in its own reviewed PR and uses the next free migration only if the approved storage contract requires one. |
| End-of-day report across machines and projects | Also **offered and not chosen**. A cloud-only project/school report could reuse P4, but “across machines” additionally depends on R3 device telemetry, which R7's stated R2/R5 dependency does not provide. Sid must choose the outcome before it is scheduled. |

## 7. Risks and open questions

- R2 archive coverage, automatic distillation, Telegram controls and rollout
  are unfinished. R7 must consume their reviewed contracts rather than create a
  second memory path.
- PRs #52 and #53 are open with requested changes, and active `0025` work is
  unpublished. Their schemas and interfaces may move before R7 builds.
- “Real-time” needs an SLO. The safe first slice notifies in the same successful
  project poll; true push delivery would require a separately reviewed webhook,
  authentication and replay design.
- Existing capacity observations are not invoices. The cost line must label
  measured spend, inferred prepaid use, configured cap and unavailable data
  distinctly.
- The roadmap says R7 depends only on R2 and R5, but W5 and W6 consume R6 item
  4, W7 composes them, and R6 depends on R3. The current full v1.6 path
  therefore waits transitively on R3 and R6. Sid must confirm either a roadmap
  change that splits the cloud-side read-only agenda from R6 so it does not
  wait on R3, or an R5 Classroom/Brightspace occurrence source for W5's first
  version. The second option can prove the pre-class exit earlier but does not
  silently remove W6's combined-agenda dependency.
- Gmail and Drive scopes may be restricted or require Google verification.
  Failure leaves owner-provided data visible; it does not justify broader
  scopes, browser automation or a copied session.
- Document forget hides Jarvis retrieval; it does not erase a remote Gmail or
  Drive original. Receipts must state that boundary.
- Calendar providers differ on recurrence, attendees, notifications and undo.
  No provider is “reversible” until the adapter proves the exact inverse for
  each enabled operation.
- The roadmap mentions a local model as an outage fallback, but a local-only
  route cannot satisfy the all-PCs-off requirement. It may be opportunistic
  only after D5; it can never be the sole fallback for the phone path.
- The roadmap's three-to-four-session estimate predates the review-gated R2/R5
  work now in flight. Slice integrity and independent review take precedence
  over that estimate.
