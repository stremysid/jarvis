# Task brief: P2 — the PC reads D2L while logged in

You are a **builder** on `stremysid/jarvis`. Read `AGENTS.md` and
`docs/plan/2026-09-19-jarvis-roadmap.md` first. This brief is the task; those are standing and
this does not override them.

**Verify this brief before trusting it.** Written 2026-09-22 against `f6bab5b`. Where it is
wrong, say so — that is a finding, not a nuisance.

## Why this exists, and why it is the only route left

Phase 3's exit test is *"a D2L email arrives and the deadline appears with nothing from you."*
**That test cannot pass by email.** Sid enabled every notification option; D2L sends an activity
summary naming the course, a count such as *"76 New Emails"*, and a link. No assignment, no date.
The dates are behind the D2L login. Classroom is impossible on this board. The Brightspace feed
does not exist. All four are in `docs/FACTS.md` — read the rows rather than re-deriving them.

So the only machine that can read a deadline is one that is **logged in as Sid**, and the only
one of those is the PC. That is this brief.

P2 is also **Phase 4/5 work wearing a Phase 3 hat**: a machine that can act on its own. Build the
PC's ability to act and school follows. Do not build a D2L-specific mechanism that ignores this.

## What already exists — read it before designing

Most of the cloud half is built. The gap is the reader, not the store.

| Piece | Where | What it gives you |
|---|---|---|
| The observation store | `src/school/school-observation-repository.ts`, `migration 0027_school_observations.sql` | `school_assignment_observations` + `_revisions`, and the missing-work derivation |
| A source-agnostic sync | `src/school/classroom-observation-sync.ts` | `ClassroomSubmissionPageReader.listSubmissionPage(courseId, pageToken)` — **the client is an interface, not Classroom**. It reports `outcome`, `pages`, `seen`, `undatedCoursework`, `rejected`, `transitions`, and holds a D1 statement budget |
| Deadlines | `migration 0011_deadlines.sql` | `deadlines`, `deadline_sources` — `last_success_at` lives here, and P3 needs it |
| The device's signed push | `src/http/sync-routes.ts` | accepts `/sync/pull`, `/sync/ack`, `/memory/distill` (`DISTILL_PATH`), `/sync/memory/project` (`MEMORY_PROJECTION_PATH`) |
| Credential sealing | `jarvis_local/crypto/dpapi.py` | `DpapiProtector.protect(bytes) -> bytes` / `.unprotect`. Already the pattern this machine uses for the device key |
| A running agent to host the work | #145 | `jarvis serve`, started at logon. **This is why #145 must land first** |

**The open design question this brief deliberately does not answer for you:** how the parsed
assignment reaches `SchoolObservationRepository`. Two shapes:

1. **PC parses, pushes observations** — a new signed route beside `MEMORY_PROJECTION_PATH`, and
   the gateway writes through the existing repository. The PC never needs the derivation logic.
2. **PC presents pages, cloud derives** — the PC is a remote implementation of the page-reader
   interface and the cloud keeps `classroom-observation-sync`'s logic.

**Choose one and argue it in the PR body.** Shape 1 keeps the board-specific parsing where the
board's HTML is; shape 2 keeps one derivation path. Say which you picked and what it costs.

## Absolute rules

- **Never merge, deploy, apply a migration, touch a secret, spend money, sign up for anything, or
  contact any person or service.** **Including D2L** — you may not log in, and you may not test
  against the live board. That is an owner action, not yours.
- **Never claim a test result you did not observe.**
- **Never guess.** Hypothesis fine; acting on an unproven one is not.
- **Never put a credential, password, session cookie or board URL into source, tests, fixtures,
  logs or commit messages.** The school password is Sid's, and it goes to DPAPI on his machine or
  nowhere.
- **Windows only, `pwsh`, not bash.**
- **Code builds tools; Jarvis makes every decision.** Read `docs/CODE-VS-JUDGMENT.md` before
  writing any condition.

## What to build

### 1. Credential storage

Sid's school password and login session are sealed with **DPAPI** on the PC — `WindowsDpapi`,
already in the tree, already used for the device key. Not a Cloudflare secret, not the repo, not
the archive, not an environment variable in a committed file.

**The session is the thing worth storing.** Whether you persist a cookie jar or a password
depends on what the login actually needs — and since you cannot log in to find out, **say which
you chose and what you could not verify.** A stale session logs you out and needs a second
attempt; that is the normal case, not an error, and it must be handled explicitly.

### 2. The scrape

Log in, walk every course's assignments page, parse what is there. You are writing a parser for
HTML you cannot see. Therefore:

- **Every parse failure must be loud and named**, never a silently empty result.
- **A page whose shape you did not expect is a failure, not "no assignments."** Those are
  different facts and only one of them is safe to report.
- **Record what you actually saw**: courses attempted, courses parsed, assignments found, items
  skipped and why. P3 needs those numbers and the audit's finding 2.2 exists because a source can
  succeed while yielding nothing.
- **Prefer a selector set that fails closed.** A missing element should refuse, not return `null`
  and continue.

**You cannot test this against the real board**, so the tests must be against **fixtures you
write for the shape you expect** — and say plainly in the PR that a fixture proves the parser
handles the shape you assumed, not the shape the board has. That distinction belongs in the PR
body, not implied away.

### 3. Push, not pull

The device is already enrolled and `http/sync-routes.ts` already accepts signed pushes. Use that
path. Do not add a second authentication mechanism, and do not have the cloud poll the PC.

### 4. Never report staleness as freshness

The scraper **will** break when the board restyles a page. That is expected, not exceptional.
Keep the last good read, fail loudly when a read fails, and make the failure visible in a way P3
can state. A silent break that keeps serving the last success is the failure that matters here.

## Refuse these

- **A `D2LIfLoggedIn` or `isSchoolHours` guard.** The first decides whether to act; the second
  makes code decide when Jarvis acts. Same shape as `callPlaceIfSensitive`, already recorded as
  the thing to refuse.
- **Any handler that decides whether a found assignment is worth reporting.** That is judgment.
- **A second scheduler.** #145's logon task and the existing cycle loop are the cadence.
- **A `--pipe-name`-style second configuration surface** the cloud cannot see.

## Gates

```powershell
uv run --project apps/local-agent --group dev pytest -q
uv run --project apps/local-agent --group dev mypy jarvis_local     # cwd apps/local-agent
uv run --project apps/local-agent --group dev ruff check .
pnpm exec vitest --config vitest.workspace.ts run <each affected file alone>
pnpm --filter @jarvis/cloud-gateway typecheck
pnpm --filter @jarvis/cloud-gateway typecheck:tests   # 144 pre-existing errors; must not grow
node scripts/check-state.mjs
```

Run one test file alone while iterating. **Mutation-verify every guard**: neuter it, confirm a
**named** test fails, restore, confirm it passes, report both. A guard that survives neutering
with a green suite is unpinned and will be sent back — this repository has three recorded
instances of exactly that, including a guard of mine that a test could not reach.

**Fixture tests are not evidence about the board.** Say so where it matters.

## What you owe

Push, open the PR, and post an entry at the top of `docs/AGENT_LOG.md`: what changed and why;
every mutation and its result; the exact gates and which suites they cover; what you did NOT do
and why; anything out of scope, named.

**Verify no entry was dropped** by comparing the set of `^## ` headings between `origin/main` and
your branch. `git diff --numstat` alone cannot detect a dropped entry — a missing entry and a
differently-sized insertion present identically. Also expect conflict markers to be more
interesting than they look: this repository's own log entries contain markdown tables, and a
`=======` row inside one can be matched as a conflict marker.

Sign with the model and reasoning effort you actually ran at; if you cannot determine them, say so.

## Stop condition

`docs/BUILDING.md`: build until the exit test passes, or until stuck. Stuck means stop and report.

**Expect to get stuck on the login, and that is not failure.** You cannot see the board, so you
cannot know what its login form looks like. If that blocks you: **stop, write exactly what you
need Sid to do** — one action, in `docs/OWNER-ACTIONS.md`, specific enough that he can paste the
result back. Do not guess credentials, invent selectors, or work around the login with browser
automation that stores a session he did not grant.
