#Requires -Version 7.3
<#
.SYNOPSIS
    Register, inspect or remove the logon-triggered scheduled task that starts
    Jarvis elevated the moment auto-login lands on the desktop.

.DESCRIPTION
    This is the half of the boot chain that removes the UAC prompt. A scheduled
    task registered with a *principal* carries that principal's highest run level
    into the process it starts, so `ops/jarvis-boot.ps1` begins life elevated and
    neither Sid nor Jarvis ever sees a consent dialog. A shortcut, a Run key or a
    Startup-folder entry all would -- and a UAC prompt at 08:00 with nobody at the
    keyboard is a boot chain that stops dead.

    The four settings that matter, and what each one breaks if it is wrong:

      * `-AtLogOn` with the account named. A task that fires for *any* user fires
        for the wrong one after a failed logon attempt.
      * `-RunLevel Highest`. Without it the task runs un-elevated and every
        admin operation the agent attempts fails on a machine nobody is watching.
      * `-LogonType Interactive`. `Password` would store a second copy of the
        password, and `S4U` cannot reach network or encrypted resources as the
        user; `Interactive` uses the token the auto-login already created.
      * `-ExecutionTimeLimit 0` (PT0S). The default is 72 hours, which would kill
        a process meant to sit resident for months -- after three days, silently.

    `RestartCount`/`RestartInterval` are set as well, because the alternative is a
    machine that booted, ran Jarvis for four seconds, and then looked fine.

    The task runs `pwsh` and nothing else; the boot script decides everything
    after that. Nothing here starts, stops or configures the agent.

.PARAMETER Status
    Report the registered task's principal, trigger, settings and action.
    Read-only and unelevated.

.PARAMETER Remove
    Unregister the task. Prompts.

.PARAMETER RunLevel
    `Highest` (default) or `Limited`. The parameter exists so the difference can
    be demonstrated, not so it can be quietly set to `Limited`: see the runbook.

.EXAMPLE
    pwsh -File ops/jarvis-logon-task.ps1 -Status

.EXAMPLE
    # Elevated. Registers for the current user with the current pwsh.
    pwsh -File ops/jarvis-logon-task.ps1
#>
[CmdletBinding(DefaultParameterSetName = 'Install', SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(ParameterSetName = 'Status', Mandatory)]
    [switch]$Status,

    [Parameter(ParameterSetName = 'Remove', Mandatory)]
    [switch]$Remove,

    # On every set, because a status check must be able to ask about the task
    # that was registered under a different name.
    [string]$TaskName = 'Jarvis boot chain',

    [Parameter(ParameterSetName = 'Install', Mandatory)]
    [string]$UserName,

    [Parameter(ParameterSetName = 'Install')]
    [string]$Domain = $env:COMPUTERNAME,

    [Parameter(ParameterSetName = 'Install')]
    [ValidateSet('Highest', 'Limited')]
    [string]$RunLevel = 'Highest',

    [Parameter(ParameterSetName = 'Install')]
    [string]$BootScript = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ops/jarvis-boot.ps1'),

    [Parameter(ParameterSetName = 'Install')]
    [string]$PwshPath = (Get-Command pwsh).Source
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

#: Restarts are bounded. A task that restarts without limit against a machine
#: that cannot start the agent would boot-loop the host overnight.
$RestartCount = 3
$RestartIntervalMinutes = 1

function Get-JarvisTask {
    param([string]$Name)
    # -ErrorAction SilentlyContinue rather than a try/catch: "no such task" is an
    # expected answer here, not a failure of the query.
    Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Assert-Elevated {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'registering a task with -RunLevel Highest requires an elevated session. Open a terminal as Administrator and re-run.'
    }
}

function Show-JarvisTask {
    param([string]$Name)
    $task = Get-JarvisTask -Name $Name
    if ($null -eq $task) {
        Write-Output "task                '$Name' is not registered"
        return
    }
    Write-Output "task                $($task.TaskName)"
    Write-Output "state               $($task.State)"
    Write-Output "user_id             $($task.Principal.UserId)"
    Write-Output "logon_type          $($task.Principal.LogonType)"
    Write-Output "run_level           $($task.Principal.RunLevel)"
    Write-Output "trigger             $($task.Triggers[0].CimClass.CimClassName)"
    if ($task.Triggers[0].UserId) { Write-Output "trigger_user        $($task.Triggers[0].UserId)" }
    Write-Output "execution_limit     $($task.Settings.ExecutionTimeLimit)"
    Write-Output "restart_count       $($task.Settings.RestartCount)"
    Write-Output "restart_interval    $($task.Settings.RestartInterval)"
    Write-Output "multiple_instances  $($task.Settings.MultipleInstances)"
    foreach ($action in $task.Actions) {
        Write-Output "action_execute      $($action.Execute)"
        Write-Output "action_arguments    $($action.Arguments)"
        Write-Output "action_directory    $($action.WorkingDirectory)"
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Status' {
        Show-JarvisTask -Name $TaskName
    }

    'Remove' {
        Assert-Elevated
        if (-not (Get-JarvisTask -Name $TaskName)) {
            Write-Output "task                '$TaskName' is not registered"
            return
        }
        if ($PSCmdlet.ShouldProcess("scheduled task '$TaskName'", 'unregister')) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Output "removed             $TaskName"
        }
    }

    'Install' {
        # `-WhatIf` is not a courtesy here. `New-ScheduledTask*` builds these
        # objects without elevation while `Register-ScheduledTask` needs it, so
        # this is the only way an unelevated session can check what the script
        # would register -- and a test that rebuilds the objects itself would
        # keep passing after this file stopped asking for `-RunLevel Highest`.
        if (-not $WhatIfPreference) { Assert-Elevated }

        foreach ($path in @($BootScript, $PwshPath)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "not a file: $path"
            }
        }
        # Registering a task whose action points at a file that is not there
        # produces a green registration and a machine that does nothing at 08:00.
        $BootScript = (Resolve-Path -LiteralPath $BootScript).Path
        $PwshPath = (Resolve-Path -LiteralPath $PwshPath).Path

        # `DefaultDomainName` is the auto-login script's job; this is Task
        # Scheduler's, and it needs the same answer: a bare name would be
        # resolved as a different account on a machine with a domain, and the
        # task would then never run.
        if (-not $UserName.Contains('\')) {
            $UserName = "$Domain\$UserName"
        }

        $action = New-ScheduledTaskAction `
            -Execute $PwshPath `
            -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$BootScript`"" `
            -WorkingDirectory (Split-Path -Parent $BootScript)

        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName

        $principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel $RunLevel

        # -ExecutionTimeLimit ([TimeSpan]::Zero) serializes to PT0S, which Task
        # Scheduler reads as "no limit". The default is PT72H.
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount $RestartCount `
            -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)

        if ($WhatIfPreference) {
            Write-Output "would_register      $TaskName"
            Write-Output "user_id             $($principal.UserId)"
            Write-Output "logon_type          $($principal.LogonType)"
            Write-Output "run_level           $($principal.RunLevel)"
            Write-Output "trigger             $($trigger.CimClass.CimClassName)"
            Write-Output "execution_limit     $($settings.ExecutionTimeLimit)"
            Write-Output "restart_count       $($settings.RestartCount)"
            Write-Output "restart_interval    $($settings.RestartInterval)"
            Write-Output "action_execute      $($action.Execute)"
            Write-Output "action_arguments    $($action.Arguments)"
            return
        }

        if ($PSCmdlet.ShouldProcess("scheduled task '$TaskName'", "register at logon as $UserName with RunLevel $RunLevel")) {
            $registered = Register-ScheduledTask `
                -TaskName $TaskName `
                -Action $action `
                -Trigger $trigger `
                -Principal $principal `
                -Settings $settings `
                -Description 'Starts Jarvis elevated at logon. See docs/runbooks/pc-boot-chain.md.' `
                -Force
            Show-JarvisTask -Name $registered.TaskName
        }
    }
}
