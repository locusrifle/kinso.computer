import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedFixture, until, clickStream } from './fixtures/hosted-pages.mjs';

for (const width of [1200, 390]) test(`pinned Browser ${width}px: owner tabs, independent pin, real input, close/new/keys, header swap and restore`, { timeout: 90000 }, async t => {
  const f = await hostedFixture(t);
  const { page, json, ask, evaluate, root, seen } = f;
  await page.setViewportSize({ width, height: 900 });
  const dir = join(root, 'pinned'); await mkdir(dir);
  await writeFile(join(dir, 'index.html'), '<title>Pinned page</title><button id="mark" style="margin:20px;height:60px" onclick="document.title=\'Clicked chosen page\'">Mark this page</button>');
  const first = await json('/shown/view', { target: dir });
  const other = await ask({ do: 'open', url: `${first.url}?agent=1`, session: 'agent' });
  await evaluate(other.tab, 'document.title="Agent background"'); await ask({ do: 'front', tab: other.tab });
  // Use production pages + live chrome and the real authenticated owner
  // transport. Only WM layout is isolated, so at/reopen and viewer disposal
  // can be asserted directly without reaching into the harness's internals.
  await page.evaluate(async url => {
    const { mountPages } = await import('/js/pages.js');
    const host = document.createElement('div'); host.id = 'pinned-browser';
    host.style.cssText = 'position:fixed;inset:100px 0 80px;z-index:100;display:flex;flex-direction:column'; document.body.append(host);
    const output = document.createElement('div');
    let wins = [];
    window.pinnedWM = {
      list: () => wins, focused: () => wins[0],
      open(spec) { const win = { ...spec, el: spec.body }; wins.push(win); host.append(spec.body); return win; },
      close(win) { win.onClose(); win.el.remove(); wins = wins.filter(one => one !== win); },
      show() {}, reveal() {}, full() {},
    };
    window.pinnedPages = mountPages({ output, wm: pinnedWM }); pinnedPages.open(url);
  }, first.url);
  const browser = '#pinned-browser';
  const tabs = page.locator(`${browser} .browser-tab`);
  const selected = () => page.locator(`${browser} .browser-tab.front`);
  const selectedId = async () => Number(await selected().getAttribute('data-tab'));
  await tabs.nth(1).waitFor(); await page.locator(`${browser} .browser-live-frame[src]`).waitFor();
  assert.equal(await tabs.count(), 2); assert.equal(await selectedId(), first.tab);
  assert.equal(await page.locator(`${browser} .browser-tab-strip`).count(), 1);
  assert.equal(await page.locator(`${browser} .gui-window-address`).isVisible(), true);
  assert.equal(await page.locator(`${browser} .gui-window-bar`).first().evaluate(el => Math.round(el.getBoundingClientRect().height)), 72);
  const stream = seen.live.find(live => live.sent.some(said => said.do === 'watch' && said.scope === 'browser' && said.tab === first.tab));
  assert.ok(stream); assert.ok(stream.received.some(said => said.frame && said.tab === first.tab && said.watching === first.tab && said.scope === 'browser'));
  await ask({ do: 'front', tab: first.tab }); await ask({ do: 'front', tab: other.tab });
  const background = await ask({ do: 'open', url: `${first.url}?background=1`, session: 'background' });
  await until(async () => await tabs.count() === 3, 'agent-created tab enters scoped list');
  assert.equal(await selectedId(), first.tab, 'agent/portal fronts do not retarget this pin');
  await page.locator(`${browser} .browser-tab[data-tab="${other.tab}"]`).click();
  await until(async () => await selectedId() === other.tab, 'person retargets this panel');
  await until(() => stream.received.some(said => said.frame && said.tab === other.tab && said.watching === other.tab), 'retargeted frames');
  await clickStream(f, other.tab, '#mark', `${browser} .browser-live-frame`);
  await until(async () => await evaluate(other.tab, 'document.title') === 'Clicked chosen page', 'real scoped input reaches chosen page');
  assert.equal(await evaluate(first.tab, 'document.title'), 'Pinned page');
  const reShows = await page.evaluate(url => { pinnedPages.shown(url, ''); return pinnedPages.tabs()[0].live.tab; }, first.url);
  assert.equal(reShows, other.tab);
  await until(async () => await selectedId() === other.tab && await page.locator(`${browser} .gui-window-address`).inputValue() === `${first.url}?agent=1`, 'quiet re-show keeps chosen pin and location');
  await page.locator(`${browser} .browser-tab-item`).filter({ has: page.locator(`.browser-tab[data-tab="${background.tab}"]`) }).locator('.browser-tab-close').click();
  await until(async () => await tabs.count() === 2, 'background close'); assert.equal(await selectedId(), other.tab);
  // A fixed embedded preview gets no strip/start/pins or lifecycle.
  await page.evaluate(async tab => {
    const { mountLive } = await import('/js/live.js');
    window.embedded = mountLive({ tab }); embedded.body.style.height = '100%';
    const host = document.createElement('div'); host.id = 'embedded-proof'; host.style.cssText = 'position:fixed;right:0;top:0;width:100px;height:80px;z-index:101'; host.append(embedded.body); document.body.append(host);
  }, first.tab);
  await page.locator('#embedded-proof .browser-live-frame[src]').waitFor();
  assert.equal(await page.locator('#embedded-proof .browser-tab-strip,#embedded-proof .browser-start,#embedded-proof .browser-pin').count(), 0);
  await page.evaluate(() => { embedded.newTab(); embedded.closeFront(); });
  assert.equal((await ask({ do: 'tabs' })).tabs.length, 2);
  await page.evaluate(() => { embedded.stop(); document.querySelector('#embedded-proof').remove(); });
  await page.locator(`${browser} .gui-window-address`).focus(); await page.keyboard.press('Control+t');
  await until(async () => await tabs.count() === 3 && ![first.tab, other.tab].includes(await selectedId()), 'typing-body Ctrl+T opens and selects exactly one tab');
  await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).waitFor();
  await page.locator(`${browser} .browser-page.front .browser-start-pin`).first().focus(); await page.keyboard.press('Control+w');
  await until(async () => await tabs.count() === 2 && await selectedId() === other.tab, 'blank-body Ctrl+W returns to chosen neighbor');
  // Keep only the active chrome attached when moving between remote/native
  // preview holders. Reconnecting retains the chosen remote tab, not target.
  const connections = seen.live.length;
  await page.evaluate(() => pinnedPages.open('about:blank'));
  await page.locator(`${browser} iframe`).waitFor(); assert.equal(await page.locator(`${browser} .browser-tab-strip`).count(), 1);
  await page.evaluate(url => pinnedPages.open(url), first.url);
  await until(() => seen.live.slice(connections).some(live => live.sent.some(said => said.do === 'watch' && said.scope === 'browser' && said.tab === other.tab) && live.received.some(said => said.frame && said.tab === other.tab)), 'reconnected mutable pin');
  await until(async () => await selectedId() === other.tab, 'return to same mutable pin');
  const saved = await page.evaluate(() => pinnedPages.at(pinnedWM.list()[0]));
  assert.equal(saved[0].target, `${first.url}?agent=1`);
  assert.equal(saved[0].base, '');
  await page.locator(`${browser} .browser-new`).click();
  await until(async () => await tabs.count() === 3 && ![first.tab, other.tab].includes(await selectedId()), 'new tab retargets pin');
  await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).waitFor();
  const fresh = await selectedId(); assert.equal(await evaluate(fresh, 'location.href'), 'about:blank');
  assert.deepEqual(await page.locator(`${browser} .browser-page.front .browser-start-pin > span:last-child`).allTextContents(), ['Gmail', 'X', 'imperfect.computer', 'YouTube']);
  assert.equal(await page.locator(`${browser} .browser-page.front .browser-start`).count(), 1, 'no duplicate local overlay');
  const savedBlank = await page.evaluate(() => pinnedPages.at(pinnedWM.list()[0])[0]);
  assert.equal(savedBlank.target, 'about:blank'); assert.equal(savedBlank.tab, fresh);
  await page.evaluate(() => pinnedWM.close(pinnedWM.list()[0]));
  await page.evaluate(saved => pinnedPages.reopen(saved), savedBlank);
  await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).waitFor();
  assert.equal(await selectedId(), fresh, 'blank restore stays in the owner browser, not a local iframe');
  assert.equal(await page.locator(`${browser} iframe,${browser} webview`).count(), 0);
  // Start-page body focus, not just header focus, handles Ctrl+T/W once.
  await page.locator(`${browser} .browser-page.front .browser-start-pin`).first().focus(); await page.keyboard.press('Control+t');
  await until(async () => await tabs.count() === 4 && await selectedId() !== fresh, 'body Ctrl+T opens and selects one remote blank');
  const secondBlank = await selectedId(); assert.notEqual(secondBlank, fresh);
  await page.locator(`${browser} .browser-page.front .browser-start-pin`).first().focus(); await page.keyboard.press('Control+w');
  await until(async () => await tabs.count() === 3, 'body Ctrl+W closes one remote tab');
  const address = page.locator(`${browser} .gui-window-address`);
  await address.fill('about:blank'); await address.press('Enter');
  await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).waitFor();
  // closeOne targets remote tabs, never disposes the preview holder.
  await page.evaluate(() => pinnedWM.list()[0].closeOne());
  await until(async () => await tabs.count() === 2, 'WM closeOne closes selected owner tab');
  assert.equal(await page.locator(browser).count(), 1);
  const beforeClose = (await ask({ do: 'tabs' })).tabs.length;
  await page.evaluate(() => pinnedWM.close(pinnedWM.list()[0]));
  assert.equal((await ask({ do: 'tabs' })).tabs.length, beforeClose, 'window close only disposes viewers');
  await ask({ do: 'close', tab: first.tab });
  await rm(join(dir, 'index.html'));
  await page.evaluate(saved => pinnedPages.reopen([saved[0]]), saved);
  try { await page.locator(`${browser} .browser-live-frame[src]`).waitFor(); }
  catch (error) {
    const ui = await page.evaluate(() => ({ html: document.querySelector('#pinned-browser').innerHTML, tabs: pinnedPages.tabs().map(tab => ({ target: tab.target, url: tab.url, stale: tab.stale })) }));
    throw new Error(`${error.message}\nRestore diagnostics: ${JSON.stringify({ ui, owner: await ask({ do: 'tabs' }), live: seen.live.map(live => ({ sent: live.sent.filter(said => said.do), received: live.received.slice(-4) })) })}`);
  }
  await until(async () => await page.locator(`${browser} .gui-window-address`).inputValue() === `${first.url}?agent=1`, 'reopen restores chosen location');
  // Last owner tab leaves a usable +, not an expired fixed view.
  for (const tab of (await ask({ do: 'tabs' })).tabs) await ask({ do: 'close', tab: tab.tab });
  await until(async () => await tabs.count() === 0, 'empty scoped browser');
  assert.equal(await page.locator(`${browser} button`, { hasText: 'Retry preview' }).count(), 0);
  // An owner arrival does not silently select an empty panel's null pin.
  // Chrome-wide Ctrl+W has no page to close; a direct click still selects it.
  const arrival = await ask({ do: 'open', url: 'about:blank', session: 'background-arrival' });
  await until(async () => await tabs.count() === 1, 'background owner arrival in empty scoped list');
  assert.equal(await selected().count(), 0, 'no false selected tab for watching:null');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'false');
  assert.equal(await tabs.first().getAttribute('tabindex'), '0', 'an unselected tab remains keyboard reachable');
  await address.focus(); await page.keyboard.press('Control+w');
  await page.locator(`${browser} .gui-window-address`).focus(); await page.keyboard.press('Control+w');
  await page.waitForTimeout(150);
  assert.equal((await ask({ do: 'tabs' })).tabs.some(tab => tab.tab === arrival.tab), true, 'Ctrl+W outside the unselected tab does not close it');
  assert.equal(await selected().count(), 0);
  await tabs.first().click();
  await until(async () => await selectedId() === arrival.tab, 'explicit selection retargets the empty pin');
  await ask({ do: 'close', tab: arrival.tab });
  await until(async () => await tabs.count() === 0, 'empty after selected arrival closes');
  const emptyConnections = seen.live.length;
  await page.evaluate(() => pinnedPages.open('about:blank'));
  await page.evaluate(url => pinnedPages.open(url), saved[0].preview);
  await until(() => seen.live.slice(emptyConnections).some(live => live.sent.some(said => said.do === 'watch' && said.scope === 'browser' && said.tab === null) && live.received.some(said => said.scope === 'browser' && said.watching === null && said.tabs?.length === 0)), 'empty pin reconnects without expiry');
  await page.locator(`${browser} .browser-new`).click(); await tabs.first().waitFor();
  await page.locator(`${browser} .browser-page.front .browser-start:not([hidden])`).waitFor();
  assert.equal(await evaluate(await selectedId(), 'location.href'), 'about:blank');
  await page.evaluate(() => pinnedWM.close(pinnedWM.list()[0]));
  assert.deepEqual(f.pageErrors, []);
});
