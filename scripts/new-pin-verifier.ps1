<#
.SYNOPSIS
    Derives the PIN_VERIFIER_JSON secret from an owner PIN, locally.

.DESCRIPTION
    The worker never stores the PIN itself, only a PBKDF2 verifier. This script
    performs that derivation on this machine so the PIN is never transmitted,
    logged, or pasted anywhere.

    The PIN is read with -AsSecureString, so it is not echoed to the console and
    does not enter PowerShell history. Only the derived record is printed; the
    PIN cannot be recovered from it without brute-forcing 10^8 candidates at
    the configured iteration count.

    Pipe the output straight into wrangler:

        .\scripts\new-pin-verifier.ps1 | pnpm exec wrangler secret put PIN_VERIFIER_JSON

.NOTES
    Format is fixed by apps/cloud-gateway/src/security/pin-verifier.ts:
    8-digit PIN, 16-byte salt, 32-byte digest, 600,000-2,000,000 iterations.
#>
[CmdletBinding()]
param(
    # 600,000 is the floor the verifier enforces. Higher is slower to verify on
    # every call, which matters because verification happens mid-phone-call.
    [ValidateRange(600000, 2000000)]
    [int]$Iterations = 600000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SALT_BYTES = 16
$DIGEST_BYTES = 32

$secure = Read-Host -Prompt 'Owner PIN (8 digits, not echoed)' -AsSecureString

# Marshal out of the SecureString only for as long as the derivation needs it,
# then zero the unmanaged buffer. This does not make PowerShell memory-safe, but
# it avoids leaving the PIN in a plain .NET string for the GC to move around.
$pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
try {
    $pin = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
}
finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer)
}

if ($pin -notmatch '^[0-9]{8}$') {
    # Deliberately does not echo what was entered.
    throw 'PIN must be exactly 8 digits.'
}

$pinBytes = [System.Text.Encoding]::UTF8.GetBytes($pin)
$pin = $null

$salt = New-Object byte[] $SALT_BYTES
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($salt)
}
finally {
    $rng.Dispose()
}

if (($salt | Where-Object { $_ -ne 0 } | Measure-Object).Count -eq 0) {
    # Guards the exact failure that produced an all-zero "random" value earlier:
    # a silently failing RNG call leaving the buffer untouched.
    throw 'Salt generation failed: buffer is all zeros.'
}

# SHA-256 must be named explicitly. Rfc2898DeriveBytes defaults to SHA-1 on
# .NET Framework, which would derive a digest the worker rejects.
$kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
    $pinBytes,
    $salt,
    $Iterations,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
try {
    $digest = $kdf.GetBytes($DIGEST_BYTES)
}
finally {
    $kdf.Dispose()
    [Array]::Clear($pinBytes, 0, $pinBytes.Length)
}

$record = [ordered]@{
    schemaVersion = '1.0'
    algorithm     = 'pbkdf2-hmac-sha256'
    iterations    = $Iterations
    saltBase64    = [Convert]::ToBase64String($salt)
    digestBase64  = [Convert]::ToBase64String($digest)
}

# -Compress so the value is a single line, which is what wrangler expects on
# stdin and what the worker parses.
$record | ConvertTo-Json -Compress
