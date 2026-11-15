#!/bin/sh
# Usage: scripts/build-binaries.sh <version> <outdir>
# Builds one `bun build --compile` binary per matrix row for the CURRENT
# lockstep version. Cross-compile is bun-native (--target); no per-OS
# runners needed for the build itself (runners verify in check.yml).
#
# Flag choice (measured 2026-11-15, Bun 1.4.4, 318 modules):
#   plain --minify  89,671,778 bytes
#   + --trim        89,671,778 bytes (identical, +0% — saves nothing here)
#   + --bytecode    94,130,018 bytes (+5%)
# So plain --minify (same flags as the old postinstall) is the default:
# --trim saves nothing, --bytecode costs 5%.
set -eu
VERSION="$1"; OUT="$2"
cd -- "$(dirname -- "$0")/.."
mkdir -p "$OUT"
echo "build-binaries: version $VERSION -> $OUT"
for t in linux-x64 linux-x64-musl linux-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64; do
	case "$t" in
		linux-x64) TARGET=bun-linux-x64 ;;
		linux-x64-musl) TARGET=bun-linux-x64-musl ;;
		linux-arm64) TARGET=bun-linux-arm64 ;;
		darwin-x64) TARGET=bun-darwin-x64 ;;
		darwin-arm64) TARGET=bun-darwin-arm64 ;;
		win32-x64) TARGET=bun-windows-x64 ;;
		win32-arm64) TARGET=bun-windows-arm64 ;;
	esac
	EXE="$OUT/mcp-pool-$t"
	case "$t" in win32-*) EXE="$EXE.exe" ;; esac
	bun build --compile --minify --target "$TARGET" src/index.ts --outfile "$EXE"
done
ls -la "$OUT"
