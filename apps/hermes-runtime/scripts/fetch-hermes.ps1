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
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Pinned Hermes source is absent.' }
  if (Test-Path -LiteralPath (Join-Path $source '.git')) { throw 'Pinned source must be a detached export without a worktree repository.' }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) {
    $path = Assert-ChildPath $source (Join-Path $source $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Pinned source file is absent: $name" }
    Assert-ExactHash $path $lock.rawFileSha256[$name] "Pinned source $name"
  }
  if ((Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
}

if ($VerifyOnly) { Assert-VerifiedSource; exit 0 }
if (Test-Path -LiteralPath $release) { throw 'Pinned release target already exists; acquisition refuses reuse.' }
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RuntimeRoot is a reparse point.' }

$staging = Assert-ChildPath $root (Join-Path $root ('.hermes-stage-' + [guid]::NewGuid().ToString('N')))
try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $gitDir = Join-Path $staging 'git'
  $workTree = Join-Path $staging 'source'
  Invoke-GitChecked $git @('-c','core.hooksPath=NUL','-c','core.autocrlf=false','-c','core.safecrlf=true','-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','-c','credential.helper=','init','--bare',$gitDir) | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'remote','add','origin',$lock.remote) | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'fetch','--no-tags','--depth=1','origin',("refs/tags/{0}:refs/tags/{0}" -f $lock.tag)) | Out-Null
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'cat-file','-t',("refs/tags/{0}" -f $lock.tag)))[0] -ne 'tag') { throw 'Pinned tag is not annotated.' }
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("refs/tags/{0}^{{tag}}" -f $lock.tag)))[0] -ne $lock.tagObject) { throw 'Pinned tag object mismatch.' }
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("refs/tags/{0}^{{}}" -f $lock.tag)))[0] -ne $lock.sourceCommit) { throw 'Pinned tag was retargeted.' }
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'rev-parse',("{0}^{{tree}}" -f $lock.sourceCommit)))[0] -ne $lock.sourceTree) { throw 'Pinned source tree mismatch.' }
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'remote')).Count -ne 1) { throw 'Unexpected Git remote.' }
  $tree = Invoke-GitChecked $git @('--git-dir',$gitDir,'ls-tree','-r',$lock.sourceCommit)
  if ($tree | Where-Object { $_ -match '^160000 ' }) { throw 'Pinned source contains a gitlink.' }
  if ($tree | Where-Object { $_ -match ' .gitmodules$' }) { throw 'Pinned source contains submodule metadata.' }
  New-Item -ItemType Directory -Path $workTree | Out-Null
  Invoke-GitChecked $git @('--git-dir',$gitDir,'--work-tree',$workTree,'checkout','--detach','--force',$lock.sourceCommit,'--','.') | Out-Null
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { Assert-ExactHash (Join-Path $workTree $name) $lock.rawFileSha256[$name] "Raw checkout $name" }
  if ((Invoke-GitChecked $git @('--git-dir',$gitDir,'--work-tree',$workTree,'status','--porcelain')).Count -ne 0) { throw 'Pinned checkout is dirty or untracked.' }
  if ((Get-ChildItem -LiteralPath $workTree -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
  Remove-Item -LiteralPath $gitDir -Force -Recurse
  New-Item -ItemType Directory -Path $release | Out-Null
  Move-Item -LiteralPath $workTree -Destination $source
  Assert-VerifiedSource
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -Recurse -ErrorAction SilentlyContinue }
}
