# Task brief: PC controls — boot chain, D2L read, daily report

You are **DeepSeek Builder** on `stremysid/jarvis`. Read `AGENTS.md` and
`docs/plan/2026-09-19-jarvis-roadmap.md` first. This brief is the task; those are standing and
this does not override them.

**Verify this brief before trusting it.** Written 2026-09-21 against `0611803`. Where it is
wrong, say so — that is a finding, not a nuisance.

## Worktree rule

`C:\javis` is the live deploy checkout and is **off limits even though your session starts
there**:

```powershell
git -C C:\javis worktree add C:\w\pcc -b codex/pc-controls-p1
# work only under C:\w\pcc
git -C C:\javis worktree remove C:\w\pcc    # after pushing
```

## Absolute rules

- **Never merge, deploy, apply a migration, touch a secret, spend money, sign up for anything,
  or contact any person or service.** You open the PR; the reviewer merges.
- **Never claim a test result you did not observe.** Windows-only work includes things no test
  covers — say what you ran by hand and what you did not.
- **Never guess.** Beginning from a hypothesis is fine; acting on an unproven one is not.
- **Windows only, `pwsh`, not bash.**

## What Sid asked for, in his words

> "jarvis has a guaranteed time of 3 hrs to do what it pleases, we shouldn't worry about my pc
> being off, also jarvis should go in admin on windows so all i have to do is hit the on button
> on my pc and once it loads and turns on jarvis can log in, as we can use elevated powershell to
> run jarvis as an elevated background task, on boot"

> "jarvis logs on checks what work i got through all my classes and then writes a report and
> texts me on telegram"

**His stated constraints:** no time in the morning to turn on and then log in; do not over-worry
about exposure — state risks once and proceed; the PC is on **08:00–23:00** and he is **out
08:00–11:00, not home until 17:00–18:00**, so 08:00–17:00 is unattended and guaranteed.

**Risks, stated once so this is on the record rather than relitigated:** anyone who powers on
the machine gets a logged-in admin desktop with his mail, files and browser sessions unlocked;
the Windows password becomes recoverable in cleartext from the registry (or the LSA secret with
Autologon.exe); and Jarvis-as-admin can do anything he can, so a bug in Jarvis is a bug with
admin rights. Sid has read these and accepts them. **Do not re-raise them in review comments.**

## Three PRs, stacked in this order

### P1 — the boot chain

**Deliverable:** power button → Jarvis running elevated, zero input.

- Auto-login via `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`
  (`AutoAdminLogon`, `DefaultUserName`, `DefaultPassword`, `DefaultDomainName`). Provide the
  command in `ops/`, not run from a PR. If `password` handling can use the LSA secret via
  Sysinternals `Autologon.exe` with the same end result, prefer that and say why.
- A **Scheduled Task** — trigger `AtLogOn`, `-RunLevel Highest`, `-LogonType Interactive`,
  restart-on-failure, `-ExecutionTimeLimit 0` — so the elevated process starts the moment
  auto-login lands on the desktop. **Scheduled tasks with a registered principal bypass UAC**;
  that is what makes this work without a prompt.
- `ops/jarvis-boot.ps1`: the entry point. Starts the local agent, connects the existing pipe
  (`transport/pipe_server.py`), and **does nothing destructive until told to**.

### P2 — the PC reads D2L

**Deliverable:** a scheduled job that logs into `ldsb.mail.learningontario.ca`, reads the
assignments page for every course, and pushes what it found.

- **There is no MFA.** A plain password login. A stale session logs you out and needs a second
  attempt — handle that retry explicitly, it is the normal case and not an error.
- **Credential storage: DPAPI.** `apps/local-agent/jarvis_local/crypto/dpapi.py` already exists
  and is already the pattern for this machine. Store it there, not in a Cloudflare secret and
  not in the repo.
- **Push, don't pull.** `http/sync-routes.ts` already accepts signed pushes (`DISTILL_PATH`,
  `MEMORY_PROJECTION_PATH`, the sync service). Use that path. This PC's device key is
  accepted: a signed pull from it succeeded on 2026-09-23.
- **The scraper will break when the board restyles a page.** That is expected, not exceptional.
  Fail loudly, keep the last good read, and never report staleness as freshness.

### P3 — the report

**Deliverable:** the assignments reach him on Telegram.

- Reuse the existing digest/Telegram path rather than building a second one.
- **It must state `last_success_at`.** A scraper that breaks silently is the failure that
  matters here; the schema already has the column and the runbook pattern already exists.
- The report is *Jarvis's judgment about what to say* — so it goes in a tool description or the
  prompt, not in an `if`.

## Why this is Phase 4/5 work wearing a Phase 3 hat

D2L's email carries no deadline — see the `FACTS.md` row. So school deadlines need a machine that can act,
which is the same machinery Phase 5 needs. **Build the PC's ability to act and school follows.**
Do not build a D2L-specific mechanism that ignores this.

## Refuse these

- A `D2LIfLoggedIn` or `isSchoolHours` guard. The first makes a judgment call; the second makes
  code decide when Jarvis acts. Same shape as `callPlaceIfSensitive`, which is already recorded
  as the thing to refuse.
- Any handler that decides *whether the report is worth sending*.

## Method

- `pnpm exec vitest --config vitest.workspace.ts run <path>` — **file alone**. `pnpm --filter
  @jarvis/cloud-gateway test -- <pattern>` does not filter.
- The gateway's tests are never typechecked (`tsconfig.json` covers `src/**` only). Run the
  suites.
- Mutation-verify every guard: neuter, confirm a **named** test fails, restore, confirm it
  passes. Report both.
- Cite code as symbol plus `as of <sha>`.
- Search `docs/AGENT_LOG.md`; never read it.
- **Python work goes through `uv`** (`uv run …`), never bare `python`.

## Gates

```powershell
pnpm exec vitest --config vitest.workspace.ts run <each affected file alone>
pnpm --filter @jarvis/cloud-gateway typecheck
node scripts/check-state.mjs
```

Windows-side steps have no suite. **Run them by hand and say so** — including the shape of the
run, not just that it worked.

## What you owe

Push, open the PR, and post an entry at the top of `docs/AGENT_LOG.md`: what changed and why;
every mutation and its result; the exact gates and which suites they cover; what you did NOT do
and why; anything out of scope, named. **The `edit` anchor must include the heading you insert
above** — this has orphaned an entry twice. Verify structurally:
`git diff --numstat origin/main -- docs/AGENT_LOG.md` must show **0 deletions**.

Sign it with the model and effort you actually ran at; if you cannot determine them, say so.

## Stop condition

`docs/BUILDING.md`: build until the exit test passes, or until stuck. Stuck means stop and
report. If the D2L login turns out to need something Sid must do, stop and add a row to
`docs/OWNER-ACTIONS.md` rather than working around it.
