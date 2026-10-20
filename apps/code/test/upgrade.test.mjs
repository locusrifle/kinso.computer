process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newer, npmTest, report, targets } from '../../../system/upgrade.mjs';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const out = hours => new Date(NOW - hours * 3600_000).toISOString();

test('Pi auth/resources, Durable and Chord move only to a shared stable release, never split or downgrade', () => {
  const times = {
    '@anthropic-ai/claude-agent-sdk': { created: out(900), modified: out(1), '0.3.287': out(60), '0.3.288': out(30), '0.3.289': out(0.1), '0.4.0-beta.1': out(40) },
    '@earendil-works/pi-ai': { '1.0.0': out(70), '1.0.1': out(25), '1.0.2': out(11), '1.0.3': out(0.5) },
    '@earendil-works/pi-coding-agent': { '1.0.0': out(70), '1.0.1': out(23.9), '1.0.2': out(10.9) },
    '@earendil-works/pi-durable': { '1.0.0': out(70), '1.0.1': out(25), '1.0.2': out(1) },
    '@earendil-works/chord': { '1.0.0': out(70), '1.0.1': out(25) },
  };
  const pi = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-durable', '@earendil-works/chord'];
  const locked = { '@anthropic-ai/claude-agent-sdk': '0.3.287', ...Object.fromEntries(pi.map(name => [name, '1.0.0'])) };
  assert.deepEqual(targets(times, locked), { '@anthropic-ai/claude-agent-sdk': '0.3.289', ...Object.fromEntries(pi.map(name => [name, '1.0.1'])) }, 'Durable 1.0.2 waits for Chord; no prereleases');
  assert.deepEqual(targets(times, { '@anthropic-ai/claude-agent-sdk': '0.3.289', ...Object.fromEntries(pi.map(name => [name, '1.0.1'])) }), {}, 'nothing newer');
  assert.deepEqual(targets(times, { ...locked, '@anthropic-ai/claude-agent-sdk': '0.3.289', '@earendil-works/pi-ai': '1.0.3' }), {}, 'a local version ahead holds the whole Pi group');
  assert.equal(targets(times, { ...locked, '@anthropic-ai/claude-agent-sdk': '0.3.290' })['@anthropic-ai/claude-agent-sdk'], undefined, 'never back');
  assert.ok(newer('0.10.0', '0.9.9') && newer('1.0.1', '1.0.0') && !newer('1.0.0', '1.0.0') && !newer('0.3.288', '0.3.289'));
});

for (const [name, options] of [
  ['', ''],
  ['spec', '--test-reporter=spec'],
  ['tap', '--test-reporter=tap'],
  ['quoted values and destination', '--test-reporter "tap" --test-reporter-destination "stdout"'],
  ['quoted options and destination', '"--test-reporter=tap" "--test-reporter-destination=stdout"'],
  ['unrelated quoted require', '--require "./require --test-reporter=tap.cjs"'],
]) test(`a test that fails once and passes when its file is tried again does not stop an update; one that fails twice does${name ? ` (inherited ${name})` : ''}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upgrade-test-'));
  const inherited = process.env.NODE_OPTIONS;
  if (options) process.env.NODE_OPTIONS = `${inherited ?? ''} ${options}`.trim();
  try {
    await mkdir(join(dir, 't'));
    await writeFile(join(dir, 'require --test-reporter=tap.cjs'), 'globalThis.reporterFixture = true;\n');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node --test t/*.test.mjs' } }));
    await writeFile(join(dir, 't', 'steady.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('steady', () => { ${name === 'unrelated quoted require' ? 'assert.equal(globalThis.reporterFixture, true);' : ''} });\n`);
    await writeFile(join(dir, 't', 'flaky.test.mjs'), "import test from 'node:test';\nimport { existsSync, writeFileSync } from 'node:fs';\ntest('flaky', () => { if (!existsSync('tried')) { writeFileSync('tried', ''); throw new Error('missed its moment'); } });\n");
    assert.equal(await npmTest(dir), null, 'passed on a second try');
    await writeFile(join(dir, 't', 'flaky.test.mjs'), "import test from 'node:test';\ntest('broken', () => { throw new Error('always'); });\n");
    assert.match(await npmTest(dir), /✖ broken/);
  } finally {
    if (inherited === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = inherited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('an update its tests refuse is written to open/upgrade.md, dated the day it first failed, and taken away once they pass', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'upgrade-open-')), dir = join(prefix, 'memory'), file = join(dir, 'open', 'upgrade.md');
  const moves = ['@earendil-works/pi-ai 1.0.3 → 1.0.4', '@earendil-works/pi-coding-agent 1.0.3 → 1.0.4'];
  const failed = '✖ Alt+1 to Alt+5 enter the sessions in the order the rail shows them (1188ms)';
  try {
    await report(moves, failed, { dir, now: NOW });
    await report(moves, failed, { dir, now: NOW + 2 * 24 * 3600_000 });
    assert.match(await readFile(file, 'utf8'), /^- 2026-10-04 upgrade: npm test fails with @earendil-works\/pi-ai 1\.0\.3 → 1\.0\.4, @earendil-works\/pi-coding-agent 1\.0\.3 → 1\.0\.4; [^\n]*\n {2}✖ Alt\+1 to Alt\+5 [^\n]*\n$/, 'dated the day it first failed with these versions');
    await report(['@earendil-works/pi-ai 1.0.3 → 1.0.5'], failed, { dir, now: NOW + 3 * 24 * 3600_000 });
    assert.match(await readFile(file, 'utf8'), /^- 2026-10-07 upgrade: npm test fails with @earendil-works\/pi-ai 1\.0\.3 → 1\.0\.5;/, 'other versions, another day');
    await report(moves, null, { dir });
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
  } finally { await rm(prefix, { recursive: true, force: true }); }
});
