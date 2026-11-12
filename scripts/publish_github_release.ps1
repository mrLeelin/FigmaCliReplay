param(
    [Parameter(Mandatory = $true)][ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$Version,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$TargetCommit,
    [string]$Repository = '',
    [string]$OutputDirectory = '',
    [string]$ReleaseNotesFile = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$publisherRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $publisherRoot 'output' }
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
if (-not $Repository) {
    $publisherConfig = Get-Content -Encoding utf8 -Raw -LiteralPath (Join-Path $publisherRoot 'release-config.json') | ConvertFrom-Json
    $Repository = [string]$publisherConfig.githubRepository
}
if ($Repository -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$') { throw 'Specify a GitHub owner/repository.' }
$archive = Join-Path $OutputDirectory "figma-relay-$Version.zip"
$assembledRoot = Join-Path $OutputDirectory "figma-relay-$Version\figma-relay"
$verifiedJson = & node (Join-Path $PSScriptRoot 'create_release_manifest.mjs') 'verify-github' '--root' $assembledRoot '--archive' $archive '--output-dir' $OutputDirectory '--github-repository' $Repository
if ($LASTEXITCODE -ne 0) { throw 'Local release verification failed. Nothing was uploaded.' }
$verified = $verifiedJson | ConvertFrom-Json
if ($verified.version -ne $Version) { throw 'The selected version does not match the packaged release.' }
$assets = @($verified.files)
foreach ($asset in $assets) {
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw "Release asset is missing: $asset" }
}
if ($ReleaseNotesFile) { $ReleaseNotesFile = (Resolve-Path -LiteralPath $ReleaseNotesFile).Path }
if ($DryRun) {
    [pscustomobject]@{ repository = $Repository; tag = $verified.tag; targetCommit = $TargetCommit; draftFirst = $true; assets = $assets; publish = $false } | ConvertTo-Json -Depth 5
    exit 0
}

$gh = (Get-Command gh -ErrorAction Stop).Source
function Invoke-PublisherGh {
    param([string[]]$Arguments)
    $result = & $gh @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed ($LASTEXITCODE). An existing draft is kept for inspection; no assets are overwritten." }
    return $result
}

$repoJson = Invoke-PublisherGh -Arguments @('repo', 'view', $Repository, '--json', 'nameWithOwner,isPrivate')
$repo = $repoJson | ConvertFrom-Json
if ($repo.isPrivate) { throw 'Automatic updates require a public download repository. The selected repository is private.' }
if ($repo.nameWithOwner -ine $Repository) { throw 'GitHub resolved a different repository. Review the repository name first.' }
$remoteCommit = (Invoke-PublisherGh -Arguments @('api', "repos/$Repository/commits/$TargetCommit", '--jq', '.sha') | Out-String).Trim()
if ($remoteCommit -ine $TargetCommit) { throw 'The exact target commit is not available in the selected GitHub repository. Push the reviewed commit first.' }
$releasesJson = Invoke-PublisherGh -Arguments @('release', 'list', '--repo', $Repository, '--limit', '1000', '--json', 'tagName')
$releases = @($releasesJson | ConvertFrom-Json)
if (@($releases | Where-Object { $_.tagName -eq $verified.tag }).Count -gt 0) { throw 'This release tag already exists. Existing releases and assets are never overwritten.' }
$tagReferencesJson = Invoke-PublisherGh -Arguments @('api', "repos/$Repository/git/matching-refs/tags/$($verified.tag)")
$tagReferences = @($tagReferencesJson | ConvertFrom-Json)
if (@($tagReferences | Where-Object { $_.ref -ceq ('refs/tags/' + $verified.tag) }).Count -gt 0) {
    $tagCommit = (Invoke-PublisherGh -Arguments @('api', "repos/$Repository/commits/$($verified.tag)", '--jq', '.sha') | Out-String).Trim()
    if ($tagCommit -ine $TargetCommit) { throw 'The remote tag already points at a different commit. No tag or release was changed.' }
}

$temporaryNotes = ''
try {
    if (-not $ReleaseNotesFile) {
        $temporaryNotes = Join-Path $OutputDirectory ('.release-notes-' + [guid]::NewGuid().ToString('N') + '.md')
        $notes = @("Figma Relay v$Version", '', 'Windows ZIP: install Node.js 18+ and Python 3.10+, extract the archive, then run the first-install batch file.', '', 'Updates are available in plugin Settings > Version and updates.', '')
        foreach ($note in @($verified.notes)) { $notes += ('- ' + [string]$note) }
        [System.IO.File]::WriteAllText($temporaryNotes, ($notes -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
        $ReleaseNotesFile = $temporaryNotes
    }
    $createArguments = @('release', 'create', [string]$verified.tag, '--repo', $Repository, '--target', $TargetCommit, '--draft', '--title', "Figma Relay v$Version", '--notes-file', $ReleaseNotesFile) + $assets
    Invoke-PublisherGh -Arguments $createArguments | Out-Host
    $draftJson = Invoke-PublisherGh -Arguments @('release', 'view', [string]$verified.tag, '--repo', $Repository, '--json', 'isDraft,targetCommitish,assets')
    $draft = $draftJson | ConvertFrom-Json
    if (-not $draft.isDraft -or $draft.targetCommitish -ine $TargetCommit) { throw 'The uploaded draft does not match the requested target commit.' }
    foreach ($asset in $assets) {
        $localItem = Get-Item -LiteralPath $asset
        $remoteAssets = @($draft.assets | Where-Object { $_.name -ceq $localItem.Name })
        if ($remoteAssets.Count -ne 1 -or [long]$remoteAssets[0].size -ne $localItem.Length) { throw "Draft asset is missing or incomplete: $($localItem.Name). The draft was not published." }
    }
    Invoke-PublisherGh -Arguments @('release', 'edit', [string]$verified.tag, '--repo', $Repository, '--draft=false', '--latest') | Out-Host
    $publishedJson = Invoke-PublisherGh -Arguments @('release', 'view', [string]$verified.tag, '--repo', $Repository, '--json', 'isDraft,url')
    $published = $publishedJson | ConvertFrom-Json
    if ($published.isDraft) { throw 'GitHub still reports this release as a draft.' }
    Write-Output $published.url
    Write-Output "Update feed: https://github.com/$Repository/releases/latest/download/latest.json"
} finally {
    if ($temporaryNotes -and (Test-Path -LiteralPath $temporaryNotes)) { Remove-Item -LiteralPath $temporaryNotes }
}
