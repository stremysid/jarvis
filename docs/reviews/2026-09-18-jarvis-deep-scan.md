> **Landing note, added when this audit was committed. Not part of the audit;
> the body below is unedited.**
>
> This is a snapshot. The revision it names in §0 is no longer main, and two of
> its environmental facts have since moved — so treat every number here as
> "true when written" until you re-derive it:
>
> - **`main` is not `d72ece5`.** As of 2026-09-18 it is `c82bfc0`. Query it
>   rather than trusting either number: `git log --oneline origin/main -1`.
> - **`git fetch` now succeeds on this machine.** §0 records it failing with
>   `SEC_E_NO_CREDENTIALS`; that is no longer reproducible.
> - **§0's production facts were relayed by the reviewer, never observed by this
>   audit.** The audit says so itself, and it remains the one class of claim
>   here that no reader can re-derive from the repository.
>
> Findings that were fixed after this snapshot are not marked fixed here.
> [docs/HANDOFF.md](../HANDOFF.md) is current state; this file is the record of
> what was true when it was written.

# Jarvis deep scan — 2026-09-18

A read-only audit of the Jarvis repository, produced for handoff. Two passes:
a general look (repo shape, docs-vs-reality), then a deep scan across four
axes chosen to attack the failure class this project has already proven it
cannot see.

**Everything here is a finding, not a fix.** No file was created, edited,
run, deployed, migrated or queried to produce it.

---

## 0. Scope, revision, and method

| | |
|---|---|
| Working tree | `832b1e8` (working tree revision at time of scan) |
| Current main | `d72ece5` (PR #91 merge) — its files read via `git show d72ece5:<path>` |
| VCS state | Clean except untracked `.venv-jarvis/`. Local checkout is one merge behind origin; `git fetch` fails on this machine with `SEC_E_NO_CREDENTIALS` |
| Method | File reads, `git` inspection, GitHub API, fetched specs. **No suites, no builds, no `wrangler`, no production queries** |
| Production facts | Supplied by the reviewer, not observed by this audit (see §9) |

### Evidence tags used throughout

- `[M]` — verified by the auditor personally, first-hand
- `[R]` — read by a surveyor subagent, **not** re-verified by the auditor; treat as a lead
- `[X]` — external source fetched and cited
- `[I]` — inferred

### What this audit cannot establish

Stated plainly, because overclaiming is the failure this repository documents
best:

- Nothing requiring live Cloudflare, Twilio, DeepSeek or Workers AI behaviour.
- Nothing concurrency-dependent. D1 has no local multi-isolate equivalent, and
  several `KNOWN_ISSUES.md` entries are exactly this class.
- **Absence of a bypass.** Inspection finds guards with no test that names
  them; it cannot prove a mutation survives.
- It does not replace the mutation sweeps. **Inspection narrows the search;
  mutation and execution prove.**

---

## 1. Repository shape (general look)

| Piece | Files | Lines | Notes |
|---|---|---|---|
| `apps/cloud-gateway/src` | 165 `.ts` + 32 `.sql` | 63,353 TS + 11,170 SQL | 25 modules; `memory/` is 22% of it |
| `apps/cloud-gateway/test` | 178 test files | 76,562 | 2,418 `it()` cases — more test code than source |
| `apps/local-agent` | 58 `.py` | 9,261 | ruff `ANN`+`S`, mypy **strict** with `warn_unreachable` |
| `apps/hermes-runtime` | 27 | 8,830 | attestation / SBOM / lock tooling |
| `apps/watchdog` | 9 | 1,328 | honours the no-gateway-import rule |
| `apps/brain-bridge` | 4 | 975 | strict shared contracts; **stalled mid-build**, see §4 D-7 |
| `packages/contracts` | 9 | 1,014 | ULIDs, timestamps, hashes, redaction patterns |

989 commits. 32 D1 migrations, `0001`–`0032`, **no gaps, no duplicates**.
`VERSION` 0.1.0.

### Genuinely strong, and worth saying plainly

- **Zero** `TODO`/`FIXME`/`HACK`, **zero** `@ts-ignore`, **zero** `any` in
  gateway `src/`, **zero** `.only`/`.skip` in the TypeScript suites. The only
  `TODO` substring hits are iCalendar `VTODO` literals.
- **The honesty culture works.** `KNOWN_ISSUES.md` is the strongest document
  in the repo — it records where guarantees are weaker than their names.
- **Database-enforced invariants** are real across all 32 migrations, not
  aspirational.
- **Watchdog isolation is genuinely honoured** — all 15 imports are relative
  `./`; `package.json` declares no dependencies.
- **Secrets hygiene is clean.** Nothing credential-shaped is tracked;
  `.gitignore` is sensible; no leaked values found.

### Corrections to commonly repeated claims

| Claim | Reality |
|---|---|
| `ARCHITECTURE.md` "the 13 migrations" | **32 files** on disk. `0001`–`0013` is exactly 13, so this was true once |
| `README.md` "Three pieces" | A four-row table follows; `apps/brain-bridge` is missing entirely |
| `README.md` slash commands (6) | Parser handles **9** — `/help`, `/call`, `/disable-owner-step-up` undocumented |
| `README.md` "full-text and vector search, both local" | Local vector index is never consulted by retrieval. (The *cloud* does now do real Vectorize semantic search — so the claim is wrong in the opposite direction from the one documented) |
| Test-typecheck count | `KNOWN_ISSUES.md:400` correctly says **122**; `KNOWN_ISSUES.md:718,727`, `AGENTS.md:54`, `TESTING.md:44` still say **117**. No CI gate exists |
| Transcribed copies "two files" | At least **five**, including **three** canonical-JSON implementations with the same failure string |

---

## 2. CI is dead, and it was the only gate of its kind

The last green run on `main` was **2026-09-12** (`34690210148`). Every push
since fails in 3–7 seconds:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

All seven jobs — `workspace suite`, both `local-agent` platforms,
`hermes-runtime` — never start. `docs/HANDOFF.md` predicts this (2,000/2,000
minutes, $0 budget, resets 2026-10-01) and records that the owner will not
raise it. That is a decision, not an oversight.

**What that actually removed**, which is worse than "no green tick":

- `apps/local-agent` and `apps/brain-bridge` have **no `package.json`**, so
  `pnpm lint`/`typecheck` never reach them. **CI was the only place `ruff` and
  `mypy --strict` ran** for 9,300 lines of Python.
- `pnpm typecheck` (gateway) ran only there.
- `brain-bridge`'s 18 tests run **nowhere at all**.
- `ci.yml` excludes `source-lock.test.mjs` and
  `workflow-containment-review5.test.mjs` — the two largest test files in the
  repo, both security tooling — from PR CI. `HANDOFF.md` records the manual
  extended suites as "not run".
- `pnpm test:all` is `pnpm test && pnpm test:runtime && pnpm test:watchdog`;
  it short-circuits at the gateway, so runtime and watchdog never execute.
  **4 security tests are red on `main`** (`sbom-integrity-round2` ×2,
  `sbom-security-review3`, `source-lock`), failing unseen.

**Cheapest real fix:** a `package.json` in the two Python apps so
`pnpm lint`/`typecheck` cover them locally, plus a pre-merge checklist naming
the exact commands.

---

## 3. Documentation vs reality

### The documents labelled "load-bearing" are the ones that rotted

`README.md:79` promises every project keeps four documents accurate. Two
are not:

- **`CHANGELOG.md` frozen at 2026-09-06** — 11 days and 33 PRs behind.
- **`docs/HANDOFF.md` says "Current as of 2026-09-16"** but the highest PR it
  names is **#59**; HEAD is the merge of **#92**. PRs #60–#92 are absent.

The real current state lives in `docs/AGENT_LOG.md` — now **12,078 lines**,
a builder↔reviewer mailbox that became the state of record by accident. The
document `docs/continuity/README.md` defers to for "current state" (HANDOFF)
is the stale one.

### Other verified drift

- `NEXT_STEPS.md` claims migration `0020` for both PR #45 (`:27`) and "main"
  (`:69`), and `0022` for both PR #48 (`:33`) and "main" (`:69`) — in one file,
  ~40 lines apart. It calls `0024`/`0026` "reserved/next free"; both are merged.
- `docs/runbooks/migration-scratch-proof.md` pins a candidate range ending at
  `0025`; disk is at `0032`.
- Spot-checking 12 `path:line` references: **7 had drifted.** One research
  factcheck table marks a citation "Verified" whose line numbers point at
  unrelated code.
- `KNOWN_ISSUES.md` says "No migration after `0015` has been applied" and
  `HANDOFF.md` says "migrations through 0015". **Both are stale** — see §9.

### A structural finding about citations

With **25 registered git worktrees**, one symbol resolved to **14 different
line numbers** across checkouts (verified by sweeping every worktree for
`void quiet;` — lines 190, 194, 200, 217, 228, 234, 288, 289, 337, 338, 355,
405, 422, 434). A bare `path:line` is therefore **ambiguous at a single
instant**, not merely drift-prone over time.

`git worktree prune` removes none of them — all 24 directories still exist.
The cheap permanent fix is revision-pinned citation: **symbol + "as of
&lt;sha&gt;"**, never a bare line number. (Accepted by the reviewer as a standing
rule for this project.)

---

## 4. Findings ledger

Severity is the auditor's calibration. Where it differs from a surveyor's,
the difference is stated.

### A. Authority and provenance — *who is allowed to act*

| ID | Finding | Symbol | Sev | Ev |
|---|---|---|---|---|
| A-1 | **The pipeline tools use the weaker of two authority markers.** `isDirectOwnerText` requires `!containsQuotedOrPastedControlContent`; `directPipelineText` omits it. A multi-line paste of third-party text is `directOwnerText=false` but `directPipelineText=true`, and school/university/study-coach run with `ownerTurnAuthoritative: true` and `requireDirectOwnerText: false`. The source comment calls the strong marker *"narrower authority used only by plain-speech memory controls"*. **This is the structural cause of the `submitted_by_sid` symptom already recorded in `KNOWN_ISSUES.md`** ("Mom emailed Dr. Shah that I submitted the Western essay"), which that entry attributes to the model's verb list. | `telegram-types.ts`, `index.ts`, `owner-telegram-agent.ts` | **High** | `[M]` |
| A-2 | **The announced tier-3 backstop is unwired.** `AutonomyService.evaluate` has no caller anywhere in `src`; `decideOutcome` is called only from `evaluate`; the only other `capability_tiers` references are its own repository's `SELECT` and the backup inventory. `ARCHITECTURE.md` rule 4 calls tier 3 *"the backstop that holds after everything else fails… the control that still works when a prompt injection has successfully steered the model"*, and `README.md` advertises "tier 3 never runs without Sid confirming". **Neither is true of the running code.** Real protection is per-feature — the outbound-call policy engine is sound — so the next feature inherits nothing. | `autonomy/*` | **High** | `[M]` |
| A-3 | **D2L authenticity: a forged pinned `DKIM-Signature` is trusted when the MTA is merely silent about that domain.** Send a message *validly signed by your own domain* (MTA honestly records `dkim=pass header.d=evil.com`, no failure), then append a second unverified `DKIM-Signature: d=<pinned>`. `contradicts` tests only for failure *for that specific domain*, so there is nothing to contradict and the forged signature is trusted. Reaches `DeadlineIngestion.ingest` and `ingestD2lEmailGrade`. `From:` and the recipient are sender-writable filters the module itself says "authorise nothing on its own". | `d2l-email-authenticity.ts` | **High** | `[M]` code path, `[R]` attack |
| A-4 | **`evaluated = mine[mine.length - 1]` selects the last group claiming `mx.cloudflare.net`.** The guard accepts a group as "the receiving MTA's own" purely on a text string any sender can write, then takes the **last** one. **RFC 8601 §4.1 is explicit that this header "MUST be prepended to the message"** — so the MTA's group is *first* and the sender's forged group is *last*. The code comment asserts the reverse ("a sender writes its headers before the MTA appends its own"). | same | **High** | `[M]` + `[X]` |
| A-5 | Unauthenticated input triggers hard `DELETE` of quarantined mail evidence via `pruneQuarantined`. Bounded (newest 5, 30 days) and quarantine-scoped, but unconfirmed and untiered. `delete.data` is tier 3. | `d2l-email-repository.ts` | Medium | `[M]` |
| A-6 | 60-second step-up window mints ~30 minutes of authority: `expires_at` = `provider_connected_at + 1800s`, fixed by the carrier's clock. No input extends it; this is a scope mismatch between the window and what it is assumed to bound. | `0018`, `voice-access-repository.ts` | Low-Med | `[R]` |
| A-7 | Dormant `waive_on_passed_a` waiver grants everything except `access.manage` — `requireOwnerStepUpVerified` is called only for that capability, so a waived call gets conversation, memory, calendar, files and `communications.send`. Fail-closed by default (`undefined => passphrase_always`). | `owner-call-step-up.ts` | Medium | `[R]` |
| A-8 | No global rate limit on owner-passphrase guessing; the attempt budget is guest-only. ~33 bits of entropy makes it impractical. | `inbound-auth.ts` | Low | `[R]` |

**The test that settles A-3/A-4** (the only items here that could be a *live*
bypass rather than a structural gap): send to the ingest address a message
with pinned `From:`, **no valid DKIM**, and a literal header

```
Authentication-Results: mx.cloudflare.net; dkim=pass header.d=<pinned>; spf=pass; dmarc=pass
```

positioned so the MTA's own group precedes it. If the receipt records
`path: "cloudflare-dkim-pass"` and the deadline/grade is written, the guard is
inverted. If it quarantines `authentication_unproven`, Cloudflare strips
same-authserv-id forgeries (RFC 8601 §5 makes that a MUST) and the finding
closes. **Note:** there is already instrumentation — `logHeaderNames` records
header names and stored `authentication_records` retain bounded values, so
the first live message answers the ordering question.

### B. Suppression and redaction — *what may be recalled*

| ID | Finding | Symbol | Sev | Ev |
|---|---|---|---|---|
| B-1 | **"Forget" does not apply to voice.** `conversation/context-retriever.ts` has **0** references to suppression/forgotten; `memory/telegram-memory-retriever.ts` has **65**. Voice wires the shared `D1ContextRetriever`, whose history arm has no anti-join against `memory_event_suppressions` — the `memory_visible_recent_events` view from `0016` exists and is unused here. **A fact stated on a call and forgotten by voice is re-fed to the model on the next call.** | `context-retriever.ts` | **High** | `[M]` |
| B-2 | **The guest PIN is four digits and no redaction pattern matches four digits.** `AUTHENTICATION_DIGITS = /(?<!\d)\d{6}(?!\d)/g` (exactly six); `CONTEXTUAL_EIGHT_DIGIT_AUTHENTICATION` (exactly eight after pin/passcode/otp); `CREDENTIAL_ASSIGNMENT` does not cover `pin`. *"My pin is 4821"* reaches the D1 `conversation.user_committed` payload and model context unredacted. The DTMF field marker cannot fire because keypad digits never enter the text path. | `packages/contracts/src/calls.ts` | **High** | `[M]` |
| B-3 | D2L ingestion runs **no redaction at all**: `Redactor` is never invoked, `structured_json` and `raw_mime_base64` (~700 KB) are written raw, and an authentic `address_verification` message persists a **live code** and pushes it to Telegram. | `d2l-email-handler.ts`, `d2l-email-repository.ts` | **High** | `[R]` |
| B-4 | Projection facts are a second copy outside the suppression span — `memory_fact_projection_{heads,pages,facts}` has no suppression reference on commit or read, so a fact distilled from a later-forgotten turn survives. | `memory-projection.ts` | **High** | `[R]` |
| B-5 | Projection redacts `fact.text` but not `sources[].excerpt`, which lands in `sources_json` + FTS and is only rejected at retrieval. | same | Medium | `[R]` |

Vault observations: redaction explicitly does not run and is not relied on.
The only cloud path is fact projection, where
`projection_policy.redaction_would_change` **refuses** a secret-bearing fact
rather than rewriting it — a gate, not a redactor, hand-kept in step with
`calls.ts` across two runtimes.

### C. Observability — *does broken look broken*

Rule 1 of `ARCHITECTURE.md`: *"Silence and success must never look the same."*

| ID | Finding | Symbol | Sev | Ev |
|---|---|---|---|---|
| C-1 | **`/status` is structurally incapable of reporting failure.** `scheduled_runs` has **no detail column** — `UPDATE scheduled_runs SET finished_at = ?, failure = NULL` on success, and `SELECT run_key, started_at, finished_at, failure` — so every `ok:true` detail is discarded. And `/status` iterates only `["drain","poll","digest"]`. **Consequence: a failed nightly `backup` run was never shown at all**, consistent with `memory_backup_runs` holding 0 rows and `last_verified` never. The module's own header states this rule: *"'Not set up yet' and 'nothing to report' must never look the same."* **This is the highest-leverage fix in the audit: one column, one job list.** | `scheduled-run-repository.ts`, `command-handler.ts` | **High** | `[M]` |
| C-2 | A missing credential is reported as **success**: `return { ok: true, detail: "…project poll not configured" }`. `ok:true` means `scheduled_runs` records a successful run, **a watchdog heartbeat is sent**, `/status` says `poll: ok` — and per C-1 the detail is then thrown away. Directly violates rule 1's *"a component that has never run reports 'never run', not 'ok'."* | `jobs/job-table.ts` | **High** | `[M]` |
| C-3 | A missing `DEEPSEEK_API_KEY`/`TELEGRAM_BOT_TOKEN` makes Jarvis **silently ignore Sid**: a bare `return` in `replyTo` before any log or notice — while the cron path in the *same file* throws `"TELEGRAM_BOT_TOKEN is not set"` loudly. `telegramSender` returns `null` for the same reason; `answerFromTap` returns after the decision was already written. | `index.ts` | **High** | `[M]` |
| C-4 | **Never-run state gated on a row only success creates** — three instances of one bug. (a) The digest's Classroom "has never completed a submission scan" branch is guarded by `classroomSource !== undefined`, but the source row is created only on a successful sync. (b) D2L's `pushSourceGap` "has never received a message" is unreachable before the first mail, because `ensureSource` runs only inside the handler and `0033` seeds no row — **a deleted Email Routing rule or a toggled-off D2L notification reads identically to a quiet term, permanently.** (c) The GitHub poll, C-2. | `digest-job.ts`, `d2l-email-handler.ts` | **High** | `[R]` |
| C-5 | `attentionChanges` has **no production caller** (only `test/projects/project-poller.test.ts` imports it) and `changedDocuments: []` is hardcoded with a comment claiming the poller "already reports changes as they happen". The digest's `` `${changedDocuments.join(", ")} changed` `` branch is dead code — **a new KNOWN_ISSUES entry and an untouched repository produce the same digest line.** | `project-poller.ts`, `digest-job.ts` | **High** | `[R]` |
| C-6 | Twilio `createCall`: **every** fetch rejection (DNS/TLS/reset/hung) → `ProviderDispatchUnknownError`. "Never landed" and "may have landed" produce the same owner sentence, with no reconciliation job. | `twilio-provider.ts` | **High** | `[R]` |
| C-7 | Voice route construction failure → `catch { routes = unavailableRoutes; }`; every Twilio webhook then 403. A malformed `PUBLIC_ORIGIN` is indistinguishable from an auth refusal, and there is **no `console.*` anywhere** in the voice routes. | `production-routes.ts` | **High** | `[R]` |
| C-8 | Delivery `timeout` → terminal `delivery_unknown`; the reply is dropped with no notice. Separately, `retry_wait` rows appear never to be reclaimed: `conversation_deliveries` is named **nowhere** in `jobs/` or the scheduler (only repository/retriever/backup code) — consistent with no drain, but a repository-mediated drain is not excluded by that grep. | `conversation-repository.ts`, `outbox-dispatcher.ts` | **High** | `[R]`, partial `[M]` |
| C-9 | Backup `alert` swallows claim and send throws — no record, no log, no owner message, on the path whose entire job is alerting. | `memory-backup.ts` | **High** | `[R]` |
| C-10 | `emptySweep` is computed and read by **nothing** — the one flag separating "the term ended" from "the feed went quietly empty". | `deadline-ingestion.ts` | Medium | `[R]` |
| C-11 | Per-project `pollFailure` lines sit in the **unprotected** "Projects" section, so a repository that could not be read can be trimmed from the digest. When protected content alone exceeds 4096, `fit` returns an over-long message and `sendMessage` throws permanent `output_limit` — the whole digest is lost. | `digest-composer.ts` | Medium | `[R]` |

Also recorded: a GitHub token that has lost contents access reads as a healthy
quiet project (all four documents 404ing produces a *successful* observation
with zero documents and `healthOf` → `"ok"`), and semantic-recall death is
dressed as backfill lag (`/status`'s `{missing}` count *rises* while the
indexer is dead).

### D. Latent tripwires and unpinned guards

| ID | Finding | Sev | Ev |
|---|---|---|---|
| D-1 | **`MEMORY_DISTILLATION_D1_STATEMENT_ALLOWANCE = 4_500`** against the documented **1,000** Workers Paid cap (verified against Cloudflare's limits page) and against the project's own recorded design intent ("its 1,000-statement allowance") and a reviewer instruction to stay under 1,000. Step 0 is untrimmed: the `availableForStep` trim sits inside `if (step > 0)`. No test pins either number — the nearest inject 3,700 and 4,100 and assert only an "allowance reached" string. **Latent: production distillation is provider-disabled, so this arms the moment a paid provider is approved.** | **High (latent)** | `[M]` + `[X]` |
| D-2 | `rebuildVectors: async () => true` — a restore step is a stub, yet the operator reports `outcome: "complete"`. **Graded Medium, not High:** it is documented in-place and a runbook guard blocks promotion. What survives is that the result object claims success for a no-op. Note this is the restore path for a backup that had never once succeeded, so nothing has exercised it in production. | Medium | `[M]` |
| D-3 | Archive seal budget pinned to the **Free-tier 50** while the account is Paid, with a test *named* "the 50-query free-tier budget" — safe, but the ceilings are not coherent. | Medium | `[R]` |
| D-4 | `MAXIMUM_D2L_EMAIL_BYTES` (512 KiB) justified in a comment by "the backup service's hard 1 MiB **single-row** ceiling", while `encodeRows` enforces 1 MiB per **object/page** and throws only when the *first* row overflows. | Medium | `[R]` |
| D-5 | `loadDescriptors` now exempts `_cf_` by prefix (PR #92), but no test covers a future **non-`_cf_`** system table — the general form of the outage that killed every backup until 2026-09-17. | Medium | `[R]` |
| D-6 | The PBKDF2 100,000-iteration cap's AST test asserts the code's own constant, so a wrong cap stays green; its provenance is a code comment and nothing else. | Medium | `[R]` |
| D-7 | `apps/brain-bridge` is **stalled mid-build**: 3 commits, all 2026-08-31. The plan lists ~25 further files and none exist; `aiohttp` is declared but `async def` appears **zero** times; `hermes-runtime` schemas require a `launchers/brain_bridge.py` that is absent. Its 18 tests run **nowhere**. It is mentioned in exactly one place: `CHANGELOG.md` — which is frozen. | Medium | `[M]` |

---

## 5. Environment divergence — the axis that produced both shipped defects

Two production defects in 24 hours, both invisible to a fully green local
suite:

1. **PBKDF2 at 600,000 iterations** — Miniflare has no cap; production workerd
   rejects it.
2. **`_cf_KV` unclassified** — the nightly backup had **never once succeeded**,
   because production's schema contained a table the test pool cannot create.

Neither was a logic error. Both were **divergence between the environment the
tests run in and the environment the code runs in.** `KNOWN_ISSUES.md` already
states the rule — tests must assert limits against *documented production
values* — but nothing enforces it repo-wide. The table below is the three
columns requested: documented production value, value the code assumes, value
the test asserts.

| # | Limit | Where (symbol) | Documented production value (source) | Code assumes | Test asserts | Verdict |
|---|---|---|---|---|---|---|
| 1 | D1 statements per invocation — distillation allowance | `MEMORY_DISTILLATION_D1_STATEMENT_ALLOWANCE` | **1,000** Paid ([Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/), fetched; also `AGENT_LOG` M3) | **4,500** | nothing | **MISMATCH** `[M]` |
| 2 | Distillation step ceiling | `AUTOMATIC_DISTILLATION_STEP_LIMITS.d1Statements` | 1,000 | ≈4,311 | circular (compares to itself) | **MISMATCH** `[R]` |
| 3 | Distillation step-0 guard | `distilMemory` — trim inside `if (step > 0)` | 1,000 | step 0 untrimmed | none | **MISMATCH** `[M]` |
| 4 | Archive seal budget | `ARCHIVE_SEGMENT_LIMITS.maxEventCount` | 1,000 Paid / 50 Free | 50 (Free tier) | asserts 50, "free-tier budget" | **MISMATCH** `[R]` |
| 5 | PBKDF2 iterations per `deriveBits` | `deriveChainedPbkdf2Sha256` | "workerd rejects above 100,000" — source is the code comment | 100,000 | re-asserts the code constant | **MATCH**, unprovable `[R]` |
| 6 | PBKDF2 cap provenance | same | **not established** | 100,000 | code value only | **UNKNOWN** `[R]` |
| 7 | Notice drain statements | `GUEST_GRANT_NOTICE_DRAIN_LIMITS.d1Statements` | 1,000 | 95 | pins 95, not 1,000 | **UNASSERTED** `[R]` |
| 8 | Classroom observation budget | `CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET` | 1,000 | 320 | self-referential | **UNASSERTED** `[R]` |
| 9 | University plan batch | `UNIVERSITY_PLAN_D1_STATEMENT_BUDGET` | 1,000 | 96 | none found | **UNASSERTED** `[R]` |
| 10 | Telegram control targets | `TELEGRAM_MEMORY_CONTROL_TARGET_LIMITS` | 1,000 | 384 | none found | **UNASSERTED** `[R]` |
| 11 | Telegram retrieval | `TELEGRAM_MEMORY_RETRIEVAL_LIMITS` | 1,000 | 900 | `< 1_000` — names it | **MATCH** `[R]` |
| 12 | Meaning index step | `MEMORY_MEANING_INDEX_LIMITS.d1Statements` | 264 (`deploy.md`) | 264 | none found | **UNASSERTED** `[R]` |
| 13 | Workers AI texts per call | `MEMORY_MEANING_INDEX_LIMITS.embeddingInputs` | 100 | 100 | asserts 100 | **MATCH** `[R]` |
| 14 | Vectorize mutations | `MEMORY_MEANING_INDEX_LIMITS` | 128 / 2 | 128 / 2 | 128 asserted, 2 not | **MATCH/UNASSERTED** `[R]` |
| 15 | Vectorize id length | `vectorId()` | 64 bytes — comment only | always 64 | nothing rejects 65 | **MATCH (comment-sourced)** `[R]` |
| 16 | Vectorize metadata index | metadata written | `principal` only (`deploy.md`) | 4 fields written | none | **UNASSERTED** `[R]` |
| 17–19 | R2 list page, bulk delete, read-after-write | `deleteSet`, `readLatestPointer` | **not stated anywhere in repo** | 1,000 / ≤1,000 / strongly consistent | none | **UNKNOWN** `[R]` |
| 20 | Isolate memory | archive segment limits | 128 MiB — comments only | 16/8 MiB, 24/48 events | asserts 16/8 MiB, 24 | **UNASSERTED** `[R]` |
| 21 | Subrequests | `maximumTieredReadEvents` | 1,000 — comment only | 48 events | none | **UNASSERTED** `[R]` |
| 22 | DO alarm retries | `call-session-do.ts` `alarm()` | 6 — comment only | abandons at 5 | none found | **UNASSERTED** `[R]` |
| 23 | DO hibernation resets state | `#failedPinAttempts` | 3-attempt promise | in-memory counter | none; `KNOWN_ISSUES.md` calls the claim unreliable | **UNASSERTED** `[R]` |
| 24–26 | Relay frame, model deadlines, Telegram ceiling | `call-session-do.ts`, `model-adapter.ts` | **no repo doc ties these to a platform limit** | 64 KiB / 30s / 90s | assert code constants | **UNKNOWN** `[R]` |
| 27 | Backup byte ceiling | `requireLimits`/`encodeRows` | claimed 1 MiB **per row** | 1 MiB per **page** | neither asserted | **MISMATCH** `[R]` |
| 28 | D2L raw email cap | `MAXIMUM_D2L_EMAIL_BYTES` | no Cloudflare cap recorded in repo | 512 KiB | built from the constant | **UNKNOWN** `[R]` |
| 29 | Backup schema allowlist | `loadDescriptors` | `_cf_` reserved; PR #92 fix landed | exact allowlist | no test for a *future non-`_cf_`* table | **UNASSERTED** `[R]` |
| 30 | Runtime flags | `wrangler.toml` | same file prod + test | no Node built-ins | none | **MATCH (structural)** `[R]` |

**What settles these by execution** (reviewer's, not this audit's):
(a) one hourly `distilMemory` run under `wrangler tail` — tests rows 1–3;
(b) a production probe of `crypto.subtle.deriveBits({name:"PBKDF2", iterations:100_001})`;
(c) `env.MEMORY_VECTORS.upsert` with a 65-byte id, and a 101-text `env.AI.run`;
(d) `bucket.list({limit:1001})` and `bucket.delete(1001 keys)`;
(e) a DO alarm forced to `retryCount` 6.
**None can be settled locally — Miniflare is exactly the layer that does not
enforce them.**

---

## 6. Ranked unpinned-guard inventory

**Method.** All **355** `RAISE(ABORT,'…')` strings from the 32 migrations and
all **804** distinct refusal literals from `throw new` in `src/**/*.ts`,
membership-tested against a 4.76 MB corpus of **278** test files, then
re-run with 2–3-segment **suffix** matching (this repo also pins via suffix
regex). Calibration: the convention here *is* naming refusals — 1,287
`toThrow("<literal>")` vs 108 bare. **But** `migration-schema.test.ts` asserts
trigger *names* via `arrayContaining`, which pins a trigger against deletion,
not against neutering; 95 names absent from tests is therefore not itself a
finding.

Result: 45/355 SQL refusal strings absent exact, **17** still absent
suffix-aware; 268/804 TS codes absent suffix-aware.

**This is the list to plant faults against — mutation is the reviewer's job.**

| Rank | Guard | Where | Why it may be unpinned | What a pinning test must assert | Conf |
|---|---|---|---|---|---|
| 1 | `signed_body_noncanonical` | `sync/signed-request.ts` | File has 14 refusal codes; the test names 13. **Zero test references** `[M]` (it *is* named in two route files as a mapped code, so "nowhere" overstates it). Reachable: a body that JSON-parses but is not byte-canonical — signature/body-hash malleability | POST a valid but whitespace-padded body; assert the exact code | High |
| 2 | Conversation turn/delivery SQL guards (10 codes) | migration `0005` | Each appears **exactly once** in the repo — its own `RAISE` `[M]`. `conversation-repository.test.ts` pins 10 *TypeScript* codes instead | Raw UPDATE of a frozen/terminal column; assert each string | High |
| 3 | `0033` — **every table CHECK constraint** | migration `0033` | No test asserts a CHECK refusal: `"CHECK constraint"` appears in only 2 test files tree-wide, neither D2L; `"UNIQUE constraint"`/`"FOREIGN KEY constraint"` = 0 | One raw INSERT/UPDATE per constraint asserting `/CHECK constraint failed/` — **the cheapest high-yield addition in the change** | High |
| 4 | Backup-restore integrity guards | `backup/memory-backup-restore.ts` | 28 refusal codes; only 7 match by suffix; the test asserts 3 patterns. `_foreign_key_check_failed`, `_self_reference_cycle`, `_trigger_rebuild_mismatch`, `_cursor_rebuild_mismatch`, `_progress_mismatch`, `_object_row_count_invalid` fire only on a corrupt/reordered set | Corrupt one dumped object; assert the code **and** that no `ALTER|CREATE|DROP` ran | High |
| 5 | `deadline_revisions_reject_update` | migration `0011` | Its **sibling** `reject_delete` IS regex-pinned and is dropped/recreated by name in a fixture — so the DELETE half is load-bearing and the UPDATE half is untouched | UPDATE a revision row; `toThrow(/deadline_revision_update_forbidden/u)` | High |
| 6 | Archive guards (8 codes) | migration `0001` | `archive_state_singleton`, `_state_immutable`, `_segment_immutable`, `_purge_not_delivered` strict-absent, while siblings `archive_circuit_latched`, `_coverage_immutable`, `_manifest_immutable` **are** pinned — a deliberate subset | Force a second state row; UPDATE a sealed segment | High |
| 7 | `*_insert_conflict` duplicate guards (3) | migration `0023` | All three study-coach ones unnamed, while sibling `*_delete_forbidden`/`*_status_invalid` **and** `school_course_fact_insert_conflict` are pinned. **The conflict guard is what a happy-path suite misses** | Duplicate insert; assert the conflict string | High |
| 8 | Call-session binding guards | migrations `0004`, `0006`, `0007` | `call-session-do.test.ts` pins a *different* string (`call_session_authority_guest_owner_required` vs `call_session_guest_owner_required`) — suffix hits trace to the wrong one. The 1800-second provider-lifetime window is asserted nowhere | Each by exact name; an authority outside the window | High |
| 9 | Decisions trigger set (entire) | migration `0009` | `decision_item_frozen`, `_state_transition_invalid`, `_item_delete_forbidden`, `_response_delete_forbidden`, `_response_update_forbidden` all strict-absent | Re-open an answered item | High |
| 10 | Post-`sleep` stop check | `local-agent/service.py` `_wait_for_cycle` | Delete it and `test_a_stop_arriving_before_the_first_cycle_leaves_the_databases_untouched` **stays green** via the second check. Not redundant: with pending control work its absence runs one more action after a stop. `AGENTS.md` already documents this trap — **the lesson was recorded and the pinning test was never written** | A stop arriving **with control work already queued** — no test does this | High |
| 11 | `*_rows?_invalid` read-back validators (24 codes) | across `src` | **24/24 absent.** Defence-in-depth against rows the schema cannot produce — structurally hard to pin, same class as the documented `isAutonomyTier` precedent | A repository seam returning an unvalidated row | Medium |
| 12 | `*_missing_after_commit` durability read-backs (4) | `src` | 4/4 absent | A batch stub returning empty `postResults` | Medium |
| 13 | D2L TypeScript layer | `d72ece5` | Migration `0033` triggers are **well pinned** (see below), but `d2l_email_message_write_failed`, `_completion_failed`, `_row_invalid`, `_verification_receipt_invalid`, `_header_names_invalid`, `_grade_value_invalid`, `_clock_invalid`, `school_email_owner_notice_unavailable` are unnamed | Each by name. **`d2l_email_header_names_invalid` / `_structured_invalid` / `_authentication_invalid` are NOT shadowed** — the column CHECKs require only `json_valid` + length, so `header_names_json='{}'` **is writeable** and `read()` must throw. Cheapest genuine pins in the whole change | High |
| 14 | D2L quarantine/parse branches | `d2l-email-handler.ts`, `d2l-email-parser.ts` | `mime_parse_failed`, `from_missing`, and the `unrecognised()` reason codes (`school_item_fields_missing`, `grade_value_missing`, `grade_value_invalid`, `due_date_missing`, `template_unknown`) all 0 occurrences — tests assert only `eventKind: "unrecognised"`, and the no-due-date case actually yields `due_date_missing` | One case per reason | High |
| 15 | `recordFailure`'s `consecutive_failures >= 3` gate | `d2l-email-repository.ts` | The two 4-message notice tests pass for **any** threshold 1–4 — the cron-router failure mode from `AGENTS.md`: counting is not enough, the assertion must name *which* firing | No notice after 2 refusals, one on the 3rd | Med-High |
| 16 | `pinnedDomain` suffix branch | `d2l-email-authenticity.ts` | Every test pins the **exact** domain, so only `pinned.has(domain)` is pinned; `arcEvidence`'s empty-sealer early return and the `"cloudflare-dkim-pass"` label likewise | A subdomain signer under a pinned parent | Medium |
| 17 | Weakest TS modules by pin rate | `extraction-evaluation.ts` 8/28, `deadline-repository.ts` 1/11, `memory-backup-restore.ts` 7/21, `telegram-memory-retriever.ts` 12/25, `study-coach-repository.ts` 7/17, `owner-telegram-agent.ts` 10/18, `memory-backup.ts` 10/18 | — | Per module | Medium |
| 18 | `classroom_*` (9) and `google_oauth_*` (7) clusters | `classroom-client.ts`, `google-oauth.ts` | Entire clusters 0 occurrences; no test drives the OAuth/Classroom failure paths | — | Medium |
| 19 | Shadowed clause | `d2l_email_messages_insert_guard` | Disjuncts `ingestion_key = NEW.ingestion_key` and `raw_sha256 = NEW.raw_sha256` are shadowed by the table's `UNIQUE` constraints, so the row is refused by SQLite's UNIQUE message instead. `D2lEmailRepository.begin()` catches any insert error and re-reads, so nothing observable changes — **a guard that cannot be observed to work is indistinguishable from one that does not** | Second `email_id` with a duplicate `ingestion_key`; assert `d2l_email_message_insert_conflict` | High |
| 20 | Dead branches worth deleting | `memory-projection.ts` (second `memory_projection_source_missing` throw on adjacent lines); `d2l-email-handler.ts` `failureNoticeText`'s `quarantineReason === null` path | Unreachable — the caller returns unless `status='quarantined'` and the CHECK makes the reason `NOT NULL` | Deleting them should stay green — which is the finding | Medium |

### The strongest pinning pattern in this repo — copy it

`test/persistence/d2l-notification-email-migration.test.ts` defines
`proveWholeTrigger`: it asserts the refusal string, **DROPs the trigger**,
re-runs the *same mutation* and asserts it now **resolves**, then restores the
SQL from `sqlite_schema`. All six `0033` triggers use it.

That is the project's mutation methodology encoded as a reusable helper.
**Generalise it.** A test that pins a trigger against *deletion* (the
`arrayContaining` name check, 95 names) is not the same as pinning it against
*neutering*.

### Cannot be settled by inspection — mutations to plant

| Guard | Exact mutation |
|---|---|
| `memory-projection.ts` `MAX_FACTS_PER_PAGE` clause (the live precedent) | Delete `page.facts.length > MAX_FACTS_PER_PAGE \|\|` from the condition. **Predicted to survive iff every over-cap test uses `pageCount === 1`**, because the surviving `totalFactCount > pageCount * MAX_FACTS_PER_PAGE` fires at 1 but not at 2 — a claim about the existing tests, settleable in one run |
| `memory_fact_projection_heads_insert_guard` | Delete the `EXISTS(…)` OR. Predicted survive (PK + `heads_delete_guard`) |
| `memory_fact_projection_pages_insert_guard` / `_facts_insert_guard` | `WHEN 1 = 0`. Predicted survive where the published-state guard also covers |
| `service.py` second stop check | Delete the post-control-work `stop_requested()`; predicted survive |
| `conversation_turns_immutable_guard` | Delete the `OLD.failure_code IS NOT NULL AND …` OR |
| `d2l_email_messages_insert_guard` | Delete both duplicate disjuncts, then run the `proveWholeTrigger` pin |

### Negative space — already pinned, do not re-audit

All six `0033` triggers (as wholes) · `signed_body_invalid`, `signed_body_mismatch`,
`body_hash_mismatch`, `signature_invalid`, `replayed_nonce`, `audience_mismatch`,
`device_key_changed`, `device_not_active`, `signed_request_expired`,
`signed_request_target_invalid` · `autonomy_mode_missing`/`_invalid` ·
`deadline_revision_delete_forbidden` · `conversation_turn_delete_forbidden`,
`conversation_delivery_target_invalid`, `_delete_forbidden` ·
`archive_circuit_latched`, `archive_coverage_immutable`,
`archive_manifest_immutable` · `memory_backup_restore_target_not_fresh` /
`_schema_mismatch` / `_trigger_classification_invalid` ·
`school_practice_item_delete_forbidden`, `school_course_fact_insert_conflict`,
`school_course_card_insert_conflict`, `school_study_evidence_status_invalid` ·
`call_session_authority_guest_owner_required`,
`call_sessions_voice_access_guest_owner_required` ·
`identity_challenge_capacity_exceeded`, `sync_snapshot_capacity_exceeded`,
`request_nonce_capacity_exceeded` · the `memory_projection_*` state-changed
family · `sync_cursor_compare_failed` · the D2L quarantine reasons
`recipient_mismatch`, `message_too_large`, `authentication_failed`,
`authentication_unproven`, `from_domain_unpinned`,
`verification_link_unpinned`, `due_date_invalid`.

---

## 7. Rule-1 sub-claim verdicts

| `ARCHITECTURE.md` claim | Verdict |
|---|---|
| A failed poll is **recorded**, not dropped | **HELD** — every failure path writes a row. Two holes are in the gate *before* recording (C-4) |
| A no-content digest says "nothing due, nothing changed" rather than not sending | **HELD**, and tested |
| The digest names an unreadable source, and truncation refuses to drop that section | **PARTIAL** — the "Could not be read" heading is protected and tested, but per-project `pollFailure` lines live in the unprotected "Projects" section (C-11) |
| A never-run component reports "never run", not "ok" | **VIOLATED in four places** (C-2, C-4) |

---

## 8. Fix ordering

1. **C-1** — add the `detail` column and the missing jobs to `/status`. One
   column, one list; the precondition for everything else being visible. It
   would have surfaced the backup failure months ago.
2. **A-2** — wire `AutonomyService.evaluate`, or delete rule 4 from
   `ARCHITECTURE.md`. A backstop that is documentation is worse than none,
   because it is *relied on*.
3. **B-1** — anti-join suppression into the shared context retriever. "Forget"
   is a privacy promise and voice is the next milestone.
4. **B-2** — a digit-count-independent `pin is N` redaction rule. One regex.
5. **A-1** — extend `isMemoryControlAuthoritative` to the pipeline tools, or
   state in `KNOWN_ISSUES.md` that deadlines carry a weaker authority bar than
   memory.
6. **Axis-4 rank 3** — one `/CHECK constraint failed/` assertion per `0033`
   constraint, plus generalising `proveWholeTrigger`.
7. **A-3/A-4** — the settling test in §4A.
8. **D-1** — correct the allowance *before* any provider is approved.
9. **CI** — a `package.json` for the two Python apps so `pnpm lint`/`typecheck`
   reach them locally; a pre-merge checklist naming the exact commands.

---

## 9. Production facts (supplied by the reviewer, not observed here)

Recorded so the handoff is coherent, and explicitly **not** established by this
audit — the auditor had no `wrangler` access by design:

- D1 is at migration **0032**, applied and verified. `0033` lands with #91.
- Deployed worker version **`c46e6c89`**, from main **`832b1e8`**.
- `memory_backup_runs`: **0 rows, `last_verified` never** — the backup had
  genuinely never succeeded before the 2026-09-17 fix. Next scheduled attempt
  23:30 UTC.
- Vectorize: index exists and is bound (`MEMORY_VECTORS` →
  `jarvis-memory-bge-m3`); meaning search is deployed and working; the setup
  commands were run.

**Correction this audit earned:** an earlier pass stated "production D1 is at
0031" and "last recorded deploy is the PR #80 era", both derived from
`AGENT_LOG` prose. Both were false. The tell was present and dropped —
`git log -1 ebe38aa4` returned `fatal: ambiguous argument: unknown revision`,
a deploy SHA quoted as fact that did not exist as an object. **Rule adopted:
every deploy SHA, migration number and "current state" claim in prose is a
claim about a system that can be queried. Query it.**

---

## 10. Corrections issued against this audit

Recorded rather than buried, because a handoff that hides its own error rate is
not trustworthy:

| Claim | Status |
|---|---|
| "Production D1 is at 0031; last deploy is the #80 era" | **Wrong** — prose trusted over a query. §9 |
| "~25 merges went in with zero verification" | **Overstated** — each cleared a documented local gate (lint, typecheck, full suite at the reviewed sha), plus adversarial suites and mutation sweeps on security PRs. The precise claim is *no cross-platform or Python verification, and no independent execution of the recorded commands* |
| "`void quiet;` is at `index.ts:422`" | **Both right** — 422 at `C:\javis`, 338 in the reviewer's worktree. This produced the 14-line-numbers-across-25-worktrees finding, and the revision-pinned-citation rule |
| "A forged group becomes the `contradicts` oracle that suppresses the real `dkim=fail`" | **Wrong** — the handler's `else if` chain tests `state === "hard_fail"` *before* `!evidence.trusted`, and `hardFailures` scans every `Authentication-Results` value. A genuine `dkim=fail` quarantines first. The primary A-3 attack and the A-4 ordering finding are unaffected. `policy` is the only live member of that set, and it is unpinned |

---

## 11. Verified clean — do not re-spend effort

GitHub client and poller failure recording · Brightspace iCal parsing · Google
OAuth · Classroom client · archive R2 read path · DeepSeek error taxonomy ·
**the watchdog liveness store** (the strongest code in scope — the component
built to answer "broken or quiet?" gets it right) · Ed25519 device
verification (windowed `issuedAt`, atomically consumed nonce, key-generation
binding) · Twilio HMAC over an exact fixed URL · durable per-call attempt
ceilings that DO hibernation cannot reset · `isAuthenticatedFirstPersonQuote`
(requires `sourceText === quote`) · the two single writers of
`directOwnerText` · `remember`/`confirm` on the agent-tool path (word-boundary,
negation, vocabulary and exact-question guards) · literal-history suppression
re-checked at write *and* read · archive tier re-checked after R2 re-read ·
meaning search and the retrievable views (anti-join
`memory_active_event_suppressions`).

**Both calibration bugs are genuinely closed** — independently refuted by a
surveyor, corroborating the reviewer's own round-3 findings: a bare `ok` no
longer promotes a model-inferred memory (`rememberGrounding` requires
`contentWords(excerpt).length >= 2`, and `confirm()` routes model-inferred
items to a keyboard), and no `draft`/`sample` marker blanks past its own span
(`blankRange` is span-exact; the secret scan deliberately omits the draft
exemption).

One caveat noted: Twilio's signed payload carries no timestamp, so a captured
body+signature replays — impact bounded by per-`CallSid` idempotency.

---

## 12. Boundary

Read-only throughout. **No file was created, edited, moved or deleted to
produce this audit; no suites, builds, installs, migrations, deploys or
production queries were run.** Every claim is file, `git`, GitHub-API, or
fetched-spec evidence, tagged `[M]` / `[R]` / `[X]` / `[I]`, with a falsifier
where one is knowable.

Rows tagged `[R]` are **leads**, not findings, until settled. The A-3/A-4
exposure is a **falsifiable hypothesis with the test named**, not a confirmed
live bypass.

**Mutation and execution remain the reviewer's.** Inspection narrows the
search; it does not prove a guard is unpinned, and it cannot prove the absence
of a bypass.
