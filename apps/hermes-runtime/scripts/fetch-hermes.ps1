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
$lock = Get-Manifest (Join-Path $repoRoot 'hermes-source-lock.json')
$release = Assert-ChildPath $root (Join-Path $root (Join-Path 'releases' $lock.sourceCommit))
$source = Assert-ChildPath $root (Join-Path $release 'source')
$git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source

function Assert-VerifiedSource {
  param([string]$Candidate)
  if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) { throw 'Pinned Hermes source is absent.' }
  if (Test-Path -LiteralPath (Join-Path $Candidate '.git')) { throw 'Pinned source must be a detached export without a worktree repository.' }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) {
    $path = Assert-ChildPath $root (Join-Path $Candidate $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Pinned source file is absent: $name" }
    Assert-ExactHash $path $lock.rawFileSha256[$name] "Pinned source $name"
  }
  if (@(Get-ChildItem -LiteralPath $Candidate -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
}

if ($VerifyOnly) { Assert-VerifiedSource $source; exit 0 }
if (Test-Path -LiteralPath $release) { throw 'Pinned release target already exists; acquisition refuses reuse.' }
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RuntimeRoot is a reparse point.' }

$stagingParent = Assert-ChildPath $root (Join-Path $root '.s')
if (-not (Test-Path -LiteralPath $stagingParent)) { New-Item -ItemType Directory -Path $stagingParent | Out-Null }
[void](Assert-LiteralRuntimeRoot $stagingParent)
$staging = Assert-ChildPath $root (Join-Path $stagingParent ([guid]::NewGuid().ToString('N')))
if (Test-Path -LiteralPath $staging) { throw 'Fresh staging path already exists.' }
try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $gitDir = Join-Path $staging 'git'
  $workTree = Join-Path $staging 'source'
  Invoke-GitChecked $git @('-c','core.hooksPath=NUL','-c','core.autocrlf=false','-c','core.safecrlf=true','-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','-c','credential.helper=','init','--bare',$gitDir) | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','core.hooksPath','NUL') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','core.bare','false') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','core.longpaths','true') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','core.autocrlf','false') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','core.safecrlf','true') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','filter.lfs.smudge','') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','filter.lfs.process','') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','filter.lfs.required','false') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'config','credential.helper','') | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'remote','add','origin',$lock.remote) | Out-Null
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    Invoke-GitChecked $git @('-c','http.version=HTTP/1.1','-c','http.lowSpeedLimit=1','-c','http.lowSpeedTime=30','--git-dir',$gitDir,'fetch','--no-tags','--depth=1','origin',("refs/tags/{0}:refs/tags/{0}" -f $lock.tag)) | Out-Null
  } finally {
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
  }
  $tagType = Invoke-GitChecked $git @('--git-dir',$gitDir,'cat-file','-t',("refs/tags/{0}" -f $lock.tag))
  if ($tagType -ne 'tag') { throw 'Pinned tag is not annotated.' }
  $tagObject = Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("refs/tags/{0}^{{tag}}" -f $lock.tag))
  if ($tagObject -ne $lock.tagObject) { throw 'Pinned tag object mismatch.' }
  $peeledCommit = Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("refs/tags/{0}^{{}}" -f $lock.tag))
  if ($peeledCommit -ne $lock.sourceCommit) { throw 'Pinned tag was retargeted.' }
  $treeHash = Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("{0}^{{tree}}" -f $lock.sourceCommit))
  if ($treeHash -ne $lock.sourceTree) { throw 'Pinned source tree mismatch.' }
  $remotes = @(Invoke-GitChecked $git @('--git-dir',$gitDir,'remote'))
  if ($remotes.Count -ne 1 -or $remotes[0] -ne 'origin') { throw 'Unexpected Git remote.' }
  $tree = @(Invoke-GitChecked $git @('--git-dir',$gitDir,'ls-tree','-r',$lock.sourceCommit))
  if ($tree | Where-Object { $_ -match '^160000 ' }) { throw 'Pinned source contains a gitlink.' }
  if ($tree | Where-Object { $_ -match ' .gitmodules$' }) { throw 'Pinned source contains submodule metadata.' }
  New-Item -ItemType Directory -Path $workTree | Out-Null
  Invoke-GitChecked $git @('-c','core.longpaths=true','--git-dir',$gitDir,'--work-tree',$workTree,'checkout','--detach','--force',$lock.sourceCommit) | Out-Null
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { Assert-ExactHash (Join-Path $workTree $name) $lock.rawFileSha256[$name] "Raw checkout $name" }
  $status = @(Invoke-GitChecked $git @('-c','core.longpaths=true','--git-dir',$gitDir,'--work-tree',$workTree,'status','--porcelain'))
  if ($status.Count -ne 0) { throw "Pinned checkout is dirty or untracked: $($status -join ';')" }
  if (@(Get-ChildItem -LiteralPath $workTree -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
  Remove-Item -LiteralPath $gitDir -Force -Recurse
  $stagedRelease = Assert-ChildPath $root (Join-Path $staging 'release')
  New-Item -ItemType Directory -Path $stagedRelease | Out-Null
  $stagedSource = Assert-ChildPath $root (Join-Path $stagedRelease 'source')
  Move-Item -LiteralPath $workTree -Destination $stagedSource
  Assert-VerifiedSource $stagedSource
  Promote-StagedDirectory $root $stagedRelease $release
  Assert-VerifiedSource $source
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -Recurse -ErrorAction SilentlyContinue }
}
