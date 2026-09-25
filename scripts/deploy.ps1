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

if ($Publish) {
    # A publish ships whatever this checkout holds, and used to report success either way: a stale
    # or dirty C:\javis put older code in production with nothing saying so. So it ships origin/main,
    # committed, or nothing. Untracked files are not checked because the bundle is only what
    # src/index.ts imports, and tracked code cannot import a file that is not tracked.
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
    # Invoke Node directly: a pnpm.cmd hop would parse the empty argument again.
    & node @deployArguments
    if ($LASTEXITCODE -ne 0) { throw "Gateway deployment command failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}
