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
  $relative = $pathFull.Substring($rootFull.Length).TrimStart('\')
  if (Test-UnsafeArchiveMember $relative) { throw 'Resolved child path has an unsafe Windows path component.' }
  $cursor = $rootFull
  if (Test-Path -LiteralPath $cursor) {
    $rootItem = Get-Item -LiteralPath $cursor -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $rootItem.PSIsContainer) { throw 'RuntimeRoot is not a literal directory.' }
  }
  foreach ($segment in ($relative -split '\\')) {
    $cursor = Join-Path $cursor $segment
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Resolved child path traverses or names a reparse point.' }
    }
  }
  return $pathFull
}

function Assert-HermesTestFixtureRoot {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $root.StartsWith(($temporaryRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($root.TrimEnd('\')).StartsWith('jarvis-hermes-workflow-fixture-', [StringComparison]::Ordinal)) { throw 'Synthetic operations require an exact ephemeral fixture root.' }
  return $root
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

function Assert-HermesSourceLock {
  param([hashtable]$Lock)
  if ($null -eq $Lock -or $Lock.schemaVersion -ne '1' -or $Lock.remote -ne 'https://github.com/NousResearch/hermes-agent.git' -or $Lock.tag -ne 'v2026.8.27' -or $Lock.tagObject -ne 'fcebd62163497e77e5de00d26d2ed86cb4ef8761' -or $Lock.sourceCommit -ne '5fc308a70719a83cccdbba4c0e39c23f5a8239d5' -or $Lock.sourceTree -ne '222ec43b5237deb643277bc2f64fa4b873dd7f28' -or $Lock.acquisitionMethod -ne 'git-detached' -or $Lock.submodules.Count -ne 0) { throw 'Hermes source lock is not the reviewed canonical lock.' }
  foreach ($name in @('LICENSE','pyproject.toml','uv.lock')) { if ($Lock.rawFileSha256[$name] -notmatch '^[a-f0-9]{64}$') { throw 'Hermes source lock raw-file hashes are invalid.' } }
}

function Assert-HermesArtifactLock {
  param([hashtable]$Lock)
  $expected = @{ cpython = 'cpython-3.11.16+20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'; uv = 'uv-x86_64-pc-windows-msvc.zip'; winsw = 'WinSW-x64.exe' }
  if ($null -eq $Lock -or $Lock.schemaVersion -ne '1') { throw 'Runtime artifact lock is not canonical.' }
  foreach ($name in $expected.Keys) { $artifact = $Lock[$name]; if ($null -eq $artifact -or $artifact.fileName -ne $expected[$name] -or $artifact.url -notmatch '^https://github\.com/' -or $artifact.size -lt 1 -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime artifact lock is not canonical.' } }
  if ($Lock.pythonBuildStandaloneLicenses.url -ne 'https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260825/python-licenses.rst' -or $Lock.pythonBuildStandaloneLicenses.size -lt 1 -or $Lock.pythonBuildStandaloneLicenses.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime artifact lock is not canonical.' }
}

function Invoke-GitChecked {
  param([string]$Git, [string[]]$Arguments)
  $result = & $Git @(Get-HermesGitIsolationOptions) @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git command failed: $($result -join "`n")" }
  return @($result | ForEach-Object { $_.ToString().Trim() })
}

function Get-HermesGitTreePaths {
  param([string]$Git, [string]$GitDirectory, [string]$Commit)
  $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $Git; $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  foreach ($argument in @((Get-HermesGitIsolationOptions) + @('--git-dir', $GitDirectory, 'ls-tree', '-r', '-z', $Commit))) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start; if (-not $process.Start()) { throw 'Unable to start Git tree verification.' }
  $bytes = [IO.MemoryStream]::new(); $process.StandardOutput.BaseStream.CopyTo($bytes); $error = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Git tree verification failed: $error" }
  $records = [Text.Encoding]::UTF8.GetString($bytes.ToArray()).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
  $entries = @(); foreach ($record in $records) { $parts = $record.Split([char]9, 2); if ($parts.Count -ne 2 -or $parts[0] -notmatch '^(?<mode>[0-7]{6}) (?<type>blob|tree|commit) (?<object>[a-f0-9]{40})$') { throw 'Pinned Git tree record is malformed.' }; $entry = [pscustomobject]@{ Mode = $Matches.mode; Type = $Matches.type; Object = $Matches.object; Path = $parts[1] }; if ((Test-UnsafeArchiveMember $entry.Path) -or $entry.Path -eq '.gitmodules' -or $entry.Mode -in @('120000','160000') -or $entry.Type -ne 'blob') { throw 'Pinned Git tree has a forbidden member.' }; $entries += $entry }
  return @($entries)
}

function Test-UnsafeArchiveMember {
  param([string]$Member)
  $candidate = if ($null -eq $Member) { '' } else { $Member.TrimEnd([char[]]@([char]'/', [char]'\')) }
  if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.StartsWith('/') -or $candidate.StartsWith('\\') -or $candidate -match '(^|[\\/])\.\.([\\/]|$)' -or $candidate -match ':') { return $true }
  foreach ($segment in ($candidate -split '[\\/]')) {
    if ([string]::IsNullOrWhiteSpace($segment) -or $segment -match '[<>"|?*]' -or $segment -match '[. ]$' -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') { return $true }
  }
  return $false
}

function Get-HermesGitIsolationOptions {
  return @('-c','core.hooksPath=NUL','-c','core.autocrlf=false','-c','core.safecrlf=true','-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','-c','credential.helper=')
}

function Assert-HermesGitTranscript {
  param([hashtable]$Lock, [string]$GitDirectory, [string]$WorkTree, [scriptblock]$InvokeGit, [object[]]$TreeEntries)
  $call = { param([string[]]$Arguments) @(& $InvokeGit $Arguments) }
  $tag = "refs/tags/{0}" -f $Lock.tag
  if ((& $call @('--git-dir', $GitDirectory, 'cat-file', '-t', $tag)) -ne 'tag') { throw 'Pinned tag is not annotated.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tag}}" -f $tag))) -ne $Lock.tagObject) { throw 'Pinned tag object mismatch.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{}}" -f $tag))) -ne $Lock.sourceCommit) { throw 'Pinned tag was retargeted.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit))) -ne $Lock.sourceTree) { throw 'Pinned source tree mismatch.' }
  $remotes = @(& $call @('--git-dir', $GitDirectory, 'remote')); if ($remotes.Count -ne 1 -or $remotes[0] -ne 'origin') { throw 'Unexpected Git remote.' }
  if ($null -eq $TreeEntries -or $TreeEntries.Count -lt 1) { throw 'Pinned source tree records are absent.' }
  foreach ($entry in $TreeEntries) {
    if ($null -eq $entry -or [string]$entry.Mode -notmatch '^[0-7]{6}$' -or [string]$entry.Type -ne 'blob' -or [string]$entry.Object -notmatch '^[a-f0-9]{40}$' -or (Test-UnsafeArchiveMember ([string]$entry.Path)) -or [string]$entry.Path -eq '.gitmodules' -or [string]$entry.Mode -in @('120000','160000')) { throw 'Pinned source tree has a forbidden member.' }
  }
  $status = @(& $call @('-c', 'core.longpaths=true', '--git-dir', $GitDirectory, '--work-tree', $WorkTree, 'status', '--porcelain')); if ($status.Count -ne 0) { throw "Pinned checkout is dirty or untracked: $($status -join ';')" }
}

function Assert-HermesSourceDirectory {
  param(
    [string]$RuntimeRoot,
    [string]$Candidate,
    [hashtable]$Lock,
    [string]$GitDirectory = '',
    [scriptblock]$AssertFileHash = $null,
    [scriptblock]$InvokeGit = $null,
    [scriptblock]$GetTreeEntries = $null
  )
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $source = Assert-ChildPath $root $Candidate
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Pinned Hermes source is absent.' }
  if ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Pinned Hermes source is a reparse point.' }
  if (Test-Path -LiteralPath (Join-Path $source '.git')) { throw 'Pinned source must be a detached export without a worktree repository.' }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) {
    $path = Assert-ChildPath $root (Join-Path $source $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Pinned source file is absent: $name" }
    if ($null -eq $AssertFileHash) { Assert-ExactHash $path $Lock.rawFileSha256[$name] "Pinned source $name" } else { & $AssertFileHash $path $Lock.rawFileSha256[$name] "Pinned source $name" }
  }
  if (@(Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
  if (-not [string]::IsNullOrEmpty($GitDirectory)) {
    $store = Assert-ChildPath $root $GitDirectory; if (-not (Test-Path -LiteralPath $store -PathType Container)) { throw 'Pinned source Git object store is absent.' }; if ((Get-Item -LiteralPath $store -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Pinned source Git object store is a reparse point.' }
    $git = if ($null -eq $InvokeGit) { Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source } else { '' }
    $treeResult = if ($null -eq $InvokeGit) { Invoke-GitChecked $git @('--git-dir', $store, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit)) } else { @(& $InvokeGit @('--git-dir', $store, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit))) }
    if ($treeResult -ne $Lock.sourceTree) { throw 'Pinned source Git tree mismatch.' }
    $entries = if ($null -eq $GetTreeEntries) { Get-HermesGitTreePaths $git $store $Lock.sourceCommit } else { @(& $GetTreeEntries $store $Lock.sourceCommit) }
    $expected = @($entries | ForEach-Object Path | Sort-Object)
    $actual = @(Get-ChildItem -LiteralPath $source -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/') } | Sort-Object)
    if ($expected.Count -ne $actual.Count -or (Compare-Object $expected $actual)) { throw 'Pinned source path set drift.' }
    $expectedDirectories = @($expected | ForEach-Object { $parts = $_ -split '/'; for ($index = 1; $index -lt $parts.Count; $index++) { ($parts[0..($index - 1)] -join '/') } } | Sort-Object -Unique)
    $actualDirectories = @(Get-ChildItem -LiteralPath $source -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/') } | Sort-Object)
    if ($expectedDirectories.Count -ne $actualDirectories.Count -or (Compare-Object $expectedDirectories $actualDirectories)) { throw 'Pinned source directory set drift.' }
    if ($null -eq $InvokeGit) { [void](Invoke-GitChecked $git @('--git-dir', $store, '--work-tree', $source, 'diff', '--no-ext-diff', '--exit-code', $Lock.sourceCommit, '--', '.')) } else { [void](& $InvokeGit @('--git-dir', $store, '--work-tree', $source, 'diff', '--no-ext-diff', '--exit-code', $Lock.sourceCommit, '--', '.')) }
  }
}

function Assert-ArtifactHttpHop {
  param([hashtable]$Artifact, [Uri]$RequestUri, [int]$StatusCode, [Uri]$Location, [Nullable[int64]]$ContentLength)
  $allowed = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')
  if ($RequestUri.Scheme -ne 'https' -or $RequestUri.Host -notin $allowed) { throw 'Artifact URL is not an approved HTTPS host.' }
  if ($StatusCode -in 301,302,303,307,308) { if ($null -eq $Location -or $Location.Scheme -ne 'https' -or $Location.Host -notin $allowed) { throw 'Artifact redirect is not an approved HTTPS host.' }; return $Location }
  if ($StatusCode -lt 200 -or $StatusCode -gt 299) { throw 'Artifact download returned a non-success status.' }
  if ($null -ne $ContentLength -and [int64]$ContentLength -ne [int64]$Artifact.size) { throw 'Artifact content length drift.' }
  return $null
}

function Assert-SafeCpythonMembers {
  param([object[]]$Members)
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($member in $Members) {
    $name = [string]$member.Name
    $canonical = $name.TrimEnd([char[]]@([char]'/', [char]'\'))
    if (-not $seen.Add($canonical)) { throw 'CPython archive has duplicate, case-colliding, or file-directory alias members.' }
    if ($member.Type -notin @('-', 'd')) { throw 'CPython archive contains a link or unsupported member type.' }
    if ((Test-UnsafeArchiveMember $name) -or ($canonical -ne 'python' -and -not $canonical.StartsWith('python/'))) { throw 'CPython archive has an unsafe or unexpected member.' }
    if ($canonical -eq 'python' -and $member.Type -ne 'd') { throw 'CPython archive root must be a directory.' }
  }
}

function Assert-SafeUvMembers {
  param([object[]]$Members)
  $expected = @('uv.exe', 'uvw.exe', 'uvx.exe'); $names = @($Members | ForEach-Object { [string]$_.Name } | Sort-Object)
  if ($names.Count -ne $expected.Count -or (Compare-Object $names $expected)) { throw 'uv archive has an unexpected member set.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($member in $Members) { if (-not $seen.Add([string]$member.Name) -or (Test-UnsafeArchiveMember ([string]$member.Name)) -or ([string]$member.Name) -match '[\\/]' -or [bool]$member.Link) { throw 'uv archive has an unsafe member.' } }
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

function Get-HermesPublicationJournalPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime-publication.json')
}

function Get-HermesPublicationReadyPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime-publication.ready.json')
}

function Write-HermesPublicationJournal {
  param([string]$RuntimeRoot, [object[]]$Promotions)
  $journal = Get-HermesPublicationJournalPath $RuntimeRoot
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication journal already exists.' }
  $record = [ordered]@{ schemaVersion = 1; state = 'promoting'; promotions = @($Promotions | ForEach-Object { [ordered]@{ staged = $_.StagedDirectory; final = $_.FinalDirectory } }) }
  [IO.File]::WriteAllText($journal, ($record | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))
  return $journal
}

function Assert-HermesPublicationMarker {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $ready = Get-HermesPublicationReadyPath $root
  if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'Runtime publication has no verified commit marker.' }
  try { $record = Get-Manifest $ready } catch { throw 'Runtime publication commit marker is malformed.' }
  if ($record.schemaVersion -ne 1 -or $record.state -ne 'committed' -or $record.promotions.Count -lt 1) { throw 'Runtime publication commit marker is invalid.' }
  foreach ($promotion in $record.promotions) {
    $final = Assert-ChildPath $root ([string]$promotion.final)
    $stage = Assert-ChildPath $root ([string]$promotion.staged)
    if ((Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $final -PathType Container) -or ((Get-Item -LiteralPath $final -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime publication commit marker references an unsafe final directory.' }
  }
}

function Assert-HermesPublicationReady {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication is incomplete or recovery is required.' }
  Assert-HermesPublicationMarker $root
}

function Write-HermesPublicationReady {
  param([string]$RuntimeRoot, [hashtable]$Record)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $ready = Get-HermesPublicationReadyPath $root
  if (Test-Path -LiteralPath $ready) { throw 'Runtime publication commit marker already exists.' }
  $temporary = Assert-ChildPath $root (Join-Path $root ('.hermes-runtime-publication.ready-' + [guid]::NewGuid().ToString('N') + '.tmp'))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Compress -Depth 8))
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  try { Move-Item -LiteralPath $temporary -Destination $ready; if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'Atomic publication marker promotion failed.' } } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
}

function Complete-StagedDirectories {
  param([string]$RuntimeRoot, [scriptblock]$Boundary = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { throw 'Runtime publication journal is absent.' }
  $record = Get-Manifest $journal
  if ($record.schemaVersion -ne 1 -or $record.state -ne 'promoting' -or $record.promotions.Count -lt 1) { throw 'Runtime publication journal is invalid.' }
  foreach ($promotion in $record.promotions) {
    $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
    if (Test-Path -LiteralPath $stage) { throw 'Runtime publication has unpromoted staging.' }
    if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Runtime publication final directory is absent.' }
  }
  $record.state = 'committed'
  Write-HermesPublicationReady $root $record
  if ($null -ne $Boundary) { & $Boundary 'marker-written' }
  Assert-HermesPublicationMarker $root
  if ($null -ne $Boundary) { & $Boundary 'marker-validated' }
  Remove-Item -LiteralPath $journal -Force
}

function Recover-StagedDirectories {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { return }
  $record = Get-Manifest $journal
  if ($record.schemaVersion -ne 1 -or $record.state -ne 'promoting' -or $record.promotions.Count -lt 1) { throw 'Runtime publication journal is invalid.' }
  $ready = Get-HermesPublicationReadyPath $root
  if (Test-Path -LiteralPath $ready) {
    Assert-HermesPublicationMarker $root
    Remove-Item -LiteralPath $journal -Force
    return
  }
  foreach ($promotion in @($record.promotions)[($record.promotions.Count - 1)..0]) {
    $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
    if (Test-Path -LiteralPath $final) {
      if (Test-Path -LiteralPath $stage) { throw 'Runtime publication recovery found both staging and final directories.' }
      $parent = [IO.Directory]::GetParent($stage).FullName; if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
      Move-Item -LiteralPath $final -Destination $stage
    } elseif (-not (Test-Path -LiteralPath $stage -PathType Container)) { throw 'Runtime publication recovery found neither staging nor final directory.' }
  }
  Remove-Item -LiteralPath $journal -Force
}

function Promote-StagedDirectories {
  param(
    [string]$RuntimeRoot,
    [object[]]$Promotions,
    [int]$FaultAfterPromotion = 0,
    [int]$CrashAfterPromotion = 0,
    [scriptblock]$Boundary = $null
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
  [void](Write-HermesPublicationJournal $root $checked)
  $promoted = @()
  try {
    foreach ($promotion in $checked) {
      Promote-StagedDirectory $root $promotion.StagedDirectory $promotion.FinalDirectory
      $promoted += $promotion
      if ($null -ne $Boundary) { & $Boundary ("promotion-{0}" -f $promoted.Count) }
      if ($CrashAfterPromotion -gt 0 -and $promoted.Count -ge $CrashAfterPromotion) { throw 'Injected publication crash.' }
      if ($FaultAfterPromotion -gt 0 -and $promoted.Count -ge $FaultAfterPromotion) { throw 'Injected promotion fault.' }
    }
  } catch {
    $original = $_
    if ($original.Exception.Message -eq 'Injected publication crash.') { throw $original }
    [array]::Reverse($promoted)
    foreach ($promotion in $promoted) {
      if ((Test-Path -LiteralPath $promotion.FinalDirectory -PathType Container) -and -not (Test-Path -LiteralPath $promotion.StagedDirectory)) {
        Move-Item -LiteralPath $promotion.FinalDirectory -Destination $promotion.StagedDirectory
      }
    }
    Remove-Item -LiteralPath (Get-HermesPublicationJournalPath $root) -Force -ErrorAction SilentlyContinue
    throw $original
  }
}

Export-ModuleMember -Function Assert-LiteralRuntimeRoot, Assert-ChildPath, Assert-HermesTestFixtureRoot, Get-Sha256Hex, Assert-ExactHash, Get-Manifest, Assert-HermesSourceLock, Assert-HermesArtifactLock, Invoke-GitChecked, Get-HermesGitTreePaths, Test-UnsafeArchiveMember, Get-HermesGitIsolationOptions, Assert-HermesGitTranscript, Assert-HermesSourceDirectory, Assert-ArtifactHttpHop, Assert-SafeCpythonMembers, Assert-SafeUvMembers, Assert-SafeCpythonArchive, Assert-SafeUvArchive, Promote-StagedDirectory, Get-HermesPublicationJournalPath, Get-HermesPublicationReadyPath, Assert-HermesPublicationReady, Complete-StagedDirectories, Recover-StagedDirectories, Promote-StagedDirectories
