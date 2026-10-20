import test from 'node:test';
import assert from 'node:assert/strict';
import { wifiPanelFixture } from './fixtures/wifi-panel.mjs';

const bounds = (p, selector) => p.locator(selector).evaluate(node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
});

// Window entrances transform their visual bounds. Observe the real animation
// finishing before comparing slots; do not disable motion or relax geometry.
async function settledWindow(p, selector = '.wm-system') {
  await p.waitForFunction(selector => {
    const win = document.querySelector(selector);
    return win && !win.getAnimations().some(a => a.playState === 'running');
  }, selector);
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function open(t, options = {}) {
  const f = await wifiPanelFixture(options);
  t.after(() => f.close());
  await f.page.locator('.system-status').click();
  await f.page.getByRole('heading', { name: 'Wi-Fi', exact: true }).waitFor();
  await settledWindow(f.page);
  if (options.width < 500) await f.page.waitForFunction(() => Math.abs(document.querySelector('.wm-system').getBoundingClientRect().x) < 1);
  return f;
}
const joined = (p, ssid) => p.getByRole('button', { name: `Join ${ssid}, secured network`, exact: true });
const finish = p => p.waitForFunction(() => document.querySelector('.system-line')?.hidden);

for (const [theme, width] of [['mac-light', 1200], ['mac-dark', 390]]) test(`${theme} ${width}: grouped Wi-Fi menu, accessible switches and safe network options`, async t => {
  const f = await open(t, { theme, width }); const p = f.page;
  const wifi = p.locator('.system-wifi');
  await p.waitForFunction(() => document.querySelector('.system-list')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.requests.filter(r => r.do === 'wifi-scan').length, 1, 'scan on open');
  assert.deepEqual(await wifi.locator('.system-network-heading').allTextContents(), ['Known networks', 'Other networks']);
  assert.deepEqual(await wifi.locator('.system-ssid').allTextContents(), ['Home Studio', 'Workshop', 'Library', 'Guest', 'Cafe', 'Campus', 'Garden']);
  assert.equal(await wifi.locator('.system-lock').count(), 6);
  assert.equal(await wifi.locator('.system-item.active .system-note').textContent(), 'Connected');
  assert.deepEqual(await wifi.locator('.system-name', { hasText: 'Garden' }).locator('svg').first().evaluate(n => [...n.children].map(n => n.getAttribute('opacity'))), [null, '0.3', '0.3', '0.3']);
  assert.equal(await wifi.getByRole('button', { name: 'Disconnect', exact: true }).count(), 0);
  assert.equal(await wifi.getByRole('button', { name: 'Forget This Network…', exact: true }).count(), 0);

  // Open networks and saved secured ones still join directly, no password.
  await wifi.getByRole('button', { name: 'Join Library, open network', exact: true }).click(); await finish(p);
  assert.deepEqual(f.requests.find(r => r.do === 'wifi-connect'), { do: 'wifi-connect', ssid: 'Library' });
  assert.equal(await wifi.locator('.system-password').count(), 0);
  await joined(p, 'Workshop').click(); await finish(p);
  assert.deepEqual(f.requests.filter(r => r.do === 'wifi-connect').at(-1), { do: 'wifi-connect', ssid: 'Workshop' });

  const options = wifi.getByRole('button', { name: 'Options for Workshop', exact: true });
  await options.focus(); await p.keyboard.press('Enter');
  assert.equal(await options.getAttribute('aria-expanded'), 'true');
  if (width < 500) assert.ok(await wifi.locator('.system-network-actions button').evaluateAll(nodes => nodes.every(n => n.offsetWidth >= 44 && n.offsetHeight >= 44)), 'touch-sized network actions');
  await wifi.getByRole('button', { name: 'Forget This Network…', exact: true }).click();
  assert.equal(f.requests.filter(r => r.do === 'wifi-forget').length, 0, 'revealing confirmation does not forget or join');
  assert.equal(await wifi.getByRole('button', { name: 'Cancel', exact: true }).evaluate(n => n === document.activeElement), true);
  await p.keyboard.press('Escape');
  assert.equal(await options.getAttribute('aria-expanded'), 'true');
  assert.equal(await options.evaluate(n => n === document.activeElement), true);
  await wifi.getByRole('button', { name: 'Disconnect', exact: true }).click(); await finish(p);
  assert.equal(f.requests.filter(r => r.do === 'wifi-disconnect').length, 1);
  if (width < 500) await options.tap(); else await options.click();
  await wifi.getByRole('button', { name: 'Forget This Network…', exact: true }).click();
  await wifi.getByRole('button', { name: 'Forget Workshop', exact: true }).click(); await finish(p);
  assert.deepEqual(f.requests.filter(r => r.do === 'wifi-forget'), [{ do: 'wifi-forget', ssid: 'Workshop' }]);
  assert.equal(await wifi.getByRole('button', { name: 'Options for Workshop', exact: true }).count(), 0);

  const radio = wifi.getByRole('switch');
  assert.equal(await radio.getAttribute('aria-checked'), 'true');
  await radio.focus(); await p.keyboard.press('Space'); await finish(p);
  assert.equal(await radio.getAttribute('aria-checked'), 'false');
  assert.equal(await radio.evaluate(n => n === document.activeElement), true, 'switch keeps keyboard focus after updating');
  assert.match(await wifi.textContent(), /Wi-Fi is off/);
  await p.keyboard.press('Enter'); await finish(p);
  assert.equal(await radio.getAttribute('aria-checked'), 'true');
  assert.deepEqual(f.requests.filter(r => r.do === 'wifi-radio').map(r => r.on), [false, true]);
  if (width < 500) {
    const sizes = await wifi.locator('button').evaluateAll(nodes => nodes.map(n => ({ label: n.getAttribute('aria-label'), w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height })));
    assert.ok(sizes.every(s => s.w >= 44 && s.h >= 44), JSON.stringify(sizes));
  }
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.system-status').evaluate(n => n === document.activeElement), true);
  await p.keyboard.press('Enter');
  // Opening fetches fresh state and starts a scan; sample the live node in
  // one task rather than an element handle detached by either repaint.
  await p.waitForFunction(() => document.querySelector('.system-wifi [role="switch"]') === document.activeElement);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/wifi-shared-${width}.png` });
  assert.deepEqual(f.errors, []);
});

for (const width of [1200, 390]) test(`${width}: inline password is private, cleared on send, paste forgotten; Escape returns to its network`, async t => {
  const f = await open(t, { width, theme: width < 500 ? 'mac-dark' : 'mac-light', holdScan: true, holdAction: 'wifi-connect' }); const p = f.page;
  await p.locator('.system-spinner').waitFor();
  await joined(p, 'Guest').click();
  // Password inputs intentionally have no implicit textbox role.
  const field = p.locator('.system-password');
  assert.equal(await field.getAttribute('type'), 'password');
  assert.equal(await field.getAttribute('autocomplete'), 'off');
  assert.equal(await joined(p, 'Guest').getAttribute('aria-expanded'), 'true');
  assert.equal(await joined(p, 'Guest').getAttribute('aria-controls'), await field.evaluate(n => n.closest('form').id));
  // A phone deliberately refuses programmatic text-field focus until the
  // field itself is touched; preserve that keyboard-opening policy.
  if (width < 500) await field.tap();
  assert.equal(await field.evaluate(n => n === document.activeElement), true);
  await p.keyboard.press('Escape');
  assert.equal(await joined(p, 'Guest').evaluate(n => n === document.activeElement), true);
  await p.keyboard.press('Enter');
  if (width < 500) await field.tap();
  await field.evaluate(n => {
    const data = new DataTransfer(); data.setData('text/plain', 'fixture secret');
    n.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    n.value = 'fixture secret';
  });
  await p.waitForFunction(() => document.querySelector('.system-password')?.value === 'fixture secret');
  f.releaseScan();
  await p.waitForFunction(() => document.querySelector('.system-list')?.getAttribute('aria-busy') === 'false');
  assert.equal(await field.inputValue(), 'fixture secret', 'finishing a scan never replaces a password being entered');
  assert.equal(await field.evaluate(n => n.closest('.system-network').querySelector('.system-ssid').textContent), 'Guest');
  if (width < 500) assert.ok(await p.locator('.system-join :is(input, button)').evaluateAll(nodes => nodes.every(n => n.offsetWidth >= 44 && n.offsetHeight >= 44)), 'touch-sized password and Join');
  await p.getByRole('button', { name: 'Join', exact: true }).click();
  await p.locator('.system-line').getByText('joining Guest…', { exact: true }).waitFor();
  assert.equal(await p.locator('.system-password').count(), 0, 'cleared before the request completes');
  const line = await p.locator('.system-line').boundingBox(), panel = await p.locator('.system-panel').boundingBox();
  assert.ok(line.y >= panel.y && line.y + line.height <= panel.y + panel.height, 'busy line stays visible in a scrolling panel');
  assert.equal(await joined(p, 'Guest').isDisabled(), true);
  f.releaseAction(); await finish(p);
  assert.deepEqual(f.clipboard, [{ do: 'forget', text: 'fixture secret' }]);
  assert.deepEqual(f.requests.filter(r => r.do === 'wifi-connect'), [{ do: 'wifi-connect', ssid: 'Guest', password: 'fixture secret' }]);
  assert.equal(await p.locator('.system-password').count(), 0);
  assert.equal(await p.locator('#entry-input').inputValue(), '');
  assert.equal(await p.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, text: document.body.innerText, inputs: [...document.querySelectorAll('input')].map(n => n.value) }).includes('fixture secret')), false);
  assert.deepEqual(f.errors, []);
});

test('scanning has a quiet refresh, live status, reduced motion and no permanent scan word button', async t => {
  const f = await open(t, { holdScan: true }); const p = f.page;
  const wifi = p.locator('.system-wifi');
  await wifi.getByRole('status').getByText('Scanning…').waitFor();
  assert.equal(await wifi.getByRole('button', { name: /^scan$/i }).count(), 0);
  assert.equal(await wifi.getByRole('button', { name: 'Refresh networks' }).isDisabled(), true);
  assert.equal(await wifi.locator('.system-list').getAttribute('aria-busy'), 'true');
  await p.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await wifi.locator('.system-spinner').evaluate(n => getComputedStyle(n).animationName), 'none');
  assert.equal(await wifi.locator('.system-switch-track').evaluate(n => getComputedStyle(n, '::after').transitionDuration), '0s');
  f.releaseScan();
  await p.waitForFunction(() => document.querySelector('.system-list')?.getAttribute('aria-busy') === 'false');
  await wifi.getByRole('button', { name: 'Refresh networks' }).click();
  await finish(p);
  assert.equal(f.requests.filter(r => r.do === 'wifi-scan').length, 2);
  assert.deepEqual(f.errors, []);
});

test('hardware off and empty radio explain the state without an actionable hardware switch', async t => {
  const off = await open(t, { hardware: false });
  const wifi = off.page.locator('.system-wifi');
  assert.equal(await wifi.getByRole('switch').getAttribute('aria-checked'), 'false');
  assert.equal(await wifi.getByRole('switch').isDisabled(), true);
  assert.match(await wifi.textContent(), /hardware switch/);
  assert.equal(off.requests.length, 0, 'no scan with hardware off');
  // Close before opening the next fixture: one test browser at a time.
  await off.close();
  const empty = await open(t, { empty: true });
  await empty.page.getByText('No networks found', { exact: true }).waitFor();
  assert.equal(await empty.page.locator('.system-network').count(), 0);
});

for (const width of [1200, 390]) test(`${width}: matching control modules keep mute, sliders, devices and power actions`, async t => {
  const f = await open(t, { width, modules: true }); const p = f.page;
  const panel = p.locator('.system-panel');
  const headings = await panel.locator('.system-head h2').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().left));
  assert.ok(headings.every(x => x === headings[0]), 'all section headings share Wi-Fi’s inset');
  const centers = await panel.locator('.system-wifi .system-signal svg, .system-sound .system-glyph-button svg, .system-screen .system-control-glyph svg, .system-battery .system-control-glyph svg').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; }));
  assert.ok(centers.every(x => Math.abs(x - centers[0]) < 1), 'all module glyphs share Wi-Fi’s icon column, including on touch');
  assert.equal(await panel.locator('.system-key, .system-value').count(), 0, 'no out/mic labels or numeric slider chrome');
  assert.match(await panel.locator('.system-battery-detail').textContent(), /82% · Plugged in/);
  await panel.getByRole('button', { name: 'Mute output', exact: true }).click(); await finish(p);
  assert.equal(await panel.getByRole('button', { name: 'Unmute output', exact: true }).getAttribute('aria-pressed'), 'true');
  await panel.getByRole('button', { name: 'Unmute microphone', exact: true }).click(); await finish(p);
  assert.equal(await panel.getByRole('button', { name: 'Mute microphone', exact: true }).getAttribute('aria-pressed'), 'false');
  for (const [label, value] of [['Output volume', '73'], ['Screen brightness', '81']]) {
    await panel.getByRole('slider', { name: label }).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    await finish(p);
    assert.equal(await panel.getByRole('slider', { name: label }).inputValue(), value);
    assert.ok(parseFloat(await panel.getByRole('slider', { name: label }).evaluate(n => n.style.getPropertyValue('--slider-fill'))) > 70);
  }
  await panel.getByRole('combobox', { name: 'Output device' }).selectOption('2'); await finish(p);
  assert.deepEqual(f.requests.find(r => r.do === 'sound-default'), { do: 'sound-default', target: 'output', id: 2 });
  for (const [name, action] of [['Studio Headphones', 'Disconnect'], ['Magic Keyboard', 'Connect'], ['Nearby Speaker', 'Pair'], ['Magic Keyboard', 'Remove']]) {
    await panel.getByRole('button', { name: `Options for ${name}`, exact: true }).click();
    assert.equal(await panel.getByRole('button', { name: `Options for ${name}`, exact: true }).getAttribute('aria-expanded'), 'true');
    await panel.locator('.system-bluetooth').getByRole('button', { name: action, exact: true }).click(); await finish(p);
  }
  assert.deepEqual(f.requests.filter(r => /^bluetooth-(connect|disconnect|pair|remove)$/.test(r.do)).map(r => r.do), ['bluetooth-disconnect', 'bluetooth-connect', 'bluetooth-pair', 'bluetooth-remove']);
  await panel.getByRole('button', { name: 'Restart…', exact: true }).click();
  assert.match(await panel.locator('.system-power-confirm').textContent(), /Restart now\?/);
  assert.equal(f.requests.filter(r => r.do === 'reboot').length, 0);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Lock Screen', exact: true }).click(); await finish(p);
  assert.equal(f.requests.filter(r => r.do === 'lock').length, 1);
  assert.deepEqual(f.requests.find(r => r.do === 'sound-volume'), { do: 'sound-volume', target: 'output', value: 0.73 });
  assert.deepEqual(f.requests.find(r => r.do === 'brightness'), { do: 'brightness', percent: 81 });
  if (width < 500) assert.ok(await panel.locator('.system-glyph-button, .system-power-choices button').evaluateAll(nodes => nodes.every(n => n.offsetHeight >= 44 && n.offsetWidth >= 44)));
  assert.deepEqual(f.errors, []);
});

test('enterprise and connection failures stay in the panel, never start the wrong join', async t => {
  const f = await open(t, { fail: 'wifi-connect' }); const p = f.page;
  await joined(p, 'Campus').click();
  await p.locator('.system-line.error').waitFor();
  assert.match(await p.locator('.system-line.error').textContent(), /needs a work or school login/);
  assert.equal(f.requests.filter(r => r.do === 'wifi-connect').length, 0);
  await joined(p, 'Workshop').click();
  await p.locator('.system-line.error').getByText(/connection could not be completed/).waitFor();
  assert.equal(await p.locator('[role="alert"], dialog[open]').count(), 0);
  assert.deepEqual(f.errors, []);
});

test('shared right panel replaces Files without moving or dismissing the conversation', async t => {
  const f = await wifiPanelFixture({ width: 1920, height: 1080, theme: 'black' });
  t.after(() => f.close());
  const p = f.page;
  const before = await bounds(p, '.entry-screen');
  const files = await bounds(p, '.wm-files');
  await p.locator('#entry-input').fill('Keep this conversation draft');
  await p.locator('.system-status').click();
  const panel = p.locator('.wm-system.wm-in-panel .system-panel-hosted');
  await panel.waitFor();
  await p.waitForFunction(() => document.querySelector('.system-list')?.getAttribute('aria-busy') === 'false');
  await settledWindow(p);
  assert.deepEqual(await bounds(p, '.wm-system'), files, 'same window slot as Files');
  assert.deepEqual(await bounds(p, '.entry-screen'), before, 'the conversation does not move');
  assert.equal(await panel.evaluate(n => getComputedStyle(n).position), 'relative');
  assert.equal(await panel.evaluate(n => getComputedStyle(n).borderRadius), '0px');
  assert.equal(await panel.evaluate(n => n.style.top), '', 'no stale popover positioning');
  await p.locator('#entry-input').click();
  await p.keyboard.press('Escape');
  assert.equal(await p.evaluate(() => systemPanelFixture.controls.isOpen()), true, 'outside clicks and Escape belong to the conversation');
  assert.equal(await p.locator('#entry-input').inputValue(), 'Keep this conversation draft');
  assert.equal(await p.locator('.system-status').getAttribute('aria-expanded'), 'true');
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/wifi-shared-desktop.png` });

  // Exercise the final production wiring with the other utility modes, not
  // only Wi-Fi and Files. A tucked window stays alive
  // but cannot own the keys or make the status click close instead of recall.
  await p.locator('.session-rail-settings').click();
  await p.locator('.wm-settings.wm-in-panel:not(.wm-tucked)').waitFor();
  assert.equal(await p.locator('.wm-system').evaluate(n => n.inert), true);
  await p.locator('.session-rail-usage').click();
  await p.locator('.wm-usage.wm-in-panel:not(.wm-tucked)').waitFor();
  assert.equal(await p.locator('.wm-settings').evaluate(n => n.inert), true);
  await p.locator('#entry-input').fill('Keep this conversation draft');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.wm-usage').isVisible(), true, 'conversation Escape does not dismiss Usage');
  await p.locator('.system-status').click();
  await panel.waitFor();
  assert.equal(await p.locator('.wm-usage').evaluate(n => n.inert), true);
  assert.equal(await p.locator('.wm-system').evaluate(n => n.inert), false);
  assert.deepEqual(await bounds(p, '.entry-screen'), before);

  await joined(p, 'Guest').click();
  await p.keyboard.type('unsent fixture password');
  await p.evaluate(() => systemPanelFixture.showFiles());
  assert.equal(await p.locator('.wm-files').isVisible(), true);
  await p.locator('.system-status').click();
  await panel.waitFor();
  assert.equal(await p.evaluate(() => systemPanelFixture.controls.isOpen()), true, 'status recalls controls when another shared window is in front');
  assert.equal(await p.locator('.system-password').count(), 0, 'recalling starts with no stale password');
  await joined(p, 'Guest').click();
  await p.keyboard.type('another unsent fixture password');
  await p.evaluate(() => systemPanelFixture.closeWindow());
  assert.equal(await p.evaluate(() => systemPanelFixture.controls.isOpen()), false);
  assert.equal(await p.locator('.system-password').count(), 0, 'host close discards a password');
  assert.equal(f.requests.filter(r => r.do === 'wifi-connect').length, 0);
  for (let i = 0; i < 2; i++) {
    await p.locator('.system-status').click();
    await panel.waitFor();
    assert.equal(await p.locator('.wm-system:not(.wm-closing)').count(), 1, 'reopening reuses the one controls body');
    await panel.focus();
    await p.keyboard.press('Escape');
    await p.locator('.system-panel').waitFor({ state: 'hidden' });
    assert.equal(await p.locator('.system-status').getAttribute('aria-expanded'), 'false');
  }
  assert.equal(await p.locator('#entry-input').inputValue(), 'Keep this conversation draft');
  assert.deepEqual(f.errors, []);
});

test('narrow shared panel scrolls within its window and survives resize; power still asks first', async t => {
  const f = await open(t, { width: 390, height: 844, modules: true, theme: 'black' });
  const p = f.page;
  const panel = p.locator('.wm-system .system-panel-hosted');
  const geometry = await panel.evaluate(n => ({ width: n.clientWidth, scroll: n.scrollHeight, height: n.clientHeight, host: n.parentElement.clientHeight }));
  assert.ok(geometry.width <= 390 && geometry.height <= geometry.host, JSON.stringify(geometry));
  assert.ok(geometry.scroll > geometry.height, 'long controls scroll instead of overflowing');
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/wifi-shared-phone.png` });
  await p.setViewportSize({ width: 1200, height: 900 });
  // A wider touch screen is still a phone/swipe layout: pointer, not width,
  // chooses it. Wait for the resize itself, not a desktop-only class.
  await p.waitForFunction(() => document.querySelector('.wm-system').offsetWidth === 1200);
  assert.equal(await p.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  assert.equal(await p.locator('.canvas-strip.wm-phone').count(), 1);
  assert.equal(await p.locator('.wm-system.wm-in-panel').count(), 0);
  assert.equal(await panel.evaluate(n => n.style.width), '', 'resize stays owned by the host');
  await p.evaluate(() => systemPanelFixture.controls.close());
  await p.evaluate(() => systemPanelFixture.controls.showPower());
  await panel.waitFor();
  assert.deepEqual(await panel.locator('.system-head h2').allTextContents(), ['Power']);
  await panel.getByRole('button', { name: 'Restart…', exact: true }).click();
  assert.equal(f.requests.filter(r => r.do === 'reboot').length, 0);
  // Explicitly focus the panel as the host's keyboard navigation does.
  await panel.focus();
  await p.keyboard.press('Escape');
  assert.equal(await panel.locator('.system-power-confirm').count(), 0);
  await p.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(f.errors, []);
});

test('a narrow desktop keeps the shared panel on resize, without moving its conversation or draft', async t => {
  const f = await open(t, { width: 700, height: 844, hasTouch: false, modules: true, theme: 'black' });
  const p = f.page;
  await p.locator('#entry-input').fill('Still in the middle');
  assert.equal(await p.locator('.wm-system.wm-in-panel:not(.wm-tucked)').count(), 1);
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.waitForFunction(() => document.querySelector('.wm-system').getBoundingClientRect().right === 1904);
  await settledWindow(p);
  const conversation = await bounds(p, '.entry-screen');
  const system = await bounds(p, '.wm-system');
  await p.evaluate(() => systemPanelFixture.showFiles());
  assert.deepEqual(await bounds(p, '.wm-files'), system, 'resized utilities use exactly the Files slot');
  assert.deepEqual(await bounds(p, '.entry-screen'), conversation);
  await p.locator('.system-status').click();
  assert.equal(await p.locator('.wm-system.wm-in-panel:not(.wm-tucked)').count(), 1);
  assert.equal(await p.locator('#entry-input').inputValue(), 'Still in the middle');
  assert.deepEqual(f.errors, []);
});

test('hosted/remote refusal cannot be opened through status or the power presenter', async t => {
  const f = await wifiPanelFixture({ refused: true }); t.after(() => f.close());
  const p = f.page;
  await p.waitForTimeout(100);
  assert.equal(await p.locator('.system-status').isVisible(), false);
  await p.evaluate(() => systemPanelFixture.controls.showPower());
  assert.equal(await p.locator('.system-panel').isVisible(), false);
  assert.equal(await p.locator('.wm-system').count(), 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.errors, []);
});
