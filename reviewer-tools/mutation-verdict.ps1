#Requires -Version 7.0
<#
    mutation-verdict.ps1 - turn a mutation report into the job's pass/fail.

    `mutate.ps1`'s exit code is the machine-readable verdict (0 only for clean
    confirmed kills, 1 for SURVIVED / KILLED-OTHER / UNCONFIRMED, 2 for
    NOT APPLIED / INVALID / an unrestored tree). The workflow wraps that call
    with `continue-on-error` so the summary and artifact still publish. This is
    the one step that decides the job, and it fails closed:

      - a non-zero mutate.ps1 exit code fails;
      - any mutation whose verdict is not a confirmed KILLED fails;
      - a missing or unparseable summary block fails, so a drift in
        mutate.ps1's marker text is a failure rather than a silent note;
      - a restore line that does not say byte-identical fails.

    It exits 0 only for a report that shows every mutation KILLED and a clean
    restore. Run it against a synthetic report in the self-test
    (reviewer-tools/test/verdict-selftest.ps1) to prove the failure path.

    Usage:
        pwsh -NoProfile -File reviewer-tools/mutation-verdict.ps1 `
            -ReportPath mutation-report.txt -MutateExitCode 0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReportPath,
    [Parameter(Mandatory)][int]$MutateExitCode,
    # Defaults to the CI job summary when the runner provides one; tests leave
    # it unset so nothing is written outside their temp directory.
    [string]$SummaryPath = $env:GITHUB_STEP_SUMMARY
)

$failures = [System.Collections.Generic.List[string]]::new()

function Write-VerdictLine([string]$Value) {
    if ($SummaryPath) { Add-Content -LiteralPath $SummaryPath -Value $Value }
    Write-Output $Value
}

$lines = @()
if (-not (Test-Path -LiteralPath $ReportPath)) {
    $failures.Add("the report file was not created: $ReportPath")
} else {
    $lines = @(Get-Content -LiteralPath $ReportPath)
}

$startIdx = $null
$endIdx = $null
if ($lines.Count -gt 0) {
    $startIdx = ($lines | Select-String -Pattern '^===== MUTATION SUMMARY =====$' | Select-Object -First 1).LineNumber
    $endIdx = ($lines | Select-String -Pattern '^============================$' | Select-Object -First 1).LineNumber
}
if (-not $startIdx -or -not $endIdx -or $endIdx -le $startIdx) {
    $failures.Add('no mutation summary block was found, so the report cannot be trusted')
} else {
    # Select-String line numbers are 1-based; the block runs from the line after
    # the opening marker to the line before the closing one.
    $block = $lines[$startIdx..($endIdx - 2)]
    $rows = @()
    foreach ($line in $block) {
        if (-not $line.Trim()) { continue }
        if ($line -match '^\s') { continue }          # killed:/note:/edit: continuation lines
        if ($line -match '^mutation\s') { continue }   # header row
        if ($line -match '^killed \d') { continue }    # aggregate counts line
        $cols = [regex]::Split($line.Trim(), '\s{2,}')
        if ($cols.Count -lt 2) { continue }
        $rows += [pscustomobject]@{ Name = $cols[0]; Verdict = $cols[1] }
    }
    if ($rows.Count -eq 0) {
        $failures.Add('the summary block lists no mutations')
    } else {
        Write-VerdictLine '| mutation | verdict |'
        Write-VerdictLine '|---|---|'
        foreach ($row in $rows) {
            $name = $row.Name -replace '\|', '\|'
            $verdict = $row.Verdict -replace '\|', '\|'
            Write-VerdictLine "| $name | $verdict |"
            if ($row.Verdict -ne 'KILLED') { $failures.Add("$($row.Name): $($row.Verdict)") }
        }
    }
    # The aggregate and restore lines are the parser's anchors: if either shape
    # changes, this fails instead of quietly reading a subset.
    if (-not ($lines | Select-String -Pattern '^killed \d+ \| killed-wrong-test \d+ \| unconfirmed \d+ \| survived \d+ \| not applied \d+ \| invalid \d+$' | Select-Object -First 1)) {
        $failures.Add('the aggregate count line is missing or changed shape')
    }
    if (-not ($lines | Select-String -Pattern '^restore verified: \d+ file\(s\) byte-identical to backup$' | Select-Object -First 1)) {
        $failures.Add('the restore line is missing or does not say byte-identical')
    }
}

if ($MutateExitCode -ne 0) {
    $failures.Add("mutate.ps1 exited $MutateExitCode")
}

if ($failures.Count -gt 0) {
    Write-VerdictLine ''
    Write-VerdictLine '**FAIL: the mutation sweep did not confirm clean kills.**'
    foreach ($failure in $failures) { Write-VerdictLine "- $failure" }
    exit 1
}
Write-VerdictLine ''
Write-VerdictLine '**PASS: every mutation KILLED and the tree was restored.**'
exit 0
