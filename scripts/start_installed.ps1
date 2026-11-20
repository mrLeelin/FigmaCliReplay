param([int]$Port = 32130, [switch]$Repair, [string[]]$CliArgs)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if ($record.currentVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
        throw 'Invalid installed Relay version.'
    }
    $release = Join-Path $PSScriptRoot "versions\$($record.currentVersion)\figma-relay"
    $node = Join-Path $release 'runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $release 'runtime\windows-x64.json'))) {
        $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    }
    if ($PSBoundParameters.ContainsKey('CliArgs')) {
        & $node (Join-Path $PSScriptRoot 'dist\cli.js') @CliArgs
    } else {
        $mode = if ($Repair) { 'repair' } else { 'start' }
        & $node (Join-Path $PSScriptRoot 'bootstrap.mjs') $mode --port $Port
    }
    exit $LASTEXITCODE
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
