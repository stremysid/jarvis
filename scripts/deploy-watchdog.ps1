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

Push-Location $repositoryRoot
try {
    & node @deployArguments
    if ($LASTEXITCODE -ne 0) { throw "Watchdog deployment command failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}
