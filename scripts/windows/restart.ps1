# npm run restart on Windows: POST /api/restart, the same route the deploy
# path uses. The server drains and exits 75, run.ps1 starts it again at once,
# and this script waits until /healthz reports a new startedAt. When nothing
# answers, it starts the task instead.
. (Join-Path $PSScriptRoot '_common.ps1')

$Node = FindNode
$P = ReadPaths $Node
$base = 'http://127.0.0.1:' + $P.READ_PORT

$before = Health $P.READ_PORT
if ($null -eq $before) {
  Write-Output ('nothing answers on ' + $base + ' -- starting task ' + $TaskName)
  Start-ScheduledTask -TaskName $TaskName
} else {
  $was = (ConvertFrom-Json $before).startedAt
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Method Post -Uri ($base + '/api/restart') -ContentType 'application/json' -Body '{}'
    Write-Output ([string]$r.Content)
  } catch {
    $status = 'no answer'
    if ($_.Exception -is [System.Net.WebException]) {
      if ($null -ne $_.Exception.Response) { $status = [string][int]$_.Exception.Response.StatusCode }
    }
    Fail ('restart refused (' + $status + '); 409 means a delivery is in flight -- try again in a few seconds')
  }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $now = Health $P.READ_PORT
    if ($null -ne $now) {
      if ((ConvertFrom-Json $now).startedAt -ne $was) {
        Write-Output 'restarted'
        exit 0
      }
    }
  }
  Fail ('no new process answered within 60 s -- see ' + $P.LOG_FILE)
}
for ($i = 0; $i -lt 30; $i++) {
  if ($null -ne (Health $P.READ_PORT)) {
    Write-Output 'started'
    exit 0
  }
  Start-Sleep -Seconds 1
}
Fail ('task started but nothing answers on ' + $base + ' -- see ' + $P.LOG_FILE)
