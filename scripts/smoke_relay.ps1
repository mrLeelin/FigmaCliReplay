param([string]$Url = 'ws://127.0.0.1:32130/relay')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'doctor_relay.ps1') -Url $Url
exit $LASTEXITCODE
