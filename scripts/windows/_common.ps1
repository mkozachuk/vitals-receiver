# Dot-sourced by the Windows service scripts. Windows PowerShell 5.1 and later;
# nothing here needs PowerShell 7. Sets $Repo, $TaskName, $ServerTs, $RunPs1,
# $Tsx and the helpers below. Paths come from src/config.ts (platform win32)
# through scripts/windows/paths.ts, so there is no second copy of the rule.
#
# Pure ASCII, CRLF line endings: tests/windows-service.test.ts checks both, and
# the PowerShell 5.1 subset (no pwsh-only syntax, cmdlets from an allow-list).

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$TaskName = 'vitals'
$ServerTs = Join-Path $Repo 'src\server.ts'
$RunPs1 = Join-Path $Repo 'scripts\windows\run.ps1'
$Tsx = Join-Path $Repo 'node_modules\tsx\dist\loader.mjs'

function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# node --import wants a URL on Windows: a bare C:\ path reads as a URL scheme.
function TsxUrl {
  if (-not (Test-Path -LiteralPath $Tsx -PathType Leaf)) { Fail 'dependencies missing -- run: npm ci' }
  return ([System.Uri]$Tsx).AbsoluteUri
}

# node >= 22, chosen deliberately: VITALS_NODE if set (no fall-through when it
# is unusable), else the node.exe found on PATH. better-sqlite3 is built
# against the node 22 ABI, so 22 is not a preference.
function FindNode {
  $candidates = @()
  if ($env:VITALS_NODE) {
    $candidates = @($env:VITALS_NODE)
  } else {
    $found = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $candidates = @($found.Path) }
  }
  foreach ($c in $candidates) {
    if (-not (Test-Path -LiteralPath $c -PathType Leaf)) {
      [Console]::Error.WriteLine("no node at $c")
      continue
    }
    $version = ''
    try { $version = [string](& $c --version) } catch { $version = '' }
    if ($version -match '^v([0-9]+)\.') {
      if ([int]$Matches[1] -ge 22) { return (Resolve-Path -LiteralPath $c).Path }
    }
    if ($version -eq '') { $version = '(no version)' }
    [Console]::Error.WriteLine("node $version at $c is older than 22")
  }
  Fail 'no node >= 22 found (better-sqlite3 is built against its ABI); set VITALS_NODE=C:\path\to\node.exe'
}

# KEY=value lines from scripts/windows/paths.ts into a hashtable. paths.ts
# exits 1 (one line on stderr) when .env moves VITALS_READ_HOST off loopback.
function ReadPaths([string]$Node) {
  $url = TsxUrl
  $out = @(& $Node --import $url (Join-Path $Repo 'scripts\windows\paths.ts') $Repo)
  if ($LASTEXITCODE -ne 0) { exit 1 }
  $p = @{}
  foreach ($line in $out) {
    $s = [string]$line
    $i = $s.IndexOf('=')
    if ($i -gt 0) { $p[$s.Substring(0, $i)] = $s.Substring($i + 1) }
  }
  foreach ($k in @('STATE_DIR', 'DB', 'TOKEN_FILE', 'LOG_FILE', 'READ_HOST', 'READ_PORT', 'INGEST_PORT')) {
    if (-not $p.ContainsKey($k)) { Fail "paths.ts did not report $k" }
  }
  return $p
}

# The task's whole argument line. Install compares it with the registered one,
# so a second install with nothing changed leaves the running task alone.
function TaskArguments([string]$Node, $P) {
  return '-WindowStyle Hidden -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "' + $RunPs1 + '"' +
    ' -Node "' + $Node + '" -Store "' + $P.DB + '" -Token "' + $P.TOKEN_FILE + '" -Log "' + $P.LOG_FILE + '"'
}

function WindowsPowerShell {
  return Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

# The processes this checkout runs: run.ps1 hosts and the node serving it.
# Matched on the full command line, so another checkout's daemon is left alone.
function ServiceProcesses([string]$Name, [string]$Needle) {
  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$Name'" |
    Where-Object { ([string]$_.CommandLine).Contains($Needle) })
}

# Stops the task and whatever it started. Task Scheduler ends the action's own
# process (powershell running run.ps1); node, two levels down, is stopped by
# id. This is a hard stop: SQLite in WAL mode keeps every committed batch.
function StopVitals {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  }
  foreach ($proc in (ServiceProcesses 'powershell.exe' $RunPs1)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  foreach ($proc in (ServiceProcesses 'node.exe' $ServerTs)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

# GET /healthz on the loopback read port. $null when nothing answers 200.
function Health([string]$ReadPort) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ('http://127.0.0.1:' + $ReadPort + '/healthz')
    if ($r.StatusCode -eq 200) { return [string]$r.Content }
  } catch {
    return $null
  }
  return $null
}
