#!/bin/sh
# Usage: scripts/release.sh <version>
# Local release prep: lockstep bump -> binary rebuild -> full gate ->
# commit -> tag -> push. Stops before npm publish (needs human OTP):
# run scripts/publish-all.sh next.
set -eu
V="${1:?usage: scripts/release.sh <version>}"
# Fail before anything is built: v-prefix would bake `v1.2.3` into versions
# and tag `vv1.2.3`; dirty files would land in the release commit.
case "$V" in
v*) echo "release.sh: drop the v prefix: release.sh ${V#v}" >&2; exit 1 ;;
*.*.*) ;;
*) echo "release.sh: want X.Y.Z, got '$V'" >&2; exit 1 ;;
esac
case "$V" in "" | *[!0-9.]* | .* | *. | *..*) echo "release.sh: want X.Y.Z, got '$V'" >&2; exit 1 ;; esac
[ -z "$(git status --porcelain)" ] || {
	echo "release.sh: tree not clean:" >&2
	git status --short >&2
	exit 1
}
if git rev-parse "v$V" >/dev/null 2>&1 || git ls-remote --exit-code origin "refs/tags/v$V" >/dev/null 2>&1; then
	echo "release.sh: tag v$V already exists" >&2
	exit 1
fi
rm -rf dist-bin
scripts/bump-versions.sh "$V"
bun install
scripts/build-binaries.sh "$V" dist-bin
scripts/gate.sh
git add -A
git commit -m "chore: release $V"
git tag "v$V"
git push origin main "v$V"
echo "tagged v$V. next: scripts/publish-all.sh"
