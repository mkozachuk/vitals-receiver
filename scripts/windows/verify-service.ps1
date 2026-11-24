# Prove the installed Windows service is serving, not merely registered. Names
# each failed check; the exit code is the number of failures.
#   (a) the task exists and is Running (or run.ps1's node is alive)
#   (b) the ingest port is listening
#   (c) GET /healthz on 127.0.0.1:<read port> answers 200 with ok true
#   (d) the credential's ACL names the running user and nobody else
#   (e) the read port is loopback-only
. (Join-Path $PSScriptRoot '_common.ps1')

$Node = FindNode
$P = ReadPaths $Node

$fails = 0
function Ok([string]$Line) { Write-Output ('  ok    ' + $Line) }
function Bad([string]$Line) { Write-Output ('  FAIL  ' + $Line); $script:fails += 1 }

Write-Output 'vitals service verification (scheduled task)'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$alive = @(ServiceProcesses 'node.exe' $ServerTs).Count
if (-not $task) {
  Bad ('(a) no scheduled task ' + $TaskName + ' -- run: npm run service:install')
} elseif (($task.State -eq 'Running') -or ($alive -gt 0)) {
  Ok ('(a) task ' + $TaskName + ' is ' + $task.State + ', node processes: ' + $alive)
} else {
  # LastTaskResult says why: 0x41303 never ran, 0x41301 still running, anything
  # else is the action's own exit code or a Task Scheduler HRESULT.
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  $why = 'LastTaskResult unknown'
  if ($info) { $why = 'LastTaskResult 0x' + ([uint32]$info.LastTaskResult).ToString('X8') + ', last run ' + [string]$info.LastRunTime }
  Bad ('(a) task ' + $TaskName + ' is ' + $task.State + ' and no node is serving (' + $why + ') -- see ' + $P.LOG_FILE)
}

$ingest = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$P.INGEST_PORT) -ErrorAction SilentlyContinue)
if ($ingest.Count -gt 0) { Ok ('(b) ingest port ' + $P.INGEST_PORT + ' is listening') }
else { Bad ('(b) ingest port ' + $P.INGEST_PORT + ': nothing is listening -- the phone has nowhere to deliver') }

$health = Health $P.READ_PORT
if (($null -ne $health) -and ($health -match '"ok":true')) { Ok ('(c) GET http://127.0.0.1:' + $P.READ_PORT + '/healthz answered 200, ok') }
else { Bad ('(c) GET http://127.0.0.1:' + $P.READ_PORT + '/healthz did not answer 200 with ok true') }

$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (Test-Path -LiteralPath $P.TOKEN_FILE -PathType Leaf) {
  $principals = @()
  foreach ($row in @(& icacls.exe $P.TOKEN_FILE)) {
    $s = [string]$row
    if ($s.StartsWith($P.TOKEN_FILE)) { $s = $s.Substring($P.TOKEN_FILE.Length) }
    if ($s -match '^\s*(.+):\(') { $principals += $Matches[1].Trim() }
  }
  $others = @($principals | Where-Object { $_ -ne $Me })
  if ($principals.Count -eq 0) { Bad ('(d) could not read the ACL of ' + $P.TOKEN_FILE) }
  elseif ($others.Count -gt 0) { Bad ('(d) credential ACL also grants: ' + ($others -join ', ') + ' -- run: npm run service:install') }
  else { Ok ('(d) credential readable by ' + $Me + ' only') }
} else {
  Bad ('(d) no credential at ' + $P.TOKEN_FILE + ' -- run: npm run token:mint')
}

$read = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$P.READ_PORT) -ErrorAction SilentlyContinue)
$wide = @($read | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
if ($read.Count -eq 0) { Bad ('(e) nothing is listening on the read port ' + $P.READ_PORT) }
elseif ($wide.Count -gt 0) { Bad ('(e) read port ' + $P.READ_PORT + ' is bound to ' + $wide[0].LocalAddress + ' -- an unauthenticated dashboard is exposed') }
else { Ok ('(e) read port ' + $P.READ_PORT + ' is loopback-only') }

Write-Output ''
if ($fails -eq 0) { Write-Output 'all checks passed' } else { Write-Output ([string]$fails + ' check(s) failed') }
exit $fails
