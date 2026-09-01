[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [switch]$VerifyOnly,
  [string]$TestEffectLog = '',
  [string]$TestOperationFixture = '',
  [ValidateRange(0,10000)][int]$TestHoldLockMilliseconds = 0,
  [ValidateSet('', 'before-staging-parent', 'before-stage-create', 'before-git-init', 'before-checkout', 'before-git-workspace-process-start', 'during-git-fetch-writable-window', 'before-internal-source-move', 'before-internal-git-move', 'before-final-promotion', 'before-source-rollback', 'during-internal-source-parent-window', 'during-internal-git-parent-window', 'during-final-promotion-parent-window', 'during-source-rollback-parent-window')][string]$TestPauseAfterEffect = '',
  [string]$TestEffectAck = '',
  [ValidateSet('', 'validated-before-root-effect', 'git-init', 'staged-full-tree-verified', 'move-complete', 'postverify-complete')][string]$FailAfterEffect = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRuntime.psm1') -Force

$repoRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
$lockPath = Join-Path $repoRoot 'hermes-source-lock.json'
$lock = Get-Manifest $lockPath 'b5b1e79e797baffaba18aa5099f79c88f9293dd82b8c529a2402133dc56e2fb7' 'Hermes source lock'
Assert-HermesSourceLock $lock
$root = Assert-HermesExactRuntimeRoot $RuntimeRoot
$testOperations = $null
if ([string]::IsNullOrEmpty($TestOperationFixture) -and (-not [string]::IsNullOrEmpty($TestEffectLog) -or -not [string]::IsNullOrEmpty($TestPauseAfterEffect) -or -not [string]::IsNullOrEmpty($TestEffectAck) -or -not [string]::IsNullOrEmpty($FailAfterEffect) -or $TestHoldLockMilliseconds -ne 0)) { throw 'Test hooks require a closed operation fixture.' }
if (-not [string]::IsNullOrEmpty($TestOperationFixture)) {
  $fixturePath = Assert-ChildPath $root $TestOperationFixture
  if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw 'Test operation fixture is absent.' }
  $testOperations = Get-Manifest $fixturePath
  $fixtureKeys = @($testOperations.Keys | Sort-Object)
  $sourceFixtureScenarios = @('success', 'manifest-drift', 'git-hostile-environment', 'git-remote-drift', 'git-tag-drift', 'git-peeled-drift', 'git-tree-drift', 'git-unsafe-member', 'source-hash-drift', 'source-stage-hardlink', 'source-stage-ads', 'source-final-rollback-failure', 'git-dirty')
  if (($fixtureKeys -join ',') -ne 'scenario,schemaVersion,workflow' -or $testOperations.schemaVersion -ne 1 -or $testOperations.workflow -ne 'source' -or $testOperations.scenario -notin $sourceFixtureScenarios) { throw 'Test operation fixture is not a closed source fixture.' }
  [void](Assert-HermesTestFixtureRoot $root)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [void](Assert-ChildPath $root $TestEffectLog) }
  if (-not [string]::IsNullOrEmpty($TestPauseAfterEffect)) {
    if ([string]::IsNullOrEmpty($TestEffectLog) -or [string]::IsNullOrEmpty($TestEffectAck)) { throw 'A deterministic test pause requires exact effect-log and acknowledgement paths.' }
    [void](Assert-ChildPath $root $TestEffectAck)
    if (Test-Path -LiteralPath $TestEffectAck) { throw 'Deterministic test acknowledgement path must start absent.' }
  } elseif (-not [string]::IsNullOrEmpty($TestEffectAck)) { throw 'A deterministic test acknowledgement is invalid without a selected pause boundary.' }
  if ($testOperations.scenario -eq 'manifest-drift') { $driftedLock = @{} + $lock; $driftedLock.remote = 'https://example.invalid/hermes.git'; Assert-HermesSourceLock $driftedLock }
}
$release = Assert-ChildPath $root (Join-Path $root (Join-Path 'releases' $lock.sourceCommit))
$source = Assert-ChildPath $root (Join-Path $release 'source')
$git = if ($null -eq $testOperations) { Get-HermesTrustedGitExecutable } else { 'synthetic-git' }
function Invoke-WorkflowEffect {
  param([string]$Name)
  if (-not [string]::IsNullOrEmpty($TestEffectLog)) { [IO.File]::AppendAllText($TestEffectLog, ($Name + "`n"), [Text.UTF8Encoding]::new($false)) }
  if ($TestPauseAfterEffect -eq $Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $TestEffectAck -PathType Leaf)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for deterministic test acknowledgement: $Name" }
      Start-Sleep -Milliseconds 20
    }
    $ackGuard = Open-HermesSafeIdentity $TestEffectAck
    try { $ackBytes = [IO.File]::ReadAllBytes($TestEffectAck) } finally { $ackGuard.Dispose() }
    try { $ackText = [Text.UTF8Encoding]::new($false, $true).GetString($ackBytes) } catch { throw 'Deterministic test acknowledgement must be canonical UTF-8.' }
    if ($ackText -cne "continue`n") { throw 'Deterministic test acknowledgement has invalid content.' }
  }
  if ($FailAfterEffect -eq $Name) { throw "Injected workflow failure: $Name" }
}

function Invoke-TestPauseBoundary {
  param([string]$Name)
  if ($TestPauseAfterEffect -eq $Name) { Invoke-WorkflowEffect $Name }
}

function Invoke-SourceGit {
  param([string[]]$Arguments)
  if ($null -eq $testOperations) { return @(Invoke-GitChecked $git $Arguments $leaseContext) }
  if ($Arguments -contains 'export-blobs') {
    $workTreeIndex = [Array]::IndexOf($Arguments, '--work-tree')
    $gitDirectoryIndex = [Array]::IndexOf($Arguments, '--git-dir')
    if ($workTreeIndex -lt 0 -or $workTreeIndex + 1 -ge $Arguments.Count) { throw 'Synthetic Git export has no work tree.' }
    if ($gitDirectoryIndex -lt 0 -or $gitDirectoryIndex + 1 -ge $Arguments.Count) { throw 'Synthetic Git export has no object store.' }
    $workTreePath = [string]$Arguments[$workTreeIndex + 1]
    foreach ($entry in ([ordered]@{ 'LICENSE' = 'synthetic-LICENSE'; 'pyproject.toml' = 'synthetic-pyproject'; 'uv.lock' = 'synthetic-uv-lock'; 'hermes.txt' = 'synthetic-source-tree' }).GetEnumerator()) {
      $content = if ($testOperations.scenario -eq 'source-hash-drift' -and $entry.Key -eq 'LICENSE') { 'hostile-source-drift' } else { [string]$entry.Value }
      Write-HermesContainedTextCreateNew $leaseContext (Join-Path $workTreePath $entry.Key) $content
    }
    if ($testOperations.scenario -eq 'git-dirty') { Write-HermesContainedTextCreateNew $leaseContext (Join-Path $workTreePath 'untracked.txt') 'synthetic-untracked' }
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
  if ($null -eq $testOperations) { return @(Get-HermesGitTreePaths $git $GitDirectory $Commit $leaseContext) }
  $contents = [ordered]@{ 'LICENSE' = 'synthetic-LICENSE'; 'hermes.txt' = 'synthetic-source-tree'; 'pyproject.toml' = 'synthetic-pyproject'; 'uv.lock' = 'synthetic-uv-lock' }
  if ($testOperations.scenario -eq 'git-unsafe-member') { $contents['CON'] = 'synthetic-unsafe-member' }
  return @($contents.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Mode = '100644'; Type = 'blob'; Object = Get-HermesGitBlobObjectIdFromBytes ([Text.UTF8Encoding]::new($false).GetBytes([string]$_.Value)); Path = [string]$_.Key } })
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
$sourceWorkTreeRunner = {
  param([string]$GitDirectory, [string]$WorkTree, [string]$Commit, [object[]]$Entries)
  foreach ($entry in $Entries) {
    $candidateFile = Assert-ChildPath $root (Join-Path $WorkTree ([string]$entry.Path).Replace('/', '\'))
    if ((Get-HermesGitBlobObjectId $candidateFile) -cne [string]$entry.Object) { throw 'Pinned source Git blob mismatch.' }
  }
}

function Assert-VerifiedSource {
  param([string]$Candidate, [string]$GitStore = '')
  if (-not [string]::IsNullOrEmpty($GitStore)) { Assert-HermesGitConfig $root $GitStore $lock.remote }
  Assert-HermesSourceDirectory $root $Candidate $lock $GitStore $sourceHashRunner $sourceGitRunner $sourceTreeRunner $sourceWorkTreeRunner $leaseContext
}

$workflowLock = Enter-HermesWorkflowLock $root
$leaseContext = New-HermesWriteContainmentContext $root $workflowLock
$gitWritableDirectories = @('branches','hooks','info','objects','objects\info','objects\pack','refs','refs\heads','refs\tags')
try {
if ($TestHoldLockMilliseconds -gt 0) { Start-Sleep -Milliseconds $TestHoldLockMilliseconds }
if ($VerifyOnly) { Assert-NoHermesContainedScratchResidue $leaseContext } else { Clear-HermesContainedScratchResidue $leaseContext }
Assert-NoHermesWorkflowResidue $root
if ($VerifyOnly) { Assert-VerifiedSource $source (Join-Path $release 'git'); Invoke-WorkflowEffect 'verify-only-start'; Invoke-WorkflowEffect 'verify-only-complete'; exit 0 }
if (Test-Path -LiteralPath $release) { throw 'Pinned release target already exists; acquisition refuses reuse.' }
Invoke-WorkflowEffect 'validated-before-root-effect'
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RuntimeRoot is a reparse point.' }

$stagingParent = Assert-ChildPath $root (Join-Path $root '.s')
[void](New-HermesLeasedDirectory $leaseContext $stagingParent)
Invoke-TestPauseBoundary 'before-stage-create'
$staging = Assert-ChildPath $root (Join-Path $stagingParent ([guid]::NewGuid().ToString('N')))
if (Test-Path -LiteralPath $staging) { throw 'Fresh staging path already exists.' }
$stagedRelease = Assert-ChildPath $root (Join-Path $staging 'release')
$releasePromoted = $false
$preserveStaging = $false
$sourceFailure = $null
try {
  [void](New-HermesLeasedDirectory $leaseContext $staging -FreshLeaf)
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'git-hostile-environment') {
    $probe = Join-Path $staging 'closed-environment-probe.git'
    [void](New-HermesLeasedDirectory $leaseContext $probe -FreshLeaf)
    foreach ($relative in $gitWritableDirectories) { [void](New-HermesLeasedDirectory $leaseContext (Join-Path $probe $relative)) }
    Write-HermesContainedTextCreateNew $leaseContext (Join-Path $probe 'config') (Get-HermesCanonicalGitConfig $lock.remote)
    Write-HermesContainedTextCreateNew $leaseContext (Join-Path $probe 'HEAD') "$($lock.sourceCommit)`n"
    $probeConfigGuard = Open-HermesSafeIdentity (Join-Path $probe 'config')
    $probeHeadGuard = Open-HermesSafeIdentity (Join-Path $probe 'HEAD')
    try {
      $probeResult = @(Invoke-GitChecked (Get-HermesTrustedGitExecutable) @('--git-dir', $probe, 'rev-parse', '--git-dir') $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name })
      if ($probeResult.Count -ne 1) { throw 'Closed Git environment probe returned an invalid object-store identity.' }
    } finally { $probeHeadGuard.Dispose(); $probeConfigGuard.Dispose() }
    [void](Add-HermesDirectoryTreeLeases $leaseContext $probe)
    Assert-HermesGitConfig $root $probe $lock.remote
    Assert-HermesDetachedHead $probe $lock.sourceCommit
    Remove-HermesContainedTreeNoFollow $leaseContext $probe
  }
  $gitDir = Join-Path $staging 'git'
  $workTree = Join-Path $staging 'source'
  [void](New-HermesLeasedDirectory $leaseContext $gitDir -FreshLeaf -MovableLeaf)
  foreach ($relative in $gitWritableDirectories) { [void](New-HermesLeasedDirectory $leaseContext (Join-Path $gitDir $relative)) }
  Invoke-TestPauseBoundary 'before-git-init'
  Invoke-WorkflowEffect 'git-init'
  Write-HermesContainedTextCreateNew $leaseContext (Join-Path $gitDir 'config') (Get-HermesCanonicalGitConfig $lock.remote)
  Write-HermesContainedTextCreateNew $leaseContext (Join-Path $gitDir 'HEAD') "$($lock.sourceCommit)`n"
  Invoke-WorkflowEffect 'git-configure'
  Invoke-WorkflowEffect 'git-add-remote'
  Assert-HermesGitConfig $root $gitDir $lock.remote
  Assert-HermesDetachedHead $gitDir $lock.sourceCommit
  $configGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'config')
  $headGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'HEAD')
  try {
    [void](Enter-HermesGitWritableDirectoryTree $leaseContext $gitDir)
    try {
      Invoke-TestPauseBoundary 'during-git-fetch-writable-window'
      Invoke-WorkflowEffect 'git-fetch'
      $fetchArguments = @('-c','http.version=HTTP/1.1','-c','http.lowSpeedLimit=1','-c','http.lowSpeedTime=30','-c','fetch.unpackLimit=1','-c','transfer.unpackLimit=1','-c','gc.auto=0','-c','maintenance.auto=false','-c','fetch.writeCommitGraph=false','-c','core.logAllRefUpdates=false','--git-dir',$gitDir,'fetch','--no-tags','--no-write-fetch-head','--no-recurse-submodules','--refmap=','origin',("refs/tags/{0}" -f $lock.tag))
      if ($null -eq $testOperations) { [void](Invoke-GitChecked $git $fetchArguments $leaseContext { param([string]$Name) Invoke-TestPauseBoundary $Name }) }
      else { Invoke-SourceGit $fetchArguments | Out-Null }
    } finally { [void](Exit-HermesGitWritableDirectoryTree $leaseContext $gitDir) }
  } finally { $headGuard.Dispose(); $configGuard.Dispose() }
  [void](Add-HermesDirectoryTreeLeases $leaseContext $gitDir)
  $verifyConfigGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'config')
  $verifyHeadGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'HEAD')
  try {
    if ((Invoke-SourceGit @('--git-dir', $gitDir, 'cat-file', '-t', $lock.tagObject)) -cne 'tag') { throw 'Fetched Hermes tag object is not annotated.' }
    if ((Invoke-SourceGit @('--git-dir', $gitDir, 'rev-parse', ("{0}^{{tag}}" -f $lock.tagObject))) -cne $lock.tagObject) { throw 'Fetched Hermes tag object mismatch.' }
    if ((Invoke-SourceGit @('--git-dir', $gitDir, 'rev-parse', ("{0}^{{}}" -f $lock.tagObject))) -cne $lock.sourceCommit) { throw 'Fetched Hermes tag was retargeted.' }
    if ((Invoke-SourceGit @('--git-dir', $gitDir, 'rev-parse', ("{0}^{{tree}}" -f $lock.sourceCommit))) -cne $lock.sourceTree) { throw 'Fetched Hermes source tree mismatch.' }
  } finally { $verifyHeadGuard.Dispose(); $verifyConfigGuard.Dispose() }
  Write-HermesContainedTextCreateNew $leaseContext (Join-Path $gitDir ("refs\tags\{0}" -f $lock.tag)) "$($lock.tagObject)`n"
  [void](Add-HermesDirectoryTreeLeases $leaseContext $gitDir)
  Invoke-WorkflowEffect 'git-tree-list'
  $treeConfigGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'config')
  $treeHeadGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'HEAD')
  $treeTagGuard = Open-HermesSafeIdentity (Join-Path $gitDir ("refs\tags\{0}" -f $lock.tag))
  try { $treeEntries = Get-SourceTreeEntries $gitDir $lock.sourceCommit }
  finally { $treeTagGuard.Dispose(); $treeHeadGuard.Dispose(); $treeConfigGuard.Dispose() }
  [void](New-HermesLeasedDirectory $leaseContext $workTree -FreshLeaf -MovableLeaf)
  $checkoutDirectories = @($treeEntries | ForEach-Object {
    $parts = ([string]$_.Path) -split '/'
    for ($index = 1; $index -lt $parts.Count; $index++) { $parts[0..($index - 1)] -join '\' }
  } | Sort-Object -Unique)
  foreach ($relative in $checkoutDirectories) { [void](New-HermesLeasedDirectory $leaseContext (Join-Path $workTree $relative)) }
  [void](Enter-HermesGitWritableDirectoryTree $leaseContext $workTree)
  try {
    Invoke-TestPauseBoundary 'before-checkout'
    Invoke-WorkflowEffect 'git-checkout'
    $exportConfigGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'config')
    $exportHeadGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'HEAD')
    $exportTagGuard = Open-HermesSafeIdentity (Join-Path $gitDir ("refs\tags\{0}" -f $lock.tag))
    try {
      if ($null -eq $testOperations) { Export-HermesGitBlobsNoClobber $git $gitDir $workTree $treeEntries $leaseContext }
      else { Invoke-SourceGit @('--git-dir',$gitDir,'--work-tree',$workTree,'export-blobs') | Out-Null }
    } finally { $exportTagGuard.Dispose(); $exportHeadGuard.Dispose(); $exportConfigGuard.Dispose() }
  } finally {
    [void](Exit-HermesGitWritableDirectoryTree $leaseContext $workTree)
  }
  [void](Add-HermesDirectoryTreeLeases $leaseContext $workTree)
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'source-stage-hardlink') { Remove-Item -LiteralPath (Join-Path $workTree 'hermes.txt') -Force; New-Item -ItemType HardLink -Path (Join-Path $workTree 'hermes.txt') -Target (Join-Path $workTree 'LICENSE') | Out-Null }
  if ($null -ne $testOperations -and $testOperations.scenario -eq 'source-stage-ads') { Set-Content -LiteralPath (Join-Path $workTree 'hermes.txt') -Stream hostile -Value 'hostile' -NoNewline }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) { Assert-SourceFileHash (Join-Path $workTree $name) $lock.rawFileSha256[$name] "Raw checkout $name" }
  Invoke-WorkflowEffect 'git-verify'
  $transcriptConfigGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'config')
  $transcriptHeadGuard = Open-HermesSafeIdentity (Join-Path $gitDir 'HEAD')
  $transcriptTagGuard = Open-HermesSafeIdentity (Join-Path $gitDir ("refs\tags\{0}" -f $lock.tag))
  try { Assert-HermesGitTranscript $lock $gitDir $workTree $sourceGitRunner $treeEntries }
  finally { $transcriptTagGuard.Dispose(); $transcriptHeadGuard.Dispose(); $transcriptConfigGuard.Dispose() }
  Assert-HermesSafeTree $root $workTree 'Pinned source checkout' $leaseContext
  [void](New-HermesLeasedDirectory $leaseContext $stagedRelease -FreshLeaf -MovableLeaf)
  $stagedSource = Assert-ChildPath $root (Join-Path $stagedRelease 'source')
  $stagedGit = Assert-ChildPath $root (Join-Path $stagedRelease 'git')
  Invoke-TestPauseBoundary 'before-internal-source-move'
  Move-HermesLeasedDirectoryNoReplace $leaseContext $workTree $stagedSource { Invoke-TestPauseBoundary 'during-internal-source-parent-window' }
  Invoke-TestPauseBoundary 'before-internal-git-move'
  Move-HermesLeasedDirectoryNoReplace $leaseContext $gitDir $stagedGit { Invoke-TestPauseBoundary 'during-internal-git-parent-window' }
  Assert-VerifiedSource $stagedSource $stagedGit
  Invoke-WorkflowEffect 'staged-full-tree-verified'
  [void](New-HermesLeasedDirectory $leaseContext ([IO.Directory]::GetParent($release).FullName))
  Invoke-TestPauseBoundary 'before-final-promotion'
  $finalValidationBoundary = if ($null -ne $testOperations -and $testOperations.scenario -eq 'source-final-rollback-failure') {
    {
      param([string]$Relative)
      [void](New-Item -ItemType Directory -Path $stagedRelease)
      throw 'Injected source post-move validation fault.'
    }.GetNewClosure()
  } else { $null }
  Promote-StagedDirectory $root $stagedRelease $release $leaseContext { Invoke-TestPauseBoundary 'during-final-promotion-parent-window' } $finalValidationBoundary
  $releasePromoted = $true
  Invoke-WorkflowEffect 'move-complete'
  Assert-VerifiedSource $source (Join-Path $release 'git')
  Invoke-WorkflowEffect 'postverify-complete'
} catch {
  $original = $_
  $sourceFailure = $original
  $releaseExists = Test-Path -LiteralPath $release
  $stagedReleaseExists = Test-Path -LiteralPath $stagedRelease
  if ($releaseExists -and -not $stagedReleaseExists) {
    try {
      [void](New-HermesLeasedDirectory $leaseContext ([IO.Directory]::GetParent($stagedRelease).FullName))
      Invoke-TestPauseBoundary 'before-source-rollback'
      Move-HermesLeasedDirectoryNoReplace $leaseContext $release $stagedRelease { Invoke-TestPauseBoundary 'during-source-rollback-parent-window' }
      $releasePromoted = $false
    } catch {
      $preserveStaging = $true
      $message = "Source acquisition failed: $($sourceFailure.Exception.Message) Exact source rollback also failed closed."
      throw [InvalidOperationException]::new($message, $sourceFailure.Exception)
    }
  } elseif ($releaseExists) {
    $preserveStaging = $true
  }
  throw $original
} finally {
  $stagingCleanupFailure = $null
  try {
    if (-not $preserveStaging -and (Test-Path -LiteralPath $staging)) { Remove-HermesContainedTreeNoFollow $leaseContext $staging }
    if (-not $preserveStaging -and (Test-Path -LiteralPath $stagingParent)) {
      if (@(Get-ChildItem -LiteralPath $stagingParent -Force).Count -eq 0) { Remove-HermesContainedTreeNoFollow $leaseContext $stagingParent }
      if (Test-Path -LiteralPath $stagingParent) { if (@(Get-ChildItem -LiteralPath $stagingParent -Force).Count -eq 0) { throw 'Empty source staging parent cleanup failed.' } }
    }
  } catch {
    $stagingCleanupFailure = $_
  }
  if ($null -ne $stagingCleanupFailure) {
    if ($null -ne $sourceFailure) {
      $message = "Source acquisition failed: $($sourceFailure.Exception.Message) Source staging cleanup also failed closed."
      throw [InvalidOperationException]::new($message, $sourceFailure.Exception)
    }
    throw [InvalidOperationException]::new('Source staging cleanup failed closed.', $stagingCleanupFailure.Exception)
  }
}
} finally {
  try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() }
}
