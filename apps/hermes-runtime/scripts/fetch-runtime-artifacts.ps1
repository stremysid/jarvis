[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly,
  [string]$TestEffectLog = '',
  [string]$TestOperationFixture = '',
  [ValidateRange(0,10000)][int]$TestHoldLockMilliseconds = 0,
  [ValidateSet('', 'validated-before-root-effect', 'filesystem-stage', 'download-CPython', 'download-uv', 'download-WinSW', 'download-license', 'staged-full-tree-verified', 'promotion-1', 'promotion-2', 'promotion-3', 'promotion-4', 'all-moves-complete', 'postverify-complete', 'marker-written', 'marker-validated', 'marker-complete')][string]$FailAfterEffect = '',
  [ValidateSet('', 'postverify-complete', 'marker-written', 'marker-validated')][string]$TestCrashAfterEffect = '',
  [ValidateRange(0,4)][int]$TestFaultAfterPromotion = 0,
  [ValidateRange(0,4)][int]$TestCrashAfterPromotion = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lockPath = Join-Path $repoRoot 'runtime-artifacts-lock.json'
Assert-ExactHash $lockPath 'c82f94702c037a0890b8f155cf70a81efb7e82fd213c6cba597cc1ea8a90d2d7' 'Runtime artifact lock'
$lock = Get-Manifest $lockPath
Assert-HermesArtifactLock $lock
$root = Assert-LiteralRuntimeRoot $RuntimeRoot
$allowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')
$testOperations = $null
if ([string]::IsNullOrEmpty($TestOperationFixture) -and (-not [string]::IsNullOrEmpty($TestEffectLog) -or -not [string]::IsNullOrEmpty($FailAfterEffect) -or -not [string]::IsNullOrEmpty($TestCrashAfterEffect) -or $TestFaultAfterPromotion -ne 0 -or $TestCrashAfterPromotion -ne 0 -or $TestHoldLockMilliseconds -ne 0)) { throw 'Test hooks require a closed operation fixture.' }
if (-not [string]::IsNullOrEmpty($TestOperationFixture)) {
  $fixturePath = Assert-ChildPath $root $TestOperationFixture
  if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw 'Test operation fixture is absent.' }
  $testOperations = Get-Manifest $fixturePath
  $fixtureKeys = @($testOperations.Keys | Sort-Object)
  $artifactFixtureScenarios = @('success', 'manifest-drift', 'torn-ready', 'http-off-host', 'http-content-length-drift', 'body-hash-drift', 'archive-case-collision', 'archive-ancestor-forward', 'archive-ancestor-reverse', 'archive-separator-collision', 'archive-extract-reparse', 'stage-hardlink', 'stage-ads', 'filesystem-stage-fault', 'verify-cleanup-fault', 'license-stage-drift', 'license-postmove-drift')
  if (($fixtureKeys -join ',') -ne 'scenario,schemaVersion,workflow' -or $testOperations.schemaVersion -ne 1 -or $testOperations.workflow -ne 'runtime-artifacts' -or $testOperations.scenario -notin $artifactFixtureScenarios) { throw 'Test operation fixture is not a closed runtime-artifact fixture.' }
  [void](Assert-HermesTestFixtureRoot $root)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [void](Assert-ChildPath $root $TestEffectLog) }
  if ($testOperations.scenario -eq 'manifest-drift') { $driftedLock = @{} + $lock; $driftedLock.schemaVersion = '0'; Assert-HermesArtifactLock $driftedLock }
}

function Invoke-WorkflowEffect {
  param([string]$Name)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [IO.File]::AppendAllText($TestEffectLog, ($Name + "`n"), [Text.UTF8Encoding]::new($false)) }
  if ($TestCrashAfterEffect -eq $Name) { throw "Injected workflow crash: $Name" }
  if ($FailAfterEffect -eq $Name) { throw "Injected workflow failure: $Name" }
}

function Invoke-PinnedDownload {
  param([hashtable]$Artifact, [string]$Destination, [string]$Label)
  if ($null -ne $testOperations) {
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'http-off-host') { [void](Assert-ArtifactHttpHop $Artifact ([Uri]$Artifact.url) 302 ([Uri]'https://example.invalid/hostile') $null) }
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'http-content-length-drift') { [void](Assert-ArtifactHttpHop $Artifact ([Uri]$Artifact.url) 200 $null ([int64]$Artifact.size + 1)) }
    $fixtureRoot = Join-Path ([IO.Directory]::GetParent($Destination).FullName) ('.fixture-' + [guid]::NewGuid().ToString('N'))
    try {
      New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
      switch ($Label) {
        'CPython' {
          $python = Join-Path $fixtureRoot 'python'; New-Item -ItemType Directory -Path $python | Out-Null
          [IO.File]::WriteAllText((Join-Path $python 'LICENSE.txt'), 'synthetic-cpython-license', [Text.UTF8Encoding]::new($false))
          [IO.File]::WriteAllText((Join-Path $python 'python.exe'), 'synthetic-cpython-payload', [Text.UTF8Encoding]::new($false))
          & tar.exe -cf $Destination -C $fixtureRoot python
          if ($LASTEXITCODE -ne 0) { throw 'Synthetic CPython archive creation failed.' }
        }
        'uv' {
          Add-Type -AssemblyName System.IO.Compression.FileSystem
          foreach ($name in @('uv.exe','uvw.exe','uvx.exe')) { [IO.File]::WriteAllText((Join-Path $fixtureRoot $name), ('synthetic-' + $name), [Text.UTF8Encoding]::new($false)) }
          [IO.Compression.ZipFile]::CreateFromDirectory($fixtureRoot, $Destination, [IO.Compression.CompressionLevel]::NoCompression, $false)
        }
        'WinSW' {
          $bytes = [byte[]]::new(128); $bytes[0] = 0x4d; $bytes[1] = 0x5a
          [BitConverter]::GetBytes([int32]64).CopyTo($bytes, 0x3c)
          $bytes[64] = 0x50; $bytes[65] = 0x45; $bytes[68] = 0x64; $bytes[69] = 0x86
          [IO.File]::WriteAllBytes($Destination, $bytes)
        }
        'python-build-standalone license rollup' { [IO.File]::WriteAllText($Destination, 'synthetic-license-rollup', [Text.UTF8Encoding]::new($false)) }
        default { throw 'Synthetic download label is not closed.' }
      }
    } finally { if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue } }
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf) -or (Get-Item -LiteralPath $Destination).Length -lt 1) { throw "$Label synthetic body is absent." }
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'body-hash-drift') { throw 'CPython synthetic body hash mismatch.' }
    return
  }
  $uri = [Uri]$Artifact.url
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  try {
    for ($hop = 0; $hop -lt 4; $hop++) {
      $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      if ([int]$response.StatusCode -in 301,302,303,307,308) {
        $location = $response.Headers.Location
        $uri = Assert-ArtifactHttpHop $Artifact $uri ([int]$response.StatusCode) $(if ($null -eq $location) { $null } else { [Uri]::new($uri, $location) }) $null
        $response.Dispose(); continue
      }
      [void](Assert-ArtifactHttpHop $Artifact $uri ([int]$response.StatusCode) $null $response.Content.Headers.ContentLength)
      $input = $response.Content.ReadAsStream(); $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = [byte[]]::new(131072); [int64]$total = 0
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $read; if ($total -gt [int64]$Artifact.size) { throw "$Label exceeds its pinned size." }; $output.Write($buffer, 0, $read)
        }
      } finally { $output.Dispose(); $input.Dispose(); $response.Dispose() }
      if ($total -ne [int64]$Artifact.size) { throw "$Label byte count drift." }
      Assert-ExactHash $Destination $Artifact.sha256 $Label
      return
    }
    throw "$Label exceeded redirect limit."
  } finally { $client.Dispose(); $handler.Dispose() }
}

function Assert-Installed {
  param([hashtable]$Artifact, [string]$Path, [string]$Label)
  $raw = Join-Path $Path $Artifact.fileName
  if (-not (Test-Path -LiteralPath $raw -PathType Leaf)) { throw "$Label stored artifact is absent." }
  if ($null -ne $testOperations) { if ((Get-Item -LiteralPath $raw).Length -lt 1) { throw "$Label stored synthetic artifact is empty." }; return }
  if ((Get-Item -LiteralPath $raw).Length -ne [int64]$Artifact.size) { throw "$Label stored artifact size drift." }
  Assert-ExactHash $raw $Artifact.sha256 $Label
}

function Assert-LicenseRollup {
  param([hashtable]$ArtifactLock, [string]$LicensePath)
  Assert-NoReparseTree $LicensePath 'python-build-standalone license directory'
  $files = @(Get-ChildItem -LiteralPath $LicensePath -Force -File -Recurse)
  if ($files.Count -ne 1 -or $files[0].FullName -cne (Join-Path $LicensePath 'python-licenses.rst')) { throw 'python-build-standalone license rollup path set drift.' }
  if ($null -ne $testOperations) {
    if ($files[0].Length -ne 24) { throw 'Synthetic python-build-standalone license rollup size drift.' }
    Assert-ExactHash $files[0].FullName '76c57fee441d9fbb53edb414da4e46d47c9518bac930127df9629bd42d887099' 'Synthetic python-build-standalone license rollup'
  } else {
    if ($files[0].Length -ne [int64]$ArtifactLock.pythonBuildStandaloneLicenses.size) { throw 'python-build-standalone license size drift.' }
    Assert-ExactHash $files[0].FullName $ArtifactLock.pythonBuildStandaloneLicenses.sha256 'python-build-standalone license rollup'
  }
}

function Assert-WinSwAmd64 {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $header = [byte[]]::new(64)
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or $header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'WinSW must be a PE image.' }
    $offset = [BitConverter]::ToInt32($header, 0x3c)
    if ($offset -lt 64 -or $offset -gt 1048576) { throw 'WinSW PE header offset is invalid.' }
    $stream.Position = $offset
    $coff = [byte[]]::new(6)
    if ($stream.Read($coff, 0, $coff.Length) -ne $coff.Length -or $coff[0] -ne 0x50 -or $coff[1] -ne 0x45 -or [BitConverter]::ToUInt16($coff, 4) -ne 0x8664) { throw 'WinSW must be AMD64 PE.' }
  } finally { $stream.Dispose() }
}

function Assert-NoReparseTree {
  param([string]$Path, [string]$Label)
  $pathFull = [IO.Path]::GetFullPath($Path); $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $identityRoot = if ($pathFull.StartsWith(($rootFull + '\'), [StringComparison]::OrdinalIgnoreCase)) { $root } else { $pathFull }
  Assert-HermesSafeTree $identityRoot $pathFull $Label
}

function Assert-WorkflowCpythonArchive {
  param([string]$Archive)
  if ($null -ne $testOperations) {
    $members = switch ($testOperations.scenario) {
      'archive-case-collision' { @([pscustomobject]@{ Name = 'python/Foo'; Type = '-' }, [pscustomobject]@{ Name = 'python/foo'; Type = '-' }) }
      'archive-ancestor-forward' { @([pscustomobject]@{ Name = 'python/conf'; Type = '-' }, [pscustomobject]@{ Name = 'python/conf/settings'; Type = '-' }) }
      'archive-ancestor-reverse' { @([pscustomobject]@{ Name = 'python/conf/settings'; Type = '-' }, [pscustomobject]@{ Name = 'python/conf'; Type = '-' }) }
      'archive-separator-collision' { @([pscustomobject]@{ Name = 'python/conf/settings'; Type = '-' }, [pscustomobject]@{ Name = 'python\conf\settings'; Type = '-' }) }
      default { $null }
    }
    if ($null -ne $members) { Assert-SafeCpythonMembers $members; return }
  }
  Assert-SafeCpythonArchive $Archive
}

function Expand-WorkflowCpythonArchive {
  param([string]$Archive, [string]$Destination, [string]$FailureLabel)
  & tar.exe -xf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { throw $FailureLabel }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'archive-extract-reparse') {
    $target = Join-Path $Destination 'fixture-target'; New-Item -ItemType Directory -Path $target | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $Destination 'python\fixture-link') -Target $target | Out-Null
  }
  Assert-NoReparseTree $Destination 'CPython extracted tree'
}

function Assert-DirectoryTreeEqual {
  param([string]$Expected, [string]$Actual, [string]$Label)
  Assert-HermesSafeTree $Expected $Expected $Label
  Assert-HermesSafeTree $root $Actual $Label
  $expectedFiles = @((Get-ChildItem -LiteralPath $Expected -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($Expected.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  $actualFiles = @((Get-ChildItem -LiteralPath $Actual -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($Actual.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  if ($expectedFiles.Count -ne $actualFiles.Count -or (Compare-Object $expectedFiles $actualFiles)) { throw "$Label path set drift." }
  $expectedDirectories = @((Get-ChildItem -LiteralPath $Expected -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($Expected.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  $actualDirectories = @((Get-ChildItem -LiteralPath $Actual -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($Actual.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  if ($expectedDirectories.Count -ne $actualDirectories.Count -or (Compare-Object $expectedDirectories $actualDirectories)) { throw "$Label directory set drift." }
  foreach ($relative in $expectedFiles) { $expectedPath = Join-Path $Expected $relative.Replace('/','\'); $actualPath = Join-Path $Actual $relative.Replace('/','\'); if ((Get-Item -LiteralPath $expectedPath).Length -ne (Get-Item -LiteralPath $actualPath).Length) { throw "$Label byte count drift." }; if ((Get-Sha256Hex $expectedPath) -ne (Get-Sha256Hex $actualPath)) { throw "$Label content drift." } }
}

function Assert-InstalledPayloads {
  param([string]$Root, [hashtable]$ArtifactLock, [string]$CpythonPath, [string]$UvPath, [string]$WinSwPath, [string]$LicensePath)
  Assert-LicenseRollup $ArtifactLock $LicensePath
  $scratch = Join-Path ([IO.Path]::GetTempPath()) ('jarvis-hermes-verify-' + [guid]::NewGuid().ToString('N'))
  [void](Assert-LiteralRuntimeRoot $scratch)
  if ([IO.Path]::GetFullPath($scratch).StartsWith(([IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'VerifyOnly scratch must be external to RuntimeRoot.' }
  $cleanupBlocker = $null
  try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $pyArchive = Join-Path $CpythonPath $ArtifactLock.cpython.fileName; Assert-WorkflowCpythonArchive $pyArchive
    $pyExpected = Join-Path $scratch 'cpython'; New-Item -ItemType Directory -Path $pyExpected | Out-Null; Expand-WorkflowCpythonArchive $pyArchive $pyExpected 'CPython verification extraction failed.'; Copy-Item -LiteralPath $pyArchive -Destination (Join-Path $pyExpected $ArtifactLock.cpython.fileName)
    Assert-DirectoryTreeEqual $pyExpected $CpythonPath 'CPython installed tree'
    $uvArchive = Join-Path $UvPath $ArtifactLock.uv.fileName; Assert-SafeUvArchive $uvArchive
    $uvExpected = Join-Path $scratch 'uv'; New-Item -ItemType Directory -Path $uvExpected | Out-Null; $uvPayload = Join-Path $uvExpected 'payload'; Expand-Archive -LiteralPath $uvArchive -DestinationPath $uvPayload -Force; Copy-Item -LiteralPath $uvArchive -Destination (Join-Path $uvExpected $ArtifactLock.uv.fileName)
    Assert-DirectoryTreeEqual $uvExpected $UvPath 'uv installed tree'
    $winswExpected = Join-Path $scratch 'winsw'; New-Item -ItemType Directory -Path $winswExpected | Out-Null; Copy-Item -LiteralPath (Join-Path $WinSwPath $ArtifactLock.winsw.fileName) -Destination (Join-Path $winswExpected $ArtifactLock.winsw.fileName); New-Item -ItemType Directory -Path (Join-Path $winswExpected 'payload') | Out-Null; Copy-Item -LiteralPath (Join-Path $WinSwPath $ArtifactLock.winsw.fileName) -Destination (Join-Path $winswExpected ('payload\' + $ArtifactLock.winsw.fileName)); Assert-DirectoryTreeEqual $winswExpected $WinSwPath 'WinSW installed tree'
    if ($null -ne $testOperations -and $testOperations.scenario -eq 'verify-cleanup-fault') {
      $held = Join-Path $scratch 'cleanup-held.tmp'; [IO.File]::WriteAllText($held, 'held', [Text.UTF8Encoding]::new($false)); $cleanupBlocker = [IO.File]::Open($held, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    }
  } finally {
    $cleanupFailure = $null
    if (Test-Path -LiteralPath $scratch) { try { Remove-Item -LiteralPath $scratch -Recurse -Force } catch { $cleanupFailure = $_ } }
    if ($null -ne $cleanupBlocker) { $cleanupBlocker.Dispose() }
    if ($null -ne $cleanupFailure) {
      if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
      throw 'External VerifyOnly scratch cleanup failed closed.'
    }
    if (Test-Path -LiteralPath $scratch) { throw 'External VerifyOnly scratch residue remains.' }
  }
}

$cpython = Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')
$uv = Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')
$winsw = Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')
$license = Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
$workflowLock = Enter-HermesWorkflowLock $root
try {
if ($TestHoldLockMilliseconds -gt 0) { Start-Sleep -Milliseconds $TestHoldLockMilliseconds }
$journalRecord = Get-HermesPublicationJournalRecord $root
Assert-NoHermesWorkflowResidue $root $(if ($null -eq $journalRecord) { '' } else { [string]$journalRecord.commonStage })
if ($VerifyOnly) {
  Assert-HermesPublicationReady $root
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-LicenseRollup $lock $license
  if (-not (Test-Path -LiteralPath (Join-Path $cpython 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license
  Invoke-WorkflowEffect 'verify-only-ready'
  Invoke-WorkflowEffect 'verify-only-complete'
  exit 0
}
Recover-StagedDirectories $root
Assert-NoHermesWorkflowResidue $root
if (Test-Path -LiteralPath (Get-HermesPublicationReadyPath $root) -PathType Leaf) {
  Assert-HermesPublicationReady $root
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license
  exit 0
}
foreach ($target in @($cpython, $uv, $winsw, $license)) { if (Test-Path -LiteralPath $target) { throw 'Runtime artifact target already exists; acquisition refuses reuse.' } }
Invoke-WorkflowEffect 'validated-before-root-effect'
$stage = Assert-ChildPath $root (Join-Path $root ('.artifact-stage-' + [guid]::NewGuid().ToString('N')))
$publicationStarted = $false
$preserveStage = $false
try {
  Invoke-WorkflowEffect 'filesystem-stage'
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'filesystem-stage-fault') { throw 'Injected filesystem fault before staging creation.' }
  New-Item -ItemType Directory -Path $stage | Out-Null
  $downloads = Join-Path $stage 'downloads'; New-Item -ItemType Directory -Path $downloads | Out-Null
  foreach ($entry in @(@($lock.cpython, $cpython, 'CPython'), @($lock.uv, $uv, 'uv'), @($lock.winsw, $winsw, 'WinSW'))) { Invoke-WorkflowEffect ('download-' + $entry[2]); Invoke-PinnedDownload $entry[0] (Join-Path $downloads $entry[0].fileName) $entry[2] }
  $rollupArtifact = @{ url = $lock.pythonBuildStandaloneLicenses.url; size = $lock.pythonBuildStandaloneLicenses.size; sha256 = $lock.pythonBuildStandaloneLicenses.sha256 }
  Invoke-WorkflowEffect 'download-license'; Invoke-PinnedDownload $rollupArtifact (Join-Path $downloads 'python-licenses.rst') 'python-build-standalone license rollup'
  Assert-WorkflowCpythonArchive (Join-Path $downloads $lock.cpython.fileName)
  Assert-SafeUvArchive (Join-Path $downloads $lock.uv.fileName)
  $pyStage = Join-Path $stage 'cpython'; New-Item -ItemType Directory -Path $pyStage | Out-Null; Expand-WorkflowCpythonArchive (Join-Path $downloads $lock.cpython.fileName) $pyStage 'CPython archive extraction failed.'
  if (-not (Test-Path -LiteralPath (Join-Path $pyStage 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  $uvStage = Join-Path $stage 'uv'; Expand-Archive -LiteralPath (Join-Path $downloads $lock.uv.fileName) -DestinationPath $uvStage -Force
  $winStage = Join-Path $stage 'winsw'; New-Item -ItemType Directory -Path $winStage | Out-Null; Copy-Item -LiteralPath (Join-Path $downloads $lock.winsw.fileName) -Destination (Join-Path $winStage $lock.winsw.fileName)
  $promote = Join-Path $stage 'promote'; New-Item -ItemType Directory -Path $promote | Out-Null
  $stageCpython = Join-Path $promote 'cpython-3.11.16'; $stageUv = Join-Path $promote 'uv-0.12.7'; $stageWinsw = Join-Path $promote 'winsw-2.12.0'; $stageLicense = Join-Path $promote '20260825'
  foreach ($target in @($stageCpython, $stageUv, $stageWinsw, $stageLicense)) { New-Item -ItemType Directory -Path $target | Out-Null }
  Move-Item -LiteralPath (Join-Path $pyStage 'python') -Destination (Join-Path $stageCpython 'python')
  Move-Item -LiteralPath $uvStage -Destination (Join-Path $stageUv 'payload')
  Move-Item -LiteralPath $winStage -Destination (Join-Path $stageWinsw 'payload')
  Copy-Item -LiteralPath (Join-Path $downloads $lock.cpython.fileName) -Destination (Join-Path $stageCpython $lock.cpython.fileName); Copy-Item -LiteralPath (Join-Path $downloads $lock.uv.fileName) -Destination (Join-Path $stageUv $lock.uv.fileName); Copy-Item -LiteralPath (Join-Path $downloads $lock.winsw.fileName) -Destination (Join-Path $stageWinsw $lock.winsw.fileName)
  Move-Item -LiteralPath (Join-Path $downloads 'python-licenses.rst') -Destination (Join-Path $stageLicense 'python-licenses.rst')
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'license-stage-drift') { [IO.File]::WriteAllText((Join-Path $stageLicense 'python-licenses.rst'), 'drifted-at-stage', [Text.UTF8Encoding]::new($false)) }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'stage-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $stageCpython 'python\python-hardlink.exe') -Target (Join-Path $stageCpython 'python\python.exe') | Out-Null }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'stage-ads') { Set-Content -LiteralPath (Join-Path $stageCpython 'python\python.exe') -Stream hostile -Value 'hostile' -NoNewline }
  foreach ($verifiedTree in @($stageCpython, $stageUv, $stageWinsw, $stageLicense)) { Assert-NoReparseTree $verifiedTree 'Staged runtime artifact tree' }
  Assert-Installed $lock.cpython $stageCpython 'CPython'; Assert-Installed $lock.uv $stageUv 'uv'; Assert-Installed $lock.winsw $stageWinsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $stageWinsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $stageCpython $stageUv $stageWinsw $stageLicense
  Invoke-WorkflowEffect 'staged-full-tree-verified'
  $publicationStarted = $true
  Promote-StagedDirectories $root @(
    [pscustomobject]@{ StagedDirectory = $stageCpython; FinalDirectory = $cpython },
    [pscustomobject]@{ StagedDirectory = $stageUv; FinalDirectory = $uv },
    [pscustomobject]@{ StagedDirectory = $stageWinsw; FinalDirectory = $winsw },
    [pscustomobject]@{ StagedDirectory = $stageLicense; FinalDirectory = $license }
  ) $TestFaultAfterPromotion $TestCrashAfterPromotion { param([string]$Name) Invoke-WorkflowEffect $Name }
  Invoke-WorkflowEffect 'all-moves-complete'
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'license-postmove-drift') { [IO.File]::WriteAllText((Join-Path $license 'python-licenses.rst'), 'drifted-after-promotion', [Text.UTF8Encoding]::new($false)) }
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license
  Invoke-WorkflowEffect 'postverify-complete'
  Complete-StagedDirectories $root {
    param([string]$Name)
    Invoke-WorkflowEffect $Name
    if ($null -ne $testOperations -and $testOperations.scenario -eq 'torn-ready' -and $Name -eq 'marker-written') {
      [IO.File]::WriteAllText((Get-HermesPublicationReadyPath $root), '{', [Text.UTF8Encoding]::new($false))
      throw 'Injected workflow crash: torn-ready'
    }
  }
  Invoke-WorkflowEffect 'marker-complete'
} catch {
  $original = $_
  if ($original.Exception.Message -eq 'Injected publication crash.' -or $original.Exception.Message.StartsWith('Injected workflow crash:', [StringComparison]::Ordinal)) { $preserveStage = $true } elseif ($publicationStarted) { $preserveStage = $true; Recover-StagedDirectories $root; $preserveStage = $false }
  throw $original
} finally { if (-not $preserveStage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Force -Recurse; if (Test-Path -LiteralPath $stage) { throw 'Runtime artifact staging cleanup failed.' } } }
} finally {
  $workflowLock.Dispose()
}
