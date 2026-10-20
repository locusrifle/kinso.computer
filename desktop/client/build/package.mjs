// One root install, one separately allowlisted standalone renter app.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageClient } from './stage.mjs';

const build = dirname(fileURLToPath(import.meta.url));
const root = resolve(build, '../../..');
const platform = process.argv[2];
if (!['linux', 'win', 'mac'].includes(platform) || process.argv.length !== 3) {
  throw new Error('Usage: node desktop/client/build/package.mjs linux|win|mac');
}
if (platform === 'mac' && process.platform !== 'darwin') {
  throw new Error('Build mac zip/dmg on macOS; Linux cannot validate, sign or notarize this app.');
}
const output = resolve(process.env.IMPERFECT_DESKTOP_OUTPUT || join(root, '..', 'artifacts', 'desktop-client'));
const stage = await stageClient(root, output);
console.log(`Standalone client stage: ${stage}\nArtifacts: ${output}`);
const env = { ...process.env, IMPERFECT_DESKTOP_STAGE: stage, IMPERFECT_DESKTOP_OUTPUT: output,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
// Reuse root Electron on Linux, instead of downloading a second copy. On other
// targets electron-builder fetches the same pinned version for that platform.
const args = ['--config', join(build, 'builder.cjs'), '--publish', 'never', `--${platform}`];
args.push(...(platform === 'mac' ? ['--x64', '--arm64'] : ['--x64']));
if (platform === 'linux' && process.platform === 'linux') args.push(`--config.electronDist=${join(root, 'node_modules', 'electron', 'dist')}`);
// Invoke JS via Node directly: .bin shims are .cmd files on Windows.
const child = spawn(process.execPath, [join(root, 'node_modules', 'electron-builder', 'cli.js'), ...args], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code; });
