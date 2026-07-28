[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Write-Warning 'This will listen on all network interfaces. Change the demo passwords for admin, alex, lin, and wu before LAN use.'
Write-Warning 'This script does not change Windows Firewall. Allow TCP 3018 only on a trusted LAN and according to company policy.'

$commonScript = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonScript -PathType Leaf)) {
    throw "Missing common script: $commonScript"
}
. $commonScript

Start-PrototypeReviewServer -ScriptsRoot $PSScriptRoot -ListenAddress '0.0.0.0' -Port 3018
