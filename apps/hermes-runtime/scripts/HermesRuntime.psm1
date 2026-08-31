Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($null -eq ('HermesRuntime.NativeFileGuard' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace HermesRuntime {
  public sealed class NativeFileGuard : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WIN32_FIND_STREAM_DATA {
      public long StreamSize;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)] public string StreamName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstStreamW(string name, int infoLevel, out WIN32_FIND_STREAM_DATA data, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextStreamW(IntPtr find, out WIN32_FIND_STREAM_DATA data);
    [DllImport("kernel32.dll")]
    private static extern bool FindClose(IntPtr find);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string existingName, string newName, uint flags);

    private readonly SafeFileHandle handle;
    public uint Attributes { get; private set; }
    public uint LinkCount { get; private set; }
    public ulong Size { get; private set; }
    public string Identity { get; private set; }
    public string[] Streams { get; private set; }

    private NativeFileGuard(string path) {
      const uint FILE_READ_ATTRIBUTES = 0x80;
      const uint FILE_SHARE_READ = 0x1;
      const uint OPEN_EXISTING = 3;
      const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
      const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
      string nativePath = path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : @"\\?\" + path;
      handle = CreateFileW(nativePath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to open a no-follow filesystem identity handle.");
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read filesystem identity.");
      Attributes = info.FileAttributes;
      LinkCount = info.NumberOfLinks;
      Size = ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow;
      Identity = info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
      var streams = new List<string>();
      WIN32_FIND_STREAM_DATA stream;
      IntPtr find = FindFirstStreamW(nativePath, 0, out stream, 0);
      if (find != new IntPtr(-1)) {
        try {
          streams.Add(stream.StreamName);
          while (FindNextStreamW(find, out stream)) streams.Add(stream.StreamName);
          int error = Marshal.GetLastWin32Error();
          if (error != 0 && error != 38) throw new Win32Exception(error, "Unable to enumerate filesystem streams.");
        } finally { FindClose(find); }
      } else {
        int error = Marshal.GetLastWin32Error();
        if (error != 38) throw new Win32Exception(error, "Unable to enumerate filesystem streams.");
      }
      Streams = streams.ToArray();
    }

    public static NativeFileGuard Open(string path) { return new NativeFileGuard(path); }
    public static void DurableMoveNoReplace(string source, string destination) {
      const uint MOVEFILE_WRITE_THROUGH = 0x8;
      if (!MoveFileExW(source, destination, MOVEFILE_WRITE_THROUGH)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Durable no-replace state move failed.");
    }
    public void Dispose() { handle.Dispose(); }
  }
}
'@
}

function Assert-LiteralRuntimeRoot {
  param([string]$RuntimeRoot)
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot) -or $RuntimeRoot.StartsWith('\\') -or $RuntimeRoot.StartsWith('//') -or $RuntimeRoot -match '^(\\\\[?.]\\|[A-Za-z]:[^\\]|[^A-Za-z])' -or $RuntimeRoot.Contains('/')) { throw 'RuntimeRoot must be an exact drive-absolute non-device local path.' }
  $full = [IO.Path]::GetFullPath($RuntimeRoot)
  if (-not [IO.Path]::IsPathFullyQualified($full) -or [IO.Path]::GetPathRoot($full) -eq $full -or -not $RuntimeRoot.Equals($full, [StringComparison]::Ordinal)) { throw 'RuntimeRoot must be a bounded canonical local child path without relative or alias segments.' }
  if (Test-UnsafeArchiveMember $full.Substring(3)) { throw 'RuntimeRoot contains an unsafe Windows path component.' }
  if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveFormat -ne 'NTFS') { throw 'RuntimeRoot must reside on NTFS for identity and alternate-stream enforcement.' }
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

function Open-HermesSafeIdentity {
  param([string]$Path, [switch]$Directory)
  try { $guard = [HermesRuntime.NativeFileGuard]::Open([IO.Path]::GetFullPath($Path)) } catch { throw "Unable to obtain a safe no-follow filesystem identity for '$Path': $($_.Exception.Message)" }
  $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
  if ($isReparse -or $isDirectory -ne [bool]$Directory -or (-not $Directory -and $guard.LinkCount -ne 1) -or $unsafeStreams.Count -ne 0) {
    $guard.Dispose()
    throw 'Filesystem object is a reparse point, hardlink, alternate stream, or has the wrong identity type.'
  }
  return $guard
}

function Assert-HermesSafeTree {
  param([string]$RuntimeRoot, [string]$Directory, [string]$Label)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = [IO.Path]::GetFullPath($Directory)
  $tree = if ($directoryFull.Equals($root, [StringComparison]::Ordinal)) { $root } else { Assert-ChildPath $root $directoryFull }
  if (-not (Test-Path -LiteralPath $tree -PathType Container)) { throw "$Label is absent." }
  $rootGuard = Open-HermesSafeIdentity $tree -Directory
  try { $null = $rootGuard.Identity } finally { $rootGuard.Dispose() }
  foreach ($item in @(Get-ChildItem -LiteralPath $tree -Force -Recurse)) {
    $guard = Open-HermesSafeIdentity $item.FullName -Directory:$item.PSIsContainer
    try { $null = $guard.Identity } finally { $guard.Dispose() }
  }
}

function Get-Sha256Hex {
  param([string]$Path)
  $guard = Open-HermesSafeIdentity $Path
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($sha.ComputeHash($stream))).ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
  } finally { $guard.Dispose() }
}

function Assert-ExactHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ((Get-Sha256Hex $Path) -ne $Expected) { throw "$Label hash mismatch." }
}

function Get-Manifest {
  param([string]$Path)
  $guard = Open-HermesSafeIdentity $Path
  try { $bytes = [IO.File]::ReadAllBytes($Path) } finally { $guard.Dispose() }
  if ($bytes.Length -lt 2 -or ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)) { throw 'Manifest must be canonical UTF-8 JSON.' }
  try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { throw 'Manifest must be canonical UTF-8 JSON.' }
  if ($text.Contains("`r") -or -not $text.EndsWith("`n", [StringComparison]::Ordinal) -or $text.EndsWith("`n`n", [StringComparison]::Ordinal)) { throw 'Manifest must use exactly one canonical LF terminator.' }
  try { $manifest = $text | ConvertFrom-Json -AsHashtable -Depth 32 } catch { throw 'Manifest JSON is malformed.' }
  if ($manifest -isnot [hashtable] -or (($manifest | ConvertTo-Json -Compress -Depth 32) + "`n") -cne $text) { throw 'Manifest JSON is noncanonical or contains duplicate keys.' }
  return $manifest
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

function Invoke-HermesGitProcess {
  param([string]$Git, [string[]]$Arguments, [switch]$BinaryOutput)
  if (-not [IO.Path]::IsPathFullyQualified($Git) -or -not (Test-Path -LiteralPath $Git -PathType Leaf) -or ([IO.Path]::GetExtension($Git) -ine '.exe') -or ((Get-Item -LiteralPath $Git -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Git executable must be an absolute non-reparse application.' }
  $workspace = Join-Path ([IO.Path]::GetTempPath()) ('jarvis-hermes-git-' + [guid]::NewGuid().ToString('N'))
  [void](Assert-LiteralRuntimeRoot $workspace)
  New-Item -ItemType Directory -Path $workspace | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $workspace 'home'), (Join-Path $workspace 'templates'), (Join-Path $workspace 'tmp') | Out-Null
  try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Git; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Environment.Clear()
    $machineRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Machine)
    if ([string]::IsNullOrEmpty($machineRoot)) { $machineRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) }
    $start.Environment['SystemRoot'] = $machineRoot
    $start.Environment['WINDIR'] = $machineRoot
    $start.Environment['TEMP'] = Join-Path $workspace 'tmp'
    $start.Environment['TMP'] = Join-Path $workspace 'tmp'
    $start.Environment['HOME'] = Join-Path $workspace 'home'
    $start.Environment['XDG_CONFIG_HOME'] = Join-Path $workspace 'home'
    $start.Environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $start.Environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    $start.Environment['GIT_CONFIG_SYSTEM'] = 'NUL'
    $start.Environment['GIT_CONFIG_COUNT'] = '0'
    $start.Environment['GIT_ATTR_NOSYSTEM'] = '1'
    $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $start.Environment['GIT_OPTIONAL_LOCKS'] = '0'
    $start.Environment['GIT_PROTOCOL_FROM_USER'] = '0'
    $start.Environment['GIT_ALLOW_PROTOCOL'] = 'https'
    $start.Environment['GIT_ASKPASS'] = 'NUL'
    $start.Environment['SSH_ASKPASS'] = 'NUL'
    $start.Environment['SSH_ASKPASS_REQUIRE'] = 'never'
    $start.Environment['GCM_INTERACTIVE'] = 'never'
    $start.Environment['GIT_TEMPLATE_DIR'] = Join-Path $workspace 'templates'
    foreach ($argument in @((Get-HermesGitIsolationOptions) + $Arguments)) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Unable to start closed Git process.' }
    $output = [IO.MemoryStream]::new(); $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($output)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit(); [void]$stdoutTask.GetAwaiter().GetResult(); $error = $stderrTask.GetAwaiter().GetResult(); $exitCode = $process.ExitCode; $process.Dispose()
    if ($exitCode -ne 0) { throw "git command failed: $error" }
    if ($BinaryOutput) { return ,$output.ToArray() }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($output.ToArray()); return @($text -split "`r?`n" | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Trim() })
  } finally {
    if (Test-Path -LiteralPath $workspace) { Remove-Item -LiteralPath $workspace -Recurse -Force; if (Test-Path -LiteralPath $workspace) { throw 'Closed Git workspace cleanup failed.' } }
  }
}

function Invoke-GitChecked {
  param([string]$Git, [string[]]$Arguments)
  return @(Invoke-HermesGitProcess $Git $Arguments)
}

function Get-HermesGitTreePaths {
  param([string]$Git, [string]$GitDirectory, [string]$Commit)
  $bytes = [byte[]](Invoke-HermesGitProcess $Git @('--git-dir', $GitDirectory, 'ls-tree', '-r', '-z', $Commit) -BinaryOutput)
  $records = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
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
  Assert-HermesSafeTree $root $source 'Pinned source'
  if (-not [string]::IsNullOrEmpty($GitDirectory)) {
    $store = Assert-ChildPath $root $GitDirectory; if (-not (Test-Path -LiteralPath $store -PathType Container)) { throw 'Pinned source Git object store is absent.' }; Assert-HermesSafeTree $root $store 'Pinned source Git object store'
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
  $types = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($member in $Members) {
    $name = [string]$member.Name
    if ($member.Type -notin @('-', 'd')) { throw 'CPython archive contains a link or unsupported member type.' }
    if ($name.Contains('\') -or (Test-UnsafeArchiveMember $name)) { throw 'CPython archive has an unsafe or separator-alias member.' }
    $canonical = $name.TrimEnd('/')
    if ($canonical -ne 'python' -and -not $canonical.StartsWith('python/', [StringComparison]::Ordinal)) { throw 'CPython archive has an unsafe or unexpected member.' }
    if ($types.ContainsKey($canonical)) { throw 'CPython archive has duplicate, case-colliding, or file-directory alias members.' }
    $segments = $canonical.Split('/')
    for ($count = 1; $count -lt $segments.Count; $count++) {
      $ancestor = $segments[0..($count - 1)] -join '/'
      if ($types.ContainsKey($ancestor) -and $types[$ancestor] -ne 'd') { throw 'CPython archive has a file ancestor of another member.' }
    }
    if ($member.Type -ne 'd') {
      foreach ($existing in @($types.Keys)) { if ($existing.StartsWith(($canonical + '/'), [StringComparison]::OrdinalIgnoreCase)) { throw 'CPython archive has a file ancestor of another member.' } }
    }
    if ($canonical -eq 'python' -and $member.Type -ne 'd') { throw 'CPython archive root must be a directory.' }
    $types.Add($canonical, [string]$member.Type)
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

function Get-HermesWorkflowLockPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime.workflow.lock')
}

function Enter-HermesWorkflowLock {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'RuntimeRoot must exist before acquiring the workflow lock.' }
  $path = Get-HermesWorkflowLockPath $root
  if (Test-Path -LiteralPath $path) {
    $identity = Open-HermesSafeIdentity $path
    try { if ($identity.Size -ne 0) { throw 'Hermes workflow lock file must remain exactly empty.' } } finally { $identity.Dispose() }
  }
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if ($stream.Length -ne 0) { $stream.Dispose(); throw 'Hermes workflow lock file must remain exactly empty.' }
    return $stream
  } catch [IO.IOException] {
    throw 'Another Hermes acquisition or verification workflow holds the exclusive RuntimeRoot lock.'
  }
}

function Get-HermesDirectoryDigest {
  param([string]$RuntimeRoot, [string]$Directory)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = Assert-ChildPath $root $Directory
  if (-not (Test-Path -LiteralPath $directoryFull -PathType Container)) { throw 'Publication digest directory is absent.' }
  $records = [Collections.Generic.List[string]]::new()
  $directoryGuard = Open-HermesSafeIdentity $directoryFull -Directory
  try { $records.Add("r`t$($directoryGuard.Identity)") } finally { $directoryGuard.Dispose() }
  foreach ($item in @(Get-ChildItem -LiteralPath $directoryFull -Force -Recurse | Sort-Object { $_.FullName.Substring($directoryFull.Length).Replace('\','/') })) {
    $relative = $item.FullName.Substring($directoryFull.Length).TrimStart('\').Replace('\','/')
    $guard = Open-HermesSafeIdentity $item.FullName -Directory:$item.PSIsContainer
    try {
      if ($item.PSIsContainer) { $records.Add("d`t$relative`t$($guard.Identity)") }
      else { $records.Add("f`t$relative`t$($guard.Identity)`t$($guard.Size)`t$(Get-Sha256Hex $item.FullName)") }
    } finally { $guard.Dispose() }
  }
  $payload = [Text.UTF8Encoding]::new($false).GetBytes(($records -join "`n") + "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([Convert]::ToHexString($sha.ComputeHash($payload))).ToLowerInvariant() } finally { $sha.Dispose() }
}

function ConvertTo-HermesStateJson {
  param([hashtable]$Record)
  return ($Record | ConvertTo-Json -Compress -Depth 16) + "`n"
}

function Read-HermesStateRecord {
  param([string]$Path, [string]$Label)
  $guard = Open-HermesSafeIdentity $Path
  try { $bytes = [IO.File]::ReadAllBytes($Path) } finally { $guard.Dispose() }
  if ($bytes.Length -lt 3 -or ($bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)) { throw "$Label is not canonical UTF-8 JSON." }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $utf8.GetString($bytes) } catch { throw "$Label is not canonical UTF-8 JSON." }
  if ($text.Contains("`r") -or -not $text.EndsWith("`n", [StringComparison]::Ordinal) -or $text.EndsWith("`n`n", [StringComparison]::Ordinal)) { throw "$Label is not canonical LF JSON." }
  try { $record = $text | ConvertFrom-Json -AsHashtable -Depth 16 } catch { throw "$Label is malformed." }
  if ($record -isnot [hashtable]) { throw "$Label is invalid." }
  if ((ConvertTo-HermesStateJson $record) -cne $text) { throw "$Label is not exact canonical JSON or contains duplicate keys." }
  return $record
}

function Get-HermesExpectedPromotions {
  param([string]$RuntimeRoot, [string]$CommonStage)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $stage = Assert-ChildPath $root $CommonStage
  return @(
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\cpython-3.11.16')); final = (Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\uv-0.12.7')); final = (Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\winsw-2.12.0')); final = (Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\20260825')); final = (Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')) }
  )
}

function Assert-HermesPublicationRecord {
  param([string]$RuntimeRoot, [hashtable]$Record, [ValidateSet('promoting','committed')][string]$State)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if ((@($Record.Keys | Sort-Object) -join ',') -cne 'commonStage,promotions,schemaVersion,state,transactionId' -or $Record.schemaVersion -ne 2 -or $Record.state -ne $State -or [string]$Record.transactionId -notmatch '^[a-f0-9]{32}$' -or $Record.promotions -isnot [object[]] -or $Record.promotions.Count -ne 4) { throw 'Runtime publication record is not the exact reviewed schema.' }
  $expectedStage = Assert-ChildPath $root (Join-Path $root ('.artifact-stage-' + [string]$Record.transactionId))
  if ([string]$Record.commonStage -cne $expectedStage) { throw 'Runtime publication record has an unbound common stage.' }
  $expected = Get-HermesExpectedPromotions $root $expectedStage
  $allPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  for ($index = 0; $index -lt 4; $index++) {
    $promotion = $Record.promotions[$index]
    if ($promotion -isnot [Collections.IDictionary] -or (@($promotion.Keys | Sort-Object) -join ',') -cne 'digest,final,staged' -or [string]$promotion.digest -notmatch '^[a-f0-9]{64}$' -or [string]$promotion.staged -cne $expected[$index].staged -or [string]$promotion.final -cne $expected[$index].final) { throw 'Runtime publication record has a forged or reordered promotion.' }
    foreach ($path in @([string]$promotion.staged, [string]$promotion.final)) { if (-not $allPaths.Add($path)) { throw 'Runtime publication record has overlapping paths.' } }
  }
  return $Record
}

function Write-HermesAtomicStateRecord {
  param([string]$RuntimeRoot, [string]$Destination, [hashtable]$Record, [string]$TemporaryPrefix)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $destinationFull = Assert-ChildPath $root $Destination
  if (Test-Path -LiteralPath $destinationFull) { throw 'Runtime publication state already exists.' }
  $temporary = Assert-ChildPath $root (Join-Path $root ($TemporaryPrefix + [guid]::NewGuid().ToString('N') + '.tmp'))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $Record))
  $stream = $null
  try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true); $stream.Dispose(); $stream = $null
    [HermesRuntime.NativeFileGuard]::DurableMoveNoReplace($temporary, $destinationFull)
    if (-not (Test-Path -LiteralPath $destinationFull -PathType Leaf)) { throw 'Atomic publication state promotion failed.' }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force; if (Test-Path -LiteralPath $temporary) { throw 'Publication state temporary cleanup failed.' } }
  }
}

function Write-HermesPublicationJournal {
  param([string]$RuntimeRoot, [object[]]$Promotions)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $RuntimeRoot
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication journal already exists.' }
  if ($Promotions.Count -ne 4) { throw 'Runtime publication requires exactly four promotions.' }
  $commonStage = [IO.Directory]::GetParent([IO.Directory]::GetParent([string]$Promotions[0].StagedDirectory).FullName).FullName
  $transactionId = [IO.Path]::GetFileName($commonStage).Substring('.artifact-stage-'.Length)
  $record = [ordered]@{
    schemaVersion = 2
    state = 'promoting'
    transactionId = $transactionId
    commonStage = $commonStage
    promotions = @($Promotions | ForEach-Object { [ordered]@{ staged = [string]$_.StagedDirectory; final = [string]$_.FinalDirectory; digest = (Get-HermesDirectoryDigest $root ([string]$_.StagedDirectory)) } })
  }
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  Write-HermesAtomicStateRecord $root $journal $record '.hermes-runtime-publication-'
  return $journal
}

function Get-HermesPublicationJournalRecord {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { return $null }
  $record = Read-HermesStateRecord $journal 'Runtime publication journal'
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  return $record
}

function Assert-HermesPublicationMarker {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $ready = Get-HermesPublicationReadyPath $root
  if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'Runtime publication has no verified commit marker.' }
  try { $record = Read-HermesStateRecord $ready 'Runtime publication commit marker' } catch { throw $_ }
  [void](Assert-HermesPublicationRecord $root $record 'committed')
  foreach ($promotion in $record.promotions) {
    $final = Assert-ChildPath $root ([string]$promotion.final)
    $stage = Assert-ChildPath $root ([string]$promotion.staged)
    if ((Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $final -PathType Container) -or ((Get-Item -LiteralPath $final -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-HermesDirectoryDigest $root $final) -ne [string]$promotion.digest) { throw 'Runtime publication commit marker references a drifted or unsafe final directory.' }
  }
  return $record
}

function Assert-HermesPublicationReady {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication is incomplete or recovery is required.' }
  $record = Assert-HermesPublicationMarker $root
  if (Test-Path -LiteralPath ([string]$record.commonStage)) { throw 'Runtime publication retains committed staging residue.' }
}

function Write-HermesPublicationReady {
  param([string]$RuntimeRoot, [hashtable]$Record)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $ready = Get-HermesPublicationReadyPath $root
  [void](Assert-HermesPublicationRecord $root $Record 'committed')
  Write-HermesAtomicStateRecord $root $ready $Record '.hermes-runtime-publication.ready-'
}

function Complete-StagedDirectories {
  param([string]$RuntimeRoot, [scriptblock]$Boundary = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { throw 'Runtime publication journal is absent.' }
  $record = Read-HermesStateRecord $journal 'Runtime publication journal'
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  foreach ($promotion in $record.promotions) {
    $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
    if (Test-Path -LiteralPath $stage) { throw 'Runtime publication has unpromoted staging.' }
    if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Runtime publication final directory is absent.' }
  }
  $committed = [ordered]@{ schemaVersion = 2; state = 'committed'; transactionId = $record.transactionId; commonStage = $record.commonStage; promotions = $record.promotions }
  Write-HermesPublicationReady $root $committed
  if ($null -ne $Boundary) { & $Boundary 'marker-written' }
  [void](Assert-HermesPublicationMarker $root)
  if ($null -ne $Boundary) { & $Boundary 'marker-validated' }
  if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-Item -LiteralPath ([string]$record.commonStage) -Recurse -Force; if (Test-Path -LiteralPath ([string]$record.commonStage)) { throw 'Committed publication staging cleanup failed.' } }
  Remove-Item -LiteralPath $journal -Force
}

function Recover-StagedDirectories {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { return }
  $record = Read-HermesStateRecord $journal 'Runtime publication journal'
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  $ready = Get-HermesPublicationReadyPath $root
  if (Test-Path -LiteralPath $ready) {
    $committed = Assert-HermesPublicationMarker $root
    if ([string]$committed.transactionId -cne [string]$record.transactionId -or [string]$committed.commonStage -cne [string]$record.commonStage -or (ConvertTo-HermesStateJson ([ordered]@{ promotions = $committed.promotions })) -cne (ConvertTo-HermesStateJson ([ordered]@{ promotions = $record.promotions }))) { throw 'Runtime publication marker does not bind the recovery journal.' }
    if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-Item -LiteralPath ([string]$record.commonStage) -Recurse -Force; if (Test-Path -LiteralPath ([string]$record.commonStage)) { throw 'Recovered committed staging cleanup failed.' } }
    Remove-Item -LiteralPath $journal -Force
    return
  }
  $validatedRecovery = @()
  foreach ($promotion in @($record.promotions)[($record.promotions.Count - 1)..0]) {
    $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
    $stageExists = Test-Path -LiteralPath $stage -PathType Container
    $finalExists = Test-Path -LiteralPath $final -PathType Container
    if ($stageExists -eq $finalExists) { throw 'Runtime publication recovery requires exactly one staging or final directory.' }
    $present = if ($finalExists) { $final } else { $stage }
    if ((Get-HermesDirectoryDigest $root $present) -cne [string]$promotion.digest) { throw 'Runtime publication recovery found a drifted staged or final directory digest.' }
    $validatedRecovery += [pscustomobject]@{ Stage = $stage; Final = $final; FinalExists = $finalExists; Digest = [string]$promotion.digest }
  }
  foreach ($promotion in $validatedRecovery) {
    if (-not $promotion.FinalExists) { continue }
    $parent = [IO.Directory]::GetParent($promotion.Stage).FullName; if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Move-Item -LiteralPath $promotion.Final -Destination $promotion.Stage
    if ((Get-HermesDirectoryDigest $root $promotion.Stage) -cne $promotion.Digest) { throw 'Runtime publication recovery move changed the recorded directory digest.' }
  }
  if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-Item -LiteralPath ([string]$record.commonStage) -Recurse -Force; if (Test-Path -LiteralPath ([string]$record.commonStage)) { throw 'Rolled-back publication staging cleanup failed.' } }
  Remove-Item -LiteralPath $journal -Force
}

function Assert-NoHermesWorkflowResidue {
  param([string]$RuntimeRoot, [string]$BoundStage = '')
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
  $bound = if ([string]::IsNullOrEmpty($BoundStage)) { '' } else { Assert-ChildPath $root $BoundStage }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
    $isResidue = $item.Name.StartsWith('.artifact-stage-', [StringComparison]::OrdinalIgnoreCase) -or $item.Name.StartsWith('.verify-', [StringComparison]::OrdinalIgnoreCase) -or $item.Name -match '^\.hermes-runtime-publication(?:\.ready)?-[a-f0-9]{32}\.tmp$'
    if ($isResidue -and ([string]::IsNullOrEmpty($bound) -or $item.FullName -cne $bound)) { throw 'RuntimeRoot contains unbound workflow residue.' }
    if ($item.Name -ieq '.s' -and $item.PSIsContainer -and @(Get-ChildItem -LiteralPath $item.FullName -Force).Count -ne 0) { throw 'RuntimeRoot contains unbound source staging residue.' }
  }
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
    Remove-Item -LiteralPath (Get-HermesPublicationJournalPath $root) -Force
    throw $original
  }
}

Export-ModuleMember -Function Assert-LiteralRuntimeRoot, Assert-ChildPath, Assert-HermesTestFixtureRoot, Open-HermesSafeIdentity, Assert-HermesSafeTree, Get-Sha256Hex, Assert-ExactHash, Get-Manifest, Assert-HermesSourceLock, Assert-HermesArtifactLock, Invoke-GitChecked, Get-HermesGitTreePaths, Test-UnsafeArchiveMember, Get-HermesGitIsolationOptions, Assert-HermesGitTranscript, Assert-HermesSourceDirectory, Assert-ArtifactHttpHop, Assert-SafeCpythonMembers, Assert-SafeUvMembers, Assert-SafeCpythonArchive, Assert-SafeUvArchive, Promote-StagedDirectory, Get-HermesPublicationJournalPath, Get-HermesPublicationReadyPath, Get-HermesPublicationJournalRecord, Get-HermesWorkflowLockPath, Enter-HermesWorkflowLock, Get-HermesDirectoryDigest, Assert-HermesPublicationReady, Complete-StagedDirectories, Recover-StagedDirectories, Assert-NoHermesWorkflowResidue, Promote-StagedDirectories
