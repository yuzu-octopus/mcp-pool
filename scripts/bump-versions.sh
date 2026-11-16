#!/bin/sh
# Usage: scripts/bump-versions.sh <version>
# Lockstep version bump: root package.json, its optionalDependencies pins,
# and all 7 platform packages together (skew across the family is the #1
# failure mode — scripts/check-versions.sh gates every publish on it).
set -eu
V="$1"
cd -- "$(dirname -- "$0")/.."
V="$V" bun -e '
	const v = process.env.V;
	for (const f of ["package.json", ...new Bun.Glob("platform/*/package.json").scanSync(".")]) {
		const p = await Bun.file(f).json();
		p.version = v;
		// Main pins its platform binaries exactly; the pins move with it.
		for (const dep of Object.keys(p.optionalDependencies ?? {})) {
			p.optionalDependencies[dep] = v;
		}
		await Bun.write(f, `${JSON.stringify(p, null, "\t")}\n`);
		console.log(`${f} -> ${v}`);
	}'
