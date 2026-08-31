[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly,
  [string]$TestEffectLog = '',
  [string]$TestOperationFixture = '',
  [ValidateSet('', 'validated-before-root-effect', 'git-init', 'staged-full-tree-verified', 'move-complete', 'postverify-complete')][string]$FailAfterEffect = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lockPath = Join-Path $repoRoot 'hermes-source-lock.json'
Assert-ExactHash $lockPath 'f3a875f0ec2a622d5939e6c41c0fb271a30dfc4627d6bccac4023ab85c5e568d' 'Hermes source lock'
$lock = Get-Manifest $lockPath
Assert-HermesSourceLock $lock
$root = Assert-LiteralRuntimeRoot $RuntimeRoot
$testOperations = $null
if ([string]::IsNullOrEmpty($TestOperationFixture) -and (-not [string]::IsNullOrEmpty($TestEffectLog) -or -not [string]::IsNullOrEmpty($FailAfterEffect))) { throw 'Test hooks require a closed operation fixture.' }
if (-not [string]::IsNullOrEmpty($TestOperationFixture)) {
  $fixturePath = Assert-ChildPath $root $TestOperationFixture
  if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw 'Test operation fixture is absent.' }
  $testOperations = Get-Manifest $fixturePath
  $fixtureKeys = @($testOperations.Keys | Sort-Object)
  $sourceFixtureScenarios = @('success', 'manifest-drift', 'git-remote-drift', 'git-tag-drift', 'git-peeled-drift', 'git-tree-drift', 'git-unsafe-member', 'source-hash-drift', 'git-dirty')
  if (($fixtureKeys -join ',') -ne 'scenario,schemaVersion,workflow' -or $testOperations.schemaVersion -ne 1 -or $testOperations.workflow -ne 'source' -or $testOperations.scenario -notin $sourceFixtureScenarios) { throw 'Test operation fixture is not a closed source fixture.' }
  [void](Assert-HermesTestFixtureRoot $root)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [void](Assert-ChildPath $root $TestEffectLog) }
  if ($testOperations.scenario -eq 'manifest-drift') { $driftedLock = @{} + $lock; $driftedLock.remote = 'https://example.invalid/hermes.git'; Assert-HermesSourceLock $driftedLock }
}
$release = Assert-ChildPath $root (Join-Path $root (Join-Path 'releases' $lock.sourceCommit))
$source = Assert-ChildPath $root (Join-Path $release 'source')
$git = if ($null -eq $testOperations) { Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source } else { 'synthetic-git' }
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
function Invoke-WorkflowEffect { param([string]$Name); if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [IO.File]::AppendAllText($TestEffectLog, ($Name + "`n"), [Text.UTF8Encoding]::new($false)) }; if ($FailAfterEffect -eq $Name) { throw "Injected workflow failure: $Name" } }

function Invoke-SourceGit {
  param([string[]]$Arguments)
  if ($null -eq $testOperations) { return @(Invoke-GitChecked $git $Arguments) }
  if ($Arguments -contains 'init') { $directory = [string]$Arguments[-1]; New-Item -ItemType Directory -Path $directory | Out-Null; return @() }
  if ($Arguments -contains 'checkout') {
    $workTreeIndex = [Array]::IndexOf($Arguments, '--work-tree')
    if ($workTreeIndex -lt 0 -or $workTreeIndex + 1 -ge $Arguments.Count) { throw 'Synthetic Git checkout has no work tree.' }
    $workTreePath = [string]$Arguments[$workTreeIndex + 1]
    foreach ($entry in ([ordered]@{ 'LICENSE' = 'synthetic-LICENSE'; 'pyproject.toml' = 'synthetic-pyproject'; 'uv.lock' = 'synthetic-uv-lock'; 'hermes.txt' = 'synthetic-source-tree' }).GetEnumerator()) {
      $content = if ($testOperations.scenario -eq 'source-hash-drift' -and $entry.Key -eq 'LICENSE') { 'hostile-source-drift' } else { [string]$entry.Value }
      [IO.File]::WriteAllText((Join-Path $workTreePath $entry.Key), $content, [Text.UTF8Encoding]::new($false))
    }
    return @()
  }
  if ($Arguments -contains 'cat-file') { return @('tag') }
  if ($Arguments -contains 'rev-parse') {
    $revision = [string]$Arguments[-1]
    if ($revision.EndsWith('^{tag}', [StringComparison]::Ordinal)) { return @($(if ($testOperations.scenario -eq 'git-tag-drift') { '0' * 40 } else { $lock.tagObject })) }
    if ($revision.EndsWith('^{tree}', [StringComparison]::Ordinal)) { return @($(if ($testOperations.scenario -eq 'git-tree-drift') { '2' * 40 } else { $lock.sourceTree })) }
    if ($revision.EndsWith('^{}', [StringComparison]::Ordinal)) { return @($(if ($testOperations.scenario -eq 'git-peeled-drift') { '1' * 40 } else { $lock.sourceCommit })) }
    throw 'Synthetic Git revision is not closed.'
  }
  $remoteIndex = [Array]::IndexOf($Arguments, 'remote')
  if ($remoteIndex -ge 0) { if ($remoteIndex + 1 -lt $Arguments.Count -and $Arguments[$remoteIndex + 1] -eq 'add') { return @() }; return @($(if ($testOperations.scenario -eq 'git-remote-drift') { @('origin', 'evil') } else { 'origin' })) }
  if ($Arguments -contains 'status') { return @($(if ($testOperations.scenario -eq 'git-dirty') { '?? injected' } else { @() })) }
  if ($Arguments -contains 'diff' -or $Arguments -contains 'config' -or $Arguments -contains 'fetch') { return @() }
  throw 'Synthetic Git operation is not closed.'
}

function Get-SourceTreeEntries {
  param([string]$GitDirectory, [string]$Commit)
  if ($null -eq $testOperations) { return @(Get-HermesGitTreePaths $git $GitDirectory $Commit) }
  $paths = @('LICENSE', 'hermes.txt', 'pyproject.toml', 'uv.lock')
  if ($testOperations.scenario -eq 'git-unsafe-member') { $paths += 'CON' }
  return @($paths | ForEach-Object { [pscustomobject]@{ Mode = '100644'; Type = 'blob'; Object = ('a' * 40); Path = $_ } })
}

function Assert-SourceFileHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ($null -eq $testOperations) { Assert-ExactHash $Path $Expected $Label; return }
  $expectedContent = switch ([IO.Path]::GetFileName($Path)) { 'LICENSE' { 'synthetic-LICENSE' }; 'pyproject.toml' { 'synthetic-pyproject' }; 'uv.lock' { 'synthetic-uv-lock' }; default { throw 'Synthetic source hash path is not closed.' } }
  if ([IO.File]::ReadAllText($Path) -cne $expectedContent) { throw "$Label synthetic content mismatch." }
}

$sourceGitRunner = { param([string[]]$Arguments) @(Invoke-SourceGit $Arguments) }
$sourceTreeRunner = { param([string]$GitDirectory, [string]$Commit) @(Get-SourceTreeEntries $GitDirectory $Commit) }
$sourceHashRunner = { param([string]$Path, [string]$Expected, [string]$Label) Assert-SourceFileHash $Path $Expected $Label }

function Assert-VerifiedSource {
  param([string]$Candidate, [string]$GitStore = '')
  Assert-HermesSourceDirectory $root $Candidate $lock $GitStore $sourceHashRunner $sourceGitRunner $sourceTreeRunner
}

if ($VerifyOnly) { Invoke-WorkflowEffect 'verify-only-start'; Assert-VerifiedSource $source (Join-Path $release 'git'); Invoke-WorkflowEffect 'verify-only-complete'; exit 0 }
if (Test-Path -LiteralPath $release) { throw 'Pinned release target already exists; acquisition refuses reuse.' }
if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
Invoke-WorkflowEffect 'validated-before-root-effect'
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
  Invoke-WorkflowEffect 'git-init'; Invoke-SourceGit @((Get-HermesGitIsolationOptions) + @('init','--bare',$gitDir)) | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','core.hooksPath','NUL') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','core.bare','false') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','core.longpaths','true') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','core.autocrlf','false') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','core.safecrlf','true') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','filter.lfs.smudge','') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','filter.lfs.process','') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','filter.lfs.required','false') | Out-Null
  Invoke-SourceGit @('--git-dir',$gitDir,'config','credential.helper','') | Out-Null
  Invoke-WorkflowEffect 'git-configure'
  Invoke-WorkflowEffect 'git-add-remote'
  Invoke-SourceGit @('--git-dir',$gitDir,'remote','add','origin',$lock.remote) | Out-Null
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    Invoke-WorkflowEffect 'git-fetch'
    Invoke-SourceGit @('-c','http.version=HTTP/1.1','-c','http.lowSpeedLimit=1','-c','http.lowSpeedTime=30','--git-dir',$gitDir,'fetch','--no-tags','--depth=1','origin',("refs/tags/{0}:refs/tags/{0}" -f $lock.tag)) | Out-Null
  } finally {
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
  }
  Invoke-WorkflowEffect 'git-tree-list'
  $treeEntries = Get-SourceTreeEntries $gitDir $lock.sourceCommit
  New-Item -ItemType Directory -Path $workTree | Out-Null
  Invoke-WorkflowEffect 'git-checkout'
  Invoke-SourceGit @('-c','core.longpaths=true','--git-dir',$gitDir,'--work-tree',$workTree,'checkout','--detach','--force',$lock.sourceCommit) | Out-Null
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { Assert-SourceFileHash (Join-Path $workTree $name) $lock.rawFileSha256[$name] "Raw checkout $name" }
  Invoke-WorkflowEffect 'git-verify'
  Assert-HermesGitTranscript $lock $gitDir $workTree $sourceGitRunner $treeEntries
  if (@(Get-ChildItem -LiteralPath $workTree -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw 'Pinned source contains a reparse point.' }
  $stagedRelease = Assert-ChildPath $root (Join-Path $staging 'release')
  New-Item -ItemType Directory -Path $stagedRelease | Out-Null
  $stagedSource = Assert-ChildPath $root (Join-Path $stagedRelease 'source')
  $stagedGit = Assert-ChildPath $root (Join-Path $stagedRelease 'git')
  Move-Item -LiteralPath $workTree -Destination $stagedSource
  Move-Item -LiteralPath $gitDir -Destination $stagedGit
  Assert-VerifiedSource $stagedSource $stagedGit
  Invoke-WorkflowEffect 'staged-full-tree-verified'
  Promote-StagedDirectory $root $stagedRelease $release
  Invoke-WorkflowEffect 'move-complete'
  Assert-VerifiedSource $source (Join-Path $release 'git')
  Invoke-WorkflowEffect 'postverify-complete'
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -Recurse -ErrorAction SilentlyContinue }
  foreach ($name in $savedGitEnvironment.Keys) {
    if ($null -eq $savedGitEnvironment[$name]) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ("Env:" + $name) -Value $savedGitEnvironment[$name] }
  }
}
