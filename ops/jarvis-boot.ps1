#Requires -Version 7.3
<#
.SYNOPSIS
    The boot-chain entry point: what the logon scheduled task runs, elevated, with
    nobody at the keyboard.

.DESCRIPTION
    Called by the task `ops/jarvis-logon-task.ps1` registers, at logon, as
    `-RunLevel Highest`. Everything here is idempotent, because a logon task runs
    on every logon, including the ones after a crash.

    What it does, in order, and nothing else:

      1. Takes a single-instance mutex. Two copies would both try to own the
         named pipe, and `FILE_FLAG_FIRST_PIPE_INSTANCE` would make the second one
         fail in a way that looks exactly like a broken agent.
      2. If a control endpoint is already listening, it asks `status` over that
         pipe and records the answer. A second start is the failure this whole
         script is arranged to avoid.
      3. Otherwise it runs the local agent's own `jarvis doctor`, which reports
         which configuration names are missing **without printing any value**.
      4. Otherwise it reports the one thing P1 cannot supply: there is no Windows
         entry point that starts the local agent's service. `jarvis node`
         (`apps/local-agent/jarvis_local/node.py`) is the only thing in the tree
         that binds the control channel, and `NodeSettings.from_config` refuses
         anything but Linux at `node.py`'s `current_platform.startswith("linux")`
         check. `AGENTS.md` forbids porting it as a side effect of another task,
         so this script says so and exits 3 rather than pretending.

    It never issues `stop`, never deletes anything, and never writes a
    configuration value. Those are not omissions; they are the brief's "does
    nothing destructive until told to", applied.

    Nothing secret is written to the log: the doctor's output names variables and
    an agent's `status` lines are counts and timestamps. No environment value, no
    path from a secret name, and no password ever reaches this file.

.PARAMETER PipeName
    The control pipe to probe. Defaults to the agent's own
    `\\.\pipe\jarvis-local-agent` (`pipe_server.py`'s `DEFAULT_PIPE_NAME`).

.PARAMETER ProbeOnly
    Probe the endpoint and report; never attempt to start anything. This is the
    mode the acceptance script drives by hand.

.PARAMETER LogPath
    Where to append. Defaults to `%LOCALAPPDATA%\Jarvis\logs\boot.log`.

.OUTPUTS
    0  an agent is listening, or another instance of this script already holds the
       mutex -- both are "nothing to do"
    2  the control endpoint answered with something this script cannot parse
    3  no Windows entry point exists to start the agent (see above)
    4  the agent's configuration is missing or unusable

.EXAMPLE
    pwsh -File ops/jarvis-boot.ps1 -ProbeOnly
#>
[CmdletBinding()]
param(
    [string]$PipeName = '\\.\pipe\jarvis-local-agent',

    [switch]$ProbeOnly,

    [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Jarvis\logs\boot.log')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExitOk = 0
$ExitProtocol = 2
$ExitNoEntryPoint = 3
$ExitConfiguration = 4

#: The commands the control channel serves (`pipe_server.py`'s CONTROL_COMMANDS).
#: Unused today beyond `status`; kept so the frame this script writes cannot
#: name a command the server would refuse.
$ControlCommands = 'status', 'run-once', 'stop', 'retry-quarantined'

#: `pipe_server.py`'s MAX_REQUEST_BYTES. A response larger than a request is
#: possible, but not by an order of magnitude, and an unbounded read on a pipe a
#: stranger may own is the bug that bound exists to prevent.
$MaxFrameBytes = 64 * 1024
$FrameHeaderBytes = 4

#: The agent's own required names, from `apps/local-agent/.env.example`. Used
#: only to name what is missing; no value is read, printed or compared.
$RequiredConfiguration = 'JARVIS_CLOUD_BASE_URL', 'JARVIS_DEVICE_ID', 'JARVIS_PRINCIPAL_ID', 'JARVIS_DEVICE_KEY_PATH'

$LogLimitBytes = 256 * 1024

$script:LogTarget = $null

function Initialize-Log {
    param([string]$Path)
    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $script:LogTarget = $Path
}

function Write-BootLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $Message
    Write-Output $line
    if (-not $script:LogTarget) { return }
    try {
        # Capped by one rotation rather than a delete: the interesting boot is
        # usually the last one, and truncating would discard it to record its end.
        if ((Test-Path -LiteralPath $script:LogTarget) -and
            (Get-Item -LiteralPath $script:LogTarget).Length -gt $LogLimitBytes) {
            Move-Item -LiteralPath $script:LogTarget -Destination "$($script:LogTarget).1" -Force
        }
        Add-Content -LiteralPath $script:LogTarget -Value $line
    }
    catch {
        # A log that cannot be written must not be the reason Jarvis does not
        # start. The console copy above has already happened.
        Write-Warning "could not write the boot log: $($_.Exception.Message)"
    }
}

function Get-MissingConfiguration {
    $missing = @(
        foreach ($name in $RequiredConfiguration) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ([string]::IsNullOrWhiteSpace($value)) { $name }
        }
    )
    # `Write-Output -NoEnumerate` so an empty result is an empty *array* rather
    # than "no output", which PowerShell collapses to $null. Under
    # `Set-StrictMode -Version Latest` the caller's `.Count` on that $null is a
    # terminating error, and it lands in the path where nothing is missing --
    # the one configuration where the script must succeed.
    Write-Output -NoEnumerate $missing
}

function Get-PipeLeafName {
    <#
        The bare pipe name .NET wants, from either form.

        `\\.\pipe\jarvis-local-agent` and `jarvis-local-agent` are the same pipe,
        and each caller writes the one that is natural to it: the Python server's
        `DEFAULT_PIPE_NAME` is the full path, and `NamedPipeClientStream` silently
        treats a full path as a *remote* name -- `\\.\pipe\x` against server "."
        becomes `\\.\pipe\\.\pipe\x`, which nothing listens on. That failure is a
        three-second connect timeout, indistinguishable from an absent agent.
    #>
    param([string]$Pipe)

    $prefix = '\\.\pipe\'
    if ($Pipe.StartsWith($prefix)) { return $Pipe.Substring($prefix.Length) }
    return $Pipe
}

function New-ControlFrame {
    # `[object]`, not `[hashtable]`: PowerShell unwraps an empty hashtable passed
    # to a hashtable parameter into "no value supplied", and then the request
    # goes out without an `arguments` key at all -- which the server refuses as
    # malformed. An `[object]` binding keeps `@{}` as `@{}`.
    param([string]$Command, [object]$Arguments = @{})

    if ($null -eq $Arguments) { $Arguments = @{} }
    $payload = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @{
        command   = $Command
        arguments = $Arguments
    } -Compress))
    $frame = [byte[]]::new($FrameHeaderBytes + $payload.Length)

    # Written by hand rather than with BitConverter, so the header is obviously
    # four big-endian bytes and not the machine's endianness. `pipe_server.py`'s
    # `encode_frame` uses `to_bytes(4, "big")`.
    $length = $payload.Length
    $frame[0] = [byte](($length -shr 24) -band 0xFF)
    $frame[1] = [byte](($length -shr 16) -band 0xFF)
    $frame[2] = [byte](($length -shr 8) -band 0xFF)
    $frame[3] = [byte]($length -band 0xFF)
    [Array]::Copy($payload, 0, $frame, $FrameHeaderBytes, $payload.Length)
    return $frame
}

function Read-ControlFrame {
    <#
        One length-prefixed frame, refusing an oversized declaration before the
        body is read. The counterpart of `read_frame` in `pipe_server.py`; the
        oversized case is the guard, and it is mutation-verified in
        `ops/test-pc-controls.ps1`.
    #>
    param([System.IO.Stream]$Stream)

    $header = [byte[]]::new($FrameHeaderBytes)
    $read = 0
    #: Counted across both loops. A short read says *where* it stopped: 39 bytes
    #: is the request this client sent and never a byte of the reply, while 43 is
    #: the header plus the 39 -- which is the read the bound below prevents. The
    #: two are the same sentence and the same exit code without this.
    $total = 0
    while ($read -lt $FrameHeaderBytes) {
        $chunk = $Stream.Read($header, $read, $FrameHeaderBytes - $read)
        if ($chunk -eq 0) { throw "the control endpoint closed the pipe mid-frame after $total bytes" }
        $read += $chunk
        $total += $chunk
    }
    # Assembled through an int, not by shifting the bytes. `-shl` on a `[byte]`
    # operand widens its *result* to 8 bits, so `[byte]10 -shl 16` is 0, not
    # 655360 -- a declared length of 655360 reads back as 0 and the bound below
    # never fires. Measured, after the oversized-frame step passed a header the
    # client had silently misread.
    $declared = (($header[0] -as [int]) * 16777216) + (([int]$header[1]) * 65536) + (([int]$header[2]) * 256) + [int]$header[3]
    if ($declared -gt $MaxFrameBytes) {
        throw "the control endpoint declared $declared bytes; this client reads at most $MaxFrameBytes"
    }
    $body = [byte[]]::new($declared)
    $read = 0
    while ($read -lt $declared) {
        $chunk = $Stream.Read($body, $read, $declared - $read)
        if ($chunk -eq 0) { throw "the control endpoint closed the pipe mid-frame after $total bytes" }
        $read += $chunk
        $total += $chunk
    }
    return [Text.Encoding]::UTF8.GetString($body)
}

function Invoke-ControlCommand {
    <#
        Ask the agent one question. Returns $null when no endpoint is listening --
        that is an expected answer, not an error -- and throws when a listener
        answered with something this client cannot parse.
    #>
    param([string]$Pipe, [string]$Command, [object]$Arguments = @{}, [int]$TimeoutMs = 3000)

    if ($Command -notin $ControlCommands) { throw "not a control command: $Command" }

    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', (Get-PipeLeafName -Pipe $Pipe), [System.IO.Pipes.PipeDirection]::InOut)
    try {
        try {
            $client.Connect($TimeoutMs)
        }
        catch [System.TimeoutException] {
            # Nobody is listening. An expected answer on a machine that has not
            # started the agent yet, not a failure.
            return $null
        }
        catch [System.Management.Automation.MethodInvocationException] {
            # PowerShell wraps a .NET exception thrown from a method call. The
            # distinction matters: a timeout is "nothing is listening" and
            # anything else -- access denied against the pipe's restricted DACL,
            # most of all -- must keep going rather than be reported as absence.
            if ($_.Exception.InnerException -isnot [System.TimeoutException]) { throw }
            return $null
        }
        $client.ReadMode = [System.IO.Pipes.PipeTransmissionMode]::Byte

        $frame = New-ControlFrame -Command $Command -Arguments $Arguments
        $client.Write($frame, 0, $frame.Length)
        $client.Flush()

        $text = Read-ControlFrame -Stream $client
        $response = ConvertFrom-Json -InputObject $text
        if ($null -eq $response -or -not ($response.PSObject.Properties.Name -contains 'code')) {
            throw 'the control endpoint answered without a code'
        }
        $lines = @()
        if ($response.PSObject.Properties.Name -contains 'lines' -and $null -ne $response.lines) {
            $lines = @($response.lines)
        }
        return [pscustomobject]@{ code = [string]$response.code; lines = $lines }
    }
    finally {
        $client.Dispose()
    }
}

function Resolve-AgentCommand {
    <#
        The Windows entry point that starts the agent's service, if one exists.

        There is not one. `jarvis node` is the only launcher that binds the
        control channel and `NodeSettings.from_config` refuses every platform
        whose `sys.platform` does not start with "linux"; the Windows half of
        `transport/pipe_server.py` is a server with no caller. Returning $null
        here is the finding, not a placeholder -- `AGENTS.md` forbids porting the
        node, and inventing a second launcher without the store wiring, the
        device key handling and the cycle loop would be a port wearing a
        different name.
    #>
    return $null
}

Initialize-Log -Path $LogPath
Write-BootLog 'boot start'

# A machine-wide name, so a second logon or a manual run cannot race this one.
$mutex = [Threading.Mutex]::new($false, 'Global\JarvisBootChain')
$ownsMutex = $false

try {
    try {
        $ownsMutex = $mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        # The previous holder died. That is a start signal, not a stop signal.
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        Write-BootLog 'already running; nothing to do'
        exit $ExitOk
    }

    try {
        $status = Invoke-ControlCommand -Pipe $PipeName -Command 'status'
        if ($null -ne $status) {
            Write-BootLog "agent already listening on the control pipe; code=$($status.code)"
            foreach ($line in $status.lines) { Write-BootLog "  $line" }
            exit $ExitOk
        }
        Write-BootLog "no agent listening on $PipeName"
    }
    catch {
        Write-BootLog "the control endpoint answered with something unusable: $($_.Exception.Message)"
        exit $ExitProtocol
    }

    $missing = Get-MissingConfiguration
    if ($missing.Count -gt 0) {
        Write-BootLog ('agent configuration missing: ' + ($missing -join ', '))
        Write-BootLog 'set these for the account this runs as; see apps/local-agent/.env.example'
        exit $ExitConfiguration
    }
    Write-BootLog 'environment names present'

    if ($ProbeOnly) {
        Write-BootLog 'probe only; not starting the agent'
        exit $ExitNoEntryPoint
    }

    # The agent's own readiness check. It reports names, never values.
    $doctor = & uv run --project apps/local-agent jarvis doctor 2>&1
    $doctorExit = $LASTEXITCODE
    foreach ($line in $doctor) { Write-BootLog "  doctor: $line" }
    if ($doctorExit -ne 0) {
        Write-BootLog "jarvis doctor exited $doctorExit; not starting the agent"
        exit $ExitConfiguration
    }

    $agentCommand = Resolve-AgentCommand
    if ($null -eq $agentCommand) {
        Write-BootLog 'no Windows entry point starts the local agent; see docs/runbooks/pc-boot-chain.md'
        Write-BootLog 'the boot chain is otherwise complete: logon task -> elevated -> this script'
        exit $ExitNoEntryPoint
    }

    Write-BootLog "starting the agent: $agentCommand"
    exit $ExitOk
}finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
