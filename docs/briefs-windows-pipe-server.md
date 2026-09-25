# Task brief: a Windows launcher for the local agent's pipe server

You are a **builder** on `stremysid/jarvis`. Read `AGENTS.md` and
`docs/plan/2026-09-19-jarvis-roadmap.md` first. This brief is the task; those are standing and
this does not override them.

**Verify this brief before trusting it.** Written 2026-09-21 against `d0ec419`. Where it is
wrong, say so — that is a finding, not a nuisance.

## Why this exists

`docs/briefs-pc-controls.md` P1 built a boot chain that reaches an elevated `pwsh` and stops
there. `ops/jarvis-boot.ps1` probes the control pipe, finds nobody listening, and exits **3**
rather than reporting green over an empty pipe. That is correct behaviour, and it is the
finding: **nothing on Windows starts the local agent.**

- `apps/local-agent/jarvis_local/node.py` is the only thing that binds the control channel, and
  its `NodeSettings.from_config` refuses any platform whose `sys.platform` does not start with
  `linux` — the `current_platform.startswith("linux")` check.
- `apps/local-agent/jarvis_local/transport/pipe_server.py` is a complete, tested Windows
  named-pipe **server** with **no caller**.
- `apps/local-agent/jarvis_local/cli.py` already speaks the **client** half on Windows:
  `_control` routes to `send_control_request(command, DEFAULT_PIPE_NAME)` when `os.name == "nt"`
  and no `--pipe-name` or `--socket-path` is given.

So the missing piece is one process that binds `\\.\pipe\jarvis-local-agent`, answers the four
control commands, and runs the agent's own work. **P1's exit test cannot pass without it**, and
P2 and P3 sit behind it.

## Not a port. Say what you build.

`AGENTS.md` forbids porting the node as a side effect of another task, and that reading is
correct: a second launcher without the store wiring, the device-key handling and the cycle loop
would be a port wearing a different name.

**The requirement is one assembly, two platform bindings.** `build_node` already takes a
`ControlFactory` (`ControlFactory = Callable[[ControlServer, Path], ControlEndpoint]`) so the
transport is a parameter, and `_validate_existing_device_key` already guards its POSIX-only
check behind `_is_linux()`. Reuse that assembly. Do **not** copy `build_node` and change the
endpoint.

What is genuinely Windows-only, and what you are expected to add:

1. **An endpoint factory that returns `NamedPipeServer`** — a `ControlEndpoint` implementation
   over the existing `NamedPipeServer`, whose handlers already exist: `ControlServer`,
   `LocalAgentService`, `control_handlers(state, retry_quarantined=...)` are all
   transport-independent.
2. **A Windows settings path.** `NodeSettings.from_config` validates store paths with
   `_is_absolute_linux_path` (a `PurePosixPath` test), so a Windows configuration of
   `C:\...` paths is rejected before anything else runs. Splitting "this configuration is
   complete" from "this platform can host a node" is the change; keep the Linux refusal
   somewhere the CLI dispatch can still reach it, so `jarvis node` on Windows still says why.
3. **An entry point.** A module plus a CLI spelling. `jarvis service` (or a name you argue for
   in the PR body) that runs the service in the foreground, so a scheduled task can hold it —
   and so a human can run it by hand to see the failure.

## What the launcher must do, and why each part is load-bearing

- **Claim the pipe before touching a store.** `build_node` already calls `control.start()`
  before `open_stores`, with the reason in a comment: "A duplicate process must fail without
  doing any store work at all." Preserve that order and preserve the reason.
- **Take `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first instance.** `create_pipe_instance(...,
  first=True)` is what makes a second process fail loudly instead of two servers sharing one
  name. `NamedPipeServer.serve_forever` accepts a `listening` instance precisely so the
  bootstrap creates the first one **on the calling thread** and sees "that name is already
  taken" at startup rather than inside a background thread nobody is watching. Use it.
- **Set the DACL from the resolved SID, never a placeholder.** `owner_only_sddl` exists because
  the obvious SDDL for the owner, `OW` (CREATOR OWNER), stays literal when applied directly and
  produces a pipe its owner cannot open. `NamedPipeServer.__init__` already calls
  `current_user_sid()` and `owner_only_sddl` for you — do not pass an `sddl` of your own.
- **Keep `should_continue` honest.** The endpoint's loop predicate must reflect
  `ServiceState.stop_requested()` the way `NodeRuntime._control_should_continue` does, or `stop`
  and the cycle loop disagree about whether the process is stopping.
- **Print diagnoses, not exception values.** `run_node`'s boundary exists to keep traceback
  text, store contents and paths out of a log that a scheduled task writes on every logon. Match
  it. Nothing secret, no environment value, no path derived from a secret name.
- **Log where the boot chain logs**, or say in the PR why not:
  `%LOCALAPPDATA%\Jarvis\logs\` (see `ops/jarvis-boot.ps1`'s `-LogPath`).
- **Exit codes that a scheduled task can act on**, documented in the module docstring and in
  `docs/runbooks/pc-boot-chain.md`.

## What the launcher must not do

- **No decision about whether to run.** No `isSchoolHours`, no `D2LIfLoggedIn`, no "only if the
  owner is idle". Read `docs/CODE-VS-JUDGMENT.md` before you write any condition: code builds
  tools, Jarvis makes decisions. Deciding *when Jarvis acts* is the model's job, on a surface
  that says so.
- **No second reading of the configuration.** If `jarvis doctor` and `NodeSettings` disagree
  about what is required, one of them is wrong; do not add a third.
- **No secret handling at all.** The device key is already sealed by DPAPI —
  `platform_device_key_store` selects `WindowsDpapi` on Windows and seals under
  `DPAPI:` — and the `-Status` path in `ops/jarvis-autologon.ps1` never prints the Winlogon
  password. Do not add a new place a credential is read, written or logged.
- **No self-elevation.** The logon task is already `-RunLevel Highest`; a launcher that tries to
  elevate itself is a second, worse mechanism.
- **Do not bind the Unix socket on Windows.** `JARVIS_CONTROL_SOCKET` stays a Linux concept.

## Acceptance, and how to run it

The exit test is the P1 one, and it is by hand — there is no Windows suite here. From an
elevated `pwsh` in the repository root:

```powershell
pwsh -NoProfile -File ops/jarvis-boot.ps1 -ProbeOnly      # before: exit 3, no agent listening
# start the service the way the logon task will
pwsh -NoProfile -File ops/jarvis-boot.ps1                 # after: exit 0
uv run --project apps/local-agent jarvis status
pwsh -NoProfile -File ops/jarvis-boot.ps1 -ProbeOnly      # after: exit 0, agent already listening
```

The specific things to observe and report:

1. `jarvis status` over the pipe from a **non-elevated** shell answers. The DACL grants the
   owner, SYSTEM and administrators — so this is a real check that the resolved SID landed, not
   a check that the caller was root.
2. `ops/jarvis-boot.ps1` exits **0** and its log holds the agent's status lines.
3. A **second** launcher run fails loudly on the pipe name instead of serving alongside the
   first. Then confirm only one process is left running.
4. `jarvis stop` stops it, and the process exits rather than hanging on a listener thread.
5. Restart it and confirm a **second** instance does not exist afterwards.

**`ops/test-pc-controls.ps1`'s live-endpoint steps cannot run while the real service owns the
pipe** — `ops/boot_pipe_fixture.py` binds that same name. Run the fixture steps with the service
stopped, or with the fixture on a different `-PipeName`, and say which you did.

## Gates

```powershell
uv run --project apps/local-agent --group dev pytest -q
uv run --project apps/local-agent --group dev mypy jarvis_local            # run from apps/local-agent
uv run --project apps/local-agent --group dev ruff check .
node scripts/check-state.mjs
```

Run one test file alone when you are iterating — `uv run ... pytest -q tests/transport/test_pipe_server.py`.
**Python work goes through `uv`**, never bare `python`.

`pnpm test` is not a gate for this unless you touch TypeScript. If you do not run it, say so
rather than leaving it to imply.

**Mutation-verify every guard you add.** Neuter it, confirm a **named** test fails, restore,
confirm it passes, and report both. Two guards in this area already carry a mutant apiece
(`ops/mutation-oversized-bound.ps1`, `ops/mutation-task-runlevel.ps1`) because a green suite
proves nothing about a guard nobody exercised. If your guard is only reachable on Windows and
the CI runs on Linux, say so plainly and give the by-hand observation instead — an unreachable
guard is indistinguishable from a broken one, and `AGENTS.md` says to write that down rather
than imply it away.

## Traps already paid for here

- **`NamedPipeClientStream` takes a bare pipe name.** The full `\\.\pipe\jarvis-local-agent` path
  that `DEFAULT_PIPE_NAME` holds is treated as remote and times out against a listening pipe.
- **`[byte]10 -shl 16` is `0` in PowerShell**, not 655360 — `-shl` widens to the operand's
  width. Cast to `[int]`. This produced a green step in P1's own suite.
- **A worktree's `.git` is a file, not a directory**, so a commit-message file written inside it
  fails with *"a parent path segment is not a directory"*. Write messages outside the worktree.
- **`git add -A` commits your scratch files.** Write the message to a file, pass `-F`.
- **The gateway's tests are never typechecked** (`tsconfig.json` covers `src/**` only). Not
  relevant unless you touch TypeScript.

## Worktree rule

`C:\javis` is the live deploy checkout and is **off limits even though your session starts
there**:

```powershell
git -C C:\javis worktree add C:\w\pipesrv -b <branch>
# work only under C:\w\pipesrv
git -C C:\javis worktree remove C:\w\pipesrv    # after pushing
```

## Absolute rules

- **Never merge, deploy, apply a migration, touch a secret, spend money, sign up for anything,
  or contact any person or service.** You open the PR; the reviewer merges.
- **Never claim a test result you did not observe.**
- **Never guess.** Beginning from a hypothesis is fine; acting on an unproven one is not.
- **Windows only, `pwsh`, not bash.** There is no Linux machine in this fleet.

## What you owe

Push, open the PR, and post an entry at the top of `docs/AGENT_LOG.md`: what changed and why;
every mutation and its result; the exact gates and which suites they cover; what you did NOT do
and why; anything out of scope, named rather than silently fixed. **The `edit` anchor must
include the heading you insert above** — this has orphaned an entry twice. Verify structurally:
`git diff --numstat origin/main -- docs/AGENT_LOG.md` must show **0 deletions**.

Also update, in the same PR: `docs/QUEUE.md`'s "No Windows launcher for the local agent" row,
`docs/runbooks/pc-boot-chain.md`'s "What is missing, and why the chain stops at exit 3" section,
and `docs/STATE.md` if P1's verdict moves.

Sign it with the model and effort you actually ran at; if you cannot determine them, say so.

## Stop condition

`docs/BUILDING.md`: build until the exit test passes, or until stuck. Stuck means stop and
report. If the Windows service turns out to need something only Sid can supply — a scheduled-task
change, a credential, a decision about where the store lives — stop and add a row to
`docs/OWNER-ACTIONS.md` rather than working around it.
