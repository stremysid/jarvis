#Requires -Version 7.3
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$Publish)

$ErrorActionPreference = 'Stop'
# Keep this entry point independent of gateway deployment and migration logic.
$PSNativeCommandArgumentPassing = 'Standard'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $repositoryRoot 'node_modules/wrangler/bin/wrangler.js'
$config = Join-Path $repositoryRoot 'apps/watchdog/wrangler.toml'
if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw 'Install the pinned workspace dependencies with pnpm install --frozen-lockfile first.'
}

$deployArguments = @($wrangler, 'deploy', '--config', $config, '--env', '', '--keep-vars', '--strict', '--no-autoconfig')
if (-not $Publish) {
    $deployArguments += '--dry-run'
} elseif (-not $PSCmdlet.ShouldProcess('jarvis-watchdog (top-level production)', 'Deploy Worker')) {
    return
}

if ($Publish) {
    # The same revision check as scripts/deploy.ps1, transcribed rather than shared so this entry
    # point stays independent of the gateway's. A publish ships origin/main, committed, or nothing.
    & git -C $repositoryRoot fetch --quiet origin main
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin/main, so the revision to publish cannot be checked.' }
    $revision = & git -C $repositoryRoot rev-parse HEAD
    $main = & git -C $repositoryRoot rev-parse origin/main
    $changed = & git -C $repositoryRoot status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$' -or $revision -ne $main -or $changed) {
        throw "Refusing to publish: HEAD is $revision, origin/main is $main$(if ($changed) { ', and tracked files have uncommitted changes' }). Check out origin/main in a clean tree first."
    }
    Write-Host "Publishing $revision, which is origin/main."
}

Push-Location $repositoryRoot
try {
    & node @deployArguments
    if ($LASTEXITCODE -ne 0) { throw "Watchdog deployment command failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}
