#!/bin/sh
# Usage: scripts/gate.sh
# Full local gate, fail-fast: format -> lint -> typecheck -> test ->
# smoke -> build -> package check. What CI runs, minus the matrix.
set -eu
cd -- "$(dirname -- "$0")/.."
bun run format
bun run lint
bun run typecheck
bun run test
bun run smoke
bun run build
bun run check:package
echo "gate: green"
