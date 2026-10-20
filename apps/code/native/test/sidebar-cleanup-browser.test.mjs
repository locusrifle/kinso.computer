import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture, PNG } from './fixtures/harness-page.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const stills = process.env.SHOTS;
const themeFor = async theme => themeCss(JSON.parse(await readFile(new URL(theme.startsWith('mac-') ? `../themes/${theme}.json` : `./fixtures/themes/${theme}.json`, import.meta.url), 'utf8')));
const files = async (req, res, path) => {
  if (path !== '/files/list') return false;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: [] }));
  return true;
};
const shoot = async (page, name) => {
  if (!stills) return;
  await mkdir(stills, { recursive: true });
  await page.screenshot({ path: join(stills, `${name}.png`) });
};

for (const theme of ['black', 'light-chalk']) for (const width of [1200, 390]) test(`${theme} ${width}: sidebar rows match Home, with contiguous hover targets`, async t => {
  // Pin the touch pointer from the first frame: Electron's default fine
  // pointer can otherwise win a race with CDP touch-context initialization.
  const browser = await launchChromium({ args: ['--no-sandbox', '--disable-gpu', ...(width < 500
    ? ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'] : [])] });
  let f;
  t.after(async () => { try { await f?.close(); } finally { await browser.close(); } });
  const themeCSS = await themeFor(theme);
  f = await harnessFixture({ browser, desk: width === 1200, themeCSS, handleRequest: files, hasTouch: width < 500, viewport: { width, height: 900 },
    messages: [{ role: 'assistant', content: 'Ready.' }],
    snapshot: { tabs: [
      { id: 'tab-a', sessionId: 'thread-a', focused: true, agent: 'claude', prompt: 'i didnt know you could', status: 'working' },
      { id: 'tab-b', sessionId: 'thread-b', agent: 'pi', prompt: 'Claude ran out of usage; you can continue here', status: 'idle' },
    ] },
  });
  const p = f.page;
  p.setDefaultTimeout(8000);
  if (width < 500) await p.waitForFunction(() => matchMedia('(pointer: coarse)').matches && document.querySelector('#entry-terminal').classList.contains('phone-layout'));
  f.answer = c => c.type === 'sessions' ? [{ id: 'older-one', name: 'An earlier conversation' }, { id: 'older-two', name: 'Another earlier conversation' }] : undefined;
  if (await p.locator('#session-rail').evaluate(n => n.classList.contains('collapsed'))) await p.evaluate(() => harness.toggleRail());
  await p.locator('.sidebar-history').click();
  await p.locator('.sidebar-past .sidebar-row').nth(1).waitFor();
  const geometry = () => p.locator('.session-rail-sidebar').evaluate(list => {
    const controls = [...list.querySelectorAll('.session-rail-open, .sidebar-history')];
    return controls.map(control => {
      const r = control.getBoundingClientRect();
      return { text: control.textContent, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  });
  const before = await geometry();
  const home = before.find(row => row.text === 'Home');
  assert.equal(home.height, width < 500 ? 44 : 31);
  for (const row of before) {
    assert.equal(row.height, home.height, row.text);
    assert.equal(row.left, home.left, row.text);
    assert.equal(row.right, home.right, row.text);
  }
  // Section headings deliberately keep their breathing room. Inside Sessions,
  // History and Files there must be no sliver between adjacent row highlights.
  for (let i = 1; i < before.length; i++) {
    if (before[i].text === 'Home' || before[i].text === 'New page') continue;
    assert.equal(before[i].top, before[i - 1].bottom, `${before[i - 1].text} → ${before[i].text}`);
  }
  await p.locator('.session-rail-agents .session-rail-open').nth(1).hover();
  assert.deepEqual(await geometry(), before, 'hover never changes geometry');
  await p.locator('.session-rail-agents .session-rail-open').nth(1).focus();
  assert.deepEqual(await geometry(), before, 'keyboard focus never changes geometry');
  for (const control of await p.locator('.session-rail-sidebar .session-rail-open, .sidebar-history').all()) {
    await control.scrollIntoViewIfNeeded();
    assert.equal(await control.evaluate(n => {
      const r = n.getBoundingClientRect();
      return [r.top + 1, r.bottom - 1].every(y => n.contains(document.elementFromPoint(r.left + 3, y)));
    }), true, `${await control.textContent()}: the whole visible highlight is clickable`);
  }
  await p.locator('.sidebar-history').click();
  await p.locator('.session-rail-sidebar').evaluate(n => { n.scrollTop = 0; });
  await p.locator('.session-rail-agents .session-rail-open').nth(1).hover();
  await shoot(p, `sidebar-${theme}-${width}-hover`);
  assert.deepEqual(f.errors, []);
});

for (const theme of ['black', 'light-chalk', 'mac-dark']) test(`${theme}: one inline image token, no completed duplicate box; paste, retry and token removal survive`, async t => {
  const browser = await launchChromium({ args: ['--no-sandbox', '--disable-gpu'] });
  let f;
  t.after(async () => { try { await f?.close(); } finally { await browser.close(); } });
  const themeCSS = await themeFor(theme);
  f = await harnessFixture({ browser, desk: true, themeCSS, handleRequest: files, messages: [{ role: 'assistant', content: 'Ready.' }] });
  const p = f.page;
  p.setDefaultTimeout(8000);
  let attempts = 0;
  await p.route('**/upload', route => {
    attempts++;
    return attempts === 2 ? route.fulfill({ status: 503, body: 'fixture failure' })
      : route.fulfill({ json: { reference: { name: 'fixture-image', sessionId: 'thread-a' }, size: PNG.length } });
  });
  await p.locator('#entry-input').fill('Look at');
  await p.locator('#entry-files').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForFunction(() => document.querySelector('#entry-pending').hidden);
  assert.equal(attempts, 1);
  assert.equal(await p.locator('.entry-pending-chip').count(), 0);
  assert.equal(await p.locator('.entry-inline-attachment').textContent(), 'image 1');
  assert.equal(await p.locator('#entry-plus span').textContent(), '1');
  if (theme === 'mac-dark') assert.equal(await p.locator('.entry-inline-attachment').evaluate(n => getComputedStyle(n).color), 'rgb(10, 132, 255)');
  await p.locator('#entry-input').evaluate(n => n.blur());
  await shoot(p, `composer-${theme}-single-image-token`);
  await p.locator('#entry-input').focus();
  await p.locator('#entry-input').evaluate(n => n.setSelectionRange(n.value.length, n.value.length));
  await p.keyboard.press('Backspace');
  assert.equal((await p.locator('#entry-input').inputValue()).trim(), 'Look at');
  assert.equal(await p.locator('#entry-plus').getAttribute('aria-label'), 'attach');
  // A deliberate paste remains an image attachment, unlike a capture event.
  await p.locator('#entry-input').evaluate((n, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    n.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...PNG]);
  await p.getByRole('button', { name: 'retry pasted.png', exact: true }).click();
  await p.waitForFunction(() => document.querySelector('#entry-plus').getAttribute('aria-label') === 'pasted.png' && document.querySelector('#entry-pending').hidden);
  assert.equal(await p.locator('.entry-inline-attachment').textContent(), 'image 1');
  assert.equal(attempts, 3);
  assert.ok(!f.commands.some(c => ['prompt', 'queue-add'].includes(c.type)));
  assert.deepEqual(f.errors, []);
});
