#Requires -Version 7.0
<#
    docs-check.ps1 - verify the checkable claims in Markdown against reality.

    Usage:
        pwsh -NoProfile -ExecutionPolicy Bypass -File docs-check.ps1 -Repo 'C:/javis'
        pwsh -NoProfile -ExecutionPolicy Bypass -File docs-check.ps1 -Repo 'C:/javis' -Files 'docs/HANDOFF.md','AGENTS.md'

    Why this exists. On 2026-09-18 every real problem of the day was a
    confidently stated wrong FACT, and not one of them was in code: three false
    claims in builder reports, three in the handoff, two in AGENTS.md. Code gets
    tested. Prose does not, so it rots silently and is then repeated by the next
    reader as though it were state.

    Three of those errors were mechanically checkable and would have been caught
    here: a `uv.exe` under a user profile that does not exist on the machine, so
    every local-agent command failed; two stale branch heads quoted as current.

    What it checks, and only what it can check without guessing:

      SHA        a 7-40 char hex token must resolve to a real commit object.
                 Catches a sha quoted from a branch that has since moved.
      BRANCH     a `name/like-this` token that looks like a branch must exist on
                 origin. Catches a branch renamed, merged and deleted.
      PATH       an absolute Windows path must exist on this machine. Catches
                 exactly the Ksid1 bug.
      MIGRATION  an `NNNN_name.sql` token must exist in the migrations folder.
      PR         a `#NNN` token must be a real PR (needs `gh`; skipped without).

    What it deliberately does NOT check, because it cannot without inventing an
    answer: whether a claim is still TRUE ("python on PATH is a broken stub",
    "42 worktrees"). Those need a live measurement, so they need a human or a
    reviewer to re-measure. Mark them in prose with the date they were measured
    and move on -- a wrong date is visible; a wrong fact is not.

    Placeholders are skipped: any token containing `...`, `<`, `>`, `NNNN` or
    `<topic>` is an example, not a claim.

    A line containing `docs-check:ignore` is skipped entirely. This is needed,
    not a convenience: a Cloudflare Worker version id is 8 hex characters and is
    NOT a git sha, and the handoff deliberately quotes a sha that does not exist
    as the worked example of a false claim. Both are correct prose that this
    tool cannot tell from a mistake. Annotate the line and say why in the same
    breath -- an unexplained ignore is how a linter dies.

    Exit 0 clean, 1 findings, 2 could not run.
#>

[CmdletBinding()]
param(
    [string] $Repo = 'C:/javis',
    [string[]] $Files,
    [switch] $SkipPaths
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Stop-Loudly {
    param([Parameter(Mandatory)][string] $Message)
    Write-Output "DOCS-CHECK ABORTED: $Message"
    exit 2
}

if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { Stop-Loudly "repo '$Repo' does not exist." }
$Repo = (Resolve-Path -LiteralPath $Repo).Path

$git = (Get-Command git -ErrorAction SilentlyContinue)?.Source
if (-not $git) { Stop-Loudly 'git must be on PATH.' }
$gh = (Get-Command gh -ErrorAction SilentlyContinue)?.Source

# A placeholder is not a claim. `C:/.../spec.json` and `codex/<topic>` are
# instructions to the reader, and failing them would train people to ignore this
# tool -- which is worse than not having it.
function Test-Placeholder {
    param([Parameter(Mandatory)][AllowEmptyString()][string] $Token)
    return $Token -match '\.\.\.|<|>|NNNN|\$\{|%[A-Za-z]+%'
}

if (-not $Files -or $Files.Count -eq 0) {
    $Files = @('docs/HANDOFF.md', 'AGENTS.md', 'TESTING.md', 'KNOWN_ISSUES.md', 'docs/BUILDING.md', 'docs/ARCHITECTURE.md')
}

$branchList = @((& $git -C $Repo ls-remote --heads origin 2>$null) |
    ForEach-Object { ($_ -split "`t")[-1] -replace '^refs/heads/', '' })
$migrationDir = Join-Path $Repo 'apps/cloud-gateway/src/persistence/migrations'
$migrations = @()
if (Test-Path -LiteralPath $migrationDir) {
    $migrations = @(Get-ChildItem -LiteralPath $migrationDir -Filter '*.sql' | Select-Object -ExpandProperty Name)
}

$findings = New-Object System.Collections.Generic.List[object]
$checked = 0

function Add-Finding {
    param([string] $File, [int] $Line, [string] $Kind, [string] $Token, [string] $Why)
    $findings.Add([pscustomobject]@{ File = $File; Line = $Line; Kind = $Kind; Token = $Token; Why = $Why })
}

foreach ($relative in $Files) {
    $path = Join-Path $Repo $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-Finding -File $relative -Line 0 -Kind 'FILE' -Token $relative -Why 'listed for checking but does not exist'
        continue
    }
    $lines = Get-Content -LiteralPath $path
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $number = $i + 1
        if ($line -match 'docs-check:ignore') { continue }

        # SHA. Word-bounded hex of 7-40. Excludes anything with a non-hex
        # neighbour so ULIDs and hashes inside longer tokens are left alone.
        foreach ($m in [regex]::Matches($line, '(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])')) {
            $sha = $m.Value
            # A run of only digits is a number, not a sha.
            if ($sha -match '^[0-9]+$') { continue }
            $checked++
            & $git -C $Repo cat-file -e "$sha^{commit}" 2>$null
            if ($LASTEXITCODE -ne 0) {
                Add-Finding -File $relative -Line $number -Kind 'SHA' -Token $sha -Why 'does not resolve to a commit in this repository'
            }
        }

        # BRANCH. Only the two prefixes this project actually uses, so a path
        # like `src/autonomy/tool-gate.ts` is not mistaken for a branch.
        foreach ($m in [regex]::Matches($line, '(?<![\w/.-])(claude|codex)/[A-Za-z0-9._-]+')) {
            $branch = $m.Value
            if (Test-Placeholder -Token $branch) { continue }
            $checked++
            if ($branchList -notcontains $branch) {
                Add-Finding -File $relative -Line $number -Kind 'BRANCH' -Token $branch -Why 'not a branch on origin (merged and deleted, renamed, or never pushed)'
            }
        }

        # PATH. Absolute Windows paths only. This is the check that would have
        # caught the Ksid1 profile.
        if (-not $SkipPaths) {
            foreach ($m in [regex]::Matches($line, '(?<![\w])[A-Za-z]:[\\/][^\s`''"|)]+')) {
                $candidate = $m.Value.TrimEnd('.', ',', ';', ':', ')', '*', '_')
                if (Test-Placeholder -Token $candidate) { continue }
                $checked++
                if (-not (Test-Path -LiteralPath $candidate)) {
                    Add-Finding -File $relative -Line $number -Kind 'PATH' -Token $candidate -Why 'does not exist on this machine'
                }
            }
        }

        # MIGRATION.
        foreach ($m in [regex]::Matches($line, '(?<![\w])[0-9]{4}_[a-z0-9_]+\.sql')) {
            $name = $m.Value
            $checked++
            if ($migrations -notcontains $name) {
                Add-Finding -File $relative -Line $number -Kind 'MIGRATION' -Token $name -Why 'no such file in the migrations folder'
            }
        }

        # PR. Only with gh, and only the number's existence -- not whether the
        # surrounding sentence describes its state correctly. That needs a
        # reader.
        if ($gh) {
            foreach ($m in [regex]::Matches($line, '(?<![\w])#([0-9]{1,4})(?![\w])')) {
                $pr = $m.Groups[1].Value
                $checked++
                $null = & $gh pr view $pr --repo (& $git -C $Repo remote get-url origin) --json number 2>$null
                if ($LASTEXITCODE -ne 0) {
                    Add-Finding -File $relative -Line $number -Kind 'PR' -Token "#$pr" -Why 'not a pull request in this repository'
                }
            }
        }
    }
}

Write-Output ''
Write-Output '===== DOCS CHECK ====='
Write-Output ("repo: {0}" -f $Repo)
Write-Output ("files: {0}" -f ($Files -join ', '))
Write-Output ("claims checked: {0}" -f $checked)
if ($findings.Count -eq 0) {
    Write-Output 'every checkable claim resolved.'
}
else {
    Write-Output ("findings: {0}" -f $findings.Count)
    Write-Output ''
    foreach ($f in $findings) {
        Write-Output ("{0}:{1}  [{2}]  {3}" -f $f.File, $f.Line, $f.Kind, $f.Token)
        Write-Output ("    {0}" -f $f.Why)
    }
}
Write-Output ''
Write-Output 'NOT CHECKED, and it cannot be: whether a still-true claim is still true.'
Write-Output '"python on PATH is a broken stub" and "42 worktrees" are measurements,'
Write-Output 'not references. Date them in the prose so staleness is visible.'
Write-Output '======================'

if ($findings.Count -gt 0) { exit 1 }
exit 0
