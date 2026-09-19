# Moved into the repo on 2026-09-18. It previously lived only in a Claude
# session's temp scratchpad, which dies with the session -- the two scripts
# that ARE the build workflow were one cleanup away from being lost.
#
# Briefs go in the relay subfolder of the scratch directory, named
# <Name>-prompt.txt, and the logs land beside them. Pass -Scratch to choose
# that directory; it defaults to the directory this script sits in.
<#
Runs one read-only audit through dsh headless using the jarvis-auditor
composition as a profile patch.

Headless has no agent-preset flag -- presets are a web-UI concept -- so the
preset's own agent.cordis.yml is layered in as a --patch. It is applied BEFORE
the run overlay so the model/effort pins still win, and DSH_PERMISSION_MODE is
deliberately NOT set to danger-full-access: read-only is the point.
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
$auditor = 'C:\Users\Sid\.dsh\.agent-presets\jarvis-auditor\agent.cordis.yml'

if (-not (Test-Path $prompt))  { throw "no prompt file at $prompt" }
if (-not (Test-Path $auditor)) { throw "no auditor composition at $auditor" }

$key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
if (-not $key) { throw 'DEEPSEEK_API_KEY is not set for this user' }
$env:DEEPSEEK_API_KEY   = $key
$env:DSH_TELEMETRY_MODE = 'off'
Remove-Item Env:DSH_PERMISSION_MODE -ErrorAction SilentlyContinue

$overlay = Join-Path $scratch ("dsh\run-$Name.yml")
@"
- id: session-telemetry-otel
  disabled: true
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: $Effort
"@ | Out-File -Encoding utf8 $overlay

$task = "Read the audit brief at $prompt and follow it exactly. It is your complete set of instructions."
$start = (Get-Date).ToUniversalTime().ToString('HH:mm')
"=== audit start $start (effort $Effort, read-only)" | Out-File -Encoding utf8 $log

Set-Location $WorkDir
& npx.cmd --yes '@deepseek-ai/dsh' --profile headless --patch $auditor --patch $overlay $task 2>&1 |
  Out-File -Encoding utf8 $out
$code = $LASTEXITCODE
$end = (Get-Date).ToUniversalTime().ToString('HH:mm')
"=== audit exit $code at $end" | Out-File -Encoding utf8 -Append $log
Write-Output "$Name finished: exit $code at $end UTC"
