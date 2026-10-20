// Invented, loopback-only presentation review. No inbox service or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const shots = process.env.KINSO_PRESENTATION_SHOTS;
const messages = [{ role: 'user', content: 'Plan a tiny garden.' }, { role: 'assistant', content: [{ type: 'text', text: 'Start with mint, basil, and a sunny window.' }] }];
const box = (page, selector) => page.locator(selector).first().evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const geometry = async page => Object.fromEntries(await Promise.all(['.entry-screen', '#entry-output', '.fresh-question', '#entry-input-zone', '.entry-status'].map(async s => [s, await box(page, s)])));
const settle = page => page.evaluate(async () => { await document.fonts.ready; for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
async function fixture(t, phone, kinso = true) {
  const f = await harnessFixture({ viewport: phone ? { width: 390, height: 844 } : { width: 1920, height: 1080 }, hasTouch: phone, messages,
    themeCSS: themeCss({ id: 'black', name: 'Black', mode: 'dark', background: '#000000', foreground: '#eeeeee', accent: '#999999' }),
    // Route every request through loopback, and refuse all external networking.
    productOrigin: 'https://fixture.invalid',
    handleRequest: async (req, res, path) => {
      if (path === '/files/list') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: '/fixture', home: '/fixture', parent: '/', entries: [{ name: 'Garden notes', path: '/fixture/Garden notes', dir: true, size: 0, mtime: 1800000000000 }] })); return true;
      }
      if (path.startsWith('/inbox/')) {
        assert.ok(['/inbox/list', '/inbox/search'].includes(path), `no writes or readmarks: ${path}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ state: 'ready', canSend: false, canConnect: false, accounts: [], conversations: ['Garden club', 'Paper boat', 'Window herbs', 'Fourth fixture'].map((name, i) => ({ key: `chat:fixture:${i}`, kind: 'chat', source: 'whatsapp', account: 'fixture', name, preview: 'Invented review conversation', at: 1800000000000 - i * 1000 })) })); return true;
      }
      return false;
    } });
  t.after(() => f.close());
  const { page } = f;
  if (kinso) {
    await page.evaluate(() => sessionStorage.setItem('imperfect.for', 'kinso'));
    await page.reload();
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await page.locator('#entry-output .gui-assistant').waitFor();
  }
  await page.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
  await settle(page);
  if (phone) assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches && document.querySelector('#entry-terminal').classList.contains('phone-layout')), true);
  return f;
}
async function shot(page, name) { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`) }); } }

for (const phone of [false, true]) test(`Kinso rounded surfaces and sea behind intact panels (${phone ? 'phone' : '1920'})`, { timeout: 90000 }, async t => {
  const f = await fixture(t, phone); const { page } = f;
  const name = phone ? 'phone' : '1920';
  const conversation = await geometry(page);
  await page.evaluate(() => harness.newTab());
  await page.waitForSelector('#entry-terminal.fresh');
  await settle(page);
  const fresh = await geometry(page);
  // Fixed baselines captured from 2433785e with these same fonts/fixtures.
  const expected = EXPECTED[name];
  assert.deepEqual({ conversation, fresh }, expected, 'middle, question and composer geometry are exactly unchanged');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 1);
  const sea = await page.evaluate(() => {
    const canvas = document.querySelector('.kinso-sharks'), strip = document.querySelector('.canvas-strip');
    const c = canvas.getBoundingClientRect(), s = strip.getBoundingClientRect();
    const style = getComputedStyle(canvas), card = document.querySelector('.wm-panel-card');
    return { parent: canvas.parentElement.className, left: c.left, right: c.right, top: c.top, bottom: c.bottom, strip: { left: s.left, right: s.right, top: s.top, bottom: s.bottom }, z: style.zIndex, events: style.pointerEvents, isolation: getComputedStyle(document.querySelector('#entry-terminal')).isolation, cardFilter: card && getComputedStyle(card).backdropFilter };
  });
  assert.match(sea.parent, /canvas-strip/);
  assert.equal(sea.z, '-1'); assert.equal(sea.events, 'none'); assert.equal(sea.isolation, 'isolate');
  assert.equal(await page.locator('.kinso-sharks').evaluate(n => getComputedStyle(n).transitionDuration), '0.42s');
  assert.deepEqual({ left: sea.left, right: sea.right, top: sea.top, bottom: sea.bottom }, sea.strip, 'sea fills the strip, not only the middle');
  if (!phone) {
    const panel = await box(page, '.wm-files');
    assert.ok(sea.right >= panel.x + panel.width, 'canvas extends under the entire right panel');
    assert.match(sea.cardFilter, /blur\(11px\)/);
    assert.equal(await page.locator('.wm-files').evaluate(n => getComputedStyle(n).borderTopLeftRadius), '10px');
    assert.equal(await page.locator('.wm-panel-card').evaluate(n => getComputedStyle(n).borderTopLeftRadius), '10px');
    assert.equal(await page.locator('#entry-terminal').evaluate(n => getComputedStyle(n, '::after').borderTopLeftRadius), '14px');
  } else {
    assert.equal(await page.locator('.kinso-sharks').evaluate(n => getComputedStyle(n).scrollSnapAlign), 'none', 'background cannot become a swipe destination');
    assert.equal(await page.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).borderTopLeftRadius), '18px');
    assert.equal(await page.locator('.entry-status').evaluate(n => getComputedStyle(n).borderBottomLeftRadius), '18px');
    assert.equal(await page.locator('.canvas-strip').evaluate(n => n.scrollWidth), await page.locator('.canvas-strip > .wm-window').count() * 390, 'absolute canvas adds no swipe column');
  }
  await page.waitForTimeout(1800); // Let the shared renderer enter; no altered renderer or shader.
  const bitmap = await page.locator('.kinso-sharks').evaluate(n => ({ width: n.width, height: n.height, dpr: devicePixelRatio, lastPixelAlpha: n.getContext('2d').getImageData(n.width - 1, n.height - 1, 1, 1).data[3] }));
  assert.equal(bitmap.width, Math.round((sea.right - sea.left) * bitmap.dpr));
  assert.equal(bitmap.height, Math.round((sea.bottom - sea.top) * bitmap.dpr));
  assert.equal(bitmap.lastPixelAlpha, 255, 'the renderer really paints beyond the former middle edge');
  await shot(page, `${name}-fresh-files`);
  // The layer boundary must not trap a model picker below the shared composer.
  f.answer = c => c.type === 'models' ? ['Cedar', 'Maple', 'Willow', 'Oak'].map(name => ({ provider: 'fixture', id: `fixture-${name.toLowerCase()}`, name, engine: 'pi', billing: 'fixture only' })) : undefined;
  await page.locator('#entry-pi-label').click();
  await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'Cedar' }).waitFor();
  assert.ok(await page.locator('#entry-dialog .entry-dialog-option').evaluateAll(rows => rows.every(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })), 'picker rows remain above the composer and take input');
  await page.keyboard.press('Escape');
  await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
  // Actual native Messages content, with only invented list data. No thread reads.
  await page.evaluate(() => harness.showMessages({}));
  await page.locator('.messages-row').first().waitFor();
  if (phone) try { await page.waitForFunction(() => Math.abs(document.querySelector('.wm-messages').getBoundingClientRect().x) < 1); }
  catch (error) { console.log(await page.evaluate(() => ({ scroll: document.querySelector('.canvas-strip').scrollLeft, width: document.querySelector('.canvas-strip').scrollWidth, children: [...document.querySelector('.canvas-strip').children].map(n => ({ cls: n.className, x: n.getBoundingClientRect().x, width: n.getBoundingClientRect().width, offset: n.offsetLeft, position: getComputedStyle(n).position, snap: getComputedStyle(n).scrollSnapAlign })) }))); await shot(page, 'phone-diagnostic'); throw error; }
  await settle(page);
  if (!phone) assert.deepEqual(await geometry(page), fresh, 'opening the real panel does not move the middle');
  else assert.equal((await box(page, '#entry-input-zone')).y, conversation['#entry-input-zone'].y, 'shared phone composer stays at the foot, not over panel content');
  assert.deepEqual(await page.locator('.messages-row .messages-row-name').allTextContents(), ['Garden club', 'Paper boat', 'Window herbs', 'Fourth fixture']);
  const layers = await page.locator('.messages-row').first().evaluate(n => { const r = n.getBoundingClientRect(); return { hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), radius: getComputedStyle(n.closest('.wm-window')).borderTopLeftRadius }; });
  assert.equal(layers.hit, true, 'real content stays in front and takes pointer input');
  if (!phone) assert.equal(layers.radius, '10px');
  await shot(page, `${name}-fresh-messages`);
  // A new session returns to the middle on a phone; the first input goes only
  // to the in-memory fake transport, not to any provider.
  await page.evaluate(() => harness.newTab());
  if (phone) {
    await page.waitForFunction(() => Math.abs(document.querySelector('.entry-screen').getBoundingClientRect().x) < 1);
    assert.deepEqual(await geometry(page), fresh, 'returning home restores the exact original fresh geometry');
  }
  f.answer = c => {
    if (c.type === 'tab-new') {
      const tab = { id: 'fixture-new', sessionId: 'fixture-new', agent: 'pi', focused: true, prompt: '', name: 'new' };
      f.tab = { ...f.tab, sessionId: tab.sessionId, tabId: tab.id, messages: [], tabs: [tab] };
      return { snapshot: f.tab };
    }
    if (c.type === 'prompt') { f.push({ ...f.tab, messages: [{ role: 'user', content: c.text }], tabs: f.tab.tabs.map(tab => ({ ...tab, prompt: c.text })) }); return { accepted: true }; }
  };
  await page.locator('#entry-input').fill('Invented first input');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#entry-terminal.fresh-move:not(.fresh)');
  await page.waitForFunction(() => !document.querySelector('#entry-terminal.fresh-move') && Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 0);
  assert.ok((await box(page, '#entry-input-zone')).y > fresh['#entry-input-zone'].y + 100, 'first input moves the composer down');
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 1);
  await shot(page, `${name}-after-first-input`);
  await page.evaluate(() => harness.newTab());
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 1);
  assert.deepEqual(f.errors, []);
});

for (const phone of [false, true]) test(`Black imperfect is unchanged (${phone ? 'phone' : '1920'})`, async t => {
  const { page, errors } = await fixture(t, phone, false);
  await page.evaluate(() => harness.newTab()); await settle(page);
  assert.equal(await page.locator('.kinso-sharks, .kinso-veil').count(), 0);
  const actual = await geometry(page);
  const name = phone ? 'phone' : '1920';
  const radii = await page.locator('#entry-input-zone').evaluate(n => ({ input: getComputedStyle(n).borderTopLeftRadius, composer: getComputedStyle(document.querySelector('#entry-terminal'), '::after').borderTopLeftRadius }));
  assert.deepEqual({ actual, radii }, BLACK[name]);
  await shot(page, `${name}-black-unchanged`);
  assert.deepEqual(errors, []);
});
const EXPECTED = {
  "1920": {
    "conversation": {
      ".entry-screen": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      "#entry-output": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      ".fresh-question": {"x": 248, "y": 458.203125, "width": 1226, "height": 63.796875},
      "#entry-input-zone": {"x": 501, "y": 1001, "width": 720, "height": 33},
      ".entry-status": {"x": 501, "y": 1034, "width": 720, "height": 30}
    },
    "fresh": {
      ".entry-screen": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      "#entry-output": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      ".fresh-question": {"x": 248, "y": 479.203125, "width": 1226, "height": 63.796875},
      "#entry-input-zone": {"x": 552, "y": 561, "width": 618, "height": 50},
      ".entry-status": {"x": 552, "y": 611, "width": 618, "height": 38}
    }
  },
  "phone": {
    "conversation": {
      ".entry-screen": {"x": 0, "y": 0, "width": 390, "height": 760},
      "#entry-output": {"x": 0, "y": 52, "width": 390, "height": 708},
      ".fresh-question": {"x": 0, "y": 314.984375, "width": 390, "height": 47.015625},
      "#entry-input-zone": {"x": 10, "y": 760, "width": 370, "height": 40},
      ".entry-status": {"x": 10, "y": 800, "width": 370, "height": 36}
    },
    "fresh": {
      ".entry-screen": {"x": 0, "y": 0, "width": 390, "height": 760},
      "#entry-output": {"x": 0, "y": 52, "width": 390, "height": 708},
      ".fresh-question": {"x": 0, "y": 322.984375, "width": 390, "height": 47.015625},
      "#entry-input-zone": {"x": 10, "y": 388, "width": 370, "height": 40},
      ".entry-status": {"x": 10, "y": 428, "width": 370, "height": 36}
    }
  }
};
const BLACK = {
  "1920": {
    "actual": {
      ".entry-screen": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      "#entry-output": {"x": 248, "y": 0, "width": 1226, "height": 1080},
      ".fresh-question": {"x": 248, "y": 495.90625, "width": 1226, "height": 39.09375},
      "#entry-input-zone": {"x": 552, "y": 561, "width": 618, "height": 50},
      ".entry-status": {"x": 552, "y": 611, "width": 618, "height": 38}
    },
    "radii": {"input": "0px", "composer": "10px"}
  },
  "phone": {
    "actual": {
      ".entry-screen": {"x": 0, "y": 0, "width": 390, "height": 760},
      "#entry-output": {"x": 0, "y": 52, "width": 390, "height": 708},
      ".fresh-question": {"x": 0, "y": 322.90625, "width": 390, "height": 39.09375},
      "#entry-input-zone": {"x": 10, "y": 388, "width": 370, "height": 40},
      ".entry-status": {"x": 10, "y": 428, "width": 370, "height": 36}
    },
    "radii": {"input": "18px", "composer": "0px"}
  }
};
