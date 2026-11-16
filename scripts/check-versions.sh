#!/bin/sh
# Usage: scripts/check-versions.sh
# Release gate: the 7 platform packages and main's exact optionalDependencies
# pins must all equal the root version. A stale pin publishes a main package
# whose binaries do not exist, and every install silently falls back to
# `node dist/index.js`.
set -eu
cd -- "$(dirname -- "$0")/.."
bun -e '
	const root = (await Bun.file("package.json").json());
	const pins = root.optionalDependencies ?? {};
	const skew = Object.entries(pins)
		.filter(([, v]) => v !== root.version)
		.map(([name, v]) => `package.json pins ${name}@${v}`);
	// Family membership: every platform dir needs a pin and vice versa.
	// Values can match while the sets drift (added/removed platform).
	const dirs = new Set(
		new Bun.Glob("platform/*/package.json")
			.scanSync(".")
			.map((f) => `@yuzu-octopus/mcp-pool-${f.split("/")[1]}`),
	);
	for (const name of Object.keys(pins))
		if (!dirs.has(name)) skew.push(`package.json pins ${name} with no platform dir`);
	for (const name of dirs)
		if (!(name in pins)) skew.push(`platform dir for ${name} has no pin`);
	for (const f of new Bun.Glob("platform/*/package.json").scanSync(".")) {
		const { version } = await Bun.file(f).json();
		if (version !== root.version) skew.push(`${f} is ${version}`);
	}
	if (skew.length) {
		console.error(`version skew vs root ${root.version}:\n  ${skew.join("\n  ")}`);
		console.error("run scripts/bump-versions.sh <version>");
		process.exit(1);
	}
	console.log(`versions lockstep at ${root.version}`);'
