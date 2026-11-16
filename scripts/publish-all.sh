#!/bin/sh
# Local publish of the 7 platform packages + main, in dependency order
# (platforms first — main's optionalDependencies pins versions that must
# already exist). PRIMARY release path: CI builds the binaries
# (release-binaries.yml), the operator downloads the artifacts into
# ./dist-bin/, stages them, and runs this. Never hand-build per-platform
# binaries on one laptop (undetectable skew).
#
# Usage: ./dist-bin must contain the 7 CI-built binaries, then:
#   scripts/publish-all.sh
set -eu
cd -- "$(dirname -- "$0")/.."

scripts/check-versions.sh

stage() {
	# $1 = platform dir, $2 = binary filename
	mkdir -p "$1/bin"
	cp "dist-bin/$2" "$1/bin/$2"
	chmod +x "$1/bin/$2"
}
stage platform/linux-x64 mcp-pool-linux-x64
stage platform/linux-x64-musl mcp-pool-linux-x64-musl
stage platform/linux-arm64 mcp-pool-linux-arm64
stage platform/darwin-x64 mcp-pool-darwin-x64
stage platform/darwin-arm64 mcp-pool-darwin-arm64
stage platform/win32-x64 mcp-pool-win32-x64.exe
stage platform/win32-arm64 mcp-pool-win32-arm64.exe

for d in platform/*/; do
	(cd "$d" && npm publish)
done
npm publish
