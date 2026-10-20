// Run the real Linux installer only in disposable homes/checkouts, with a
// closed PATH: npm, curl, systemctl and desktop integration cannot escape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = new URL('../../../', import.meta.url);
const bash = execFileSync('which', ['bash'], { encoding: 'utf8' }).trim();
const lock = '{"lockfileVersion":3,"packages":{}}\n';
const receipt = createHash('sha256').update(lock).digest('hex') + '\n';
const unknown = [
  ['unavailable', '', 7],
  ['HTTP error with idle body', '{"busy":false}', 22],
  ['malformed JSON', '{', 0],
  ['empty response', '', 0],
  ['missing busy', '{}', 0],
  ['null response', 'null', 0],
  ['nonboolean busy', '{"busy":0}', 0],
];

async function fixture(t, { active = true, health = '{"busy":false}', curlStatus = 0, changed = true, lateHealth = health, fresh = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linux-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'checkout'), home = join(dir, 'home'), bin = join(dir, 'bin');
  const prefix = join(home, '.imperfect'), events = join(dir, 'events');
  for (const path of [bin, join(root, 'node_modules'), join(root, 'desktop/product'), join(prefix, 'models/parakeet-tdt-0.6b-v2-int8')]) await mkdir(path, { recursive: true });
  await copyFile(new URL('install.sh', source), join(root, 'install.sh'));
  for (const name of ['imperfect-open', 'imperfect-file-manager', 'imperfect-code.desktop', 'imperfect-files.desktop']) {
    await copyFile(new URL(`desktop/product/${name}`, source), join(root, 'desktop/product', name));
  }
  await writeFile(join(root, 'package-lock.json'), lock);
  const before = fresh ? null : changed ? 'old-lock\n' : receipt;
  if (!fresh) {
    await writeFile(join(root, 'node_modules/.imperfect-lock'), before);
    await writeFile(join(root, 'node_modules/sentinel'), 'live dependencies');
  }
  await writeFile(join(prefix, 'models/parakeet-tdt-0.6b-v2-int8/tokens.txt'), 'fixture');
  await writeFile(events, '');
  // Only filesystem utilities are real; everything capable of contacting a
  // service or installing anything is mocked. No inherited user PATH/config.
  for (const name of ['cat', 'sed', 'mkdir', 'chmod', 'rm', 'install', 'cut', 'sha256sum', 'readlink', 'dirname']) {
    const path = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    await symlink(path, join(bin, name));
  }
  const mock = async (name, code) => {
    const path = join(bin, name);
    await writeFile(path, `#!${bash}\nset -eu\n${code}\n`);
    await chmod(path, 0o755);
  };
  await mock('uname', 'echo Linux');
  await mock('git', 'exit 0');
  await mock('npm', 'echo "npm $*" >> "$EVENTS"; mkdir -p node_modules; rm -f node_modules/sentinel');
  await mock('curl', `echo 'curl health' >> "$EVENTS"
[[ "$*" == *"http://127.0.0.1:59999/health"* ]] || exit 99
if [[ -f "$COUNT" ]]; then printf '%s' "$LATE_HEALTH"; else printf '%s' "$HEALTH"; fi
printf x > "$COUNT"
exit "$CURL_STATUS"`);
  await mock('systemctl', 'echo "systemctl $*" >> "$EVENTS"; if [[ "$*" == *is-active* ]]; then exit "$ACTIVE_STATUS"; fi');
  for (const name of ['gdbus', 'update-desktop-database', 'tailscale']) await mock(name, 'exit 1');
  await mock('xdg-mime', 'exit 0');
  await mock('node', `if [[ "\${1:-}" == *system/memory.mjs ]]; then exit 1; fi\nexec ${JSON.stringify(process.execPath)} "$@"`);
  const result = spawnSync(bash, [join(root, 'install.sh')], {
    cwd: root, timeout: 10_000, encoding: 'utf8',
    env: { PATH: bin, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
      IMPERFECT_PREFIX: prefix, IMPERFECT_PORT: '59999', IMPERFECT_BIN_DIR: join(home, '.local/bin'),
      EVENTS: events, COUNT: join(dir, 'curl-count'), HEALTH: health, LATE_HEALTH: lateHealth,
      CURL_STATUS: String(curlStatus), ACTIVE_STATUS: active ? '0' : '3' },
  });
  const calls = await readFile(events, 'utf8');
  const marker = await readFile(join(root, 'node_modules/.imperfect-lock'), 'utf8').catch(() => null);
  const sentinel = await readFile(join(root, 'node_modules/sentinel'), 'utf8').catch(() => null);
  const evidence = JSON.stringify({ status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr, calls, marker, sentinel }, null, 2);
  if (process.env.INSTALL_TEST_LOG_DIR) {
    await mkdir(process.env.INSTALL_TEST_LOG_DIR, { recursive: true });
    await writeFile(join(process.env.INSTALL_TEST_LOG_DIR, t.name.replace(/[^a-zA-Z0-9-]/g, '_') + '.json'), evidence);
  }
  assert.equal(result.error, undefined, evidence);
  return { ...result, calls, marker, sentinel, before, evidence };
}

function untouched(w) {
  assert.doesNotMatch(w.calls, /^npm /m, w.evidence);
  assert.equal(w.marker, w.before, w.evidence);
  assert.equal(w.sentinel, 'live dependencies', w.evidence);
  assert.doesNotMatch(w.calls, /systemctl --user (?:restart|start|stop|disable)/, w.evidence);
}

test('Linux changed lock refuses npm beneath a busy agent', async t => {
  const w = await fixture(t, { health: '{"busy":true}' });
  untouched(w);
  assert.notEqual(w.status, 0, w.evidence);
});

for (const [label, health, curlStatus] of unknown) {
  test(`Linux changed lock refuses npm on ${label}`, async t => {
    const w = await fixture(t, { health, curlStatus });
    untouched(w);
    assert.notEqual(w.status, 0, w.evidence);
  });
  test(`Linux unchanged lock never restarts on ${label}`, async t => {
    untouched(await fixture(t, { changed: false, health, curlStatus }));
  });
}

test('Linux unchanged lock leaves busy agent running', async t => {
  const w = await fixture(t, { changed: false, health: '{"busy":true}' });
  untouched(w);
  assert.equal(w.status, 0, w.evidence);
});

test('Linux changed lock refuses npm even beneath a currently idle running service', async t => {
  const w = await fixture(t);
  untouched(w);
  assert.notEqual(w.status, 0, w.evidence);
});

test('Linux stopped install updates dependencies and starts', async t => {
  const w = await fixture(t, { active: false });
  assert.equal(w.status, 0, w.evidence);
  assert.match(w.calls, /^npm ci --no-audit --no-fund --loglevel=error$/m, w.evidence);
  assert.equal(w.marker, receipt);
  assert.match(w.calls, /systemctl --user start imperfect-code.service/, w.evidence);
});

test('Linux idle unchanged install skips npm and restarts', async t => {
  const w = await fixture(t, { changed: false });
  assert.equal(w.status, 0, w.evidence);
  assert.doesNotMatch(w.calls, /^npm /m, w.evidence);
  assert.match(w.calls, /systemctl --user restart imperfect-code.service/, w.evidence);
});

test('Linux genuine first install needs no existing health endpoint', async t => {
  const w = await fixture(t, { active: false, health: '', curlStatus: 7, fresh: true });
  assert.equal(w.status, 0, w.evidence);
  assert.match(w.calls, /^npm /m, w.evidence);
  assert.match(w.calls, /systemctl --user start imperfect-code.service/, w.evidence);
  assert.doesNotMatch(w.calls, /curl health|systemctl --user restart/, w.evidence);
});

test('Linux changed lock cannot race a new turn after an idle health snapshot', async t => {
  const w = await fixture(t, { lateHealth: '{"busy":true}' });
  untouched(w);
  assert.notEqual(w.status, 0, w.evidence);
  assert.doesNotMatch(w.calls, /curl health/, 'running service alone fences npm; no idle snapshot is trusted');
});

test('Linux changed lock cannot race lost health after an idle snapshot', async t => {
  const w = await fixture(t, { lateHealth: '{' });
  untouched(w);
  assert.notEqual(w.status, 0, w.evidence);
  assert.doesNotMatch(w.calls, /curl health/, 'running service alone fences npm; no idle snapshot is trusted');
});
