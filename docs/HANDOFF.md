# Handoff

**Current as of 2026-09-18, `origin/main` = `6febf32`.**

This document replaces the previous handoff entirely. It is written to be read by
a session with no memory of what came before — human or model — and it is
deliberately blunt about what has been verified and what has not.

Read this file, then [docs/ARCHITECTURE.md](ARCHITECTURE.md), then
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md), then [AGENTS.md](../AGENTS.md) for the
traps. `docs/AGENT_LOG.md` is the running mailbox between builder and reviewer;
its top entries are the most recent truth, and this document summarises rather
than replaces it.

---

## 1. What Jarvis is meant to be

The owner's words, 2026-09-18:

> "This should just be an AI that I can call and chat with, who also has access
> to tools so it can do things for me. Literally THIS CHAT, but if I said hey
> send an email to blah, or check my Google Classroom, or warm up my Tesla, or
> do this on my PC."
>
> "IT'S JUST AI WITH EXTENDED HANDS. AN AI OUTSIDE THE SANDBOX."
>
> "Like a human. My brain knows what to do and uses the tools to do it — tools
> as in my body."

The design rule that follows, and the test to apply to every feature:
**he talks, the model works out what he meant, tools do the rest.** Any place he
must phrase something a particular way is wiring that is wrong. Code holds only
**reflexes** — things the model must not be able to do however convinced it is —
and **receipts** — what actually happened.

Named requirement: store everything, automatically remember what matters, recall
anything on request, and **no homework** — he should never have to file, tag or
manage anything.

---

## 2. The fleet and the constraints

| Device | OS | Notes |
|---|---|---|
| Home PC | **Windows 11** | On all waking hours, **off overnight** |
| Laptop | **Windows 11** | |
| Phone | **iPhone 16** | |
| Car | Tesla | Separate integration, not a host |

- **There is no Linux machine and he has never used one.** A `systemd`, `chmod`
  or bash instruction is not something he can run. Do not plan for a Linux host.
- **Anything that must survive the night lives in the cloud.** "Always-on" means
  "on except overnight".
- Grade 12 in Ontario, behind after surgery, **university applications due
  around now**. School is the top priority after foundations.
- Cost-conscious. **GitHub Actions is out of budget until 2026-10-01.**

---

## 3. Where the work stands

### Revisions and deployment

| | |
|---|---|
| `origin/main` | `6febf32` |
| Migrations on main | **34**, `0001`–`0034`, no gaps |
| Production D1 | through **0032** applied and verified (reviewer-confirmed) |
| Production Worker | `c46e6c89` from `832b1e8` (reviewer-confirmed) |

**Unapplied migrations are a standing hazard, not a detail.** Code on `main`
reads tables production may not have. Establish what is applied before any
deploy. Do not infer production state from prose — see §9.

### CI is dead, and this is a standing decision

Last green run on `main`: **2026-09-12**. Every push since fails in 3–7 seconds
with *"The job was not started because recent account payments have failed or
your spending limit needs to be increased."* The owner has decided not to raise
the limit; it resets 2026-10-01.

Consequences to hold in mind:

- **A local gate is the only check.** See §4.2.
- `apps/local-agent` and `apps/brain-bridge` have **no `package.json`**, so
  `pnpm lint`/`typecheck` never reach them. CI was the only place `ruff` and
  `mypy --strict` ran for ~9,300 lines of Python.
- Four `@jarvis/hermes-runtime` tests fail on `main` (SBOM, source-lock).
  **Pre-existing. Not yours. Do not fix them here.**

### Recently merged (an audit-response burst)

Several merges on 2026-09-18 answered findings from that day's deep audit:

| PR | Subject |
|---|---|
| #93 | Voice honours forgetting in shared conversation retrieval |
| #94 | Status: make a failed or never-run job visible |
| #95 | School: trust the receiving MTA's own authentication group |
| #97 | Digest: school first, and a dead feed says so |
| #98 | Memory: recall uncertain proposals instead of hiding them |
| #99 | Memory: pin the forgetting guarantee at every layer |
| #100 | Memory: correcting a fact in plain speech |
| #101 | reviewer-tools handoff |

**Open PRs:** #96 *Calling: a spoken PIN before sensitive actions, and redact
it*; #84 *Telegram: never claim actions Jarvis didn't take* (superseded, kept
for record).

Detail for each is in `docs/AGENT_LOG.md`. **These summaries come from PR titles
and log headings, not from a review of the diffs — treat them as pointers.**

---

## 4. THE WORKFLOWS

This section is the point of the document. Everything below is how work is done
here, not what to do next.

### 4.1 Build and review (the cross-vendor gate)

**Never let the same model build and review the same work.** One vendor builds,
a different vendor reviews, and **the reviewer never accepts a builder's claim
about its own tests.**

- `docs/BUILDING.md` holds the per-milestone build/review assignment and the
  escalation ladder. Read it before starting a milestone.
- A PR that **applies a migration to live data is reviewed at max.**
- **The one rule:** a session builds until its milestone's exit test passes, or
  until it is stuck. **Stuck means stop and report. Never grind.** Grinding is
  the failure this project has already had.
- Stop at the first of: the same test failing three times against three
  different fixes; two full attempts at one item; the failure being in code the
  milestone does not touch; the fix needing a new service or >200 lines the
  roadmap does not name; two documents disagreeing on something load-bearing; a
  missing credential, purchase or permission.

### 4.2 The local gate (because CI is dead)

Run from the repository root, in your own worktree:

```bash
pnpm lint
pnpm typecheck
pnpm test          # cloud-gateway + contracts + acceptance
```

**Scoping caveat that has caught people:** `pnpm test:all` is
`pnpm test && pnpm test:runtime && pnpm test:watchdog` — an `&&` chain that
**stops at the first failing package**. Gateway-only numbers are not `test:all`
numbers, and reporting them as such overstates what ran.

The local agent is Python and is **not** covered by `pnpm`:

```bash
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run pytest -q
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run ruff check .
& "C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe" run mypy --platform win32 jarvis_local
```

`python` on PATH is a **broken stub**. `uv` is at the unusual path above. All
three must pass. Ruff runs with `ANN`, so **every function needs annotations,
test functions included**.

The suite is **load-sensitive**. Unrelated files that time out under a full
parallel run usually pass alone — rerun them isolated, and say so rather than
reporting them as failures.

### 4.3 The two-session mailbox

`docs/AGENT_LOG.md` is a mailbox between a builder session and a reviewer
session that cannot talk to each other.

- **Append at the top.** Sign it. Write it to be read late.
- State **what effort level you ran at**, and what that effort did *not* cover.
- Record things a reviewer will check, including things you got wrong on the way.
- Where the project *stands* goes in this file, not there. The log is history.

### 4.4 Migrations — the workflow with the most traps

1. **Find the next free number** by checking `main` *and every open PR branch*.
   Two migrations have collided on this project before.
2. **Additive and remote-D1-safe.** Use `WHEN … BEGIN SELECT RAISE(...)` or
   `CHECK`. **Never `SELECT CASE … RAISE`** — remote D1 rejects it.
3. **No semicolons inside `--` comments.** The test migration splitter divides
   on `;` and cuts the statement in half.
4. **Register it in `memory-backup-restore-migrations.ts`** in the same commit.
   A migration missing from that inventory makes backups at the new schema
   version **unrestorable**.
5. **Classify any new table** in `memory-backup.ts` (`MEMORY_BACKUP_TABLES`,
   `MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES`, or
   `MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES`), or the nightly backup aborts
   with `memory_backup_table_unclassified`.
6. **If it seeds rows, update `MIGRATION_SEEDED_ROWS` in
   `memory-backup-restore.ts`.** The restore path pins the exact seeded row set
   per table and refuses a target that does not match
   (`memory_backup_restore_target_not_fresh`).
7. **A migration that adds a column or table the new code reads MUST be applied
   before that code deploys.** Deploying first is an outage, not a warning. The
   project has the scar: `KNOWN_ISSUES.md` records the `0024` ordering hazard,
   and PR #90's log entry states the rule for `0032`.
8. **The Sid-attended scratch rehearsal is mandatory** before any production
   apply: `docs/runbooks/migration-scratch-proof.md`.
9. Adding a migration means updating `test/persistence/migration.ts` (import +
   applier + `allCloudGatewayMigrations`),
   `test/persistence/remote-d1-migration-syntax.test.ts`, and any test that pins
   the expected `databaseSchemaVersion`.

### 4.5 Worktrees

**One session per milestone. Do not work in the shared checkout.** Create your
own worktree at a **short path** on a new branch:

```bash
git fetch origin
git worktree add C:\Users\Sid\jarvis-<topic> -b codex/<topic> origin/main
```

Short paths matter: the Hermes runtime containment check rejects paths containing
an 8.3 short name, and a deep temp path can trip it. Remove the worktree **only
after pushing**.

### 4.6 Deploy

`docs/runbooks/deploy.md`. Dry-run by default, explicit production selection,
publishing requires confirmation. Deployment is the **owner's** action.

### 4.7 Standing rules — never do these

**Never merge, deploy, apply migrations, touch secrets, spend, sign up, or
contact anyone.** Merging, production operations, secrets and consequential
actions are the owner's. Building through roadmap items needs no approval; those
do.

### 4.8 Reporting discipline

Every claim carries a tag:

- `[M]` verified by the writer, first-hand
- `[R]` relayed from someone else, **not** re-verified — a lead, not a finding
- `[X]` external source, fetched and cited
- `[I]` inferred

And a **falsifier** where one exists — what observation would show the claim is
wrong. Separate **"this is broken"** from **"this is a design choice I
disagree with"**; they are acted on differently.

**Cite symbol + "as of `<sha>`", never a bare `path:line`.** With ~25 git
worktrees live, one symbol resolved to **14 different line numbers** across
checkouts; a bare line number is ambiguous at a single instant.

### 4.9 Mutation testing — the bar for a guard

A guard whose logic can be neutered while the suite stays green is **unpinned**
and gets sent back. For any new guard:

1. Write a **named** test whose name describes the behaviour.
2. Neuter the guard, confirm **that named test fails**.
3. Restore, confirm it passes.
4. Report both results.

**A mutation that survives is a finding about your tests, not a pass.** This
happened on the tier-3 work: the first mutation targeted a branch reachable only
in an uncovered configuration, survived, and the fix was to add the missing
coverage — not to change the mutation.

Beware the two recurring traps: a test that pins a **name** rather than the
behaviour (asserting a trigger exists is not asserting it is load-bearing), and
a test that passes for a **different reason** than the one it claims.

### 4.10 Memory, backup and restore invariants

- **D1 is authoritative.** FTS5 and Vectorize are rebuildable indexes; a stale
  vector cannot resurface suppressed content because the read re-validates
  against D1.
- **Append-only means a trigger, not a convention.** Read the `CHECK`
  constraints and `RAISE(ABORT, …)` triggers, not the repository code.
- **Forgetting is hiding, never erasure.** The receipt says the original
  conversation remains retained. Do not describe it as deletion.
- **A backup taken before a forget does not carry the suppression**, and
  nothing re-applies suppressions after a restore. Forgetting holds forward from
  the forget; a pre-forget backup is the resurrection path. This is deliberate,
  not a bug — but say it out loud rather than implying otherwise.

---

## 5. IN FLIGHT: the tier-3 backstop (unmerged branch)

**Branch `codex/wire-autonomy-tier3` at `54ad5a0`, pushed. No PR opened. Not
green.**

### The defect it addresses

`AutonomyService.evaluate` has **zero callers** in `src`. `decideOutcome` is
called only from `evaluate`. Meanwhile `README.md` advertises "tier 3 never runs
without Sid confirming" and `docs/ARCHITECTURE.md` rule 4 calls tier 3 "the
backstop that holds after everything else fails". **Neither is true of the
running code.** Real protection today is per-feature; every new hand inherits
nothing.

**Re-verified on current main `6febf32`: still zero production callers `[M]`.
The work is not redundant.**

### What is built

| File | What it does |
|---|---|
| `src/autonomy/tool-gate.ts` | The gate. Evaluates capability → tier **before** any tool acts; fails closed on unclassified and on an audit-write failure; never reads arguments for meaning |
| `src/autonomy/tool-capabilities.ts` | Tool → capability map. The eight existing tools classified; the reserved hands (email/Tesla) pre-classified |
| `src/autonomy/tool-confirmations.ts` | Tier-3 confirmation bound to **capability + a canonical hash of the arguments**, consumed from the existing `decision_responses` ledger. **No new table for the confirmation** |
| `0035_autonomy_tool_capabilities.sql` | Additive seed of five capability rows. `0035` is the next free number `[M]` |
| `test/autonomy/tool-gate.test.ts` | 9 gate tests |
| `test/channels/owner-telegram-agent.test.ts` | +2 integration tests that fail if the gate call site is removed |

Wired into `OwnerTelegramAgentAdapter.executeCall` as a **required**
dependency, so a construction site that forgets it is a compile error. **Voice
has no tool dispatch today `[M]`, so `executeCall` is the only wiring point.**

The confirmation reuses the existing decision queue exactly as the memory
`confirm`/`forget` flows do: `decisions.raise` →
`recordPendingTelegramReplyMarkup` → answered via `answerFromTap`. **No second
confirmation mechanism was invented.**

### Mutation results (all restored, verified clean)

| Mutation | Result |
|---|---|
| Disable the gate call site | **2 failed** — exactly the two new integration tests |
| `requires_confirmation` → permit (uncovered branch) | **survived** → real test gap; coverage added |
| Confirmation lookup-miss → permit | **4 failed** |
| Unclassified → default tier-1 capability | **1 failed** — the named test |
| Standing confirmation never found | **2 failed** |

### Why it is NOT green

Last full run: **15 failures**, after fixing two real integration points found by
running the suite (`memory_backup_restore_target_not_fresh:capability_tiers`, and
the schema-version fixture). Remaining failures cluster in the **voice acceptance
suites** (`voice-call-path`, `voice-telegram-call`,
`voice-telegram-owner-step-up`, `call-session-do`), plus
`owner-telegram-agent > does not promote a model inference from a stale Confirm
keyboard`, one `memory-backup` case, and one `owner-call-step-up-migration` case.

**These are NOT diagnosed.** An earlier baseline on a different revision passed
199/199, so they cannot be assumed unrelated. **This is the first thing to
investigate.**

### Two things a successor must know

1. **Deploy ordering is load-bearing.** The gate denies a capability with no
   row, so `0035` must be applied **before** the gateway deploys, or every
   memory/school/university/study call is refused. The refusal is loud — it
   appears in the receipt — but it is still an outage.
2. **The one judgement call that changes product behaviour:** the eight
   existing tools are classified **tier 1, not tier 2.** Production runs the
   shadow mode `0008` seeds, and shadow withholds every tier-2 action — so tier
   2 would have stopped the school, university, study and memory tools the owner
   is using. The reasoning is written into `0035`'s comment and
   `tool-capabilities.ts`. **The alternative is one `UPDATE`. That decision is
   the owner's.**

### Still owed on this branch

- Diagnose the 15 failures.
- The `docs/AGENT_LOG.md` ready entry, signed, with the effort level stated.
- The PR itself, titled *"Autonomy: the tier-3 backstop actually runs"*.
- If the README's claim cannot be made true as written, say so plainly and
  propose what the documentation should say instead.

---

## 6. Open defects worth knowing (top of the register)

`KNOWN_ISSUES.md` is ~1,000 lines and is **the most honest document here**. The
highest-value entries as of this writing, all `[R]` from the 2026-09-18 audit
unless marked:

1. **`/status` could not report failure** — no `detail` column and a hardcoded
   three-job list. Fixed by #94 `[R]`.
2. **Distilled facts were unreachable** — the pipeline's default output
   (`proposed + model + inferred`) was excluded by every recall path.
   Addressed by #98 `[R]`.
3. **Voice has no memory search** — `TelegramMemoryRetriever` is constructed
   only in `index.ts`; voice wires the raw `D1ContextRetriever` `[M]`. **Not
   addressed as far as is known.**
4. **An incomplete search is reported as complete** —
   `LiteralHistoryService` computes `status: "incomplete"` and `mergeMemory`
   drops it `[R]`.
5. **School and study tools run on a weaker authority marker than memory** —
   `directPipelineText` omits `containsQuotedOrPastedControlContent`, so a
   multi-line paste of someone else's words can mutate deadlines and application
   status `[M]`. This is the structural cause of a `submitted_by_sid` false
   record already in `KNOWN_ISSUES.md`.
6. **The backup had never once succeeded** until 2026-09-17 (`_cf_KV` was
   unclassified). Fixed and deployed `[R]`.
7. **Rate limiting and the circuit breaker are per-isolate.**
8. **The gateway heartbeat 404s** — cause found (missing
   `global_fetch_strictly_public`), fix on `main`, **needs a redeploy to prove**.
9. **Nothing watches the watchdog** — no external uptime monitor exists.
   Owner-blocked.
10. **CI type-checks only Windows**, so every Linux-guarded branch in the local
    agent is invisible to `mypy`.

---

## 7. The roadmap reality

Plan documents: `docs/plan/2026-09-03-jarvis-roadmap.md` (milestones R0–R10) and
`docs/plan/2026-09-15-*`. The roadmap's own status table **lags** — check
`docs/AGENT_LOG.md` and the merged-PR list.

**What exists today:** Telegram text with memory, calling (cloud-side, gated on
Twilio config and owner-phone enrollment), school and university trackers, study
coach, deadlines, the digest, the decision queue, the watchdog, the backup.

**What the vision names and does not exist:**

| Hand | State |
|---|---|
| Google Classroom | **Built and wired**, gated only on three Google credentials. The closest thing to working — one owner OAuth action away. |
| Email | **Nothing.** Zero hits for `gmail`, `send_email`, `smtp` `[M]` |
| Tesla | **Nothing.** Zero hits for `tesla` `[M]` |
| PC control | Substrate partly present (`transport/pipe_server.py`, `crypto/dpapi.py` are real Windows implementations, CI-tested), but **no Windows service host** and `jarvis node` refuses non-Linux `[M]` |

**A sequencing opinion worth carrying forward:** email needs the tier-3 gate and
a Google identity; the Tesla needs the gate and is *reversible*, so it is the
safer first hand; PC control is the largest build and should come last, in
slices, starting read-only.

---

## 8. Traps that have actually cost time

`AGENTS.md` holds the full list. The ones that recur:

- **`python` on PATH is a broken stub.** Use `uv` at the path in §4.2.
- **No semicolons inside SQL comments** (the splitter).
- **`fetch` must be bound**: `globalThis.fetch.bind(globalThis)`, or it throws
  `Illegal invocation` in workerd. Every test passed against mocks before this
  was found in production.
- **Never write source containing escapes through a shell heredoc** — it has
  corrupted files three times. Use the file-writing tool. Corollary learned the
  hard way: in PowerShell, `\n` inside a double-quoted string is a **literal
  backslash-n**, not a newline. Use a backtick-n or a here-string, and verify
  the edit landed rather than assuming.
- **The watchdog must not import from the gateway.** Not a type, not a helper.
- **The gateway's tests were never typechecked.**
- **A green suite is not evidence.** Mutate the guard.

---

## 9. How to verify a claim in this repository

**Prose is a claim, never state.** Every deploy SHA, migration number and
"current state" sentence in these documents is a claim about a system you can
query.

This was learned expensively: an audit reported "production D1 is at 0031" and
"last deploy is the PR #80 era" — both derived from `AGENT_LOG` prose, both
**false**. The tell was present and dropped: `git log -1 ebe38aa4` returned
*"unknown revision"*, a deploy SHA quoted as fact that did not exist as an object
in the repository.

So:

```bash
gh pr list --state open --json number,title,headRefName
gh pr list --state merged --limit 10
gh run list --branch main --limit 5
git log --oneline origin/main -15
git ls-tree -r --name-only origin/main -- apps/cloud-gateway/src/persistence/migrations
git grep -n "<Symbol>" origin/main -- apps/cloud-gateway/src
```

And for production, **ask the reviewer to run the query** — an auditor does not
get `wrangler`, because the same credential deploys Workers and applies
migrations. Write the SQL; the reviewer runs it read-only and pastes results.

---

## 10. Immediate next actions, in order

1. **Diagnose the 15 failures on `codex/wire-autonomy-tier3`** and get it green.
   Nothing else about that branch matters until then.
2. **Add the `docs/AGENT_LOG.md` entry** for that branch (signed, effort stated,
   deploy-ordering rule stated, tier-1 judgement call stated) and open the PR.
3. **Re-run the doc-vs-reality sweep** after the documentation reconciliation
   lands — the previous sweep found `HANDOFF.md` and `CHANGELOG.md` abandoned
   while `README.md` called them load-bearing, `ARCHITECTURE.md` claiming "the 13
   migrations" against 34 on disk, and a 117/122 test-typecheck count in four
   documents.
4. **School first:** one owner OAuth action turns on Classroom; the university
   tracker needs its migrations applied first, with the scratch rehearsal.
5. **Then hands**, in the order argued in §7 — and the tier gate from §5 is the
   precondition for every one of them.
