# Mutation specs — 2026-09-18

Every sweep run on 2026-09-18, kept so the results in `docs/AGENT_LOG.md` can be
reproduced rather than taken on trust. Run one with:

    pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:/Users/Sid/jarvis-gate/reviewer-tools/mutate.ps1' -Spec 'C:/Users/Sid/jarvis-gate/reviewer-tools/mutation-specs-2026-09-18/<spec>.json' -GateDir '<a worktree at the right sha, deps installed>'

Forward-slash paths. The gate directory must be clean and checked out at the
commit the spec was written against — several `find` strings will not match
otherwise, and the tool will correctly refuse rather than report a false
survivor.

| Spec | PR | What it plants | Result |
|---|---|---|---|
| `m4spec.json` | #97 | the Classroom never-scanned gap reverted to active-only, plus an unmatchable control | KILLED; control NOT APPLIED |
| `pr99spec.json` | #99 | projection anti-join disabled; restricted-source guard made unmatchable | both KILLED |
| `pr99spec2.json` | #99 | the version-number clause of `memory_topic_note_versions_insert_guard` made unreachable | KILLED |
| `pr100spec.json` | #100 | sensitivity downgrade; suppressed wording echoed; authority check bypassed; stale-target guard removed | 3 KILLED, 1 SURVIVED |
| `pr100spec2.json` | #100 | the repository-level stale-target guard, alone and with the service-level one | both SURVIVED |
| `pr100spec3.json` | #100 | both application guards **and** the `0016` transition trigger clause | KILLED |
| `pr98verify.json` | #98 | control: both candidate queries neutered with the guard intact; then both plus the guard | SURVIVED, then KILLED |
| `f1spec.json` | #98 | the first attempt at F1 — **withdrawn** | see below |
| `f1control.json` | #98 | the control that withdrew it | KILLED |
| `f2spec.json` | #98 | same-file two-edit restore, and `expect: "*"` must not glob | SURVIVED, SURVIVED |

## The two that matter most

`pr100spec2.json` and `pr100spec3.json` together are an attribution, not a
defect: "a memory that is no longer current cannot be replaced" is carried
entirely by the database trigger in `0016`. Both application-level checks can be
deleted with nothing observable changing; delete them together with the trigger
clause and the test dies immediately.

`f1spec.json` and `f1control.json` are kept as a worked example of the mistake
this tooling exists to prevent. `f1spec` reported KILLED and was read as proof
that a guard was pinned. `f1control` plants only the *fixture* half of that same
mutation — and it also reports KILLED. So the original result proved nothing:
the test was dying because of the fixture edit, not the guard. A mutation
without a control is not evidence. The tool cannot catch a badly designed
experiment; only a control can.

`f2spec.json` is the tooling's own regression test. Two edits to the same file
must restore byte-identically, and `expect: "*"` must not be treated as a
wildcard that matches any failing test.
