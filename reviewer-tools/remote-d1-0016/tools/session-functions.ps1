$PSNativeCommandArgumentPassing = 'Standard'
$Db = 'jarvis-scratch-0016-proof'
$Cfg = Join-Path $Proof 'wrangler.scratch.toml'
$Wrangler = Join-Path $Src 'node_modules\wrangler\bin\wrangler.js'
$Receipts = Join-Path $Proof 'receipts'
New-Item -ItemType Directory -Force $Receipts | Out-Null

function Invoke-ProofWrangler {
  param([Parameter(Mandatory)][string]$Receipt, [Parameter(Mandatory)][string[]]$WranglerArgs)
  $output = & node $Wrangler @WranglerArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  $code = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $Receipts "$Receipt.txt") -Value "exit $code`n$output" -Encoding utf8
  [pscustomobject]@{ Code = $code; Output = $output }
}

function Get-ProofJson {
  param([Parameter(Mandatory)][string]$Output)
  $match = [regex]::Match($Output, '(?ms)^\[.*\]')
  if (-not $match.Success) { return $null }
  try { return @($match.Value | ConvertFrom-Json) } catch { return $null }
}

function Get-D1List {
  $output = & node $Wrangler d1 list --json 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'wrangler d1 list failed. Check that Wrangler is logged in.' }
  $list = Get-ProofJson $output
  if ($null -eq $list) { throw 'Unexpected output from wrangler d1 list.' }
  return $list
}

function Assert-ScratchTarget {
  $problems = [System.Collections.Generic.List[string]]::new()
  $gateway = Get-Content -Raw -LiteralPath (Join-Path $Src 'apps\cloud-gateway\wrangler.toml')
  $productionIds = @([regex]::Matches($gateway, 'database_id\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $productionNames = @([regex]::Matches($gateway, 'database_name\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  if ($productionIds.Count -eq 0) { $problems.Add('could not read the production database id from the gateway wrangler.toml') }
  $config = Get-Content -Raw -LiteralPath $Cfg
  $ids = @([regex]::Matches($config, 'database_id\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $names = @([regex]::Matches($config, 'database_name\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  if ($ids.Count -ne 1 -or $names.Count -ne 1) {
    $problems.Add('the scratch config must declare exactly one database')
  } else {
    if ($names[0] -ne $Db) { $problems.Add("the scratch config names '$($names[0])' instead of $Db") }
    if ($productionNames -contains $names[0]) { $problems.Add('the scratch config uses a production database name') }
    if ($productionIds -contains $ids[0]) { $problems.Add('THE SCRATCH CONFIG ID EQUALS A PRODUCTION DATABASE ID') }
    if ($ids[0] -eq 'SCRATCH_DATABASE_ID_NOT_SET') { $problems.Add('the scratch database id has not been filled in') }
  }
  if ($config -match '(?m)^\s*binding\s*=\s*"DB"') { $problems.Add('the scratch config uses the production binding name DB') }
  if ($problems.Count -eq 0 -and $Target -contains '--remote') {
    $live = @(Get-D1List | Where-Object { $_.name -eq $Db })
    if ($live.Count -ne 1) { $problems.Add("expected exactly one database named $Db, found $($live.Count)") }
    elseif ($live[0].uuid -ne $ids[0]) { $problems.Add("the scratch config id does not belong to the database named $Db") }
  }
  if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-Host "PREFLIGHT FAILED: $_" -ForegroundColor Red }
    throw 'Preflight failed. Stop here and tell the reviewer.'
  }
  Write-Host 'PREFLIGHT OK: the target is the scratch database, not production' -ForegroundColor Green
}

function Invoke-ProofSql {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Expect)
  $sql = Get-Content -Raw -LiteralPath (Join-Path $Proof "probes\$Name.sql")
  $run = Invoke-ProofWrangler -Receipt $Name -WranglerArgs (@('d1', 'execute', $Db) + $Target + @('--config', $Cfg, '--json', '--command', $sql))
  $passed = $false
  if ($Expect -eq 'success') { $passed = $run.Code -eq 0 -and $run.Output -notmatch '"success":\s*false' }
  elseif ($Expect -eq 'ok') { $passed = $run.Code -eq 0 -and $run.Output -match '"ok":\s*1\b' }
  elseif ($Expect.StartsWith('raise:')) { $passed = $run.Code -ne 0 -and $run.Output.Contains($Expect.Substring(6)) }
  elseif ($Expect.StartsWith('errregex:')) { $passed = $run.Code -ne 0 -and $run.Output -match $Expect.Substring(9) }
  elseif ($Expect.StartsWith('regex:')) { $passed = $run.Code -eq 0 -and $run.Output -match $Expect.Substring(6) }
  else { throw "unknown expectation $Expect" }
  $timing = ''
  $results = if ($run.Code -eq 0) { Get-ProofJson $run.Output } else { $null }
  if ($results) {
    $durations = @($results | ForEach-Object { $_.meta.duration } | Where-Object { $null -ne $_ })
    if ($durations.Count -gt 0) {
      $measure = $durations | Measure-Object -Maximum -Sum
      $timing = "  ($($durations.Count) statements, slowest $([math]::Round($measure.Maximum)) ms, total $([math]::Round($measure.Sum)) ms)"
    }
  }
  if ($passed) { Write-Host "PASS  $Name$timing" -ForegroundColor Green }
  else { Write-Host "FAIL  $Name  expected $Expect  (see receipts\$Name.txt)" -ForegroundColor Red }
  return [bool]$passed
}

function Invoke-ProofPlan {
  param([string[]]$Phase = @('main'))
  $plan = Get-Content -Raw -LiteralPath (Join-Path $Proof 'probes\plan.json') | ConvertFrom-Json
  foreach ($entry in $plan) {
    if ($Phase -notcontains $entry.phase) { continue }
    if (-not (Invoke-ProofSql -Name $entry.name -Expect $entry.expect)) {
      Write-Host "STOPPED at $($entry.name). Do not go on; tell the reviewer." -ForegroundColor Red
      return $false
    }
  }
  Write-Host 'ALL PROBES PASSED' -ForegroundColor Green
  return $true
}

function Get-ProofPending {
  param([Parameter(Mandatory)][string]$Receipt)
  $list = Invoke-ProofWrangler -Receipt $Receipt -WranglerArgs (@('d1', 'migrations', 'list', $Db) + $Target + @('--config', $Cfg))
  if ($list.Code -ne 0) { return $null }
  return ,@([regex]::Matches($list.Output, '\d{4}_[a-z0-9_]+\.sql') | ForEach-Object { $_.Value } | Sort-Object -Unique)
}

function Invoke-ProofMigrations {
  param([Parameter(Mandatory)][string]$Step, [Parameter(Mandatory)][string[]]$ExpectedPending)
  $want = (@($ExpectedPending | Sort-Object) -join ', ')
  $before = Get-ProofPending -Receipt "$Step-list-before"
  if ($null -eq $before -or ($before -join ', ') -ne $want) {
    Write-Host "FAIL  $Step  pending migrations are [$($before -join ', ')], expected [$want]" -ForegroundColor Red
    return $false
  }
  $apply = Invoke-ProofWrangler -Receipt "$Step-apply" -WranglerArgs (@('d1', 'migrations', 'apply', $Db) + $Target + @('--config', $Cfg))
  $after = Get-ProofPending -Receipt "$Step-list-after"
  if ($apply.Code -ne 0 -or $null -eq $after -or $after.Count -ne 0) {
    Write-Host "FAIL  $Step  apply exit $($apply.Code); still pending [$($after -join ', ')]  (see receipts\$Step-apply.txt)" -ForegroundColor Red
    return $false
  }
  Write-Host "PASS  $Step  applied [$want]; nothing left pending" -ForegroundColor Green
  return $true
}

function Test-ProofInventory {
  param([Parameter(Mandatory)][string]$Receipt, [Parameter(Mandatory)][string]$Expected)
  $sql = Get-Content -Raw -LiteralPath (Join-Path $Proof 'probes\00-inventory.sql')
  $run = Invoke-ProofWrangler -Receipt $Receipt -WranglerArgs (@('d1', 'execute', $Db) + $Target + @('--config', $Cfg, '--json', '--command', $sql))
  $results = if ($run.Code -eq 0) { Get-ProofJson $run.Output } else { $null }
  if (-not $results) {
    Write-Host "FAIL  $Receipt  inventory query failed  (see receipts\$Receipt.txt)" -ForegroundColor Red
    return $false
  }
  $actual = @($results[0].results)
  $expectedRows = @(Get-Content -Raw -LiteralPath (Join-Path $Proof "expected\$Expected") | ConvertFrom-Json)
  $actualKeys = @($actual | ForEach-Object { "$($_.type)|$($_.name)|$($_.tbl_name)" })
  $expectedKeys = @($expectedRows | ForEach-Object { "$($_.type)|$($_.name)|$($_.tbl_name)" })
  $missing = @($expectedKeys | Where-Object { $actualKeys -notcontains $_ })
  $unexpected = @($actualKeys | Where-Object { $expectedKeys -notcontains $_ })
  $lengths = @{}
  $expectedRows | ForEach-Object { $lengths["$($_.type)|$($_.name)"] = [int]$_.sql_len }
  $lengthDiffs = @($actual | Where-Object {
      $lengths.ContainsKey("$($_.type)|$($_.name)") -and $lengths["$($_.type)|$($_.name)"] -ne [int]$_.sql_len
    } | ForEach-Object { $_.name })
  $counts = ($actual | Group-Object type | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
  Write-Host "      $Receipt  $counts"
  $missing | ForEach-Object { Write-Host "      missing: $_" -ForegroundColor Red }
  $unexpected | ForEach-Object { Write-Host "      unexpected: $_" -ForegroundColor Red }
  if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) {
    Write-Host "FAIL  $Receipt  does not match expected\$Expected" -ForegroundColor Red
    return $false
  }
  if ($lengthDiffs.Count -gt 0) {
    Write-Host "NOTE  $Receipt  stored SQL length differs for: $($lengthDiffs -join ', ')  (not a stop; the reviewer checks it)" -ForegroundColor Yellow
  }
  Write-Host "PASS  $Receipt  matches expected\$Expected ($($actual.Count) objects)" -ForegroundColor Green
  return $true
}

function Save-RedactedReceipts {
  $redacted = Join-Path $Proof 'receipts-redacted'
  New-Item -ItemType Directory -Force $redacted | Out-Null
  $uuid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
  $hex32 = '(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])'
  $email = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  Get-ChildItem -LiteralPath $Receipts -Filter '*.txt' | ForEach-Object {
    $text = Get-Content -Raw -LiteralPath $_.FullName
    $text = $text -replace $uuid, '<uuid>' -replace $hex32, '<hex32>' -replace $email, '<email>'
    Set-Content -LiteralPath (Join-Path $redacted $_.Name) -Value $text -Encoding utf8
  }
  $leaks = @(Get-ChildItem -LiteralPath $redacted -Filter '*.txt' | Select-String -Pattern $uuid, $hex32, $email)
  if ($leaks.Count -gt 0) { throw "Redaction left $($leaks.Count) identifiers. Tell the reviewer." }
  Write-Host "REDACTED  $((Get-ChildItem -LiteralPath $redacted -Filter '*.txt').Count) receipts saved in $redacted" -ForegroundColor Green
}
