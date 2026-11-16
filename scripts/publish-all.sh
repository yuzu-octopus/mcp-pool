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
	# $1 = platform dir, $2 = binary filename in ./dist-bin, $3 = installed filename.
	# Installed name is plain `mcp-pool` so the process shows as mcp-pool, not mcp-pool-<platform>.
	mkdir -p "$1/bin"
	cp "dist-bin/$2" "$1/bin/$3"
	chmod +x "$1/bin/$3"
}
stage platform/linux-x64 mcp-pool-linux-x64 mcp-pool
stage platform/linux-x64-musl mcp-pool-linux-x64-musl mcp-pool
stage platform/linux-arm64 mcp-pool-linux-arm64 mcp-pool
stage platform/darwin-x64 mcp-pool-darwin-x64 mcp-pool
stage platform/darwin-arm64 mcp-pool-darwin-arm64 mcp-pool
stage platform/win32-x64 mcp-pool-win32-x64.exe mcp-pool.exe
stage platform/win32-arm64 mcp-pool-win32-arm64.exe mcp-pool.exe

publish_one() {
	pkg="$1/package.json"
	name="$(bun -e 'console.log((await Bun.file(Bun.argv[1]).json()).name)' "$pkg")"
	ver="$(bun -e 'console.log((await Bun.file(Bun.argv[1]).json()).version)' "$pkg")"
	if npm view "$name@$ver" version >/dev/null 2>&1; then
		echo "skip $name@$ver (already published)"
	else
		(cd "$1" && npm publish)
	fi
}
for d in platform/*/; do publish_one "${d%/}"; done
publish_one .
