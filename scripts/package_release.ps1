param(
    [switch]$NoLaunch,
    [switch]$NoOpenFigma,
    [switch]$NoVersionBump
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$LocalNodeDir = Join-Path $PluginRoot ".local\node"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

function Assert-PathInside {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\\')
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\\')
    if (-not $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside release output: $fullPath"
    }
}

function Copy-ReleaseItem {
    param(
        [string]$RelativePath,
        [string]$DestinationRoot
    )

    $source = Join-Path $PluginRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required release item is missing: $source"
    }

    $destination = Join-Path $DestinationRoot $RelativePath
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Ensure-NodeEnvironment {
    if (Test-Path -LiteralPath (Join-Path $LocalNodeDir "node.exe")) {
        $env:Path = "$LocalNodeDir;$env:Path"
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm -or -not $python) {
        throw "Packaging requires node, npm and python in PATH."
    }

    $nodeVersion = (& $node.Source --version).Trim()
    if ($nodeVersion -notmatch "^v?(\d+)\.") {
        throw "Could not parse Node.js version: $nodeVersion"
    }
    if ([int]$Matches[1] -lt 18) {
        throw "Node.js $nodeVersion is too old; Node.js 18+ is required."
    }

    Write-Host "Node.js $nodeVersion; Python $((& $python.Source --version).Trim())" -ForegroundColor Green
}

function Ensure-NpmDependencies {
    $nodeModules = Join-Path $PluginRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
        Write-Step "Installing npm dependencies"
        Push-Location $PluginRoot
        try {
            Invoke-Checked -FilePath "npm" -Arguments @("ci")
        } finally {
            Pop-Location
        }
    }
}

function Stop-RelayFromPath {
    param([string]$RelayPath)

    $escapedRoot = [regex]::Escape((Resolve-Path -LiteralPath $RelayPath).Path)
    $targets = Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $escapedRoot -and
        $_.CommandLine -match "dist\\index\.js|figma_mcp_companion\.py|figma_mcp_relay_server\.py"
    }
    $stoppedCount = 0
    foreach ($target in $targets) {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
        if ($?) {
            $stoppedCount++
            Write-Host "Stopped previous Relay process: $($target.ProcessId)" -ForegroundColor Yellow
        }
    }
    return $stoppedCount
}

function Wait-ForRelayStop {
    param([string]$RelayPath)

    $controlledRoot = (Resolve-Path -LiteralPath $RelayPath).Path.TrimEnd('\')
    $deadline = (Get-Date).AddSeconds(10)
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:32130/health" -TimeoutSec 1
            if (-not $health.gateway.pluginRoot) {
                throw "Port 32130 is occupied by a gateway without a plugin root."
            }
            $activeRoot = (Resolve-Path -LiteralPath $health.gateway.pluginRoot).Path.TrimEnd('\')
            if (-not $activeRoot.StartsWith($controlledRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Port 32130 is occupied by another Relay checkout: $activeRoot"
            }
        } catch {
            if ($_.Exception.Message -notmatch "occupied by") {
                return
            }
            throw
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "Previous Relay did not stop within 10 seconds: $controlledRoot"
}

$unityBridge = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge"
$unityBridgeMeta = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge.meta"
if (-not (Test-Path -LiteralPath $unityBridge -PathType Container) -or -not (Test-Path -LiteralPath $unityBridgeMeta -PathType Leaf)) {
    throw "Unity FigmaBridge Editor plugin or its .meta file is missing. Expected: $unityBridge"
}

Write-Step "Checking packaging environment"
Ensure-NodeEnvironment
Ensure-NpmDependencies

Write-Step "Bumping release version"
Push-Location $PluginRoot
try {
    if ($NoVersionBump) {
        $releaseVersion = (Get-Content -Raw -LiteralPath (Join-Path $PluginRoot "package.json") | ConvertFrom-Json).version
    } else {
        $releaseVersion = (& npm version patch --no-git-tag-version).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "npm version patch failed with exit code $LASTEXITCODE"
        }
        $releaseVersion = $releaseVersion.TrimStart("v")
    }
    if ($releaseVersion -notmatch "^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$") {
        throw "npm returned an invalid release version: $releaseVersion"
    }

    Write-Step "Building Relay"
    Invoke-Checked -FilePath "npm" -Arguments @("run", "build")
    Invoke-Checked -FilePath "python" -Arguments @("scripts/build.py")
} finally {
    Pop-Location
}

$outputRoot = Join-Path $PluginRoot "output"
$releaseName = "figma-mcp-relay-$releaseVersion"
$releaseRoot = Join-Path $outputRoot $releaseName
$zipPath = Join-Path $outputRoot "$releaseName.zip"
$relayRoot = Join-Path $releaseRoot "figma-mcp-relay"
$unityRoot = Join-Path $releaseRoot "unity"

Assert-PathInside -Path $releaseRoot -Root $outputRoot
Assert-PathInside -Path $zipPath -Root $outputRoot
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $releaseRoot) {
    $stoppedReleaseCount = Stop-RelayFromPath -RelayPath $releaseRoot
    if ($stoppedReleaseCount -gt 0) {
        Wait-ForRelayStop -RelayPath $releaseRoot
    }
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Force -Path $relayRoot, $unityRoot | Out-Null

Write-Step "Assembling release package"
$releaseItems = @(
    "ai", "client", "code", "dist", "prompts", "scripts", "server", "src",
    ".build_version", ".gitignore", "build.bat", "code.js", "manifest.json", "package-lock.json",
    "package.json", "README.md", "tsconfig.json", "ui.html"
)
foreach ($item in $releaseItems) {
    Copy-ReleaseItem -RelativePath $item -DestinationRoot $relayRoot
}
Get-ChildItem -LiteralPath $PluginRoot -Filter "*.bat" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $relayRoot $_.Name) -Force
}

$unityAssetsRoot = Join-Path $unityRoot "Assets\Editor"
New-Item -ItemType Directory -Force -Path $unityAssetsRoot | Out-Null
Copy-Item -LiteralPath $unityBridge -Destination (Join-Path $unityAssetsRoot "FigmaBridge") -Recurse -Force
Copy-Item -LiteralPath $unityBridgeMeta -Destination (Join-Path $unityAssetsRoot "FigmaBridge.meta") -Force
$unityReadme = Join-Path $unityRoot "README.md"
@(
    "# Unity FigmaBridge Installation",
    "",
    "Copy Assets/Editor/FigmaBridge and Assets/Editor/FigmaBridge.meta together into the target Unity project's Assets/Editor/ directory.",
    "This plugin contains only an Editor Assembly and does not enter the game Runtime."
) | Set-Content -LiteralPath $unityReadme -Encoding UTF8

Compress-Archive -Path (Join-Path $releaseRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "Release directory: $releaseRoot" -ForegroundColor Green
Write-Host "Release archive:   $zipPath" -ForegroundColor Green

if (-not $NoLaunch) {
    Write-Step "Launching packaged Relay"
    [void](Stop-RelayFromPath -RelayPath $PluginRoot)
    Wait-ForRelayStop -RelayPath $PluginRoot
    $launcher = Join-Path $relayRoot "scripts\start_mcp_oneclick.ps1"
    $launchArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher, "-NoPause")
    if (-not $NoOpenFigma) {
        $launchArguments += "-OpenFigma"
    }
    & powershell.exe @launchArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged Relay launcher failed with exit code $LASTEXITCODE"
    }
    Write-Host "Packaged Relay is ready: $launcher" -ForegroundColor Green
}
