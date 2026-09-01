[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly,
  [string]$TestEffectLog = '',
  [string]$TestOperationFixture = '',
  [ValidateRange(0,10000)][int]$TestHoldLockMilliseconds = 0,
  [ValidateSet('', 'before-first-download', 'after-cpython-extraction', 'before-raw-copies', 'before-installed-payload-scratch-write', 'before-installed-payload-scratch-copy', 'before-promotion-1', 'before-promotion-2', 'before-promotion-3', 'before-promotion-4', 'before-recovery-1', 'before-recovery-2', 'before-recovery-3', 'before-recovery-4', 'during-promotion-1-parent-window', 'during-promotion-2-parent-window', 'during-promotion-3-parent-window', 'during-promotion-4-parent-window', 'during-recovery-1-parent-window', 'during-recovery-2-parent-window', 'during-recovery-3-parent-window', 'during-recovery-4-parent-window', 'during-promotion-rollback-1-parent-window', 'during-promotion-rollback-2-parent-window', 'during-promotion-rollback-3-parent-window', 'during-promotion-rollback-4-parent-window')][string]$TestPauseAfterEffect = '',
  [string]$TestEffectAck = '',
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
$lock = Get-Manifest $lockPath 'c82f94702c037a0890b8f155cf70a81efb7e82fd213c6cba597cc1ea8a90d2d7' 'Runtime artifact lock'
Assert-HermesArtifactLock $lock
$root = Assert-HermesExactRuntimeRoot $RuntimeRoot
$allowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')
$testOperations = $null
if ([string]::IsNullOrEmpty($TestOperationFixture) -and (-not [string]::IsNullOrEmpty($TestEffectLog) -or -not [string]::IsNullOrEmpty($TestPauseAfterEffect) -or -not [string]::IsNullOrEmpty($TestEffectAck) -or -not [string]::IsNullOrEmpty($FailAfterEffect) -or -not [string]::IsNullOrEmpty($TestCrashAfterEffect) -or $TestFaultAfterPromotion -ne 0 -or $TestCrashAfterPromotion -ne 0 -or $TestHoldLockMilliseconds -ne 0)) { throw 'Test hooks require a closed operation fixture.' }
if (-not [string]::IsNullOrEmpty($TestOperationFixture)) {
  $fixturePath = Assert-ChildPath $root $TestOperationFixture
  if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw 'Test operation fixture is absent.' }
  $testOperations = Get-Manifest $fixturePath
  $fixtureKeys = @($testOperations.Keys | Sort-Object)
  $artifactFixtureScenarios = @('success', 'manifest-drift', 'torn-ready', 'http-off-host', 'http-content-length-drift', 'body-hash-drift', 'archive-case-collision', 'archive-ancestor-forward', 'archive-ancestor-reverse', 'archive-separator-collision', 'archive-extract-reparse', 'stage-hardlink', 'stage-ads', 'filesystem-stage-fault', 'verify-cleanup-fault', 'license-stage-drift', 'license-postmove-drift')
  if (($fixtureKeys -join ',') -ne 'scenario,schemaVersion,workflow' -or $testOperations.schemaVersion -ne 1 -or $testOperations.workflow -ne 'runtime-artifacts' -or $testOperations.scenario -notin $artifactFixtureScenarios) { throw 'Test operation fixture is not a closed runtime-artifact fixture.' }
  [void](Assert-HermesTestFixtureRoot $root)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [void](Assert-ChildPath $root $TestEffectLog) }
  if (-not [string]::IsNullOrEmpty($TestPauseAfterEffect)) {
    if ([string]::IsNullOrEmpty($TestEffectLog) -or [string]::IsNullOrEmpty($TestEffectAck)) { throw 'A deterministic test pause requires exact effect-log and acknowledgement paths.' }
    [void](Assert-ChildPath $root $TestEffectAck)
    if (Test-Path -LiteralPath $TestEffectAck) { throw 'Deterministic test acknowledgement path must start absent.' }
  } elseif (-not [string]::IsNullOrEmpty($TestEffectAck)) { throw 'A deterministic test acknowledgement is invalid without a selected pause boundary.' }
  if ($testOperations.scenario -eq 'manifest-drift') { $driftedLock = @{} + $lock; $driftedLock.schemaVersion = '0'; Assert-HermesArtifactLock $driftedLock }
}

function Invoke-WorkflowEffect {
  param([string]$Name)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [IO.File]::AppendAllText($TestEffectLog, ($Name + "`n"), [Text.UTF8Encoding]::new($false)) }
  if ($TestPauseAfterEffect -eq $Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $TestEffectAck -PathType Leaf)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for deterministic test acknowledgement: $Name" }
      Start-Sleep -Milliseconds 20
    }
    $ackGuard = Open-HermesSafeIdentity $TestEffectAck
    try { $ackBytes = [IO.File]::ReadAllBytes($TestEffectAck) } finally { $ackGuard.Dispose() }
    try { $ackText = [Text.UTF8Encoding]::new($false, $true).GetString($ackBytes) } catch { throw 'Deterministic test acknowledgement must be canonical UTF-8.' }
    if ($ackText -cne "continue`n") { throw 'Deterministic test acknowledgement has invalid content.' }
  }
  if ($TestCrashAfterEffect -eq $Name) { throw "Injected workflow crash: $Name" }
  if ($FailAfterEffect -eq $Name) { throw "Injected workflow failure: $Name" }
}

function Invoke-TestPauseBoundary {
  param([string]$Name)
  if ($TestPauseAfterEffect -eq $Name) { Invoke-WorkflowEffect $Name }
}

function Invoke-PinnedHttpTransfer {
  param(
    [hashtable]$Artifact,
    [Uri]$InitialUri,
    [Net.Http.HttpClient]$Client,
    [scriptblock]$OpenOutput,
    [string]$Label,
    [Threading.CancellationToken]$CancellationToken
  )
  $uri = $InitialUri
  for ($hop = 0; $hop -lt 4; $hop++) {
    $response = $null
    $input = $null
    $output = $null
    try {
      $response = $Client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $CancellationToken).GetAwaiter().GetResult()
      if ([int]$response.StatusCode -in 301,302,303,307,308) {
        $location = $response.Headers.Location
        $uri = Assert-ArtifactHttpHop $Artifact $uri ([int]$response.StatusCode) $(if ($null -eq $location) { $null } else { [Uri]::new($uri, $location) }) $null
        continue
      }
      [void](Assert-ArtifactHttpHop $Artifact $uri ([int]$response.StatusCode) $null $response.Content.Headers.ContentLength)
      $input = $response.Content.ReadAsStreamAsync($CancellationToken).GetAwaiter().GetResult()
      $output = & $OpenOutput
      if ($null -eq $output -or $output -isnot [IO.Stream] -or -not $output.CanWrite) { throw 'Artifact output stream is unavailable.' }
      $buffer = [byte[]]::new(131072)
      [int64]$total = 0
      while (($read = $input.ReadAsync($buffer, 0, $buffer.Length, $CancellationToken).GetAwaiter().GetResult()) -gt 0) {
        $total += $read
        if ($total -gt [int64]$Artifact.size) { throw "$Label exceeds its pinned size." }
        [void]($output.WriteAsync($buffer, 0, $read, $CancellationToken).GetAwaiter().GetResult())
      }
      [void]($output.FlushAsync($CancellationToken).GetAwaiter().GetResult())
      return [int64]$total
    } finally {
      if ($null -ne $output) { $output.Dispose() }
      if ($null -ne $input) { $input.Dispose() }
      if ($null -ne $response) { $response.Dispose() }
    }
  }
  throw "$Label exceeded redirect limit."
}

function Invoke-PinnedDownload {
  param([hashtable]$Artifact, [string]$Destination, [string]$Label, [pscustomobject]$LeaseContext)
  if ($null -ne $testOperations) {
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'http-off-host') { [void](Assert-ArtifactHttpHop $Artifact ([Uri]$Artifact.url) 302 ([Uri]'https://example.invalid/hostile') $null) }
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'http-content-length-drift') { [void](Assert-ArtifactHttpHop $Artifact ([Uri]$Artifact.url) 200 $null ([int64]$Artifact.size + 1)) }
    $fixtureRoot = Join-Path ([IO.Directory]::GetParent($Destination).FullName) ('.fixture-' + [guid]::NewGuid().ToString('N'))
    try {
      [void](New-HermesLeasedDirectory $LeaseContext $fixtureRoot -FreshLeaf)
      switch ($Label) {
        'CPython' {
          $temporaryArchive = Join-Path $fixtureRoot 'cpython.tar'
          $archiveStream = Open-HermesContainedFileCreateNew $LeaseContext $temporaryArchive
          $writer = [System.Formats.Tar.TarWriter]::new($archiveStream, $true)
          try {
            foreach ($entry in ([ordered]@{ 'python/LICENSE.txt' = 'synthetic-cpython-license'; 'python/python.exe' = 'synthetic-cpython-payload' }).GetEnumerator()) {
              $bytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$entry.Value)
              $payload = [IO.MemoryStream]::new($bytes, $false)
              $tarEntry = [System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::RegularFile, [string]$entry.Key)
              $tarEntry.DataStream = $payload
              try { $writer.WriteEntry($tarEntry) } finally { $payload.Dispose() }
            }
          } finally { $writer.Dispose(); $archiveStream.Flush($true); $archiveStream.Dispose() }
          Move-HermesContainedFileNoReplace $LeaseContext $temporaryArchive $Destination
        }
        'uv' {
          $temporaryArchive = Join-Path $fixtureRoot 'uv.zip'
          $archiveStream = Open-HermesContainedFileCreateNew $LeaseContext $temporaryArchive
          $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Create, $true)
          try {
            foreach ($name in @('uv.exe','uvw.exe','uvx.exe')) {
              $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::NoCompression)
              $entryStream = $entry.Open()
              try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes('synthetic-' + $name); $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
            }
          } finally { $zip.Dispose(); $archiveStream.Flush($true); $archiveStream.Dispose() }
          Move-HermesContainedFileNoReplace $LeaseContext $temporaryArchive $Destination
        }
        'WinSW' {
          $bytes = [byte[]]::new(128); $bytes[0] = 0x4d; $bytes[1] = 0x5a
          [BitConverter]::GetBytes([int32]64).CopyTo($bytes, 0x3c)
          $bytes[64] = 0x50; $bytes[65] = 0x45; $bytes[68] = 0x64; $bytes[69] = 0x86
          Write-HermesContainedBytesCreateNew $LeaseContext $Destination $bytes
        }
        'python-build-standalone license rollup' { Write-HermesContainedTextCreateNew $LeaseContext $Destination 'synthetic-license-rollup' }
        default { throw 'Synthetic download label is not closed.' }
      }
    } finally { if (Test-Path -LiteralPath $fixtureRoot) { Remove-HermesContainedTreeNoFollow $LeaseContext $fixtureRoot } }
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf) -or (Get-Item -LiteralPath $Destination).Length -lt 1) { throw "$Label synthetic body is absent." }
    if ($Label -eq 'CPython' -and $testOperations.scenario -eq 'body-hash-drift') { throw 'CPython synthetic body hash mismatch.' }
    return
  }
  $uri = [Uri]$Artifact.url
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $deadline = [Threading.CancellationTokenSource]::new()
  try {
    $deadline.CancelAfter([TimeSpan]::FromMinutes(10))
    $outputFactory = { Open-HermesContainedFileCreateNew $LeaseContext $Destination }.GetNewClosure()
    try {
      $total = Invoke-PinnedHttpTransfer $Artifact $uri $client $outputFactory $Label $deadline.Token
    } catch {
      if ($deadline.IsCancellationRequested) { throw "$Label download deadline exceeded." }
      throw
    }
    if ($total -ne [int64]$Artifact.size) { throw "$Label byte count drift." }
    Assert-ExactHash $Destination $Artifact.sha256 $Label
  } finally { $deadline.Dispose(); $client.Dispose(); $handler.Dispose() }
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
  param([hashtable]$ArtifactLock, [string]$LicensePath, [pscustomobject]$LeaseContext = $null)
  Assert-NoReparseTree $LicensePath 'python-build-standalone license directory' $LeaseContext
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
  param([string]$Path, [string]$Label, [pscustomobject]$LeaseContext = $null)
  $pathFull = [IO.Path]::GetFullPath($Path); $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $identityRoot = if ($pathFull.StartsWith(($rootFull + '\'), [StringComparison]::OrdinalIgnoreCase)) { $root } else { $pathFull }
  Assert-HermesSafeTree $identityRoot $pathFull $Label $LeaseContext
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
  param([hashtable]$Artifact, [string]$Archive, [string]$StableRoot, [string]$Destination, [pscustomobject]$LeaseContext = $null)
  if ($null -ne $testOperations -and $testOperations.scenario -in @('archive-case-collision', 'archive-ancestor-forward', 'archive-ancestor-reverse', 'archive-separator-collision')) { Assert-WorkflowCpythonArchive $Archive }
  $integrity = @{}
  if ($null -eq $testOperations) { $integrity.ExpectedSha256 = [string]$Artifact.sha256; $integrity.ExpectedSize = [int64]$Artifact.size }
  Expand-HermesCpythonArchiveIdentityStable -Archive $Archive -StableRoot $StableRoot -Destination $Destination -LeaseContext $LeaseContext @integrity
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'archive-extract-reparse') {
    $target = Join-Path $Destination 'fixture-target'; New-Item -ItemType Directory -Path $target | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $Destination 'python\fixture-link') -Target $target | Out-Null
  }
  Assert-NoReparseTree $Destination 'CPython extracted tree' $LeaseContext
}

function Expand-WorkflowUvArchive {
  param([hashtable]$Artifact, [string]$Archive, [string]$StableRoot, [string]$Destination, [pscustomobject]$LeaseContext = $null)
  $integrity = @{}
  if ($null -eq $testOperations) { $integrity.ExpectedSha256 = [string]$Artifact.sha256; $integrity.ExpectedSize = [int64]$Artifact.size }
  Expand-HermesUvArchiveIdentityStable -Archive $Archive -StableRoot $StableRoot -Destination $Destination -LeaseContext $LeaseContext @integrity
}

function Assert-DirectoryTreeEqual {
  param([string]$Expected, [string]$Actual, [string]$Label, [pscustomobject]$LeaseContext = $null)
  Assert-HermesSafeTree $Expected $Expected $Label $LeaseContext
  Assert-HermesSafeTree $root $Actual $Label $LeaseContext
  $expectedFiles = @((Get-ChildItem -LiteralPath $Expected -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($Expected.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  $actualFiles = @((Get-ChildItem -LiteralPath $Actual -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($Actual.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  if (-not (Test-HermesOrdinalPathSetEqual $expectedFiles $actualFiles)) { throw "$Label path set drift." }
  $expectedDirectories = @((Get-ChildItem -LiteralPath $Expected -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($Expected.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  $actualDirectories = @((Get-ChildItem -LiteralPath $Actual -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($Actual.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  if (-not (Test-HermesOrdinalPathSetEqual $expectedDirectories $actualDirectories)) { throw "$Label directory set drift." }
  foreach ($relative in $expectedFiles) { $expectedPath = Join-Path $Expected $relative.Replace('/','\'); $actualPath = Join-Path $Actual $relative.Replace('/','\'); if ((Get-Item -LiteralPath $expectedPath).Length -ne (Get-Item -LiteralPath $actualPath).Length) { throw "$Label byte count drift." }; if ((Get-Sha256Hex $expectedPath) -ne (Get-Sha256Hex $actualPath)) { throw "$Label content drift." } }
}

function Assert-InstalledPayloads {
  param([string]$Root, [hashtable]$ArtifactLock, [string]$CpythonPath, [string]$UvPath, [string]$WinSwPath, [string]$LicensePath, [pscustomobject]$LeaseContext = $null, [scriptblock]$Boundary = $null)
  if ((Assert-HermesContainmentContext $LeaseContext) -cne (Assert-LiteralRuntimeRoot $Root)) { throw 'Installed-payload verification containment is bound to a different RuntimeRoot.' }
  foreach ($tree in @($CpythonPath, $UvPath, $WinSwPath, $LicensePath)) { [void](Add-HermesDirectoryTreeLeases $LeaseContext $tree) }
  [void](Assert-HermesExactDirectorySpelling $LeaseContext $CpythonPath 'CPython installed root')
  [void](Assert-HermesExactDirectorySpelling $LeaseContext $UvPath 'uv installed root')
  [void](Assert-HermesExactDirectorySpelling $LeaseContext $WinSwPath 'WinSW installed root')
  [void](Assert-HermesExactDirectorySpelling $LeaseContext $LicensePath 'python-build-standalone license root')
  Assert-LicenseRollup $ArtifactLock $LicensePath $LeaseContext
  $scratch = New-HermesContainedScratchDirectory $LeaseContext 'payload'
  $cleanupBlocker = $null
  try {
    $pyArchive = Join-Path $CpythonPath $ArtifactLock.cpython.fileName
    $pyExpected = Join-Path $scratch 'cpython'; [void](New-HermesLeasedDirectory $LeaseContext $pyExpected -FreshLeaf)
    if ($null -ne $Boundary) { & $Boundary 'before-installed-payload-scratch-write' }
    Expand-WorkflowCpythonArchive $ArtifactLock.cpython $pyArchive $scratch $pyExpected $LeaseContext
    if ($null -ne $Boundary) { & $Boundary 'before-installed-payload-scratch-copy' }
    Copy-HermesContainedFileCreateNew $LeaseContext $pyArchive (Join-Path $pyExpected $ArtifactLock.cpython.fileName)
    Assert-DirectoryTreeEqual $pyExpected $CpythonPath 'CPython installed tree' $LeaseContext
    $uvArchive = Join-Path $UvPath $ArtifactLock.uv.fileName
    $uvExpected = Join-Path $scratch 'uv'; [void](New-HermesLeasedDirectory $LeaseContext $uvExpected -FreshLeaf)
    $uvPayload = Join-Path $uvExpected 'payload'; [void](New-HermesLeasedDirectory $LeaseContext $uvPayload -FreshLeaf)
    Expand-WorkflowUvArchive $ArtifactLock.uv $uvArchive $scratch $uvPayload $LeaseContext
    Copy-HermesContainedFileCreateNew $LeaseContext $uvArchive (Join-Path $uvExpected $ArtifactLock.uv.fileName)
    Assert-DirectoryTreeEqual $uvExpected $UvPath 'uv installed tree' $LeaseContext
    $winswExpected = Join-Path $scratch 'winsw'; [void](New-HermesLeasedDirectory $LeaseContext $winswExpected -FreshLeaf)
    Copy-HermesContainedFileCreateNew $LeaseContext (Join-Path $WinSwPath $ArtifactLock.winsw.fileName) (Join-Path $winswExpected $ArtifactLock.winsw.fileName)
    $winswPayload = Join-Path $winswExpected 'payload'; [void](New-HermesLeasedDirectory $LeaseContext $winswPayload -FreshLeaf)
    Copy-HermesContainedFileCreateNew $LeaseContext (Join-Path $WinSwPath $ArtifactLock.winsw.fileName) (Join-Path $winswPayload $ArtifactLock.winsw.fileName)
    Assert-DirectoryTreeEqual $winswExpected $WinSwPath 'WinSW installed tree' $LeaseContext
    if ($null -ne $testOperations -and $testOperations.scenario -eq 'verify-cleanup-fault') {
      $held = Join-Path $scratch 'cleanup-held.tmp'; Write-HermesContainedTextCreateNew $LeaseContext $held 'held'; $cleanupBlocker = [IO.File]::Open($held, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    }
  } finally {
    $cleanupFailure = $null
    if (Test-Path -LiteralPath $scratch) { try { Remove-HermesContainedTreeNoFollow $LeaseContext $scratch } catch { $cleanupFailure = $_ } }
    if ($null -ne $cleanupBlocker) { $cleanupBlocker.Dispose() }
    if ($null -ne $cleanupFailure) {
      if (Test-Path -LiteralPath $scratch) { Remove-HermesContainedTreeNoFollow $LeaseContext $scratch }
      throw 'Contained VerifyOnly scratch cleanup failed closed.'
    }
    if (Test-Path -LiteralPath $scratch) { throw 'Contained VerifyOnly scratch residue remains.' }
  }
}

$cpython = Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')
$uv = Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')
$winsw = Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')
$license = Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')
$workflowLock = Enter-HermesWorkflowLock $root
$leaseContext = New-HermesWriteContainmentContext $root $workflowLock
try {
if ($TestHoldLockMilliseconds -gt 0) { Start-Sleep -Milliseconds $TestHoldLockMilliseconds }
if ($VerifyOnly) { Assert-NoHermesContainedScratchResidue $leaseContext } else { Clear-HermesContainedScratchResidue $leaseContext }
$journalRecord = Get-HermesPublicationJournalRecord $root
Assert-NoHermesWorkflowResidue $root $(if ($null -eq $journalRecord) { '' } else { [string]$journalRecord.commonStage })
if ($VerifyOnly) {
  Assert-HermesPublicationReady $root $leaseContext
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-LicenseRollup $lock $license $leaseContext
  if (-not (Test-Path -LiteralPath (Join-Path $cpython 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name }
  Invoke-WorkflowEffect 'verify-only-ready'
  Invoke-WorkflowEffect 'verify-only-complete'
  exit 0
}
Recover-StagedDirectories $root -LeaseContext $leaseContext -Boundary { param([string]$Name) Invoke-TestPauseBoundary $Name }
Assert-NoHermesWorkflowResidue $root
if (Test-Path -LiteralPath (Get-HermesPublicationReadyPath $root) -PathType Leaf) {
  Assert-HermesPublicationReady $root $leaseContext
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name }
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
  [void](New-HermesLeasedDirectory $leaseContext $stage -FreshLeaf)
  $downloads = Join-Path $stage 'downloads'; [void](New-HermesLeasedDirectory $leaseContext $downloads -FreshLeaf)
  Invoke-TestPauseBoundary 'before-first-download'
  foreach ($entry in @(@($lock.cpython, $cpython, 'CPython'), @($lock.uv, $uv, 'uv'), @($lock.winsw, $winsw, 'WinSW'))) { Invoke-WorkflowEffect ('download-' + $entry[2]); Invoke-PinnedDownload $entry[0] (Join-Path $downloads $entry[0].fileName) $entry[2] $leaseContext }
  $rollupArtifact = @{ url = $lock.pythonBuildStandaloneLicenses.url; size = $lock.pythonBuildStandaloneLicenses.size; sha256 = $lock.pythonBuildStandaloneLicenses.sha256 }
  Invoke-WorkflowEffect 'download-license'; Invoke-PinnedDownload $rollupArtifact (Join-Path $downloads 'python-licenses.rst') 'python-build-standalone license rollup' $leaseContext
  $pyStage = Join-Path $stage 'cpython'; [void](New-HermesLeasedDirectory $leaseContext $pyStage -FreshLeaf); Expand-WorkflowCpythonArchive $lock.cpython (Join-Path $downloads $lock.cpython.fileName) $stage $pyStage $leaseContext
  Invoke-TestPauseBoundary 'after-cpython-extraction'
  if (-not (Test-Path -LiteralPath (Join-Path $pyStage 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  $uvStage = Join-Path $stage 'uv'; [void](New-HermesLeasedDirectory $leaseContext $uvStage -FreshLeaf -MovableLeaf); Expand-WorkflowUvArchive $lock.uv (Join-Path $downloads $lock.uv.fileName) $stage $uvStage $leaseContext
  $winStage = Join-Path $stage 'winsw'; [void](New-HermesLeasedDirectory $leaseContext $winStage -FreshLeaf -MovableLeaf); Copy-HermesContainedFileCreateNew $leaseContext (Join-Path $downloads $lock.winsw.fileName) (Join-Path $winStage $lock.winsw.fileName)
  $promote = Join-Path $stage 'promote'; [void](New-HermesLeasedDirectory $leaseContext $promote -FreshLeaf)
  $stageCpython = Join-Path $promote 'cpython-3.11.16'; $stageUv = Join-Path $promote 'uv-0.12.7'; $stageWinsw = Join-Path $promote 'winsw-2.12.0'; $stageLicense = Join-Path $promote '20260825'
  foreach ($target in @($stageCpython, $stageUv, $stageWinsw, $stageLicense)) { [void](New-HermesLeasedDirectory $leaseContext $target -FreshLeaf -MovableLeaf) }
  Move-HermesLeasedDirectoryNoReplace $leaseContext (Join-Path $pyStage 'python') (Join-Path $stageCpython 'python')
  Move-HermesLeasedDirectoryNoReplace $leaseContext $uvStage (Join-Path $stageUv 'payload')
  Move-HermesLeasedDirectoryNoReplace $leaseContext $winStage (Join-Path $stageWinsw 'payload')
  Invoke-TestPauseBoundary 'before-raw-copies'
  Copy-HermesContainedFileCreateNew $leaseContext (Join-Path $downloads $lock.cpython.fileName) (Join-Path $stageCpython $lock.cpython.fileName)
  Copy-HermesContainedFileCreateNew $leaseContext (Join-Path $downloads $lock.uv.fileName) (Join-Path $stageUv $lock.uv.fileName)
  Copy-HermesContainedFileCreateNew $leaseContext (Join-Path $downloads $lock.winsw.fileName) (Join-Path $stageWinsw $lock.winsw.fileName)
  Move-HermesContainedFileNoReplace $leaseContext (Join-Path $downloads 'python-licenses.rst') (Join-Path $stageLicense 'python-licenses.rst')
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'license-stage-drift') { [IO.File]::WriteAllText((Join-Path $stageLicense 'python-licenses.rst'), 'drifted-at-stage', [Text.UTF8Encoding]::new($false)) }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'stage-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $stageCpython 'python\python-hardlink.exe') -Target (Join-Path $stageCpython 'python\python.exe') | Out-Null }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'stage-ads') { Set-Content -LiteralPath (Join-Path $stageCpython 'python\python.exe') -Stream hostile -Value 'hostile' -NoNewline }
  foreach ($verifiedTree in @($stageCpython, $stageUv, $stageWinsw, $stageLicense)) { Assert-NoReparseTree $verifiedTree 'Staged runtime artifact tree' }
  Assert-Installed $lock.cpython $stageCpython 'CPython'; Assert-Installed $lock.uv $stageUv 'uv'; Assert-Installed $lock.winsw $stageWinsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $stageWinsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $stageCpython $stageUv $stageWinsw $stageLicense $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name }
  Invoke-WorkflowEffect 'staged-full-tree-verified'
  $publicationStarted = $true
  Promote-StagedDirectories -RuntimeRoot $root -Promotions @(
    [pscustomobject]@{ StagedDirectory = $stageCpython; FinalDirectory = $cpython },
    [pscustomobject]@{ StagedDirectory = $stageUv; FinalDirectory = $uv },
    [pscustomobject]@{ StagedDirectory = $stageWinsw; FinalDirectory = $winsw },
    [pscustomobject]@{ StagedDirectory = $stageLicense; FinalDirectory = $license }
  ) -FaultAfterPromotion $TestFaultAfterPromotion -CrashAfterPromotion $TestCrashAfterPromotion -LeaseContext $leaseContext -Boundary {
    param([string]$Name)
    if ($Name.StartsWith('before-', [StringComparison]::Ordinal) -or $Name.StartsWith('during-', [StringComparison]::Ordinal)) { Invoke-TestPauseBoundary $Name } else { Invoke-WorkflowEffect $Name }
  }
  Invoke-WorkflowEffect 'all-moves-complete'
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'license-postmove-drift') { [IO.File]::WriteAllText((Join-Path $license 'python-licenses.rst'), 'drifted-after-promotion', [Text.UTF8Encoding]::new($false)) }
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  Assert-InstalledPayloads $root $lock $cpython $uv $winsw $license $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name }
  Invoke-WorkflowEffect 'postverify-complete'
  Complete-StagedDirectories $root -LeaseContext $leaseContext -Boundary {
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
  if ($original.Exception.Message -eq 'Injected publication crash.' -or $original.Exception.Message.StartsWith('Injected workflow crash:', [StringComparison]::Ordinal)) { $preserveStage = $true } elseif ($publicationStarted) { $preserveStage = $true; Recover-StagedDirectories $root -LeaseContext $leaseContext -Boundary { param([string]$Name) Invoke-TestPauseBoundary $Name }; $preserveStage = $false }
  throw $original
} finally { if (-not $preserveStage -and (Test-Path -LiteralPath $stage)) { Remove-HermesContainedTreeNoFollow $leaseContext $stage } }
} finally {
  try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() }
}
