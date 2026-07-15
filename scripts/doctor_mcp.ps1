param(
    [ValidateSet("codex", "claude")]
    [string]$Client = "codex",
    [string]$GatewayUrl = "http://127.0.0.1:32130"
)

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$baseUrl = $GatewayUrl.TrimEnd("/")
$manifestPath = Join-Path $PluginRoot "manifest.json"
$distScript = Join-Path $PluginRoot "dist\index.js"
$tokenFile = Join-Path $PluginRoot ".local\admin-token.txt"

function Check($Name, [scriptblock]$Body) {
    try {
        $result = & $Body
        Write-Host "[OK] $Name $result" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] $Name $($_.Exception.Message)" -ForegroundColor Red
    }
}

Check "Node.js" {
    $node = Get-Command node -ErrorAction Stop
    $version = & $node.Source --version
    $version
}

Check "Gateway build" {
    if (-not (Test-Path $distScript)) { throw "dist\index.js not found. Run npm run build." }
    "found"
}

Check "Gateway health" {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 3
    if ($health.mode -ne "node-gateway") { throw "unexpected mode: $($health.mode)" }
    if ($health.gateway -and $health.gateway.pluginRoot) {
        $expectedRoot = (Resolve-Path $PluginRoot).Path
        $actualRoot = (Resolve-Path ([string]$health.gateway.pluginRoot)).Path
        if ($actualRoot -ne $expectedRoot) { throw "gateway pluginRoot mismatch: $actualRoot" }
    }
    "pending=$($health.pending) pluginConnected=$($health.plugin.connected)"
}

Check "MCP config ($Client)" {
    $status = Invoke-RestMethod -Uri "$baseUrl/mcp/config/status?client=$Client" -Method Get -TimeoutSec 3
    if (-not $status.configured) { throw "not configured. Run scripts\setup_mcp_config.ps1 -Client $Client -Action write." }
    $status.entryUrl
}

Check "Admin token" {
    if (-not (Test-Path $tokenFile)) { throw ".local\admin-token.txt not found" }
    "found"
}

Check "Figma manifest localhost domains" {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $domains = @($manifest.networkAccess.devAllowedDomains)
    if ($domains -contains "http://127.0.0.1:32129" -or $domains -contains "http://127.0.0.1:32130") {
        throw "manifest contains 127.0.0.1 devAllowedDomains"
    }
    if (-not ($domains -contains "ws://localhost:32130")) {
        throw "missing ws://localhost:32130"
    }
    "ok"
}
