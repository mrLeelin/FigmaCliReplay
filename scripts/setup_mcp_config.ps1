param(
    [ValidateSet("codex", "claude")]
    [string]$Client = "codex",
    [ValidateSet("write", "delete", "open", "status")]
    [string]$Action = "write",
    [string]$GatewayUrl = "http://127.0.0.1:32130"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$TokenFile = Join-Path $PluginRoot ".local\admin-token.txt"

if (-not (Test-Path $TokenFile)) {
    throw "Admin token file not found. Start the gateway once with scripts\start_mcp_hidden.bat or start_mcp.bat first."
}

$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$baseUrl = $GatewayUrl.TrimEnd("/")
$health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 5
$expectedRoot = (Resolve-Path $PluginRoot).Path
$actualRoot = ""
if ($health.gateway -and $health.gateway.pluginRoot) {
    $actualRoot = [string]$health.gateway.pluginRoot
}
if ($actualRoot -and ((Resolve-Path $actualRoot).Path -ne $expectedRoot)) {
    throw "Gateway at $baseUrl belongs to another plugin checkout: $actualRoot. Expected: $expectedRoot"
}
$headers = @{
    "Content-Type" = "application/json"
    "X-Figma-Mcp-Relay-Token" = $token
}

if ($Action -eq "status") {
    $status = Invoke-RestMethod -Uri "$baseUrl/mcp/config/status?client=$Client" -Method Get -TimeoutSec 5
    $status | ConvertTo-Json -Depth 8
    exit 0
}

$body = @{ client = $Client } | ConvertTo-Json -Compress
$endpoint = "$baseUrl/mcp/config/$Action"
$result = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body -TimeoutSec 10
$result | ConvertTo-Json -Depth 8
