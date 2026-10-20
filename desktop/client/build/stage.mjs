import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const clientFiles = Object.freeze([
  'package.json', 'main.mjs', 'preload.cjs', 'index.html', 'hands.mjs',
  'auth.mjs', 'session.mjs', 'style.css', 'ui.js',
]);
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
async function copyRegular(source, destination) {
  if (!(await lstat(source)).isFile()) throw new Error(`Not a regular source file: ${source}`);
  await copyFile(source, destination);
}
export async function stageClient(root, output) {
  root = await realpath(root);
  output = resolve(output);
  if (inside(root, output)) throw new Error('Artifacts must live outside the repository.');
  await mkdir(output, { recursive: true });
  if (inside(root, await realpath(output))) throw new Error('Output symlink points inside the repository.');
  const client = join(root, 'desktop', 'client');
  const stage = await mkdtemp(join(output, '.stage-'));
  // No server, kiosk, environment files, test fixtures or profile.
  for (const name of clientFiles) await copyRegular(join(client, name), join(stage, name));
  await copyRegular(join(client, 'build', 'icon.png'), join(stage, 'icon.png'));
  await copyRegular(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  const ws = join(root, 'node_modules', 'ws');
  if (!(await lstat(join(root, 'node_modules'))).isDirectory() || !(await lstat(ws)).isDirectory()) {
    throw new Error('ws must be an independently installed root dependency, not a symlink.');
  }
  const wsVersion = JSON.parse(await readFile(join(ws, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (wsVersion !== manifest.dependencies.ws || wsVersion !== rootManifest.dependencies.ws) {
    throw new Error('Client ws version must match the pinned installed root dependency.');
  }
  manifest.version = rootManifest.version;
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(stage, 'node_modules'), { recursive: true });
  await cp(ws, join(stage, 'node_modules', 'ws'), { recursive: true, dereference: false,
    filter: async source => {
      if ((await lstat(source)).isSymbolicLink()) throw new Error('Refusing a symlink in ws staging.');
      return true;
    },
  });
  return stage;
}
