# Remove the scheduled task and stop what it runs. Keeps the store and the
# credential -- health data is not this script's to delete -- unless -Purge.
#
#   npm run service:uninstall              keep store, credential and log
#   npm run service:uninstall -- -Purge    delete them too
param([switch]$Purge)
. (Join-Path $PSScriptRoot '_common.ps1')

$Node = FindNode
$P = ReadPaths $Node

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
StopVitals
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "uninstalled task $TaskName"
} else {
  Write-Output "no task $TaskName -- nothing to uninstall"
}

if ($Purge) {
  foreach ($f in @($P.DB, ($P.DB + '-wal'), ($P.DB + '-shm'), $P.TOKEN_FILE)) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
  }
  $logDir = Split-Path -Parent $P.LOG_FILE
  if (Test-Path -LiteralPath $logDir) { Remove-Item -LiteralPath $logDir -Recurse -Force }
  if (Test-Path -LiteralPath $P.STATE_DIR) {
    if (@(Get-ChildItem -LiteralPath $P.STATE_DIR -Force).Count -eq 0) { Remove-Item -LiteralPath $P.STATE_DIR -Force }
  }
  Write-Output ('purged: ' + $P.DB + ' and ' + $P.TOKEN_FILE)
} else {
  Write-Output ('kept: ' + $P.DB + ' and ' + $P.TOKEN_FILE + ' (-Purge deletes them)')
}
