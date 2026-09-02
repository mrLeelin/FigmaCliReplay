$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$starter = Join-Path $repoRoot "scripts\start_mcp_hidden.ps1"
$nodeSource = (Get-Command node -ErrorAction Stop).Source
$npmSource = Join-Path (Split-Path -Parent $nodeSource) "npm.cmd"
if (-not (Test-Path -LiteralPath $npmSource -PathType Leaf)) {
    throw "The test requires npm.cmd beside node.exe: $npmSource"
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "figma-mcp-relay-node-tools-$PID"
$fixtureNodeDir = Join-Path $fixtureRoot "node"

try {
    New-Item -ItemType Directory -Force -Path $fixtureNodeDir | Out-Null
    Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $fixtureNodeDir "node.exe")
    Copy-Item -LiteralPath $npmSource -Destination (Join-Path $fixtureNodeDir "npm.cmd")

    # PATHEXT intentionally omits .CMD, reproducing a startup environment that finds node.exe but not npm.
    $childScript = @"
`$env:Path = '$fixtureNodeDir;C:\Windows\System32'
`$env:PATHEXT = '.EXE'
& '$starter' -ValidateNodeTools
exit `$LASTEXITCODE
"@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand 2>&1
    $childExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($childExitCode -ne 0) {
        throw "Expected hidden startup to find npm.cmd beside node.exe, but it exited $childExitCode.`n$output"
    }

    Write-Output "PASS: hidden startup resolved npm.cmd beside node.exe."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
