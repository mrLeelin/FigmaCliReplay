$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'relay_logging.ps1')
$setupLog = [RelayScriptLogger]::new('relay.setup')
$setupLog.Write('started', 'Install dependencies for this extracted Relay package')
$relaySetupRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Invoke-SetupCommand {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Setup command failed ($LASTEXITCODE): $Command" }
}

try {
    $setupLog.Write('progress', 'Check Node.js, npm and Python')
    $nodeCommand = (Get-Command node -ErrorAction Stop).Source
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $pythonCommand = (Get-Command python -ErrorAction Stop).Source
    $nodeVersion = (& $nodeCommand --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) {
        throw 'Node.js 18+ is required.'
    }
    Invoke-SetupCommand $pythonCommand @('-c', 'import sys; assert sys.version_info >= (3, 10)')
    Push-Location $relaySetupRoot
    try {
        $setupLog.Write('progress', 'Install locked Node dependencies')
        Invoke-SetupCommand $npmCommand @('ci', '--no-audit', '--no-fund')
        $venvPython = Join-Path $relaySetupRoot '.venv\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
            $setupLog.Write('progress', 'Create a private Python environment for this package')
            Invoke-SetupCommand $pythonCommand @('-m', 'venv', (Join-Path $relaySetupRoot '.venv'))
        }
        $setupLog.Write('progress', 'Install and verify Python image and PSD dependencies')
        Invoke-SetupCommand $venvPython @('-m', 'pip', 'install', '-r', 'server/requirements.txt')
        Invoke-SetupCommand $venvPython @('-c', 'import PIL, psd_tools; from psd_tools import PSDImage')
        Invoke-SetupCommand $nodeCommand @('dist/cli.js', '--help')
    } finally {
        Pop-Location
    }
    $setupLog.Write('succeeded', 'Dependencies installed. Run start_relay.bat, then import manifest.json in Figma Desktop.')
} catch {
    $setupLog.Write('failed', $_.Exception.Message)
    exit 1
}
