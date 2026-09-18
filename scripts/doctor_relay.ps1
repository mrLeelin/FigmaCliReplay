param([string]$Url = 'ws://127.0.0.1:32130/relay')
$ErrorActionPreference = 'Stop'
$PluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$localNode = Join-Path $PluginRoot '.local\node'
if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) { $env:Path = "$localNode;$env:Path" }
& node (Join-Path $PluginRoot 'dist\cli.js') control --job-type relay.status --payload '{}' --url $Url
exit $LASTEXITCODE
