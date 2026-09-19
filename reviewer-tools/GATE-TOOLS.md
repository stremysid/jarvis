# Gate tools

Three Windows PowerShell scripts on the reviewer's branch. They are not product
code and never ship. (`docs-check.ps1` is a fourth and
`migration-numbers.verify.ps1` a fifth; each explains itself in its own header.)
They exist because the review loop's most expensive mistakes have been
mechanical:

- `pnpm test:all` is a `&&` chain, so the first failing package stops the
  later ones. Four hermes-runtime security tests sat red on main for six days
  because nobody saw them fail.
- A mutation whose `find` text silently matched nothing runs no mutation, the
  suite stays green, and it gets written up as SURVIVED. That happened twice by
  hand before `mutate.ps1` existed.
- Two branches each picked "the next free migration number" by looking at main,
  where the other branch's file did not exist yet. Both claimed `0018`, and
  later both claimed `0035`. A human found each by eye, after the fact.
  `migration-numbers.ps1` exists so that does not need a human eye.

PowerShell, not bash: invoking the `pnpm`/`npx` shims from Git Bash on this
machine dies with `'C:\Program' is not recognized` before anything starts.
The scripts run from any directory and quote every path, because this machine
has spaces in its program paths.

## `gate.ps1`

```powershell
pwsh -NoProfile -File gate.ps1 -Sha <sha> [-GateDir C:\Users\Sid\jarvis-pr39]
```

What it does, in order:

1. `git fetch origin -q`, `git checkout --detach <sha> -q` in the gate copy,
   then **proves** `HEAD` is the commit that was asked for and aborts loudly if
   it is not. A verdict about the wrong commit is worse than no verdict.
   It also refuses to start on a dirty gate copy.
2. `pnpm install --frozen-lockfile`. It stops here if that fails; nothing
   after it would be about the reviewed dependency graph.
3. `pnpm lint` and `pnpm typecheck`, recorded separately.
4. The three packages, **separately and unconditionally** - never `test:all`:
   `pnpm test`, then `pnpm test:runtime`, then `pnpm test:watchdog`. An earlier
   failure never stops a later package from reporting.
5. Flake classification. For every test FILE that reported a failure, the file
   is re-run alone. A test that passes alone is a load flake; one that fails
   alone is real. The suite is load-sensitive and the two are different claims.
6. One compact verdict block: sha, lint, typecheck, per-package file and test
   counts, then the REAL failures, the load flakes, and the known pre-existing
   failures, each named rather than counted.
7. Exit 0 only when lint, typecheck and every package passed apart from load
   flakes and the known pre-existing hermes-runtime failures. Otherwise
   non-zero, and the output tails are printed.

The allowance is a named constant at the top of the file
(`$KnownPreExistingFailures`), matched on file **and** test name. It must
shrink as those defects are fixed and must never grow silently - adding an
entry is a review decision, not a convenience. Matching on the file alone
would excuse any future failure in that file.

Two places the script does something other than what the loop's shorthand
says, on purpose:

- The alone-run uses the runner that can host the file. The shorthand
  `npx vitest --config vitest.workspace.ts run <file>` is right for the
  gateway, contracts and acceptance tests, but the workspace config does not
  include `apps/hermes-runtime` or `apps/watchdog`; they are Node packages with
  their own configs. The shorthand there reports "No test files found", which
  would misread every runtime failure as REAL. Same intent, correct runner.
- Vitest 4's default reporter prints failing tests as a tree
  (`<mark> <file> (N tests | M failed)` then `× <test name>`), not as the
  classic `FAIL <file> > <name>` lines. Both shapes are parsed, duplicates are
  merged on the test's last `> ` segment, and the package's own summary count
  is the backstop: a failure the parser could not name is reported as an error
  instead of being quietly absent from both lists.

## `mutate.ps1`

```powershell
pwsh -NoProfile -File mutate.ps1 -Spec <spec.json> [-GateDir C:\Users\Sid\jarvis-pr40]
```

The spec is a JSON array of
`{ "name", "file", "find", "replace", "testPath", "expect" }`:

- `file` and `testPath` are relative to the gate directory;
- `find` and `replace` are **literal** strings, not regexes;
- `expect` is a substring of the test name that should die.

For each mutation it backs the file up byte-for-byte, applies the literal
replacement, then **verifies the file actually changed and the replacement text
is present before running any test**. `find` must occur exactly once: zero
matches is `NOT APPLIED` and more than one is `NOT APPLIED` too, because
guessing which occurrence was meant is not a mutation. `NOT APPLIED` is an
error, never a result - the whole reason this script exists is that a silent
non-match used to be written up as SURVIVED.

It then runs the target tests, records the names of the tests that failed, and
restores the file from the backup in a `finally` block, so an exception or a
Ctrl-C cannot leave a mutated tree. At the end it verifies every touched file
is byte-identical to its backup and says so.

A baseline run of each distinct `testPath` happens first, so a test that was
already red cannot be counted as a kill. Verdicts:

| Verdict | Meaning |
|---|---|
| `KILLED` | a test that was green at baseline died, and it is the expected one |
| `KILLED/OTHER` | a new test died, but not the expected one - its own verdict, never a pass |
| `SURVIVED` | no test that passed at baseline failed |
| `NOT APPLIED` | `find` did not match exactly once; nothing was run |
| `INVALID` | a failure the parser could not name, or a runner that failed without naming a test - skips, timeouts and crashes are not kills |

Exit 0 only when every mutation was applied and every kill named the expected
test.

## `migration-numbers.ps1`

```powershell
pwsh -NoProfile -File migration-numbers.ps1 [-Repo C:\Users\Sid\jarvis-migcheck]
```

It answers two questions before a migration number is accepted: is any number
contested by more than one branch, and what is the next genuinely free number.

It enumerates **every head on origin** with `git ls-remote --heads origin` and
reads each one's migrations with `git ls-tree` against the sha that command
reports, so it never checks a branch out and never touches a working tree. It
used to enumerate `gh pr list` instead, which was a blind spot with teeth: the
standing rule here is "push before you finish", so the window in which two
builders collide is exactly the window in which the second branch is pushed and
has no PR yet. On 2026-09-18 it said `verdict: clean, next genuinely free
number: 0037` while two branches both held `0036`. PR numbers are still printed
next to a branch that has one; they no longer decide which branches are read,
and a `gh` that is missing, unauthenticated or pointed at a non-GitHub remote
no longer aborts the run - it degrades the PR column and nothing else.

Two rules keep a full scan from reporting the same stale news forever, and both
are printed rather than applied silently:

- A branch whose tip is an ancestor of `origin/main` is excluded: its commits
  are main's commits. Every excluded ref is named at the bottom of the output.
- A branch is compared against **its own merge-base with main**, not against
  main's tip. A branch that forked before a migration was edited on main holds
  the older bytes without ever having touched the file; merging it cannot change
  the file, so it is not read as a claim.

Findings come in three kinds, and only the first sets the verdict:

- `COLLISION` - a number main does not apply that two pending branches claim
  with different filenames, or, at a number main does apply, a pending branch
  changing that migration's bytes. Exit 1.
- `STALE` - main already applies the number under another name and a branch
  that forked earlier claims it too. Printed, not counted.
- `REVISION` - one filename at different revisions where main has not applied
  the number yet, which is what a superseded branch normally looks like. Printed,
  not counted.

- `-Repo` defaults to the repository the script lives in (the parent of
  `reviewer-tools/`), **not** to a shared checkout path. `docs-check.ps1`
  defaults to `C:/javis`, so running it from a worktree silently checks the
  wrong tree; this script cannot, because every git call is rooted at the
  resolved repository and the resolved path plus the branch census is printed
  at the top of the output.
- It fetches `origin` before enumerating. A scan of stale refs can report a
  collision that has since been resolved, or miss one just created, so a fetch
  failure aborts rather than answering from refs that may no longer match. If a
  push lands between the fetch and the enumeration, the affected branch cannot
  be compared and the run aborts (exit 2) naming it, rather than treating an
  unread branch as a branch with nothing to report.
- The next free number is the smallest number above the highest number on
  `origin/main` that no pending branch claims - not a gap below it, because a gap
  was either applied or deliberately skipped, and Wrangler applies by name.
- Exit 0 clean, 1 contested collision, 2 could not produce a usable answer (not
  a repository, no `origin/main`, fetch failed, a branch that cannot be
  compared). The exit-2 output says ABORTED and never prints a clean verdict.

## `migration-numbers.verify.ps1`

```powershell
pwsh -NoProfile -File migration-numbers.verify.ps1 [-Scratch C:/Temp/migration-numbers-verify]
```

Builds a throwaway bare origin plus a clone under `-Scratch` and constructs one
repository state per verdict - clean, contested, revision, stale, applied-edit,
merged - then runs `migration-numbers.ps1` against each and compares the exit
code and the finding printed. Three of those states are "not a collision", which
is indistinguishable from a rule that never fires, so the fixture is what makes
the classifications load-bearing rather than merely written down. The fixture
has no GitHub remote, which is also how the `PR context: unavailable` path gets
exercised. Exit 0 when every case matched, 1 when one did not, 2 when the
fixture could not be built. It touches nothing outside `-Scratch`.

## Worked example: `gate.ps1`

Run at `origin/main` head on 2026-09-18 in `C:\Users\Sid\jarvis-pr39`:

```text
GATE-EXAMPLE-PLACEHOLDER
```

## Worked example: `mutate.ps1`

Spec (`sanity.json`, two entries: one that must be killed, one whose `find` is
not in the file at all):

```json
[
  {
    "name": "canonical-json-nfc-normalization",
    "file": "packages/contracts/src/canonical-json.ts",
    "find": "  return value.normalize(\"NFC\");",
    "replace": "  return value;",
    "testPath": "packages/contracts/test/canonical-json.test.ts",
    "expect": "normalizes NFC before hashing a payload"
  },
  {
    "name": "spec-find-that-is-not-in-the-file",
    "file": "packages/contracts/src/canonical-json.ts",
    "find": "  // this literal occurs nowhere in this file",
    "replace": "  // so the mutation must never be reported as a result",
    "testPath": "packages/contracts/test/canonical-json.test.ts",
    "expect": "normalizes NFC before hashing a payload"
  }
]
```

```text
mutate: C:\Users\Sid\jarvis-pr40 at 8a441a86a4ff, 2 mutation(s)
baseline: packages/contracts/test/canonical-json.test.ts
baseline packages/contracts/test/canonical-json.test.ts : green (exit 0)
KILLED  canonical-json-nfc-normalization
NOT APPLIED  spec-find-that-is-not-in-the-file - find does not occur in the file

===== MUTATION SUMMARY =====
mutation                           verdict        expected
canonical-json-nfc-normalization   KILLED         died
    killed: canonical JSON > normalizes NFC before hashing a payload
    killed: canonical JSON > sorts object keys into RFC 8785 canonical JSON
spec-find-that-is-not-in-the-file  NOT APPLIED    -
    note:   find does not occur in the file
killed 1 | killed-wrong-test 0 | survived 0 | not applied 1 | invalid 0
restore verified: 2 file(s) byte-identical to backup
============================
```

Exit code 1, because `NOT APPLIED` is an error even though the other entry was
killed.

## Worked example: `migration-numbers.ps1`

Run from `C:\Users\Sid\jarvis-migcheck` on 2026-09-18, when main was at `0034`
and 128 heads existed on origin. The two lists at the bottom - every excluded
merged ref, and every pending branch with its claim - are elided here; the run
prints all of them.

```text
===== MIGRATION NUMBER CHECK =====
repo:       C:/Users/Sid/jarvis-migcheck
migrations: apps/cloud-gateway/src/persistence/migrations
branches:   128 head(s) on origin besides main, every one enumerated from git ls-remote
             101 excluded - an ancestor of origin/main, so nothing on it is not already on main
              27 pending - compared against its own fork point, not against main's tip
               7 of those changed a migration file
PR context: 5 open pull request(s)
            PR numbers are context only: every head on origin is read whether or not it has one.
claims:     34 migration file(s) on main; 7 added or changed by a pending branch

COLLISION 0036 - 2 different migrations claim this number:
    0036_email_read_everything.sql  [bf40ffb50d]
        origin/codex/email-read-everything  (no PR, forked at main@0034)
    0036_owner_sensitive_action_pin.sql  [73f6b6903c]
        origin/codex/r1-sensitive-action-pin-v6  (PR #96, forked at main@0034)

STALE 0027 - main already applies this number, and a branch that forked earlier claims it too:
    0027_school_observations.sql  [72d65882a2]
        origin/main  (no PR)
    0027_school_progress.sql  [dbcabdb148]
        origin/codex/r5-grades-missing-work-step5  (no PR, forked at main@0025)

REVISION 0035 - the same filename at different revisions on branches that all still claim it:
    0035_autonomy_tool_capabilities.sql  [2c0df4804a]
        origin/claude/tier3-on-main  (no PR, forked at main@0034)
    0035_autonomy_tool_capabilities.sql  [26e447f4ae]
        origin/codex/tier3-classify-memory-correct  (PR #106, forked at main@0034)
    0035_autonomy_tool_capabilities.sql  [2c0df4804a]
        origin/codex/wire-autonomy-tier3  (no PR, forked at main@0034)

next genuinely free number: 0038
verdict: COLLISION - 1 number(s) contested by more than one pending branch
note:    1 stale claim(s) above are printed but not counted: a branch that cannot land as numbered is not a number two builders are racing for.
note:    1 revision(s) above are printed but not counted: nothing has shipped at that number, so a superseded copy is an old branch, not a defect.
==================================

EXCLUDED (101) - already merged into origin/main, printed so the filter is auditable:
    [... every merged ref, named ...]
PENDING (27) - read for claims; 7 changed a migration file:
    [... every pending ref, with its PR number and the file it claims ...]
==================================
```

Exit code 1. The one collision that sets it is `0036`, named on both sides -
including `origin/codex/email-read-everything`, which was pushed and had no PR,
which is why the `gh pr list` version of this script called the same repository
clean. With a path outside any repository the same invocation prints the
`ABORTED` banner and exits 2.

`GATE-TOOLS.md` is not in `docs-check.ps1`'s default file list, and this example
is part of why: a pasted run names migrations that live on branches rather than
on main, and `[blobprefix]` reads as a sha that resolves to nothing. Passed
explicitly, `docs-check.ps1` flags both here, in this example and in the older
one it replaced.

## What these do NOT do

**They decide nothing.** They run checks and plant faults. Choosing what to
review, judging whether a guard reads the right input, and deciding whether a
green test would actually fail when the property it names is violated all stay
with the reviewer. A `KILLED` verdict says a named test failed, not that the
test's assertion is the right one; a killed by a test that only asserts a
string was removed proves nothing, and the scripts cannot tell the difference.

- No Python. `gate.ps1` runs neither the local agent (`uv run pytest`, ruff,
  mypy) nor any migration rehearsal; `mutate.ps1` has no pytest runner here.
- No voice gates. `typecheck:voice-access` and `test:voice-access` are not run.
- No test typecheck. `tsconfig.test.json` reports 117 pre-existing errors and
  is not a CI gate, so it is not run either.
- No GitHub writes. None of the scripts comments, approves, merges, deploys or
  applies a migration. `migration-numbers.ps1` is the only one that fetches and
  the only one that talks to GitHub, and its `gh pr list` is decoration: if it
  fails, the run still reads every branch and says so. Its git use is `fetch`,
  `ls-remote`, `merge-base`, `ls-tree` and `rev-parse`, and it never checks
  anything out. `gate.ps1` and `mutate.ps1` use only `git fetch`,
  `checkout --detach`, `status` and `rev-parse`.
- No history rewriting. `mutate.ps1` restores from its own backup copy, and
  refuses to start on a dirty tree; it never commits, stashes or discards.
- No judgement about scope. The known-failure allowance is a list of test
  names, not an argument that those failures do not matter - they are security
  tests, and the constant is written down so it shrinks.
