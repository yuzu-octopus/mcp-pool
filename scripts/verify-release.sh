#!/bin/sh
# Usage: scripts/verify-release.sh <version>
# Confirm all 8 packages exist at <version> with matching pins.
set -eu
V="${1:?usage: scripts/verify-release.sh <version>}"
fail=0
for p in mcp-pool \
  @yuzu-octopus/mcp-pool-darwin-arm64 @yuzu-octopus/mcp-pool-darwin-x64 \
  @yuzu-octopus/mcp-pool-linux-x64 @yuzu-octopus/mcp-pool-linux-x64-musl \
  @yuzu-octopus/mcp-pool-linux-arm64 \
  @yuzu-octopus/mcp-pool-win32-x64 @yuzu-octopus/mcp-pool-win32-arm64; do
  got="$(npm view "$p@$V" version 2>/dev/null || echo MISSING)"
  printf '%s: %s\n' "$p" "$got"
  [ "$got" = "$V" ] || fail=1
done
pins="$(npm view "mcp-pool@$V" optionalDependencies 2>/dev/null | grep -c "'$V'" || true)"
echo "pins at $V: $pins/7"
[ "$pins" = 7 ] || fail=1
[ "$fail" = 0 ] && echo "release $V: complete" || { echo "release $V: INCOMPLETE"; exit 1; }
