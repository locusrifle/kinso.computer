// Shared by installation and machine startup. Only run between machines:
// npm ci replaces node_modules, so never rebuild beneath a working server.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function installMacPackages(root, { node = process.execPath, env = process.env, run = spawnSync,
  beforeInstall = () => {}, log = text => console.log(`imperfect: ${text}`) } = {}) {
  const lock = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
  const marker = join(root, 'node_modules/.imperfect-lock');
  let installed = '';
  try { installed = readFileSync(marker, 'utf8').trim(); } catch { /* first install */ }
  if (installed === lock) return false;
  beforeInstall();
  log('installing dependencies (npm ci)');
  const done = run(join(dirname(node), 'npm'), ['ci', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: root, env: { ...env, PATH: `${dirname(node)}:${env.PATH ?? '/usr/bin:/bin'}` }, stdio: 'inherit', timeout: 600_000,
  });
  // Fail closed: the keeper retries startup; never load a half-installed tree.
  if (done.error || done.status !== 0) throw new Error('npm ci failed; dependencies will be retried on the next start');
  writeFileSync(marker, `${lock}\n`);
  return true;
}
