import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createShown } from '../../../../system/shown.mjs';
import { runShow } from '../code-control.mjs';
import { devServers } from '../dev-servers.mjs';
import { hostedFixture, clickStream, until, AUTH } from './fixtures/hosted-pages.mjs';

const shownKey = Symbol.for('imperfect.shown');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
function localGet(url) {
  const at = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: at.port, path: at.pathname + at.search,
      headers: { host: at.host } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}
async function viewThrough(shown, value) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => { void shown.handle(req, res, '/shown/view'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/shown/view`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('hosted view resolver keeps native root assets inside unique authorized folder origins; nonhosted stays local', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-view-contract-'));
  const before = globalThis[shownKey];
  const one = join(root, 'one'), two = join(root, 'two');
  await mkdir(one); await mkdir(two);
  for (const dir of [one, two]) await writeFile(join(dir, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(one, 'main.js'), 'export const app="one"');
  await writeFile(join(two, 'main.js'), 'export const app="two"');
  await writeFile(join(one, 'paper.pdf'), '%PDF-1.4\n');
  await writeFile(join(root, 'private.txt'), 'outside-root');
  await symlink(join(root, 'private.txt'), join(one, 'escape.txt'));
  const calls = [];
  const shown = createShown({ hosted: true, webOrigin: 'http://fixture', stateDir: join(root, 'state'),
    servers: () => ({ list: () => [] }), view: async options => { calls.push(options); return { tab: 31, url: options.url }; } });
  await shown.listen();
  let local;
  t.after(async () => { await shown.close(); await local?.close(); globalThis[shownKey] = before; await rm(root, { recursive: true, force: true }); });
  const result = await viewThrough(shown, { target: one });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.stream, true); assert.equal(result.body.tab, 31);
  const url = new URL(result.body.url);
  assert.equal(url.hostname, `${createHash('sha256').update(one).digest('hex').slice(0, 32)}.localhost`);
  assert.equal(url.pathname, '/index.html');
  assert.deepEqual(calls[0], { url: result.body.url, reload: false });
  assert.equal((await localGet(new URL('/main.js', url))).body, 'export const app="one"');
  const other = await viewThrough(shown, { target: join(two, 'index.html'), reload: true });
  assert.notEqual(new URL(other.body.url).origin, url.origin, 'different containing folders do not share page storage');
  assert.deepEqual(calls.at(-1), { url: other.body.url, reload: true });
  assert.equal((await localGet(new URL('/main.js', other.body.url))).body, 'export const app="two"');
  for (const path of ['/escape.txt', '/private.txt', '/%2e%2e%2fprivate.txt', `/shown${join(two, 'main.js')}`]) {
    assert.notEqual((await localGet(new URL(path, url))).status, 200, path);
  }
  const pdf = await viewThrough(shown, { target: join(one, 'paper.pdf') });
  assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
  assert.equal(pdf.body.stream, true);
  assert.equal(new URL(pdf.body.url).origin, url.origin, 'streamed PDFs are native too, never an authenticated public-door URL');
  assert.equal(new URL(pdf.body.url).pathname, '/paper.pdf');
  const denied = await viewThrough(shown, { target: 'http://localhost:61234/not-authorized' });
  assert.ok(denied.status >= 400, 'view does not authorize an arbitrary unregistered local port');
  local = createShown({ stateDir: join(root, 'local') }); await local.listen();
  const desk = await viewThrough(local, { target: join(one, 'index.html') });
  assert.equal(desk.status, 200, JSON.stringify(desk.body));
  assert.equal(desk.body.stream, false); assert.equal(desk.body.tab, undefined);
  assert.ok(desk.body.url.startsWith('http://127.0.0.1:'));
});

async function refuseSocket(origin, path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + path);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`No refusal: ${path}`)); }, 15000);
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error(`Unauthenticated socket opened: ${path}`)); });
    ws.once('unexpected-response', (_, response) => { clearTimeout(timer); response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
}
async function assertDoor(fixture, paths) {
  for (const path of paths) for (const method of ['GET', 'POST']) {
    const response = await fetch(`${fixture.origin}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(await response.text(), 'Unauthorized');
  }
  for (const path of ['/browser/live', '/pi', '/port/5173/', '/@vite/client']) {
    assert.equal(await refuseSocket(fixture.origin, path), 401, `WS ${path}`);
  }
}
async function revealFiles(page) {
  await page.locator('.wm-files').waitFor();
  await page.locator('.wm-files').scrollIntoViewIfNeeded();
  await page.locator('.wm-files .browser-live-frame').waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.wm-files .browser-live-frame');
    return img?.src.startsWith('data:image/jpeg') && img.complete && img.naturalWidth > 0;
  });
}

const appHTML = `<html><head><script>window.appErrors=[];window.addEventListener('error',e=>appErrors.push(e.message||e.target.src),true);window.addEventListener('unhandledrejection',e=>appErrors.push(String(e.reason)));</script><title>Hosted proof</title><link rel="stylesheet" href="/style.css"></head>
<body><h1 id="message">Loading</h1><img id="asset" src="/pixel.png"><button id="play">Play</button><input id="input" aria-label="App input"><output id="typed"></output><a id="route" href="/nested/client">Client route</a>
<script type="module" src="/src/main.js"></script></body></html>`;
const appModule = `import { message } from '/src/message.js';
window.loadId = Math.random(); window.updates = 0;
const render = value => document.querySelector('#message').textContent = value;
render(message); document.body.dataset.ready = 'yes';
document.querySelector('#play').onclick = () => { document.querySelector('#play').textContent = 'Playing'; document.title = 'Playing'; };
document.querySelector('#input').oninput = event => document.querySelector('#typed').textContent = event.target.value;
document.querySelector('#route').onclick = event => { event.preventDefault(); history.pushState({}, '', event.target.pathname); document.body.dataset.route = location.pathname; };
document.body.dataset.route = location.pathname;
if (import.meta.hot) import.meta.hot.accept('/src/message.js', module => { window.updates++; render(module.message); });`;
function makePDF() {
  const text = 'BT /F1 24 Tf 30 100 Td (Hosted PDF proof) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}
async function makeApp(root) {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'index.html'), appHTML);
  await writeFile(join(root, 'src/main.js'), appModule);
  await writeFile(join(root, 'src/message.js'), 'export const message = "Module loaded";');
  await writeFile(join(root, 'style.css'), 'body{margin:16px;background:rgb(240, 220, 190)}button,input,a{display:block;margin:16px 0;min-height:48px}');
  await writeFile(join(root, 'pixel.png'), PNG);
}

test('behind the authenticated door, shown HTML and folder apps stream real Electron frames and real UI input without exposing assets', { timeout: 300000 }, async t => {
  const fixture = await hostedFixture(t);
  const { root, origin, page, json, ask, evaluate, seen } = fixture;
  try {
  const dir = join(root, 'plain'); await makeApp(dir);
  await assertDoor(fixture, ['/', `/shown${dir}/index.html`, `/shown${dir}/`, '/style.css', '/src/main.js', '/pixel.png',
    `/files/raw?path=${encodeURIComponent(join(dir, 'pixel.png'))}`, '/media/fixture', '/files/list', '/shown/add', '/shown/view', '/browser/live', '/port/5173/']);
  await runShow({ path: dir, session: 'proof-session' });
  await revealFiles(page);
  assert.equal(await page.locator('.wm-files iframe,.wm-files webview').count(), 0, 'hosted preview never embeds a remote file URL in an iframe');
  assert.equal(await page.locator('.wm-files .browser-tab-strip').count(), 0, 'fixed embedded hosted preview has no inner browser strip');
  const first = await json('/shown/view', { target: dir });
  assert.equal(first.stream, true); assert.ok(first.tab > 0);
  await until(async () => await evaluate(first.tab, 'document.body.dataset.ready') === 'yes', 'native module loading');
  assert.equal(await evaluate(first.tab, 'document.querySelector("#message").textContent'), 'Module loaded');
  assert.equal(await evaluate(first.tab, 'getComputedStyle(document.body).backgroundColor'), 'rgb(240, 220, 190)');
  assert.equal(await evaluate(first.tab, 'document.querySelector("#asset").naturalWidth'), 1);
  assert.deepEqual(await evaluate(first.tab, 'window.appErrors'), []);
  assert.equal(new URL(first.url).pathname, '/index.html');
  for (const port of new Set([5067, 5080, fixture.app.server.address().port, Number(new URL(first.url).port)])) {
    const response = await fetch(`${origin}/shown/view`, { method: 'POST', headers: { authorization: AUTH, origin, 'content-type': 'application/json' }, body: JSON.stringify({ target: `http://localhost:${port}/` }) });
    assert.ok(response.status >= 400, `hosted view refuses private/unregistered service port ${port}`);
  }
  await until(() => seen.live.some(live => live.sent.some(said => said.do === 'watch' && said.tab === first.tab)
    && live.received.some(said => said.frame && said.tab === first.tab)), 'fixed-tab production live stream');
  assert.ok(seen.upgrades.some(one => one.path === '/browser/live' && one.authenticated), 'stream crosses authenticated door');
  await clickStream(fixture, first.tab, '#play');
  await until(async () => await evaluate(first.tab, 'document.title') === 'Playing', 'real person click');
  await clickStream(fixture, first.tab, '#input');
  await page.waitForFunction(() => document.activeElement.matches('.wm-files .browser-live-keyboard'));
  assert.equal(await page.locator('.browser-live-type').count(), 0);
  await page.keyboard.insertText('hello from the person');
  await page.keyboard.press('Enter');
  await until(async () => await evaluate(first.tab, 'document.querySelector("#typed").textContent') === 'hello from the person', 'real person typing');
  const same = await json('/shown/view', { target: join(dir, 'index.html') });
  assert.equal(same.tab, first.tab, 'file and folder resolve to the same reused tab');
  assert.equal(await evaluate(first.tab, 'document.title'), 'Playing', 'reopening preserves app state');
  await runShow({ path: join(dir, 'index.html'), session: 'proof-session' });
  await until(async () => await evaluate(first.tab, 'document.title') === 'Hosted proof', 'showing the HTML file reloads its existing streamed app');
  assert.equal(await page.locator('.wm-files .workbench-view-count').textContent(), '+', 'file show reuses the folder app view');
  // A shown preview must stay on its own tab even when the ordinary browser's
  // front tab changes. A normal portal still follows that front tab.
  const other = await ask({ do: 'open', url: first.url, session: 'other' });
  await ask({ do: 'front', tab: other.tab });
  await evaluate(other.tab, 'document.title = "Unrelated front tab"');
  await evaluate(first.tab, 'document.title = "Waiting for fixed click"');
  await clickStream(fixture, first.tab, '#play');
  await until(async () => await evaluate(first.tab, 'document.title') === 'Playing', 'fixed-tab click while another tab is in front');
  assert.equal(await evaluate(other.tab, 'document.title'), 'Unrelated front tab', 'fixed view does not send clicks to front tab');
  const watched = new WebSocket(`${origin.replace(/^http/, 'ws')}/browser/live`, { headers: { authorization: AUTH, origin } });
  const frontFrames = [];
  watched.on('message', raw => { const said = JSON.parse(raw); if (said.frame) { frontFrames.push(said); watched.send('{"ack":true}'); } });
  await new Promise((resolve, reject) => { watched.once('open', resolve); watched.once('error', reject); });
  t.after(() => watched.terminate()); watched.send('{"do":"watch"}');
  await until(() => frontFrames.some(frame => frame.tab === other.tab), 'ordinary portal follows front tab');
  const reload = await json('/shown/view', { target: dir, reload: true });
  assert.equal(reload.tab, first.tab);
  await until(async () => await evaluate(first.tab, 'document.title') === 'Hosted proof', 'explicit reload resets app');
  // The real Browser preview uses a scoped pinned stream, not an
  // iframe or a private renderer; its strip lists the owner's other tabs. It works alongside Workbench's preview.
  const project = join(root, 'projects/browser-proof'); await makeApp(project);
  const browserView = await json('/shown/view', { target: project });
  fixture.say(`[Open native preview](${browserView.url})`);
  await page.locator('.gui-assistant a[data-page]').click();
  await page.locator('.wm-browser').scrollIntoViewIfNeeded();
  await page.locator('.wm-browser .browser-live-frame').waitFor();
  await page.waitForFunction(() => document.querySelector('.wm-browser .browser-live-frame')?.naturalWidth > 0);
  assert.equal(browserView.stream, true); assert.notEqual(browserView.tab, first.tab);
  await clickStream(fixture, browserView.tab, '#play', '.wm-browser .browser-live-frame');
  await until(async () => await evaluate(browserView.tab, 'document.title') === 'Playing', 'real Browser preview panel click');
  assert.equal(await page.locator('.wm-browser iframe,.wm-browser webview').count(), 0);
  await until(() => seen.live.some(live => live.sent.some(said => said.do === 'watch' && said.tab === browserView.tab && said.scope === 'browser')), 'Browser panel scoped pinned watch');
  const paper = join(project, 'paper.pdf'); await writeFile(paper, makePDF());
  await runShow({ path: paper, session: 'proof-session' });
  const pdf = await json('/shown/view', { target: paper });
  // Showing adds a quiet tab; following its conversation link selects it.
  fixture.say(`[Open PDF preview](${pdf.url})`);
  await page.getByRole('link', { name: 'Open PDF preview', exact: true }).click();
  await page.locator('.wm-browser').scrollIntoViewIfNeeded();
  const ownerTabs = (await ask({ do: 'tabs' })).tabs;
  await until(async () => await page.locator('.wm-browser .browser-tab').count() === ownerTabs.length, 'Browser strip lists all owning-computer tabs');
  assert.deepEqual((await page.locator('.wm-browser .browser-tab').evaluateAll(tabs => tabs.map(tab => Number(tab.dataset.tab)))).sort((a, b) => a - b), ownerTabs.map(tab => tab.tab).sort((a, b) => a - b), 'shown PDF selects a preview without hiding the other browser tabs');
  assert.equal(await page.locator('.wm-browser .browser-tab-strip').count(), 1, 'inactive local and remote headers stay detached');
  assert.equal(new URL(pdf.url).origin, new URL(browserView.url).origin, 'PDF and page share only their containing-folder origin');
  await until(() => seen.live.some(live => live.sent.some(said => said.do === 'watch' && said.tab === pdf.tab)
    && live.received.some(said => said.frame && said.tab === pdf.tab)), 'real native PDF streams through Browser panel');
  assert.equal(await evaluate(pdf.tab, 'location.href'), pdf.url, 'PDF renderer reached the authorized native file, not a door login/error');
  assert.equal(await page.locator('.wm-browser iframe,.wm-browser webview').count(), 0);
  const imagePath = join(dir, 'pixel.png');
  fixture.showResult(await runShow({ path: imagePath, session: 'proof-session' }));
  const media = page.locator('.gui-window img[src*="/files/raw"]').first();
  await media.waitFor({ state: 'attached' });
  await until(async () => await media.evaluate(image => image.complete && image.naturalWidth === 1), 'shown conversation PNG loads through authenticated native media route');
  assert.equal(new URL(await media.getAttribute('src')).origin, origin);
  assert.ok(seen.responses.some(response => response.status === 200 && response.type.startsWith('image/png') && response.url.startsWith(`${origin}/files/raw?path=`)));
  // Explicit show also works for a server the person/agent started outside
  // dev_server. It has no saved service identity, so it uses Browser, not
  // Files; an arbitrary unopened port remains forbidden.
  const raw = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/deep' }); res.end(); return; }
    if (req.url === '/broken') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<title>Compile error</title><h1>Fix the code</h1>'); return; }
    if (req.url === '/raw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('window.rawLoaded=true'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Manual app</title><button id="raw" onclick="document.title=\'Raw playing\'">Raw play</button><script src="/raw.js"></script>'); }
  });
  await new Promise(resolve => raw.listen(0, '127.0.0.1', resolve));
  t.after(async () => { raw.closeAllConnections(); await new Promise(resolve => raw.close(resolve)); });
  const rawURL = `http://localhost:${raw.address().port}/redirect`;
  const unopened = await fetch(`${origin}/shown/view`, { method: 'POST', headers: { authorization: AUTH, origin, 'content-type': 'application/json' }, body: JSON.stringify({ target: rawURL }) });
  assert.equal(unopened.status, 503);
  await runShow({ path: rawURL, session: 'proof-session' });
  fixture.say(`[Open manual server](${rawURL})`);
  await page.getByRole('link', { name: 'Open manual server', exact: true }).click();
  const rawView = await json('/shown/view', { target: rawURL });
  assert.equal(rawView.stream, true);
  await until(async () => await evaluate(rawView.tab, 'window.rawLoaded') === true, 'manually started server absolute asset loads natively');
  assert.equal(await evaluate(rawView.tab, 'location.pathname'), '/deep', 'native redirects work without carried-path rewriting');
  await until(() => seen.live.some(live => live.sent.some(said => said.do === 'watch' && said.tab === rawView.tab)
    && live.received.some(said => said.frame && said.tab === rawView.tab)), 'manual server streams in Browser panel');
  await clickStream(fixture, rawView.tab, '#raw', '.wm-browser .browser-page.front .browser-live-frame');
  await until(async () => await evaluate(rawView.tab, 'document.title') === 'Raw playing', 'person clicks manually started hosted app');
  await runShow({ path: rawURL, session: 'proof-session' });
  await until(async () => await evaluate(rawView.tab, 'document.title') === 'Manual app', 're-show reloads the manually started app in its existing tab');
  assert.equal((await json('/shown/view', { target: rawURL })).tab, rawView.tab);
  const brokenURL = `http://localhost:${raw.address().port}/broken`;
  await runShow({ path: brokenURL, session: 'proof-session' });
  fixture.say(`[Open compile error](${brokenURL})`);
  await page.getByRole('link', { name: 'Open compile error', exact: true }).click();
  const broken = await json('/shown/view', { target: brokenURL });
  await until(async () => await evaluate(broken.tab, 'document.body.innerText') === 'Fix the code', 'HTTP dev error pages are shown, not mistaken for an unavailable server');
  await until(() => seen.live.some(live => live.received.some(said => said.frame && said.tab === broken.tab)), 'compile error pixels reach the person');
  await assertDoor(fixture, ['/raw.js', `/port/${raw.address().port}/deep`]);
  const leaked = seen.requests.filter(req => req.authenticated && /^\/(?:src\/|raw\.js|pixel\.png|style\.css|port\/)/.test(req.path));
  assert.deepEqual(leaked, [], 'visitor receives frames, never app scripts/assets through the public door');
  assert.deepEqual(fixture.pageErrors, []);
  } catch (error) {
    // Observe a failed step before teardown without adding a readiness round
    // trip (or retry) to any successful input/stream assertion.
    try {
      t.diagnostic(JSON.stringify({
        failed: error.message, tabs: await ask({ do: 'tabs' }),
        live: seen.live.map(live => ({
          closed: live.closed, sent: live.sent.filter(said => !said.ack),
          received: live.received.filter(said => !said.frame).slice(-5),
          frames: live.received.filter(said => said.frame).map(said => ({ tab: said.tab, size: said.size })).slice(-3),
        })),
        ui: await page.evaluate(() => ({
          browser: document.querySelector('.wm-browser')?.innerText,
          panels: [...document.querySelectorAll('.wm-window')].map(el => ({ class: el.className, box: el.getBoundingClientRect().toJSON() })),
          frames: [...document.querySelectorAll('.browser-live-frame')].map(el => ({ box: el.getBoundingClientRect().toJSON(), drawn: el.naturalWidth })),
          viewport: [innerWidth, innerHeight],
        })),
      }));
    } catch (diagnosticError) { t.diagnostic(`Hosted diagnostics unavailable: ${diagnosticError.message}`); }
    throw error;
  }
});

test('real Vite stays native localhost: absolute modules/assets, connected HMR, hot update and client deep-link reload stream through the real UI', { timeout: 180000 }, async t => {
  const fixture = await hostedFixture(t);
  const { root, page, json, evaluate, seen } = fixture;
  const dir = join(root, 'vite'); await makeApp(dir);
  // Observe, without changing destinations or substituting a fake transport,
  // the native WebSocket used by Vite's actual /@vite/client module.
  await writeFile(join(dir, 'index.html'), appHTML.replace('<head>', `<head><script>
window.socketProof=[];const NativeWebSocket=window.WebSocket;
window.WebSocket=class extends NativeWebSocket { constructor(url, protocols) { super(url, protocols); const proof={url:String(url),protocols,open:false};window.socketProof.push(proof);this.addEventListener('open',()=>{proof.open=true;proof.protocol=this.protocol;}); } };
</script>`));
  const viteCLI = fileURLToPath(new URL('../../../../node_modules/vite/bin/vite.js', import.meta.url));
  const registry = devServers();
  const started = await registry.start({ cwd: dir, name: 'Hosted Vite proof', session: 'proof-session',
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(viteCLI)} --host 127.0.0.1 --port 0` });
  t.after(async () => { await registry.stop(started.server.id); });
  assert.ok(started.server.running && started.server.url, `Real Vite did not start: ${started.log}`);
  const nativeOrigin = new URL(started.server.url).origin;
  await assertDoor(fixture, ['/', '/@vite/client', '/src/message.js', '/src/main.js', '/pixel.png', '/nested/client',
    `/port/${new URL(nativeOrigin).port}/`, '/shown/view', '/browser/live']);
  await runShow({ path: started.server.url, session: 'proof-session' });
  await page.locator('.wm-files').scrollIntoViewIfNeeded();
  await page.locator('.wm-files .browser-live-frame').waitFor({ state: 'attached' });
  // Agent presentation keeps an existing Files view selected. The person
  // explicitly selects the new registered app rather than stealing focus.
  await page.locator('.wm-files .workbench-view-count').click();
  await page.locator('.wm-files .workbench-tab').filter({ hasText: 'Hosted Vite proof' }).getByRole('button').first().click();
  await revealFiles(page);
  const resolved = await json('/shown/view', { target: started.server.url });
  assert.equal(resolved.stream, true);
  assert.equal(new URL(resolved.url).origin, nativeOrigin, 'no /port proxy origin or rewritten app');
  assert.equal(new URL(resolved.url).pathname, '/');
  await until(async () => await evaluate(resolved.tab, 'document.body.dataset.ready') === 'yes', 'real Vite module loaded');
  assert.equal(await evaluate(resolved.tab, 'document.querySelector("#message").textContent'), 'Module loaded');
  assert.equal(await evaluate(resolved.tab, 'document.querySelector("#asset").naturalWidth'), 1);
  await until(async () => (await evaluate(resolved.tab, 'window.socketProof')).some(socket => socket.open && socket.protocol === 'vite-hmr'), 'real Vite HMR websocket connected');
  const sockets = await evaluate(resolved.tab, 'window.socketProof');
  assert.ok(sockets.some(socket => socket.open && new URL(socket.url).hostname === 'localhost' && new URL(socket.url).port === new URL(nativeOrigin).port));
  const loadId = await evaluate(resolved.tab, 'window.loadId');
  const beforeHotFrame = await page.locator('.wm-files .browser-live-frame').getAttribute('src');
  await writeFile(join(dir, 'src/message.js'), 'export const message = "Hot update arrived";');
  await until(async () => await evaluate(resolved.tab, 'document.querySelector("#message").textContent') === 'Hot update arrived', 'real Vite hot update');
  assert.equal(await evaluate(resolved.tab, 'window.loadId'), loadId, 'HMR updates module without reloading app');
  // File watchers may report the same write more than once under load. What
  // matters is an accepted hot update, unchanged document and new pixels.
  assert.ok(await evaluate(resolved.tab, 'window.updates') >= 1);
  await until(async () => await page.locator('.wm-files .browser-live-frame').getAttribute('src') !== beforeHotFrame, 'hot-updated pixels reach actual Workbench image');
  await clickStream(fixture, resolved.tab, '#route');
  await until(async () => await evaluate(resolved.tab, 'location.pathname') === '/nested/client', 'person client-side navigation');
  const deep = await json('/shown/view', { target: `${nativeOrigin}/nested/client`, reload: true });
  assert.equal(new URL(deep.url).pathname, '/nested/client');
  assert.equal(deep.tab, resolved.tab, 'the routed page reloads in the tab already being streamed');
  await until(async () => await evaluate(deep.tab, 'document.body.dataset.ready') === 'yes', 'deep-link reload loads Vite SPA');
  assert.equal(await evaluate(deep.tab, 'document.body.dataset.route'), '/nested/client');
  assert.notEqual(await evaluate(deep.tab, 'window.loadId'), loadId, 'deep-link reload is a real fresh document');
  assert.equal(await evaluate(deep.tab, 'window.updates'), 0);
  assert.equal(await evaluate(deep.tab, 'document.querySelector("#message").textContent'), 'Hot update arrived');
  await until(() => seen.live.some(live => live.received.some(frame => frame.frame && frame.tab === resolved.tab)), 'real streamed Vite frames');
  assert.equal(await page.locator('.wm-files iframe,.wm-files webview').count(), 0);
  assert.deepEqual(seen.requests.filter(req => req.authenticated && /^\/(?:@vite\/|src\/|pixel\.png|port\/)/.test(req.path)), [], 'Vite assets and HMR never cross visitor door');
  assert.deepEqual(fixture.pageErrors, []);
});
