param(
    [string]$GatewayUrl = "http://127.0.0.1:32130",
    [switch]$ValidateNodeTools
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $ScriptDir)).Path
$GatewayBaseUrl = $GatewayUrl.TrimEnd("/")
$ExpectedRoot = $PluginRoot.TrimEnd('\')
$DistScript = Join-Path $PluginRoot "dist\index.js"
$LogDir = Join-Path $PluginRoot ".logs"
$LocalDir = Join-Path $PluginRoot ".local"
$LocalNodeDir = Join-Path $LocalDir "node"
$TokenFile = Join-Path $LocalDir "admin-token.txt"

function Test-ExistingGateway {
    try {
        $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/health" -TimeoutSec 2
    } catch {
        return $false
    }

    if ($health.mode -ne "node-gateway") {
        throw "Port 32130 is occupied by a non-Node Figma MCP Relay. Stop it before starting this gateway."
    }
    if (-not $health.gateway.pluginRoot) {
        throw "Port 32130 is occupied by a Node gateway without a plugin root."
    }

    $activeRoot = (Resolve-Path -LiteralPath $health.gateway.pluginRoot).Path.TrimEnd('\')
    if ($activeRoot -ne $ExpectedRoot) {
        throw "Port 32130 is already used by another Figma MCP Relay checkout: $activeRoot"
    }

    Write-Host "Figma MCP Relay Node gateway is already running." -ForegroundColor Green
    return $true
}

function Get-AdminToken {
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    if (-not (Test-Path -LiteralPath $TokenFile)) {
        [guid]::NewGuid().ToString("N") | Set-Content -LiteralPath $TokenFile -Encoding ASCII
    }
    return (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}

function Resolve-NodeTools {
    $localNode = Join-Path $LocalNodeDir "node.exe"
    if (Test-Path -LiteralPath $localNode -PathType Leaf) {
        $nodePath = (Resolve-Path -LiteralPath $localNode).Path
        $env:Path = "$LocalNodeDir;$env:Path"
    } else {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            throw "node.exe was not found in PATH. Install Node.js 18+ first."
        }
        $nodePath = $node.Source
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    $npmPath = if ($npm) {
        $npm.Source
    } else {
        $nodeDirectory = Split-Path -Parent $nodePath
        @("npm.cmd", "npm.ps1", "npm") |
            ForEach-Object { Join-Path $nodeDirectory $_ } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
    }
    if (-not $npmPath) {
        throw "npm was not found in PATH or beside node.exe: $nodePath. Install a full Node.js distribution, or place one under .local\\node."
    }

    return [pscustomobject]@{
        NodePath = $nodePath
        NpmPath = $npmPath
    }
}

function Ensure-GatewayBuild {
    $nodeTools = Resolve-NodeTools

    $nodeModules = Join-Path $PluginRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
        Push-Location $PluginRoot
        try {
            & $nodeTools.NpmPath install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }

    $needsBuild = -not (Test-Path -LiteralPath $DistScript)
    if (-not $needsBuild) {
        $distTime = (Get-Item -LiteralPath $DistScript).LastWriteTimeUtc
        $inputs = @("package.json", "package-lock.json", "tsconfig.json") | ForEach-Object { Join-Path $PluginRoot $_ }
        $newerInput = $inputs | Where-Object { (Test-Path -LiteralPath $_) -and ((Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $distTime) } | Select-Object -First 1
        $newerSource = Get-ChildItem -LiteralPath (Join-Path $PluginRoot "src") -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $distTime } | Select-Object -First 1
        $needsBuild = ($null -ne $newerInput) -or ($null -ne $newerSource)
    }
    if ($needsBuild) {
        Push-Location $PluginRoot
        try {
            & $nodeTools.NpmPath run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }

    return $nodeTools
}

function Start-GatewayProcess {
    $node = Ensure-GatewayBuild
    $token = Get-AdminToken
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $stdoutLog = Join-Path $LogDir "figma-mcp-relay.stdout.log"
    $stderrLog = Join-Path $LogDir "figma-mcp-relay.stderr.log"
    $arguments = @(
        $DistScript,
        "--host", "127.0.0.1",
        "--public-host", "localhost",
        "--port", "32130",
        "--transport", "auto",
        "--admin-token", $token,
        "--asset-root", (Join-Path $PluginRoot ".tmp")
    )

    return Start-Process -FilePath $node.NodePath -ArgumentList $arguments -WorkingDirectory $PluginRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
}

function Wait-ForGateway {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        try {
            $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/health" -TimeoutSec 2
            if ($health.mode -ne "node-gateway" -or -not $health.gateway.pluginRoot) {
                throw "Port 32130 did not return the expected Node gateway health response."
            }
            $activeRoot = (Resolve-Path -LiteralPath $health.gateway.pluginRoot).Path.TrimEnd('\')
            if ($activeRoot -ne $ExpectedRoot) {
                throw "Port 32130 is running another Figma MCP Relay checkout: $activeRoot"
            }
            return
        } catch {
            $lastError = $_.Exception.Message
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            throw "Node gateway exited with code $($Process.ExitCode). Check $LogDir. Last health error: $lastError"
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    throw "Gateway did not become healthy at $GatewayBaseUrl. Check $LogDir. Last error: $lastError"
}

if ($ValidateNodeTools) {
    [void](Resolve-NodeTools)
    exit 0
}

if (Test-ExistingGateway) {
    exit 0
}

$process = Start-GatewayProcess
Wait-ForGateway -Process $process
Write-Host "Figma MCP Relay Companion started in background." -ForegroundColor Green
