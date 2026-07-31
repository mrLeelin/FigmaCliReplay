param(
    [ValidateSet("Install", "Uninstall", "Status")]
    [string]$Action = "Install"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Starter = Join-Path $ScriptDir "start_mcp_hidden.ps1"
$StartupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$StartupCommand = Join-Path $StartupDirectory "FigmaMcpRelay Gateway.cmd"

function Test-AutoStartInstalled {
    return Test-Path -LiteralPath $StartupCommand -PathType Leaf
}

switch ($Action) {
    "Install" {
        if (-not (Test-Path -LiteralPath $Starter -PathType Leaf)) {
            throw "Gateway startup script was not found: $Starter"
        }

        $command = @(
            "@echo off",
            "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Starter`""
        )
        Set-Content -LiteralPath $StartupCommand -Value $command -Encoding ASCII
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Starter
        if ($LASTEXITCODE -ne 0) {
            throw "Gateway startup script failed with exit code $LASTEXITCODE"
        }
        Write-Host "Figma MCP Relay will start automatically when you sign in." -ForegroundColor Green
        Write-Host "Startup entry: $StartupCommand"
    }
    "Uninstall" {
        if (Test-AutoStartInstalled) {
            Remove-Item -LiteralPath $StartupCommand -Force
            Write-Host "Figma MCP Relay automatic startup has been removed." -ForegroundColor Green
        } else {
            Write-Host "Figma MCP Relay automatic startup is not installed."
        }
    }
    "Status" {
        if (-not (Test-AutoStartInstalled)) {
            Write-Host "Figma MCP Relay automatic startup is not installed."
            exit 1
        }
        Write-Host "Figma MCP Relay automatic startup is installed."
        Write-Host "Startup entry: $StartupCommand"
    }
}
