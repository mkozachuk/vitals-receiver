# npm run service:logs on Windows: follow the log file run.ps1 appends to.
. (Join-Path $PSScriptRoot '_common.ps1')

$Node = FindNode
$P = ReadPaths $Node
if (-not (Test-Path -LiteralPath $P.LOG_FILE -PathType Leaf)) { Fail ('no log yet at ' + $P.LOG_FILE + ' -- is the service installed') }
Get-Content -LiteralPath $P.LOG_FILE -Tail 50 -Wait
