import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedFixture, until } from './fixtures/hosted-pages.mjs';

for (const width of [1200, 390]) test(`real scoped ${width}px: repeated show preserves different/same-id navigation; hidden vanished/empty pins recover`, { timeout: 60000 }, async t => {
  const f = await hostedFixture(t), { page, json, ask, evaluate, root, seen } = f;
  await page.setViewportSize({ width, height: 900 });
  const dir = join(root, 'recovery'); await mkdir(dir);
  await writeFile(join(dir, 'index.html'), '<title>Original creation</title><h1>Original creation</h1>');
  const first = await json('/shown/view', { target: dir });
  const other = await ask({ do: 'open', url: `${first.url}?human=1`, session: 'human' });
  await page.evaluate(async url => {
    const { mountPages } = await import('/js/pages.js');
    const host = document.createElement('div'); host.id = 'recovery-browser';
    host.style.cssText = 'position:fixed;inset:100px 0 80px;z-index:100'; document.body.append(host);
    let wins = [];
    window.recoveryWM = {
      list: () => wins, focused: () => wins[0],
      open(spec) { const win = { ...spec, el: spec.body }; wins.push(win); host.append(spec.body); return win; },
      close(win) { win.onClose(); win.el.remove(); wins = wins.filter(one => one !== win); }, show() {}, reveal() {}, full() {},
    };
    window.recoveryPages = mountPages({ output: document.createElement('div'), wm: recoveryWM }); recoveryPages.open(url);
  }, first.url);
  const browser = '#recovery-browser', selected = page.locator(`${browser} .browser-tab.front`);
  const selectedId = async () => Number(await selected.getAttribute('data-tab'));
  await page.locator(`${browser} .browser-live-frame[src]`).waitFor();
  await page.locator(`${browser} .browser-tab[data-tab="${other.tab}"]`).click();
  await until(async () => await selectedId() === other.tab, 'human retarget');
  const view = await page.evaluate(() => { window.keptView = recoveryPages.tabs()[0].live; return recoveryPages.tabs().length; });
  assert.equal(view, 1);
  const connections = seen.live.length;
  const requests = seen.requests.filter(req => req.path === '/shown/view').length;
  await page.evaluate(url => recoveryPages.shown(url, ''), first.url);
  await until(() => seen.requests.filter(req => req.path === '/shown/view').length > requests, 'backend original refresh');
  await until(async () => !await page.evaluate(() => recoveryPages.tabs()[0].stale), 'refresh settled');
  assert.equal(await selectedId(), other.tab); assert.equal(seen.live.length, connections);
  assert.equal(await page.evaluate(() => recoveryPages.tabs()[0].live === keptView), true);
  // Reusing A's own id for a human site must not make re-show navigate it
  // back to A. Blank is a real remote navigation, no external network.
  await page.locator(`${browser} .browser-tab[data-tab="${first.tab}"]`).click();
  await until(async () => await selectedId() === first.tab, 'select original id');
  const address = page.locator(`${browser} .gui-window-address`);
  await address.fill('about:blank'); await address.press('Enter');
  await until(async () => await evaluate(first.tab, 'location.href') === 'about:blank', 'human reuses original id');
  await page.evaluate(url => recoveryPages.shown(url, ''), first.url);
  await until(async () => (await ask({ do: 'tabs' })).tabs.some(one => one.tab !== first.tab && one.tab !== other.tab && one.url === first.url), 'new original behind human reused page');
  await until(async () => !await page.evaluate(() => recoveryPages.tabs()[0].stale), 'same-id refresh settled');
  assert.equal(await selectedId(), first.tab); assert.equal(await evaluate(first.tab, 'location.href'), 'about:blank');
  assert.equal(seen.live.length, connections); assert.equal(await page.evaluate(() => recoveryPages.tabs()[0].live === keptView), true);
  assert.equal(await page.evaluate(url => recoveryPages.shown(url, '') === recoveryPages.tabs()[0], first.url), true, 'immutable target identity retained');
  await until(async () => !await page.evaluate(() => recoveryPages.tabs()[0].stale), 'repeated refresh settled');
  for (const tab of (await ask({ do: 'tabs' })).tabs) if (![first.tab, other.tab].includes(tab.tab)) await ask({ do: 'close', tab: tab.tab });
  // Hide/disconnect A, close it while B survives, then return through the
  // actual own-pane strip. Initial invalid pins remain separately failclosed.
  await page.evaluate(() => recoveryPages.open('about:blank'));
  await page.locator(`${browser} .browser-page.front iframe`).waitFor();
  await ask({ do: 'close', tab: first.tab });
  const hidden = seen.live.length;
  await page.locator(`${browser} .browser-tab`).first().click();
  await until(async () => await selectedId() === other.tab, 'vanished pin recovers to survivor');
  await until(() => seen.live.slice(hidden).some(ws => ws.sent.some(one => one.do === 'watch' && one.tab === first.tab && one.resume === true) && ws.received.some(one => one.scope === 'browser' && one.watching === other.tab && one.frame)), 'resume scope/frame proof');
  await ask({ do: 'close', tab: other.tab });
  await until(async () => await page.locator(`${browser} .browser-tab`).count() === 0, 'last closed stays valid empty');
  const emptySaved = await page.evaluate(() => recoveryPages.at(recoveryWM.list()[0])[0]);
  assert.equal(emptySaved.tab, null); assert.equal(emptySaved.stream, true);
  await page.evaluate(() => recoveryPages.open('about:blank'));
  const fresh = await ask({ do: 'open', url: 'about:blank', session: 'agent' });
  const emptyReconnects = seen.live.length;
  await page.locator(`${browser} .browser-tab`).first().click();
  await until(async () => await selectedId() === fresh.tab, 'empty disconnected pin recovers newly created owner tab');
  await until(() => seen.live.slice(emptyReconnects).some(ws => ws.sent.some(one => one.do === 'watch' && one.tab === null && one.resume === true) && ws.received.some(one => one.scope === 'browser' && one.watching === fresh.tab)), 'null reconnect proof');
  assert.equal(await evaluate(fresh.tab, 'location.href'), 'about:blank');
  assert.equal(await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Retry preview', exact: true }).count(), 0);
  assert.deepEqual(f.pageErrors, []);
});
