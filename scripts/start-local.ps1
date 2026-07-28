[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$commonScript = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonScript -PathType Leaf)) {
    throw "Missing common script: $commonScript"
}
. $commonScript

Start-PrototypeReviewServer -ScriptsRoot $PSScriptRoot -ListenAddress '127.0.0.1' -Port 3018
