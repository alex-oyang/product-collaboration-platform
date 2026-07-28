[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$commonScript = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonScript -PathType Leaf)) {
    throw "Missing common script: $commonScript"
}
. $commonScript

$paths = Get-PrototypeReviewPaths -ScriptsRoot $PSScriptRoot
$serverProcessId = Read-ProjectServerPid -Paths $paths
if ($null -eq $serverProcessId) {
    Write-Host 'No project PID file was found; this service was not started by the project script.'
    return
}

$processInfo = Get-ValidatedProjectNodeProcess -Paths $paths -ServerProcessId $serverProcessId
if ($null -eq $processInfo) {
    Remove-ProjectPidFile -Paths $paths
    Write-Warning "Process $serverProcessId no longer exists; removed its stale PID file."
    return
}

Stop-Process -Id $serverProcessId -Force -ErrorAction Stop
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($null -eq (Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
}
if ($null -ne (Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue)) {
    throw "Process $serverProcessId did not stop; the PID file was preserved."
}

Remove-ProjectPidFile -Paths $paths
Write-Host "Stopped the project Node service. PID: $serverProcessId"
