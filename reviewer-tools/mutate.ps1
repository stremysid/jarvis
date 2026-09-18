#Requires -Version 7.0
<#
    mutate.ps1 - plant faults from a JSON spec and report which tests notice.

    Usage:
        pwsh -NoProfile -File mutate.ps1 -Spec <spec.json> [-GateDir C:\Users\Sid\jarvis-pr40]

    Windows PowerShell, not bash: the pnpm/npx shims cannot be invoked from Git
    Bash on this machine ("'C:\Program' is not recognized").

    Spec: a JSON array of
        { "name", "file", "find", "replace", "testPath", "expect" }
      or, when a fault only exists once several places agree,
        { "name", "edits": [ { "file", "find", "replace" }, ... ], "testPath", "expect" }
      file      path relative to the gate directory
      find      literal string, NOT a regex; must occur exactly once
      replace   literal string; may be empty to delete
      testPath  test file or directory to run, relative to the gate directory
      expect    substring of the test name that SHOULD die; may not be empty

    Why `edits`. Some guards are only reachable once a fixture is changed as
    well as the source: the PR 98 audit's F1 needs one edit in a test fixture
    and one in `src`, because the fixture currently makes a different clause
    fire first. A guard no single edit can reach is still a guard a sweep must
    be able to plant. Either every edit of a mutation lands or none of them do,
    and they are restored together.

    Why this exists. A mutation whose `find` silently matched nothing runs no
    mutation, the suite stays green, and it is reported SURVIVED - a false
    finding that is worse than no result, and one the reviewer produced twice by
    hand. So `find` must match exactly once, the file must really have changed,
    and the new text must really be present, all before any test runs.

    A mutation is restored from a byte-exact backup in a `finally` block, so an
    exception or Ctrl-C cannot leave a mutated tree behind.

    Verdicts per mutation:
      KILLED              a test that was not failing at baseline failed, and it
                          is the expected one
      KILLED/OTHER        some new test failed, but not the expected one - its
                          own verdict, not a pass
      SURVIVED            no test that passed at baseline failed
      NOT APPLIED         `find` did not match exactly once; nothing was run
      INVALID             the runner failed without naming a failing test, so a
                          kill cannot be claimed (skips and timeouts are not
                          kills)
      UNCONFIRMED         the expected test died once, then passed on an
                          immediate re-run with the mutation still applied

    Why UNCONFIRMED exists. This suite is load-sensitive: two gateway test files
    are nondeterministic, and on 2026-09-18 the same seven files reported five
    failures and then 162/162 green minutes later. A mutation that lands and is
    then "killed" by a flake is a FALSE KILLED -- and a false kill is the one
    error this tool could not otherwise catch, because it looks exactly like the
    result everybody wanted. So a kill is re-run once, with the mutation still
    in place, before it is believed.

    Exit codes, which are deliberately three different things:
      0   every mutation applied, every kill confirmed on the expected test
      1   the sweep worked and FOUND something -- SURVIVED, KILLED/OTHER or
          UNCONFIRMED. A fact about the tests, to act on.
      2   the sweep produced no usable result -- NOT APPLIED, INVALID, an
          unrestored file, or an aborted start. A fact about the spec or this
          tool, and nothing about the tests may be concluded from it.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string] $Spec,
    [string] $GateDir = 'C:\Users\Sid\jarvis-pr40',
    [switch] $SkipKillConfirmation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Usage {
    Write-Output @'
Usage: pwsh -NoProfile -File mutate.ps1 -Spec <spec.json> [-GateDir C:\Users\Sid\jarvis-pr40]

  -Spec     JSON array of { name, file, find, replace, testPath, expect }
            or { name, edits: [ { file, find, replace } ], testPath, expect }
  -GateDir  git worktree to mutate, already detached at the commit under test
  -SkipKillConfirmation
            do not re-run a kill to confirm it -- faster, and unsafe on a busy
            machine, because this suite is load-sensitive
'@
}

function Invoke-Capture {
    param(
        [Parameter(Mandatory)][string]   $Exe,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string]   $WorkingDirectory
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $text = (& $Exe @Arguments 2>&1 | Out-String)
        $exit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    return [pscustomobject]@{ Output = $text; ExitCode = $exit }
}

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
    # present under the workspace config, so it is optional.
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
    $bare = $Name
    $separator = $bare.LastIndexOf(' > ')
    if ($separator -ge 0) { $bare = $bare.Substring($separator + 3) }
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

function Get-SummaryLine {
    param([Parameter(Mandatory)][string] $Output, [Parameter(Mandatory)][string] $Label)
    $found = $null
    foreach ($line in ($Output -split "`r?`n")) {
        if ($line -match ('^\s*' + [regex]::Escape($Label) + '\s+(.+?)\s*$')) { $found = $Matches[1] }
    }
    return $found
}

# The summary count is the backstop: a failure line this parser does not know
# still shows up here, and a kill may never be claimed from a failure that was
# never named.
function Get-SummaryFailedCount {
    param([Parameter(Mandatory)][string] $Output)
    $line = Get-SummaryLine -Output $Output -Label 'Tests'
    if (-not $line) { return -1 }
    if ($line -match '(\d+)\s+failed') { return [int]$Matches[1] }
    return 0
}

# Same reason as gate.ps1: the workspace config hosts the gateway, contracts and
# acceptance tests, but hermes-runtime and watchdog are Node packages with their
# own config, and the workspace config reports "No test files found" for them.
function Get-TestRunner {
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
            Prefix           = 'apps/hermes-runtime/'
        }
    }
    if ($slashed -like 'apps/watchdog/*') {
        return [pscustomobject]@{
            WorkingDirectory = (Join-Path $Root 'apps/watchdog')
            Path             = $slashed.Substring('apps/watchdog/'.Length)
            Arguments        = @('vitest', '--config', 'vitest.config.ts', 'run')
            Prefix           = 'apps/watchdog/'
        }
    }
    return [pscustomobject]@{
        WorkingDirectory = $Root
        Path             = $slashed
        Arguments        = @('vitest', '--config', 'vitest.workspace.ts', 'run')
        Prefix           = ''
    }
}

function Get-LiteralCount {
    param([Parameter(Mandatory)][string] $Haystack, [Parameter(Mandatory)][string] $Needle)
    if ($Needle.Length -eq 0) { return 0 }
    $count = 0
    $index = 0
    while ($true) {
        $index = $Haystack.IndexOf($Needle, $index, [System.StringComparison]::Ordinal)
        if ($index -lt 0) { break }
        $count++
        $index += $Needle.Length
    }
    return $count
}

function Get-ByteHash {
    param([Parameter(Mandatory)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# A mutation is one or more edits applied together. Single-edit specs keep the
# original shape; `edits` is the general case.
function Get-MutationEdits {
    param([Parameter(Mandatory)] $Mutation)
    if ($Mutation.PSObject.Properties['edits']) { return @($Mutation.edits) }
    return @([pscustomobject]@{ file = $Mutation.file; find = $Mutation.find; replace = $Mutation.replace })
}

# One edit, applied and PROVEN applied before anything is run. The proof is the
# whole point of this tool: a `find` that matched nothing leaves a green suite
# that reads as SURVIVED, and a false finding is worse than no finding.
function Invoke-Edit {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Find,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Replace
    )
    if ($Find.Length -eq 0) { return [pscustomobject]@{ Applied = $false; Note = "'find' is empty" } }

    $note = ''
    $beforeHash = Get-ByteHash -Path $Path
    $originalBytes = [IO.File]::ReadAllBytes($Path)
    $hasUtf8Bom  = ($originalBytes.Length -ge 3 -and $originalBytes[0] -eq 0xEF -and $originalBytes[1] -eq 0xBB -and $originalBytes[2] -eq 0xBF)
    $hasUtf16Bom = ($originalBytes.Length -ge 2 -and $originalBytes[0] -eq 0xFF -and $originalBytes[1] -eq 0xFE)
    $encoding = if ($hasUtf16Bom) { [System.Text.UnicodeEncoding]::new($false, $true) }
                elseif ($hasUtf8Bom) { [System.Text.UTF8Encoding]::new($true) }
                else { [System.Text.UTF8Encoding]::new($false) }

    $text = [IO.File]::ReadAllText($Path)
    $find = $Find
    $replace = $Replace
    $count = Get-LiteralCount -Haystack $text -Needle $find
    if ($count -eq 0) {
        # A spec written with \n against a CRLF file matched nothing and was
        # reported SURVIVED by hand. Retry on LF-normalized text, and say so.
        $lfText = $text.Replace("`r`n", "`n")
        $lfFind = $find.Replace("`r`n", "`n")
        if ((Get-LiteralCount -Haystack $lfText -Needle $lfFind) -eq 1) {
            $text = $lfText; $find = $lfFind; $replace = $replace.Replace("`r`n", "`n"); $count = 1
            $note = 'matched after LF normalization'
        }
    }
    if ($count -eq 0) { return [pscustomobject]@{ Applied = $false; Note = 'find does not occur in the file' } }
    if ($count -gt 1) { return [pscustomobject]@{ Applied = $false; Note = "find occurs $count times; refusing to guess which one was meant" } }

    [IO.File]::WriteAllText($Path, $text.Replace($find, $replace), $encoding)

    $afterText = [IO.File]::ReadAllText($Path)
    $changed = (Get-ByteHash -Path $Path) -ne $beforeHash
    $present = ($replace.Length -eq 0) -or $afterText.Contains($replace)
    if (-not $changed -or -not $present) {
        return [pscustomobject]@{ Applied = $false; Note = "file bytes changed: $changed; replacement present: $present" }
    }
    return [pscustomobject]@{ Applied = $true; Note = $note }
}

# One test run reduced to the facts a verdict needs. Extracted so the
# confirmation re-run is the SAME measurement rather than a second one written
# twice and drifting.
function Measure-MutationRun {
    param(
        [Parameter(Mandatory)] $Runner,
        [Parameter(Mandatory)][string] $Npx,
        [Parameter(Mandatory)] $Baseline,
        [Parameter(Mandatory)][string] $Expect
    )
    $run = Invoke-Capture -Exe $Npx -Arguments ($Runner.Arguments + @($Runner.Path)) -WorkingDirectory $Runner.WorkingDirectory
    $failures = Get-VitestFailures -Output $run.Output -PathPrefix $Runner.Prefix
    $summaryFailed = Get-SummaryFailedCount -Output $run.Output
    $newFailures = @($failures | Where-Object { $Baseline.Names -notcontains $_.Name })
    $newNames = @($newFailures | Select-Object -ExpandProperty Name)
    # The summary count minus the baseline minus every named new failure is the
    # number of failures this parser could not name. A kill may not be claimed
    # from those, and they may not be rounded away into a clean pass.
    $unnamed = $summaryFailed - $Baseline.Failed - $newFailures.Count
    return [pscustomobject]@{
        AllFailures   = $failures
        NewNames      = $newNames
        Unnamed       = $unnamed
        SummaryFailed = $summaryFailed
        ExitCode      = $run.ExitCode
        ExpectedHit   = (@($newNames | Where-Object { $_ -like ('*' + $Expect + '*') }).Count -gt 0)
    }
}

function Stop-Loudly {
    param([Parameter(Mandatory)][string] $Message)
    Write-Output ''
    Write-Output "MUTATE ABORTED: $Message"
    exit 2
}

if (-not $Spec) {
    Write-Usage
    exit 2
}
if (-not (Test-Path -LiteralPath $Spec -PathType Leaf)) { Stop-Loudly "spec '$Spec' not found." }
if (-not (Test-Path -LiteralPath $GateDir -PathType Container)) { Stop-Loudly "gate directory '$GateDir' does not exist." }

$Spec = (Resolve-Path -LiteralPath $Spec).Path
$GateDir = (Resolve-Path -LiteralPath $GateDir).Path

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npx) { Stop-Loudly 'npx.cmd must be on PATH.' }

$dirty = ((& git -C $GateDir status --porcelain 2>&1) -join "`n").Trim()
if ($dirty) {
    Stop-Loudly "gate directory has uncommitted changes; a mutation result on top of them would not be about the commit under test:`n$dirty"
}
$sha = ((& git -C $GateDir rev-parse HEAD) -join '').Trim()

$mutations = @(Get-Content -LiteralPath $Spec -Raw | ConvertFrom-Json)
if ($mutations.Count -eq 0) { Stop-Loudly 'spec is empty; nothing to mutate.' }
foreach ($mutation in $mutations) {
    foreach ($field in @('name', 'testPath', 'expect')) {
        if (-not $mutation.PSObject.Properties[$field]) { Stop-Loudly "mutation '$($mutation.name)' is missing '$field'." }
    }
    # '*' + '' + '*' matches every failing test, so an empty `expect` would
    # report KILLED with "expected died" for any mutation at all -- the same
    # false confidence this tool exists to prevent, arriving by another door.
    if ([string]::IsNullOrWhiteSpace([string]$mutation.expect)) {
        Stop-Loudly "mutation '$($mutation.name)': 'expect' is empty, which would match any failing test and report a false KILLED."
    }
    if (-not $mutation.PSObject.Properties['edits']) {
        foreach ($field in @('file', 'find', 'replace')) {
            if (-not $mutation.PSObject.Properties[$field]) { Stop-Loudly "mutation '$($mutation.name)' is missing '$field' and has no 'edits' array." }
        }
    }
    $edits = Get-MutationEdits -Mutation $mutation
    if ($edits.Count -eq 0) { Stop-Loudly "mutation '$($mutation.name)': 'edits' is empty." }
    foreach ($edit in $edits) {
        foreach ($field in @('file', 'find', 'replace')) {
            if (-not $edit.PSObject.Properties[$field]) { Stop-Loudly "mutation '$($mutation.name)': an edit is missing '$field'." }
        }
        $path = Join-Path $GateDir $edit.file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Loudly "mutation '$($mutation.name)': file '$($edit.file)' does not exist in $GateDir." }
    }
}

$backupRoot = Join-Path $env:TEMP ("reviewer-mutate-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

Write-Output "mutate: $GateDir at $($sha.Substring(0, 12)), $($mutations.Count) mutation(s)"

# Baseline: a test that was already failing before the mutation is not a kill.
# One baseline run per distinct testPath, so the claim "this test died because of
# this change" is bounded by what was actually green first.
$baselines = @{}
foreach ($testPath in ($mutations | Select-Object -ExpandProperty testPath | Select-Object -Unique)) {
    $runner = Get-TestRunner -RelativePath $testPath -Root $GateDir
    Write-Host "baseline: $testPath"
    $run = Invoke-Capture -Exe $npx -Arguments ($runner.Arguments + @($runner.Path)) -WorkingDirectory $runner.WorkingDirectory
    $failures = Get-VitestFailures -Output $run.Output -PathPrefix $runner.Prefix
    $baselines[$testPath] = [pscustomobject]@{
        Names  = @($failures | Select-Object -ExpandProperty Name)
        Failed = (Get-SummaryFailedCount -Output $run.Output)
    }
    if ($failures.Count -eq 0) {
        Write-Output "baseline $testPath : green (exit $($run.ExitCode))"
    }
    else {
        Write-Output "baseline $testPath : ALREADY RED - $($failures.Count) failing test(s), which cannot count as kills:"
        foreach ($failure in $failures) { Write-Output "    $($failure.Name)" }
    }
}

$outcomes = New-Object System.Collections.Generic.List[object]
$touched = New-Object System.Collections.Generic.List[object]

foreach ($mutation in $mutations) {
    $edits = Get-MutationEdits -Mutation $mutation
    $outcome = [pscustomobject]@{
        Name = $mutation.name
        File = (($edits | ForEach-Object { $_.file }) -join ', ')
        Verdict = ''
        Expected = $mutation.expect
        ExpectedDied = $false
        Killed = @()
        Note = ''
    }
    $applied = New-Object System.Collections.Generic.List[object]

    try {
        # Either every edit lands or none does. A half-applied mutation is a
        # fault nobody specified, and its verdict would be about nothing.
        $blocked = $null
        foreach ($edit in $edits) {
            $path = Join-Path $GateDir $edit.file
            $backup = Join-Path $backupRoot ((Split-Path -Leaf $edit.file) + '.' + $outcomes.Count + '.' + $applied.Count + '.bak')
            Copy-Item -LiteralPath $path -Destination $backup -Force
            $entry = [pscustomobject]@{ Path = $path; Backup = $backup; Name = $mutation.name }
            $applied.Add($entry)
            $touched.Add($entry)

            $result = Invoke-Edit -Path $path -Find $edit.find -Replace $edit.replace
            if ($result.Note) { $outcome.Note = $result.Note }
            if (-not $result.Applied) { $blocked = "$($edit.file): $($result.Note)"; break }
        }
        if ($blocked) {
            $outcome.Verdict = 'NOT APPLIED'
            $outcome.Note = $blocked
            $outcomes.Add($outcome)
            Write-Output "NOT APPLIED  $($mutation.name) - $($outcome.Note)"
            continue
        }

        $runner = Get-TestRunner -RelativePath $mutation.testPath -Root $GateDir
        $baseline = $baselines[$mutation.testPath]
        $first = Measure-MutationRun -Runner $runner -Npx $npx -Baseline $baseline -Expect $mutation.expect
        $outcome.Killed = $first.NewNames

        if ($first.ExpectedHit) {
            # A kill is the result everyone wants, which is exactly why it is
            # measured twice. A flake landing on the expected name reads as a
            # clean kill, and nothing downstream would ever question it.
            if ($SkipKillConfirmation) {
                $outcome.Verdict = 'KILLED'
                $outcome.ExpectedDied = $true
                $outcome.Note = 'not re-run; -SkipKillConfirmation was set'
            }
            else {
                Write-Host "confirming kill: $($mutation.name)"
                $again = Measure-MutationRun -Runner $runner -Npx $npx -Baseline $baseline -Expect $mutation.expect
                if ($again.ExpectedHit) {
                    $outcome.Verdict = 'KILLED'
                    $outcome.ExpectedDied = $true
                    $outcome.Note = 'confirmed on a second run'
                }
                else {
                    $outcome.Verdict = 'UNCONFIRMED'
                    $outcome.Note = 'died once, then passed on an immediate re-run with the mutation still applied; this suite is load-sensitive, so one red run is not a kill'
                }
            }
            if ($first.Unnamed -gt 0 -and $outcome.Verdict -eq 'KILLED') {
                $outcome.Note = $outcome.Note + "; $($first.Unnamed) other failing test(s) had no parsed name"
            }
        }
        elseif ($first.Unnamed -gt 0) {
            $outcome.Verdict = 'INVALID'
            $outcome.Note = "$($first.Unnamed) failing test(s) in this run had no parsed name, so no kill can be attributed to '$($mutation.expect)'"
        }
        elseif ($first.NewNames.Count -gt 0) {
            $outcome.Verdict = 'KILLED/OTHER'
            $outcome.Note = "expected '$($mutation.expect)' did not die"
        }
        elseif ($first.ExitCode -ne 0 -and $first.SummaryFailed -lt 0) {
            $outcome.Verdict = 'INVALID'
            $outcome.Note = "runner exited $($first.ExitCode) with no vitest summary line; the run was incomplete"
        }
        else {
            $outcome.Verdict = 'SURVIVED'
            if ($first.AllFailures.Count -gt 0) { $outcome.Note = "only baseline-red test(s) failed ($($first.AllFailures.Count))" }
        }
        $outcomes.Add($outcome)
        Write-Output "$($outcome.Verdict)  $($mutation.name)$(if ($outcome.Note) { " - $($outcome.Note)" })"
    }
    finally {
        foreach ($entry in $applied) { Copy-Item -LiteralPath $entry.Backup -Destination $entry.Path -Force }
    }
}

# ---------------------------------------------------------------------------
# Restore proof. Byte-identical, not "looks fine": a leftover mutation would
# silently change every later result in this tree.
# ---------------------------------------------------------------------------
$restored = $true
foreach ($entry in $touched) {
    if ((Get-ByteHash -Path $entry.Path) -ne (Get-ByteHash -Path $entry.Backup)) {
        $restored = $false
        Write-Output "RESTORE FAILED  $($entry.Path) differs from its backup"
    }
}

$longest = @($outcomes | Measure-Object -Property Name -Maximum)[0].Maximum
$width = if ($longest) { $longest.Length } else { 12 }
if ($width -lt 12) { $width = 12 }
Write-Output ''
Write-Output '===== MUTATION SUMMARY ====='
Write-Output ("{0,-$width}  {1,-13}  {2}" -f 'mutation', 'verdict', 'expected')
foreach ($outcome in $outcomes) {
    $expected = if ($outcome.Verdict -like 'KILLED*') { $(if ($outcome.ExpectedDied) { 'died' } else { 'NO' }) } else { '-' }
    Write-Output ("{0,-$width}  {1,-13}  {2}" -f $outcome.Name, $outcome.Verdict, $expected)
    foreach ($name in $outcome.Killed) { Write-Output ("    killed: $name") }
    if ($outcome.Note) { Write-Output ("    note:   $($outcome.Note)") }
}
$survived = @($outcomes | Where-Object { $_.Verdict -eq 'SURVIVED' }).Count
$notApplied = @($outcomes | Where-Object { $_.Verdict -eq 'NOT APPLIED' }).Count
$otherKill = @($outcomes | Where-Object { $_.Verdict -eq 'KILLED/OTHER' }).Count
$invalid = @($outcomes | Where-Object { $_.Verdict -eq 'INVALID' }).Count
$unconfirmed = @($outcomes | Where-Object { $_.Verdict -eq 'UNCONFIRMED' }).Count
Write-Output ("killed {0} | killed-wrong-test {1} | unconfirmed {2} | survived {3} | not applied {4} | invalid {5}" -f `
    (@($outcomes | Where-Object { $_.Verdict -eq 'KILLED' }).Count), $otherKill, $unconfirmed, $survived, $notApplied, $invalid)
Write-Output ("restore verified: {0} file(s) byte-identical to backup" -f $(if ($restored) { $touched.Count } else { 'NO - SOME FILES DIFFER' }))
Write-Output '============================'

Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue

# 2 and 1 are different claims. Collapsing them was how a broken spec could be
# read as a gap in the tests.
if (-not $restored -or $notApplied -gt 0 -or $invalid -gt 0) { exit 2 }
if ($survived -gt 0 -or $otherKill -gt 0 -or $unconfirmed -gt 0) { exit 1 }
exit 0
