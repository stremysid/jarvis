#Requires -Version 7.3
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$Publish)

$ErrorActionPreference = 'Stop'
# Standard preserves the empty environment value; Windows PowerShell drops it.
$PSNativeCommandArgumentPassing = 'Standard'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $repositoryRoot 'node_modules/wrangler/bin/wrangler.js'
$config = Join-Path $repositoryRoot 'apps/cloud-gateway/wrangler.toml'
if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw 'Install the pinned workspace dependencies with pnpm install --frozen-lockfile first.'
}

$deployArguments = @($wrangler, 'deploy', '--config', $config, '--env', '', '--keep-vars', '--strict', '--no-autoconfig')
if (-not $Publish) {
    $deployArguments += '--dry-run'
} elseif (-not $PSCmdlet.ShouldProcess('jarvis-cloud-gateway (top-level production)', 'Deploy Worker')) {
    return
}

Push-Location $repositoryRoot
try {
    # Invoke Node directly: a pnpm.cmd hop would parse the empty argument again.
    & node @deployArguments
    if ($LASTEXITCODE -ne 0) { throw "Gateway deployment command failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}
