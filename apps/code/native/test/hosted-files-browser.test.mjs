import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createGueyServer } from '../../../../system/server.mjs';
import { solitaryMachines } from '../../../../system/machines.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('a solitary hosted computer discovers itself and opens Files home without a tailnet', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-files-'));
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const snapshot = { agent: 'pi', sessionId: 'fixture-session', cwd: dir,
    model: { provider: 'fixture', id: 'fixture' }, messages: [{ role: 'assistant', content: 'Ready' }],
    queue: { items: [] }, stats: {}, ui: {}, tabs: [{ id: 'fixture-tab', sessionId: 'fixture-session', focused: true, agent: 'pi', name: 'Fixture' }] };
  const runtime = { events: new EventEmitter(), snapshot: () => snapshot, command: async () => ({}), close: async () => {} };
  app = await createGueyServer({ hosted: true, machines: solitaryMachines('hosted-fixture'), runtime,
    stateDir: dir, cwd: dir, port: 0, pagePort: 0, sessionToken: 'fixture-only',
    browser: { sockets: async () => [], open: async () => { throw new Error('No native browser in this fixture'); } } });
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  const response = await fetch(`${base}/machines.json`);
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.equal(inventory.authority, '');
  assert.equal(inventory.machines.length, 1);
  assert.equal(inventory.machines[0].home, true);
  browser = await launchChromium({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#entry-output .gui-assistant').waitFor();
  await page.waitForFunction(home => [...document.querySelectorAll('.workbench-path .workbench-crumb')].at(-1)?.textContent === home.split('/').at(-1), homedir(), { timeout: 10000 });
  assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1, 'real hosted server serves browser focus too');
  assert.doesNotMatch(await page.locator('.workbench-note').innerText(), /Finding|unavailable/);
  assert.deepEqual(errors, []);
});
