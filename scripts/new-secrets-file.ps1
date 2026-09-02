<#
.SYNOPSIS
    Builds the one-time secrets file for the first Worker deploy.

.DESCRIPTION
    A new Worker cannot have secrets set before it exists, so the first deploy
    must supply them from a file. That file holds plaintext, so this script
    keeps its life as short and its handling as careful as possible:

      * peppers are generated here and never displayed, so they cannot be
        copied into a shell history, a document, or a chat;
      * the PIN is read without echo and only its PBKDF2 verifier is written;
      * the file is written outside the repository by default;
      * it is written UTF-8 without BOM, because a BOM makes wrangler reject
        the file as invalid.

    Delete the file as soon as the deploy succeeds. The script prints the exact
    command to do that.

.EXAMPLE
    .\scripts\new-secrets-file.ps1
    cd apps\cloud-gateway
    pnpm exec wrangler deploy --env="" --secrets-file "$env:TEMP\jarvis-secrets.txt"
    Remove-Item "$env:TEMP\jarvis-secrets.txt" -Force
#>
[CmdletBinding()]
param(
    # Outside the repository by default, so it cannot be committed by accident.
    [string]$OutputPath = (Join-Path $env:TEMP 'jarvis-secrets.txt'),

    [ValidateRange(600000, 2000000)]
    [int]$Iterations = 600000,

    # Not a secret: a stable identifier the owner's voice identity binds to.
    [string]$OwnerVoiceIdentityId = 'identity:owner:voice'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($OutputPath -like (Join-Path $PSScriptRoot '..' '*')) {
    Write-Warning 'Output path appears to be inside the repository. Prefer $env:TEMP.'
}

function New-Pepper {
    <#
        Generated and returned without ever being printed. Uses
        RandomNumberGenerator::Create() rather than ::Fill(), which does not
        exist on Windows PowerShell 5.1 and fails while leaving the buffer as
        32 zero bytes -- producing something that looks like a key but is a
        published constant.
    #>
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }

    if (($bytes | Where-Object { $_ -ne 0 } | Measure-Object).Count -eq 0) {
        throw 'Pepper generation failed: buffer is all zeros.'
    }
    return [Convert]::ToBase64String($bytes)
}

Write-Host 'Generating three peppers (not displayed)...'
$guestPinPepper = New-Pepper
$authBudgetPepper = New-Pepper
$identityChallengePepper = New-Pepper

if (($guestPinPepper -eq $authBudgetPepper) -or
    ($guestPinPepper -eq $identityChallengePepper) -or
    ($authBudgetPepper -eq $identityChallengePepper)) {
    # Astronomically unlikely, and a sign the RNG is broken if it happens.
    throw 'Generated peppers are not distinct; refusing to continue.'
}

Write-Host 'Deriving the PIN verifier. Choose an 8-digit PIN you will remember:'
$verifier = & (Join-Path $PSScriptRoot 'new-pin-verifier.ps1') -Iterations $Iterations
if ([string]::IsNullOrWhiteSpace($verifier)) { throw 'PIN verifier derivation produced no output.' }

# dotenv form: NAME=value, one per line, no quoting. Values are base64 or JSON
# and contain no newlines, so they need no escaping.
$lines = @(
    "PIN_VERIFIER_JSON=$verifier",
    "OWNER_VOICE_IDENTITY_ID=$OwnerVoiceIdentityId",
    "GUEST_PIN_PEPPER_V1=$guestPinPepper",
    "AUTHENTICATION_BUDGET_PEPPER=$authBudgetPepper",
    "IDENTITY_CHALLENGE_HMAC_PEPPER=$identityChallengePepper"
)

# WriteAllText with an explicit no-BOM encoding. Set-Content and Out-File add a
# BOM on Windows PowerShell, which wrangler rejects.
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, ($lines -join "`n") + "`n", $encoding)

$written = [System.IO.File]::ReadAllBytes($OutputPath)
if ($written.Length -eq 0) { throw "Wrote an empty file to $OutputPath." }

Write-Host ''
Write-Host "Wrote 5 secrets to $OutputPath ($($written.Length) bytes)."
Write-Host 'Values were not displayed. Deploy, then delete the file:'
Write-Host ''
Write-Host '  cd C:\javis\apps\cloud-gateway'
Write-Host "  pnpm exec wrangler deploy --env=`"`" --secrets-file `"$OutputPath`""
Write-Host "  Remove-Item `"$OutputPath`" -Force"
