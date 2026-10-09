param(
    [Parameter(Mandatory=$true)][string]$Directory,
    [Parameter(Mandatory=$true)][string]$Archive
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = (Resolve-Path -LiteralPath $Directory).Path
$destination = [System.IO.Path]::GetFullPath($Archive)
if (Test-Path -LiteralPath $destination) { throw 'Archive already exists' }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $source, $destination, [System.IO.Compression.CompressionLevel]::Optimal, $true
)
$zip = [System.IO.Compression.ZipFile]::OpenRead($destination)
try {
    $entries = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
    ConvertTo-Json -InputObject $entries -Compress
} finally { $zip.Dispose() }

