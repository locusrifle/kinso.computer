// The Mac's installer and keeper (desktop/mac), checked from any computer:
// what imperfect.app is told, its one line of code, and the keeper keeping a
// stand-in machine running, starting it again, and stopping with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BUNDLE_ID, plist, STUB, iconName } from '../../../desktop/mac/install.mjs';

const exec = promisify(execFile);
const keeper = new URL('../../../desktop/mac/keeper.mjs', import.meta.url).pathname;
const until = async (check, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (await check()) return true;
  return false;
};

test('imperfect.app is named imperfect, opens folders, and says why it asks for the mic and the folders', () => {
  const told = plist('0.4.0');
  assert.equal(BUNDLE_ID, 'computer.imperfect.code');
  assert.equal(told.CFBundleIdentifier, BUNDLE_ID);
  assert.equal(told.CFBundleExecutable, 'imperfect');
  assert.equal(told.CFBundleIconFile, 'imperfect.icns');
  // Named by its picture, so a new icon is not the one macOS kept.
  assert.match(iconName(Buffer.from('goat')), /^imperfect-[0-9a-f]{10}\.icns$/);
  assert.notEqual(iconName(Buffer.from('goat')), iconName(Buffer.from('silver goat')));
  assert.equal(plist('0.4.0', iconName(Buffer.from('goat'))).CFBundleIconFile, iconName(Buffer.from('goat')));
  assert.deepEqual(told.CFBundleDocumentTypes[0].LSItemContentTypes, ['public.folder']);
  for (const key of ['NSMicrophoneUsageDescription', 'NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription']) assert.ok(told[key]?.length > 10, key);
});

test('the app\'s own code is a module that opens the checkout\'s window', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-stub-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'main.mjs'), STUB);
  await exec(process.execPath, ['--check', join(dir, 'main.mjs')]);
  assert.match(STUB, /desktop\/electron\/main\.mjs/);
  assert.match(STUB, /mac\.json/);
});

test('keeper stop waits for a working machine to settle, without replacing or killing it', async t => {
  const prefix = await mkdtemp(join(tmpdir(), 'mac-keeper-idle-'));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const machine = join(prefix, 'machine.mjs');
  await writeFile(machine, `import { existsSync, writeFileSync } from 'node:fs';
const prefix = ${JSON.stringify(prefix)};
writeFileSync(prefix + '/started', String(process.pid));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; writeFileSync(prefix + '/settling', 'yes'); });
setInterval(() => { if (stopping && existsSync(prefix + '/idle')) process.exit(0); }, 20);
`);
  const env = { ...process.env, IMPERFECT_PREFIX: prefix, IMPERFECT_KEEPER_SCRIPT: machine };
  const kept = spawn(process.execPath, [keeper], { env, stdio: 'ignore' });
  let machinePid;
  t.after(() => { for (const pid of [machinePid, kept.pid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  assert.ok(await until(() => stat(join(prefix, 'started')).then(() => true, () => false)));
  machinePid = Number(await readFile(join(prefix, 'started'), 'utf8'));
  let stopped = false;
  const stopping = exec(process.execPath, [keeper, 'stop'], { env, timeout: 20_000 }).finally(() => { stopped = true; });
  assert.ok(await until(() => stat(join(prefix, 'settling')).then(() => true, () => false)));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(stopped, false, 'stop has no force-kill deadline');
  assert.equal(JSON.parse(await readFile(join(prefix, 'keeper.json'), 'utf8')).machine, machinePid);
  process.kill(machinePid, 0);
  await writeFile(join(prefix, 'idle'), 'yes');
  await stopping;
  await assert.rejects(stat(join(prefix, 'keeper.json')));
});

test('the keeper keeps the machine running, one keeper at a time, and stops with it', async t => {
  const prefix = await mkdtemp(join(tmpdir(), 'mac-keeper-'));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  // A machine that says it started, then stops at once the first time (an
  // update taken), and the second time runs until it is asked to stop.
  const machine = join(prefix, 'machine.mjs');
  await writeFile(machine, `import { appendFileSync, readFileSync } from 'node:fs';
const file = ${JSON.stringify(join(prefix, 'starts'))};
appendFileSync(file, 'started\\n');
if (readFileSync(file, 'utf8').split('\\n').filter(Boolean).length === 1) process.exit(0);
process.on('SIGTERM', () => { appendFileSync(file, 'stopped\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const env = { ...process.env, IMPERFECT_PREFIX: prefix, IMPERFECT_KEEPER_SCRIPT: machine };
  const kept = spawn(process.execPath, [keeper], { env, stdio: 'ignore' });
  t.after(() => { try { kept.kill('SIGKILL'); } catch { /* gone */ } });
  const starts = () => readFile(join(prefix, 'starts'), 'utf8').then(text => text.split('\n').filter(Boolean), () => []);
  assert.ok(await until(async () => (await starts()).length === 2), 'started again after it stopped');
  // A second keeper sees the first and leaves.
  const second = await exec(process.execPath, [keeper], { env, timeout: 10_000 });
  assert.equal(second.stdout, '');
  assert.equal((await exec(process.execPath, [keeper, 'status'], { env })).stdout.startsWith(`keeping imperfect: keeper ${kept.pid}`), true);
  await exec(process.execPath, [keeper, 'stop'], { env, timeout: 20_000 });
  assert.deepEqual(await starts(), ['started', 'started', 'stopped']);
  await assert.rejects(stat(join(prefix, 'keeper.json')));
  const log = await readFile(join(prefix, 'logs', 'imperfect.log'), 'utf8');
  assert.match(log, /keeper: machine \d+ started/);
  assert.match(log, /keeper: asked to stop \(SIGTERM\)/);
});
