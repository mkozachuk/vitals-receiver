# The scheduled task's action: a supervising loop around one node process.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run.ps1
#     -Node <node.exe> -Store <store> -Token <credential> -Log <log file>
#
# Task Scheduler does not reliably re-run an action that exits non-zero, so the
# restart policy lives here (mirrored in scripts/windows/policy.ts, which the
# tests exercise and compare against these constants):
#   exit 75 (POST /api/restart)  start again at once
#   exit 0  (a clean stop)       stop the loop, exit 0
#   anything else                wait 10 s, start again; more than 5 restarts
#                                within 10 minutes and the loop gives up, exit 1
#
# node runs with the tsx loader by absolute URL (no npm, no npx), the repo's
# .env through --env-file when it exists, and the read host pinned to
# 127.0.0.1 below: node never lets a .env value override a variable already set, so the
# read listener stays on loopback whatever .env says. stdout and stderr are
# appended to the log file.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  # Not -Db: an advanced script gets the common parameters, and -db is the
  # alias of -Debug, so Windows PowerShell refuses to bind the script at all.
  [Parameter(Mandatory = $true)][string]$Store,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Log
)
# Nobody reads this process's console: anything that stops the script before
# the loop goes to the log file too, with the line it came from.
function Early([string]$Line) {
  $text = (Get-Date -Format 's') + ' run.ps1: ' + $Line
  [Console]::Error.WriteLine($text)
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
    Add-Content -LiteralPath $Log -Encoding ASCII -Value $text
  } catch {
    [Console]::Error.WriteLine('run.ps1: cannot write ' + $Log + ': ' + [string]$_)
  }
}
trap {
  Early ('stopped: ' + [string]$_ + ' at ' + $_.InvocationInfo.ScriptName + ':' + $_.InvocationInfo.ScriptLineNumber)
  exit 1
}
Early ('started as ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name + ' in ' + [string]$PWD.Path)
. (Join-Path $PSScriptRoot '_common.ps1')
function Fail([string]$Message) {
  Early $Message
  exit 1
}

$RestartExit = 75
$BackoffSeconds = 10
$MaxRestarts = 5
$WindowSeconds = 600

$env:VITALS_DB = $Store
$env:VITALS_TOKEN_FILE = $Token
$env:VITALS_READ_HOST = '127.0.0.1'
$env:NODE_ENV = 'production'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
$url = TsxUrl
$envFile = Join-Path $Repo '.env'

function Note([string]$Line) {
  Add-Content -LiteralPath $Log -Encoding ASCII -Value ((Get-Date -Format 's') + ' run.ps1: ' + $Line)
}

$failures = @()
while ($true) {
  $line = '"' + $Node + '"'
  if (Test-Path -LiteralPath $envFile -PathType Leaf) { $line += ' "--env-file=' + $envFile + '"' }
  $line += ' --import "' + $url + '" "' + $ServerTs + '" >> "' + $Log + '" 2>&1'

  # cmd.exe does the appending: the redirect keeps node's bytes as they are.
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $env:ComSpec
  $start.Arguments = '/d /s /c "' + $line + '"'
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $Repo
  Note ('starting node (' + $Node + ')')
  $proc = [System.Diagnostics.Process]::Start($start)
  $proc.WaitForExit()
  $code = $proc.ExitCode

  if ($code -eq $RestartExit) {
    Note ('node exited ' + $code + ' (restart requested); starting again')
    continue
  }
  if ($code -eq 0) {
    Note 'node exited 0 (stopped); the loop ends'
    exit 0
  }
  $now = Get-Date
  $failures = @($failures | Where-Object { ($now - $_).TotalSeconds -lt $WindowSeconds }) + @($now)
  if ($failures.Count -gt $MaxRestarts) {
    Note ('node exited ' + $code + '; ' + $MaxRestarts + ' restarts within ' + $WindowSeconds + ' s already, giving up')
    exit 1
  }
  Note ('node exited ' + $code + '; starting again in ' + $BackoffSeconds + ' s (restart ' + $failures.Count + ' of ' + $MaxRestarts + ' within ' + $WindowSeconds + ' s)')
  Start-Sleep -Seconds $BackoffSeconds
}
