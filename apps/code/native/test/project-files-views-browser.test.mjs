import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFiles } from '../../../../system/files.mjs';
import { createShown } from '../../../../system/shown.mjs';
import { createProjects } from '../../../../system/projects.mjs';
import { harnessFixture, FAKE_DESK } from './fixtures/harness-page.mjs';

async function appServer(owner, port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader('set-cookie', 'app-cookie=not-for-host');
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
    if (req.url === '/main.js') return res.end(`import { label } from './relative.js'; document.querySelector('h1').textContent=label; document.querySelector('button').onclick=()=>document.querySelector('output').textContent='clicked'; const socket=new WebSocket('ws://localhost:${server.address().port}/hmr'); socket.onmessage=e=>document.querySelector('#socket').textContent=e.data; try { parent.document.body; document.body.dataset.escape='yes'; } catch { document.body.dataset.escape='blocked'; }`);
    if (req.url === '/relative.js') return res.end(`export const label=${JSON.stringify(owner)};`);
    if (req.url === '/favicon.ico') { res.statusCode = 404; return res.end(); }
    res.end('<!doctype html><h1>loading</h1><button>Play</button><output></output><p id="socket"></p><script type="module" src="/main.js"></script>');
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => { requests.push(req.headers); socket.send('HMR works'); });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  return { requests, port: server.address().port, close: async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise(done => sockets.close(done)); server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}

for (const phone of [false, true]) test(`server-backed projects and shown dev apps stay inside Files (${phone ? 'phone + peer' : 'desktop'})`, { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'project-files-'));
  const root = join(home, 'projects');
  await mkdir(join(root, 'Dacre'), { recursive: true });
  await writeFile(join(root, 'Dacre', 'package.json'), JSON.stringify({ scripts: { dev: 'synthetic-dev' } }));
  const htmlPath = join(root, 'file-app.html');
  await writeFile(htmlPath, '<button onclick="this.textContent=\'File still playing\'">File app</button>');
  const files = createFiles({ thumbnailDir: join(home, 'cache'), pictureMakers: [] });
  const from = phone ? '/peer/peer-fixture' : '';
  const owner = phone ? 'peer-app' : 'desktop-app';
  const running = new Map();
  let projects;
  let dev = await appServer('dev-app');
  let service = { running: true, url: `http://localhost:${dev.port}/`, cwd: home, name: 'Synthetic dev' };
  const shown = createShown({ stateDir: join(home, 'state'), servers: () => ({ list: () => [service] }), carries: port => projects.carries(port), projectAt: port => projects.atPort(port) });
  await shown.listen();
  projects = createProjects({ root, stateDir: join(home, 'state'), shown, every: 0, picture: async () => null,
    systemd: { running: async () => [], active: async unit => running.has(unit), start: async (unit, options) => { running.set(unit, await appServer(owner, Number(options.env.PORT))); }, stop: async unit => { await running.get(unit)?.close(); running.delete(unit); } } });
  const fixture = await harnessFixture({ desk: !phone, hasTouch: phone, viewport: phone ? { width: 390, height: 844 } : { width: 1200, height: 900 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] }],
    machines: [{ id: 'self-fixture', self: true, name: 'Fixture', reachable: true, capabilities: ['files'] }, { id: 'peer-fixture', name: 'Peer', reachable: true, capabilities: ['files'] }],
    handleRequest: async (req, res, path) => {
      if (path === '/') res.setHeader('content-security-policy', "connect-src 'self'; frame-src 'self' http://127.0.0.1:*");
      const local = path.replace(/^\/peer\/peer-fixture/, '');
      if (await projects.handle(req, res, local)) return true;
      if (await shown.handle(req, res, local)) return true;
      if (local === '/files/list') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: root, entries: [{ name: 'Dacre', path: join(root, 'Dacre'), dir: true }, { name: 'file-app.html', path: htmlPath, dir: false }] })); return true; }
      if (await files(req, res, local, new URL(req.url, 'http://fixture').search)) return true;
      return false;
    } });
  const page = fixture.page;
  const frame = () => page.frameLocator('.wm-files .workbench-view:not([hidden]) iframe');
  try {
    if (phone) await page.evaluate(() => harness.openFiles());
    await page.evaluate(({ root, from }) => harness.openFiles(root, { base: from }), { root, from });
    await page.locator('.workbench-items').getByText('file-app.html', { exact: true }).click();
    if (!phone) await page.locator('.workbench-items').getByText('file-app.html', { exact: true }).dblclick();
    await frame().getByRole('button', { name: 'File app', exact: true }).click();
    await page.evaluate(({ root, from }) => harness.openFiles(root, { base: from }), { root, from });
    await page.getByRole('button', { name: 'Open Dacre', exact: true }).click();
    await frame().getByRole('heading', { name: owner }).waitFor();
    await frame().getByText('HMR works').waitFor();
    await frame().getByRole('button', { name: 'Play' }).click();
    assert.equal(await frame().locator('output').textContent(), 'clicked');
    assert.equal(await frame().locator('body').getAttribute('data-escape'), 'blocked');
    assert.equal(await page.locator('.wm-browser').count(), 0);
    assert.equal(await page.locator('.workbench-tabs').count(), 0);
    const projectSrc = await page.locator('.wm-files .workbench-view:not([hidden]) iframe').getAttribute('src');
    await page.evaluate(from => harness.openProject('Dacre', from), from);
    assert.equal(await page.locator('.wm-files iframe').count(), 2, 'same project reuses its view, file app survives');
    await page.frameLocator('.wm-files .workbench-view[hidden] iframe').getByRole('button', { name: 'File still playing', includeHidden: true }).waitFor({ state: 'attached' });
    assert.equal(await frame().locator('output').textContent(), 'clicked');
    fixture.sendFrom(phone ? 'peer-fixture' : '', { type: 'shown', target: `http://localhost:${dev.port}/`, shape: 'landscape' });
    await page.waitForFunction(() => document.querySelectorAll('.wm-files iframe').length === 3);
    assert.equal(await page.locator('.wm-browser').count(), 0, 'show also stays in Files');
    await page.locator('.workbench-view-count').click();
    await page.getByRole('button', { name: /Synthetic dev/ }).click();
    await frame().getByRole('heading', { name: 'dev-app' }).waitFor();
    await frame().getByText('HMR works').waitFor();
    assert.notEqual(await page.locator('.wm-files .workbench-view:not([hidden]) iframe').getAttribute('src'), projectSrc);
    await frame().getByRole('button', { name: 'Play' }).click();
    assert.equal(await frame().locator('output').textContent(), 'clicked');
    // Re-showing a creation refreshes its existing view, not a duplicate tab.
    fixture.sendFrom(phone ? 'peer-fixture' : '', { type: 'shown', target: `http://localhost:${dev.port}/`, shape: 'landscape' });
    await frame().locator('output').filter({ hasText: 'clicked' }).waitFor({ state: 'detached' });
    await frame().getByRole('heading', { name: 'dev-app' }).waitFor();
    assert.equal(await frame().locator('output').textContent(), '');
    assert.equal(await page.locator('.wm-files iframe').count(), 3);
    // The hidden project never stopped or lost its button state.
    await page.evaluate(from => harness.openProject('Dacre', from), from);
    assert.equal(await frame().locator('output').textContent(), 'clicked');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('imperfect.workbench.tabs')));
    assert.ok(saved.tabs.some(tab => tab.app?.project === 'Dacre' && tab.owner === (phone ? 'peer-fixture' : '')));
    assert.ok(saved.tabs.some(tab => tab.app?.service?.cwd === home));
    assert.ok(!JSON.stringify(saved).includes(String(dev.port)), 'no transient port persisted');
    // Both servers change ports. Reload must resolve by project or cwd/name.
    for (const [unit, app] of running) { await app.close(); running.delete(unit); }
    await dev.close(); dev = await appServer('dev-after-restart');
    service = { ...service, url: `http://localhost:${dev.port}/` };
    await page.evaluate(() => harness.prepareSurfaceReload());
    await page.reload();
    if (!phone) await page.evaluate(FAKE_DESK);
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    if (phone) await page.evaluate(() => harness.openFiles());
    await frame().getByRole('heading', { name: owner }).waitFor();
    await page.locator('.workbench-view-count').click();
    await page.getByRole('button', { name: /Synthetic dev/ }).click();
    await frame().getByRole('heading', { name: 'dev-after-restart' }).waitFor();
    // Offline service shows Retry, never a different owner's page.
    service = { ...service, running: false };
    await page.getByRole('button', { name: 'Retry / reload' }).click();
    await page.getByText(/no longer running/).waitFor();
    service = { ...service, running: true };
    await page.getByRole('button', { name: 'Retry / reload' }).click();
    await frame().getByRole('heading', { name: 'dev-after-restart' }).waitFor();
    assert.equal(await page.locator('.wm-browser').count(), 0);
    // External /port-looking websites must not be mistaken for owned apps.
    const classified = await page.evaluate(async from => (await fetch(`${from}/shown/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'https://example.invalid/port/5173/' }) })).json(), from);
    assert.deepEqual(classified, { local: false });
    const total = await page.evaluate(() => JSON.parse(localStorage.getItem('imperfect.workbench.tabs')).tabs.length);
    const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem('imperfect.workbench.tabs')).tabs);
    for (let i = 0; i < total; i++) {
      const before = await kept();
      await page.locator('.workbench-view-count').press('ArrowDown');
      await page.locator('.workbench-tab-close').last().click();
      // Closed, and the view now in front loaded again (its file back in it):
      // the rest kept as they were, or, the last gone, its folder alone.
      await page.waitForFunction(rest => {
        const { tabs } = JSON.parse(localStorage.getItem('imperfect.workbench.tabs'));
        return rest.length ? JSON.stringify(tabs) === JSON.stringify(rest) : tabs.length === 1 && tabs[0].path !== '' && !tabs[0].file && !tabs[0].app;
      }, before.slice(0, -1));
    }
    await page.locator('.workbench-item').first().waitFor();
    assert.equal(await page.locator('.wm-files iframe').count(), 0);
    await page.route('https://example.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic external site</h1>' }));
    fixture.sendFrom(phone ? 'peer-fixture' : '', { type: 'shown', target: 'https://example.invalid/port/5173/', shape: 'landscape' });
    await page.locator('.wm-browser').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.wm-files iframe').count(), 0, 'external websites never become Files apps');
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
    for (const app of running.values()) await app.close();
    await dev.close(); projects.close(); await shown.close(); await rm(home, { recursive: true, force: true });
  }
});
