import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { createTabHost } from '../tabs.mjs';
import { fixture } from '../../tools/gui-preview.mjs';
import { noisePNG, tinyBMP } from './attachment-fixture.mjs';

for (const agent of ['pi', 'claude']) test(`real browser → streaming upload → ${agent} host preserves originals and delivers vision after owner restart without socket base64`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'attachments-browser-'));
  const calls = [], attempts = [], wire = [], errors = [], timeline = [];
  const snapshots = new EventEmitter(), started = Date.now();
  const mark = (event, detail = {}) => timeline.push({ ms: Date.now() - started, event, ...detail });
  let refuse = true, restarting = false;
  const snap = { ...fixture({ empty: true, agent }), cwd: root, tabs: undefined, sessionId: 'browser-session' };
  const runtime = { events: new EventEmitter(), snapshot: () => snap,
    command: async command => {
      if (command.type === 'prompt') {
        attempts.push({ refuse, requestId: command.requestId });
        mark('runtime prompt', attempts.at(-1));
        if (refuse) throw new Error('fixture retry required');
        calls.push(command);
      }
      return { accepted: true };
    }, close: async () => {} };
  let host = await createTabHost({ sessionToken: 'fixture-only', firstTab: agent, createRuntime: () => runtime, createClaudeRuntime: () => runtime, claudeAvailable: () => true });
  let app = await createGueyServer({ port: 0, stateDir: join(root, 'state'), runtime: host, sessionToken: 'fixture-only' });
  assert.equal(host.snapshot().sessionId, 'browser-session');
  const address = await app.listen();
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-features=LocalNetworkAccessChecks'] });
  let page;
  const readiness = async () => page?.evaluate(() => ({
    view: window.harness?.guiSnapshot(), flash: document.querySelector('#entry-flash')?.textContent,
    fresh: document.querySelector('#entry-output')?.dataset.fresh,
    text: document.querySelector('#entry-input')?.value,
    attachments: document.querySelectorAll('.entry-pending-chip').length,
  }));
  t.after(async () => {
    if (!t.passed) t.diagnostic(JSON.stringify({ timeline, attempts, wire, errors, calls: calls.length,
      readiness: await readiness().catch(error => error.message) }));
    await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
  });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    mark('websocket');
    socket.on('close', () => mark('socket close'));
    socket.on('socketerror', error => {
      mark('socket error', { error: String(error) });
      if (!restarting || !String(error).includes('ERR_CONNECTION_REFUSED')) errors.push(String(error));
    });
    socket.on('framesent', frame => { try {
      const c = JSON.parse(frame.payload);
      if (c.type === 'prompt') { wire.push(c); mark('sent prompt', { requestId: c.requestId }); }
    } catch {} });
    socket.on('framereceived', frame => { try {
      const c = JSON.parse(frame.payload);
      if (['snapshot', 'response'].includes(c.type)) mark('received', { type: c.type, id: c.id, success: c.success, error: c.error, instanceId: c.data?.instanceId });
      if (c.type === 'snapshot') snapshots.emit('snapshot', c.data);
    } catch {} });
  });
  const submit = async () => {
    const result = await page.evaluate(() => harness.submit());
    mark('submit result', { result, readiness: await readiness() });
    return result;
  };
  // Expose the real application's existing harness hooks, without replacing
  // its DOM, API, WebSocket, upload transport, or server image preparation.
  await page.route('**/js/site.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.harness = harness;` });
  });
  await page.goto(`http://127.0.0.1:${address.port}/?face=code`);
  await page.waitForFunction(() => window.harness?.guiSnapshot().sessionId === 'browser-session');
  const png = noisePNG(1400, 1400);
  assert.ok(png.length > 5 * 1024 * 1024, 'larger than the old photo ceiling');
  const bmp = tinyBMP();
  assert.equal(await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/bmp' }));
    const width = bitmap.width; bitmap.close(); return width;
  }, [...bmp]), 1, 'BMP was supported by the former browser preparation path');
  await page.locator('#entry-files').setInputFiles([
    { name: 'camera.png', mimeType: 'image/png', buffer: png },
    { name: 'camera.bmp', mimeType: 'image/bmp', buffer: bmp },
    { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('original plan') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.entry-pending-chip').length === 1 && document.querySelectorAll('.entry-pending-chip.is-uploading').length === 0);
  assert.equal((await page.locator('#entry-input').inputValue()).trim(), 'image 1 image 2');
  assert.deepEqual(await page.locator('.entry-inline-attachment').allTextContents(), ['image 1', 'image 2']);
  assert.match(await page.locator('#entry-pending').textContent(), /plan.txt/);
  assert.doesNotMatch(await page.locator('#entry-pending').textContent(), /\(image/);
  const previousInstance = host.snapshot().instanceId;
  restarting = true;
  // Keep the listener down through a failed reconnect, deterministically. A
  // Playwright 'websocket' event means an attempt, not an open/usable socket.
  const failedReconnect = once(page, 'websocket', { signal: AbortSignal.timeout(8000) })
    .then(([socket]) => once(socket, 'close', { signal: AbortSignal.timeout(8000) }));
  const stopping = app.close();
  app.server.closeAllConnections(); // A process exit also drops remaining HTTP keep-alives.
  await Promise.all([stopping, failedReconnect]);
  host = await createTabHost({ sessionToken: 'fixture-only', firstTab: agent, createRuntime: () => runtime, createClaudeRuntime: () => runtime, claudeAvailable: () => true });
  app = await createGueyServer({ port: address.port, pagePort: 0, stateDir: join(root, 'state'), runtime: host, sessionToken: 'fixture-only' });
  await page.waitForFunction(() => document.querySelector('#entry-output')?.dataset.fresh !== 'fresh');
  assert.deepEqual(await submit(), { accepted: false, error: 'Execution selection unavailable; choose a session first' });
  assert.equal(wire.length, 0, 'an offline submit never reached the socket');
  assert.equal(attempts.length, 0, 'an offline submit never reached admission');
  assert.equal(await page.locator('.entry-pending-chip').count(), 1, 'offline rejection retains the file chip; image tokens stay in the input');

  const nextInstance = host.snapshot().instanceId;
  assert.notEqual(nextInstance, previousInstance);
  const newSnapshot = once(snapshots, 'snapshot', { signal: AbortSignal.timeout(8000) });
  const [, [snapshot]] = await Promise.all([app.listen(), newSnapshot]);
  assert.equal(snapshot.instanceId, nextInstance, 'snapshot came from the replacement host');
  await page.waitForFunction(() => document.querySelector('#entry-output')?.dataset.fresh === 'fresh'
    && harness.guiSnapshot().sessionId === 'browser-session');
  mark('replacement ready', { instanceId: nextInstance, readiness: await readiness() });
  restarting = false;
  assert.equal(await page.locator('.entry-pending-chip').count(), 1, 'file chip survives reconnect without duplicate image chips');
  assert.deepEqual(await submit(), { accepted: false, error: 'fixture retry required' });
  assert.equal(attempts.length, 1, 'the intended refusal actually reached runtime admission');
  assert.equal(wire.length, 1);
  assert.equal(await page.locator('.entry-pending-chip').count(), 1, 'failed prompt restores the file chip without duplicate image chips');
  refuse = false;
  assert.deepEqual(await submit(), { accepted: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(attempts, [
    { refuse: true, requestId: wire[0].requestId },
    { refuse: false, requestId: wire[0].requestId },
  ], 'an immediate retry reaches admission with the same identity');
  assert.equal(calls[0].images.length, 2, 'vision block, not a path-only photo');
  assert.ok(calls[0].images[0].data.length <= 1024 * 1024);
  assert.match(calls[0].text, /uploaded image original:/);
  assert.match(calls[0].text, /uploaded file:/);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].images, undefined);
  assert.ok(JSON.stringify(wire[0]).length < 2000);
  assert.equal(wire[0].requestId, wire[1].requestId, 'failed acceptance keeps its request identity');
  assert.deepEqual(wire[0].attachments, wire[1].attachments);
  const names = await readdir(join(root, 'uploads'));
  assert.equal(names.length, 3, 'retry did not re-upload originals');
  assert.deepEqual(await readFile(join(root, 'uploads', names.find(n => n.endsWith('.png')))), png);
  assert.equal(await readFile(join(root, 'uploads', names.find(n => n.endsWith('.txt'))), 'utf8'), 'original plan');
  assert.deepEqual(await readFile(join(root, 'uploads', names.find(n => n.endsWith('.bmp')))), bmp);
  // Failed uploads retain the original Blob for explicit retry; cancellation
  // removes a pending XHR rather than letting it enter a later prompt.
  await page.route('**/upload', route => route.fulfill({ status: 503, body: 'fixture upload failure' }), { times: 1 });
  await page.locator('#entry-files').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry original') });
  await page.getByRole('button', { name: 'retry retry.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: 'retry retry.txt', exact: true }).click();
  await page.locator('.entry-pending-chip:not(.is-uploading)').waitFor();
  await page.getByRole('button', { name: 'remove retry.txt', exact: true }).click();
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  const intercepted = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route('**/upload', async route => { intercepted.resolve(); await release.promise; await route.abort().catch(() => {}); }, { times: 1 });
  await page.locator('#entry-files').setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel original') });
  await page.locator('.entry-pending-chip.is-uploading').waitFor();
  await intercepted.promise;
  await page.getByRole('button', { name: 'remove cancel.txt', exact: true }).click();
  release.resolve();
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  assert.equal(calls.length, 1, 'cancel and retry never submit a prompt on their own');
  assert.deepEqual(errors, []);
});
