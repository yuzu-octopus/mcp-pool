#!/bin/sh
# Usage: scripts/bump-versions.sh <version>
# Lockstep version bump: root package.json + all 7 platform packages
# together (skew across the family is the #1 failure mode — the release
# workflows gate on equality and refuse to publish on mismatch).
set -eu
V="$1"
cd -- "$(dirname -- "$0")/.."
V="$V" bun -e '
	const v = process.env.V;
	for (const f of ["package.json", ...new Bun.Glob("platform/*/package.json").scanSync(".")]) {
		const p = await Bun.file(f).json();
		p.version = v;
		await Bun.write(f, `${JSON.stringify(p, null, "\t")}\n`);
		console.log(`${f} -> ${v}`);
	}'
