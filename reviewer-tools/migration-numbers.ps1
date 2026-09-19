#Requires -Version 7.0
<#
    migration-numbers.ps1 - catch a migration-number collision BEFORE it reaches main.

    Usage:
        pwsh -NoProfile -ExecutionPolicy Bypass -File migration-numbers.ps1
        pwsh -NoProfile -ExecutionPolicy Bypass -File migration-numbers.ps1 -Repo 'C:/Users/Sid/jarvis-migcheck'

    Why this exists. Migrations are numbered by FILENAME, two vendor chats build
    in parallel on separate branches, and each picks "the next free number" by
    looking at main - where neither branch's file exists yet. So both pick the
    same number and a human finds it by eye, after the fact. It has happened
    twice: 0018, then 0035.

    EVERY head on origin is enumerated, with `git ls-remote --heads origin`.
    This script used to enumerate `gh pr list` instead, and that was a blind spot
    with teeth. The standing builder rule here is "push before you finish", so
    the window in which two builders collide is exactly the window in which the
    second branch is pushed and has no PR yet. On 2026-09-18 it printed
    "verdict: clean, next genuinely free number: 0037" while two branches both
    held 0036 - one with an open PR, the other pushed and un-PR'd. PR numbers
    are still printed wherever a branch has one, because they are real context;
    they no longer decide which branches are read.

    Reading every branch raises the opposite risk - a checker that cries wolf on
    every run is a checker nobody reads - so two rules remove the noise, and
    neither is a judgement call about how old or how alive a branch looks:

      1. A branch whose tip is already an ancestor of origin/main is EXCLUDED.
         Its commits are main's commits, so it cannot add a migration main does
         not already have. Every excluded ref is printed at the bottom with the
         reason, never swallowed.

      2. A branch is compared against ITS OWN merge-base with origin/main, not
         against main's tip. A branch that forked before a migration was edited
         on main still holds the older bytes without ever having touched that
         file, and merging it cannot change the file. Only a file the branch
         itself added or modified is read as a claim. Without this, a scan of
         everything reports five "content collisions" that are nothing but
         stale forks of 0001, 0002, 0006 and 0014.

    Three kinds of finding, and only the first sets the verdict:

      - COLLISION: a number main does NOT apply that more than one pending
        branch claims with a different filename, or - for a number main does
        apply - one filename whose bytes a pending branch changes. Two branches
        adding 0036_a.sql and 0036_b.sql merge cleanly and silently; a branch
        rewriting an applied migration changes text that a D1 receipt already
        names. Both are the defect this script exists for.

      - STALE, printed and not counted: a number main already applies under a
        different name, claimed by a branch that forked earlier and picked a
        number main has since taken. The branch cannot land as numbered, but
        nothing is racing for that number any more, and reporting it as a live
        collision forever is how a tool teaches its reader to ignore it.

      - REVISION, printed and not counted: one filename with different bytes at
        a number main does not apply yet. This repo pushes revised work to a new
        branch rather than force-pushing, so a superseded copy is the normal
        state of an old branch, not a defect: nothing has shipped, the second
        merge is an add/add conflict git refuses rather than a silent overwrite,
        and counting it would leave this tool red permanently on work that is
        already finished. It stops being a revision the moment main applies the
        number, which is why the rule keys on that and not on the branch's age.

    A number present, byte-identical, on main and on a branch is not a
    collision: every branch contains main's migrations.

    Next free number is the smallest number above the highest number on
    origin/main that no pending branch claims. It is not a gap off main, because
    a gap was either applied already or deliberately skipped, and Wrangler
    applies by name.

    -Repo defaults to the repository this script lives in (the parent of this
    file's folder), NOT a shared checkout path. docs-check.ps1 defaults to
    C:/javis, so running it from a worktree silently checks the wrong tree;
    this script cannot do that, and it prints the resolved repository and every
    ref it read so the tree under test is unmissable.

    Exit 0 clean, 1 contested collision, 2 could not produce a usable answer
    (not a repository, no origin/main, fetch failed, a branch that cannot be
    compared). The exit-2 output says ABORTED in three places and never prints a
    clean verdict, so a failure can never be mistaken for a green run - that
    distinction is the whole reason mutate.ps1 aborts loudly rather than
    reporting a result it did not get.

    What this does NOT catch: a branch that DELETES a migration file main still
    has, and a migration file added under a name that is not NNNN_something.sql.
    Neither has happened here; both would leave a D1 receipt with no text to
    replay, and both are invisible to a rule stated in terms of numbers.
#>

[CmdletBinding()]
param(
    [string] $Repo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native commands report through $LASTEXITCODE here; a non-zero exit is data
# this tool records and turns into an explicit abort, not an exception.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$MigrationDir = 'apps/cloud-gateway/src/persistence/migrations'

# An unexpected failure is not a verdict. Without this, a StrictMode property
# error or a bad gh payload would leave the process on exit 1, which every
# caller reads as "collision found" - a wrong answer wearing the right seal.
trap {
    Write-Output ''
    Write-Output '===== MIGRATION NUMBER CHECK (ABORTED - NOT A CLEAN RESULT) ====='
    Write-Output ("MIGRATION-NUMBERS ABORTED: unexpected failure: {0}" -f $_.Exception.Message)
    Write-Output '==============================================================='
    exit 2
}

$RepoWasDefaulted = -not $Repo
if ($RepoWasDefaulted) { $Repo = Split-Path -Parent $PSScriptRoot }

function Stop-Loudly {
    param([Parameter(Mandatory)][string] $Message)
    Write-Output ''
    Write-Output '===== MIGRATION NUMBER CHECK (ABORTED - NOT A CLEAN RESULT) ====='
    Write-Output ("repo:    {0}{1}" -f $Repo, $(if ($RepoWasDefaulted) { '  (defaulted from this script''s location)' } else { '' }))
    Write-Output ''
    Write-Output ("MIGRATION-NUMBERS ABORTED: {0}" -f $Message)
    Write-Output '==============================================================='
    exit 2
}

if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
    Stop-Loudly "repo '$Repo' does not exist."
}

$git = (Get-Command git -ErrorAction SilentlyContinue)?.Source
if (-not $git) { Stop-Loudly 'git must be on PATH.' }

# Resolving the repository root is what makes every git call below independent
# of the caller's working directory, so running from a worktree or from the
# shared checkout changes only which refs are fetched, never which tree is read.
$top = ((& $git -C $Repo rev-parse --show-toplevel 2>$null) -join '').Trim()
if ($LASTEXITCODE -ne 0 -or -not $top) {
    Stop-Loudly "'$Repo' is not inside a git repository."
}
$Repo = $top

$remote = ((& $git -C $Repo remote get-url origin 2>$null) -join '').Trim()
if ($LASTEXITCODE -ne 0 -or -not $remote) {
    Stop-Loudly "no 'origin' remote in '$Repo'; the branches to compare live on origin."
}

# Freshness is load-bearing: a stale ref set can show a resolved collision or
# hide a new one. The fetch happens BEFORE the enumeration so that every sha
# ls-remote reports has almost certainly been fetched; a push that lands between
# the two is caught by the object check below rather than answered around.
$null = & $git -C $Repo fetch origin --quiet 2>&1
if ($LASTEXITCODE -ne 0) {
    Stop-Loudly 'git fetch origin failed, so local objects may not match the branches on origin and a clean result could be stale.'
}

$headLines = @(& $git -C $Repo ls-remote --heads origin 2>$null)
if ($LASTEXITCODE -ne 0) {
    Stop-Loudly 'git ls-remote --heads origin failed, so the branches on origin could not be enumerated.'
}

$heads = New-Object System.Collections.Generic.List[object]
foreach ($line in $headLines) {
    if ($line -notmatch '^([0-9a-f]{40,64})\s+refs/heads/(.+)$') { continue }
    $heads.Add([pscustomobject]@{ Sha = $Matches[1]; Branch = $Matches[2] })
}
$mainHead = @($heads | Where-Object { $_.Branch -eq 'main' })
if ($mainHead.Count -ne 1) {
    Stop-Loudly "origin has no single 'main' branch; this does not look like the Jarvis repository (wrong -Repo?)."
}
$mainSha = $mainHead[0].Sha

# PR numbers are context, not coverage: every branch is read either way, so a
# missing or unauthenticated gh can no longer hide one, and aborting on it would
# refuse to answer a question this script can now answer completely.
$prByBranch = @{}
$prContext = 'unavailable'
$gh = (Get-Command gh -ErrorAction SilentlyContinue)?.Source
if (-not $gh) {
    $prContext = 'unavailable (gh is not on PATH)'
}
else {
    $rawPrs = (& $gh pr list --repo $remote --state open --limit 1000 --json number,headRefName 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        $firstLine = (($rawPrs.Trim() -split "`n")[0]).Trim()
        if ($firstLine.Length -gt 120) { $firstLine = $firstLine.Substring(0, 117) + '...' }
        $prContext = "unavailable (gh pr list failed: $firstLine)"
    }
    else {
        $prs = @()
        if ($rawPrs.Trim()) {
            try { $parsed = $rawPrs | ConvertFrom-Json }
            catch { $parsed = $null }
            if ($parsed) { $prs = @($parsed) }
        }
        foreach ($pr in $prs) {
            if (-not $pr.PSObject.Properties['headRefName'] -or -not $pr.PSObject.Properties['number']) { continue }
            $prByBranch[[string]$pr.headRefName] = [int]$pr.number
        }
        $prContext = ("{0} open pull request(s)" -f $prByBranch.Count)
    }
}

function Read-MigrationTree {
    param([Parameter(Mandatory)][string] $Commit, [Parameter(Mandatory)][string] $Who)
    $map = @{}
    $lines = & $git -C $Repo ls-tree -r $Commit -- $MigrationDir 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Loudly "git ls-tree failed for $Who ($Commit); its migration files cannot be read."
    }
    foreach ($line in @($lines)) {
        if ($line -notmatch '^\S+\s+\S+\s+([0-9a-f]{40,64})\s+(.+)$') { continue }
        $sha = $Matches[1]
        $leaf = Split-Path -Leaf $Matches[2]
        if ($leaf -notmatch '^(\d{4})_') { continue }
        $map[$leaf] = [pscustomobject]@{ Sha = $sha; Number = $Matches[1] }
    }
    return $map
}

$mainMap = Read-MigrationTree -Commit $mainSha -Who 'origin/main'
if ($mainMap.Count -eq 0) {
    Stop-Loudly "no migrations found under '$MigrationDir' on origin/main; this does not look like the Jarvis repository (wrong -Repo?)."
}

# Classification per branch. `Claims` are the migrations this branch itself
# added or changed relative to its own fork point, minus any that already match
# main's bytes exactly - the branch has no opinion about those.
$mergedRefs = New-Object System.Collections.Generic.List[string]
$unreadableRefs = New-Object System.Collections.Generic.List[string]
$pending = New-Object System.Collections.Generic.List[object]

foreach ($head in ($heads | Where-Object { $_.Branch -ne 'main' } | Sort-Object Branch)) {
    $ref = "origin/$($head.Branch)"
    $base = ((& $git -C $Repo merge-base $head.Sha $mainSha 2>$null) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $base) {
        # Either the object was not fetched (a push raced this run) or the branch
        # shares no history with main. Both mean this branch was not read, and an
        # unread branch must never look like a branch with nothing to report.
        $unreadableRefs.Add($ref)
        continue
    }
    if ($base -eq $head.Sha) {
        $mergedRefs.Add($ref)
        continue
    }
    $branchMap = Read-MigrationTree -Commit $head.Sha -Who $ref
    $baseMap = Read-MigrationTree -Commit $base -Who "$ref at its fork point"
    $claims = New-Object System.Collections.Generic.List[object]
    foreach ($file in ($branchMap.Keys | Sort-Object)) {
        $blob = $branchMap[$file].Sha
        if ($baseMap.ContainsKey($file) -and $baseMap[$file].Sha -eq $blob) { continue }
        if ($mainMap.ContainsKey($file) -and $mainMap[$file].Sha -eq $blob) { continue }
        $claims.Add([pscustomobject]@{ File = $file; Sha = $blob; Number = $branchMap[$file].Number })
    }
    $pending.Add([pscustomobject]@{
            Ref = $ref; Branch = $head.Branch; Sha = $head.Sha; Base = $base
            BaseNumber = $(if ($baseMap.Count -gt 0) { (($baseMap.Values | ForEach-Object { [int]$_.Number }) | Measure-Object -Maximum).Maximum } else { 0 })
            Pr = $(if ($prByBranch.ContainsKey($head.Branch)) { $prByBranch[$head.Branch] } else { $null })
            Claims = $claims
        })
}

if ($unreadableRefs.Count -gt 0) {
    Stop-Loudly ("these branches could not be compared with origin/main, so their migrations were not read: {0}. A push landing mid-run does this; re-run." -f ($unreadableRefs -join ', '))
}

function Format-Number { param([int] $Value) return ('{0:D4}' -f $Value) }
function Format-Blob { param([string] $Sha) return $Sha.Substring(0, [Math]::Min(10, $Sha.Length)) }
function Format-Who {
    param([string] $Ref, [AllowNull()][object] $Pr, [string] $Suffix)
    $pr = if ($null -eq $Pr) { 'no PR' } else { "PR #$Pr" }
    return "$Ref  ($pr$Suffix)"
}

# One row per (number, filename, blob) over main and every pending claim.
$entries = New-Object System.Collections.Generic.List[object]
foreach ($file in $mainMap.Keys) {
    $entries.Add([pscustomobject]@{
            Number = $mainMap[$file].Number; File = $file; Sha = $mainMap[$file].Sha
            Ref = 'origin/main'; Pr = $null; ForkedAt = $null
        })
}
$claimedNumbers = @{}
foreach ($branch in $pending) {
    foreach ($claim in $branch.Claims) {
        $claimedNumbers[$claim.Number] = $true
        $entries.Add([pscustomobject]@{
                Number = $claim.Number; File = $claim.File; Sha = $claim.Sha
                Ref = $branch.Ref; Pr = $branch.Pr; ForkedAt = $branch.BaseNumber
            })
    }
}

$contested = New-Object System.Collections.Generic.List[object]
$stale = New-Object System.Collections.Generic.List[object]
$revisions = New-Object System.Collections.Generic.List[object]
foreach ($group in ($entries | Group-Object Number)) {
    $files = @($group.Group | Select-Object -ExpandProperty File -Unique)
    $shas = @($group.Group | Select-Object -ExpandProperty Sha -Unique)
    $mainOwns = @($group.Group | Where-Object { $_.Ref -eq 'origin/main' }).Count -gt 0
    if ($files.Count -gt 1) {
        $record = [pscustomobject]@{
            Number = $group.Name
            Kind = $(if ($mainOwns) { 'stale' } else { 'number' })
            Claims = @($group.Group | Sort-Object File, Ref)
        }
        if ($mainOwns) { $stale.Add($record) } else { $contested.Add($record) }
    }
    elseif ($shas.Count -gt 1) {
        # Same filename, different bytes. When main applies this number the
        # bytes are the ledger and a branch changing them is a collision; when
        # main does not, this is a revised copy of work still in flight.
        $record = [pscustomobject]@{
            Number = $group.Name
            Kind = $(if ($mainOwns) { 'content' } else { 'revision' })
            Claims = @($group.Group | Sort-Object Ref)
        }
        if ($mainOwns) { $contested.Add($record) } else { $revisions.Add($record) }
    }
}

function Write-ClaimList {
    param([object] $Collision)
    if ($Collision.Kind -eq 'number') {
        $count = @($Collision.Claims | Select-Object -ExpandProperty File -Unique).Count
        Write-Output ("COLLISION {0} - {1} different migrations claim this number:" -f $Collision.Number, $count)
    }
    elseif ($Collision.Kind -eq 'content') {
        Write-Output ("COLLISION {0} - a pending branch changes a migration main already applies:" -f $Collision.Number)
    }
    elseif ($Collision.Kind -eq 'revision') {
        Write-Output ("REVISION {0} - the same filename at different revisions on branches that all still claim it:" -f $Collision.Number)
    }
    else {
        Write-Output ("STALE {0} - main already applies this number, and a branch that forked earlier claims it too:" -f $Collision.Number)
    }
    foreach ($claim in $Collision.Claims) {
        Write-Output ("    {0}  [{1}]" -f $claim.File, (Format-Blob $claim.Sha))
        $suffix = if ($null -eq $claim.ForkedAt) { '' } else { ", forked at main@$(Format-Number ([int]$claim.ForkedAt))" }
        Write-Output ("        {0}" -f (Format-Who -Ref $claim.Ref -Pr $claim.Pr -Suffix $suffix))
    }
    Write-Output ''
}

$withClaims = @($pending | Where-Object { $_.Claims.Count -gt 0 })

Write-Output ''
Write-Output '===== MIGRATION NUMBER CHECK ====='
Write-Output ("repo:       {0}{1}" -f $Repo, $(if ($RepoWasDefaulted) { '  (defaulted from this script''s location)' } else { '' }))
Write-Output ("migrations: {0}" -f $MigrationDir)
Write-Output ("branches:   {0} head(s) on origin besides main, every one enumerated from git ls-remote" -f ($pending.Count + $mergedRefs.Count))
Write-Output ("            {0,4} excluded - an ancestor of origin/main, so nothing on it is not already on main" -f $mergedRefs.Count)
Write-Output ("            {0,4} pending - compared against its own fork point, not against main's tip" -f $pending.Count)
Write-Output ("            {0,4} of those changed a migration file" -f $withClaims.Count)
Write-Output ("PR context: {0}" -f $prContext)
Write-Output '            PR numbers are context only: every head on origin is read whether or not it has one.'
$claimCount = (@($pending | ForEach-Object { $_.Claims.Count }) | Measure-Object -Sum).Sum
Write-Output ("claims:     {0} migration file(s) on main; {1} added or changed by a pending branch" -f $mainMap.Count, $claimCount)
Write-Output ''

if ($contested.Count -eq 0) {
    Write-Output 'no contested number: no number is claimed by more than one pending branch, and no'
    Write-Output 'pending branch rewrites a migration that main already applies.'
}
else {
    foreach ($collision in ($contested | Sort-Object Number)) { Write-ClaimList -Collision $collision }
}
foreach ($collision in ($stale | Sort-Object Number)) { Write-ClaimList -Collision $collision }
foreach ($collision in ($revisions | Sort-Object Number)) { Write-ClaimList -Collision $collision }

$floor = (($mainMap.Values | ForEach-Object { [int]$_.Number }) | Measure-Object -Maximum).Maximum
$next = $floor + 1
while ($claimedNumbers.ContainsKey((Format-Number $next))) { $next++ }

Write-Output ("next genuinely free number: {0}" -f (Format-Number $next))
if ($contested.Count -eq 0) {
    Write-Output 'verdict: clean'
}
else {
    Write-Output ("verdict: COLLISION - {0} number(s) contested by more than one pending branch" -f $contested.Count)
}
if ($stale.Count -gt 0) {
    Write-Output ("note:    {0} stale claim(s) above are printed but not counted: a branch that cannot land as numbered is not a number two builders are racing for." -f $stale.Count)
}
if ($revisions.Count -gt 0) {
    Write-Output ("note:    {0} revision(s) above are printed but not counted: nothing has shipped at that number, so a superseded copy is an old branch, not a defect." -f $revisions.Count)
}
Write-Output '=================================='

Write-Output ''
Write-Output ("EXCLUDED ({0}) - already merged into origin/main, printed so the filter is auditable:" -f $mergedRefs.Count)
if ($mergedRefs.Count -eq 0) { Write-Output '    (none)' }
else {
    $line = '    '
    foreach ($ref in ($mergedRefs | Sort-Object)) {
        if ($line.Length + $ref.Length + 2 -gt 100) { Write-Output $line.TrimEnd(); $line = '    ' }
        $line += "$ref, "
    }
    Write-Output $line.TrimEnd().TrimEnd(',')
}
Write-Output ("PENDING ({0}) - read for claims; {1} changed a migration file:" -f $pending.Count, $withClaims.Count)
foreach ($branch in ($pending | Sort-Object Ref)) {
    $who = if ($null -eq $branch.Pr) { 'no PR' } else { "PR #$($branch.Pr)" }
    if ($branch.Claims.Count -eq 0) {
        Write-Output ("    {0,-52} {1,-9} no migration change" -f $branch.Ref, $who)
    }
    else {
        Write-Output ("    {0,-52} {1,-9} {2}" -f $branch.Ref, $who, (@($branch.Claims | ForEach-Object { $_.File }) -join ', '))
    }
}
Write-Output '=================================='

if ($contested.Count -gt 0) { exit 1 }
exit 0
