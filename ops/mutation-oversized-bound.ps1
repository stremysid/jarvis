#Requires -Version 7.3
<#
.SYNOPSIS
    Writes a neutered copy of `ops/jarvis-boot.ps1` for the oversized-frame
    mutation.

.DESCRIPTION
    Separate from `ops/test-pc-controls.ps1` on purpose. A mutation written and
    applied inside the same script that grades it can be edited to suit, and the
    reader cannot tell by looking. This file is small enough to read in one go
    and does exactly two things:

      1. Replaces the declaration bound's *condition* with `$false`. The
         statement, its message and the `throw` all stay, so the diff is one
         token.
      2. Makes every chunked read that returns nothing report the count it had
         when it gave up, under `NO-DATA`. Without this the neutered run and the
         live run both exit 2 -- this client's code for any short read -- and the
         two are indistinguishable.

    Both replacements are asserted by count. A `Replace` that finds nothing
    returns the input unchanged, silently, which is a green mutation that mutated
    nothing.

.PARAMETER Source
    The `jarvis-boot.ps1` to copy.

.PARAMETER Destination
    Where to write the neutered copy.
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

$boundAnchor = 'if ($declared -gt $MaxFrameBytes) {'
if (-not $text.Contains($boundAnchor)) { throw "the bound anchor is gone: $boundAnchor" }
$text = $text.Replace($boundAnchor, 'if ($false) {')

# Both read loops share this line, and both are instrumented. The message
# already names the running byte count, which is what distinguishes the two
# failures: the header loop can only report the request's own size, while the
# body loop reports the header plus that -- the read a live bound prevents.
$readAnchor = 'the control endpoint closed the pipe mid-frame after $total bytes'
$occurrences = ([regex]::Matches($text, [regex]::Escape($readAnchor))).Count
if ($occurrences -ne 2) { throw "expected 2 read anchors, found $occurrences" }
# The prefix makes the two probe lines greppable without matching the untouched
# message text anywhere else in the file.
$text = $text.Replace($readAnchor, 'NO-DATA after $total bytes')

Set-Content -LiteralPath $Destination -Value $text -NoNewline
Write-Output "neutered copy written: $Destination"
