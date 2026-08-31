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

function Get-HermesGitIsolationOptions {
  return @('-c','core.hooksPath=NUL','-c','core.autocrlf=false','-c','core.safecrlf=true','-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','-c','credential.helper=')
}

function Assert-HermesGitTranscript {
  param([hashtable]$Lock, [string]$GitDirectory, [string]$WorkTree, [scriptblock]$InvokeGit)
  $call = { param([string[]]$Arguments) @(& $InvokeGit $Arguments) }
  $tag = "refs/tags/{0}" -f $Lock.tag
  if ((& $call @('--git-dir', $GitDirectory, 'cat-file', '-t', $tag)) -ne 'tag') { throw 'Pinned tag is not annotated.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tag}}" -f $tag))) -ne $Lock.tagObject) { throw 'Pinned tag object mismatch.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{}}" -f $tag))) -ne $Lock.sourceCommit) { throw 'Pinned tag was retargeted.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit))) -ne $Lock.sourceTree) { throw 'Pinned source tree mismatch.' }
  $remotes = @(& $call @('--git-dir', $GitDirectory, 'remote')); if ($remotes.Count -ne 1 -or $remotes[0] -ne 'origin') { throw 'Unexpected Git remote.' }
  $tree = @(& $call @('--git-dir', $GitDirectory, 'ls-tree', '-r', $Lock.sourceCommit)); if ($tree | Where-Object { $_ -match '^160000 ' }) { throw 'Pinned source contains a gitlink.' }; if ($tree | Where-Object { $_ -match ' .gitmodules$' }) { throw 'Pinned source contains submodule metadata.' }
  $status = @(& $call @('-c', 'core.longpaths=true', '--git-dir', $GitDirectory, '--work-tree', $WorkTree, 'status', '--porcelain')); if ($status.Count -ne 0) { throw "Pinned checkout is dirty or untracked: $($status -join ';')" }
}

function Assert-HermesSourceDirectory {
  param([string]$RuntimeRoot, [string]$Candidate, [hashtable]$Lock)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $source = Assert-ChildPath $root $Candidate
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Pinned Hermes source is absent.' }
  if (Test-Path -LiteralPath (Join-Path $source '.git')) { throw 'Pinned source must be a detached export without a worktree repository.' }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { $path = Assert-ChildPath $root (Join-Path $source $name); if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Pinned source file is absent: $name" }; Assert-ExactHash $path $Lock.rawFileSha256[$name] "Pinned source $name" }
  if (@(Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
}

function Assert-ArtifactHttpHop {
  param([hashtable]$Artifact, [Uri]$RequestUri, [int]$StatusCode, [Uri]$Location, [Nullable[int64]]$ContentLength)
  $allowed = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')
  if ($RequestUri.Scheme -ne 'https' -or $RequestUri.Host -notin $allowed) { throw 'Artifact URL is not an approved HTTPS host.' }
  if ($StatusCode -in 301,302,303,307,308) { if ($null -eq $Location -or $Location.Scheme -ne 'https' -or $Location.Host -notin $allowed) { throw 'Artifact redirect is not an approved HTTPS host.' }; return $Location }
  if ($StatusCode -lt 200 -or $StatusCode -gt 299) { throw 'Artifact download returned a non-success status.' }
  if ($ContentLength.HasValue -and $ContentLength.Value -ne [int64]$Artifact.size) { throw 'Artifact content length drift.' }
  return $null
}

function Assert-SafeCpythonMembers {
  param([object[]]$Members)
  foreach ($member in $Members) { if ($member.Type -notin @('-', 'd')) { throw 'CPython archive contains a link or unsupported member type.' }; if ((Test-UnsafeArchiveMember ([string]$member.Name)) -or -not ([string]$member.Name).StartsWith('python/')) { throw 'CPython archive has an unsafe or unexpected member.' } }
}

function Assert-SafeUvMembers {
  param([object[]]$Members)
  $expected = @('uv.exe', 'uvw.exe', 'uvx.exe'); $names = @($Members | ForEach-Object { [string]$_.Name } | Sort-Object)
  if ($names.Count -ne $expected.Count -or (Compare-Object $names $expected)) { throw 'uv archive has an unexpected member set.' }
  foreach ($member in $Members) { if ((Test-UnsafeArchiveMember ([string]$member.Name)) -or ([string]$member.Name) -match '[\\/]' -or [bool]$member.Link) { throw 'uv archive has an unsafe member.' } }
}

function Assert-SafeCpythonArchive {
  param([string]$Archive)
  $names = @(& tar.exe -tf $Archive 2>&1); if ($LASTEXITCODE -ne 0) { throw 'CPython archive listing failed.' }
  $verbose = @(& tar.exe -tvf $Archive 2>&1); if ($LASTEXITCODE -ne 0 -or $names.Count -ne $verbose.Count) { throw 'CPython archive metadata listing failed.' }
  $members = for ($index = 0; $index -lt $names.Count; $index++) { [pscustomobject]@{ Name = $names[$index].ToString(); Type = $verbose[$index].ToString()[0] } }
  Assert-SafeCpythonMembers $members
}

function Assert-SafeUvArchive {
  param([string]$Archive)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $members = @($zip.Entries | ForEach-Object { [pscustomobject]@{ Name = $_.FullName; Link = ((($_.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) } })
    Assert-SafeUvMembers $members
  } finally { $zip.Dispose() }
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

function Promote-StagedDirectories {
  param(
    [string]$RuntimeRoot,
    [object[]]$Promotions,
    [int]$FaultAfterPromotion = 0
  )
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if ($Promotions.Count -lt 1) { throw 'At least one staged promotion is required.' }
  $checked = @()
  foreach ($promotion in $Promotions) {
    if ($null -eq $promotion -or $promotion.PSObject.Properties.Name -notcontains 'StagedDirectory' -or $promotion.PSObject.Properties.Name -notcontains 'FinalDirectory') { throw 'Promotion must name staged and final directories.' }
    $staged = Assert-ChildPath $root ([string]$promotion.StagedDirectory)
    $final = Assert-ChildPath $root ([string]$promotion.FinalDirectory)
    if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw 'Verified staging directory is absent.' }
    if (Test-Path -LiteralPath $final) { throw 'Final target already exists; promotion refuses replacement.' }
    $checked += [pscustomobject]@{ StagedDirectory = $staged; FinalDirectory = $final }
  }
  $promoted = @()
  try {
    foreach ($promotion in $checked) {
      Promote-StagedDirectory $root $promotion.StagedDirectory $promotion.FinalDirectory
      $promoted += $promotion
      if ($FaultAfterPromotion -gt 0 -and $promoted.Count -ge $FaultAfterPromotion) { throw 'Injected promotion fault.' }
    }
  } catch {
    $original = $_
    [array]::Reverse($promoted)
    foreach ($promotion in $promoted) {
      if ((Test-Path -LiteralPath $promotion.FinalDirectory -PathType Container) -and -not (Test-Path -LiteralPath $promotion.StagedDirectory)) {
        Move-Item -LiteralPath $promotion.FinalDirectory -Destination $promotion.StagedDirectory
      }
    }
    throw $original
  }
}

Export-ModuleMember -Function Assert-LiteralRuntimeRoot, Assert-ChildPath, Get-Sha256Hex, Assert-ExactHash, Get-Manifest, Invoke-GitChecked, Test-UnsafeArchiveMember, Get-HermesGitIsolationOptions, Assert-HermesGitTranscript, Assert-HermesSourceDirectory, Assert-ArtifactHttpHop, Assert-SafeCpythonMembers, Assert-SafeUvMembers, Assert-SafeCpythonArchive, Assert-SafeUvArchive, Promote-StagedDirectory, Promote-StagedDirectories
