param([string]$Registry = 'ghcr.io')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($Registry -notin @('ghcr.io','ghcr.nju.edu.cn')) { throw 'Unsupported registry' }
$image = "$Registry/rust-cross/cargo-xwin@sha256:10fa1f350addf9c59345954f9d6eb10e353ba481c6130757a5c95d8daad37191"
Push-Location $root
try {
    & node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Type check failed' }
    & node node_modules/vite/bin/vite.js build
    if ($LASTEXITCODE -ne 0) { throw 'Renderer build failed' }
    & docker run --rm --mount "type=bind,source=$root,target=/workspace" --workdir /workspace/src-tauri -e CARGO_BUILD_JOBS=4 $image cargo xwin build --locked --release --target x86_64-pc-windows-msvc --features desktop,custom-protocol,cli --bin token-usage-lab --bin usage-lab-cli
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
    Write-Output (Join-Path $root 'src-tauri\target\x86_64-pc-windows-msvc\release\token-usage-lab.exe')
} finally { Pop-Location }
