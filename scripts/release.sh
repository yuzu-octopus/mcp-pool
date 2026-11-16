#!/bin/sh
# Usage: scripts/release.sh <version>
# Local release prep: lockstep bump -> binary rebuild -> full gate ->
# commit -> tag -> push. Stops before npm publish (needs human OTP):
# run scripts/publish-all.sh next.
set -eu
V="${1:?usage: scripts/release.sh <version>}"
rm -rf dist-bin
scripts/bump-versions.sh "$V"
bun install
rm -rf ./dist-bin
scripts/build-binaries.sh "$V" ./dist-bin
scripts/gate.sh
git add -A
git commit -m "chore: release $V"
git tag "$V"
git push origin main "$V"
echo "tagged $V. next: scripts/publish-all.sh"
