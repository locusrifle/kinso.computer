// Invented read-only conversations in the production layout. Loopback only;
// no real inbox, draft, mark, provider or model transport is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { usageArtifacts } from './fixtures/usage-controls.mjs';
import { createDemoInbox } from '../../../../system/inbox-demo.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url))));
const shots = usageArtifacts('kinso-warm');
const allLink = p => p.locator('#session-rail .sidebar-row').filter({ has: p.getByText('All messages', { exact: true }) }).locator('button').first();
const rows = p => p.locator('.messages-row').evaluateAll(nodes => nodes.map(n => n.dataset.key));
const style = (p, selector, property) => p.locator(selector).first().evaluate((n, property) => getComputedStyle(n)[property], property);
const shot = async (p, name) => {
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  await p.screenshot({ path: join(shots, `${name}.png`), caret: 'hide' });
};
async function fitsAndHits(p) {
  await p.waitForTimeout(900);
  const result = await p.evaluate(() => {
    const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
    const wide = [...document.querySelectorAll('.messages, .messages-body, .messages-thread, .messages-scroll, .messages-list, .messages-composer')]
      .filter(visible).filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.className);
    const buttons = [...document.querySelectorAll('.messages :is(.messages-tool, .messages-chip, .messages-row, .messages-send)')]
      .filter(visible).filter(n => !n.disabled).map(n => {
        const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        // Only test targets within their scroll viewport, not off-screen rows.
        const list = n.closest('.messages-list'), lr = list?.getBoundingClientRect();
        const clipped = lr && (r.y < lr.y || r.bottom > lr.bottom);
        return { name: n.ariaLabel || n.textContent.slice(0, 40), width: r.width, height: r.height, hit: clipped || !!hit && (hit === n || n.contains(hit)) };
      });
    return { wide, buttons };
  });
  assert.deepEqual(result.wide, [], 'no content runs outside the panel');
  assert.ok(result.buttons.every(b => b.width >= 24 && b.height >= 24 && b.hit), JSON.stringify(result.buttons));
  return result;
}

for (const brand of ['kinso', 'imperfect']) for (const width of [1920, 390]) {
  test(`${brand} warm Messages ${width}: list, filters, read-only mail/chat and composer in real layout`, { timeout: 120000 }, async t => {
    await mkdir(shots, { recursive: true });
    const phone = width === 390, calls = [], box = createDemoInbox(), list = await box.list();
    const readonly = answer => ({ ...answer, canSend: false, canConnect: false });
    const f = await harnessFixture({ productOrigin: brand === 'kinso' ? 'https://computer.kinso.computer' : 'https://noah.imperfect.computer',
      desk: !phone, hasTouch: phone, viewport: { width, height: phone ? 844 : 1080 }, themeCSS,
      messages: [{ role: 'user', content: 'Review the invented Fernlight conversations.' }, { role: 'assistant', content: 'The demo inbox is open beside this conversation. Sending and connecting are off on this computer.' }],
      handleRequest: async (req, res, path) => {
        if (!path.startsWith('/inbox/')) return false;
        calls.push([req.method, req.url]);
        const query = new URL(req.url, 'http://fixture').searchParams;
        let data;
        if (req.method === 'GET' && path === '/inbox/list') data = readonly(list);
        // Deliberately never forward seen: opening cannot mark the fixture.
        else if (req.method === 'GET' && path === '/inbox/thread') data = readonly(await box.thread(query.get('key')));
        else if (req.method === 'GET' && path === '/inbox/search') data = readonly(await box.search(query.get('q')));
        else { res.statusCode = 403; data = { error: 'Read-only fixture' }; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return true;
      } });
    t.after(() => f.close());
    const p = f.page, name = `${brand}-${width}`;
    await p.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
    if (phone) { await p.waitForFunction(() => document.querySelector('#entry-terminal').classList.contains('phone-layout')); await p.evaluate(() => harness.toggleRail()); }
    await allLink(p).waitFor();
    assert.deepEqual(await p.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites', 'Messages']);
    const sidebarNames = await p.locator('#session-rail .session-rail-sidebar').evaluate(n => {
      const head = [...n.children].find(n => n.textContent === 'Messages');
      const out = []; for (let row = head.nextElementSibling; row; row = row.nextElementSibling) out.push(row.querySelector('.session-rail-asked')?.textContent);
      return out;
    });
    assert.deepEqual(sidebarNames, [...list.conversations.slice(0, 3).map(c => c.name), 'All messages']);
    await allLink(p).click();
    await p.locator('.messages-row').first().waitFor();
    assert.deepEqual(await rows(p), list.conversations.map(c => c.key));
    assert.deepEqual(await p.locator('.messages-chip').allTextContents(), ['Gmail', 'LinkedIn', 'Instagram']);
    assert.equal(await p.getByRole('button', { name: 'Connect an account' }).count(), 0);
    if (!phone) assert.equal(await p.locator('.messages').evaluate(n => n.closest('.wm-window').classList.contains('wm-in-panel')), true);
    const initial = await fitsAndHits(p);
    assert.equal(await p.getByRole('button', { name: /^(Done|Archive|Snooze)$/i }).count(), 0);
    if (brand === 'kinso') {
      assert.equal(await style(p, '.messages', 'backgroundColor'), 'rgb(255, 250, 246)');
      assert.equal(await style(p, '.messages-row', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.equal(await style(p, '.messages-row', 'borderRadius'), '12px');
      assert.equal(await style(p, '.messages-row-time', 'color'), 'rgb(115, 115, 115)');
      const contrast = await p.evaluate(() => {
        const luminance = value => {
          const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return channels.reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        };
        const row = document.querySelector('.messages-row'), time = row.querySelector('.messages-row-time');
        const badge = getComputedStyle(document.querySelector('.messages-demo-tag'));
        return {
          row: (luminance(getComputedStyle(row).backgroundColor) + .05) / (luminance(getComputedStyle(time).color) + .05),
          badge: (luminance(badge.backgroundColor) + .05) / (luminance(badge.color) + .05),
        };
      });
      assert.ok(contrast.row >= 4.5, `muted card labels meet AA: ${contrast.row}`);
      assert.ok(contrast.badge >= 4.5, `demo badge meets AA: ${contrast.badge}`);
      assert.match(await style(p, '.messages', 'fontFamily'), /Kinso Inter/);
      assert.equal(await p.evaluate(() => document.fonts.check('400 13px "Kinso Inter"')), true);
      if (phone) assert.ok(initial.buttons.every(b => b.height >= 40), 'thumb targets');
    } else {
      assert.equal(await style(p, '.messages-row', 'borderRadius'), '0px');
      assert.notEqual(await style(p, '.messages-row', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.doesNotMatch(await style(p, '.messages', 'fontFamily'), /Kinso/);
      assert.equal(await p.locator('.kinso-sharks').count(), 0);
    }
    await shot(p, `${name}-list`);
    const gmail = p.locator('.messages-chip').filter({ hasText: 'Gmail' });
    await gmail.click();
    assert.deepEqual(await rows(p), list.conversations.filter(c => c.source === 'gmail').map(c => c.key));
    await gmail.focus(); await p.keyboard.press('Space');
    assert.deepEqual(await rows(p), list.conversations.map(c => c.key), 'keyboard toggles active provider off');
    await gmail.click();
    if (phone) await p.evaluate(() => harness.toggleRail());
    await allLink(p).click();
    assert.equal(await p.locator('.messages-chip[aria-pressed="true"]').count(), 0, 'All messages clears selected source');
    await p.locator('.messages-search input').fill('seed round');
    await p.waitForFunction(() => document.querySelectorAll('.messages-row').length === 1);
    await p.locator('.messages-search input').fill('');
    await p.waitForFunction(n => document.querySelectorAll('.messages-row').length === n, list.conversations.length);
    const mail = list.conversations.find(c => c.kind === 'mail');
    await p.locator(`.messages-row[data-key="${mail.key}"]`).click();
    await p.locator('.messages-letter').first().waitFor();
    assert.match(await p.locator('.messages-reply-to').textContent(), /sending is off|nothing is sent/i);
    assert.equal(await p.locator('.messages-send').isDisabled(), true);
    assert.equal(await p.locator('.messages-field').inputValue(), '');
    if (brand === 'kinso') {
      assert.equal(await style(p, '.messages-letter', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.equal(await style(p, '.messages-letter', 'borderRadius'), '12px');
      assert.equal(await style(p, '.messages-send', 'backgroundColor'), 'rgb(0, 0, 0)');
      assert.equal(await style(p, '.messages-field', 'backgroundColor'), 'rgb(255, 255, 255)');
    }
    await fitsAndHits(p);
    await p.locator('.messages-field').focus();
    assert.equal(await p.locator('.messages-field').evaluate(n => document.activeElement === n), true);
    if (brand === 'kinso') assert.equal(await style(p, '.messages-field', 'boxShadow'), 'rgb(0, 0, 0) 0px 0px 0px 1px');
    await shot(p, `${name}-mail-composer`);
    if (await p.locator('.messages-back').isVisible()) await p.locator('.messages-back').click();
    const chat = list.conversations.find(c => c.kind === 'chat');
    await p.locator(`.messages-row[data-key="${chat.key}"]`).click();
    await p.locator('.messages-bubble').first().waitFor();
    assert.equal(await p.locator('.messages-send').isDisabled(), true);
    await fitsAndHits(p); await shot(p, `${name}-chat-composer`);
    if (brand === 'kinso') {
      // A fresh session keeps Noah’s chosen pale grid renderer, including its quiet
      // reduced-motion still. Do not send a prompt or change panel geometry.
      await p.emulateMedia({ reducedMotion: 'reduce' });
      await p.evaluate(() => harness.newTab());
      await p.waitForSelector('#entry-terminal.fresh');
      await p.waitForFunction(() => document.querySelector('.kinso-sharks')?.width > 0);
      const palette = await p.evaluate(() => {
        const c = document.querySelector('.kinso-sharks'), ctx = c.getContext('2d'), counts = new Map();
        for (let y = 3; y < c.height; y += 17) for (let x = 3; x < c.width; x += 17) {
          const px = [...ctx.getImageData(x, y, 1, 1).data].join(','); counts.set(px, (counts.get(px) || 0) + 1);
        }
        return [...counts].sort((a,b) => b[1] - a[1])[0][0];
      });
      assert.equal(palette, '252,252,251,255', 'opaque light canvas ground, not a CSS-only colour illusion');
      await shot(p, `${name}-fresh-still`);
    }
    assert.ok(calls.every(([method, path]) => method === 'GET' && /^\/inbox\/(list|thread|search)(\?|$)/.test(path)), JSON.stringify(calls));
    assert.equal(f.commands.some(c => /^(auth_|prompt|messages_|tab-new)/.test(c.type)), false);
    assert.deepEqual(f.errors, []);
    await writeFile(join(shots, `${name}-checks.json`), JSON.stringify({ initial, calls, faults: f.errors, readonly: true }, null, 2));
  });
}
