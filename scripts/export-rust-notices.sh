#!/usr/bin/env bash
set -euo pipefail
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root="$PWD"
target="${1:-x86_64-pc-windows-msvc}"
mkdir -p .acceptance
cargo metadata --manifest-path src-tauri/Cargo.toml --locked --offline \
  --features desktop,custom-protocol --filter-platform "$target" \
  --format-version 1 > .acceptance/rust-metadata.json
registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
(
  cd "$registry"
  find . -type f \( -iname 'license*' -o -iname 'licence*' -o -iname 'notice*' -o -iname 'copying*' -o -iname 'copyright*' -o -name '.cargo_vcs_info.json' \) -print0 |
    tar --null --files-from=- --create --file="$root/.acceptance/rust-licenses.tar"
)
