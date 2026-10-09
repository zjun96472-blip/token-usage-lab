$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Installer smoke tests must run on a disposable GitHub Windows runner, never on a user profile'
}
$root = Split-Path -Parent $PSScriptRoot
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-installer-source.json') -Raw | ConvertFrom-Json
$installers = @(Get-ChildItem -LiteralPath (Join-Path $root 'src-tauri/target/release/bundle/nsis') -File -Filter '*.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
$installer = $installers[0].FullName
$temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$testRoot = [IO.Path]::GetFullPath((Join-Path $temporary "usage-lab-install-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"))
$installDirectory = Join-Path $testRoot 'program'
if (-not $testRoot.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test path escaped runner temp' }
if (Test-Path -LiteralPath $testRoot) { throw 'Refusing to reuse an installation test directory' }
$dataDirectory = Join-Path $env:LOCALAPPDATA 'TokenUsageLab'
if (Test-Path -LiteralPath $dataDirectory) { throw 'Refusing to touch an existing usage ledger' }
$ledger = Join-Path $dataDirectory 'token-usage-lab.sqlite3'
$installedExe = Join-Path $installDirectory 'token-usage-lab.exe'
$uninstallRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Token Usage Lab'
$machineRegistry = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Token Usage Lab'
if ((Test-Path -LiteralPath $uninstallRegistry) -or (Test-Path -LiteralPath $machineRegistry)) { throw 'Existing application installation found' }
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
[IO.File]::WriteAllText((Join-Path $testRoot 'outside-sentinel.txt'), 'SYNTHETIC_KEEP', [Text.UTF8Encoding]::new($false))

function Hash([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Run-Setup([string]$File, [string]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'Installer process timed out' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
function Check-Installed {
    if ((Hash $installedExe) -ne $pin.executableSha256) { throw 'Installed application differs from the approved executable' }
    $resources = Join-Path $root '.acceptance/installer-resources'
    foreach ($file in (Get-ChildItem -LiteralPath $resources -File)) {
        if ((Hash (Join-Path $installDirectory $file.Name)) -ne (Hash $file.FullName)) { throw "Installed resource changed: $($file.Name)" }
    }
    $registered = Get-ItemProperty -LiteralPath $uninstallRegistry
    if ($registered.InstallLocation.Trim('"') -ne $installDirectory) { throw 'Incorrect per-user installation location' }
    if (Test-Path -LiteralPath $machineRegistry) { throw 'Unexpected machine-wide application registration' }
}
function Start-And-Close([int]$Attempt) {
    $process = Start-Process -FilePath $installedExe -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
    try {
        for ($index = 0; $index -lt 60; $index++) {
            Start-Sleep -Milliseconds 500
            $process.Refresh()
            if ($process.HasExited) { throw 'Installed application exited unexpectedly' }
            if ($process.MainWindowHandle -ne 0 -and (Test-Path -LiteralPath $ledger)) { break }
        }
        if ($process.MainWindowHandle -eq 0 -or $process.MainWindowTitle -ne 'Token Usage Lab') { throw 'Native application window not found' }
        if (-not (Test-Path -LiteralPath $ledger)) { throw 'Independent usage ledger was not created' }
        Start-Sleep -Seconds 4
        if (-not $process.CloseMainWindow()) { throw 'Could not close the native application window' }
        if (-not $process.WaitForExit(15000)) { throw 'Application did not exit after closing its window' }
        if ($process.ExitCode -ne 0) { throw "Application exit failed: $($process.ExitCode)" }
        return @{ attempt = $Attempt; nativeWindow = $true; ledgerCreated = $true; cleanExit = $true }
    } finally {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    }
}

$report = @{ result = 'FAIL'; operatingSystem = [Environment]::OSVersion.Version.ToString(); installerSha256 = (Hash $installer) }
try {
    Run-Setup $installer "/S /D=$installDirectory"
    Check-Installed
    $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Token Usage Lab\Token Usage Lab.lnk'
    $shell = New-Object -ComObject WScript.Shell
    if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'Start-menu shortcut missing' }
    if ($shell.CreateShortcut($shortcutPath).TargetPath -ne $installedExe) { throw 'Shortcut target is incorrect' }
    $report.attempts = @(Start-And-Close 1; Start-And-Close 2)
    $ledgerHash = Hash $ledger
    $sentinel = Join-Path $dataDirectory 'keep-statistics.txt'
    [IO.File]::WriteAllText($sentinel, 'SYNTHETIC_KEEP', [Text.UTF8Encoding]::new($false))
    $extra = Join-Path $installDirectory 'user-owned-file.txt'
    [IO.File]::WriteAllText($extra, 'SYNTHETIC_KEEP', [Text.UTF8Encoding]::new($false))
    Run-Setup $installer "/S /D=$installDirectory"
    Check-Installed
    if ((Hash $ledger) -ne $ledgerHash -or -not (Test-Path -LiteralPath $sentinel)) { throw 'Reinstall changed existing statistics' }
    $uninstaller = [IO.Path]::GetFullPath((Join-Path $installDirectory 'uninstall.exe'))
    if (-not $uninstaller.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall target escaped verified test directory' }
    Run-Setup $uninstaller '/S'
    for ($index = 0; $index -lt 60 -and (Test-Path -LiteralPath $installedExe); $index++) { Start-Sleep -Milliseconds 500 }
    if ((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $uninstallRegistry) -or (Test-Path -LiteralPath $shortcutPath)) { throw 'Uninstall did not remove the application registration, binary or shortcut' }
    if ((Hash $ledger) -ne $ledgerHash) { throw 'Uninstall changed the statistics ledger' }
    foreach ($file in @($sentinel, $extra, (Join-Path $testRoot 'outside-sentinel.txt'))) {
        if ([IO.File]::ReadAllText($file) -ne 'SYNTHETIC_KEEP') { throw 'Install or uninstall changed user-owned files' }
    }
    $report.result = 'PASS'
    $report.currentUserInstall = $true
    $report.startMenuShortcut = $true
    $report.reinstallPreservesLedger = $true
    $report.uninstallPreservesLedger = $true
    $report.uninstallPreservesUnownedFiles = $true
    $report.installedExecutableSha256 = $pin.executableSha256
    $report.signature = (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()
    $report.limitations = @('Disposable Windows Server 2022 runner', 'Missing-WebView2 download path not exercised', 'SmartScreen and managed-device policies not validated', 'Application binary unchanged from the earlier Windows 11 candidate')
} finally {
    $json = $report | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $root '.acceptance/windows-installer-verification.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output $json
}
