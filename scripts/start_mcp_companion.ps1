param(
    [ValidateSet("gateway", "relay", "mcp", "bridge")]
    [string]$Mode = "mcp"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$RelayScript = Join-Path $PluginRoot "server\figma_mcp_relay_server.py"
$DistScript = Join-Path $PluginRoot "dist\index.js"
$LocalDir = Join-Path $PluginRoot ".local"
$AdminTokenFile = Join-Path $LocalDir "admin-token.txt"

function Get-AdminToken {
    if (-not (Test-Path $LocalDir)) {
        New-Item -ItemType Directory -Path $LocalDir | Out-Null
    }
    if (-not (Test-Path $AdminTokenFile)) {
        [guid]::NewGuid().ToString("N") | Set-Content -LiteralPath $AdminTokenFile -Encoding ASCII
    }
    return (Get-Content -LiteralPath $AdminTokenFile -Raw).Trim()
}

function Ensure-NodeGatewayBuild {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "node.exe was not found in PATH. Install Node.js 18+ or use -Mode relay for the legacy Python relay."
    }
    if (-not (Test-Path (Join-Path $PluginRoot "node_modules"))) {
        Write-Host "Installing Node dependencies..." -ForegroundColor Yellow
        Push-Location $PluginRoot
        try { npm install } finally { Pop-Location }
    }

    $needsBuild = -not (Test-Path $DistScript)
    if (-not $needsBuild) {
        $distTime = (Get-Item $DistScript).LastWriteTimeUtc
        $inputs = @(
            (Join-Path $PluginRoot "package.json"),
            (Join-Path $PluginRoot "package-lock.json"),
            (Join-Path $PluginRoot "tsconfig.json")
        )
        foreach ($inputPath in $inputs) {
            if ((Test-Path $inputPath) -and (Get-Item $inputPath).LastWriteTimeUtc -gt $distTime) {
                $needsBuild = $true
                break
            }
        }
        if (-not $needsBuild) {
            $newerSource = Get-ChildItem -LiteralPath (Join-Path $PluginRoot "src") -Recurse -File |
                Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
                Select-Object -First 1
            $needsBuild = $null -ne $newerSource
        }
    }

    if ($needsBuild) {
        Write-Host "Building Node gateway..." -ForegroundColor Yellow
        Push-Location $PluginRoot
        try { npm run build } finally { Pop-Location }
    }
}

if ($Mode -eq "mcp" -or $Mode -eq "gateway") {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:32130/health" -TimeoutSec 2
        if ($health.mode -eq "node-gateway") {
            Write-Host "Figma MCP Relay Node gateway is already running at http://127.0.0.1:32130." -ForegroundColor Green
            return
        }
        Write-Host "Port 32130 is already used by a legacy Figma MCP companion." -ForegroundColor Red
        Write-Host "Run stop_mcp.bat first, then start this gateway again." -ForegroundColor Yellow
        exit 1
    } catch {
        # Not running yet.
    }
    Ensure-NodeGatewayBuild
    Write-Host "Starting Figma MCP Relay Node gateway..." -ForegroundColor Cyan
    Write-Host "Script: $DistScript"
    Write-Host "MCP endpoint: http://127.0.0.1:32130/mcp"
    Write-Host "Plugin relay: http://localhost:32130"
    Write-Host "Keep this window open while Codex/AI and the Figma plugin are connected."
    Write-Host ""
    $adminToken = Get-AdminToken
    node $DistScript --host 127.0.0.1 --public-host localhost --port 32130 --transport auto --admin-token $adminToken --asset-root (Join-Path $PluginRoot ".tmp")
} else {
    Write-Host "Starting legacy Python Figma MCP Relay for internal debugging..." -ForegroundColor Cyan
    Write-Host "Script: $RelayScript"
    Write-Host "Legacy relay endpoint: http://127.0.0.1:32131"
    Write-Host "Use -Mode gateway for the standard AI-facing Node gateway."
    Write-Host ""
    python $RelayScript --port 32131
}

Write-Host ""
Write-Host "Process exited. Press any key to close this window..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
