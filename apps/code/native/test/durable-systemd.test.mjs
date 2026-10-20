import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Subagents, command } from '../subagent.mjs';
import { readDurableArchive } from '../durable-archive.mjs';
import { until } from './durable-fixture.mjs';
const synthetic = fileURLToPath(new URL('./fixtures/subagent-synthetic.mjs', import.meta.url));
const smoke = { skip: process.env.IMPERFECT_SYSTEMD_SMOKE !== '1', timeout: 30000 };
for (const mode of ['success', 'hang', 'recover']) test(`real user systemd, mocked provider: ${mode}`, smoke, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-systemd-'));
  const manager = new Subagents({ root: join(dir, 'tasks'), agentDir: join(dir, 'agent'), owner: mode,
    launch: (cmd, args) => command(cmd, args.flatMap(arg => arg === '--' ? [`--setenv=FAKE_DURABLE_MODE=${mode}`, '--setenv=PI_OFFLINE=1', '--property=RuntimeMaxSec=45', '--property=MemoryMax=256M', '--property=TasksMax=32', '--property=CPUQuota=50%', arg] : [arg.endsWith('/subagent-runner.mjs') ? synthetic : arg])) });
  const task = manager.start({ task: 'Synthetic fixture; never call a model', cwd: dir });
  t.after(async () => { await command('systemctl', ['--user', 'stop', task.unit]).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  if (mode === 'hang' || mode === 'recover') {
    await until(async () => Boolean(await stat(join(task.path, 'mock-request-started')).catch(() => null)));
    if (mode === 'hang') { await manager.cancel(task.id); assert.equal(manager.result(task.id).status, 'cancelled'); return; }
    await command('systemctl', ['--user', 'kill', '--signal=SIGKILL', task.unit]);
  }
  await until(() => manager.read(task.id).status === 'done', 1500);
  assert.equal(manager.result(task.id).output, 'synthetic durable report');
  assert.equal(manager.result(task.id).usageReliable, mode !== 'recover');
  if (mode === 'recover') assert.equal(manager.result(task.id).usage, null, 'a killed request may have usage that was never recorded');
  const history = readDurableArchive(manager.read(task.id).sessionPath);
  assert.equal(history.messages.filter(m => m.role === 'user').length, 1, 'restart retries the same Durable receipt, never a fresh task');
});
