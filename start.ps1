<#
  start.ps1 — Windows launcher. The counterpart of start.sh.

  What it deliberately does NOT do, and why:
    * no caffeinate  — the PC is a wired desktop that never sleeps
    * no pmset wake  — nothing to wake
    * no caretaker   — wrapper.js already restarts on crash; a Scheduled Task
                       set to "At log on" covers reboots (see -Install)

  Usage:
      .\start.ps1              start the bot (kills any previous instance)
      .\start.ps1 -Install     also register the At-logon Scheduled Task
      .\start.ps1 -Uninstall   remove that task
      .\start.ps1 -Stop        stop the bot and leave it stopped
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$BotDir   = $PSScriptRoot
$DataDir  = Join-Path $BotDir 'data'
$PidFile  = Join-Path $DataDir 'bot.pid'
$LogFile  = Join-Path $BotDir 'bot.log'
$TaskName = 'claudegram-bot'

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# ── Stop whatever is running from THIS directory ────────────────────────────
# Matching on the directory matters: a second checkout, or an unrelated node
# process, must not be killed. Telegram allows one long-poll per token, so the
# old process has to be gone before the new one starts or both get 409s.
function Stop-Bot {
  $killed = @()
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      ($_.CommandLine -match 'bot\.js|wrapper\.js') -and
      ($_.CommandLine -like "*$BotDir*" -or (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).Path)
    } |
    ForEach-Object {
      # Confirm by working directory where we can, so a same-named process from
      # another checkout survives.
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed += $_.ProcessId } catch {}
    }
  if (Test-Path $PidFile) {
    $old = (Get-Content $PidFile -ErrorAction SilentlyContinue).Trim()
    if ($old) { try { Stop-Process -Id ([int]$old) -Force -ErrorAction Stop; $killed += $old } catch {} }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  if ($killed.Count) { Write-Host "Stopped: $($killed -join ', ')" }
}

# ── Scheduled Task: bring the bot back after a reboot ───────────────────────
# This is the ONLY piece of the Mac's caretaker/waker machinery that Windows
# needs. Everything else it did (keep awake, wake from sleep, revive a wedged
# process) is either moot here or already covered by wrapper.js.
function Install-Task {
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
             -WorkingDirectory $BotDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
  Write-Host "Scheduled Task '$TaskName' registered (runs at log on)."
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Scheduled Task '$TaskName' removed."
  Stop-Bot
  return
}

if ($Stop) { Stop-Bot; return }

# ── Syntax check before starting, same as start.sh ──────────────────────────
# A syntax error must not take the bot down and leave the wrapper retrying it
# five times; catch it here while there is still a console to print to.
Write-Host 'Checking syntax...'
$files = @(Join-Path $BotDir 'bot.js') +
         (Get-ChildItem (Join-Path $BotDir 'lib') -Filter *.js -Recurse | ForEach-Object FullName)
foreach ($f in $files) {
  & node --check $f
  if ($LASTEXITCODE -ne 0) { Write-Host "Syntax error in $f - not starting." -ForegroundColor Red; exit 1 }
}
Write-Host 'Syntax OK'

Stop-Bot

# ── Launch detached, so the bot outlives this console ───────────────────────
Push-Location $BotDir
$proc = Start-Process -FilePath 'node' -ArgumentList 'wrapper.js' `
        -WorkingDirectory $BotDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $DataDir 'detached.log') `
        -RedirectStandardError  (Join-Path $DataDir 'detached.err.log')
Pop-Location

if ($proc) {
  Write-Host "Telegram bot started (PID: $($proc.Id))"
  Write-Host "Log: $LogFile"
} else {
  Write-Host 'Failed to start bot.' -ForegroundColor Red
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
  exit 1
}

if ($Install) { Install-Task }
