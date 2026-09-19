# Handoff

**This document is a narrative, not a status.** For what is true right now read
[docs/STATE.md](STATE.md); for what is in flight, and who acts next, read
[docs/QUEUE.md](QUEUE.md). Those two are maintained. This one explains.

Its facts were verified at the revision printed by:

```bash
git log --oneline origin/main -1
```

A row below that carries a date or a sha is a historical claim about that revision.
It is not wrong for being old. It is wrong only if it is read as current — which is
the mistake this file has now made three times.

This document replaces every earlier handoff. It is written to be read by a
session with no memory of what came before — human or model — and it is
deliberately blunt about what has been verified and what has not.

Read [docs/STATE.md](STATE.md) first — it is short, it is current, and it wins any
disagreement with this file. Then this file, then
[docs/ARCHITECTURE.md](ARCHITECTURE.md), then
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md), then [AGENTS.md](../AGENTS.md) for the traps.
`docs/AGENT_LOG.md` is the mailbox between builder and reviewer: **search it, do
not read it** — it is evidence, and none of it is current state.

---

## 0. Where things stand — 2026-09-19 01:30 UTC

Written at the end of a reviewer session that ran out of context. `origin/main`
is **`855e12a`**. Production is **unchanged**: Worker `555c1414`, D1 at
migration **`0034`**, `autonomy_mode` **`shadow`**. **The deploy has still not
happened and is the open item.**

**Landed this evening.** [#106](https://github.com/stremysid/jarvis/pull/106) —
the tier-3 backstop is now actually wired into `OwnerTelegramAgentAdapter.executeCall`,
after a blocker the *merge* introduced (`memory_correct` dispatched but
unclassified, so the gate would have denied memory correction in production).
[#110](https://github.com/stremysid/jarvis/pull/110) — the hourly distillation
path ignored the suppression ledger, so forgetting had a back door.
[#105](https://github.com/stremysid/jarvis/pull/105) — the Classroom route is
recorded as dead **in this document and in the runbook**, not only in a memory
file, which is why it came back a second time.

### The outside audit has been read in full and triaged

Sid commissioned a second-vendor deep dive and asked for it to be read whole
rather than skimmed. It was — 5,924 lines plus a 245-line companion, in
`jarvis-sweep-reports` under his user profile, **outside this repository**. Do
not re-read them. The triage is
[docs/reviews/2026-09-18-full-audit-triage.md](reviews/2026-09-18-full-audit-triage.md)
and the top entry of [docs/AGENT_LOG.md](AGENT_LOG.md).

Six findings survived independent re-derivation. **Work order:**

| # | Finding | Note for whoever picks it up |
|---|---|---|
| 1 | The red `local-agent` CI job | `d839cad` moved the Worker to six chained 100,000-iteration PBKDF2 passes and regenerated the shared fixture; `owner_passphrase_policy.py:70` still makes one 600,000 call. **Do not regenerate `digestBase64` back** — that blesses the divergence the fixture exists to catch |
| 2 | `channel_identities` has no `BEFORE INSERT` trigger, and `capability_tiers` has neither an update nor a delete guard | One migration, four triggers. `0035`, `0036` and `0037` are all claimed — use **`0038`** |
| 3 | `tool-gate.ts` returns `verdict: "permit"` as a literal | **`verdictFor(confirmed)` is the wrong fix**; it breaks the confirmed path, because `decideOutcome` takes no input but tier and mode. Deny when the second evaluation is not the outcome the first one was |
| 4 | `telegram-provider.ts` clears its abort timer before the body read | Under a comment saying the timeout exists so that cannot happen. `twilio-provider.ts` does it correctly |
| 5 | `jarvis vault sync` cannot see past the first 64 notes | Not 64 per run — the same 64 forever; nothing persists a position |

Recorded, not queued: the safe-log allow-list has zero production importers;
`/health` shares one per-isolate 30/min bucket; `handleReadiness` has no route;
the H1/Hermes bridge is test-only; five Python modules have no production
importer.

**Discount that report where it discounts itself.** Its provider and model rows
are its own sub-agent's work quoted back — it spot-checked four of them and
found one wrong — and two of its ten parts ran no test at all, so `PINNED` there
means somebody read a test's *name*, not that anyone watched it pass.

### Do not restart the builders without asking

Every builder is stopped. Sid stopped them inside his peak-cost window and that
stands until he says otherwise. **The cheap window is 12:30-20:30 his time
(16:30-00:30 UTC)**; outside it, the same work bills at double. When it reopens,
finding 1 goes first — nothing else can be proven green while the gate is red.

### Waiting on Sid, and he has been told

Apply `0035` then the reviewer deploys, in that order · whether to restart the
builders · tier 1 vs tier 2 for the eight everyday tools (silence means tier 1,
which live D1 supports) · confirm the deployed `DEFAULT_GUEST_PIN` is not the
committed test value · and, only after a deploy proves the `email()` handler
live, flipping `school@onesid.ca` off his Gmail and onto the Worker — which
turns on D2L **and** Classroom at the same instant.

---

## 1. How Sid works — read this before anything else

It changes how you behave, not just what you know.

- **Windows 11 only. No Linux, no server, no NAS, anywhere.** Never write a
  bash, `systemd` or `chmod` runbook; he cannot run it.
- **Short replies. Detail goes in files.** Anything he asks you to explain or
  show must be **visualised**, not written as prose.
- **Outcomes, not internals.** Bring him merges, live yes/no decisions, money,
  and physical tasks. Nothing else.
- **Never guess.** Prove a cause from logs, code or queries actually run, and
  label anything unverified.
- **The reviewer may merge PRs it has cleared, at the exact reviewed head.**
  Deploying and applying migrations are Sid's. See the table in §4.9.
- **Ask before running any deep-scan or audit pass.**
- **When a plan attributes a decision to Sid, that is evidence, not proof.**
  This has mattered twice: the Linux home node and the watchdog's R0 scope were
  both recorded as his decisions and were neither.

---

## 2. What Jarvis is meant to be

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

### The fleet

| Device | OS | Notes |
|---|---|---|
| Home PC | **Windows 11** | On all waking hours, **off overnight** |
| Laptop | **Windows 11** | |
| Phone | **iPhone 16** | |
| Car | Tesla | Separate integration, not a host |

**Anything that must survive the night lives in the cloud.** "Always-on" means
"on except overnight".

Grade 12 in Ontario, behind after surgery. **University applications opened
2026-09-18 and are due in December** — so school leads, but the urgency is a
term, not a week. He is cost-conscious, and **GitHub Actions is out of budget
until 2026-10-01**.

---

## 3. Where the work stands

| | |
|---|---|
| `origin/main` | **query it** — `git log --oneline origin/main -1`. `6febf32` when written; not maintained here |
| Migrations on main | **34**, `0001`–`0034`, no gaps |
| Production Worker | **`555c1414`**, not redeployed since <!-- docs-check:ignore: a Cloudflare Worker version id is 8 hex characters, not a git sha --> |
| Production D1 | **migration `0034`** — verified by querying `d1_migrations` |
| Open PRs | #96 (stuck), #84 (stale since 2026-09-17, never triaged) |
| Running | nothing — all DeepSeek instances finished |

Merged 2026-09-18: **#90–#95, #97, #98, #99, #100, #101.**

### Corrections to earlier handoffs, and who is right

Two handoffs existed and they disagreed. Recorded rather than silently
reconciled:

- **Production is at migration `0034`, not `0032`.** An earlier draft of this
  document said `0032`; `reviewer-tools/HANDOFF-2026-09-18c.md` said `0034` and
  is **right**. The `0032` figure was accurate when written and went stale.
- **Production runs Worker `555c1414`, not `c46e6c89`.** Same cause; 18c is <!-- docs-check:ignore: both tokens are Cloudflare Worker version ids, not git shas -->
  right. The redeploy happened on 2026-09-18.
- **`main` was `6febf32`.** 18c records `8b5f438`, which was current when it was
  written, before #98's merge commit landed. Both are now behind main; see the
  header for why this document no longer states a revision as current.
- **The merged list is 18c's** (#90–#95, #97–#101). The earlier draft omitted
  #90, #91 and #92.
- **The reviewer tooling branch head is `d4f5aa2`.** 18c says `e78b787` and the
  2026-09-18 brief said `d98ac72`; both are stale. `d4f5aa2` is the commit that
  dropped eight superseded handoffs.
- **University applications are due in December**, not "around now". The earlier
  draft overstated the urgency.
- **Merging is role-split.** An earlier draft said "never merge" flatly. The
  builder never merges; **the reviewer may merge a PR it has cleared, at the
  exact reviewed head.** The reviewer still never deploys and never applies
  migrations.
- **One false builder claim to keep dead:** PR #100's report states *"Production
  is at 0015, so deploying this first breaks all memory control."* **That is
  false.** `0016` and `0032` are both applied. Do not propagate it.

### A warning that generalises

**Three builder claims were false on 2026-09-18, and none of them were in
code.** One mis-stated production's migration state; one signed its log
`effort max` and ran at `high`; one attributed a hardware decision to Sid he
never made.

The code gets tested. **The prose does not.** Builder *reports* are where review
is weakest. Verify any claim about **production state, effort level, or what Sid
decided** before repeating it.

### CI is dead, and this is a standing decision

Last green run on `main`: **2026-09-12**. Every push since fails in 3–7 seconds
with *"The job was not started because recent account payments have failed or
your spending limit needs to be increased."* The owner has decided not to raise
the limit; it resets 2026-10-01.

Consequences to hold in mind:

- **A local gate is the only check.** See §4.3.
- `apps/local-agent` and `apps/brain-bridge` have **no `package.json`**, so
  `pnpm lint`/`typecheck` never reach them. CI was the only place `ruff` and
  `mypy --strict` ran for ~9,300 lines of Python.
- Four `@jarvis/hermes-runtime` tests fail on `main` — `sbom-integrity-round2`
  (×2), `sbom-security-review3`, `source-lock`. **Pre-existing. Not yours to fix
  inside an unrelated PR.** They sat red for six days because of the
  short-circuit described in §4.3.

---

## 4. THE WORKFLOWS

This section is the point of the document. Everything below is how work is done
here, not what to do next.

### 4.1 Build and review — the cross-vendor gate

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

### 4.2 The headless build workflow — how work is actually built now

Builders and auditors run **headless on Sid's PC**, launched by the reviewer.
Nothing needs Sid and nothing needs a browser chat — but **his PC must be on**.

```powershell
# builder
pwsh -NoProfile -ExecutionPolicy Bypass -File reviewer-tools\dsh-relay.ps1 -Name <job> -Effort high
# read-only auditor
pwsh -NoProfile -ExecutionPolicy Bypass -File reviewer-tools\dsh-audit.ps1 -Name <job> -Effort high
```

- **Write the brief to `<scratch>\relay\<job>-prompt.txt` FIRST.** Both scripts
  take `-Scratch` to choose that directory.
- **The brief is passed BY FILE PATH, never as an argument.** `npx.cmd` is a cmd
  shim and cmd truncates an argument at the first `&`, `<`, `>` or `|`. On
  2026-09-18 a brief was silently cut at its first `&` and a build ran with
  almost no instructions.
- `-ExecutionPolicy Bypass` is required, or the script is refused outright.
- Output: `<job>.log` (start/exit) and `<job>-attempt1.log` (the full run; the
  report is the final assistant message, at the end).
- The auditor layers
  `C:\Users\Sid\.dsh\.agent-presets\jarvis-auditor\agent.cordis.yml` as a
  profile patch, because headless has **no agent-preset flag** — presets are a
  web-UI concept. It deliberately does not set `DSH_PERMISSION_MODE`, so the
  sandbox stays read-only.

**Known limit: a read-only auditor cannot run tests.** `vite` spawns and the
sandbox returns `spawn EPERM`. Every auditor finding is read from code, so treat
each as a **suspect, not a conviction**. On PR #98 the auditor raised three
findings and two were disproved by running one test each. It is excellent at
finding *where to look*; it cannot settle anything.

- Web UI: `npx @deepseek-ai/dsh web` on `127.0.0.1:3080`. A separate small chat
  app at `127.0.0.1:8757` (`C:\Users\Sid\deepseek-chat\server.mjs`) is **not**
  the harness.
- **Cost:** off-peak, a full day of work — three instances, several PRs, a whole
  audit — ran at about **$0.0067 per million tokens**, roughly 5× cheaper than
  the peak run that alarmed Sid. Peak is weekdays 01:00–04:00 and 06:00–10:00
  UTC *per our notes, not re-verified*. Prefer off-peak for heavy work.

**Standing builder rules that are working:** fresh session per task; own
worktree at a short path, never `C:\javis`; push before finishing; never merge,
deploy, apply migrations or touch secrets.

**A builder's output is not saved until it is committed and pushed.** Two review
scripts were written by a builder that was killed before it could commit them;
they sat untracked in a worktree for six hours while the reviewer hand-rolled a
worse version and hit the exact bug they prevent. **Check for uncommitted files
before stopping any builder.**

### 4.3 The local gate

Run from the repository root, in your own worktree:

```bash
pnpm lint
pnpm typecheck
pnpm test          # cloud-gateway + contracts + acceptance
```

**Scoping caveat that has caught people:** `pnpm test:all` is
`pnpm test && pnpm test:runtime && pnpm test:watchdog` — an `&&` chain that
**stops at the first failing package**. Gateway-only numbers are not `test:all`
numbers, and reporting them as such overstates what ran. That short-circuit is
exactly how four security tests stayed red on `main` for six days.

Use `gate.ps1` instead — see §4.4. It runs every package even when an earlier
one fails.

The local agent is Python and is **not** covered by `pnpm`:

```bash
uv run pytest -q
uv run ruff check .
uv run mypy --platform win32 jarvis_local
```

**Corrected 2026-09-18 by direct check.** `AGENTS.md`, `TESTING.md` and every
earlier handoff give this as `C:\Users\Ksid1\AppData\Local\hermes\bin\uv.exe`. <!-- docs-check:ignore: the dead path this paragraph exists to retract, so flagging it inverts the meaning -->
**That path does not exist, and neither does the `Ksid1` user profile** — the
only profile on this machine is `Sid`. `uv` is on `PATH` (WinGet shim,
`uv 0.12.13`), so the bare command works. The stale path is still in
`AGENTS.md` and `TESTING.md`; fixing it there is an open chore.

The same sources say `python` on PATH is a **broken stub**. That is no longer
true as written: `python` resolves to a real Python and reports `3.12.6`.
Prefer `uv run` regardless, because it uses the project's pinned environment —
but do not repeat the stub claim as fact without checking.

All three must pass. Ruff runs with `ANN`, so **every function needs
annotations, test functions included**.

The suite is **load-sensitive**. Unrelated files that time out under a full
parallel run usually pass alone — rerun them isolated, and say so rather than
reporting them as failures.

### 4.4 The review tooling — use it, do not hand-roll

`reviewer-tools/mutate.ps1`, `gate.ps1`, `dsh-relay.ps1` and `dsh-audit.ps1`,
plus the mutation specs and the status page, are on branch
**`claude/reviewer-gate-tools`, head `d4f5aa2` — NOT ON MAIN.** Until that branch
lands, the entire workflow lives on one unmerged branch. **Merging it is a
task.**

Invoke with **forward-slash Windows paths**; backslashes are eaten crossing Bash
into pwsh and the script aborts saying the gate directory does not exist:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:/Users/Sid/jarvis-gate/reviewer-tools/mutate.ps1' -Spec 'C:/.../spec.json' -GateDir 'C:/Users/Sid/jarvis-pr97'
pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:/Users/Sid/jarvis-gate/reviewer-tools/gate.ps1'   -Sha <sha>        -GateDir 'C:/Users/Sid/jarvis-pr97'
```

**`mutate.ps1`** — spec is a JSON array of
`{name, file, find, replace, testPath, expect}`, or
`{name, edits: [{file, find, replace}], testPath, expect}` when a fault needs
several edits applied together. Every guarantee exists because of a real
failure:

- `find` must match **exactly once**, and the file must provably change, before
  any test runs. A hand-rolled sweep whose pattern matched nothing reported
  SURVIVED three times — a false finding, worse than none.
- Every kill is **re-run with the mutation still applied**. A flake landing on
  the expected test name reads as a clean kill and nobody questions the result
  they wanted. A kill that does not repeat is `UNCONFIRMED`.
- A test already red at baseline is **`INVALID`, not SURVIVED**.
- A non-zero runner exit with nothing named is **`INVALID`**. SURVIVED may not
  rest on failing to parse English.
- Exit **2** = no usable result. Exit **1** = a real finding. Different claims.

**`gate.ps1`** runs every package even when an earlier one fails, then re-runs
each failing test **file alone**, because the suite is load-sensitive and a
failure under load is not the same claim as a real failure. Its list of known
pre-existing failures matches on **file AND test name**, so matching the file
alone cannot excuse a future failure. **That list must shrink and must never
grow silently.**

**Never hand-roll a sweep, and always run a control.** A two-edit mutation was
reported KILLED when the fixture edit *alone* killed the same test, so the
experiment proved nothing. The tool cannot catch a badly designed experiment;
only a control can. `reviewer-tools/mutation-specs-2026-09-18/` carries every
spec behind the 2026-09-18 `AGENT_LOG` results, with a README; `f1spec.json`
plus `f1control.json` are kept as the worked example of exactly that mistake.

### 4.5 The two-session mailbox

`docs/AGENT_LOG.md` is a mailbox between a builder session and a reviewer
session that cannot talk to each other.

- **Append at the top.** Sign it. Write it to be read late.
- State **what effort level you ran at**, and what that effort did *not* cover.
  A log signed `effort max` that ran at `high` is a false claim like any other.
- Record things a reviewer will check, including things you got wrong on the way.
- Where the project *stands* goes in this file, not there. The log is history.

### 4.6 Migrations — the workflow with the most traps

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

### 4.7 Worktrees

**One session per milestone. Do not work in `C:\javis`.** It is a shared
checkout. Create your own worktree at a **short path** on a new branch:

```bash
git fetch origin
git worktree add C:\Users\Sid\jarvis-<topic> -b codex/<topic> origin/main
```

Short paths matter: the Hermes runtime containment check rejects paths
containing an 8.3 short name, and a deep temp path can trip it. Remove the
worktree **only after pushing**.

**There are two clones of this repository on the machine, and each registers its
own worktrees.** `C:\javis` owns `jarvis-pr97` and `jarvis-log`. A second clone
at `C:\Users\Sid\OneDrive\Documents\ChatGPT\jarvis` owns `jarvis-gate`,
`jarvis-gatemain` and `jarvis-recall`, **and it is the working directory the
headless builders and auditors run from.** Between them they register 41 — 23 and 18,
counted 2026-09-18 — and most are historical. So `git worktree list` run in `C:\javis` will **not** show
`jarvis-gate` — the working copy of `claude/reviewer-gate-tools`, holding all
four scripts and the mutation specs — and its absence there means you are
standing in the wrong clone, not that the tooling is gone.

### 4.8 Deploy

`docs/runbooks/deploy.md`. Dry-run by default, explicit production selection,
publishing requires confirmation. **Deployment is Sid's action, never yours**,
and so is applying a migration.

### 4.9 Standing rules

| | Builder | Reviewer |
|---|---|---|
| Merge a PR it cleared | **never** | **yes**, at the exact reviewed head |
| Deploy | never | never |
| Apply migrations | never | never |
| Touch secrets, spend, sign up, contact anyone | never | never |

A builder may work through roadmap items without asking. Anything in the right
half of that table is Sid's.

**The reviewer holds production `wrangler` access; the builder does not.** When
a builder needs to know something about production, the reviewer writes the SQL,
runs it read-only, and pastes the result. Never hand `wrangler` to a builder —
the same credential deploys Workers and applies migrations.

### 4.10 Reporting discipline

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

### 4.11 Mutation testing — the bar for a guard

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

### 4.12 Memory, backup and restore invariants

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

**Branch `codex/wire-autonomy-tier3`, head `c982b0b`, pushed. No PR opened. Not
green.** The code commit is `54ad5a0`; `c982b0b` adds this document.

### The defect it addresses

`AutonomyService.evaluate` has **zero callers** in `src`. `decideOutcome` is
called only from `evaluate`. Meanwhile `README.md` advertises "tier 3 never runs
without Sid confirming" and `docs/ARCHITECTURE.md` rule 4 calls tier 3 "the
backstop that holds after everything else fails". **Neither is true of the
running code.** Real protection today is per-feature; every new hand inherits
nothing.

**Re-verified on main `6febf32`: still zero production callers. The work is not
redundant.**

### What is built

| File | What it does |
|---|---|
| `src/autonomy/tool-gate.ts` | The gate. Evaluates capability → tier **before** any tool acts; fails closed on unclassified and on an audit-write failure; never reads arguments for meaning |
| `src/autonomy/tool-capabilities.ts` | Tool → capability map. The eight existing tools classified; the reserved hands (email/Tesla) pre-classified |
| `src/autonomy/tool-confirmations.ts` | Tier-3 confirmation bound to **capability + a canonical hash of the arguments**, consumed from the existing `decision_responses` ledger. **No new table for the confirmation** |
| `0035_autonomy_tool_capabilities.sql` | Additive seed of five capability rows. `0035` is the next free number <!-- docs-check:ignore: this file is on the unmerged branch above, not on main, and the cell says so by calling 0035 the next free number --> |
| `test/autonomy/tool-gate.test.ts` | 9 gate tests |
| `test/channels/owner-telegram-agent.test.ts` | +2 integration tests that fail if the gate call site is removed |

Wired into `OwnerTelegramAgentAdapter.executeCall` as a **required**
dependency, so a construction site that forgets it is a compile error. **Voice
has no tool dispatch today, so `executeCall` is the only wiring point.**

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

## 6. What is left

### The governing thesis

**The work terminates one layer short of Sid.** Tier-3 autonomy is built and
tested with **zero production callers**. Exhaustive search is implemented with
**zero call sites**. The topic tree has **no production importer**. The
bottleneck is **wiring**, not engineering — the roadmap is mostly connection
work. Apply this lens before proposing anything new.

### Track A — school, calendar-bound

- **A1. Google Classroom consent — NOT SID'S ACTION. THE API ROUTE IS DEAD.**
  `pollClassroom` is wired into the hourly job and gated on `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`, and **those three can never be
  obtained.** Sid's school account cannot reach `console.cloud.google.com` — the
  board runs Microsoft 365 and does not allow Google accounts. He established
  this on 2026-09-17; it was recorded in reviewer memory and **not** in this
  handoff, so a later session sent him back to the runbook anyway on 2026-09-18.
  A personal Google account does not help: the data is the school account's, so
  consent must come from it. **Never present this as a one-sitting owner action.**
  The live route is Classroom notification emails through the `onesid.ca` forward
  Sid already built; the outstanding work is **ours** — `d2l-email-parser.ts`
  handles D2L only, so Classroom notifications arrive and are ignored. See
  `docs/runbooks/google-classroom-oauth.md`, which now carries the same warning.
- **A3. Digest school-first — DONE, PR #97.** Verify.
- **A4. Grade and missing-work watch.** Previously "needs A1's submissions
  scope" — **that dependency is dead.** A1's OAuth route cannot be obtained (see
  A1). Grades and missing work must come from Classroom notification email,
  through the same parser work A1 now names.
- **D2L: LDSB Brightspace has NO calendar or iCal feed.** **Never ask Sid for
  one.** The route is notification email into `onesid.ca`, after memory.

### Track B — the hands platform, dependency-ordered

- **B0. WIRE TIER-3.** Outranks all housekeeping: it is a precondition for
  **every** hand. Branch `codex/wire-autonomy-tier3`, head `c982b0b`, no PR, not
  green. **Treat all of §5 as relayed — none of it has been independently
  re-run.**
- **B1. Memory.** Largely landed 2026-09-18 (#98 recall, #99 forgetting pinned
  at every layer, #100 correction in plain speech). **Still open:** meaning
  search has no call sites; the real retriever is not wired into voice; nightly
  backup and rollout. Verify what actually remains.
- **B2. Tesla** — climate, charge, lock. Cloud-only. Deliberately the first
  hand: reversible, cheap, no third party, and it proves model → tool → receipt
  end to end. **Requirements unverified** — the vendor docs refused the fetch.
  Check before committing an evening.
- **B3. Email send** — the first irreversible, third-party hand. Needs the
  tier-3 gate actually exercised, plus a draft → read-back → confirm flow.
- **B4. PC control** — last, biggest, riskiest. `pipe_server.py` and
  `crypto/dpapi.py` already exist and are CI-tested on `windows-latest`.
  Missing: a Windows service host, a short list of what the model may do
  unasked, and honest "the PC is asleep" handling. **Ship read-only tools
  first.**

### Unshipped elsewhere

v1.1 meaning search, nightly backup, calls, rollout. v1.2 D2L and Classroom. The
study coach's **push** behaviour — it answers when asked but never chases.
v1.3–v1.6 not started.

**R1 call gaps awaiting Sid's decision:** inbound owner admitted by caller ID
alone with no STIR/SHAKEN; no answering-machine detection on outbound, so
voicemail could receive private replies. Both must be decided before live
calling widens.

### Deliberately off the path

**Do not let these creep back:** dashboards, Siri shortcuts, calendar
management, wake word, St. Remy, the profile/manager milestone. **None serves
"warm up my car".**

### Reviewer housekeeping — small; do not present this as the roadmap

- **#96 stuck**: 11 tests pass together and fail in isolation. Hand it to a
  Claude builder — **never Fable**.
- **#84** stale since 2026-09-17, never triaged.
- **Merge `claude/reviewer-gate-tools` to `main`** (§4.4).
- Give `memory_item_transitions_insert_guard` in migration `0016` a
  whole-trigger proof, using the `proveWholeTrigger` helper PR #99 landed.
- **`reviewer-tools/status-page-2026-09-18.html` needs a pass** — Sid's single
  status surface still says a memory fix "is building now"; that shipped as #98.

### Waiting on Sid

**A production deploy** (#97–#100 merged but not live) and **the Classroom
credentials** (A1). Nothing else.

---

## 7. Open defects worth knowing

`KNOWN_ISSUES.md` is ~1,000 lines and is **the most honest document here**. The
highest-value entries, most relayed from the 2026-09-18 audit:

1. **`/status` could not report failure** — no `detail` column, hardcoded
   three-job list. Fixed by #94.
2. **Distilled facts were unreachable** — the pipeline's default output
   (`proposed + model + inferred`) was excluded by every recall path. Addressed
   by #98.
3. **Voice has no memory search** — `TelegramMemoryRetriever` is constructed
   only in `index.ts`; voice wires the raw `D1ContextRetriever`. **Not addressed
   as far as is known.**
4. **An incomplete search is reported as complete** — `LiteralHistoryService`
   computes `status: "incomplete"` and `mergeMemory` drops it.
5. **School and study tools run on a weaker authority marker than memory** —
   `directPipelineText` omits `containsQuotedOrPastedControlContent`, so a
   multi-line paste of someone else's words can mutate deadlines and application
   status. This is the structural cause of a `submitted_by_sid` false record
   already in `KNOWN_ISSUES.md`.
6. **The backup had never once succeeded** until 2026-09-17 (`_cf_KV` was
   unclassified). Fixed and deployed.
7. **Rate limiting and the circuit breaker are per-isolate.**
8. **The gateway heartbeat 404s** — cause found (missing
   `global_fetch_strictly_public`), fix on `main`, **needs a redeploy to prove**.
9. **Nothing watches the watchdog** — no external uptime monitor. Owner-blocked.
10. **CI type-checks only Windows**, so every Linux-guarded branch in the local
    agent is invisible to `mypy`.

---

## 8. Traps that have actually cost time

`AGENTS.md` holds the full list. The ones that recur:

- **The documented `uv` path is wrong** and `python` is no longer the stub
  `AGENTS.md` describes. See §4.3, corrected against the machine.
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

**Prose is a claim, never state — query it.** Every deploy SHA, migration number
and "current state" sentence in these documents is a claim about a system you
can query.

This was learned expensively. An audit reported "production D1 is at 0031" and
"last deploy is the PR #80 era" — both derived from `AGENT_LOG` prose, both
**false**. The tell was present and dropped: `git log -1 ebe38aa4` returned <!-- docs-check:ignore: quoted as the deploy sha that proved the lesson, so it is supposed to be unresolvable -->
*"unknown revision"*, a deploy SHA quoted as fact that did not exist as an object
in the repository.

```bash
gh pr list --state open --json number,title,headRefName
gh pr list --state merged --limit 10
gh run list --branch main --limit 5
git log --oneline origin/main -15
git ls-tree -r --name-only origin/main -- apps/cloud-gateway/src/persistence/migrations
git grep -n "<Symbol>" origin/main -- apps/cloud-gateway/src
```

For production, **ask the reviewer to run the query** — a builder or auditor
does not get `wrangler`. Write the SQL; the reviewer runs it read-only and
pastes the result.

**And distrust green.** This project already shipped two production defects that
a fully green local suite could not see (PBKDF2 above the production cap; a
backup that had never once succeeded). **Distrust green.**

---

## 10. One handoff, and what to do next

**There is exactly one handoff, and this is it.** Two competing handoffs is the
problem this document is fixing. This PR deletes
`reviewer-tools/HANDOFF-2026-09-18c.md` in the same change, leaving
`docs/HANDOFF.md` as the sole survivor. Verify with:

```bash
git ls-files | grep -i handoff
```

Eight further superseded handoffs (2026-09-15 to 09-18) were dropped from
`claude/reviewer-gate-tools` at `d4f5aa2` before that branch could carry them
onto `main`. **Nothing was lost** — git history keeps them. **Do not rewrite git
history and do not delete old branches to achieve this.** Deleting the working
files is enough; the history is the record.

### Immediate next actions, in order

1. **Diagnose the 15 failures on `codex/wire-autonomy-tier3`** and get it green.
   Nothing else about that branch matters until then.
2. **Add the `docs/AGENT_LOG.md` entry** for it (signed, effort stated,
   deploy-ordering rule stated, tier-1 judgement call stated) and open the PR.
3. **Merge `claude/reviewer-gate-tools`** so the review workflow stops living on
   one unmerged branch.
4. **School first:** one owner OAuth action turns on Classroom; the university
   tracker needs its migrations applied first, with the scratch rehearsal.
5. **Then hands**, in the order argued in §6 — and the tier gate in §5 is the
   precondition for every one of them.
