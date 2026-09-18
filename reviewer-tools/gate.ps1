#Requires -Version 7.0
<#
    gate.ps1 - run the whole local gate against one commit, in one gate copy.

    Usage:
        pwsh -NoProfile -File gate.ps1 -Sha <sha> [-GateDir C:\Users\Sid\jarvis-pr39]
                                            [-IsolationRuns 3] [-HeartbeatSeconds 60]

    Windows PowerShell, not bash: invoking the pnpm/npx shims from Git Bash on
    this machine dies with "'C:\Program' is not recognized" before anything
    starts.

    Why this exists. `pnpm test:all` is `pnpm test && pnpm test:runtime &&
    pnpm test:watchdog`, so the first failing package stops the other two from
    ever running. Four hermes-runtime security tests (sbom-integrity-round2 x2,
    sbom-security-review3, source-lock) sat red on main for six days behind
    exactly that chain. This script runs every package even when an earlier one
    fails, then re-runs each failing test FILE alone -IsolationRuns times,
    because the suite is load-sensitive and a failure under load is not the
    same claim as a failure.

    ONE isolated run is not evidence, and the first version of this script
    learned that the expensive way. It re-ran each failing file once and called
    a recurrence REAL; on its first complete run it reported three REAL
    failures, and a reviewer re-running all three found all three were flakes
    (two passed 44/44 alone, the third passed twice and failed once in three
    isolated runs). The single re-run happened in the SAME loaded session as
    the full run, so a load flake failed again under load and was promoted -
    the control did not control for the variable it exists to control for.
    Classification is therefore on the RATE over -IsolationRuns runs, and every
    classified entry prints that rate.

    Exit code 0 means: lint clean, typecheck clean, no failure reproduced in
    EVERY one of the isolation runs, and nothing left unverified. Load flakes,
    INTERMITTENT results and the known pre-existing failures below do not fail
    the gate; only a failure that reproduced in every isolation run does. The
    classification table in step 5 and the note at the verdict say why.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string] $Sha,
    [string] $GateDir = 'C:\Users\Sid\jarvis-pr39',
    # How many times each failing FILE is re-run alone. One run cannot tell a
    # load flake from a real failure at this suite's measured rate (roughly 2
    # failures in 11 runs for one known file), so the default is 3 and the
    # count is a parameter rather than a constant.
    [ValidateRange(1, 20)][int] $IsolationRuns = 3,
    # Seconds between "still running" lines while a command runs. 0 turns the
    # heartbeat off. Silence and a hang look identical, and a package here has
    # measured 824s and 1080s.
    [ValidateRange(0, 3600)][int] $HeartbeatSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native commands report through $LASTEXITCODE here; a non-zero exit is data we
# record, not an exception that should unwind the run.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Failures that were already red on main when this tool was written, so the
# gate does not hide a NEW failure behind them. Matched on file AND test name:
# matching the file alone would excuse any future failure in that file.
# This list must SHRINK as the defects are fixed and never grow silently -
# adding an entry is a review decision, not a convenience.
$KnownPreExistingFailures = @(
    # Every one of these is a hermes-runtime security test that was already red
    # on main when this tool was written (seen again at b478d6d, 2026-09-18).
    [pscustomobject]@{ File = 'sbom-integrity-round2.test.mjs'; Test = 'rejects a fabricated release-shaped source root through the real generator before reading lock inputs' }
    [pscustomobject]@{ File = 'sbom-integrity-round2.test.mjs'; Test = 'closes PowerShell module discovery inside the real locked-source verifier child' }
    [pscustomobject]@{ File = 'sbom-security-review3.test.mjs';  Test = 'does not execute or trust a zero-exit pwsh shadow from inherited PATH' }
    [pscustomobject]@{ File = 'source-lock.test.mjs';            Test = 'rejects hostile tar members and zip members before runtime extraction' }
)

function Write-Usage {
    Write-Output @'
Usage: pwsh -NoProfile -File gate.ps1 -Sha <sha> [-GateDir C:\Users\Sid\jarvis-pr39]
                                        [-IsolationRuns 3] [-HeartbeatSeconds 60]

  -Sha               commit under test; the gate copy is fetched and detached to it
  -GateDir           git worktree with node_modules installed (default C:\Users\Sid\jarvis-pr39)
  -IsolationRuns     times each failing file is re-run alone (default 3; the rate is the verdict)
  -HeartbeatSeconds  seconds between "still running" lines, 0 to disable (default 60)
'@
}

# Seconds below two minutes, minutes above it. A progress line is read at a
# glance to tell "working" from "hung", and neither "0.0 min" nor "1080s" does
# that.
function Format-Elapsed {
    param([Parameter(Mandatory)][timespan] $Elapsed)
    if ($Elapsed.TotalSeconds -lt 120) { return ('{0:n0}s' -f $Elapsed.TotalSeconds) }
    return ('{0:n1} min' -f $Elapsed.TotalMinutes)
}

# A long command in this thread prints nothing until it ends, and 13-18 minutes
# of silence is indistinguishable from a hang - one review session killed a
# working run for exactly that reason. With a heartbeat requested the command
# runs in a second runspace inside this process and this thread keeps the
# clock. Without one it runs here, which is cheaper and is what the short
# commands want.
function Invoke-Capture {
    param(
        [Parameter(Mandatory)][string]   $Exe,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string]   $WorkingDirectory,
        [string] $Label,
        [int]    $HeartbeatSeconds = 0
    )
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $Label -or $HeartbeatSeconds -le 0) {
        Push-Location -LiteralPath $WorkingDirectory
        try {
            $text = (& $Exe @Arguments 2>&1 | Out-String)
            $exit = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        return [pscustomobject]@{ Output = $text; ExitCode = $exit; Elapsed = $watch.Elapsed }
    }

    # The result comes back through a ConcurrentQueue rather than a return
    # value: the runspace is on another thread, and a lost result would read as
    # "the run produced nothing", which is the one outcome this script must
    # never invent.
    $box = [System.Collections.Concurrent.ConcurrentQueue[object]]::new()
    $shell = [powershell]::Create()
    [void]$shell.AddScript({
        param($Exe, $Arguments, $WorkingDirectory, $Box)
        $ErrorActionPreference = 'Continue'
        if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
            $PSNativeCommandUseErrorActionPreference = $false
        }
        Set-Location -LiteralPath $WorkingDirectory
        try {
            $text = (& $Exe @Arguments 2>&1 | Out-String)
            $Box.Enqueue([pscustomobject]@{ Output = $text; ExitCode = $LASTEXITCODE })
        }
        catch {
            $Box.Enqueue([pscustomobject]@{ Output = "capture failed: $($_.Exception.Message)"; ExitCode = -1 })
        }
    }).AddArgument($Exe).AddArgument($Arguments).AddArgument($WorkingDirectory).AddArgument($box)
    try {
        $handle = $shell.BeginInvoke()
        $next = [double]$HeartbeatSeconds
        while (-not $handle.AsyncWaitHandle.WaitOne(500)) {
            $elapsed = $watch.Elapsed.TotalSeconds
            if ($elapsed -ge $next) {
                Write-Host ('  ... {0}: still running, {1} elapsed' -f $Label, (Format-Elapsed $watch.Elapsed))
                $next += $HeartbeatSeconds
            }
        }
        $shell.EndInvoke($handle)
    }
    catch {
        Write-Host "  ! ${Label}: the capture runspace failed: $($_.Exception.Message)"
    }
    finally {
        $shell.Dispose()
    }
    $captured = $null
    if (-not $box.TryDequeue([ref]$captured)) {
        $captured = [pscustomobject]@{ Output = 'the capture runspace returned no result'; ExitCode = -1 }
    }
    return [pscustomobject]@{ Output = $captured.Output; ExitCode = $captured.ExitCode; Elapsed = $watch.Elapsed }
}

function Get-SummaryLine {
    param([Parameter(Mandatory)][string] $Output, [Parameter(Mandatory)][string] $Label)
    $found = $null
    foreach ($line in ($Output -split "`r?`n")) {
        if ($line -match ('^\s*' + [regex]::Escape($Label) + '\s+(.+?)\s*$')) { $found = $Matches[1] }
    }
    return $found
}

function Get-Counts {
    param([string] $Line)
    $counts = [ordered]@{ Passed = 0; Failed = 0; Skipped = 0; Total = $null }
    if ($Line) {
        if ($Line -match '(\d+)\s+passed')  { $counts.Passed  = [int]$Matches[1] }
        if ($Line -match '(\d+)\s+failed')  { $counts.Failed  = [int]$Matches[1] }
        if ($Line -match '(\d+)\s+skipped') { $counts.Skipped = [int]$Matches[1] }
        if ($Line -match '\((\d+)\)\s*$')   { $counts.Total   = [int]$Matches[1] }
    }
    if ($null -eq $counts.Total) { $counts.Total = $counts.Passed + $counts.Failed + $counts.Skipped }
    return [pscustomobject]$counts
}

# Vitest's default reporter prints one line per failed test, the file path and
# the full test name joined by " > ". That is the only place the names appear,
# so the verdict names tests rather than counting them.
function Get-VitestFailures {
    param(
        [Parameter(Mandatory)][string] $Output,
        [string] $PathPrefix = ''
    )
    # Vitest prints failing tests in two shapes and both are read here:
    #     <mark> |default| packages/contracts/test/x.test.ts (10 tests | 2 failed) 10ms
    #         <x> the name of the failing test 5ms
    #     FAIL  |default| packages/contracts/test/x.test.ts > describe > test name
    # where <mark> is U+276F and <x> is U+00D7. The `|project|` token is only
    # present under the workspace config, so it is optional. The tree is what
    # this repository's vitest version actually prints for a failing file; the
    # project's own summary count is the cross-check for a shape neither parser
    # knows, because an unparsed failure must never look like a clean run.
    $treeFile = '^\s*[\u276F\u2713\u00D7\u2193]\uFE0F?\s+(?:[^\s]+\s+)*(?<file>[^\s(]+\.(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs))\b'
    $treeFail = '^\s*[\u00D7\u2717]\uFE0F?\s+(?<name>.+?)\s*(?:[0-9]+(?:\.[0-9]+)?(?:ms|s))?\s*$'
    $classic  = '^\s*FAIL\s+(?:[^\s]+\s+)*(?<file>\S+\.(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs))(?:\s*>\s*(?<name>.*))?$'
    $found = [ordered]@{}
    $currentFile = $null
    foreach ($raw in ($Output -split "`r?`n")) {
        $line = $raw.TrimEnd()
        $match = [regex]::Match($line, $classic)
        if ($match.Success) {
            $name = $match.Groups['name'].Value.Trim()
            if (-not $name) { $name = '(file-level failure)' }
            Add-VitestFailure -Found $found -File (Get-RepoRelativePath -Path $match.Groups['file'].Value -Prefix $PathPrefix) -Name $name
            continue
        }
        $match = [regex]::Match($line, $treeFile)
        if ($match.Success) {
            # Package-local runs print paths relative to the package directory.
            $currentFile = Get-RepoRelativePath -Path $match.Groups['file'].Value -Prefix $PathPrefix
            continue
        }
        $match = [regex]::Match($line, $treeFail)
        if ($match.Success -and $currentFile) {
            $name = $match.Groups['name'].Value.Trim()
            if ($name) { Add-VitestFailure -Found $found -File $currentFile -Name $name }
        }
    }
    # The comma keeps an empty result from unrolling to $null on the way out.
    return ,@($found.Values)
}

# Vitest names the same test two ways: bare in the tree, suite-qualified after
# "FAIL <file> > ". The last " > " segment is the test's own name and the only
# part that matches across both shapes. Comparing whole strings instead would
# read one test reported in two shapes as two different tests, and the second
# one - "the file is red but not with this name" - is classified as a failure
# that reproduced.
function Get-BareTestName {
    param([Parameter(Mandatory)][string] $Name)
    $separator = $Name.LastIndexOf(' > ')
    if ($separator -ge 0) { return $Name.Substring($separator + 3) }
    return $Name
}

# The same failing test appears twice - bare in the tree, suite-qualified in the
# FAIL line - and counting it twice would inflate every list in the verdict. The
# longest name seen for a test wins, because that is the one a reviewer can find
# in the file.
function Add-VitestFailure {
    param(
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary] $Found,
        [Parameter(Mandatory)][string] $File,
        [Parameter(Mandatory)][string] $Name
    )
    $bare = Get-BareTestName -Name $Name
    $key = $File + '::' + $bare
    if (-not $Found.Contains($key) -or $Name.Length -gt $Found[$key].Name.Length) {
        $Found[$key] = [pscustomobject]@{ File = $File; Name = $Name }
    }
}

function Get-RepoRelativePath {
    param([Parameter(Mandatory)][string] $Path, [string] $Prefix = '')
    $slashed = $Path -replace '\\', '/'
    if ($slashed -like 'apps/*' -or $slashed -like 'packages/*' -or $slashed -like 'tests/*') { return $slashed }
    return ($Prefix + $slashed)
}

function Get-SummaryFailedCount {
    param([Parameter(Mandatory)][string] $Output)
    $line = Get-SummaryLine -Output $Output -Label 'Tests'
    if (-not $line) { return -1 }
    if ($line -match '(\d+)\s+failed') { return [int]$Matches[1] }
    return 0
}

# Re-running a file alone has to use the runner that can host it. The literal
# `npx vitest --config vitest.workspace.ts run <file>` the review loop names
# works for the gateway, contracts and acceptance tests, but hermes-runtime and
# watchdog are Node/own-config packages: the workspace config's projects do not
# include them, so that command reports "No test files found" and every runtime
# failure would be misread as REAL. Same intent, correct runner.
function Get-FileRunner {
    param(
        [Parameter(Mandatory)][string] $RelativePath,
        [Parameter(Mandatory)][string] $Root
    )
    $slashed = $RelativePath -replace '\\', '/'
    if ($slashed -like 'apps/hermes-runtime/*') {
        return [pscustomobject]@{
            WorkingDirectory = (Join-Path $Root 'apps/hermes-runtime')
            Path             = $slashed.Substring('apps/hermes-runtime/'.Length)
            Arguments        = @('vitest', 'run')
        }
    }
    if ($slashed -like 'apps/watchdog/*') {
        return [pscustomobject]@{
            WorkingDirectory = (Join-Path $Root 'apps/watchdog')
            Path             = $slashed.Substring('apps/watchdog/'.Length)
            Arguments        = @('vitest', '--config', 'vitest.config.ts', 'run')
        }
    }
    return [pscustomobject]@{
        WorkingDirectory = $Root
        Path             = $slashed
        Arguments        = @('vitest', '--config', 'vitest.workspace.ts', 'run')
    }
}

function Test-KnownFailure {
    param([Parameter(Mandatory)][string] $File, [Parameter(Mandatory)][string] $Name)
    foreach ($known in $KnownPreExistingFailures) {
        if (($File -like ('*' + $known.File)) -and ($Name -like ('*' + $known.Test + '*'))) { return $true }
    }
    return $false
}

function Stop-Loudly {
    param([Parameter(Mandatory)][string] $Message)
    Write-Output ''
    Write-Output "GATE ABORTED: $Message"
    exit 2
}

if (-not $Sha) {
    Write-Usage
    exit 2
}

if (-not (Test-Path -LiteralPath $GateDir -PathType Container)) {
    Stop-Loudly "gate directory '$GateDir' does not exist."
}

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)?.Source
$npx  = (Get-Command npx.cmd  -ErrorAction SilentlyContinue)?.Source
if (-not $pnpm -or -not $npx) { Stop-Loudly 'pnpm.cmd and npx.cmd must both be on PATH.' }

$started = Get-Date
Write-Host "gate: $GateDir  sha $Sha"
Write-Host "gate: isolation $IsolationRuns run(s) per failing file, heartbeat ${HeartbeatSeconds}s"

# ---------------------------------------------------------------------------
# 1. Fetch, detach, and prove HEAD is the commit that was asked for. A gate
# result for the wrong commit is worse than no result: it names the right
# behaviour and reports the wrong code.
# ---------------------------------------------------------------------------
$dirty = (& git -C $GateDir status --porcelain 2>&1) -join "`n"
if ($dirty.Trim()) {
    Stop-Loudly "gate directory has uncommitted changes; refusing to detach over them:`n$dirty"
}

$fetch = Invoke-Capture -Exe 'git' -Arguments @('fetch', 'origin', '-q') -WorkingDirectory $GateDir
if ($fetch.ExitCode -ne 0) { Stop-Loudly "git fetch origin failed:`n$($fetch.Output)" }

$checkout = Invoke-Capture -Exe 'git' -Arguments @('checkout', '--detach', $Sha, '-q') -WorkingDirectory $GateDir
if ($checkout.ExitCode -ne 0) { Stop-Loudly "git checkout --detach $Sha failed:`n$($checkout.Output)" }

$head = ((& git -C $GateDir rev-parse HEAD) -join '').Trim()
$wanted = ((& git -C $GateDir rev-parse --verify --quiet ($Sha + '^{commit}')) -join '').Trim()
if (-not $wanted) { Stop-Loudly "'$Sha' does not resolve to a commit in '$GateDir'." }
if ($head -ne $wanted) {
    Stop-Loudly "HEAD is $head but $Sha resolves to $wanted; refusing to run the gate on the wrong commit."
}
$short = $head.Substring(0, 12)
Write-Host "gate: detached at $short (verified)"

# ---------------------------------------------------------------------------
# 2. Install exactly what the lockfile pins. Anything else is a different
# dependency graph than the one being reviewed.
# ---------------------------------------------------------------------------
$install = Invoke-Capture -Exe $pnpm -Arguments @('install', '--frozen-lockfile') -WorkingDirectory $GateDir -Label 'pnpm install' -HeartbeatSeconds $HeartbeatSeconds
if ($install.ExitCode -ne 0) {
    Write-Output $install.Output
    Stop-Loudly 'pnpm install --frozen-lockfile failed; nothing else can be trusted after that.'
}
Write-Host ('install: ok in {0}' -f (Format-Elapsed $install.Elapsed))

# ---------------------------------------------------------------------------
# 3. Lint and typecheck, recorded separately: they fail for different reasons
# and a review entry has to say which one went red.
# ---------------------------------------------------------------------------
$lint = Invoke-Capture -Exe $pnpm -Arguments @('lint') -WorkingDirectory $GateDir -Label 'pnpm lint' -HeartbeatSeconds $HeartbeatSeconds
$typecheck = Invoke-Capture -Exe $pnpm -Arguments @('typecheck') -WorkingDirectory $GateDir -Label 'pnpm typecheck' -HeartbeatSeconds $HeartbeatSeconds
Write-Host ('lint: exit {0} in {1}   typecheck: exit {2} in {3}' -f $lint.ExitCode, (Format-Elapsed $lint.Elapsed), $typecheck.ExitCode, (Format-Elapsed $typecheck.Elapsed))

# ---------------------------------------------------------------------------
# 4. Every package, separately and unconditionally. No && chain: an earlier
# failure must not stop the later packages from reporting.
# ---------------------------------------------------------------------------
$packageRuns = @(
    [pscustomobject]@{ Label = 'cloud-gateway (pnpm test)';            Script = 'test';         PathPrefix = '' }
    [pscustomobject]@{ Label = 'hermes-runtime (pnpm test:runtime)';   Script = 'test:runtime'; PathPrefix = 'apps/hermes-runtime/' }
    [pscustomobject]@{ Label = 'watchdog (pnpm test:watchdog)';        Script = 'test:watchdog'; PathPrefix = 'apps/watchdog/' }
)

$results = New-Object System.Collections.Generic.List[object]
foreach ($package in $packageRuns) {
    Write-Host "run: $($package.Label) started $((Get-Date).ToString('HH:mm:ss'))"
    $run = Invoke-Capture -Exe $pnpm -Arguments @($package.Script) -WorkingDirectory $GateDir -Label $package.Label -HeartbeatSeconds $HeartbeatSeconds
    Write-Host ('run: {0}: exit {1} in {2}' -f $package.Label, $run.ExitCode, (Format-Elapsed $run.Elapsed))
    $parsed = Get-VitestFailures -Output $run.Output -PathPrefix $package.PathPrefix
    $summaryFailed = Get-SummaryFailedCount -Output $run.Output
    $results.Add([pscustomobject]@{
        Label         = $package.Label
        ExitCode      = $run.ExitCode
        FileLine      = Get-SummaryLine -Output $run.Output -Label 'Test Files'
        TestLine      = Get-SummaryLine -Output $run.Output -Label 'Tests'
        Failures      = $parsed
        SummaryFailed = $summaryFailed
        Tail          = (($run.Output -split "`r?`n") | Select-Object -Last 25) -join "`n"
    })
}

# ---------------------------------------------------------------------------
# 5. Flake classification, on a RATE. Each failing file is re-run alone
# -IsolationRuns times, and each test that failed in the full run is classified
# by how many of those runs it failed in:
#
#     failed N/N    REAL          reproduced in every isolated run
#     failed 0/N    load flake    reproduced in no isolated run
#     0 < k < N     INTERMITTENT  neither claim is established; the rate is
#                                 the evidence and is printed
#
# A single isolated run is not a control: it runs in the same loaded session as
# the full run, so a load flake fails again for the same reason it failed the
# first time. Counting runs is the whole fix; a binary here is what produced
# the wrong verdict this rewrite exists to correct.
# ---------------------------------------------------------------------------
$real = New-Object System.Collections.Generic.List[object]
$intermittent = New-Object System.Collections.Generic.List[object]
$flakes = New-Object System.Collections.Generic.List[object]
$known = New-Object System.Collections.Generic.List[object]
$unverified = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[string]

foreach ($result in $results) {
    if ($result.ExitCode -ne 0 -and -not $result.TestLine) {
        $errors.Add("$($result.Label) exited $($result.ExitCode) without a vitest summary line; treat this run as incomplete.")
    }
    elseif ($result.SummaryFailed -gt @($result.Failures).Count) {
        # A failure that cannot be named cannot be classified as real or flake,
        # and silently counting it as a flake is how a red suite looks green.
        $errors.Add("$($result.Label) reported $($result.SummaryFailed) failing test(s) but only $(@($result.Failures).Count) named line(s) were parsed; failures are unnamed and are not classified below.")
    }
    foreach ($group in ($result.Failures | Group-Object File)) {
        $runner = Get-FileRunner -RelativePath $group.Name -Root $GateDir
        Write-Host "flake check: $($group.Name) alone x$IsolationRuns"
        $aloneRuns = New-Object System.Collections.Generic.List[object]
        for ($attempt = 1; $attempt -le $IsolationRuns; $attempt++) {
            $rerun = Invoke-Capture -Exe $npx -Arguments ($runner.Arguments + @($runner.Path)) -WorkingDirectory $runner.WorkingDirectory `
                                    -Label "$($group.Name) alone (run $attempt/$IsolationRuns)" -HeartbeatSeconds $HeartbeatSeconds
            # No @() here: Get-VitestFailures already returns one array object,
            # and wrapping it again makes a single-element array whose only
            # element is the real list - which reads as "1 failure" on a clean
            # run and makes the name match below throw.
            $aloneFailures = Get-VitestFailures -Output $rerun.Output
            $noFiles = [bool]($rerun.Output -match 'No test files found')
            $aloneRuns.Add([pscustomobject]@{ Failures = $aloneFailures; ExitCode = $rerun.ExitCode; NoFiles = $noFiles })
            $note = if ($noFiles) { 'no test files found' } else { "exit $($rerun.ExitCode), $(@($aloneFailures).Count) named failure(s)" }
            Write-Host ('  run {0}/{1}: {2} in {3}' -f $attempt, $IsolationRuns, $note, (Format-Elapsed $rerun.Elapsed))
        }
        # A run that did not host the file says nothing about the failure, in
        # either direction, so every test in it is left unverified rather than
        # counted as a pass.
        $hosted = @($aloneRuns | Where-Object { -not $_.NoFiles })
        if ($hosted.Count -lt $IsolationRuns) {
            foreach ($failure in $group.Group) {
                $entry = [pscustomobject]@{ Package = $result.Label; File = $failure.File; Test = $failure.Name }
                if (Test-KnownFailure -File $failure.File -Name $failure.Name) { $known.Add($entry); continue }
                $entry | Add-Member -NotePropertyName Detail -NotePropertyValue `
                    "$($IsolationRuns - $hosted.Count)/$IsolationRuns alone run(s) found no test files for this path"
                $unverified.Add($entry)
            }
            continue
        }
        # A run that exited non-zero over an empty failure list is not a clean
        # run either: something went wrong that named no test, and reading that
        # as "passed alone" is how a broken run becomes a load flake.
        $unclean = @($aloneRuns | Where-Object { @($_.Failures).Count -gt 0 -or $_.ExitCode -ne 0 })
        foreach ($failure in $group.Group) {
            $entry = [pscustomobject]@{ Package = $result.Label; File = $failure.File; Test = $failure.Name }
            if (Test-KnownFailure -File $failure.File -Name $failure.Name) { $known.Add($entry); continue }
            $bare = Get-BareTestName -Name $failure.Name
            $recurrences = @($aloneRuns | Where-Object {
                @($_.Failures | Where-Object { (Get-BareTestName -Name $_.Name) -eq $bare }).Count -gt 0
            }).Count
            $entry | Add-Member -NotePropertyName FailedRuns -NotePropertyValue $recurrences
            $entry | Add-Member -NotePropertyName RunCount -NotePropertyValue $IsolationRuns
            if ($recurrences -eq $IsolationRuns) {
                $real.Add($entry)
            }
            elseif ($recurrences -gt 0) {
                $intermittent.Add($entry)
            }
            elseif ($unclean.Count -gt 0) {
                # This test never reproduced, but the file was not clean in
                # those runs. Calling it a load flake would assert a clean
                # isolated run that did not happen.
                $entry | Add-Member -NotePropertyName Detail -NotePropertyValue `
                    "$($unclean.Count)/$IsolationRuns alone run(s) were red without naming this test"
                $intermittent.Add($entry)
            }
            else {
                $flakes.Add($entry)
            }
        }
        Write-Host ('flake check: {0}: {1}/{2} alone run(s) failed' -f $group.Name, $unclean.Count, $IsolationRuns)
    }
}

# ---------------------------------------------------------------------------
# 6. One compact block, easy to paste into a review entry.
# ---------------------------------------------------------------------------
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('===== REVIEWER GATE =====')
$lines.Add("sha            $short ($head)")
$lines.Add("gate dir       $GateDir")
$lines.Add("isolation      $IsolationRuns run(s) per failing file")
$lines.Add("lint           $(if ($lint.ExitCode -eq 0) { 'PASS' } else { "FAIL (exit $($lint.ExitCode))" })")
$lines.Add("typecheck      $(if ($typecheck.ExitCode -eq 0) { 'PASS' } else { "FAIL (exit $($typecheck.ExitCode))" })")
foreach ($result in $results) {
    $files = Get-Counts -Line $result.FileLine
    $tests = Get-Counts -Line $result.TestLine
    $verdict = if ($result.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    $lines.Add(('{0,-30} {1,-5} {2} files / {3} tests ({4} failed, {5} skipped)' -f `
        $result.Label, $verdict, $files.Total, $tests.Total, $tests.Failed, $tests.Skipped))
}
# Every classified line carries the rate. A name alone is what let one failed
# isolated run read as a real failure for a whole review round.
$lines.Add("-- REAL failures (failed in all $IsolationRuns isolation runs) --")
if ($real.Count -eq 0) { $lines.Add('  (none)') }
foreach ($entry in $real) { $lines.Add("  $($entry.File) > $($entry.Test)  [failed $($entry.FailedRuns)/$($entry.RunCount) alone]") }
$lines.Add('-- INTERMITTENT (failed some isolation runs and passed others: NOT a real failure and NOT a load flake) --')
if ($intermittent.Count -eq 0) { $lines.Add('  (none)') }
foreach ($entry in $intermittent) {
    $detail = if ($entry.PSObject.Properties['Detail']) { "  $($entry.Detail)" } else { '' }
    $lines.Add("  $($entry.File) > $($entry.Test)  [failed $($entry.FailedRuns)/$($entry.RunCount) alone]$detail")
}
$lines.Add("-- load flakes (passed in all $IsolationRuns isolation runs) --")
if ($flakes.Count -eq 0) { $lines.Add('  (none)') }
foreach ($entry in $flakes) { $lines.Add("  $($entry.File) > $($entry.Test)  [failed 0/$($entry.RunCount) alone]") }
$lines.Add('-- known pre-existing (allowed to fail, must shrink) --')
if ($known.Count -eq 0) { $lines.Add('  (none seen in this run)') }
foreach ($entry in $known) { $lines.Add("  $($entry.File) > $($entry.Test)") }
if ($unverified.Count -gt 0) {
    $lines.Add('-- UNVERIFIED (the alone run did not host this file) --')
    foreach ($entry in $unverified) { $lines.Add("  $($entry.File) > $($entry.Test)  [$($entry.Detail)]") }
}
foreach ($error in $errors) { $lines.Add("-- ERROR: $error") }
$lines.Add(('time           {0:n1} min' -f ((Get-Date) - $started).TotalMinutes))

$failed = ($lint.ExitCode -ne 0) -or ($typecheck.ExitCode -ne 0) -or
          ($real.Count -gt 0) -or ($unverified.Count -gt 0) -or ($errors.Count -gt 0) -or
          (@($results | Where-Object { $_.ExitCode -ne 0 -and -not $_.TestLine }).Count -gt 0)
# The verdict is three-valued on purpose. A mixed isolation rate cannot be
# reported as PASS - that claims a clean commit the runs did not show - and it
# must not be reported as FAIL either, which is the defect this rewrite fixes:
# one failure in N isolated runs promoted to a real failure sends a builder
# after code that is not broken. INCONCLUSIVE is the honest third answer, and
# the exit code stays 0 because it answers exactly one question - did anything
# fail EVERY isolation run - and nothing did. An intermittent test can still be
# a real defect; that is why it is named, rated and separated rather than
# counted as a flake.
$verdict = if ($failed) { 'FAIL' } elseif ($intermittent.Count -gt 0) { 'INCONCLUSIVE' } else { 'PASS' }
$exitCode = if ($failed) { 1 } else { 0 }
$exitWhy = if ($failed) {
    "FAIL: $($real.Count) REAL failure(s), or lint/typecheck, or an unverified or incomplete run"
} elseif ($intermittent.Count -gt 0) {
    "INCONCLUSIVE: no failure reproduced in all $IsolationRuns runs; $($intermittent.Count) result(s) need more runs before they are called either (re-run with -IsolationRuns 10 to separate them)"
} else {
    "PASS: nothing failed every isolation run"
}
$lines.Add("verdict        $verdict")
$lines.Add("exit code      $exitCode ($exitWhy)")
$lines.Add('=========================')

Write-Output ''
Write-Output ($lines -join "`n")

if ($failed) {
    Write-Output ''
    Write-Output '--- output tails (last 25 lines per package) ---'
    foreach ($result in $results) {
        Write-Output ''
        Write-Output "### $($result.Label)  exit $($result.ExitCode)"
        Write-Output $result.Tail
    }
    if ($lint.ExitCode -ne 0) { Write-Output ''; Write-Output '### pnpm lint'; Write-Output $lint.Output }
    if ($typecheck.ExitCode -ne 0) { Write-Output ''; Write-Output '### pnpm typecheck'; Write-Output $typecheck.Output }
}

exit $exitCode
