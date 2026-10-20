// The actual product document, embedded at its real origin behind an isolated
// transport fixture. No production ticket, computer, credentials or runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, readBody, PNG } from './fixtures/harness-page.mjs';
import { createDemoInbox } from '../../../../system/inbox-demo.mjs';

const HARNESSES = [{ agent: 'pi', ready: true }, { agent: 'claude', ready: true }, { agent: 'codex', ready: true }];
const mutatesSession = command => /^(tab-(?:new|focus|open|close)|session-attach|prompt|set-model)$/.test(command.type);
async function launchFixture({ hasTouch = false, kinso = false } = {}) {
  const browserCalls = [], filesCalls = [], watchers = new Set();
  const inbox = await createDemoInbox().list();
  let tabs = [{ tab: 4, title: 'Other', url: 'https://example.test', front: true }];
  const send = ws => {
    const tab = tabs.find(tab => tab.front);
    ws.send(JSON.stringify({ tabs }));
    if (tab) ws.send(JSON.stringify({ frame: PNG.toString('base64'), width: 1, height: 1, tab: tab.tab }));
  };
  const f = await harnessFixture({ launchFrame: true, hasTouch,
    ...(kinso ? { productOrigin: 'https://computer.kinso.computer', launchOrigin: 'https://kinso.computer' } : {}),
    messages: [{ role: 'assistant', content: 'Existing private session' }],
    machines: [{ id: 'vm', name: 'Noah', self: true, hosted: true, home: true, reachable: true }], snapshot: { harnesses: HARNESSES },
    handleRequest: async (req, res, path) => {
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (path === '/inbox/list') { json(inbox); return true; }
      if (path === '/files/list') { filesCalls.push(req.url); json({ path: '/home/noah', home: '/home/noah', entries: [{ name: 'Downloads', path: '/home/noah/Downloads', dir: true, size: 0, mtime: 1 }] }); return true; }
      if (path !== '/browser') return false;
      const request = await readBody(req); browserCalls.push(request);
      if (request.do === 'tabs') json({ tabs });
      else if (request.do === 'open') { const tab = { tab: 5, url: request.url, title: 'Google', front: false }; tabs.push(tab); json(tab); }
      else if (request.do === 'front') { tabs = tabs.map(tab => ({ ...tab, front: tab.tab === request.tab })); json({ tab: request.tab }); }
      else { res.statusCode = 400; json({ error: 'unexpected browser command' }); }
      for (const ws of watchers) send(ws);
      return true;
    },
    onBrowserLive: ws => { watchers.add(ws); ws.on('close', () => watchers.delete(ws)); ws.on('message', raw => { const request = JSON.parse(raw); if (request.do === 'watch') send(ws); }); },
  });
  return Object.assign(f, { browserCalls, filesCalls });
}
async function step(f, step) {
  await f.page.evaluate(({ step, origin }) => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step }, origin), { step, origin: new URL(f.product.url()).origin });
  await f.page.waitForFunction(step => messages.some(message => message.type === 'imperfect:assembled' && message.step === step), step);
}

test('the real framed fresh session assembles monotonically without touching existing session state', async () => {
  const f = await launchFixture(); const { product, page } = f;
  try {
    assert.equal(await product.locator('html').getAttribute('data-assembly-step'), 'bare');
    assert.equal(await product.locator('.fresh-question').textContent(), 'what do you want?');
    assert.equal(await product.locator('[data-computer], .agent-choose').count(), 0);
    assert.equal(await product.locator('#session-rail').isVisible(), false);
    assert.equal(await product.locator('.wm-files').isVisible(), false);
    assert.equal(await product.locator('canvas.kept-sky').count(), 0);
    assert.equal(f.commands.some(mutatesSession), false);
    assert.equal(f.browserCalls.length, 0, 'bare does not open or navigate the browser');
    await product.locator('#entry-input').fill('not until the computer is ready');
    await product.locator('#entry-send').click();
    await product.locator('#entry-files').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
    await product.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(f.commands.some(mutatesSession), false, 'send and attach cannot bypass unfinished assembly');
    await product.locator('#entry-input').fill('');
    await page.waitForFunction(() => messages.some(message => message.type === 'imperfect:demo-ready'));
    for (const stepName of ['bare', 'claude', 'codex']) {
      await step(f, stepName);
      assert.equal(await product.locator('#entry-terminal.fresh .fresh-question').isVisible(), true);
    }
    await step(f, 'files');
    assert.equal(await product.locator('#session-rail').isVisible(), true);
    await product.locator('.wm-files .workbench-item').first().waitFor();
    assert.ok(f.filesCalls.some(path => path === '/files/list?path='));
    assert.equal(await product.locator('.wm-files').isVisible(), true);
    await step(f, 'browser');
    await product.locator('.wm-live .browser-live-frame').waitFor();
    await page.waitForFunction(() => true);
    await product.waitForFunction(() => document.querySelector('.wm-live .gui-window-address')?.value === 'https://www.google.com');
    assert.deepEqual(f.browserCalls, [{ do: 'tabs' }, { do: 'open', url: 'https://www.google.com' }, { do: 'front', tab: 5 }]);
    await step(f, 'done');
    await step(f, 'done');
    assert.equal(f.browserCalls.length, 3, 'duplicate done does not reopen the browser');
    assert.equal(await product.locator('#entry-terminal.fresh .fresh-question').isVisible(), true, 'done retains the new-session page');
    assert.equal(await product.locator('.agent-choose-hint').count(), 0);
    assert.equal(f.commands.some(mutatesSession), false);
    // Already-existing/background sessions cannot displace the client chooser.
    f.push({ ...f.tab, tabs: [...f.tab.tabs, { id: 'background', agent: 'claude', name: 'Background' }] });
    await product.locator('#entry-terminal.fresh .fresh-question').waitFor();
    assert.equal(f.commands.some(mutatesSession), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a background snapshot preserves the fresh composer and its question', async () => {
  const f = await launchFixture();
  try {
    await step(f, 'codex');
    await f.product.locator('#entry-input').fill('a private draft');
    f.push({ ...f.tab });
    await f.product.waitForFunction(() => document.querySelector('#entry-terminal.fresh .fresh-question')?.isConnected);
    assert.equal(await f.product.locator('#entry-input').inputValue(), 'a private draft');
    assert.equal(f.commands.some(mutatesSession), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('skip is cumulative and a coarse pointer still gets the desktop product in the launch frame', async () => {
  const f = await launchFixture({ hasTouch: true });
  try {
    await step(f, 'done');
    assert.equal(await f.product.locator('#entry-terminal.focus-layout').count(), 1);
    assert.equal(await f.product.locator('#entry-terminal.phone-layout').count(), 0);
    assert.equal(await f.product.locator('#entry-terminal.fresh .fresh-question').isVisible(), true);
    assert.equal(await f.product.locator('#session-rail').isVisible(), true);
    assert.equal(f.commands.some(mutatesSession), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the same authenticated launch surface can show an inert native phone fresh screen, not another session', async () => {
  const f = await launchFixture();
  try {
    await f.page.evaluate(() => {
      const frame = document.querySelector('iframe');
      Object.assign(frame.style, { width: '390px', height: '844px' });
      frame.src = 'https://noah.imperfect.computer/?face=code&launch=phone';
    });
    await f.product.waitForURL('**/?face=code&launch=phone');
    await f.product.locator('html.launch-phone #entry-terminal.phone-layout .fresh-question').waitFor();
    await step(f, 'done');
    assert.equal(await f.product.locator('html.launch-framed').count(), 0);
    assert.equal(await f.product.locator('#entry-terminal.focus-layout').count(), 0);
    assert.equal(await f.product.locator('[data-computer]').count(), 0);
    const rect = await f.product.locator('#entry-terminal.fresh .fresh-question').evaluate(node => {
      const r = node.getBoundingClientRect(), root = getComputedStyle(document.documentElement);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, safeTop: root.getPropertyValue('--safe-top').trim(), safeBottom: root.getPropertyValue('--safe-bottom').trim() };
    });
    assert.equal(rect.width, 390); assert.equal(rect.height, 844);
    assert.ok(rect.left >= 0 && rect.right <= 390 && rect.top >= 54 && rect.bottom <= 818, JSON.stringify(rect));
    assert.equal(rect.safeTop, '54px'); assert.equal(rect.safeBottom, '26px');
    assert.equal(f.browserCalls.length, 0, 'the phone does not open another Google tab');
    const hello = f.commands.filter(command => command.type === 'hello').at(-1);
    assert.equal(hello.kind, 'viewer'); assert.equal(hello.visible, false, 'a passive companion never takes the active person/browser role');
    f.send({ type: 'browse', machine: 'vm' }); f.send({ type: 'shown', target: 'https://www.google.com' });
    await f.product.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await f.product.locator('.wm-live').count(), 0, 'agent announcements cannot open a second stream behind the phone chooser');
    assert.equal(f.browserCalls.length, 0);
    assert.equal(f.commands.some(mutatesSession), false);
    f.push({ ...f.tab, tabs: [...f.tab.tabs, { id: 'ambient', agent: 'claude', name: 'Background' }] });
    await f.product.locator('#entry-terminal.fresh .fresh-question').waitFor();
    assert.equal(f.commands.some(mutatesSession), false, 'ambient snapshots never focus or create a session');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('same-frame and wrong-origin messages cannot start assembly, and earlier steps never undo it', async () => {
  const f = await launchFixture();
  try {
    await f.product.evaluate(() => {
      window.postMessage({ type: 'imperfect:assemble', step: 'done' }, location.origin);
      dispatchEvent(new MessageEvent('message', { source: parent, origin: 'https://imperfect.computer.evil.test', data: { type: 'imperfect:assemble', step: 'done' } }));
    });
    await f.product.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await f.product.locator('html').getAttribute('data-assembly-step'), 'bare');
    await step(f, 'codex');
    await f.page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step: 'bare' }, 'https://noah.imperfect.computer'));
    assert.equal(await f.product.locator('html').getAttribute('data-assembly-step'), 'codex');
    assert.equal(f.browserCalls.length, 0);
    assert.equal(f.commands.some(mutatesSession), false);
  } finally { await f.close(); }
});

test('Kinso keeps reordered Messages hidden until its own assembly beat, including sidebar redraws', async t => {
  const f = await launchFixture({ kinso: true }); t.after(() => f.close());
  const p = f.product;
  for (const beat of ['bare', 'claude', 'codex', 'files', 'browser']) {
    await step(f, beat);
    f.push({ ...f.tab, stats: { cost: 1 } });
    await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await p.locator('#session-rail .sidebar-head-title', { hasText: /^Messages$/ }).count(), 0, `${beat}: no early Messages section`);
    assert.equal(await p.getByText('All messages', { exact: true }).count(), 0);
    if (beat === 'files' || beat === 'browser') assert.deepEqual(await p.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites']);
  }
  await step(f, 'messages');
  assert.deepEqual(await p.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites', 'Messages']);
  await p.getByText('All messages', { exact: true }).waitFor();
  const names = await p.locator('#session-rail .session-rail-sidebar .session-rail-asked').allTextContents();
  assert.deepEqual(names.slice(-4), ['Ingrid Vasquez-Holm', 'Jun Takeda-Price', 'Tobias Ferreira-Lund', 'All messages']);
  await step(f, 'done');
  assert.deepEqual(await p.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites', 'Messages']);
  assert.equal(f.commands.some(mutatesSession), false);
  assert.deepEqual(f.errors, []);
});
