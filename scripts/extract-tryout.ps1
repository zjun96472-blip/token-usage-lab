param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Directory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destination = [System.IO.Path]::GetFullPath($Directory)
$temporary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $destination.StartsWith($temporary, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Acceptance extraction must stay inside the temporary directory'
}
if (Test-Path -LiteralPath $destination) { throw 'Extraction destination already exists' }
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try {
    foreach ($entry in $zip.Entries) {
        $target = [System.IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        if (-not $target.StartsWith($destination + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Archive entry escapes extraction directory'
        }
    }
} finally { $zip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $destination)

