import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('two live owners: persistent rail, colliding identities, drafts/images, targeted queue and uploads', async () => {
  const root = new URL('../public/', import.meta.url);
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const calls = [], urls = [], clients = new Map(), pendingPrompts = [], listed = [];
  const until = async (check, what) => { for (const end = Date.now() + 5000; !check();) { if (Date.now() > end) assert.fail(what); await new Promise(r => setTimeout(r, 20)); } };
  let refuseFocus = false;
  let offline = false, uploads = 0, holdSnapshot = false, heldSnapshot;
  const snapshots = Object.fromEntries(['a', 'b'].map(owner => [owner, {
    agent: 'pi', sessionId: 'same-session', cwd: '/fixture', model: { provider: 'fixture', id: owner }, harnesses: [{ agent: 'pi', ready: true }],
    messages: [{ role: 'user', content: `owner ${owner}` }], stats: {}, ui: {},
    queue: { items: [{ id: 'same-queue', lane: 'steering', text: `${owner} queued`, images: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }] },
    tabs: [{ id: 'same-tab', sessionId: 'same-session', focused: true, agent: 'pi', model: owner, name: owner }],
  }]));
  const push = owner => clients.get(owner)?.send(JSON.stringify({ type: 'snapshot', data: snapshots[owner] }));
  const reply = (ws, c, data, error) => ws.send(JSON.stringify({ type: 'response', id: c.id, success: !error, data, error }));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path.endsWith('/files/list')) listed.push(req.url);
    try {
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html + '<style>#entry-terminal{height:650px!important}.entry-screen{height:450px;min-height:0}</style>'); return; }
      if (path.endsWith('/upload')) { uploads++; res.end(JSON.stringify({ reference: { name: 'uploaded', sessionId: 'same-session' } })); return; }
      if (path.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ machines: [{ id: 'a', name: 'desktop', self: true, reachable: true }, { id: 'b', name: 'laptop', reachable: !offline, home: true }, { id: 'c', name: 'offline', reachable: false }] })); return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const owner = /^\/peer\/([^/]+)\/pi$/.exec(req.url)?.[1] || 'a';
    urls.push(req.url);
    if (owner === 'b' && offline) { ws.close(); return; }
    clients.set(owner, ws); push(owner);
    ws.on('message', raw => {
      const c = JSON.parse(raw); calls.push({ owner, ...c });
      if (c.type === 'snapshot') {
        if (owner === 'b' && holdSnapshot) heldSnapshot = () => reply(ws, c, snapshots[owner]);
        else reply(ws, c, snapshots[owner]);
      }
      else if (c.type === 'harness') reply(ws, c, { startable: ['pi'] });
      else if (c.type === 'queue-take') { reply(ws, c, { item: snapshots[owner].queue.items.shift() }); push(owner); }
      else if (c.type === 'prompt') pendingPrompts.push({ owner, c, ws });
      else if (c.type === 'tab-focus') {
        const answer = () => reply(ws, c, { id: c.tabId, focused: true, snapshot: snapshots[owner] });
        if (owner === 'b' && refuseFocus) reply(ws, c, null, 'Owner refused focus');
        else if (owner === 'b' && holdSnapshot) heldSnapshot = answer;
        else answer();
      }
      else reply(ws, c, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}/?face=code`;
    await page.addInitScript(() => {
      // This owner/queue regression also asserts the scrolling layout's rail.
      // Browser windows now default to focus; choose the layout under test.
      localStorage.setItem('imperfect.layout-choice.v2', 'scrolling');
      localStorage.setItem('guey-draft:' + JSON.stringify(['a', 'same-session']), 'saved local draft');
    });
    await page.goto(url);
    await page.evaluate(async () => {
      const { mountGueyPi } = await import('/js/harness.js');
      window.harness = mountGueyPi({ hooks: { canFocus: () => true } });
    });
    const row = owner => page.locator(`.session-rail-item[data-owner="${owner}"] .session-rail-open`);
    await row('b').waitFor();
    await page.waitForFunction(() => harness.guiSnapshot().owner === 'a');
    assert.equal(await row('a').count(), 1); assert.equal(await row('b').count(), 1);
    assert.equal(await page.locator('.session-rail-machine').count(), 2, 'computer groups share the tab region');
    assert.ok(await page.locator('.session-rail-new .session-rail-open').evaluate(n => {
      const r = n.getBoundingClientRect(), rail = n.closest('#session-rail').getBoundingClientRect();
      return r.left >= rail.left && r.right <= rail.right && n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }), 'grouped computers cannot swallow the new-session slot');
    await page.getByRole('button', { name: 'show the agents', exact: true }).click();
    assert.ok(await page.locator('#session-rail').evaluate(n => {
      const r = n.getBoundingClientRect(), work = document.querySelector('.entry-screen').getBoundingClientRect(), composer = document.querySelector('#entry-input-zone').getBoundingClientRect();
      return Math.abs(r.left - work.left) <= 1 && Math.abs(r.width - work.width) <= 2 && r.bottom <= composer.top + 1;
    }), 'expanded preview belongs to the conversation, not neighboring panes or composer');
    await page.getByRole('button', { name: 'collapse the agents', exact: true }).click();
    assert.deepEqual(urls.sort(), ['/peer/b/pi', '/pi']);
    assert.equal(calls.find(c => c.owner === 'b' && c.type === 'hello').kind, 'viewer');
    assert.equal(calls.filter(c => c.owner === 'b' && ['faces','open_face'].includes(c.type)).length, 0);
    assert.equal(calls.filter(c => ['prompt','tab-new','tab-focus'].includes(c.type)).length, 0);
    assert.equal(await page.locator('#entry-input').inputValue(), 'saved local draft', 'a conversation\'s draft comes back with it');
    await page.locator('#entry-input').fill('desktop draft');
    await page.locator('[data-queue-id="same-queue"]').click();
    await page.waitForFunction(() => document.querySelector('#entry-input').value.startsWith('a queued'));
    const draftA = await page.locator('#entry-input').inputValue();
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 1);
    refuseFocus = true; await row('b').click();
    await page.waitForFunction(() => document.querySelector('#entry-flash').textContent.includes('Owner refused focus'));
    assert.equal(await page.evaluate(() => harness.guiSnapshot().owner), 'a');
    assert.equal(await page.locator('#entry-input').inputValue(), draftA);
    await until(() => listed.includes('/files/list?path='), 'Workbench opens at this computer\'s home');
    assert.ok(!listed.some(asked => asked.startsWith('/peer/')), 'a refused switch leaves Workbench where it is');
    refuseFocus = false;
    holdSnapshot = true;
    await row('b').click();
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => harness.guiSnapshot().owner), 'a', 'keep old view until destination snapshot is ready');
    assert.equal(await page.locator('#entry-input').inputValue(), draftA);
    assert.ok(heldSnapshot); holdSnapshot = false; heldSnapshot();
    await page.waitForFunction(() => harness.guiSnapshot().owner === 'b');
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('owner b'));
    assert.ok(!(await page.locator('#entry-output').textContent()).includes('owner a'));
    await until(() => listed.at(-1) === '/peer/b/files/list?path=', 'Workbench follows the session to its computer\'s home');
    assert.equal(await page.locator('#entry-input').inputValue(), '');
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 0);
    await page.locator('#entry-input').fill('laptop draft');
    await page.locator('[data-queue-id="same-queue"]').click();
    await page.waitForFunction(() => document.querySelector('#entry-input').value.startsWith('b queued'));
    const draftB = await page.locator('#entry-input').inputValue();
    assert.deepEqual(calls.filter(c => c.type === 'queue-take').map(c => [c.owner,c.expectedSessionId,c.expectedTabId]), [['a','same-session','same-tab'],['b','same-session','same-tab']]);
    const focusCalls = calls.filter(c => c.type === 'tab-focus').length;
    snapshots.a.messages = [{ role: 'user', content: 'BACKGROUND MUST NOT APPEAR' }]; push('a');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => harness.guiSnapshot().owner), 'b');
    assert.equal(await page.locator('#entry-input').inputValue(), draftB);
    assert.equal(calls.filter(c => c.type === 'tab-focus').length, focusCalls);
    assert.ok(!(await page.locator('#entry-output').textContent()).includes('BACKGROUND MUST NOT APPEAR'));
    await page.evaluate(() => harness.attachFiles([new File(['private'], 'example.txt', { type: 'text/plain' })]));
    assert.equal(uploads, 1);
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 2, 'remote file joins the queued image');
    await row('a').click(); await page.waitForFunction(() => harness.guiSnapshot().owner === 'a');
    assert.equal(await page.locator('#entry-input').inputValue(), draftA);
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 1);
    await until(() => listed.at(-1) === '/files/list?path=', 'and back');
    await row('b').click(); await page.waitForFunction(() => harness.guiSnapshot().owner === 'b');
    assert.equal(await page.locator('#entry-input').inputValue(), draftB);
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 2);
    await page.evaluate(() => { window.submission = harness.submit(); }); await page.waitForTimeout(100);
    assert.equal(pendingPrompts.length, 1); assert.equal(pendingPrompts[0].owner, 'b');
    assert.equal(pendingPrompts[0].c.images[0].data, 'aW1hZ2U=');
    const first = pendingPrompts[0];
    await row('a').click(); await page.waitForFunction(() => harness.guiSnapshot().owner === 'a');
    assert.equal(await page.locator('#entry-input').inputValue(), draftA);
    await page.evaluate(() => { window.localSubmission = harness.submit(); }); await page.waitForTimeout(100);
    const local = pendingPrompts.at(-1);
    assert.equal(local.owner, 'a', 'another owner can submit while remote acceptance is pending');
    assert.notEqual(local.c.requestId, first.c.requestId);
    reply(local.ws, local.c, null, 'Local review'); await page.evaluate(() => localSubmission);
    reply(first.ws, first.c, null, 'Acceptance unknown'); await page.evaluate(() => submission);
    assert.equal(await page.locator('#entry-input').inputValue(), draftA, 'background failure restores only its originating owner draft');
    await row('b').click(); await page.waitForFunction(() => harness.guiSnapshot().owner === 'b');
    await page.evaluate(() => { window.submission = harness.submit(); }); await page.waitForTimeout(100);
    const retry = pendingPrompts.at(-1); assert.equal(retry.c.requestId, first.c.requestId);
    reply(retry.ws, retry.c, { accepted: true, pending: true }); await page.evaluate(() => submission);
    assert.equal(calls.filter(c => c.type === 'tab-new').length, 0);
    assert.equal(page.url(), url);
    assert.equal(urls.length, 2, 'selection reuses persistent streams');
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.fresh');
    assert.equal(await page.locator('[data-computer], .agent-choose-machine').count(), 0);
    assert.equal(calls.filter(c => c.type === 'tab-new').length, 0, 'a fresh screen alone makes nothing');
    await page.keyboard.press('Escape');
    assert.equal(page.url(), url);
    await row('a').click(); await page.waitForFunction(() => harness.guiSnapshot().owner === 'a');
    offline = true; clients.get('b').close();
    await page.waitForFunction(() => document.querySelector('.session-rail-item[data-owner="b"] .session-rail-open').disabled);
    assert.match(await row('b').getAttribute('title'), /offline/);
    assert.equal(await row('b').count(), 1, 'offline owner remains visible');
    assert.equal(await page.evaluate(() => harness.guiSnapshot().owner), 'a');
    assert.equal(await page.locator('#entry-input').inputValue(), draftA);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});
