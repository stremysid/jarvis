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
the run overlay so the model/effort pins still win.

READ-ONLY IS ARRANGED IN TWO HALVES AND THIS FILE OWNS ONE OF THEM.

DSH_PERMISSION_MODE is set to read-only below, and that is load-bearing rather
than belt-and-braces. The host composition mounts @deepseek-ai/dsh-sandbox-policy
with `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`, and the auditor
preset deliberately does NOT mount that plugin itself: doing so made the preset
unloadable with `service "sandboxPolicy" has been registered`, and the UI refused
to switch to Jarvis Auditor at all. See the note in
~/.dsh/.agent-presets/jarvis-auditor/agent.cordis.yml.

The preset's half is disabling `dsh-permission-presets`, the only plugin that
emits a `sandbox/mode` event. Without that, a session override would outrank this
default and a UI picker could raise the run to full access.

So: do not remove the variable, and do not re-add a sandbox row to the preset.
Together they are the difference between an auditor that is read-only by default
and one that is read-only by construction.
#>
param(
  [Parameter(Mandatory)] [string] $Name,
  [ValidateSet('off','low','high','max')] [string] $Effort = 'high',
  # C:\javis, not a scratch clone. This previously defaulted to
  # C:\Users\Sid\OneDrive\Documents\ChatGPT\jarvis, which looked like a repo and
  # was one -- 449 commits behind main, on a branch from an abandoned increment,
  # with neither the roadmap nor the memory tools in it. An audit launched with
  # that default would have measured a state that does not exist and reported it
  # confidently. The live checkout is the authoritative tree, and the read-only
  # mode above is what makes reading it safe.
  [string] $WorkDir = 'C:\javis',
  [string] $Scratch
)
$ErrorActionPreference = 'Stop'
$scratch = if ($Scratch) { $Scratch } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$prompt  = Join-Path $scratch "relay\$Name-prompt.txt"
$log     = Join-Path $scratch "relay\$Name.log"
$out     = Join-Path $scratch "relay\$Name-attempt1.log"
$auditor = 'C:\Users\Sid\.dsh\.agent-presets\jarvis-auditor\agent.cordis.yml'

# Both directories are created rather than assumed. This script writes into
# `$scratch\relay\` and `$scratch\dsh\` and used to create neither, so it only
# ever worked against a scratch directory somebody had already populated by
# hand. Pointed at a fresh one it died at the overlay write with
# "Could not find a part of the path ...\dsh\run-<name>.yml" -- which is what
# happens the first time anyone runs an audit in a new scratch directory.
foreach ($directory in @((Join-Path $scratch 'relay'), (Join-Path $scratch 'dsh'))) {
  if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
}

if (-not (Test-Path $prompt))  { throw "no prompt file at $prompt" }
if (-not (Test-Path $auditor)) { throw "no auditor composition at $auditor" }

$key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
if (-not $key) { throw 'DEEPSEEK_API_KEY is not set for this user' }
$env:DEEPSEEK_API_KEY   = $key
$env:DSH_TELEMETRY_MODE = 'off'
# Set, never removed. This is the auditor's whole read-only guarantee: the host
# composition reads it, and the preset has no sandbox row to fall back on.
$env:DSH_PERMISSION_MODE = 'read-only'

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
