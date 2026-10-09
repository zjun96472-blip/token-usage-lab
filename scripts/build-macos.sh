#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'A macOS machine or macOS CI runner is required. No Mac artifact was built.' >&2
  exit 1
fi
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v pnpm >/dev/null
command -v rustup >/dev/null
xcode-select -p >/dev/null

target="${1:-}"
if [[ -z "$target" ]]; then
  case "$(uname -m)" in
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
    *) printf '%s\n' 'Unsupported Mac architecture' >&2; exit 1 ;;
  esac
fi
case "$target" in
  aarch64-apple-darwin|x86_64-apple-darwin) rustup target add "$target" ;;
  universal-apple-darwin) rustup target add aarch64-apple-darwin x86_64-apple-darwin ;;
  *) printf '%s\n' 'Expected a Mac Rust target or universal-apple-darwin' >&2; exit 1 ;;
esac

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:unit
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
notice_target="$target"
if [[ "$target" == universal-apple-darwin ]]; then
  notice_target=aarch64-apple-darwin
fi
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target "$notice_target"
bash scripts/export-rust-notices.sh "$notice_target"
if ! node scripts/generate-notices.mjs; then
  test -f .acceptance/missing-licenses.json
  node scripts/fetch-missing-notices.mjs
  node scripts/generate-notices.mjs
fi
pnpm exec tauri icon src-tauri/icons/128x128.png --output .acceptance/macos-icons
pnpm exec tauri build --ci --features desktop --target "$target" --config \
  '{"bundle":{"active":true,"targets":["app","dmg"],"icon":["../.acceptance/macos-icons/icon.icns","icons/128x128.png"],"resources":{"../LICENSE":"LICENSE","../.acceptance/THIRD-PARTY-NOTICES.txt":"THIRD-PARTY-NOTICES.txt","../docs/MACOS-TRYOUT.md":"START-HERE.txt"},"macOS":{"minimumSystemVersion":"12.0","signingIdentity":"-"}}}' \
  -- --locked
printf 'Candidate artifacts: src-tauri/target/%s/release/bundle\n' "$target"
printf '%s\n' 'Build output is not device acceptance or notarization. Test and sign before general distribution.'
