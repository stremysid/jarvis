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
      3. Otherwise it runs the agent's own `jarvis doctor`, which names the
         configuration variables that are missing **without printing any value**,
         and refuses to start unless it answered `ready`.
      4. Otherwise it starts the agent's service -- `Resolve-AgentCommand` -- and
         waits for its control endpoint to answer. That wait is what makes this
         script's exit code mean something: the task is only as good as an agent
         that is actually on the other end of the pipe.

    It never issues `stop`, never deletes anything, and never writes a
    configuration value. Those are not omissions; they are the brief's "does
    nothing destructive until told to", applied.

    Nothing secret is written to the log: the doctor's output names variables and
    an agent's `status` lines are counts and timestamps. No environment value, no
    path from a secret name, and no password ever reaches this file. The agent's
    own stdout and stderr go to a sibling of this script's log, because a service
    that dies during startup has nothing else to say.

.PARAMETER PipeName
    The control pipe to probe. Defaults to the agent's own
    `\\.\pipe\jarvis-local-agent` (`pipe_server.py`'s `DEFAULT_PIPE_NAME`).

.PARAMETER ProbeOnly
    Probe the endpoint and report; never attempt to start anything. This is the
    mode the acceptance script drives by hand.

.PARAMETER LogPath
    Where to append. Defaults to `%LOCALAPPDATA%\Jarvis\logs\boot.log`.

.PARAMETER StartTimeoutSeconds
    How long to wait for a started agent's control endpoint to answer.

.OUTPUTS
    0  an agent is listening, or another instance of this script already holds the
       mutex -- both are "nothing to do"
    2  the control endpoint answered with something this script cannot parse
    3  no agent is listening and this run was not allowed to start one
    4  the agent's configuration is missing or unusable
    5  the agent was started and its control endpoint never answered

.EXAMPLE
    pwsh -File ops/jarvis-boot.ps1 -ProbeOnly
#>
[CmdletBinding()]
param(
    [string]$PipeName = '\\.\pipe\jarvis-local-agent',

    [switch]$ProbeOnly,

    [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Jarvis\logs\boot.log'),

    [int]$StartTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExitOk = 0
$ExitProtocol = 2
$ExitNoAgent = 3
$ExitConfiguration = 4
$ExitStartup = 5

#: The commands the control channel serves (`pipe_server.py`'s CONTROL_COMMANDS).
#: Unused today beyond `status`; kept so the frame this script writes cannot
#: name a command the server would refuse.
$ControlCommands = 'status', 'run-once', 'stop', 'retry-quarantined'

#: `pipe_server.py`'s MAX_REQUEST_BYTES. A response larger than a request is
#: possible, but not by an order of magnitude, and an unbounded read on a pipe a
#: stranger may own is the bug that bound exists to prevent.
$MaxFrameBytes = 64 * 1024
$FrameHeaderBytes = 4

$LogLimitBytes = 256 * 1024
$ControlPollMilliseconds = 250

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
        catch [System.IO.IOException] {
            # `ERROR_FILE_NOT_FOUND`: no pipe with that name exists at all.
            # The same answer as a timeout, by a shorter route -- and it is the
            # common one, because a probe for a named pipe fails at once rather
            # than waiting for the timeout to elapse. Neither is a refusal by an
            # agent that is listening, which is what the callers distinguish.
            return $null
        }
        catch [System.Management.Automation.MethodInvocationException] {
            # PowerShell wraps a .NET exception thrown from a method call. The
            # distinction matters: a timeout is "nothing is listening" and
            # anything else -- access denied against the pipe's restricted DACL,
            # most of all -- must keep going rather than be reported as absence.
            $inner = $_.Exception.InnerException
            if ($inner -is [System.TimeoutException] -or $inner -is [System.IO.IOException]) { return $null }
            throw
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
        The command that starts the agent's service on this host.

        The agent's own entry point, not a second launcher: `jarvis serve`
        (`cli.py`) assembles the same node `jarvis node` does and binds the same
        control channel through `build_node`'s control factory -- the Windows
        half being `transport/pipe_server.py`, which until now had no caller.
        Anything this script invented here would be a launcher beside the one
        the agent already tests.

        Returns $null only when there is nothing on this machine to run, which
        the caller reports rather than guessing at.
    #>
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $projectDirectory = Join-Path $repoRoot 'apps/local-agent'
    $entryPoint = Join-Path $projectDirectory 'jarvis_local/cli.py'

    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        # An installed `jarvis` is the other honest answer. `Get-Command` is
        # preferred over `uv`, because a launcher that reaches the PATH is the
        # command a person would type when checking by hand.
        $installed = Get-Command jarvis -ErrorAction SilentlyContinue
        if ($null -ne $installed) {
            return @{
                FilePath        = $installed.Source
                Arguments       = @('serve')
                ConfigArguments = @('config')
                Display         = "jarvis serve ($($installed.Source))"
            }
        }
        return $null
    }

    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -eq $uv) { return $null }

    # Through `uv`, as `AGENTS.md` requires for every local-agent command, and
    # with `--project` pointing at this checkout, so the agent that starts is
    # the one in this repository rather than whatever is installed beside it.
    $prefix = @('run', '--project', $projectDirectory, 'jarvis')
    return @{
        FilePath        = $uv.Source
        Arguments       = $prefix + @('serve')
        ConfigArguments = $prefix + @('config')
        Display         = "uv run --project $projectDirectory jarvis serve"
    }
}

function Start-Agent {
    param([hashtable]$Command, [string]$OutputPath)
    # Stdout and stderr go to files rather than being inherited: a service whose
    # startup failed has nothing else to say, and a redirected child that also
    # writes to the console is how a redirect can block. Deliberately not
    # `-NonInteractive`: this process is meant to outlive the script, and a
    # batch-mode `uv` is a process that does not expect to be asked anything.
    return Start-Process -FilePath $Command.FilePath -ArgumentList $Command.Arguments `
        -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$OutputPath.out" -RedirectStandardError "$OutputPath.err"
}

function Test-ProcessRunning {
    # `.HasExited` on a process that was never started, or whose handle was
    # closed, is a terminating error under StrictMode; the check is cheaper than
    # the exception.
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process) { return $false }
    try { $Process.Refresh() } catch { return $false }
    return -not $Process.HasExited
}

function Wait-ForControlEndpoint {
    <#
        Wait until the endpoint answers, or until the process that was supposed
        to open it is gone.

        `status` is the probe because it is the only question that proves an
        agent is on the other end: a connect that succeeds proves an instance
        exists, and `ServeOne` answers a request it could not parse with a
        refusal, so a listener that is not ours still looks like one from here.
    #>
    param([System.Diagnostics.Process]$Process, [string]$Pipe, [int]$Seconds)

    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $status = Invoke-ControlCommand -Pipe $Pipe -Command 'status' -TimeoutMs 1000
            if ($null -ne $status) { return $status }
        }
        catch {
            # Whatever it said, the agent is not answering with a status. Keep
            # waiting until the deadline or the process's exit decides it.
        }
        if (-not (Test-ProcessRunning -Process $Process)) { return $null }
        Start-Sleep -Milliseconds $ControlPollMilliseconds
    }
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

    # The agent's own configuration check, run through `Resolve-AgentCommand`'s
    # interpreter so this reads the same project the start below will. It names
    # the missing variables and never prints a value. Run before `-ProbeOnly` as
    # well: which repair applies is worth knowing even when this run is not
    # allowed to make it, and it keeps exit 4 meaning one thing.
    $readiness = Resolve-AgentCommand
    if ($null -eq $readiness) {
        Write-BootLog 'no way to run the local agent on this machine; see docs/runbooks/pc-boot-chain.md'
        exit $ExitNoAgent
    }

    $config = & $readiness.FilePath @($readiness.ConfigArguments) 2>&1
    $configExit = $LASTEXITCODE
    foreach ($line in $config) { Write-BootLog "  config: $line" }
    if ($configExit -ne 0) {
        Write-BootLog "the agent configuration is not usable (exit $configExit); not starting the agent"
        exit $ExitConfiguration
    }

    if ($ProbeOnly) {
        Write-BootLog 'probe only; not starting the agent'
        exit $ExitNoAgent
    }

    Write-BootLog "starting the agent: $($readiness.Display)"
    $agentOutput = "$LogPath.agent"
    $agent = Start-Agent -Command $readiness -OutputPath $agentOutput

    $started = Wait-ForControlEndpoint -Process $agent -Pipe $PipeName -Seconds $StartTimeoutSeconds
    if ($null -eq $started) {
        if (Test-ProcessRunning -Process $agent) {
            Write-BootLog "the agent did not answer on $PipeName within $StartTimeoutSeconds seconds"
        }
        else {
            # Read after the exit, so the code is the real one rather than
            # whatever a still-running process would report.
            $agentExit = $agent.ExitCode
            Write-BootLog "the agent exited with $agentExit before answering on $PipeName"
        }
        Write-BootLog "agent stdout and stderr: $agentOutput.out, $agentOutput.err"
        exit $ExitStartup
    }

    Write-BootLog "agent listening on the control pipe; pid=$($agent.Id) code=$($started.code)"
    foreach ($line in $started.lines) { Write-BootLog "  $line" }
    exit $ExitOk
}finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
