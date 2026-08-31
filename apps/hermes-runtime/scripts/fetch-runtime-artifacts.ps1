[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$root = Assert-LiteralRuntimeRoot $RuntimeRoot
$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lock = Get-Manifest (Join-Path $repoRoot 'runtime-artifacts-lock.json')
$allowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')

function Invoke-PinnedDownload {
  param([hashtable]$Artifact, [string]$Destination, [string]$Label)
  $uri = [Uri]$Artifact.url
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  try {
    for ($hop = 0; $hop -lt 4; $hop++) {
      if ($uri.Scheme -ne 'https' -or $uri.Host -notin $allowedHosts) { throw "$Label redirect is not an approved HTTPS host." }
      $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      if ([int]$response.StatusCode -in 301,302,303,307,308) {
        $location = $response.Headers.Location
        if ($null -eq $location) { throw "$Label redirect lacks Location." }
        $uri = [Uri]::new($uri, $location)
        $response.Dispose(); continue
      }
      if (-not $response.IsSuccessStatusCode) { throw "$Label download returned $($response.StatusCode)." }
      if ($response.Content.Headers.ContentLength -ne $null -and [int64]$response.Content.Headers.ContentLength -ne [int64]$Artifact.size) { throw "$Label content length drift." }
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

function Assert-NoUnsafeArchiveEntries {
  param([string]$Archive)
  $entries = & tar.exe -tf $Archive 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'CPython archive listing failed.' }
  foreach ($entry in $entries) { if (Test-UnsafeArchiveMember $entry) { throw 'CPython archive has an unsafe member.' } }
}

function Assert-Installed {
  param([hashtable]$Artifact, [string]$Path, [string]$Label)
  $raw = Join-Path $Path $Artifact.fileName
  if (-not (Test-Path -LiteralPath $raw -PathType Leaf)) { throw "$Label stored artifact is absent." }
  if ((Get-Item -LiteralPath $raw).Length -ne [int64]$Artifact.size) { throw "$Label stored artifact size drift." }
  Assert-ExactHash $raw $Artifact.sha256 $Label
}

$cpython = Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')
$uv = Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')
$winsw = Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')
$license = Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')
if ($VerifyOnly) {
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
  $rollup = Join-Path $license 'python-licenses.rst'; if (-not (Test-Path -LiteralPath $rollup)) { throw 'python-build-standalone license rollup is absent.' }; if ((Get-Item -LiteralPath $rollup).Length -ne [int64]$lock.pythonBuildStandaloneLicenses.size) { throw 'python-build-standalone license size drift.' }; Assert-ExactHash $rollup $lock.pythonBuildStandaloneLicenses.sha256 'python-build-standalone license rollup'
  if (-not (Test-Path -LiteralPath (Join-Path $cpython 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
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
  Assert-NoUnsafeArchiveEntries (Join-Path $downloads $lock.cpython.fileName)
  $pyStage = Join-Path $stage 'cpython'; New-Item -ItemType Directory -Path $pyStage | Out-Null; & tar.exe -xf (Join-Path $downloads $lock.cpython.fileName) -C $pyStage; if ($LASTEXITCODE -ne 0) { throw 'CPython archive extraction failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $pyStage 'python\LICENSE.txt') -PathType Leaf)) { throw 'CPython artifact LICENSE.txt is absent.' }
  $uvStage = Join-Path $stage 'uv'; Expand-Archive -LiteralPath (Join-Path $downloads $lock.uv.fileName) -DestinationPath $uvStage -Force
  $winStage = Join-Path $stage 'winsw'; New-Item -ItemType Directory -Path $winStage | Out-Null; Copy-Item -LiteralPath (Join-Path $downloads $lock.winsw.fileName) -Destination (Join-Path $winStage $lock.winsw.fileName)
  foreach ($pair in @(@($pyStage, $cpython), @($uvStage, $uv), @($winStage, $winsw))) { New-Item -ItemType Directory -Path $pair[1] | Out-Null; Move-Item -LiteralPath $pair[0] -Destination (Join-Path $pair[1] 'payload') }
  Copy-Item -LiteralPath (Join-Path $downloads $lock.cpython.fileName) -Destination (Join-Path $cpython $lock.cpython.fileName); Copy-Item -LiteralPath (Join-Path $downloads $lock.uv.fileName) -Destination (Join-Path $uv $lock.uv.fileName); Copy-Item -LiteralPath (Join-Path $downloads $lock.winsw.fileName) -Destination (Join-Path $winsw $lock.winsw.fileName)
  New-Item -ItemType Directory -Path $license | Out-Null; Move-Item -LiteralPath (Join-Path $downloads 'python-licenses.rst') -Destination (Join-Path $license 'python-licenses.rst')
  Assert-Installed $lock.cpython $cpython 'CPython'; Assert-Installed $lock.uv $uv 'uv'; Assert-Installed $lock.winsw $winsw 'WinSW'
} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue } }
