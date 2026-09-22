#Requires -Version 7.3
<#
.SYNOPSIS
    Runs the P1 boot chain by hand and reports what each step actually did.

.DESCRIPTION
    There is no test suite for the Windows side of P1, so this is not one. It is
    the script that performs the run: every step is a real subprocess, over a real
    named pipe, and the output is the evidence.

    Two kinds of step:

      * **Core** -- the boot script against a live control endpoint, and against
        a lie. `ops/boot_pipe_fixture.py` serves the first: it answers using the
        agent's own `read_frame`/`decode_request`/`encode_response`, so a drift
        between the boot script's client and the real server fails here. The
        second is an endpoint that declares a frame ten times the size the boot
        script will read, which is the one guard worth pinning (see `-Mutation`).
      * **Elevation-gated** -- registering the boot task reads the registry and
        Task Scheduler state in ways a non-elevated session cannot. Run with
        `-Elevated` from an administrator terminal to include them.

    Nothing here writes a registry value, registers a task, or starts an agent.
    The one task it registers is named `Jarvis pc-controls acceptance` and
    removed in the same step.

.PARAMETER Mutation
    Neutered run: the boot script's oversized-frame check is disabled in a copy
    of it, and the maxframe step is expected to FAIL. A guard that survives its
    own removal with a green suite is not pinned. The copy is deleted afterwards.

.PARAMETER Elevated
    Include the steps that need an administrator session.

.EXAMPLE
    pwsh -File ops/test-pc-controls.ps1

.EXAMPLE
    pwsh -File ops/test-pc-controls.ps1 -Mutation
#>
[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PipePrefix = 'jarvis-pc-controls',
    [string]$FixtureTimeoutSeconds = 20,
    [switch]$Mutation,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Failures = 0
$script:Steps = 0
$script:Fixtures = [System.Collections.Generic.List[pscustomobject]]::new()

function Write-Step {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $script:Steps++
    if (-not $Passed) { $script:Failures++ }
    $verdict = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0}  {1}  {2}" -f $verdict, $Name, $Detail)
}

function Write-Skip {
    param([string]$Name, [string]$Why)
    Write-Host ("SKIP  {0}  {1}" -f $Name, $Why)
}

function Invoke-Boot {
    <#
        Runs the boot script as its own process and returns its result.

        `output` is always an array, including when the script printed nothing:
        a `$null` here would make every `-join` and `-match` downstream a
        terminating error under StrictMode, and the run would report a broken
        harness instead of a broken script.
    #>
    param([string]$Script, [string[]]$Arguments)

    $output = & pwsh -NoProfile -NonInteractive -File $Script @Arguments 2>&1
    $exit = $LASTEXITCODE
    return [pscustomobject]@{
        exit   = $exit
        output = @($output | ForEach-Object { [string]$_ })
    }
}

function Start-Fixture {
    <#
        Starts the fixture. Waits for its pipe with `Wait-ForPipe`.

        The pipe name goes through the environment, not the command line. Passed
        as an argument it arrives as `\\.\\pipe\\x`: `Start-Process` builds one
        command line string, `uv.exe` re-splits it, and the separators do not
        survive. An environment variable has no such step.

        `$PipeName` is the bare name; the `\\.\pipe\` prefix is added here,
        because that is what the server takes -- `pipe_server.DEFAULT_PIPE_NAME`
        is `\\.\pipe\jarvis-local-agent` and `_winapi.CreateNamedPipe` is handed
        it unchanged. A bare name to the server is `WinError 123`.

        The fixture's stdout and stderr both land in `-OutFile`, so its exit code
        and its account of what it saw are readable even though the process is
        killed as part of cleanup.
    #>
    param([string]$PipeName, [string]$Mode)

    $env:PYTHONPATH = 'apps/local-agent'
    $env:JARVIS_FIXTURE_PIPE = "\\.\pipe\$PipeName"
    $outFile = Join-Path $env:TEMP "$PipeName.fixture.out"
    $errFile = Join-Path $env:TEMP "$PipeName.fixture.err"
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue

    $arguments = @('run', '--project', 'apps/local-agent', 'python', 'ops/boot_pipe_fixture.py', $Mode)
    $process = Start-Process -FilePath 'uv' -ArgumentList $arguments -WorkingDirectory $RepositoryRoot `
        -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $script:Fixtures.Add([pscustomobject]@{ Process = $process; Out = $outFile; Err = $errFile }) | Out-Null
    return $process
}

function Wait-ForPipe {
    <#
        Waits until something is listening on a pipe name.

        A connect attempt that succeeds consumes the fixture's current instance,
        so the process is waited on before the pipe is polled: `uv run` spends
        most of a fixture's startup before Python even names the pipe. Windows
        offers no read of a pipe's existence that does not open it -- `Test-Path`
        and `File.GetAttributes` both refuse the `\\.\pipe\` namespace -- so a
        probe loop is the only option, and the fixture absorbs the probes as
        connections carrying no request.
    #>
    param([string]$PipeName, [int]$Seconds, [System.Diagnostics.Process]$Process)

    # Returns as soon as the process is gone or the wait elapses; a fixture still
    # starting is expected here, and `WaitForExit(2000)` is only a head start.
    $null = $Process.WaitForExit(2000)

    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "the fixture exited with code $($Process.ExitCode) before opening \\.\pipe\$PipeName"
        }
        # `NamedPipeClientStream` takes the bare name, not the `\\.\pipe\` path
        # the Python server takes. Passing the full path makes .NET treat it as
        # remote and prepend the prefix a second time, which times out on a pipe
        # that is listening.
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $client.Connect(500)
            return $true
        }
        catch [System.TimeoutException] {
            # Busy rather than absent: the name is live.
            return $true
        }
        catch [System.Management.Automation.MethodInvocationException] {
            $inner = $_.Exception.InnerException
            if ($inner -is [System.TimeoutException]) { return $true }
            if ($inner -isnot [System.IO.IOException]) { throw }
            # Not there yet. Try again.
        }
        finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Stop-Fixtures {
    <#
        Ends every fixture and everything it spawned.

        `Kill()` on the `uv` process leaves the `python` grandchild holding the
        pipe name, and a later run then fails `CreateNamedPipe` with
        `WinError 5` -- access denied, because the name is still owned. So this
        takes the process *tree*, then sweeps for any child of ours that outlived
        a previous run by matching on the fixture's own script name.
    #>
    foreach ($fixture in $script:Fixtures) {
        if (-not $fixture.Process.HasExited) {
            & taskkill.exe /T /F /PID $fixture.Process.Id 2>&1 | Out-Null
        }
    }
    $script:Fixtures.Clear()

    $stragglers = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*ops/boot_pipe_fixture.py*' -or $_.CommandLine -like '*ops\boot_pipe_fixture.py*' }
    foreach ($process in $stragglers) {
        & taskkill.exe /T /F /PID $process.ProcessId 2>&1 | Out-Null
    }
}

function Get-FixtureError {
    param([string]$PipeName)
    $err = Join-Path $env:TEMP "$PipeName.fixture.err"
    if (-not (Test-Path -LiteralPath $err)) { return '' }
    # `-Raw` on an empty file is $null, not ''. Every caller wants a string.
    return [string](Get-Content -LiteralPath $err -Raw)
}

try {
    Write-Host ''
    Write-Host "repository: $RepositoryRoot"
    Write-Host "pwsh:       $($PSVersionTable.PSVersion)"
    Write-Host ''

    $boot = Join-Path $RepositoryRoot 'ops/jarvis-boot.ps1'
    $task = Join-Path $RepositoryRoot 'ops/jarvis-logon-task.ps1'
    $autologon = Join-Path $RepositoryRoot 'ops/jarvis-autologon.ps1'

    # --- 1. a live control endpoint, answered by the agent's own framing -----
    $pipe = "$PipePrefix-live"
    $fixture = Start-Fixture -PipeName $pipe -Mode 'status'
    if (-not (Wait-ForPipe -PipeName $pipe -Seconds $FixtureTimeoutSeconds -Process $fixture)) { throw "fixture never opened $pipe" }
    $result = Invoke-Boot -Script $boot -Arguments @('-PipeName', "\\.\pipe\$pipe", '-ProbeOnly', '-LogPath', (Join-Path $env:TEMP "$pipe.log"))
    $joined = $result.output -join "`n"
    Write-Step 'boot connects to a live control endpoint' ($result.exit -eq 0 -and $joined -match 'cycles_recorded 1') "exit=$($result.exit)"
    Write-Step 'boot relays the agent status lines' ($joined -match 'status running') "saw status running: $($joined -match 'status running')"
    # `$fixture` is read before `Stop-Fixtures`, because that clears the list and
    # with it this reference -- reading `.ExitCode` afterwards is a null-valued
    # expression, which the first version of this step did.
    $servedExit = 'still running after 15s'
    if ($fixture.WaitForExit(15000)) { $servedExit = "exit=$($fixture.ExitCode)" }
    # Read now, not at the step below: a later fixture with the same pipe name
    # deletes this file when it starts, and `Get-Content` on a missing file
    # returns $null rather than ''.
    $fixtureError = [string](Get-FixtureError -PipeName $pipe)
    Write-Step 'the fixture served one status request and exited clean' ($servedExit -ne 'still running after 15s' -and $fixtureError -notmatch 'fixture never received') "$servedExit; stderr: [$($fixtureError.Trim())]"

    # --- 2. no endpoint at all -----------------------------------------------
    $absent = "$PipePrefix-absent"
    $result = Invoke-Boot -Script $boot -Arguments @('-PipeName', "\\.\pipe\$absent", '-ProbeOnly', '-LogPath', (Join-Path $env:TEMP "$absent.log"))
    $joined = $result.output -join "`n"
    # Exit 4 when the configuration names are absent, 3 when they are present and
    # only the agent entry point is missing. Both mean "nothing is listening",
    # which is the claim here; which one is reported says which repair applies.
    Write-Step 'boot reports a missing endpoint instead of hanging' ($result.exit -in 3, 4 -and $joined -match 'no agent listening') "exit=$($result.exit)"

    # --- 3. the oversized-frame bound ---------------------------------------
    $oversized = "$PipePrefix-maxframe"
    $fixture = Start-Fixture -PipeName $oversized -Mode 'maxframe'
    if (-not (Wait-ForPipe -PipeName $oversized -Seconds $FixtureTimeoutSeconds -Process $fixture)) { throw "fixture never opened $oversized" }
    $overArgs = @('-PipeName', "\\.\pipe\$oversized", '-ProbeOnly', '-LogPath', (Join-Path $env:TEMP "$oversized.log"))
    $result = Invoke-Boot -Script $boot -Arguments $overArgs
    $joined = $result.output -join "`n"
    # The fixture answers a complete request with a declaration nothing follows,
    # so a client that reads the body blocks until its own connect timeout and
    # never names the size. Reaching the size check at all is the guard working.
    $refusedBeforeReading = $result.exit -eq 2 -and $joined -match 'declared 655360 bytes'
    Write-Step 'the bound refused an oversized frame before reading it' $refusedBeforeReading "exit=$($result.exit)"

    if ($Mutation) {
        # Neutered: the declaration check's condition is replaced with `$false`,
        # and every chunked read announces the total it has read so far, in a
        # copy. The copy is written by `ops/mutation-oversized-bound.ps1` so the
        # mutation cannot be edited away inside the same file it is checking.
        #
        # Exit 2 is what this client returns for *any* short read, so the exit
        # code cannot prove which path ran. What can: `after N bytes`. With the
        # bound live the client refuses on the declaration and reports the size
        # it refused, having read nothing but the four-byte header. Neutered, it
        # asks the pipe for 655,360, gets nothing back, and reports the byte
        # count it had reached -- a count no bound-abiding run can produce.
        $neutered = Join-Path $env:TEMP 'jarvis-boot-neutered.ps1'
        $mutationScript = Join-Path $RepositoryRoot 'ops/mutation-oversized-bound.ps1'
        & pwsh -NoProfile -NonInteractive -File $mutationScript -Source $boot -Destination $neutered | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "the mutation script failed; see ops/mutation-oversized-bound.ps1" }
        try {
            Stop-Fixtures
            $fixture = Start-Fixture -PipeName $oversized -Mode 'maxframe'
            if (-not (Wait-ForPipe -PipeName $oversized -Seconds $FixtureTimeoutSeconds -Process $fixture)) { throw "neutered fixture never opened $oversized" }
            $result = Invoke-Boot -Script $neutered -Arguments $overArgs
            $neuteredOutput = $result.output -join "`n"
            # `\d+` rather than a literal: the request's own size depends on the
            # config names this session happens to have set, and the claim is
            # "it read past the header", not "it read exactly 43".
            $readIntoTheBody = $neuteredOutput -match 'NO-DATA after \d+ bytes'
            Write-Step 'MUTATION: with the bound neutered the client reads the body' $readIntoTheBody "neutered run: $($neuteredOutput.Trim())"
            Write-Step 'MUTATION: with the bound live the client never reads the body' ($joined -match 'declared 655360 bytes' -and $joined -notmatch 'NO-DATA') "live run named the size: $($joined -match 'declared 655360 bytes')"
        }
        finally {
            Remove-Item -LiteralPath $neutered -Force -ErrorAction SilentlyContinue
        }
    }

    # --- 4. boot is a no-op when a sibling copy holds the mutex --------------
    $held = [Threading.Mutex]::new($false, 'Global\JarvisBootChain')
    $held.WaitOne(0) | Out-Null
    try {
        $result = Invoke-Boot -Script $boot -Arguments @('-PipeName', "\\.\pipe\$absent", '-ProbeOnly', '-LogPath', (Join-Path $env:TEMP "$absent-2.log"))
        Write-Step 'a second copy does not race the first' ($result.exit -eq 0 -and ($result.output -join "`n") -match 'already running') "exit=$($result.exit)"
    }
    finally {
        $held.ReleaseMutex()
        $held.Dispose()
    }

    # --- 5. what `ops/jarvis-logon-task.ps1` would register -----------------
    #
    # Driven through the script's own `-WhatIf`, not by rebuilding the settings
    # and principal here: this way a step fails when the script stops asking for
    # `-RunLevel Highest`, which a re-typed copy of the construction would not
    # notice. `New-ScheduledTask*` needs no elevation; `Register-ScheduledTask`
    # does, and that is what `-WhatIf` replaces.
    $taskArgs = @('-UserName', $env:USERNAME, '-WhatIf')
    $result = Invoke-Boot -Script $task -Arguments $taskArgs
    $taskOutput = $result.output -join "`n"
    Write-Step 'the boot task would be registered at the highest run level' ($result.exit -eq 0 -and $taskOutput -match 'run_level\s+Highest') "run_level line: $(($result.output | Where-Object { $_ -match 'run_level' }) -join '')"
    Write-Step 'the boot task would be interactive, not a stored password' ($taskOutput -match 'logon_type\s+Interactive') "logon_type line: $(($result.output | Where-Object { $_ -match 'logon_type' }) -join '')"
    Write-Step 'the boot task would have no execution time limit' ($taskOutput -match 'execution_limit\s+PT0S') "execution_limit line: $(($result.output | Where-Object { $_ -match 'execution_limit' }) -join '')"
    Write-Step 'the boot task would restart a bounded number of times' ($taskOutput -match 'restart_count\s+3' -and $taskOutput -match 'restart_interval\s+PT1M') "restart lines: $(($result.output | Where-Object { $_ -match 'restart_' }) -join ' ')"
    Write-Step 'the boot task would fire on logon for this account' ($taskOutput -match 'trigger\s+MSFT_TaskLogonTrigger') "trigger line: $(($result.output | Where-Object { $_ -match 'trigger' }) -join '')"
    Write-Step 'the boot task would start ops/jarvis-boot.ps1' ($taskOutput -match 'jarvis-boot\.ps1') "action line: $(($result.output | Where-Object { $_ -match 'action_arguments' }) -join '')"

    if ($Mutation) {
        # The structural half of the mutation check. `-WhatIf` prints what the
        # script built, so a run of a script whose default run level is Limited
        # has to stop printing Highest -- and if it does not, the step above is
        # reading something other than the script's own choice.
        $mutatedTask = Join-Path $env:TEMP 'jarvis-logon-task-mutated.ps1'
        $taskMutation = Join-Path $RepositoryRoot 'ops/mutation-task-runlevel.ps1'
        & pwsh -NoProfile -NonInteractive -File $taskMutation -Source $task -Destination $mutatedTask | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'the task mutation script failed; see ops/mutation-task-runlevel.ps1' }
        try {
            $result = Invoke-Boot -Script $mutatedTask -Arguments $taskArgs
            $mutatedOutput = $result.output -join "`n"
            Write-Step 'MUTATION: with RunLevel Limited the same step would fail' ($mutatedOutput -notmatch 'run_level\s+Highest') "mutated run_level line: $(($result.output | Where-Object { $_ -match 'run_level' }) -join '')"
        }
        finally {
            Remove-Item -LiteralPath $mutatedTask -Force -ErrorAction SilentlyContinue
        }
    }

    # --- 6. elevation-gated steps -------------------------------------------
    Write-Host ''
    $result = Invoke-Boot -Script $autologon -Arguments @('-Status')
    Write-Step 'autologon status reads back unelevated' ($result.exit -eq 0 -and ($result.output -join "`n") -match 'auto_admin_logon') "exit=$($result.exit)"

    $result = Invoke-Boot -Script $task -Arguments @('-UserName', $env:USERNAME, '-Confirm:$false')
    Write-Step 'registering the task without elevation is refused loudly' ($result.exit -ne 0 -and ($result.output -join "`n") -match 'requires an elevated session') "exit=$($result.exit)"

    if ($Elevated) {
        $name = 'Jarvis pc-controls acceptance'
        try {
            & pwsh -NoProfile -NonInteractive -File $task -TaskName $name -UserName $env:USERNAME -RunLevel Highest -Confirm:$false | Out-Host
            $registered = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            Write-Step 'the registered task carries RunLevel Highest' ($registered.Principal.RunLevel -eq 'Highest') "RunLevel=$($registered.Principal.RunLevel)"
            Write-Step 'the registered task has no execution time limit' ($registered.Settings.ExecutionTimeLimit -eq 'PT0S') "ExecutionTimeLimit=$($registered.Settings.ExecutionTimeLimit)"
            Write-Step 'the registered task starts the boot script' ($registered.Actions[0].Arguments -match 'jarvis-boot\.ps1') "arguments: $($registered.Actions[0].Arguments)"
        }
        finally {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    else {
        Write-Skip 'the registered task carries RunLevel Highest' 'needs an elevated session; re-run with -Elevated'
        Write-Skip 'the registered task has no execution time limit' 'needs an elevated session; re-run with -Elevated'
        Write-Skip 'the registered task starts the boot script' 'needs an elevated session; re-run with -Elevated'
        Write-Skip 'autologon install writes the four values' 'needs an elevated session; re-run with -Elevated'
    }
}
catch {
    # The harness failing is not a step failing, and the two look the same
    # otherwise: a one-line StrictMode error with no line number. Report which
    # statement it was.
    Write-Host ''
    Write-Host "HARNESS ERROR: $($_.Exception.Message)"
    Write-Host "  at $($_.InvocationInfo.PositionMessage)"
    $script:Failures++
    $script:Steps++
}
finally {
    Stop-Fixtures
}

Write-Host ''
Write-Host "$($script:Steps - $script:Failures)/$($script:Steps) steps passed"
exit $(if ($script:Failures -gt 0) { 1 } else { 0 })
