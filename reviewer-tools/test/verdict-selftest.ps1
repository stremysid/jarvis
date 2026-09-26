#Requires -Version 7.0
<#
    verdict-selftest.ps1 - prove the mutation job fails on a bad sweep.

    The audit's load-bearing finding: the step that turns SURVIVED / NOT
    APPLIED / INVALID into a failed job had never been shown to fire. This runs
    the real `reviewer-tools/mutation-verdict.ps1` over synthetic reports and
    asserts it exits 0 only for an all-KILLED report, and 1 for each bad verdict.

    It also proves the exit-code capture shape `.github/workflows/mutation.yml`
    uses: a native `pwsh -File` call whose output is redirected to a file, with
    `$LASTEXITCODE` read on the very next statement. The audit's finding was
    that piping through `Tee-Object` may leave that read at 0, so the run would
    report green while measuring nothing. The self-test runs a deliberately
    failing script through the same shape and asserts the non-zero code arrives,
    and asserts the workflow no longer pipes that call.

    Run directly, or from `ci.yml`'s `mutation-verdict-selftest` job:
        pwsh -NoProfile -File reviewer-tools/test/verdict-selftest.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$verdictScript = Join-Path $repoRoot 'reviewer-tools/mutation-verdict.ps1'
$workflowPath = Join-Path $repoRoot '.github/workflows/mutation.yml'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("mutation-verdict-selftest-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Report([string]$Name, [string[]]$Lines) {
    $path = Join-Path $temp "$Name.txt"
    Set-Content -LiteralPath $path -Value ($Lines -join "`n") -Encoding utf8NoBOM
    return $path
}

function Invoke-Verdict([string]$ReportPath, [int]$MutateExitCode) {
    & pwsh -NoProfile -File $verdictScript -ReportPath $ReportPath -MutateExitCode $MutateExitCode *> $null
    return $LASTEXITCODE
}

function Assert-Verdict([string]$Case, [string]$ReportPath, [int]$MutateExitCode, [int]$Expected) {
    $actual = Invoke-Verdict $ReportPath $MutateExitCode
    if ($actual -ne $Expected) {
        $failures.Add("$Case`: expected exit $Expected but the verdict script exited $actual")
    } else {
        Write-Output "ok   $Case -> $actual"
    }
}

$countsClean = 'killed 2 | killed-wrong-test 0 | unconfirmed 0 | survived 0 | not applied 0 | invalid 0'
$cleanRestore = 'restore verified: 1 file(s) byte-identical to backup'
$cleanRow = 'M1 a clean kill        KILLED         died'

function New-SummaryReport([string]$Row, [string]$Counts, [string]$Restore) {
    return @(
        'baseline: apps/cloud-gateway/test/example.test.ts'
        '===== MUTATION SUMMARY ====='
        'mutation               verdict        expected'
        $Row
        $Counts
        $Restore
        '============================'
    )
}

# The pass case: every mutation KILLED, exit 0.
Assert-Verdict 'all-KILLED passes' (Add-Report 'clean' (New-SummaryReport $cleanRow $countsClean $cleanRestore)) 0 0

# Every bad verdict fails, whatever the exit code says.
Assert-Verdict 'SURVIVED fails' (Add-Report 'survived' (New-SummaryReport `
    'M1 a survivor          SURVIVED       -' `
    'killed 0 | killed-wrong-test 0 | unconfirmed 0 | survived 1 | not applied 0 | invalid 0' $cleanRestore)) 1 1
Assert-Verdict 'NOT APPLIED fails' (Add-Report 'not-applied' (New-SummaryReport `
    'M1 text did not match   NOT APPLIED    died' `
    'killed 0 | killed-wrong-test 0 | unconfirmed 0 | survived 0 | not applied 1 | invalid 0' $cleanRestore)) 2 1
Assert-Verdict 'INVALID fails' (Add-Report 'invalid' (New-SummaryReport `
    'M1 runner could not say INVALID        died' `
    'killed 0 | killed-wrong-test 0 | unconfirmed 0 | survived 0 | not applied 0 | invalid 1' $cleanRestore)) 2 1
Assert-Verdict 'KILLED/OTHER fails' (Add-Report 'other' (New-SummaryReport `
    'M1 wrong test died      KILLED/OTHER   NO' `
    'killed 1 | killed-wrong-test 1 | unconfirmed 0 | survived 0 | not applied 0 | invalid 0' $cleanRestore)) 1 1
Assert-Verdict 'UNCONFIRMED fails' (Add-Report 'unconfirmed' (New-SummaryReport `
    'M1 died once           UNCONFIRMED    died' `
    'killed 1 | killed-wrong-test 0 | unconfirmed 1 | survived 0 | not applied 0 | invalid 0' $cleanRestore)) 1 1

# A report that cannot be parsed must fail, not degrade to a note.
Assert-Verdict 'missing summary block fails' (Add-Report 'no-block' @('baseline: nothing', 'some traffic')) 0 1
Assert-Verdict 'empty report fails' (Add-Report 'empty' @()) 0 1

# A clean-looking report must still fail when the exit code disagrees, and when
# the restore line says the tree was not restored.
Assert-Verdict 'non-zero exit fails even on a clean table' (Add-Report 'clean-exit1' (New-SummaryReport $cleanRow $countsClean $cleanRestore)) 1 1
Assert-Verdict 'unrestored tree fails' (Add-Report 'unrestored' (New-SummaryReport $cleanRow $countsClean 'restore verified: NO - SOME FILES DIFFER')) 2 1

# End-to-end: a real deliberately-surviving spec, through the real mutate.ps1,
# must produce a real SURVIVED report that the verdict step fails on. This is
# the whole job, not a synthetic summary.
$survivorSpec = Join-Path $repoRoot 'reviewer-tools/test-fixtures/mutation-spec-deliberate-survivor.json'
$mutateScript = Join-Path $repoRoot 'reviewer-tools/mutate.ps1'
if (-not (Test-Path -LiteralPath $survivorSpec) -or -not (Test-Path -LiteralPath $mutateScript)) {
    $failures.Add('the deliberate-survivor fixture or mutate.ps1 is missing')
} else {
    $e2eReport = Join-Path $temp 'e2e-report.txt'
    pwsh -NoProfile -File $mutateScript -Spec $survivorSpec -GateDir $repoRoot *> $e2eReport
    $e2eCode = $LASTEXITCODE
    if ($e2eCode -ne 1) {
        $failures.Add("the deliberate-survivor sweep exited $e2eCode, expected 1 (SURVIVED)")
    } else {
        Write-Output 'ok   deliberate-survivor sweep exited 1'
    }
    $e2eText = if (Test-Path -LiteralPath $e2eReport) { Get-Content -Raw -LiteralPath $e2eReport } else { '' }
    if ($e2eText -notmatch 'SURVIVED') {
        $failures.Add('the deliberate-survivor report does not contain SURVIVED')
    }
    $e2eVerdict = Invoke-Verdict $e2eReport $e2eCode
    if ($e2eVerdict -ne 1) {
        $failures.Add("the verdict step passed a real SURVIVED sweep (exit $e2eVerdict)")
    } else {
        Write-Output 'ok   verdict step fails the real SURVIVED report'
    }
}

# Prove the capture shape mutation.yml uses: redirect a native call to a file,
# read $LASTEXITCODE on the next statement, and see the failing code arrive.
$probeScript = Join-Path $temp 'exit-7.ps1'
Set-Content -LiteralPath $probeScript -Value 'exit 7' -Encoding utf8NoBOM
$probeReport = Join-Path $temp 'probe.txt'
pwsh -NoProfile -File $probeScript *> $probeReport
$probeCode = $LASTEXITCODE
if ($probeCode -ne 7) {
    $failures.Add("exit-code capture through a file redirect returned $probeCode, not 7")
} else {
    Write-Output 'ok   redirected native exit code -> 7'
}

# Lock the fix in the workflow itself: the call must not be piped, and the read
# must be the statement directly after the redirect to the report file.
if (Test-Path -LiteralPath $workflowPath) {
    $workflowText = Get-Content -Raw -LiteralPath $workflowPath
    if ($workflowText -match '\|\s*Tee-Object') {
        $failures.Add('mutation.yml still pipes the sweep through Tee-Object')
    }
    $lines = @(Get-Content -LiteralPath $workflowPath)
    $redirectIdx = ($lines | Select-String -Pattern '\*>\s*mutation-report\.txt' | Select-Object -First 1).LineNumber
    if (-not $redirectIdx) {
        $failures.Add('mutation.yml has no `*> mutation-report.txt` redirect')
    } elseif ($redirectIdx -ge $lines.Count -or $lines[$redirectIdx] -notmatch '\$code\s*=\s*\$LASTEXITCODE') {
        $failures.Add('mutation.yml does not read $LASTEXITCODE on the statement directly after the redirect')
    } else {
        Write-Output 'ok   mutation.yml captures the exit code without a pipeline'
    }
} else {
    $failures.Add("mutation.yml not found at $workflowPath")
}

Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue

if ($failures.Count -gt 0) {
    Write-Output ''
    foreach ($failure in $failures) { Write-Output "SELFTEST FAIL: $failure" }
    exit 1
}
Write-Output ''
Write-Output 'mutation verdict self-test passed: bad sweeps fail, clean sweeps pass.'
exit 0
