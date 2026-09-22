# The PC boot chain

> **P1 of three.** This runbook installs what happens between pressing the power
> button and an elevated Jarvis process being alive. It does **not** install the
> agent: see *What is missing* below, which is the reason the chain currently
> ends at exit 3.
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
| 3 | The entry point that task runs | `ops/jarvis-boot.ps1` |

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
3. Otherwise it runs the agent's own `jarvis doctor`, which names missing
   configuration variables and never prints a value.
4. Otherwise it reports what P1 cannot supply: there is no Windows entry point
   that starts the local agent. See below.

It never issues `stop`, never deletes anything, and never writes a configuration
value. That is the brief's "does nothing destructive until told to", applied.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | an agent is listening, or a sibling copy holds the mutex — nothing to do |
| 2 | the endpoint answered with something this client cannot parse |
| 3 | no Windows entry point exists to start the agent |
| 4 | the agent's configuration is missing or unusable |

The log is appended to `%LOCALAPPDATA%\Jarvis\logs\boot.log`, rotated once at
256 KiB, and printed to the console. It holds variable *names*, counts and
timestamps. It never holds a value.

### What is missing, and why the chain stops at exit 3

`ops/jarvis-boot.ps1` refuses to start the agent because nothing on Windows can.
In the tree as of `688fe02`:

- `jarvis node` (`apps/local-agent/jarvis_local/node.py`) is the only launcher
  that binds the control channel, and `NodeSettings.from_config` refuses any
  platform whose `sys.platform` does not start with `linux` — the
  `current_platform.startswith("linux")` check.
- `apps/local-agent/jarvis_local/transport/pipe_server.py` is a complete,
  tested Windows named-pipe *server* with no caller. `cli.py` speaks the client
  half only: `status`, `run-once`, `stop`, `retry-quarantined`.
- `AGENTS.md` forbids porting the node as a side effect of another task, and that
  is the correct reading: a second launcher without the store wiring, the device
  key handling and the cycle loop would be a port wearing a different name.

So the boot chain is complete and verified from the power button to an elevated
`pwsh` running the boot script. What it cannot do yet is put an agent on the other
end of the pipe. That is a row in [QUEUE.md](../QUEUE.md).

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
- **The oversized-frame step** is the one guard, and it is mutation-verified.
  `-Mutation` writes a neutered copy through `ops/mutation-oversized-bound.ps1`
  and requires the neutered run to behave differently. Two mutants are checked:
  the declaration bound, and the task's default run level.
- **The `-Elevated` steps** register and immediately unregister a task named
  `Jarvis pc-controls acceptance`. Without elevation they report `SKIP`, not
  `PASS` — a skip that reads as a pass is how an unverified claim gets made.

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
