[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lockPath = Join-Path $repoRoot 'runtime-artifacts-lock.json'
Assert-ExactHash $lockPath '8b4cb370fe0a25f879c4bc44e27bbcc73bbc518a8b0543b8854c76acabc15673' 'Runtime artifact lock'
$lock = Get-Manifest $lockPath
Assert-HermesArtifactLock $lock
$root = Assert-LiteralRuntimeRoot $RuntimeRoot
$allowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')

function Invoke-PinnedDownload {
  param([hashtable]$Artifact, [string]$Destination, [string]$Label)
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
  if ((Get-Item -LiteralPath $raw).Length -ne [int64]$Artifact.size) { throw "$Label stored artifact size drift." }
  Assert-ExactHash $raw $Artifact.sha256 $Label
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

function Assert-DirectoryTreeEqual {
  param([string]$Expected, [string]$Actual, [string]$Label)
  foreach ($path in @($Expected, $Actual)) { if (@(Get-ChildItem -LiteralPath $path -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw "$Label contains a reparse point." } }
  $expectedFiles = @((Get-ChildItem -LiteralPath $Expected -File -Recurse | ForEach-Object { $_.FullName.Substring($Expected.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  $actualFiles = @((Get-ChildItem -LiteralPath $Actual -File -Recurse | ForEach-Object { $_.FullName.Substring($Actual.Length).TrimStart('\').Replace('\','/') }) | Sort-Object)
  if ($expectedFiles.Count -ne $actualFiles.Count -or (Compare-Object $expectedFiles $actualFiles)) { throw "$Label path set drift." }
  foreach ($relative in $expectedFiles) { $expectedPath = Join-Path $Expected $relative.Replace('/','\'); $actualPath = Join-Path $Actual $relative.Replace('/','\'); if ((Get-Item -LiteralPath $expectedPath).Length -ne (Get-Item -LiteralPath $actualPath).Length) { throw "$Label byte count drift." }; if ((Get-Sha256Hex $expectedPath) -ne (Get-Sha256Hex $actualPath)) { throw "$Label content drift." } }
}

function Assert-InstalledPayloads {
  param([string]$Root, [hashtable]$ArtifactLock, [string]$CpythonPath, [string]$UvPath)
  $scratch = Assert-ChildPath $Root (Join-Path $Root ('.verify-' + [guid]::NewGuid().ToString('N')))
  try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $pyArchive = Join-Path $CpythonPath $ArtifactLock.cpython.fileName; Assert-SafeCpythonArchive $pyArchive
    $pyExpected = Join-Path $scratch 'cpython'; New-Item -ItemType Directory -Path $pyExpected | Out-Null; & tar.exe -xf $pyArchive -C $pyExpected; if ($LASTEXITCODE -ne 0) { throw 'CPython verification extraction failed.' }
    Assert-DirectoryTreeEqual (Join-Path $pyExpected 'python') (Join-Path $CpythonPath 'python') 'CPython extracted payload'
    $uvArchive = Join-Path $UvPath $ArtifactLock.uv.fileName; Assert-SafeUvArchive $uvArchive
    $uvExpected = Join-Path $scratch 'uv'; Expand-Archive -LiteralPath $uvArchive -DestinationPath $uvExpected -Force
    Assert-DirectoryTreeEqual $uvExpected (Join-Path $UvPath 'payload') 'uv extracted payload'
  } finally { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue } }
}

$cpython = Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')
$uv = Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')
$winsw = Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')
$license = Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')
if ($VerifyOnly) {
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
  $rollup = Join-Path $license 'python-licenses.rst'; if (-not (Test-Path -LiteralPath $rollup)) { throw 'python-build-standalone license rollup is absent.' }; if ((Get-Item -LiteralPath $rollup).Length -ne [int64]$lock.pythonBuildStandaloneLicenses.size) { throw 'python-build-standalone license size drift.' }; Assert-ExactHash $rollup $lock.pythonBuildStandaloneLicenses.sha256 'python-build-standalone license rollup'
  if (-not (Test-Path -LiteralPath (Join-Path $cpython 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  Assert-InstalledPayloads $root $lock $cpython $uv
  exit 0
}
foreach ($target in @($cpython, $uv, $winsw, $license)) { if (Test-Path -LiteralPath $target) { throw 'Runtime artifact target already exists; acquisition refuses reuse.' } }
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
$stage = Assert-ChildPath $root (Join-Path $root ('.artifact-stage-' + [guid]::NewGuid().ToString('N')))
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  $downloads = Join-Path $stage 'downloads'; New-Item -ItemType Directory -Path $downloads | Out-Null
  foreach ($entry in @(@($lock.cpython, $cpython, 'CPython'), @($lock.uv, $uv, 'uv'), @($lock.winsw, $winsw, 'WinSW'))) { Invoke-PinnedDownload $entry[0] (Join-Path $downloads $entry[0].fileName) $entry[2] }
  $rollupArtifact = @{ url = $lock.pythonBuildStandaloneLicenses.url; size = $lock.pythonBuildStandaloneLicenses.size; sha256 = $lock.pythonBuildStandaloneLicenses.sha256 }
  Invoke-PinnedDownload $rollupArtifact (Join-Path $downloads 'python-licenses.rst') 'python-build-standalone license rollup'
  Assert-SafeCpythonArchive (Join-Path $downloads $lock.cpython.fileName)
  Assert-SafeUvArchive (Join-Path $downloads $lock.uv.fileName)
  $pyStage = Join-Path $stage 'cpython'; New-Item -ItemType Directory -Path $pyStage | Out-Null; & tar.exe -xf (Join-Path $downloads $lock.cpython.fileName) -C $pyStage; if ($LASTEXITCODE -ne 0) { throw 'CPython archive extraction failed.' }
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
  Assert-Installed $lock.cpython $stageCpython 'CPython'; Assert-Installed $lock.uv $stageUv 'uv'; Assert-Installed $lock.winsw $stageWinsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $stageWinsw $lock.winsw.fileName)
  Promote-StagedDirectories $root @(
    [pscustomobject]@{ StagedDirectory = $stageCpython; FinalDirectory = $cpython },
    [pscustomobject]@{ StagedDirectory = $stageUv; FinalDirectory = $uv },
    [pscustomobject]@{ StagedDirectory = $stageWinsw; FinalDirectory = $winsw },
    [pscustomobject]@{ StagedDirectory = $stageLicense; FinalDirectory = $license }
  )
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  Assert-WinSwAmd64 (Join-Path $winsw $lock.winsw.fileName)
} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue } }
