# Install (or reinstall) vitals as a per-user scheduled task that starts at
# logon. No administrator rights, nothing downloaded. Idempotent: a second run
# with nothing changed leaves the registered task as it is and exits 0.
#
#   npm run service:install      (scripts/service.mjs on Windows runs this file)
#
# Order: everything that only reads first (node, dependencies, credential,
# paths), then the ACLs, then the task, then start it and verify.
. (Join-Path $PSScriptRoot '_common.ps1')

$Node = FindNode
Write-Output ('using node ' + [string](& $Node --version) + ' at ' + $Node)

# The native module is the dependency that can be present and still wrong.
Push-Location -LiteralPath $Repo
& $Node -e "import('better-sqlite3').then(()=>process.exit(0),()=>process.exit(1))" | Out-Null
$loaded = $LASTEXITCODE
Pop-Location
if ($loaded -ne 0) { Fail "better-sqlite3 will not load under $Node (ABI mismatch) -- run: npm rebuild better-sqlite3" }

$P = ReadPaths $Node

# A LAN-facing listener with no credential is worse than no listener: the
# server exits 1 without one, and run.ps1 would retry it until it gives up.
$haveToken = Test-Path -LiteralPath $P.TOKEN_FILE -PathType Leaf
if ($haveToken) { $haveToken = (Get-Item -LiteralPath $P.TOKEN_FILE).Length -gt 0 }
if (-not $haveToken) { Fail ('no credential at ' + $P.TOKEN_FILE + ' -- run: npm run token:mint') }

# Only the running user may read the store and the credential: inheritance
# cut, one grant each. verify-service.ps1 check (d) reads it back.
$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType Directory -Force -Path $P.STATE_DIR | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $P.LOG_FILE) | Out-Null
& icacls.exe $P.STATE_DIR /inheritance:r /grant:r "${Me}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail ('icacls could not restrict ' + $P.STATE_DIR) }
& icacls.exe $P.TOKEN_FILE /inheritance:r /grant:r "${Me}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail ('icacls could not restrict ' + $P.TOKEN_FILE) }
Write-Output ('credential and store readable by ' + $Me + ' only')

$Exe = WindowsPowerShell
$Arguments = TaskArguments $Node $P
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$same = $false
if ($existing) {
  $old = @($existing.Actions)[0]
  $same = ($old.Execute -eq $Exe) -and ($old.Arguments -eq $Arguments) -and ($old.WorkingDirectory -eq $Repo)
}
if ($same) {
  Write-Output "task unchanged: $TaskName"
} else {
  if ($existing) { StopVitals }
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $Repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Me
  $principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'vitals: receiver for healthd Apple Health exports' -Force | Out-Null
  Write-Output "task registered: $TaskName (at logon of $Me)"
}

# Start now rather than at the next logon.
$task = Get-ScheduledTask -TaskName $TaskName
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }

Write-Output ('logs: ' + $P.LOG_FILE + '   (npm run service:logs)')
$wait = 15
if ($env:VITALS_INSTALL_WAIT) { $wait = [int]$env:VITALS_INSTALL_WAIT }
for ($i = 0; $i -lt $wait; $i++) {
  if ($null -ne (Health $P.READ_PORT)) { break }
  Start-Sleep -Seconds 1
}
& (Join-Path $PSScriptRoot 'verify-service.ps1')
exit $LASTEXITCODE
