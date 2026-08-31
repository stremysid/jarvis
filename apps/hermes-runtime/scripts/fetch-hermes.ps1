[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lock = Get-Manifest (Join-Path $repoRoot 'hermes-source-lock.json')
Assert-HermesSourceLock $lock
$root = Assert-LiteralRuntimeRoot $RuntimeRoot
$release = Assert-ChildPath $root (Join-Path $root (Join-Path 'releases' $lock.sourceCommit))
$source = Assert-ChildPath $root (Join-Path $release 'source')
$git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$savedGitEnvironment = @{}
foreach ($name in @('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ATTR_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE')) {
  $item = Get-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
  $savedGitEnvironment[$name] = if ($null -eq $item) { $null } else { $item.Value }
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = 'NUL'
$env:GIT_CONFIG_SYSTEM = 'NUL'
$env:GIT_ATTR_NOSYSTEM = '1'
foreach ($name in @('GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE')) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue }

function Assert-VerifiedSource {
  param([string]$Candidate)
  Assert-HermesSourceDirectory $root $Candidate $lock
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
  Invoke-GitChecked $git @((Get-HermesGitIsolationOptions) + @('init','--bare',$gitDir)) | Out-Null
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
  New-Item -ItemType Directory -Path $workTree | Out-Null
  Invoke-GitChecked $git @('-c','core.longpaths=true','--git-dir',$gitDir,'--work-tree',$workTree,'checkout','--detach','--force',$lock.sourceCommit) | Out-Null
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { Assert-ExactHash (Join-Path $workTree $name) $lock.rawFileSha256[$name] "Raw checkout $name" }
  $gitRunner = { param([string[]]$Arguments) Invoke-GitChecked $git $Arguments }
  Assert-HermesGitTranscript $lock $gitDir $workTree $gitRunner
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
  foreach ($name in $savedGitEnvironment.Keys) {
    if ($null -eq $savedGitEnvironment[$name]) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ("Env:" + $name) -Value $savedGitEnvironment[$name] }
  }
}
