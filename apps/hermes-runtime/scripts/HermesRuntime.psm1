Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LiteralRuntimeRoot {
  param([string]$RuntimeRoot)
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot) -or $RuntimeRoot.StartsWith('\\')) { throw 'RuntimeRoot must be a non-UNC literal local path.' }
  $full = [IO.Path]::GetFullPath($RuntimeRoot)
  if (-not [IO.Path]::IsPathFullyQualified($full) -or [IO.Path]::GetPathRoot($full) -eq $full) { throw 'RuntimeRoot must be a bounded local child path.' }
  $cursor = $full
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RuntimeRoot must not traverse a reparse point.' }
    }
    $parentInfo = [IO.Directory]::GetParent($cursor)
    $parent = if ($null -eq $parentInfo) { '' } else { $parentInfo.FullName }
    if ($parent -eq $cursor -or [string]::IsNullOrEmpty($parent)) { break }
    $cursor = $parent
  }
  return $full
}

function Assert-ChildPath {
  param([string]$Root, [string]$Path)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved path escapes RuntimeRoot.' }
  return $pathFull
}

function Get-Sha256Hex {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ExactHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ((Get-Sha256Hex $Path) -ne $Expected) { throw "$Label hash mismatch." }
}

function Get-Manifest {
  param([string]$Path)
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -Depth 32
}

function Invoke-GitChecked {
  param([string]$Git, [string[]]$Arguments)
  $result = & $Git @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git command failed: $($result -join "`n")" }
  return @($result | ForEach-Object { $_.ToString().Trim() })
}

function Test-UnsafeArchiveMember {
  param([string]$Member)
  return [string]::IsNullOrWhiteSpace($Member) -or $Member.StartsWith('/') -or $Member.StartsWith('\\') -or $Member -match '(^|[\\/])\.\.([\\/]|$)' -or $Member -match '^[A-Za-z]:'
}

function Promote-StagedDirectory {
  param([string]$RuntimeRoot, [string]$StagedDirectory, [string]$FinalDirectory)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $staged = Assert-ChildPath $root $StagedDirectory
  $final = Assert-ChildPath $root $FinalDirectory
  if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw 'Verified staging directory is absent.' }
  if (Test-Path -LiteralPath $final) { throw 'Final target already exists; promotion refuses replacement.' }
  $parent = [IO.Directory]::GetParent($final).FullName
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  [void](Assert-LiteralRuntimeRoot $parent)
  Move-Item -LiteralPath $staged -Destination $final
  if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Atomic promotion did not create the final target.' }
}

Export-ModuleMember -Function Assert-LiteralRuntimeRoot, Assert-ChildPath, Get-Sha256Hex, Assert-ExactHash, Get-Manifest, Invoke-GitChecked, Test-UnsafeArchiveMember, Promote-StagedDirectory
