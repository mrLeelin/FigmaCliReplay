param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = [IO.Path]::GetFullPath($Archive)
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Extraction destination already exists.' }
[IO.Directory]::CreateDirectory($destinationPath) | Out-Null
$prefix = $destinationPath.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($zip.Entries.Count -gt 10000) { throw 'Update archive contains too many entries.' }
    [long]$total = 0
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Contains([char]0) -or $name -match '(^|/)\.\.(/|$)' -or $name -match '(^|/)\.(/|$)') { throw 'Unsafe path in update archive.' }
        $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixType -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'Links are not allowed in update archives.' }
        $relative = $name.TrimEnd('/')
        if (-not $relative -or -not $names.Add($relative)) { throw 'Duplicate path in update archive.' }
        if ($relative -match '(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$)' -or $relative -match '[. ](/|$)') { throw 'Ambiguous Windows path in update archive.' }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destinationPath, $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)))
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escaped extraction root.' }
        $total += $entry.Length
        if ($entry.Length -gt 536870912 -or $total -gt 2147483648) { throw 'Uncompressed update archive exceeds the allowed size.' }
        if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
} finally { $zip.Dispose() }
