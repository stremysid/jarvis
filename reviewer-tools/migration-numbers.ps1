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
    twice: 0018, then 0035 (codex/tier3-classify-memory-correct and
    codex/r1-sensitive-action-pin-v6, main still at 0034). The existing
    mitigation is a sentence in a runbook telling reviewers to check every open
    PR branch by hand, and it has failed twice.

    It reads only remote refs with `git ls-tree`, so it never checks a branch
    out and never touches anyone's working tree. Open PR branches come from
    `gh pr list`; nothing is hardcoded.

    It fetches origin first, because a scan of stale local refs can report a
    collision that has since been resolved - or miss one that has just been
    created. A fetch failure aborts (exit 2) rather than answering from refs
    that may no longer match the open PRs.

    Collisions reported:
      - a NUMBER with more than one distinct filename across the scanned refs
        (the 0018 / 0035 defect), and
      - one filename with different blob contents on different refs, which is
        the same number meaning two different migrations depending on merge
        order and which a filename-only comparison would miss.

    A number that is present, byte-identical, on main and on every branch that
    carries it is NOT a collision: every branch contains main's migrations.

    Next free number is the smallest number above the highest number on
    origin/main that no scanned ref claims. It is not a gap off main, because a
    gap was either applied already or deliberately skipped, and Wrangler
    applies by name.

    -Repo defaults to the repository this script lives in (the parent of this
    file's folder), NOT a shared checkout path. docs-check.ps1 defaults to
    C:/javis, so running it from a worktree silently checks the wrong tree;
    this script cannot do that, and it prints the resolved repository and every
    scanned ref at the top of its output so the tree under test is unmissable.

    Exit 0 clean, 1 collision, 2 could not produce a usable answer (gh missing
    or unauthenticated, not a repository, fetch failed, a listed PR branch has
    no local ref). The exit-2 output says ABORTED in three places and never
    prints a clean verdict, so a failure can never be mistaken for a green run -
    that distinction is the whole reason mutate.ps1 aborts loudly rather than
    reporting a result it did not get.
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

$gh = (Get-Command gh -ErrorAction SilentlyContinue)?.Source
if (-not $gh) {
    Stop-Loudly 'gh must be on PATH; without it the open PR branches cannot be enumerated. An unenumerated branch is an unchecked branch.'
}

$remote = ((& $git -C $Repo remote get-url origin 2>$null) -join '').Trim()
if ($LASTEXITCODE -ne 0 -or -not $remote) {
    Stop-Loudly "no 'origin' remote in '$Repo'; the open PR branches live on origin."
}

# Freshness is load-bearing: a stale ref set can show a resolved collision or
# hide a new one. Abort instead of answering from refs that may not match GitHub.
$null = & $git -C $Repo fetch origin --quiet 2>&1
if ($LASTEXITCODE -ne 0) {
    Stop-Loudly "git fetch origin failed, so local refs may not match the open PR branches and a clean result could be stale."
}

$rawPrs = (& $gh pr list --repo $remote --state open --limit 1000 --json number,headRefName 2>&1 | Out-String)
$ghExit = $LASTEXITCODE
if ($ghExit -ne 0) {
    Stop-Loudly "gh pr list failed (exit $ghExit); gh is unavailable or unauthenticated:`n$($rawPrs.Trim())"
}

$prs = @()
if ($rawPrs.Trim()) {
    try {
        $parsed = $rawPrs | ConvertFrom-Json
    }
    catch {
        Stop-Loudly "gh pr list returned JSON this tool could not parse: $($_.Exception.Message)"
    }
    if ($parsed) { $prs = @($parsed) }
}

$scans = New-Object System.Collections.Generic.List[object]
$scannedRefs = @{}
$scans.Add([pscustomobject]@{ Ref = 'origin/main'; Label = 'main'; Pr = $null })
$scannedRefs['origin/main'] = $true

foreach ($pr in $prs) {
    if (-not $pr.PSObject.Properties['headRefName'] -or -not $pr.PSObject.Properties['number']) {
        Stop-Loudly "gh pr list returned a pull request without the fields this tool asked for: $($pr | ConvertTo-Json -Compress)"
    }
    $branch = [string]$pr.headRefName
    if ([string]::IsNullOrWhiteSpace($branch)) {
        Stop-Loudly 'gh pr list returned a pull request without a headRefName.'
    }
    $ref = "origin/$branch"
    if ($scannedRefs.ContainsKey($ref)) { continue }
    # refs under origin/ only. A fork PR's head is not here and cannot be read
    # without fetching the fork, so it is refused rather than silently skipped.
    $scans.Add([pscustomobject]@{ Ref = $ref; Label = $branch; Pr = [int]$pr.number })
    $scannedRefs[$ref] = $true
}

foreach ($scan in $scans) {
    $null = & $git -C $Repo rev-parse --verify --quiet ($scan.Ref + '^{commit}') 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Loudly "ref '$($scan.Ref)' is not present locally after fetch (branch deleted, or a fork PR this checkout does not track), so its migrations cannot be read."
    }
}

# One claim per file per scanned ref. Reading the tree object, not the working
# tree, is what keeps this from needing a checkout or a clean worktree.
$claims = New-Object System.Collections.Generic.List[object]
$claimedNumbers = @{}

foreach ($scan in $scans) {
    $lines = & $git -C $Repo ls-tree -r $scan.Ref -- $MigrationDir 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Loudly "git ls-tree failed for '$($scan.Ref)'."
    }
    foreach ($line in @($lines)) {
        if ($line -notmatch '^\S+\s+\S+\s+([0-9a-f]{40,64})\s+(.+)$') { continue }
        $sha = $Matches[1]
        $leaf = Split-Path -Leaf $Matches[2]
        if ($leaf -notmatch '^(\d{4})_') { continue }
        $number = $Matches[1]
        $claims.Add([pscustomobject]@{
                Ref = $scan.Ref; Label = $scan.Label; Pr = $scan.Pr
                Number = $number; File = $leaf; Sha = $sha
            })
        $claimedNumbers[$number] = $true
    }
}

$mainClaims = @($claims | Where-Object { $_.Ref -eq 'origin/main' })
if ($mainClaims.Count -eq 0) {
    Stop-Loudly "no migrations found under '$MigrationDir' on origin/main; this does not look like the Jarvis repository (wrong -Repo?)."
}

function Format-Number { param([int] $Value) return ('{0:D4}' -f $Value) }
function Format-Blob { param([string] $Sha) return $Sha.Substring(0, [Math]::Min(10, $Sha.Length)) }

$collisions = New-Object System.Collections.Generic.List[object]
foreach ($group in ($claims | Group-Object Number)) {
    $files = @($group.Group | Select-Object -ExpandProperty File -Unique)
    if ($files.Count -gt 1) {
        $collisions.Add([pscustomobject]@{
                Number = $group.Name
                Kind   = 'number'
                Claims = @($group.Group | Sort-Object File, Ref)
            })
    }
    else {
        $shas = @($group.Group | Select-Object -ExpandProperty Sha -Unique)
        if ($shas.Count -gt 1) {
            $collisions.Add([pscustomobject]@{
                    Number = $group.Name
                    Kind   = 'content'
                    Claims = @($group.Group | Sort-Object Ref)
                })
        }
    }
}

Write-Output ''
Write-Output '===== MIGRATION NUMBER CHECK ====='
Write-Output ("repo:       {0}{1}" -f $Repo, $(if ($RepoWasDefaulted) { '  (defaulted from this script''s location)' } else { '' }))
Write-Output ("migrations: {0}" -f $MigrationDir)
Write-Output ("scanned:    origin/main + {0} open PR branch(es)" -f ($scans.Count - 1))
foreach ($scan in $scans) {
    $label = if ($null -eq $scan.Pr) { 'main' } else { "PR #$($scan.Pr)" }
    Write-Output ('    {0,-48} {1}' -f $scan.Ref, $label)
}
Write-Output ("files read: {0}" -f $claims.Count)
Write-Output ''

if ($collisions.Count -eq 0) {
    Write-Output 'no number collision: every migration number is claimed by a single branch.'
}
else {
    foreach ($collision in ($collisions | Sort-Object Number)) {
        if ($collision.Kind -eq 'number') {
            $count = @($collision.Claims | Select-Object -ExpandProperty File -Unique).Count
            Write-Output ("COLLISION {0} - {1} different migrations claim this number:" -f $collision.Number, $count)
        }
        else {
            Write-Output ("COLLISION {0} - the same filename has different contents on different branches:" -f $collision.Number)
        }
        foreach ($claim in $collision.Claims) {
            $who = if ($null -eq $claim.Pr) { $claim.Ref } else { "$($claim.Ref)  (PR #$($claim.Pr))" }
            Write-Output ("    {0}  [{1}]" -f $claim.File, (Format-Blob $claim.Sha))
            Write-Output ("        {0}" -f $who)
        }
        Write-Output ''
    }
}

$floor = ($mainClaims | ForEach-Object { [int]$_.Number } | Measure-Object -Maximum).Maximum
$next = $floor + 1
while ($claimedNumbers.ContainsKey((Format-Number $next))) { $next++ }

Write-Output ("next genuinely free number: {0}" -f (Format-Number $next))
if ($collisions.Count -eq 0) {
    Write-Output 'verdict: clean'
}
else {
    Write-Output ("verdict: COLLISION - {0} number(s) claimed by more than one branch" -f $collisions.Count)
}
Write-Output '=================================='

if ($collisions.Count -gt 0) { exit 1 }
exit 0
