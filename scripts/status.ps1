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
$processValid = $false
$healthValid = Test-PrototypeReviewHealth -Port 3018
$processState = 'stopped'

if ($null -ne $serverProcessId) {
    try {
        $processInfo = Get-ValidatedProjectNodeProcess -Paths $paths -ServerProcessId $serverProcessId
        if ($null -ne $processInfo) {
            $processValid = $true
            $processState = 'running'
        } else {
            $processState = 'stale PID'
        }
    } catch {
        $processState = "PID rejected: $($_.Exception.Message)"
    }
}

[pscustomobject]@{
    Service = 'Prototype Review System'
    Process = $processState
    PID = if ($null -eq $serverProcessId) { '-' } else { $serverProcessId }
    Health = if ($healthValid) { 'ok' } else { 'unreachable' }
    URL = 'http://127.0.0.1:3018/'
} | Format-List

if (-not ($processValid -and $healthValid)) { exit 1 }
