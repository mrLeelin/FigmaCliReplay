param(
    [ValidateSet("none", "codex", "claude", "all")]
    [string]$SetupClient = "none",
    [switch]$OpenFigma,
    [switch]$RunDoctor,
    [switch]$VisibleLog,
    [switch]$NoPause,
    [string]$GatewayUrl = "http://127.0.0.1:32130"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptsDir = $ScriptDir
$PluginRoot = Split-Path -Parent $ScriptDir
$GatewayBaseUrl = $GatewayUrl.TrimEnd("/")
$ExpectedRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$LocalNodeDir = Join-Path $PluginRoot ".local\node"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Gray
}

function Wait-ForGateway {
    param([int]$TimeoutSeconds = 20)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        try {
            $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/health" -Method Get -TimeoutSec 3
            if ($health.mode -ne "node-gateway") {
                throw "Port 32130 responded, but mode is '$($health.mode)', not 'node-gateway'."
            }
            if ($health.gateway -and $health.gateway.pluginRoot) {
                $actualRoot = (Resolve-Path -LiteralPath ([string]$health.gateway.pluginRoot)).Path
                if ($actualRoot -ne $ExpectedRoot) {
                    throw "Port 32130 is running another figma-mcp-relay checkout: $actualRoot. Expected: $ExpectedRoot"
                }
            }
            return $health
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    throw "Gateway did not become healthy at $GatewayBaseUrl. Last error: $lastError"
}

function Test-NodeEnvironment {
    Write-Step "Checking Node.js"
    $localNode = Join-Path $LocalNodeDir "node.exe"
    if (Test-Path $localNode) {
        $env:Path = "$LocalNodeDir;$env:Path"
        Write-Info "Using local portable Node.js: $localNode"
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "node.exe was not found in PATH. Install Node.js 18+ first: https://nodejs.org/"
    }

    $versionText = (& $node.Source --version).Trim()
    if ($versionText -notmatch "^v?(\d+)\.") {
        throw "Could not parse Node.js version: $versionText"
    }
    $major = [int]$Matches[1]
    if ($major -lt 18) {
        throw "Node.js $versionText is too old. Install Node.js 18+; Node.js 22 LTS is recommended."
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw "npm was not found in PATH. Reinstall Node.js with npm enabled, or place a full Node.js distribution under .local\node."
    }

    Write-Host "Node.js $versionText found." -ForegroundColor Green
}

function Ensure-NpmDependencies {
    Write-Step "Checking dependencies"
    $nodeModules = Join-Path $PluginRoot "node_modules"
    $packageLock = Join-Path $PluginRoot "package-lock.json"
    $installedLock = Join-Path $nodeModules ".package-lock.json"
    $needsInstall = -not (Test-Path $nodeModules)

    if ((-not $needsInstall) -and (Test-Path $packageLock)) {
        if (-not (Test-Path $installedLock)) {
            $needsInstall = $true
        } elseif ((Get-Item $packageLock).LastWriteTimeUtc -gt (Get-Item $installedLock).LastWriteTimeUtc) {
            $needsInstall = $true
        }
    }

    if ($needsInstall) {
        Write-Host "Installing Node dependencies with npm install..." -ForegroundColor Yellow
        Push-Location $PluginRoot
        try {
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "Dependencies are already installed." -ForegroundColor Green
    }
}

function Start-Gateway {
    Write-Step "Starting Gateway"
    if ($VisibleLog) {
        $companion = Join-Path $ScriptsDir "start_mcp_companion.ps1"
        Write-Host "Starting visible gateway console. Keep this window open." -ForegroundColor Yellow
        & powershell -NoProfile -ExecutionPolicy Bypass -File $companion -Mode mcp
        if ($LASTEXITCODE -ne 0) {
            throw "visible gateway exited with code $LASTEXITCODE"
        }
        return
    }

    $starter = Join-Path $ScriptsDir "start_mcp_hidden.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $starter -GatewayUrl $GatewayBaseUrl
    if ($LASTEXITCODE -ne 0) {
        throw "start_mcp_hidden.ps1 failed with exit code $LASTEXITCODE"
    }

    $health = Wait-ForGateway -TimeoutSeconds 20
    Write-Host "Gateway is ready." -ForegroundColor Green
    Write-Info "Pending jobs: $($health.pending); plugin connected: $($health.plugin.connected)"
}

function Setup-McpClient {
    param([string]$Client)
    Write-Step "Configuring $Client MCP client"
    $setup = Join-Path $ScriptsDir "setup_mcp_config.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $setup -Client $Client -Action write -GatewayUrl $GatewayBaseUrl
    if ($LASTEXITCODE -ne 0) {
        throw "setup_mcp_config.ps1 failed for $Client with exit code $LASTEXITCODE"
    }
}

function Invoke-Doctor {
    param([string]$Client)
    Write-Step "Running doctor for $Client"
    $doctor = Join-Path $ScriptsDir "doctor_mcp.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $doctor -Client $Client -GatewayUrl $GatewayBaseUrl
}

function Open-FigmaDesktop {
    Write-Step "Opening Figma Desktop"
    $figmaExe = Join-Path $env:LOCALAPPDATA "Figma\Figma.exe"
    if (Test-Path $figmaExe) {
        Start-Process -FilePath $figmaExe -WindowStyle Normal
        Write-Host "Figma Desktop opened." -ForegroundColor Green
    } else {
        Write-Host "Figma Desktop was not found at: $figmaExe" -ForegroundColor Yellow
        Write-Host "Open Figma Desktop manually, then run the development plugin." -ForegroundColor Yellow
    }
}

try {
    Write-Host "LKS Figma MCP Relay one-click launcher" -ForegroundColor Cyan
    Write-Info "Plugin directory: $ExpectedRoot"

    Test-NodeEnvironment
    Ensure-NpmDependencies
    Start-Gateway

    if ($SetupClient -eq "codex" -or $SetupClient -eq "all") {
        Setup-McpClient -Client "codex"
    }
    if ($SetupClient -eq "claude" -or $SetupClient -eq "all") {
        Setup-McpClient -Client "claude"
    }

    if ($RunDoctor) {
        if ($SetupClient -eq "claude") {
            Invoke-Doctor -Client "claude"
        } else {
            Invoke-Doctor -Client "codex"
        }
    }

    if ($OpenFigma) {
        Open-FigmaDesktop
    }

    Write-Step "Ready"
    Write-Host "AI MCP endpoint:     http://127.0.0.1:32130/mcp" -ForegroundColor Green
    Write-Host "Plugin relay URL:    http://localhost:32130" -ForegroundColor Green
    Write-Host "WebSocket endpoint:  ws://localhost:32130/figma" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. Open Figma Desktop and your design file."
    Write-Host "2. Run Plugins > Development > LKS Figma MCP Relay."
    Write-Host "3. Keep the plugin panel open while Codex/AI uses figmaMcpRelay tools."
    if ($SetupClient -eq "none") {
        Write-Host ""
        Write-Host "First-time AI config is optional. Run this when needed:" -ForegroundColor Yellow
        Write-Host "  .\start_mcp_oneclick.bat -SetupClient codex"
        Write-Host "  .\start_mcp_oneclick.bat -SetupClient claude"
    }
    Write-Host ""
    Write-Host "For visible live server logs, run:" -ForegroundColor Yellow
    Write-Host "  .\start_mcp.bat"
    Write-Host "  .\start_mcp_oneclick.bat -VisibleLog"
} catch {
    Write-Host ""
    Write-Host "Figma MCP one-click start failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Useful checks:" -ForegroundColor Yellow
    Write-Host "  .\scripts\doctor_mcp.ps1"
    Write-Host "  .\stop_mcp.bat"
    Write-Host "  .\start_mcp.bat"
    exit 1
} finally {
    if (-not $NoPause) {
        Write-Host ""
        Write-Host "Press any key to close this window..."
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }
}
