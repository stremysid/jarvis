# Gate tools

Two Windows PowerShell scripts on the reviewer's branch. They are not product
code and never ship. They exist because the review loop's two most expensive
mistakes were both mechanical:

- `pnpm test:all` is a `&&` chain, so the first failing package stops the
  later ones. Four hermes-runtime security tests sat red on main for six days
  because nobody saw them fail.
- A mutation whose `find` text silently matched nothing runs no mutation, the
  suite stays green, and it gets written up as SURVIVED. That happened twice by
  hand before `mutate.ps1` existed.

PowerShell, not bash: invoking the `pnpm`/`npx` shims from Git Bash on this
machine dies with `'C:\Program' is not recognized` before anything starts.
Both scripts run from any directory and quote every path, because this machine
has spaces in its program paths.

## `gate.ps1`

```powershell
pwsh -NoProfile -File gate.ps1 -Sha <sha> [-GateDir C:\Users\Sid\jarvis-pr39]
                                    [-IsolationRuns 3] [-HeartbeatSeconds 60]
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
   failure never stops a later package from reporting. Each package prints when
   it started, how long it took, and a heartbeat every `-HeartbeatSeconds`
   while it runs, because a package here has measured 824s and 1080s and a
   silent run and a hung one looked identical.
5. Flake classification, **on a rate**. For every test FILE that reported a
   failure, the file is re-run alone `-IsolationRuns` times (default 3), and
   each failing test is classified by how many of those runs it failed in:

   | Rate | Verdict |
   |---|---|
   | `failed N/N alone` | **REAL** - reproduced in every isolated run |
   | `failed 0/N alone` | **load flake** - reproduced in none |
   | `0 < k < N` | **INTERMITTENT** - neither claim is established |

   Every classified line prints the rate; a bare REAL/flake binary is what
   made the first version of this script report three REAL failures that a
   reviewer then found were all flakes. A single isolated re-run is not a
   control: it happens in the same loaded session as the full run, so a load
   flake fails again for the same reason it failed the first time.
6. One compact verdict block: sha, lint, typecheck, per-package file and test
   counts, then the REAL failures, the INTERMITTENT results, the load flakes
   and the known pre-existing failures, each named with its isolation rate
   rather than counted, and the exit code printed with its reason.
7. Exit 0 only when lint, typecheck and every package passed apart from load
   flakes, INTERMITTENT results and the known pre-existing hermes-runtime
   failures. Otherwise non-zero, and the output tails are printed. The verdict
   is three-valued: `FAIL` when something failed every isolation run (or lint,
   typecheck or an unverified run went red), `INCONCLUSIVE` when the only
   unresolved results are intermittent, `PASS` otherwise. An intermittent
   result exits 0 on purpose: the exit code answers exactly one question - did
   anything fail EVERY isolated run - and a mixed rate does not answer it. It
   is printed, named and rated rather than silently cleared, so nothing reads
   as clean.

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
- No GitHub. Neither script fetches a PR, reads a review, comments, approves,
  merges, deploys or applies a migration. `git fetch`, `checkout --detach`,
  `status` and `rev-parse` are the whole of their git use.
- No history rewriting. `mutate.ps1` restores from its own backup copy, and
  refuses to start on a dirty tree; it never commits, stashes or discards.
- No judgement about scope. The known-failure allowance is a list of test
  names, not an argument that those failures do not matter - they are security
  tests, and the constant is written down so it shrinks.
