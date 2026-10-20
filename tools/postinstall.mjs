// After npm installs, keep only this computer's esbuild.
//
// Pi ships an npm-shrinkwrap.json. npm checks os/cpu while it plans the tree,
// but unpacks a dependency's shrinkwrap afterwards, so every optional build in
// it lands: all 26 of esbuild's platform binaries (~280 MB), where one is used.
// Overrides do not reach inside a shrinkwrap either, so this removes the rest.
// On a platform esbuild has no build named for, everything is left alone.

import { readdirSync, rmSync } from 'node:fs';

const dir = new URL('../node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/', import.meta.url);
const ours = `${process.platform}-${process.arch}`;
let builds = [];
try { builds = readdirSync(dir); } catch {}
if (builds.includes(ours)) {
  for (const build of builds) if (build !== ours) rmSync(new URL(build, dir), { recursive: true, force: true });
}
