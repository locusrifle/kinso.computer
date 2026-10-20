import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { createSystemControls } from '../../../../system/controls.mjs';
import { recordedComputer } from '../../test/fixtures/system/computer.mjs';

// The real page and the real controls (system/controls.mjs) over recorded
// tool output; only the owner check is the fixture's, since this is not the
// real server (apps/code/test/system-controls.test.mjs checks that one).
async function page(t, { computer = 'laptop', theme = 'black', width = 1536, refused = false, missing = [], fail, layout = null } = {}) {
  const themeCSS = themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${theme}.json`, import.meta.url), 'utf8')));
  const machine = recordedComputer(computer, { missing, fail });
  const handle = createSystemControls({ run: machine.run, lockState: async name => name === 'locked', refuse: async () => (refused ? 'only on this computer\'s own screen' : '') });
  const asked = [];
  const f = await harnessFixture({
    site: true, themeCSS, viewport: { width, height: 900 }, hasTouch: width < 500, layout,
    messages: [{ role: 'assistant', content: 'Ready.' }],
    handleRequest: async (req, res, path) => {
      if (path === '/files/list') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: '/home/noah', home: '/home/noah', entries: [] })); return true; }
      if (path === '/system') asked.push(req.method);
      return handle(req, res, path);
    },
  });
  const close = f.close;
  let closed = false;
  f.close = async () => { if (closed) return; closed = true; await close(); };
  t.after(() => f.close());
  return { ...f, machine, asked };
}
const box = (p, selector) => p.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });

// A real phone hides local hardware. The synthetic Wi-Fi menu fixture checks
// narrow/touch rendering separately, without changing that access policy.
for (const theme of ['black', 'light-chalk']) for (const width of [1536, 1200]) test(`${theme} ${width}: Wi-Fi and battery beside the time at the conversation's centre, the panel under the band`, async t => {
  const f = await page(t, { theme, width });
  const p = f.page;
  const status = p.locator('.screen-status .system-status');
  await status.waitFor({ state: 'visible' });
  const [clock, glance, group, heading] = await Promise.all([box(p, '.screen-clock'), box(p, '.system-status'), box(p, '.screen-status'), box(p, '.session-rail-heading')]);
  assert.ok(Math.abs((clock.top + clock.bottom) / 2 - (glance.top + glance.bottom) / 2) < 1, 'same line as the clock');
  assert.ok(glance.left >= clock.right, 'right of the clock, not over it');
  const middle = await p.evaluate(() => {
    const frame = document.getElementById('entry-terminal'), style = getComputedStyle(frame);
    const rail = parseFloat(style.getPropertyValue('--focus-rail-w')) || 0, panel = parseFloat(style.getPropertyValue('--focus-panel-column')) || 0;
    return rail + (frame.getBoundingClientRect().width - rail - panel) / 2;
  });
  assert.ok(Math.abs((group.left + group.right) / 2 - middle) < 1.5, `the group at the focus middle's centre ${JSON.stringify(group)}`);
  assert.ok(glance.top >= 0 && glance.bottom <= heading.bottom, 'within the top band');
  assert.equal(await p.locator('.system-status .system-network').count(), 0, 'Wi-Fi is its icon alone, the name in the title');
  assert.match(await status.getAttribute('title'), /Wi-Fi: /);
  assert.match(await status.textContent(), /17%/);
  const red = await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--theme-red').trim());
  const low = await p.locator('.system-status .system-battery.low').evaluate(node => getComputedStyle(node).color);
  assert.notEqual(low, await status.evaluate(node => getComputedStyle(node).color), `a battery about to die is ${red}, not the text colour`);
  await status.click();
  const panel = p.locator('.system-panel');
  await panel.locator('.system-wifi .system-item').first().waitFor();
  assert.deepEqual(await panel.locator('.system-head h2').allTextContents(), ['Wi-Fi', 'Bluetooth', 'Sound', 'Display', 'Battery', 'Power']);
  const opened = await box(p, '.system-panel');
  const band = await box(p, '.session-rail-heading');
  assert.equal(opened.top, Math.round(band.bottom), 'no gap under the band');
  assert.equal(opened.width, 380);
  assert.ok(Math.abs((opened.left + opened.right) / 2 - (group.left + group.right) / 2) < 1.5, `centred under the group ${JSON.stringify({ opened, group })}`);
  assert.equal(await panel.evaluate(node => getComputedStyle(node).borderBottomLeftRadius), '14px', 'the shared Mac panel shape');
  assert.equal(await panel.getByRole('switch', { name: 'Turn Wi-Fi off' }).getAttribute('aria-checked'), 'true');
  await p.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  // The time is as much the way in as the glance.
  await p.locator('.screen-clock').click();
  await panel.waitFor();
  await p.locator('.screen-clock').click();
  await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(f.errors, []);
});

// Neither the glance nor its panel follow a column: with Files turned to the
// left and the conversation running off the window's right edge, both stay
// at the screen's centre.
test('columns turned and moved, the glance and its panel stay at the screen\'s centre', async t => {
  const f = await page(t, { width: 1200, layout: 'scrolling' });
  const p = f.page;
  await p.locator('.wm-files').waitFor();
  await p.locator('.system-status').waitFor({ state: 'visible' });
  await p.keyboard.press('Alt+Shift+ArrowRight');
  await p.waitForFunction(() => !document.querySelector('.wm-moving'));
  const g = await p.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { pane: rect(document.querySelector('.entry-screen')), view: rect(document.querySelector('#canvas-strip')), group: rect(document.querySelector('.screen-status')), rail: rect(document.querySelector('#session-rail')) };
  });
  assert.ok(g.pane.left > g.view.left + 100 && g.rail.right > g.view.right + 40, `the conversation and its band run off the right: ${JSON.stringify(g)}`);
  assert.ok(Math.abs((g.group.left + g.group.right) / 2 - 600) < 1.5, `the window's centre: ${JSON.stringify(g)}`);
  await p.locator('.system-status').click();
  const panel = p.locator('.system-panel');
  await panel.locator('.system-wifi .system-item').first().waitFor();
  const opened = await box(p, '.system-panel');
  assert.ok(Math.abs((opened.left + opened.right) / 2 - 600) < 1.5, `the panel under the group: ${JSON.stringify({ opened, g })}`);
  assert.deepEqual(f.errors, []);
});

test('joining a locked network: the password goes to the computer and nowhere else on the page', async t => {
  const f = await page(t);
  const p = f.page;
  await p.locator('.system-status').click();
  await p.locator('.system-panel .system-name', { hasText: 'Neighbour0895C8' }).click();
  const field = p.locator('.system-panel .system-password');
  await field.waitFor();
  assert.equal(await field.evaluate(node => document.activeElement === node), true, 'the field has the keys');
  assert.equal(await field.getAttribute('type'), 'password');
  assert.equal(await field.getAttribute('autocomplete'), 'off');
  const secret = 'Sw0rdfish under the sea';
  await p.keyboard.type(secret);
  assert.equal(await p.locator('#entry-input').inputValue(), '', 'not a letter in the input bar');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => !document.querySelector('.system-panel .system-line')?.textContent.includes('joining'));
  const connect = f.machine.ran.find(r => r.args.includes('connect'));
  assert.equal(connect.input, `${secret}\n`);
  assert.ok(!connect.args.join(' ').includes('Sw0rdfish'));
  const left = await p.evaluate(text => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, input: document.querySelector('#entry-input').value, page: document.body.innerText, fields: [...document.querySelectorAll('input')].map(i => i.value) }).includes(text), 'Sw0rdfish');
  assert.equal(left, false, 'not kept in storage, the input bar or any field');
  assert.deepEqual(f.errors, []);
});

test('restart, shut down and sleep ask first, in place; lock does not', async t => {
  const f = await page(t);
  const p = f.page;
  await p.locator('.system-status').click();
  const power = p.locator('.system-panel .system-power');
  await power.locator('button', { hasText: 'Shut Down…' }).click();
  assert.match(await power.textContent(), /Shut Down now\?/);
  assert.equal(f.machine.changes().filter(r => r.command === 'systemctl').length, 0, 'nothing yet');
  await power.locator('button', { hasText: 'Cancel' }).click();
  await power.locator('button', { hasText: 'Restart…' }).click();
  await power.locator('.system-danger').click();
  await p.waitForFunction(() => !document.querySelector('.system-panel .system-line')?.textContent.includes('restart'));
  await power.getByRole('button', { name: 'Sleep', exact: true }).click();
  assert.match(await power.textContent(), /Sleep now\?/);
  assert.equal(f.machine.changes().filter(r => r.command === 'systemctl').length, 1);
  await power.locator('.system-danger').click();
  await p.waitForFunction(() => !document.querySelector('.system-panel .system-line')?.textContent.includes('sleep'));
  await power.getByRole('button', { name: 'Lock Screen', exact: true }).click();
  await p.waitForFunction(() => !document.querySelector('.system-panel .system-line')?.textContent.includes('lock'));
  assert.deepEqual(f.machine.changes().filter(r => r.command === 'loginctl').map(r => r.args), [['lock-sessions'], ['lock-sessions']]);
  assert.deepEqual(f.machine.changes().filter(r => r.command === 'systemctl').map(r => r.args.at(-1)), ['reboot', 'suspend']);
  assert.equal(await p.locator('dialog[open], .toast, [role="alert"]').count(), 0, 'no popups');
});

test('short power press opens only local power choices, with no action until selection', async t => {
  const f = await page(t); const p = f.page;
  f.send({ type: 'power-menu' });
  await p.locator('.system-panel').waitFor({ state: 'visible' });
  assert.deepEqual(await p.locator('.system-panel .system-head h2').allTextContents(), ['Power']);
  assert.equal(f.machine.changes().length, 0);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/power-menu.png` });
  await p.locator('.system-power button', { hasText: 'Sleep' }).click();
  assert.equal(f.machine.changes().length, 0);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.locator('.system-panel').waitFor({ state: 'hidden' });
});

test('the shared Bluetooth switch and sound mute retain their distinct meanings and actions', async t => {
  const f = await page(t); const p = f.page;
  await p.locator('.system-status').click();
  const bluetooth = p.locator('.system-bluetooth').getByRole('switch');
  assert.equal(await bluetooth.getAttribute('aria-checked'), 'true');
  await bluetooth.focus(); await p.keyboard.press('Space');
  await p.waitForFunction(() => document.querySelector('.system-line')?.hidden);
  assert.ok(f.machine.changes().some(r => r.command === 'bluetoothctl' && r.args.join(' ') === 'power off'));
  const mute = p.getByRole('button', { name: 'Mute output', exact: true });
  assert.equal(await mute.getAttribute('aria-pressed'), 'false', 'mute remains a labelled pressed button, not a radio switch');
  await mute.click();
  await p.waitForFunction(() => document.querySelector('.system-line')?.hidden);
  assert.ok(f.machine.changes().some(r => r.command === 'wpctl' && r.args.join(' ') === 'set-mute @DEFAULT_AUDIO_SINK@ 1'));
  assert.deepEqual(f.errors, []);
});

test('a failure is a line in the panel, not a popup', async t => {
  const f = await page(t, { fail: (command, args) => (command === 'bluetoothctl' && args.includes('connect') ? { stdout: 'Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n' } : null) });
  const p = f.page;
  await p.locator('.system-status').click();
  await p.getByRole('button', { name: 'Options for ZV-E10', exact: true }).click();
  await p.locator('.system-bluetooth').getByRole('button', { name: 'Connect', exact: true }).click();
  await p.locator('.system-panel .system-line.error').waitFor();
  assert.match(await p.locator('.system-panel .system-line.error').textContent(), /connecting ZV-E10: Failed to connect/);
});

test('the PC: Wi-Fi, Bluetooth, sound and power, but no screen light or battery', async t => {
  const f = await page(t, { computer: 'desktop' });
  const p = f.page;
  await p.locator('.system-status').waitFor({ state: 'visible' });
  assert.equal(await p.locator('.system-status .system-battery').count(), 0);
  await p.locator('.system-status').click();
  await p.locator('.system-panel .system-wifi').waitFor();
  assert.deepEqual(await p.locator('.system-panel .system-head h2').allTextContents(), ['Wi-Fi', 'Bluetooth', 'Sound', 'Power']);
});

test('nothing at all on the phone, another computer, a hosted computer, or without the tools', async t => {
  for (const options of [{ refused: true }, { missing: ['nmcli', 'bluetoothctl', 'wpctl', 'brightnessctl', 'upower', 'systemctl'] }]) {
    const f = await page(t, options);
    await f.page.waitForTimeout(400);
    assert.equal(await f.page.locator('.system-status').isVisible(), false, JSON.stringify(options));
    assert.equal(await f.page.locator('.system-panel').isVisible(), false);
    assert.deepEqual(f.asked, ['GET'], 'asked once; the answer will not change while the page is open');
    await f.close(); // Each fixture owns a browser; finish it before the next.
  }
});

// imperfect OS starts imperfect behind its lock: asked then, the computer says
// it is locked (423), which is for now, not a refusal. The lock going brings
// Wi-Fi and battery back at once, and they are still polled after.
test('a page that first asks while the screen is locked shows Wi-Fi and battery once it is unlocked', async t => {
  const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url), 'utf8')));
  const machine = recordedComputer('laptop');
  let held = true;
  const answers = [];
  const handle = createSystemControls({ run: machine.run, lockState: async name => (name === 'held' ? held : name === 'locked'), refuse: async () => '' });
  const f = await harnessFixture({
    site: true, themeCSS, viewport: { width: 1472, height: 920 }, messages: [{ role: 'assistant', content: 'Ready.' }],
    handleRequest: async (req, res, path) => {
      if (path === '/files/list') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: '/home/noah', home: '/home/noah', entries: [] })); return true; }
      if (path === '/system') res.on('finish', () => answers.push(res.statusCode));
      return handle(req, res, path);
    },
  });
  t.after(() => f.close());
  const p = f.page;
  await p.addInitScript(() => {
    let hear = null, now = { epoch: 1760083200 };
    globalThis.imperfectDesk = { onKey() {}, onBrowse() {}, onTab() {}, front() {}, onOpen() {}, onLock: fn => { const was = hear; hear = state => { was?.(state); fn(state); }; fn(now); } };
    globalThis.unlock = () => { now = null; hear?.(null); };
  });
  answers.length = 0;
  await p.reload();
  await p.waitForFunction(() => document.querySelector('.screen-clock')?.textContent);
  await p.waitForTimeout(300);
  assert.ok(answers.includes(423), JSON.stringify(answers));
  assert.equal(await p.locator('.system-status').isVisible(), false, 'nothing to show while locked');
  held = false;
  await p.evaluate(() => unlock());
  await p.locator('.system-status .system-wifi-icon').waitFor({ state: 'visible', timeout: 3000 });
  assert.match(await p.locator('.system-status').textContent(), /17%/);
  const [group, clock] = await Promise.all([box(p, '.screen-status'), box(p, '.screen-clock')]);
  // a desk's window is the focus layout: the middle's top centre, between the sidebar and the panel beside it
  const middle = await p.evaluate(() => { const frame = document.getElementById('entry-terminal'), style = getComputedStyle(frame);
    const rail = parseFloat(style.getPropertyValue('--focus-rail-w')) || 0, panel = parseFloat(style.getPropertyValue('--focus-panel-column')) || 0;
    return rail + (frame.getBoundingClientRect().width - rail - panel) / 2; });
  assert.ok(Math.abs((group.left + group.right) / 2 - middle) < 1.5, `centred over the middle ${JSON.stringify(group)} ${middle}`);
  assert.ok(clock.width > 0);
  assert.deepEqual(f.errors, []);
});
