# Moved into the repo on 2026-09-18. It previously lived only in a Claude
# session's temp scratchpad, which dies with the session -- the two scripts
# that ARE the build workflow were one cleanup away from being lost.
#
# Briefs go in the relay subfolder of the scratch directory, named
# <Name>-prompt.txt, and the logs land beside them. Pass -Scratch to choose
# that directory; it defaults to the directory this script sits in.
<#
Runs one queued builder prompt through DeepSeek Harness (dsh) headless.

Why PowerShell: invoking the npx shim from Git Bash dies instantly with
"'C:\Program' is not recognized" before dsh even starts. Native shell only.

Usage:
  pwsh -NoProfile -File dsh-relay.ps1 -Name pr91-round3 [-Effort max]
#>
param(
  [Parameter(Mandatory)] [string] $Name,
  [ValidateSet('off','low','high','max')] [string] $Effort = 'high',
  [string] $WorkDir = 'C:\Users\Sid\OneDrive\Documents\ChatGPT\jarvis',
  [string] $Scratch
)
$ErrorActionPreference = 'Stop'

$scratch = if ($Scratch) { $Scratch } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$prompt  = Join-Path $scratch "relay\$Name-prompt.txt"
$log     = Join-Path $scratch "relay\$Name.log"
$out     = Join-Path $scratch "relay\$Name-attempt1.log"
$patch   = Join-Path $scratch "dsh\no-telemetry.yml"
$builder = 'C:\Users\Sid\.dsh\.agent-presets\jarvis-builder\agent.cordis.yml'

if (-not (Test-Path $prompt))  { throw "no prompt file at $prompt" }
# The Jarvis Builder preset carries the standing rules: Windows/pwsh only,
# worktree-only and never the live checkout, verify-do-not-trust,
# mutation-verified guards, the four known-failing hermes-runtime tests, and
# the end-of-task AGENT_LOG entry. Until 2026-09-18 this script did NOT layer
# it, so every headless builder ran on the default composition and those
# rules existed only in whatever the brief happened to repeat. Presets are a
# web-UI concept and headless has no flag for them, so it goes in as a
# --patch, exactly as dsh-audit.ps1 does with the auditor.
if (-not (Test-Path $builder)) { throw "no builder preset at $builder" }

$key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
if (-not $key) { throw 'DEEPSEEK_API_KEY is not set for this user' }
$env:DEEPSEEK_API_KEY = $key

# danger-full-access sets approval policy to "never", which is what makes an
# unattended run possible at all. The builder is still bound by the standing
# rules in its prompt: never merge, deploy, apply migrations or touch secrets.
$env:DSH_PERMISSION_MODE = 'danger-full-access'
$env:DSH_TELEMETRY_MODE  = 'off'

# Effort is an adapter-level setting keyed `reasoningEffort` on
# agent-default-model (see ~/.dsh/settings.yaml, which is where the web UI
# stores it). Written as a per-run overlay so the wrapper never mutates Sid's
# saved settings.
$overlay = Join-Path $scratch ("dsh" + [IO.Path]::DirectorySeparatorChar + "run-$Name.yml")
@"
- id: session-telemetry-otel
  disabled: true
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: $Effort
"@ | Out-File -Encoding utf8 $overlay

# The brief is NOT passed as a command-line argument. npx.cmd is a cmd shim, and
# cmd truncates the argument at the first & < > or | -- on 2026-09-18 a brief
# arrived cut off at its first "&" and the builder ran with almost no
# instructions. Point the agent at the file instead; the path has none of those
# characters.
$task = "Read the build brief at $prompt and follow it exactly. It is your complete set of instructions. Do not infer scope from the branch name."
$start = (Get-Date).ToUniversalTime().ToString('HH:mm')
"=== dsh attempt 1 start $start (effort $Effort)" | Out-File -Encoding utf8 $log

Set-Location $WorkDir
# Preset first, run overlay second, so the model and effort pins still win.
& npx.cmd --yes '@deepseek-ai/dsh' --profile headless --patch $builder --patch $overlay $task 2>&1 |
  Out-File -Encoding utf8 $out
$code = $LASTEXITCODE

$end = (Get-Date).ToUniversalTime().ToString('HH:mm')
"=== dsh attempt 1 exit $code at $end" | Out-File -Encoding utf8 -Append $log
"=== $Name finished $end"              | Out-File -Encoding utf8 -Append $log
Write-Output "$Name finished: exit $code at $end UTC"
