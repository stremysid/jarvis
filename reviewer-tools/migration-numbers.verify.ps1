#Requires -Version 7.0
<#
    migration-numbers.verify.ps1 - prove each verdict migration-numbers.ps1 can
    reach is actually reachable, against a throwaway repository it builds itself.

    Usage:
        pwsh -NoProfile -ExecutionPolicy Bypass -File migration-numbers.verify.ps1
        pwsh -NoProfile -ExecutionPolicy Bypass -File migration-numbers.verify.ps1 -Scratch C:/Temp/migration-numbers-verify

    Why this exists. The classifications in migration-numbers.ps1 are rules about
    branches, and the repository the tool is pointed at cannot be made to exhibit
    all of them on demand: a clean run, a contested number, a stale number and a
    revised copy are four different states of origin. Three of those states are
    "clean", which is indistinguishable from a rule that never fires. A guard
    that cannot be shown to be load-bearing is indistinguishable from one that is
    not there at all - the lesson this repository already paid for with the
    body-clear trigger and the two stop-checks.

    So this builds a real remote. A bare origin plus a clone under -Scratch, with
    three migrations on main, and then constructs one state per case, runs the
    checker against it, and compares the exit code and the finding it printed.
    Nothing outside -Scratch is touched, nothing is fetched, and gh is not needed:
    the fixture has no GitHub remote, which is also how the "PR context
    unavailable, every branch still read" path gets exercised.

    Cases, and what each one is really testing:

      clean        a branch adding a free number is not a finding, and the next
                   free number skips the number that branch now holds.
      contested    two pending branches claiming one number with different
                   filenames exits 1 and names both refs.
      revision     the same filename at two revisions on two branches, at a
                   number main does not apply, is printed and NOT counted: it
                   must not exit 1.
      stale        a branch that forked before main took the number is printed
                   and NOT counted: it must not exit 1 either.
      applied-edit a branch changing bytes of a migration main already applies
                   exits 1 - the one content change that is a collision.
      merged       a branch already merged into main drops out as an exclusion,
                   and the migration it added is then main's own.

    Exit 0 when every case matched, 1 when one did not, 2 when the fixture could
    not be built.
#>

[CmdletBinding()]
param(
    [string] $Scratch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if (-not $Scratch) { $Scratch = Join-Path ([System.IO.Path]::GetTempPath()) 'migration-numbers-verify' }
$Checker = Join-Path $PSScriptRoot 'migration-numbers.ps1'
if (-not (Test-Path -LiteralPath $Checker -PathType Leaf)) { throw "checker not found next to this script: $Checker" }

# -Scratch is deleted wholesale, so it is only deleted when it is unmistakably
# this script's own fixture directory.
if (Test-Path -LiteralPath $Scratch) {
    if ((Split-Path -Leaf $Scratch) -ne 'migration-numbers-verify') {
        throw "refusing to delete '$Scratch': its last path segment is not 'migration-numbers-verify'"
    }
    Remove-Item -LiteralPath $Scratch -Recurse -Force
}

function Invoke-Git {
    param([Parameter(Mandatory)][string] $Cwd, [Parameter(Mandatory)][string[]] $GitArgs)
    # A fixture commit needs an identity, and a machine-level one may not exist.
    # example.invalid is reserved by RFC 2606, so nothing here can be a real address.
    $out = & git -C $Cwd -c user.name='migration-numbers-verify' -c user.email='verify@example.invalid' -c commit.gpgsign=false @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in ${Cwd}:`n$out" }
    return ($out -join "`n")
}

$results = New-Object System.Collections.Generic.List[object]

function Invoke-Case {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][int] $ExpectedExit,
        [Parameter(Mandatory)][string] $ExpectedPattern,
        [Parameter(Mandatory)][AllowEmptyString()][string] $ExpectedAbsent
    )
    $work = Join-Path $Scratch 'work'
    $output = (& pwsh -NoProfile -ExecutionPolicy Bypass -File $Checker -Repo $work 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $problems = New-Object System.Collections.Generic.List[string]
    if ($code -ne $ExpectedExit) { $problems.Add("exit $code, expected $ExpectedExit") }
    if ($output -notmatch $ExpectedPattern) { $problems.Add("output did not match /$ExpectedPattern/") }
    if ($ExpectedAbsent -and $output -match $ExpectedAbsent) { $problems.Add("output unexpectedly matched /$ExpectedAbsent/") }
    $results.Add([pscustomobject]@{ Case = $Name; Exit = $code; Expected = $ExpectedExit; Output = $output; Problems = @($problems) })
}

# --- the fixture: a real remote, three migrations on main -------------------
$originPath = Join-Path $Scratch 'origin.git'
$work = Join-Path $Scratch 'work'
$migrations = Join-Path $work 'apps/cloud-gateway/src/persistence/migrations'
New-Item -ItemType Directory -Force -Path $migrations | Out-Null

$null = Invoke-Git -Cwd $work -GitArgs @('init', '-b', 'main')
Set-Content -LiteralPath (Join-Path $migrations '0001_foundation.sql') -Value "-- The fixture's foundation.`nCREATE TABLE things (id TEXT PRIMARY KEY);"
Set-Content -LiteralPath (Join-Path $migrations '0002_liveness.sql') -Value "-- The fixture's liveness table.`nCREATE TABLE heartbeats (id TEXT PRIMARY KEY);"
$null = Invoke-Git -Cwd $work -GitArgs @('add', '-A')
$null = Invoke-Git -Cwd $work -GitArgs @('commit', '-m', 'fixture: foundation and liveness')
$beforeNumberThree = (Invoke-Git -Cwd $work -GitArgs @('rev-parse', 'HEAD')).Trim()
Set-Content -LiteralPath (Join-Path $migrations '0003_archive.sql') -Value "-- The fixture's archive table, added after the dead branch forked.`nCREATE TABLE archive (id TEXT PRIMARY KEY);"
$null = Invoke-Git -Cwd $work -GitArgs @('add', '-A')
$null = Invoke-Git -Cwd $work -GitArgs @('commit', '-m', 'fixture: archive')

$null = Invoke-Git -Cwd $work -GitArgs @('init', '--bare', $originPath)
$null = Invoke-Git -Cwd $work -GitArgs @('remote', 'add', 'origin', $originPath)
$null = Invoke-Git -Cwd $work -GitArgs @('push', '-u', 'origin', 'main')
$null = Invoke-Git -Cwd $originPath -GitArgs @('symbolic-ref', 'HEAD', 'refs/heads/main')

function New-FixtureBranch {
    param(
        [Parameter(Mandatory)][string] $Branch,
        [Parameter(Mandatory)][string] $File,
        [Parameter(Mandatory)][string] $Body,
        [string] $From
    )
    $work = Join-Path $Scratch 'work'
    if ($From) { $null = Invoke-Git -Cwd $work -GitArgs @('checkout', '-B', $Branch, $From) }
    else { $null = Invoke-Git -Cwd $work -GitArgs @('checkout', '-B', $Branch, 'main') }
    Set-Content -LiteralPath (Join-Path $work "apps/cloud-gateway/src/persistence/migrations/$File") -Value $Body
    $null = Invoke-Git -Cwd $work -GitArgs @('add', '-A')
    $null = Invoke-Git -Cwd $work -GitArgs @('commit', '-m', "fixture: $Branch")
    $null = Invoke-Git -Cwd $work -GitArgs @('push', 'origin', $Branch)
    $null = Invoke-Git -Cwd $work -GitArgs @('checkout', 'main')
}

function Remove-FixtureBranch {
    param([Parameter(Mandatory)][string] $Branch)
    $work = Join-Path $Scratch 'work'
    $null = Invoke-Git -Cwd $work -GitArgs @('push', 'origin', '--delete', $Branch)
    $null = Invoke-Git -Cwd $work -GitArgs @('branch', '-D', $Branch)
}

# --- clean: a free number claimed by one branch, and 0004 is then not free ----
New-FixtureBranch -Branch 'case/a-clean' -File '0004_alpha.sql' -Body '-- A free number, claimed once.'
Invoke-Case -Name 'clean' -ExpectedExit 0 -ExpectedPattern 'next genuinely free number: 0005[\s\S]*verdict: clean' -ExpectedAbsent 'COLLISION'
Remove-FixtureBranch -Branch 'case/a-clean'

# --- contested: the defect this script exists for -----------------------------
New-FixtureBranch -Branch 'case/b-one' -File '0005_one.sql' -Body '-- First claimant of 0005.'
New-FixtureBranch -Branch 'case/b-two' -File '0005_two.sql' -Body '-- Second claimant of 0005.'
Invoke-Case -Name 'contested' -ExpectedExit 1 -ExpectedPattern 'COLLISION 0005 - 2 different migrations claim this number:[\s\S]*origin/case/b-one[\s\S]*origin/case/b-two' -ExpectedAbsent ''
Remove-FixtureBranch -Branch 'case/b-one'
Remove-FixtureBranch -Branch 'case/b-two'

# --- revision: same filename, two revisions, nothing shipped yet --------------
New-FixtureBranch -Branch 'case/c-old' -File '0006_same.sql' -Body '-- Revision one of the same migration.'
New-FixtureBranch -Branch 'case/c-new' -File '0006_same.sql' -Body '-- Revision two of the same migration.'
Invoke-Case -Name 'revision' -ExpectedExit 0 -ExpectedPattern 'REVISION 0006[\s\S]*verdict: clean' -ExpectedAbsent 'COLLISION'
Remove-FixtureBranch -Branch 'case/c-old'
Remove-FixtureBranch -Branch 'case/c-new'

# --- stale: a branch that forked before main took 0003 ------------------------
New-FixtureBranch -Branch 'case/d-dead' -File '0003_progress.sql' -Body '-- Picked 0003 when main was at 0002.' -From $beforeNumberThree
Invoke-Case -Name 'stale' -ExpectedExit 0 -ExpectedPattern 'STALE 0003[\s\S]*0003_progress\.sql[\s\S]*forked at main@0002[\s\S]*verdict: clean' -ExpectedAbsent 'COLLISION'
Remove-FixtureBranch -Branch 'case/d-dead'

# --- applied-edit: changing bytes main already applied ------------------------
New-FixtureBranch -Branch 'case/e-edit' -File '0003_archive.sql' -Body '-- Rewritten after 0003 was applied on main.'
Invoke-Case -Name 'applied-edit' -ExpectedExit 1 -ExpectedPattern 'COLLISION 0003 - a pending branch changes a migration main already applies' -ExpectedAbsent ''
Remove-FixtureBranch -Branch 'case/e-edit'

# --- merged: an ancestor of main is excluded, not reported --------------------
New-FixtureBranch -Branch 'case/f-merged' -File '0007_merged.sql' -Body '-- Lands on main, so it stops being a branch claim.'
$null = Invoke-Git -Cwd $work -GitArgs @('merge', '--no-ff', '-m', 'fixture: merge case/f-merged', 'case/f-merged')
$null = Invoke-Git -Cwd $work -GitArgs @('push', 'origin', 'main')
Invoke-Case -Name 'merged' -ExpectedExit 0 -ExpectedPattern 'excluded - an ancestor of origin/main[\s\S]*next genuinely free number: 0008[\s\S]*verdict: clean[\s\S]*EXCLUDED \(1\)[\s\S]*origin/case/f-merged' -ExpectedAbsent 'COLLISION'

# --- report -------------------------------------------------------------------
Write-Output ''
Write-Output '===== MIGRATION-NUMBERS VERIFY ====='
Write-Output ("fixture: {0}" -f $Scratch)
Write-Output ''
$failed = 0
foreach ($result in $results) {
    if ($result.Problems.Count -eq 0) {
        Write-Output ("PASS  {0,-13} exit {1} (expected {2})" -f $result.Case, $result.Exit, $result.Expected)
    }
    else {
        $failed += 1
        Write-Output ("FAIL  {0,-13} exit {1} (expected {2}): {3}" -f $result.Case, $result.Exit, $result.Expected, ($result.Problems -join '; '))
    }
    Write-Output ''
    Write-Output $result.Output.TrimEnd()
    Write-Output ''
    Write-Output '-----------------------------------'
}
Write-Output ("{0} case(s), {1} failed" -f $results.Count, $failed)
Write-Output '===================================='

if ($failed -gt 0) { exit 1 }
exit 0
