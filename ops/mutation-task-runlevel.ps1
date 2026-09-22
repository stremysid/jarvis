#Requires -Version 7.3
<#
.SYNOPSIS
    Writes a copy of `ops/jarvis-logon-task.ps1` that asks for the wrong run
    level, for the structural half of the mutation check.

.DESCRIPTION
    Separate from `ops/test-pc-controls.ps1` for the same reason as
    `ops/mutation-oversized-bound.ps1`: a mutation written inside the script that
    grades it can be edited to suit.

    One replacement: the default of `$RunLevel` becomes `Limited`. That is the
    single setting the whole boot chain turns on -- without it the task starts
    un-elevated and every privileged thing the agent tries fails on a machine
    nobody is watching.

    A `Replace` that finds nothing returns the input unchanged, silently, which
    is a green mutation that mutated nothing, so the anchor is asserted by count.
    `ValidateSet` is deliberately left alone: the point is a script that still
    runs and still registers, asking for the wrong level.

.PARAMETER Source
    The `jarvis-logon-task.ps1` to copy.

.PARAMETER Destination
    Where to write the mutated copy.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Source,

    [Parameter(Mandatory)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "not a file: $Source" }

$text = Get-Content -LiteralPath $Source -Raw

$defaultAnchor = "[string]`$RunLevel = 'Highest'"
$occurrences = ([regex]::Matches($text, [regex]::Escape($defaultAnchor))).Count
if ($occurrences -ne 1) { throw "expected 1 occurrence of the run-level default, found $occurrences" }
$text = $text.Replace($defaultAnchor, "[string]`$RunLevel = 'Limited'")

Set-Content -LiteralPath $Destination -Value $text -NoNewline
Write-Output "mutated copy written: $Destination"
