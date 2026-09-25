#Requires -Version 7.3
<#
.SYNOPSIS
    Register, inspect or remove the Winlogon auto-login that puts Jarvis's host on
    the desktop with no morning input.

.DESCRIPTION
    The machine Sid uses is a Windows 11 home PC with one local account, `Sid`. The
    boot chain P1 asks for is: power on -> the desktop appears with nobody at the
    keyboard -> the logon-triggered scheduled task starts `ops/jarvis-boot.ps1`
    elevated. Windows only performs the middle step from these four values under
    `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`.

    The password is the whole reason this file is not a one-liner. Four ways to
    store it were considered, and three were rejected:

      * `DefaultPassword` (what this script does). A REG_SZ in the registry,
        readable by any process running as this user or as an administrator.
        Rejected nowhere else that matters, but note it is plaintext at rest and
        anything with the registry can read it back.
      * The LSA secret, written by Sysinternals `Autologon.exe` and by
        `DefaultPassword`'s own first-boot migration. This is the form Microsoft
        itself documents as the *supported* one, and it is why Windows deletes
        `DefaultPassword` after a successful auto-logon. It is preferred in
        principle and unavailable in practice here: it needs a downloaded
        third-party executable run on the live machine, and this repository may
        not fetch or install one. Sysinternals is a Microsoft download, so this
        is a bar the owner can clear in one sitting -- see
        `docs/runbooks/pc-boot-chain.md`.
      * DPAPI (`crypto/dpapi.py`). The right answer for a secret Jarvis itself
        holds, and the wrong answer here: the password must be readable by
        `winlogon.exe` before any user profile is loaded, and DPAPI
        machine-scope is a different store than the one the agent uses.
      * Group Policy / an answer file. Not available on Windows 11 Home.

    So the choice is `DefaultPassword` now, with the LSA secret named in the
    runbook as the upgrade that removes the plaintext copy. Both end with the
    same four registry values and the same desktop.

    Nothing in this file prints the password. `-Status` reports *that* one is
    configured, and the length of nothing; the read-back is a boolean.

.PARAMETER Status
    Report the current auto-login configuration. Read-only, works unelevated, and
    is the only mode that does not need the four values.

.PARAMETER Remove
    Clear `AutoAdminLogon`, `DefaultUserName`, `DefaultDomainName` and
    `DefaultPassword`. Prompts; pass `-Confirm:$false` to run unattended.

.EXAMPLE
    pwsh -File ops/jarvis-autologon.ps1 -Status

.EXAMPLE
    # Elevated. Run it in *this* session, with `&`. A SecureString does not
    # survive a process boundary -- `pwsh -File ... -Password $s` hands the
    # script a plain String and it fails to bind -- so a child pwsh cannot be
    # used however the prompt is built. Measured 2026-09-21, through both
    # `-File` and `-Command`.
    $secure = Read-Host -AsSecureString -Prompt 'Windows password'
    & C:\javis\ops\jarvis-autologon.ps1 -UserName Sid -Domain SID -Password $secure
#>
[CmdletBinding(DefaultParameterSetName = 'Install', SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(ParameterSetName = 'Status', Mandatory)]
    [switch]$Status,

    [Parameter(ParameterSetName = 'Remove', Mandatory)]
    [switch]$Remove,

    [Parameter(ParameterSetName = 'Install', Mandatory)]
    [string]$UserName,

    [Parameter(ParameterSetName = 'Install')]
    [string]$Domain = $env:COMPUTERNAME,

    [Parameter(ParameterSetName = 'Install', Mandatory)]
    [SecureString]$Password
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The one path Windows reads at boot. `Winlogon` here is a registry key, not a
# service -- `Get-Service winlogon` finds nothing, which is a wrong turn this
# script's first hand-run took.
$WinlogonKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

# The values this script owns. Named so `-Remove` cannot widen into something
# else later.
$OwnedValues = 'AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName', 'DefaultPassword'

function Get-WinlogonValue {
    $key = Get-Item -LiteralPath $WinlogonKey
    $names = $key.GetValueNames()
    $values = @{}
    foreach ($name in $OwnedValues) {
        # `GetValue` rather than `Get-ItemProperty` so a missing value is $null
        # rather than a property-not-found terminating error under StrictMode.
        $values[$name] = if ($names -contains $name) { $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
    }
    return $values
}

function Assert-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "writing $WinlogonKey requires an elevated session. Open a terminal as Administrator and re-run."
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Status' {
        # Read-only and unelevated on purpose. This is the command to run before
        # and after a change, and requiring elevation for it would make the
        # before-state unobservable from the session that reports it.
        $current = Get-WinlogonValue
        $configured = [bool]$current['AutoAdminLogon'] -and $current['AutoAdminLogon'] -ne '0'
        Write-Output "winlogon_key        $WinlogonKey"
        Write-Output "auto_admin_logon    $configured"
        Write-Output "default_user_name   $(if ($current['DefaultUserName']) { $current['DefaultUserName'] } else { '(unset)' })"
        Write-Output "default_domain_name $(if ($current['DefaultDomainName']) { $current['DefaultDomainName'] } else { '(unset)' })"
        # A boolean, never a length and never a prefix. "8 characters" narrows a
        # search space, which is the same disclosure with extra steps.
        Write-Output "password_present    $([bool]$current['DefaultPassword'])"
        Write-Output "password_location   registry REG_SZ (plaintext at rest)"
    }

    'Remove' {
        Assert-Elevated
        if ($PSCmdlet.ShouldProcess($WinlogonKey, 'clear Jarvis auto-login values')) {
            $current = Get-WinlogonValue
            if (-not ($current['AutoAdminLogon'] -or $current['DefaultUserName'] -or $current['DefaultPassword'])) {
                Write-Output 'nothing to remove; auto-login values are already absent'
                # `return`, not `break`: in a `switch` inside a script, `break`
                # leaves only the switch and would fall through to no case at
                # all -- which looks identical here and would not once a
                # subsequent statement is added.
                return
            }
            # Removed one at a time rather than by deleting the key: the key holds
            # Shell, Userinit, VMApplet and more, and removing it breaks the
            # machine's ability to log anyone in at all.
            $key = Get-Item -LiteralPath $WinlogonKey
            foreach ($name in $OwnedValues) {
                if ($key.GetValueNames() -contains $name) {
                    Remove-ItemProperty -LiteralPath $WinlogonKey -Name $name
                }
            }
            $after = Get-WinlogonValue
            Write-Output "auto_admin_logon    $([bool]$after['AutoAdminLogon'])"
            Write-Output "password_present    $([bool]$after['DefaultPassword'])"
            Write-Output 'removed             ' + ($OwnedValues -join ', ')
        }
    }

    'Install' {
        Assert-Elevated

        $plain = [System.Net.NetworkCredential]::new('', $Password).Password
        try {
            if ([string]::IsNullOrEmpty($plain)) {
                throw 'the password is empty; a blank password cannot auto-login'
            }
            if ([string]::IsNullOrWhiteSpace($UserName)) {
                throw 'the user name is empty'
            }

            # `DefaultDomainName` decides *which* Sid. A local account takes the
            # computer name; a Microsoft account would take its domain, and
            # getting this wrong produces a machine that boots to the logon
            # screen with the right name in the wrong box.
            if ($PSCmdlet.ShouldProcess($WinlogonKey, "enable auto-login for $Domain\$UserName")) {
                # Created if absent; the key itself always exists on a booted
                # Windows install, so this is belt-and-braces for a restored hiv.
                if (-not (Test-Path -LiteralPath $WinlogonKey)) {
                    New-Item -Path $WinlogonKey -Force | Out-Null
                }
                # AutoAdminLogon is read as a string by Winlogon. `1`/`0`, not
                # $true/$false: a REG_DWORD here is silently not auto-login.
                Set-ItemProperty -LiteralPath $WinlogonKey -Name 'AutoAdminLogon' -Value '1' -Type String
                Set-ItemProperty -LiteralPath $WinlogonKey -Name 'DefaultUserName' -Value $UserName -Type String
                Set-ItemProperty -LiteralPath $WinlogonKey -Name 'DefaultDomainName' -Value $Domain -Type String
                Set-ItemProperty -LiteralPath $WinlogonKey -Name 'DefaultPassword' -Value $plain -Type String

                $after = Get-WinlogonValue
                if (-not ($after['AutoAdminLogon'] -eq '1' -and $after['DefaultUserName'])) {
                    throw 'the auto-login values did not read back; do not trust this machine to log in'
                }
                Write-Output "auto_admin_logon    $($after['AutoAdminLogon'])"
                Write-Output "default_user_name   $($after['DefaultUserName'])"
                Write-Output "default_domain_name $($after['DefaultDomainName'])"
                Write-Output "password_present    $([bool]$after['DefaultPassword'])"
                Write-Output 'note                the password is now plaintext at rest; see docs/runbooks/pc-boot-chain.md'
            }
        }
        finally {
            # The only copy of the password this process holds. Dropped even on
            # the throw above, so a failed install does not leave it in a local.
            $plain = $null
        }
    }
}
