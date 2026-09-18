# Neuter each new guard, run the test that names it, confirm failure, restore, confirm pass.
# Prints one line per guard: "<name>: mutant=<PASS|FAIL|UNKNOWN> restored=<PASS|FAIL|UNKNOWN>".
$ErrorActionPreference = "Continue"
# Defaults to the worktree this script is checked out in, so it runs anywhere.
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "vitest.workspace.ts"))) {
  throw "not a Jarvis worktree: $root has no vitest.workspace.ts"
}
Set-Location $root
# Set-Location does not move the process's own working directory, and .NET file
# APIs resolve against that, not against PowerShell's location. Without this,
# ReadAllText on a relative path returns nothing and every patch is skipped.
[System.IO.Directory]::SetCurrentDirectory($root)

function Run-Tests([string[]]$files, [string]$nameFilter) {
  $arguments = @("vitest", "--config", "vitest.workspace.ts", "run") + $files + @("--reporter=dot")
  if ($nameFilter) { $arguments += @("-t", $nameFilter) }
  $out = (& npx @arguments 2>&1 | Out-String)
  $exit = $LASTEXITCODE
  $counts = [regex]::Matches($out, "(?m)^\s*Tests\s+(.+)$")
  $summary = if ($counts.Count -gt 0) { $counts[$counts.Count - 1].Groups[1].Value.Trim() } else { "no-summary" }
  Write-Output ("    [" + $summary + "] exit=" + $exit)
  if ($exit -eq 0) { return "PASS" }
  if ($out -match "Failed Tests" -or $out -match "\d+ failed") { return "FAIL" }
  return "UNKNOWN"
}

$mutants = @(
  @{ name = "A handler: every message labelled verified"
     file = "apps/cloud-gateway/src/school/d2l-email-handler.ts"
     from = 'const authenticity: EmailAuthenticity = evidence.trusted ? "verified" : "unverified";'
     to   = 'const authenticity: EmailAuthenticity = "verified";'
     files = @("apps/cloud-gateway/test/school/d2l-email-handler.test.ts")
     filter = "reads a message from a forged From domain" },
  @{ name = "B handler: discard the body of unpinned mail again"
     file = "apps/cloud-gateway/src/school/d2l-email-handler.ts"
     from = 'const RAW_WITHHELD_REASONS = new Set(["recipient_mismatch"]);'
     to   = 'const RAW_WITHHELD_REASONS = new Set(["recipient_mismatch", "from_missing", "from_domain_unpinned", "authentication_unproven"]);'
     files = @("apps/cloud-gateway/test/school/d2l-email-handler.test.ts")
     filter = "retains and reads back the body of a message from an unpinned sender" },
  @{ name = "C handler: unverified senders no longer quarantined"
     file = "apps/cloud-gateway/src/school/d2l-email-handler.ts"
     from = 'else if (authenticity === "unverified") quarantineReason = "authentication_unproven";'
     to   = 'else if (authenticity === "unverified") quarantineReason = null;'
     files = @("apps/cloud-gateway/test/school/d2l-email-handler.test.ts")
     filter = "sends one notice for a run of unproven senders" },
  @{ name = "D repository: raw bodies never pruned by age"
     file = "apps/cloud-gateway/src/school/d2l-email-repository.ts"
     from = '.bind(principalId, currentEmailId, cutoff, principalId, MAXIMUM_RETAINED_RAW_RECEIPTS)'
     to   = '.bind(principalId, currentEmailId, "1970-01-01T00:00:00.000Z", principalId, MAXIMUM_RETAINED_RAW_RECEIPTS)'
     files = @("apps/cloud-gateway/test/school/d2l-email-handler.test.ts")
     filter = "keeps every receipt under a flood" },
  @{ name = "E repository: provenance lookup always empty"
     file = "apps/cloud-gateway/src/school/d2l-email-repository.ts"
     from = 'if (externalIds.length === 0) return new Map();'
     to   = 'if (externalIds.length >= 0) return new Map();'
     files = @("apps/cloud-gateway/test/school/d2l-email-authenticity-read.test.ts")
     filter = "answers unverified for a deadline whose only receipt was unproven" },
  @{ name = "F composer: deadline provenance label dropped"
     file = "apps/cloud-gateway/src/digest/digest-composer.ts"
     from = '      const provenance = deadline.emailAuthenticity === undefined'
     to   = '      const provenance = true'
     files = @("apps/cloud-gateway/test/digest/digest-composer.test.ts")
     filter = "marks a deadline read out of unverified mail" },
  @{ name = "G composer: grade provenance label dropped"
     file = "apps/cloud-gateway/src/digest/digest-composer.ts"
     from = '? `reported by D2L email (${grade.authenticity})`'
     to   = '? "reported by D2L email"'
     files = @("apps/cloud-gateway/test/digest/digest-composer.test.ts")
     filter = "marks a grade read out of unverified mail" },
  @{ name = "H digest job: mail provenance never wired into the composer"
     file = "apps/cloud-gateway/src/jobs/digest-job.ts"
     from = '      ? { emailAuthenticity: emailAuthenticity.get(deadline.externalId) }'
     to   = '      ? {}'
     files = @("apps/cloud-gateway/test/jobs/digest-job.test.ts")
     filter = "labels a deadline the school-mail source produced" },
  @{ name = "K migration: a cleared body may be refilled"
     file = "apps/cloud-gateway/src/persistence/migrations/0036_email_read_everything.sql"
     from = "      OLD.raw_mime_base64 <> ''`r`n      AND NEW.raw_mime_base64 = ''"
     to   = "      1 = 1"
     files = @("apps/cloud-gateway/test/persistence/email-read-everything-migration.test.ts")
     filter = "refuses refilling a cleared body" }
)

$results = @()
foreach ($m in $mutants) {
  Write-Output ("=== " + $m.name)
  $path = Join-Path $root $m.file
  $original = [System.IO.File]::ReadAllText($path)
  $needle = $m.from.Replace("`r`n", "`n")
  if (-not $original.Replace("`r`n", "`n").Contains($needle)) {
    $results += ($m.name + ": PATCH-NOT-APPLIED")
    Write-Output "    PATCH-NOT-APPLIED"
    continue
  }
  # Replace on the normalized text so a CRLF/LF difference cannot silently skip a patch.
  $normalized = $original.Replace("`r`n", "`n")
  $mutated = $normalized.Replace($needle, $m.to.Replace("`r`n", "`n"))
  [System.IO.File]::WriteAllText($path, $mutated)
  $mutantRun = Run-Tests $m.files $m.filter
  [System.IO.File]::WriteAllText($path, $original)
  $restoredRun = Run-Tests $m.files $m.filter
  $results += ($m.name + ": mutant=" + $mutantRun + " restored=" + $restoredRun)
}
Write-Output "=== SUMMARY ==="
$results | ForEach-Object { Write-Output $_ }
