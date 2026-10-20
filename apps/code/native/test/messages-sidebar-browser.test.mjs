// Read-only demo evidence for the shared PC/Kinso sidebar. No thread opens,
// read marks, drafts, sends, sign-in, live config, keys or provider transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture, readBody, PNG } from './fixtures/harness-page.mjs';
import { usageArtifacts } from './fixtures/usage-controls.mjs';
import { createDemoInbox } from '../../../../system/inbox-demo.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url))));
const shots = usageArtifacts('sidebar-dividers');
const origins = { pc: 'https://noah.imperfect.computer', kinso: 'https://computer.kinso.computer' };
const rows = page => page.locator('.messages-row').evaluateAll(nodes => nodes.map(n => n.dataset.key));
const allLink = page => page.locator('#session-rail .sidebar-row').filter({ has: page.getByText('All messages', { exact: true }) }).locator('button').first();
const capture = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.documentElement.matches('.turn, .session-turn'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(shots, `${name}.png`), caret: 'hide' });
};

// Compare resolved borders, not a literal .5px: Chromium may round a CSS
// half-pixel to a physical pixel at this fixture's device scale factor.
async function checkDividers(page, expected = ['Sessions', 'Files', 'Sites', 'Messages']) {
  const look = await page.locator('#session-rail').evaluate(rail => {
    const style = node => {
      const css = getComputedStyle(node), rect = node.getBoundingClientRect();
      return { border: css.borderTopStyle, thickness: css.borderTopWidth, color: css.borderTopColor,
        left: rect.left, width: rect.width, padding: css.padding, margin: css.margin, gap: css.gap };
    };
    return {
      phone: rail.parentElement.classList.contains('phone-layout'),
      usage: style(rail.querySelector('.session-rail-usage')),
      heads: [...rail.querySelectorAll('.session-rail-sidebar > .sidebar-head')].map(node => ({ name: node.textContent, ...style(node) })),
      rowBorders: [...rail.querySelectorAll('.session-rail-sidebar .session-rail-item, .session-rail-sidebar .session-rail-open, .sidebar-history')].map(node => getComputedStyle(node).borderTopWidth),
    };
  });
  assert.deepEqual(look.heads.map(head => head.name), expected);
  assert.equal(look.heads[0].thickness, '0px', 'no line above Sessions');
  const divided = look.heads.filter(head => parseFloat(head.thickness) > 0);
  assert.equal(divided.length, expected.length - 1, 'exactly one divider at each subsequent heading');
  assert.equal(look.usage.border, 'solid');
  assert.ok(parseFloat(look.usage.thickness) > 0);
  for (const head of divided) {
    for (const key of ['border', 'thickness', 'color', 'left', 'width']) assert.equal(head[key], look.usage[key], `${head.name}: ${key} matches Usage`);
    assert.equal(head.padding, look.phone ? '18px 14px 6px 20px' : '14px 14px 4px 20px', 'existing layout-specific heading padding stays unchanged');
    assert.equal(head.margin, '0px', 'no extra group margin');
    assert.equal(head.gap, '6px', 'existing heading gap stays unchanged');
  }
  assert.ok(look.rowBorders.every(width => width === '0px'), 'no per-row dividers');
  return look;
}

for (const [brand, productOrigin] of Object.entries(origins)) for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
  test(`${brand} ${viewport.width}: three matching group dividers, three newest, All messages and toggleable provider filters`, { timeout: 90000 }, async t => {
    await mkdir(shots, { recursive: true });
    const data = await createDemoInbox().list();
    const inboxRequests = [];
    const phone = viewport.width < 500;
    const f = await harnessFixture({ productOrigin, viewport, hasTouch: phone, desk: !phone, themeCSS,
      messages: [{ role: 'user', content: 'Show the demo inbox.' }, { role: 'assistant', content: 'These are invented conversations. Nothing is sent.' }],
      handleRequest: (req, res, path) => {
        const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return true; };
        if (path.startsWith('/inbox/')) {
          inboxRequests.push([req.method, req.url]);
          if (path === '/inbox/list' && req.method === 'GET') return json(data);
          res.statusCode = 403; return json({ error: 'Only the demo list is allowed in this test' });
        }
        if (path === '/files/list') return json({ path: '/fixture', home: '/fixture', entries: [] });
        return false;
      } });
    t.after(() => f.close());
    const p = f.page;
    await p.addStyleTag({ content: 'html body #entry-terminal { height:100vh !important; }' });
    if (phone) {
      await p.waitForFunction(() => matchMedia('(pointer: coarse)').matches && document.querySelector('#entry-terminal').classList.contains('phone-layout'));
      await p.evaluate(() => harness.toggleRail());
    }
    await allLink(p).waitFor();
    assert.deepEqual(await p.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites', 'Messages']);
    const messageNames = await p.locator('#session-rail .session-rail-sidebar').evaluate(list => {
      const head = [...list.children].find(n => n.textContent === 'Messages');
      const names = []; for (let n = head.nextElementSibling; n; n = n.nextElementSibling) names.push(n.querySelector('.session-rail-asked')?.textContent);
      return names;
    });
    assert.deepEqual(messageNames, [...data.conversations.slice(0, 3).map(c => c.name), 'All messages']);
    assert.deepEqual(messageNames.slice(0, 3), ['Ingrid Vasquez-Holm', 'Jun Takeda-Price', 'Tobias Ferreira-Lund']);
    assert.ok(await p.locator('#session-rail').evaluate(rail => {
      const list = rail.querySelector('.session-rail-list');
      return ['.session-rail-settings', '.session-rail-usage'].every(selector => Boolean(list.compareDocumentPosition(rail.querySelector(selector)) & Node.DOCUMENT_POSITION_FOLLOWING));
    }), 'Settings/Usage remain in the existing footer below Messages');
    assert.deepEqual(await p.locator('#session-rail > .session-rail-foot > *').evaluateAll(nodes => nodes.map(node => node.className)), ['session-rail-settings', 'usage-summary session-rail-usage']);
    assert.equal(await p.locator('html').getAttribute('data-brand'), brand === 'kinso' ? 'kinso' : 'imperfect');
    const dividers = await checkDividers(p);
    await writeFile(join(shots, `${brand}-${viewport.width}-computed.json`), JSON.stringify(dividers, null, 2));
    await capture(p, `${brand}-${viewport.width}-sidebar`);
    await allLink(p).click();
    await p.locator('.messages-row').first().waitFor();
    if (!phone) assert.equal(await p.locator('.messages').evaluate(n => n.closest('.wm-window').classList.contains('wm-in-panel')), true);
    const all = data.conversations.map(c => c.key);
    assert.deepEqual(await rows(p), all, 'All messages reaches every conversation, including those outside the sidebar');
    const chips = p.locator('.messages-chip');
    assert.deepEqual(await chips.allTextContents(), ['Gmail', 'LinkedIn', 'Instagram']);
    assert.equal(await chips.filter({ hasText: /^All$/ }).count(), 0);
    assert.equal(await p.locator('.messages-chip[aria-pressed="true"]').count(), 0, 'default inbox has no provider selected');
    await capture(p, `${brand}-${viewport.width}-panel`);
    for (const [label, source] of [['Gmail', 'gmail'], ['LinkedIn', 'linkedin'], ['Instagram', 'instagram']]) {
      await chips.filter({ hasText: label }).click();
      assert.deepEqual(await rows(p), data.conversations.filter(c => c.source === source).map(c => c.key));
      assert.equal(await p.locator('.messages-chip[aria-pressed="true"]').textContent(), label);
    }
    await chips.filter({ hasText: 'Instagram' }).click();
    assert.deepEqual(await rows(p), all, 'toggling selected provider clears it');
    assert.equal(await p.locator('.messages-chip[aria-pressed="true"]').count(), 0);
    await chips.filter({ hasText: 'Gmail' }).click();
    if (phone) await p.evaluate(() => harness.toggleRail());
    await allLink(p).click();
    assert.deepEqual(await rows(p), all, 'All messages also clears an existing provider filter');
    assert.ok(inboxRequests.length > 0 && inboxRequests.every(([method, path]) => method === 'GET' && path === '/inbox/list'), JSON.stringify(inboxRequests));
    assert.equal(f.commands.some(c => /^(auth_|prompt|messages_|tab-new)/.test(c.type)), false);
    assert.deepEqual(f.errors, []);
  });

  test(`${brand} ${viewport.width}: divider follows the Messages assembly gate and sidebar redraws`, { timeout: 90000 }, async t => {
    const data = await createDemoInbox().list(), inboxRequests = [];
    const f = await harnessFixture({ productOrigin, launchFrame: true, viewport, hasTouch: viewport.width < 500, themeCSS,
      launchOrigin: brand === 'kinso' ? 'https://kinso.computer' : 'https://imperfect.computer',
      messages: [{ role: 'assistant', content: 'Invented fixture only.' }],
      handleRequest: async (req, res, path) => {
        const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return true; };
        if (path.startsWith('/inbox/')) {
          inboxRequests.push([req.method, req.url]);
          if (path === '/inbox/list' && req.method === 'GET') return json(data);
          res.statusCode = 403; return json({ error: 'Demo list only' });
        }
        if (path === '/files/list') return json({ path: '/fixture', home: '/fixture', entries: [] });
        if (path === '/browser') {
          const request = await readBody(req);
          if (request.do === 'tabs') return json({ tabs: [{ tab: 1, title: 'Google fixture', url: 'https://www.google.com', front: true }] });
          if (request.do === 'front') return json({ tab: 1 });
          res.statusCode = 403; return json({ error: 'Fixture does not navigate' });
        }
        return false;
      },
      onBrowserLive: ws => ws.on('message', () => ws.send(JSON.stringify({ frame: PNG.toString('base64'), width: 1, height: 1, tab: 1 }))),
    });
    t.after(() => f.close());
    const p = f.product;
    const step = async beat => {
      await f.page.evaluate(({ beat, origin }) => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step: beat }, origin), { beat, origin: productOrigin });
      await f.page.waitForFunction(beat => messages.some(message => message.type === 'imperfect:assembled' && message.step === beat), beat);
      f.push({ ...f.tab });
      await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    for (const beat of ['bare', 'claude', 'codex', 'files', 'browser']) {
      await step(beat);
      assert.equal(await p.getByText('All messages', { exact: true }).count(), 0);
      assert.equal(await p.locator('.sidebar-head-title', { hasText: /^Messages$/ }).count(), 0);
      if (beat === 'files' || beat === 'browser') await checkDividers(p, ['Sessions', 'Files', 'Sites']);
    }
    for (const beat of ['messages', 'done']) {
      await step(beat);
      await p.getByText('All messages', { exact: true }).waitFor();
      await checkDividers(p);
      assert.deepEqual((await p.locator('#session-rail .session-rail-asked').allTextContents()).slice(-4), [...data.conversations.slice(0, 3).map(c => c.name), 'All messages']);
    }
    assert.ok(inboxRequests.length > 0 && inboxRequests.every(([method, path]) => method === 'GET' && path === '/inbox/list'));
    assert.equal(f.commands.some(c => /^(auth_|prompt|messages_|tab-(?:new|focus|open|close)|session-attach)/.test(c.type)), false);
    assert.deepEqual(f.errors, []);
  });
}
