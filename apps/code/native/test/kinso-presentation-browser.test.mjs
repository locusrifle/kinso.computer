// Invented, loopback-only presentation review. No inbox service or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { contrast, themeCss } from '../../../../system/theme.mjs';

const shots = process.env.KINSO_PRESENTATION_SHOTS;
const messages = [{ role: 'user', content: 'Plan a tiny garden.' }, { role: 'assistant', content: [{ type: 'text', text: 'Start with mint, basil, and a sunny window.' }] }];
const box = (page, selector) => page.locator(selector).first().evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const geometry = async page => Object.fromEntries(await Promise.all(['.entry-screen', '#entry-output', ...(await page.locator('.fresh-question').count() ? ['.fresh-question'] : []), '#entry-input-zone', '.entry-status'].map(async s => [s, await box(page, s)])));
const settle = page => page.evaluate(async () => { await document.fonts.ready; for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
async function fixture(t, phone, kinso = true, railReview = false) {
  const f = await harnessFixture({ viewport: phone ? { width: 390, height: 844 } : { width: 1920, height: 1080 }, hasTouch: phone, messages,
    answer: c => c.type === 'models' ? [{ provider: 'fixture', id: 'fixture', name: 'fixture', engine: 'pi', billing: 'fixture only' }]
      : c.type === 'sessions' ? Array.from({ length: 40 }, (_, i) => ({ id: `past-${i}`, name: `Invented past session ${i}`, modified: 1800000000000 - i * 1000 })) : undefined,
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
    // Use the real renderer's still-pose API, not painted imitation sharks.
    if (railReview) await page.route('**/js/sharks.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      import { swim as engine } from '/js/sharks.js?rail-review';
      export function swim(canvas, options) { return engine(canvas, { ...options, seed: 42, pose: [
        { species: 'hammerhead', x: 230, y: 150, length: 42, angle: 0.1 },
        { species: 'reef', x: 210, y: 340, length: 40, angle: -0.1 },
        { species: 'hammerhead', x: 210, y: 760, length: 42, angle: 0.1 }
      ] }); }
    ` }));
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
  await page.waitForSelector('#entry-terminal.choosing');
  await settle(page);
  const fresh = await geometry(page);
  assert.deepEqual(conversation, EXPECTED[name], 'conversation geometry is unchanged');
  assert.deepEqual(fresh, conversation, 'fresh has exactly the conversation geometry');
  assert.equal(await page.locator('.fresh-question').count(), 0);
  assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'what do you want?');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 1);
  const sea = await page.evaluate(() => {
    const canvas = document.querySelector('.kinso-sharks'), strip = document.querySelector('#entry-terminal');
    const c = canvas.getBoundingClientRect(), s = strip.getBoundingClientRect();
    const style = getComputedStyle(canvas), card = document.querySelector('.wm-panel-card');
    return { parent: canvas.parentElement.id, left: c.left, right: c.right, top: c.top, bottom: c.bottom, strip: { left: s.left, right: s.right, top: s.top, bottom: s.bottom }, z: style.zIndex, events: style.pointerEvents, isolation: getComputedStyle(document.querySelector('#entry-terminal')).isolation, cardFilter: card && getComputedStyle(card).backdropFilter };
  });
  assert.equal(sea.parent, 'entry-terminal');
  assert.equal(sea.z, '-1'); assert.equal(sea.events, 'none'); assert.equal(sea.isolation, 'isolate');
  assert.equal(await page.locator('.kinso-sharks').evaluate(n => getComputedStyle(n).transitionDuration), '0s');
  assert.deepEqual({ left: sea.left, right: sea.right, top: sea.top, bottom: sea.bottom }, sea.strip, 'sea fills the frame, not only the strip');
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
  await page.evaluate(() => {
    window.seaCanvas = document.querySelector('.kinso-sharks'); window.seaDraws = 0;
    const ctx = seaCanvas.getContext('2d'), fill = ctx.fillRect.bind(ctx);
    ctx.fillRect = (...args) => { seaDraws++; return fill(...args); };
  });
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
  const modelAnswer = f.answer;
  f.answer = c => {
    if (c.type === 'models') return modelAnswer(c);
    if (c.type === 'tab-new') {
      const tab = { id: 'fixture-new', sessionId: 'fixture-new', agent: 'pi', focused: true, prompt: '', name: 'new' };
      f.tab = { ...f.tab, sessionId: tab.sessionId, tabId: tab.id, messages: [], tabs: [tab] };
      return { snapshot: f.tab };
    }
    if (c.type === 'prompt') { f.push({ ...f.tab, messages: [{ role: 'user', content: c.text }, ...messages], tabs: f.tab.tabs.map(tab => ({ ...tab, prompt: c.text })) }); return { accepted: true }; }
  };
  await page.locator('#entry-input').fill('Invented first input');
  await page.keyboard.press('Enter');
  await page.locator('#entry-output .gui-assistant').waitFor();
  await settle(page);
  assert.equal(await page.locator('#entry-terminal.fresh-move').count(), 0);
  assert.deepEqual(await geometry(page), fresh, 'first input never moves the composer');
  assert.equal(await page.evaluate(() => document.querySelector('.kinso-sharks') === seaCanvas && getComputedStyle(seaCanvas).opacity === '1'), true);
  const draws = await page.evaluate(() => seaDraws);
  await page.waitForFunction(draws => seaDraws > draws, draws);
  const text = await page.locator('#entry-output .gui-assistant').evaluate(n => {
    const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hit: n.contains(hit), color: getComputedStyle(n).color };
  });
  assert.equal(text.hit, true, 'messages stay above the sea for selection');
  assert.equal(text.color, 'rgb(0, 0, 0)', 'words retain full black ink');
  assert.equal(f.commands.filter(c => c.type === 'prompt').length, 1);
  await shot(page, `${name}-after-first-input`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.querySelector('.kinso-sharks').dataset.palette === 'dark');
  const dark = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), terminal = document.querySelector('#entry-terminal');
    return { background: root.getPropertyValue('--theme-bg').trim(), ink: root.getPropertyValue('--theme-ink').trim(),
      muted: root.getPropertyValue('--theme-muted').trim(), panel: root.getPropertyValue('--theme-raised').trim(),
      frost: getComputedStyle(terminal, '::after').backgroundColor, sameSea: seaCanvas === document.querySelector('.kinso-sharks'),
      placeholder: getComputedStyle(document.querySelector('#entry-input'), '::placeholder').color };
  });
  assert.equal(dark.background, '#0e0e0f'); assert.equal(dark.ink, '#f3f1ed');
  for (const ink of [dark.ink, dark.muted]) for (const bg of [dark.background, dark.panel]) assert.ok(contrast(ink, bg) >= 4.5, `${ink} on ${bg}`);
  assert.equal(dark.placeholder, 'rgb(181, 176, 169)');
  assert.equal(dark.sameSea, true, 'Automatic does not restart the sea');
  assert.deepEqual(await geometry(page), fresh, 'appearance does not move the composer');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.querySelector('.kinso-sharks').dataset.palette === 'light');
  assert.equal(await page.locator('#entry-output .gui-assistant').evaluate(n => getComputedStyle(n).color), 'rgb(0, 0, 0)');
  await page.evaluate(() => harness.newTab());
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 1);
  assert.deepEqual(f.errors, []);
});

for (const phone of [false, true]) test(`Black imperfect is unchanged (${phone ? 'phone' : '1920'})`, async t => {
  const { page, errors } = await fixture(t, phone, false);
  await page.evaluate(() => harness.newTab()); await settle(page);
  assert.equal(await page.locator('.kinso-sharks, .kinso-veil').count(), 0);
  assert.equal(await page.locator('#session-rail').evaluate(n => getComputedStyle(n).backdropFilter), 'none');
  assert.equal(await page.locator('.fresh-question').textContent(), 'what do you want?');
  assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'Message');
  const actual = await geometry(page);
  const name = phone ? 'phone' : '1920';
  const radii = await page.locator('#entry-input-zone').evaluate(n => ({ input: getComputedStyle(n).borderTopLeftRadius, composer: getComputedStyle(document.querySelector('#entry-terminal'), '::after').borderTopLeftRadius }));
  assert.deepEqual({ actual, radii }, BLACK[name]);
  await shot(page, `${name}-black-unchanged`);
  assert.deepEqual(errors, []);
});
// Check actual composited pixels, not just the CSS colour over a flat ground.
async function railContrast(page) {
  const samples = await page.locator('#session-rail').evaluate(rail => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); canvas.width = canvas.height = 1;
    const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    return [...rail.querySelectorAll('.session-rail-asked, .sidebar-head-title, .sidebar-history > span, .sidebar-meta, .session-rail-settings, .usage-row-window, .usage-row-reset, .sidebar-unread, [data-state="blocked"] .session-rail-state')].flatMap(n => {
      const r = n.getBoundingClientRect(), s = getComputedStyle(n), dot = n.matches('.sidebar-unread, .session-rail-state');
      return r.width && r.height && r.y >= 0 && r.bottom <= innerHeight && s.visibility === 'visible'
        ? [{ text: dot ? 'unread dot' : n.textContent, x: r.x, y: r.y, width: r.width, height: r.height, ink: rgb(dot ? s.backgroundColor : s.color) }] : [];
    });
  });
  assert.ok(samples.length >= 8, 'rows, headings and footer are reviewed');
  const hide = await page.addStyleTag({ content: '#session-rail * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; } #session-rail svg { visibility: hidden !important; } #session-rail :is(.sidebar-unread, [data-state="blocked"] .session-rail-state) { background: transparent !important; }' });
  const png = (await page.screenshot()).toString('base64');
  await hide.evaluate(n => n.remove());
  const backgrounds = await page.evaluate(async ({ png, samples }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
    return samples.map(s => {
      const colors = new Set();
      const data = ctx.getImageData(Math.ceil(s.x), Math.ceil(s.y), Math.max(1, Math.floor(s.width) - 1), Math.max(1, Math.floor(s.height) - 1)).data;
      for (let i = 0; i < data.length; i += 4) colors.add([...data.slice(i, i + 3)].join(','));
      return [...colors].map(c => c.split(',').map(Number));
    });
  }, { png, samples });
  const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  return samples.map((s, i) => {
    const minimum = Math.min(...backgrounds[i].map(bg => contrast(hex(s.ink), hex(bg))));
    assert.ok(minimum >= 4.5, `${s.text}: ${minimum.toFixed(2)}:1 over rendered glass and shark`);
    return { text: s.text, minimum };
  });
}

for (const layout of ['desktop', 'narrow', 'phone']) for (const appearance of ['light', 'dark']) test(`Kinso rail shares glass and takes input over sharks (${layout}, ${appearance})`, { timeout: 90000 }, async t => {
  const phone = layout === 'phone', f = await fixture(t, phone, true, true), { page } = f;
  await page.setViewportSize(layout === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  const rail = page.locator('#session-rail');
  const unfold = async () => { if (await rail.evaluate(n => n.classList.contains('collapsed'))) await rail.locator('.session-rail-fold').click(); await settle(page); };
  await unfold();
  {
    await page.emulateMedia({ colorScheme: appearance });
    await page.waitForFunction(a => document.querySelector('.kinso-sharks')?.dataset.palette === a, appearance);
    await settle(page);
    await unfold();
    const material = await rail.evaluate(n => {
      const terminal = document.querySelector('#entry-terminal'), phone = terminal.classList.contains('phone-layout');
      const bar = getComputedStyle(phone ? document.querySelector('#entry-input-zone') : terminal, phone ? null : '::after');
      const r = n.getBoundingClientRect(), c = document.querySelector('.kinso-sharks'), sea = c.getBoundingClientRect(), veil = document.querySelector('.kinso-veil').getBoundingClientRect();
      const card = document.querySelector('.wm-panel-card'), cardStyle = card && getComputedStyle(card);
      const ctx = c.getContext('2d'), ground = ctx.getImageData(c.width - 1, c.height - 1, 1, 1).data;
      const pixels = ctx.getImageData(Math.max(0, r.x - sea.x), 80, Math.min(r.width, 248), 310).data;
      let sharkPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== ground[0] || pixels[i + 1] !== ground[1] || pixels[i + 2] !== ground[2]) sharkPixels++;
      return { railBg: getComputedStyle(n).backgroundColor, barBg: bar.backgroundColor, railFilter: getComputedStyle(n).backdropFilter, barFilter: bar.backdropFilter,
        railShadow: getComputedStyle(n).boxShadow, barShadow: bar.boxShadow, cardBg: cardStyle?.backgroundColor, cardFilter: cardStyle?.backdropFilter, cardShadow: cardStyle?.boxShadow, left: sea.left, right: sea.right, railLeft: r.left, railRight: r.right, veilLeft: veil.left, sharkPixels };
    });
    assert.equal(material.railBg, material.barBg); assert.equal(material.railFilter, material.barFilter);
    assert.equal(material.railFilter, 'blur(11px) saturate(1.05)');
    if (!phone) {
      assert.equal(material.railShadow, material.barShadow);
      assert.equal(material.cardBg, material.barBg); assert.equal(material.cardFilter, material.barFilter); assert.equal(material.cardShadow, material.barShadow);
    }
    assert.ok(material.left <= material.railLeft && material.right >= material.railRight, 'canvas spans the rail');
    if (layout === 'desktop') assert.ok(material.veilLeft > material.railLeft, 'conversation veil does not extend into the sidebar');
    // Sharks wander and steer round the bar, so wait for one to pass under the rail (anywhere along it), not one instant.
    await page.waitForFunction(() => {
      const r = document.querySelector('#session-rail').getBoundingClientRect(), c = document.querySelector('.kinso-sharks');
      const sea = c.getBoundingClientRect(), ctx = c.getContext('2d'), ground = ctx.getImageData(c.width - 1, c.height - 1, 1, 1).data;
      const x = Math.max(0, Math.round(r.x - sea.x)), w = Math.max(1, Math.min(Math.round(r.width), c.width - x));
      const pixels = ctx.getImageData(x, 0, w, c.height).data;
      let sharkPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== ground[0] || pixels[i + 1] !== ground[1] || pixels[i + 2] !== ground[2]) sharkPixels++;
      return sharkPixels > 100;
    }, null, { timeout: 30000, polling: 100 });
    // An invented unread site mark exercises the same small-dot rule as real sites.
    await rail.locator('.sidebar-row.dim .session-rail-open').first().evaluate(n => { const dot = document.createElement('span'); dot.className = 'sidebar-unread'; n.append(dot); });
    await rail.locator('.sidebar-row.dim .session-rail-open').nth(1).evaluate(n => { n.parentElement.dataset.state = 'blocked'; const dot = document.createElement('span'); dot.className = 'session-rail-state'; n.append(dot); });
    const normal = await railContrast(page);
    let hover = [];
    if (!phone) { await rail.locator('.sidebar-row.dim .session-rail-open').first().hover(); hover = await railContrast(page); await page.mouse.move(380, 820); }
    if (shots) { await mkdir(shots, { recursive: true }); await writeFile(join(shots, `${layout}-${appearance}-checks.json`), JSON.stringify({ material, normal, hover }, null, 2)); }
    await shot(page, `${layout}-${appearance}-glass-rail`);
    // Actual row handlers still run through the glass, not just hit tests.
    await rail.getByRole('button', { name: 'New session', exact: true }).click();
    await page.waitForSelector('#entry-terminal.choosing');
    await unfold();
    const history = rail.getByRole('button', { name: 'History', exact: true });
    await history.click(); assert.equal(await history.getAttribute('aria-expanded'), 'true');
    await rail.getByRole('button', { name: 'Invented past session 39', exact: false }).waitFor({ state: 'attached' });
    const list = rail.locator('.session-rail-list');
    await list.hover(); await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector('#session-rail .session-rail-list').scrollTop > 0);
    await history.click();
    await list.evaluate(n => { n.scrollTop = 0; });
    await rail.locator('.session-rail-fold').click(); await settle(page);
    if (phone) {
      assert.equal(await rail.evaluate(n => getComputedStyle(n).backdropFilter), material.barFilter, 'the phone strip is glass too');
      assert.equal(await rail.evaluate(n => getComputedStyle(n).backgroundColor), material.barBg);
      await shot(page, `${layout}-${appearance}-glass-strip`);
    } else {
      assert.equal(await rail.evaluate(n => getComputedStyle(n).backdropFilter), 'none', 'folded desktop has no glass surface');
      assert.equal(await rail.evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
    }
  }
  assert.deepEqual(f.errors, []);
});

for (const kinso of [true, false]) for (const layout of ['desktop', 'narrow', 'phone']) test(`${kinso ? 'Kinso' : 'imperfect'} Settings rail order, keyboard and panel (${layout})`, { timeout: 90000 }, async t => {
  const f = await fixture(t, layout === 'phone', kinso, kinso), { page } = f;
  await page.setViewportSize(layout === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  const rail = page.locator('#session-rail'), settings = rail.locator('.session-rail-settings');
  const unfold = async () => {
    if (await rail.evaluate(n => n.classList.contains('collapsed'))) await rail.locator('.session-rail-fold').click();
    await settle(page);
  };
  await unfold();
  await rail.getByRole('button', { name: 'All messages', exact: true }).waitFor();
  await settings.evaluate(n => { window.originalRailSettings = n; });
  for (const appearance of kinso ? ['light', 'dark'] : ['dark']) {
    await page.emulateMedia({ colorScheme: appearance });
    if (kinso) await page.waitForFunction(a => document.querySelector('.kinso-sharks')?.dataset.palette === a, appearance);
    await unfold();
    const all = rail.getByRole('button', { name: 'All messages', exact: true });
    const order = await settings.evaluate(n => {
      const rail = n.closest('#session-rail'), list = rail.querySelector('.session-rail-sidebar'), foot = rail.querySelector('.session-rail-foot');
      const buttons = [...rail.querySelectorAll('button')].filter(b => b.getClientRects().length && !b.disabled && getComputedStyle(b).visibility !== 'hidden');
      return { inList: list.contains(n), sectionLast: list.lastElementChild === n.parentElement,
        previous: n.parentElement.previousElementSibling?.textContent.trim(),
        footer: [...foot.children].map(n => n.className),
        lastButtons: buttons.slice(-3).map(b => b.className), same: n === originalRailSettings };
    });
    assert.equal(order.same, true, 'redraws keep the same Settings button');
    assert.equal(order.inList, kinso);
    if (kinso) {
      assert.equal(order.sectionLast, true);
      assert.equal(order.previous, 'All messages', 'Settings directly follows the last Messages row');
      assert.deepEqual(order.footer, ['usage-summary session-rail-usage']);
      const spacing = await settings.evaluate(n => {
        const section = getComputedStyle(n.parentElement), head = getComputedStyle(n.closest('.session-rail-sidebar').querySelector('.sidebar-head:not(:first-child)'));
        return { padding: section.paddingTop, expectedPadding: head.paddingTop, border: section.borderTop, expectedBorder: head.borderTop };
      });
      assert.equal(spacing.padding, spacing.expectedPadding); assert.equal(spacing.border, spacing.expectedBorder);
    } else {
      assert.deepEqual(order.footer, ['session-rail-settings', 'usage-summary session-rail-usage'], 'imperfect keeps Settings above Usage in the footer');
    }
    assert.deepEqual(order.lastButtons, ['session-rail-open', 'session-rail-settings', 'usage-summary session-rail-usage']);
    // Real Tab navigation, not CSS order or tabindex inspection alone.
    await all.focus(); await page.keyboard.press('Tab');
    assert.equal(await settings.evaluate(n => n === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await rail.locator('.session-rail-usage').evaluate(n => n === document.activeElement), true, 'Usage is the last rail action');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await settings.evaluate(n => n === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await all.evaluate(n => n === document.activeElement), true);
    await settings.scrollIntoViewIfNeeded();
    const positions = await Promise.all([all, settings, rail.locator('.session-rail-usage')].map(n => n.boundingBox()));
    assert.ok(positions[0].y + positions[0].height <= positions[1].y, 'Settings is visually after All messages');
    assert.ok(positions[1].y + positions[1].height <= positions[2].y, 'Usage remains below Settings at the foot');
    if (kinso) {
      await all.evaluate(n => n.blur());
      await shot(page, `${layout}-${appearance}-settings-rail`);
    }
    await settings.focus(); await page.keyboard.press('Enter');
    await page.locator('.settings-sheet').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.phone-layout') || Math.abs(document.querySelector('.wm-settings').getBoundingClientRect().x) < 1);
    // Phone aria follows the strip's scroll-settle callback, not its first frame.
    await page.waitForFunction(() => document.querySelector('.session-rail-settings')?.getAttribute('aria-expanded') === 'true');
    assert.equal(await settings.getAttribute('aria-expanded'), 'true');
    assert.equal(await settings.evaluate(n => n === originalRailSettings), true, 'opening Settings retains its button');
    await page.locator('.settings-done').click();
    await page.locator('.settings-sheet').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.session-rail-settings')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await settings.getAttribute('aria-expanded'), 'false');
    await unfold();
    await rail.locator('.session-rail-fold').click();
    await unfold();
    assert.equal(await settings.evaluate(n => n === originalRailSettings), true, 'folding retains its button and handler');
  }
  assert.deepEqual(f.errors, []);
});

const EXPECTED = {
  '1920': {
    '.entry-screen': { x: 248, y: 0, width: 1226, height: 1080 },
    '#entry-output': { x: 248, y: 0, width: 1226, height: 1080 },
    '#entry-input-zone': { x: 501, y: 1001, width: 720, height: 33 },
    '.entry-status': { x: 501, y: 1034, width: 720, height: 30 },
  },
  phone: {
    '.entry-screen': { x: 0, y: 0, width: 390, height: 760 },
    '#entry-output': { x: 0, y: 52, width: 390, height: 708 },
    '#entry-input-zone': { x: 10, y: 760, width: 370, height: 40 },
    '.entry-status': { x: 10, y: 800, width: 370, height: 36 },
  },
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
