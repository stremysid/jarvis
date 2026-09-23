# The PC boot chain

> **P1 of three.** This runbook installs what happens between pressing the power
> button and an elevated Jarvis process being alive. It now starts the agent as
> well as the entry point that runs it: `ops/jarvis-boot.ps1` finishes by starting
> `jarvis serve` and waiting for its control pipe to answer. See *What the agent
> needed, and why the chain used to stop at exit 3* below.
>
> **Read this first if you are Sid.** The auto-login it sets up stores your
> Windows password in the registry, and anyone who powers the machine on gets a
> logged-in desktop with your mail, files and browser sessions unlocked. You
> stated on 2026-09-21 that you have read and accept that. It is written here so
> the next person to read this file knows it was a decision and not an oversight.

## What this installs

| Step | What does it | Command |
|---|---|---|
| 1 | Auto-login: power on lands on the desktop with nobody at the keyboard | `ops/jarvis-autologon.ps1` |
| 2 | A logon-triggered scheduled task at `-RunLevel Highest`: the desktop appears, and the elevated process starts with no UAC prompt | `ops/jarvis-logon-task.ps1` |
| 3 | The entry point that task runs: checks the agent's configuration, starts `jarvis serve`, and waits for its control pipe | `ops/jarvis-boot.ps1` |

Exactly one machine in the fleet is the host: the **Windows 11 home PC**, one
local account, `Sid`. `Sid` is not a domain account, so every place a domain name
is required it is the computer name — `SID`.

## 1. Auto-login

`ops/jarvis-autologon.ps1` writes four values under
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`:
`AutoAdminLogon`, `DefaultUserName`, `DefaultDomainName`, `DefaultPassword`.
Windows reads those before any user profile exists, which is why the password
cannot live in DPAPI.

**The password is plaintext at rest.** Three alternatives were considered and
rejected; the reasoning is in the script's own comment-based help, and the one
that is a genuine improvement is the LSA secret written by Sysinternals
`Autologon.exe`. This repository may not download and run a third-party
executable, so that one is yours to run if you want it: it ends at the same four
values and the same desktop, and Windows deletes `DefaultPassword` itself after
the first successful auto-logon. It is not required for the chain to work.

### Check the current state (unelevated)

```powershell
& C:\javis\ops\jarvis-autologon.ps1 -Status
```

Observed on this machine, 2026-09-21, unelevated:

```text
winlogon_key        HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon
auto_admin_logon    True
default_user_name   Sid
default_domain_name SID
password_present    True
password_location   registry REG_SZ (plaintext at rest)
```

**Auto-login is already configured on this machine.** That is not something this
runbook did; it was set up before 2026-09-21 and no document recorded it. The
running of step 1 below is therefore a re-assertion, not a first install.

`-Status` prints whether a password is present, never a length and never a
prefix. "Eight characters" narrows a search space, which is the same disclosure
with extra steps.

### Install (elevated)

**Run it in the elevated session, with `&`, not through a second `pwsh`.** A
`SecureString` does not survive a process boundary: `pwsh -File ops/jarvis-autologon.ps1
-Password $s` reaches the script as a plain `String` and fails with

```text
Cannot convert the value of type "System.String" to type "System.Security.SecureString"
```

Measured 2026-09-21, through both `-File` and `-Command`. Start an elevated
terminal and run:

```powershell
$secure = Read-Host -AsSecureString -Prompt 'Windows password'
& C:\javis\ops\jarvis-autologon.ps1 -UserName Sid -Domain SID -Password $secure
```

The script asserts elevation itself and refuses with a sentence naming what to
do; it does not half-install. It reads its own values back and throws if
`AutoAdminLogon` is not `1` afterwards, because a machine that boots to the logon
screen is the failure this whole file exists to prevent.

To undo: `& C:\javis\ops\jarvis-autologon.ps1 -Remove` (elevated, prompts).

## 2. The logon task

`ops/jarvis-logon-task.ps1` registers one task under the name **`Jarvis boot
chain`**. Four settings matter, and the script sets each for a stated reason:

- **`-AtLogOn`, with the account named.** A task that fires for any user fires
  for the wrong one after a failed logon.
- **`-RunLevel Highest`.** This is what removes the UAC prompt. A registered task
  carries its principal's run level into the process it starts; a shortcut, a Run
  key or a Startup-folder entry would each raise a consent dialog, and a UAC
  prompt at 08:00 with nobody at the keyboard is a dead boot chain.
- **`-LogonType Interactive`.** `Password` would store a second copy of the
  password; `S4U` cannot reach network or encrypted resources as the user.
  `Interactive` uses the token auto-login already created.
- **`-ExecutionTimeLimit 0`.** Serialized as `PT0S`. The default is `PT72H` —
  three days, after which Task Scheduler kills a process meant to be resident for
  months, silently. `RestartCount 3` / `RestartInterval PT1M` covers the other
  half: a machine that booted, ran Jarvis for four seconds and looked fine.

### See what it would register (unelevated)

`-WhatIf` builds everything and stops before registering, so this needs no
elevation. This is also what `ops/test-pc-controls.ps1` grades:

```powershell
& C:\javis\ops\jarvis-logon-task.ps1 -UserName Sid -WhatIf
```

Observed on this machine, 2026-09-21, unelevated, from `C:\w\pcc`:

```text
would_register      Jarvis boot chain
user_id             SID\Sid
logon_type          Interactive
run_level           Highest
trigger             MSFT_TaskLogonTrigger
execution_limit     PT0S
restart_count       3
restart_interval    PT1M
action_execute      C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe
action_arguments    -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\w\pcc\ops\jarvis-boot.ps1"
```

`action_execute` is the WindowsApps alias for `pwsh`, and it is the same path
`Get-Command pwsh` resolves to. It is an App Execution Alias rather than a real
file; that is what a Store-installed PowerShell looks like and Task Scheduler
launches it.

### Install (elevated)

```powershell
& C:\javis\ops\jarvis-logon-task.ps1 -UserName Sid
```

To undo: `& C:\javis\ops\jarvis-logon-task.ps1 -Remove` (elevated, prompts).

## 3. `ops/jarvis-boot.ps1`

The task runs this, elevated, at every logon. It is idempotent, because a logon
task runs on every logon including the ones after a crash. In order:

1. Takes the `Global\JarvisBootChain` mutex. Two copies would both try to own the
   named pipe, and `FILE_FLAG_FIRST_PIPE_INSTANCE` makes the loser fail in a way
   that looks exactly like a broken agent.
2. If a control endpoint is already listening, it asks `status` over that pipe
   and records the answer. A second start is the failure the script is arranged
   to avoid.
3. Otherwise it runs the agent's own `jarvis config`, which names the missing
   configuration variables and never prints a value, and stops unless it
   answered `configuration ready`.
4. Otherwise it starts the agent — `Resolve-AgentCommand` — and waits up to 30
   seconds for that agent's control pipe to answer `status`. The wait is the
   point: a script that returned 0 while the service died a second later would
   report a successful boot for a machine with no agent on it.

It never issues `stop`, never deletes anything, and never writes a configuration
value. That is the brief's "does nothing destructive until told to", applied.

`Resolve-AgentCommand` prefers the checkout it is running from —
`uv run --project <repo>/apps/local-agent jarvis serve` — and falls back to an
installed `jarvis` on `PATH` only when that checkout is not there. It returns
`$null` when neither exists, and the script then reports exit 3 rather than
guessing at a command.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | an agent is listening, or a sibling copy holds the mutex — nothing to do |
| 2 | the endpoint answered with something this client cannot parse |
| 3 | no agent is listening and this run was not allowed to start one, or there is nothing on this machine to start it with |
| 4 | the agent's configuration is missing or unusable |
| 5 | the agent was started and its control pipe never answered within 30 s |

Exit 5 is the one worth having: it is the difference between "the boot chain ran"
and "there is an agent at the other end of the pipe". The agent's own stdout and
stderr land beside the log at `boot.log.agent.out` and `boot.log.agent.err`,
because a service that died during startup has nothing else to say.

The log is appended to `%LOCALAPPDATA%\Jarvis\logs\boot.log`, rotated once at
256 KiB, and printed to the console. It holds variable *names*, counts and
timestamps. It never holds a value.

### What the agent needed, and why the chain used to stop at exit 3

`ops/jarvis-boot.ps1` used to refuse to start the agent because nothing on
Windows could. In the tree as of `688fe02`:

- `jarvis node` (`apps/local-agent/jarvis_local/node.py`) was the only launcher
  that bound the control channel, and `NodeSettings.from_config` refused any
  platform whose `sys.platform` did not start with `linux` — the
  `current_platform.startswith("linux")` check.
- `apps/local-agent/jarvis_local/transport/pipe_server.py` was a complete,
  tested Windows named-pipe *server* with no caller.
- `cli.py` spoke the client half only: `status`, `run-once`, `stop`,
  `retry-quarantined`.

That is closed now, and the way it was closed is the part worth keeping:
**one assembly, two platform bindings.** `build_node` already took a
`ControlFactory` and already guarded its POSIX-only device-key checks, so
`jarvis serve` calls it with the Windows binding — `pipe_server.py`'s
`NamedPipeServer` behind the same `ControlServer` the Unix socket path gets.
`NodeSettings.from_config` takes the platform it is assembling for, so the
Windows settings are built and tested on the Linux boxes the suite runs on.

**`jarvis serve` is not a port of the node, and it is not a second launcher.**
It is the same `build_node`, the same `RunLoop`, the same stores and device key;
the difference between it and `jarvis node` is which class owns the channel.
`jarvis node` still refuses anything but Linux and `jarvis serve` refuses
anything but Windows, so neither can quietly be the other.

Two things this needs that the machine did not have, and which are **not**
secrets:

| Name | Value |
|---|---|
| `JARVIS_ARCHIVE_PATH` | an absolute path to the append-only archive |
| `JARVIS_MEMORY_PATH` | an absolute path to the memory store, a different file |

They belong at **user scope**, for the account the logon task runs as, or at
machine scope. A value set at user scope is not visible to a process that was
already running — it is read at the next logon — so a shell that refuses to
start the agent may simply predate the variable. That is recorded in
[FACTS.md](../FACTS.md).

## Running the checks by hand

There is no test suite for the Windows side, so this is the run. It is a script
because the run has to be repeatable, not because it is a suite:

```powershell
pwsh -NoProfile -File C:\javis\ops\test-pc-controls.ps1
pwsh -NoProfile -File C:\javis\ops\test-pc-controls.ps1 -Mutation
pwsh -NoProfile -File C:\javis\ops\test-pc-controls.ps1 -Elevated
```

What each step is worth:

- **The live-endpoint steps** run the boot script against
  `ops/boot_pipe_fixture.py`, which answers using the agent's own `read_frame`,
  `decode_request` and `encode_response`. A drift between the boot script's
  client and the real server fails there.
- **They cannot run while the real agent owns the pipe.** The fixture binds
  `\\.\pipe\jarvis-local-agent` — the same name — and `FILE_FLAG_FIRST_PIPE_INSTANCE`
  means exactly one of them can. **Stop the service first** (`jarvis stop`), or
  point the fixture at another name with `-PipeName`. The step that fails if you
  do not is a fixture that never opens its pipe, which reads as a broken test
  rather than a busy name.
- **The oversized-frame step** is the one guard, and it is mutation-verified.
  `-Mutation` writes a neutered copy through `ops/mutation-oversized-bound.ps1`
  and requires the neutered run to behave differently. Two mutants are checked:
  the declaration bound, and the task's default run level.
- **The `-Elevated` steps** register and immediately unregister a task named
  `Jarvis pc-controls acceptance`. Without elevation they report `SKIP`, not
  `PASS` — a skip that reads as a pass is how an unverified claim gets made.

### The exit test for the launcher

There is no suite for the Windows side, so this is the run, in order, with the
service stopped to begin with:

```powershell
pwsh -NoProfile -File ops/jarvis-boot.ps1 -ProbeOnly   # exit 3: nothing is listening
pwsh -NoProfile -File ops/jarvis-boot.ps1              # exit 0: starts it and waits for the pipe
uv run --project apps/local-agent jarvis status        # the answer, over the pipe
pwsh -NoProfile -File ops/jarvis-boot.ps1 -ProbeOnly   # exit 0: agent already listening
uv run --project apps/local-agent jarvis serve         # exit 4: the name is taken, and it says so
uv run --project apps/local-agent jarvis stop          # the process exits
pwsh -NoProfile -File ops/jarvis-boot.ps1              # restart; exactly one agent is running
```

It needs the three configuration names above to be set. `JARVIS_DEVICE_KEY_PATH`,
`JARVIS_DEVICE_ID`, `JARVIS_PRINCIPAL_ID` and `JARVIS_CLOUD_BASE_URL` are already
set on this machine; `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` are not.

## The two things a by-hand run taught that no code review would have

Both were live defects in the P1 code, found by running it rather than reading it.

1. **`NamedPipeClientStream` takes a bare pipe name.** Passing the full
   `\\.\pipe\jarvis-local-agent` path — which is exactly what
   `pipe_server.DEFAULT_PIPE_NAME` holds — makes .NET treat the name as remote
   and prepend the prefix a second time. The connect then times out against a
   pipe that is listening, which is indistinguishable from an absent agent. The
   boot script normalizes either form.
2. **PowerShell's `-shl` widens its result to the width of a `[byte]` operand.**
   `[byte]10 -shl 16` is `0`, not `655360`, so the four-byte big-endian length
   header of a frame declaring 655,360 bytes read back as **0** and the bound
   never fired. The declared length is assembled through an `int` now. This was
   found by writing the mutation, not by reading the code: the live run had been
   reporting the refusal only because *both* paths ended in a short read, and the
   step that graded it could not tell them apart. The step now names the number of
   bytes read, and the mutation is what proves the two runs differ.
