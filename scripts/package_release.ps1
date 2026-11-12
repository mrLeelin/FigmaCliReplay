param(
    [switch]$NoLaunch,
    [switch]$NoVersionBump,
    [string]$UpdateBaseUrl = '',
    [string]$ManifestUrl = '',
    [string]$SigningKeyPath = '',
    [string]$ReleaseNotesFile = '',
    [string]$GitHubRepository = ''
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$LocalNodeDir = Join-Path $PluginRoot ".local\node"
. (Join-Path $ScriptDir 'relay_logging.ps1')
$packageLog = [RelayScriptLogger]::new('relay.package')
$packageLog.Write('started', 'Build and assemble a distributable Relay archive')

function Write-Step {
    param([string]$Message)
    $packageLog.Write('progress', $Message)
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
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination $destination -Force
        return
    }
    # Copy source files only; stale Python bytecode must never ship retired servers.
    Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object {
        $_.FullName -notmatch '[\\/](__pycache__|\.git|node_modules|\.venv|\.local|\.logs)[\\/]' -and
        $_.Name -notmatch '^\.env(?:\.|$)' -and $_.Extension -notin @('.pyc', '.pyo')
    } | ForEach-Object {
        $relativeFile = $_.FullName.Substring($source.Length).TrimStart([char[]]'\/')
        $targetFile = Join-Path $destination $relativeFile
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetFile) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetFile -Force
    }
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

try {
$unityBridge = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge"
$unityBridgeMeta = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge.meta"
if (-not (Test-Path -LiteralPath $unityBridge -PathType Container) -or -not (Test-Path -LiteralPath $unityBridgeMeta -PathType Leaf)) {
    throw "Unity FigmaBridge Editor plugin or its .meta file is missing. Expected: $unityBridge"
}

Write-Step "Checking packaging environment"
Ensure-NodeEnvironment
Ensure-NpmDependencies
if (-not $PSBoundParameters.ContainsKey('GitHubRepository') -and -not $UpdateBaseUrl -and -not $ManifestUrl) {
    $publisherConfig = Get-Content -Encoding utf8 -Raw -LiteralPath (Join-Path $PluginRoot 'release-config.json') | ConvertFrom-Json
    if ($publisherConfig.githubRepository) { $GitHubRepository = [string]$publisherConfig.githubRepository }
}
if ($GitHubRepository -and ($UpdateBaseUrl -or $ManifestUrl)) {
    throw 'Use GitHubRepository or custom UpdateBaseUrl/ManifestUrl, not both.'
}

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

    Write-Step "Synchronizing release version"
    Invoke-Checked -FilePath "python" -Arguments @("scripts/build.py", "--sync-release-version")

    Write-Step "Building Relay"
    Invoke-Checked -FilePath "npm" -Arguments @("run", "build")
} finally {
    Pop-Location
}

if ($GitHubRepository) {
    $githubUrlsJson = & node (Join-Path $ScriptDir 'create_release_manifest.mjs') 'github-urls' '--repository' $GitHubRepository '--version' $releaseVersion
    if ($LASTEXITCODE -ne 0) { throw 'Invalid GitHub release repository or version.' }
    $githubUrls = $githubUrlsJson | ConvertFrom-Json
    $UpdateBaseUrl = $githubUrls.baseUrl
    $ManifestUrl = $githubUrls.manifestUrl
}

$outputRoot = Join-Path $PluginRoot "output"
$releaseName = "figma-relay-$releaseVersion"
$releaseRoot = Join-Path $outputRoot $releaseName
$zipPath = Join-Path $outputRoot "$releaseName.zip"
$relayRoot = Join-Path $releaseRoot "figma-relay"

Assert-PathInside -Path $releaseRoot -Root $outputRoot
Assert-PathInside -Path $zipPath -Root $outputRoot
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $releaseRoot) {
    throw "Release directory already exists; choose a new version or remove the reviewed output manually."
}
if (Test-Path -LiteralPath $zipPath) {
    throw "Release archive already exists; choose a new version."
}
New-Item -ItemType Directory -Force -Path $relayRoot | Out-Null

Write-Step "Assembling release package"
$releaseItems = @(
    "ai", "client", "code", "dist", "docs", "prompts", "scripts", "server", "src",
    ".build_version", ".gitignore", "build.bat", "code.js", "manifest.json", "package-lock.json",
    "package.json", "README.md", "AGENTS.md", "CLAUDE.md", "LICENSE", "tsconfig.json", "ui.html", "release-config.json",
    "unity\Assets\Editor\FigmaBridge", "unity\Assets\Editor\FigmaBridge.meta"
)
foreach ($item in $releaseItems) {
    Copy-ReleaseItem -RelativePath $item -DestinationRoot $relayRoot
}
Get-ChildItem -LiteralPath $PluginRoot -Filter "*.bat" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $relayRoot $_.Name) -Force
}

Copy-Item -LiteralPath (Join-Path $PluginRoot 'docs\distribution.md') -Destination (Join-Path $releaseRoot 'README.md')

Write-Step "Preparing signed update identity and release feed"
$manifestTool = Join-Path $ScriptDir 'create_release_manifest.mjs'
$prepareArguments = @($manifestTool, 'prepare', '--root', $relayRoot)
if ($UpdateBaseUrl) { $prepareArguments += @('--base-url', $UpdateBaseUrl) }
if ($ManifestUrl) { $prepareArguments += @('--manifest-url', $ManifestUrl) }
if ($GitHubRepository) { $prepareArguments += @('--github-repository', $GitHubRepository) }
if ($SigningKeyPath) { $prepareArguments += @('--private-key', $SigningKeyPath) }
Invoke-Checked -FilePath 'node' -Arguments $prepareArguments

Write-Step "Validating assembled release versions and runtime layout"
Invoke-Checked -FilePath 'node' -Arguments @((Join-Path $ScriptDir 'check_release.mjs'), $relayRoot)
foreach ($requiredUpdateFile in @('release-config.json', 'scripts\install_release.mjs', 'scripts\apply_update.mjs', 'scripts\installed_launcher.mjs', 'scripts\update_common.mjs', 'scripts\extract_update.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $relayRoot $requiredUpdateFile) -PathType Leaf)) {
        throw "Required update release item is missing: $requiredUpdateFile"
    }
}
Compress-Archive -Path (Join-Path $releaseRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Step "Signing archive metadata"
$finalizeArguments = @($manifestTool, 'finalize', '--root', $relayRoot, '--archive', $zipPath, '--output-dir', $outputRoot)
if ($UpdateBaseUrl) { $finalizeArguments += @('--base-url', $UpdateBaseUrl) }
if ($SigningKeyPath) { $finalizeArguments += @('--private-key', $SigningKeyPath) }
if ($ReleaseNotesFile) { $finalizeArguments += @('--notes-file', $ReleaseNotesFile) }
Invoke-Checked -FilePath 'node' -Arguments $finalizeArguments
Write-Host "Release directory: $releaseRoot" -ForegroundColor Green
Write-Host "Release archive:   $zipPath" -ForegroundColor Green

if (-not $NoLaunch) {
    Write-Step "Launching packaged Relay"
    $launcher = Join-Path $relayRoot "scripts\start_relay.ps1"
    $launchArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher)
    & powershell.exe @launchArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged Relay launcher failed with exit code $LASTEXITCODE"
    }
    Write-Host "Packaged Relay is ready: $launcher" -ForegroundColor Green
}
$packageLog.Write('succeeded', "Release $releaseVersion archive created: $zipPath")
} catch {
    $packageLog.Write('failed', $_.Exception.Message)
    throw
}
