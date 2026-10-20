import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync, crc32 } from 'node:zlib';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { createClipboard } from '../../../../system/clipboard.mjs';
import { createSystemControls } from '../../../../system/controls.mjs';
import { fakeCliphist } from '../../test/fixtures/system/cliphist.mjs';
import { recordedComputer } from '../../test/fixtures/system/computer.mjs';

// A real picture, so the page can draw it: a light square on dark.
function picture(width, height) {
	const chunk = (type, data) => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, 'latin1');
		data.copy(out, 8);
		out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
		return out;
	};
	const head = Buffer.alloc(13);
	head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
	const rows = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) rows.push(...(x > width / 4 && x < width * 3 / 4 && y > height / 4 && y < height * 3 / 4 ? [212, 212, 212] : [24, 24, 28]));
	}
	return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PICTURE = picture(64, 40);

// The real page, the real clipboard and system handlers (system/clipboard.mjs,
// controls.mjs) over cliphist in memory and recorded tools; only the owner
// check is the fixture's (apps/code/test/clipboard.test.mjs checks the real one).
async function page(t, { theme = 'black', width = 1536, desk = false, site = !desk, refused = false, missing = false } = {}) {
	const shots = await mkdtemp(join(tmpdir(), 'imperfect-shots-'));
	const cliphist = fakeCliphist();
	const refuse = async () => (refused ? 'only on this computer\'s own screen' : '');
	let f;
	const clipboard = createClipboard({ run: missing ? async () => ({ ok: false, missing: true, stdout: '', stderr: '' }) : cliphist.run, refuse, env: {}, shots,
		onBegin: capture => f.send({ type: 'screenshot-begin', capture }),
		onShot: (name, target) => f.send({ type: 'screenshot', name, ...target }),
	});
	const system = createSystemControls({ run: recordedComputer('laptop').run, refuse });
	const themeCSS = themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${theme}.json`, import.meta.url), 'utf8')));
	const asked = [], uploads = [];
	f = await harnessFixture({
		desk, site, themeCSS, viewport: { width, height: 900 }, hasTouch: width < 500,
		messages: [{ role: 'assistant', content: 'Ready.' }],
		handleRequest: async (req, res, path) => {
			if (path === '/upload') {
				let size = 0; for await (const bytes of req) size += bytes.length;
				uploads.push(req.headers['x-filename']);
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ size, reference: { name: `fixture-${uploads.length}`, sessionId: req.headers['x-session-id'] } })); return true;
			}
			if (path === '/files/list') { asked.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: '/home/noah', home: '/home/noah', entries: [] })); return true; }
			return (await clipboard.handle(req, res, path)) || system(req, res, path);
		},
	});
	await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(f.page.url()).origin });
	t.after(async () => { await f.close(); await rm(shots, { recursive: true, force: true }); });
	return { ...f, cliphist, shots, asked, uploads, mod: desk ? 'Meta' : 'Alt' };
}
const box = (p, selector) => p.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
const shoot = (p, name) => process.env.SHOTS && p.screenshot({ path: join(process.env.SHOTS, `${name}.png`) });

test('switching conversation during capture attaches to neither draft', async t => {
	const f = await page(t, { desk: true }); const p = f.page;
	await writeFile(join(f.shots, 'fenced.png'), PICTURE);
	await p.locator('#entry-input').fill('original words');
	const capture = await p.evaluate(async () => (await (await fetch('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"begin":true}' })).json()).capture);
	await p.waitForTimeout(300);
	const original = f.tab;
	f.push({ ...original, sessionId: 'thread-b', tabs: [{ id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'pi', name: 'B' }] });
	await p.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
	await p.locator('#entry-input').fill('other words');
	await p.evaluate(async capture => fetch('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taken: 'fenced.png', capture }) }), capture);
	await p.waitForTimeout(500);
	assert.equal(await p.locator('#entry-pending .entry-pending-chip').count(), 0);
	assert.equal(await p.locator('#entry-input').inputValue(), 'other words');
	assert.match(await p.locator('.shot-panel').textContent(), /saved · copied/);
	assert.equal(f.uploads.length, 0);
	f.push(original);
	await p.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-a');
	assert.equal(await p.locator('#entry-input').inputValue(), 'original words');
	assert.equal(await p.locator('#entry-pending .entry-pending-chip').count(), 0);
	assert.equal(f.uploads.length, 0);
	assert.deepEqual(f.errors, []);
});

test('Print capture only previews the saved copy, never uploads, attaches or sends', async t => {
	const f = await page(t, { desk: true }); const p = f.page;
	await writeFile(join(f.shots, 'auto.png'), PICTURE);
	const copied = f.cliphist.put(PICTURE);
	await p.locator('#entry-input').fill('keep my draft');
	// A native website owns the keyboard, but its host is still the active
	// local window. The host bridge, not document.hasFocus(), decides.
	await p.evaluate(() => { imperfectDesk.isFocused = () => true; document.hasFocus = () => false; });
	const capture = await p.evaluate(async () => (await (await fetch('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"begin":true}' })).json()).capture);
	await p.waitForTimeout(300);
	await p.evaluate(async capture => {
		for (let i = 0; i < 2; i++) await fetch('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taken: 'auto.png', capture }) });
	}, capture);
	await p.waitForTimeout(500);
	assert.deepEqual(f.errors, []);
	assert.match(await p.locator('.shot-panel').textContent(), /saved · copied/);
	assert.equal(await p.locator('#entry-input').inputValue(), 'keep my draft');
	assert.equal(await p.locator('#entry-pending .entry-pending-chip').count(), 0);
	assert.equal(await p.locator('#entry-pending').isVisible(), false);
	assert.equal(f.uploads.length, 0);
	assert.deepEqual(await readFile(join(f.shots, 'auto.png')), PICTURE, 'saved original is untouched');
	assert.deepEqual(f.cliphist.db.get(copied), PICTURE, 'copied image history is untouched');
	assert.ok(!f.commands.some(command => ['prompt', 'queue-add'].includes(command.type)));
	await shoot(p, 'screenshot-no-auto-attachment');
});

for (const theme of ['black', 'light-chalk']) test(`${theme}: Mod+V hangs what was copied under the status group, newest first; picked, it is copied and pasted into the input bar`, async t => {
	const f = await page(t, { theme });
	const p = f.page;
	f.cliphist.put('git push origin desktop-tools');
	f.cliphist.put(PICTURE);
	f.cliphist.put('A long note copied from the essay, about one computer with many forms that is never finished, and the person and the agents who share it as it grows.');
	await p.locator('.screen-status .system-status').waitFor({ state: 'visible' });
	await p.locator('#entry-input').click();
	await p.locator('#entry-input').fill('run ');
	await p.keyboard.press(`${f.mod}+KeyV`);
	const panel = p.locator('.clip-panel');
	await panel.locator('.clip-pick').nth(2).waitFor();
	await panel.locator('.clip-image').evaluate(image => image.complete || new Promise(resolve => { image.onload = resolve; }));
	assert.ok(await panel.locator('.clip-image').evaluate(image => image.naturalWidth === 64), 'the picture itself');
	const listed = await panel.locator('.clip-pick').allTextContents();
	assert.match(listed[0], /^A long note copied from the essay/);
	assert.match(listed[1], /^png 64×40 · \d+ B$/);
	assert.equal(listed[2], 'git push origin desktop-tools');
	const [opened, band, group] = await Promise.all([box(p, '.clip-panel'), box(p, '.session-rail-heading'), box(p, '.screen-status')]);
	assert.equal(opened.top, Math.round(band.bottom), 'no gap under the band');
	assert.equal(opened.width, 420);
	assert.ok(Math.abs((opened.left + opened.right) / 2 - (group.left + group.right) / 2) < 1.5, 'centred under the group');
	assert.ok(await panel.evaluate(node => [node, ...node.querySelectorAll('*')].every(child => getComputedStyle(child).borderRadius === '0px')), 'hard edges throughout');
	assert.equal(await p.evaluate(() => document.activeElement.className), 'clip-pick', 'the newest has the keys');
	await p.keyboard.press('ArrowDown');
	await shoot(p, `clipboard-${theme}`);
	await p.keyboard.press('ArrowDown');
	assert.equal(await p.evaluate(() => document.activeElement.textContent), 'git push origin desktop-tools');
	await p.keyboard.press('Enter');
	await panel.waitFor({ state: 'hidden' });
	assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'git push origin desktop-tools');
	assert.equal(await p.locator('#entry-input').inputValue(), 'run git push origin desktop-tools', 'pasted where the keys were');
	assert.equal(await p.evaluate(() => document.activeElement.id), 'entry-input');
	assert.deepEqual(f.errors, []);
});

test('in the desktop window Super+Shift+V; a picture picked goes on the clipboard and into the input bar as an image', async t => {
	const f = await page(t, { desk: { altAlias: false } });
	const p = f.page;
	f.cliphist.put(PICTURE);
	await p.locator('#entry-input').click();
	await p.waitForTimeout(300);
	await p.keyboard.press('Alt+KeyV');
	await p.waitForTimeout(300);
	assert.equal(await p.locator('.clip-panel').isVisible(), false, 'Alt is not Super in the desktop window under sway');
	await p.keyboard.press('Meta+Shift+KeyV');
	await p.locator('.clip-panel .clip-image').waitFor();
	await p.keyboard.press('Enter');
	await p.waitForFunction(() => document.querySelector('#entry-plus')?.classList.contains('has-files'));
	await p.waitForFunction(() => document.querySelector('#entry-pending').hidden);
	assert.match(await p.locator('#entry-input').inputValue(), /image 1/);
	const types = await p.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types));
	assert.deepEqual(types, ['image/png']);
	// From a website: Electron sends the key here.
	await p.evaluate(() => keyFromWindow('clipboard'));
	await p.locator('.clip-panel').waitFor();
	await p.keyboard.press('Escape');
	await p.locator('.clip-panel').waitFor({ state: 'hidden' });
	assert.deepEqual(f.errors, []);
});

test('each can be deleted, or all with a question first; clearing empties the clipboard too', async t => {
	const f = await page(t);
	const p = f.page;
	for (const word of ['one', 'two', 'three', 'four']) f.cliphist.put(word);
	await p.evaluate(() => navigator.clipboard.writeText('four'));
	await p.keyboard.press('Alt+KeyV');
	const picks = p.locator('.clip-panel .clip-pick');
	await picks.nth(3).waitFor();
	await p.locator('.clip-panel .clip-item').nth(1).locator('.clip-delete').click();
	await p.waitForFunction(() => document.querySelectorAll('.clip-panel .clip-pick').length === 3);
	assert.deepEqual(await picks.allTextContents(), ['four', 'two', 'one']);
	await picks.nth(1).focus();
	await p.keyboard.press('Delete');
	await p.waitForFunction(() => document.querySelectorAll('.clip-panel .clip-pick').length === 2);
	assert.deepEqual(await picks.allTextContents(), ['four', 'one']);
	assert.equal(await p.evaluate(() => document.activeElement.textContent), 'one', 'the keys stay in the list');
	await p.locator('.clip-head button', { hasText: 'clear' }).click();
	assert.equal(await p.locator('.clip-head h2').textContent(), 'clear everything copied?');
	await p.keyboard.press('Escape');
	assert.equal(await p.locator('.clip-head h2').textContent(), 'clipboard', 'Escape takes the question back first');
	assert.deepEqual([...f.cliphist.db.values()].map(String), ['one', 'four']);
	await p.locator('.clip-head button', { hasText: 'clear' }).click();
	await p.locator('.clip-head .system-danger').click();
	await p.locator('.clip-panel .system-line', { hasText: 'nothing copied yet' }).waitFor();
	assert.equal(f.cliphist.db.size, 0);
	assert.equal(await p.evaluate(() => navigator.clipboard.readText()), '');
	await p.locator('#entry-input').click();
	await p.locator('.clip-panel').waitFor({ state: 'hidden' });
	assert.deepEqual(f.errors, []);
});

for (const [why, options] of [['a computer without cliphist', { missing: true }], ['a screen that is not the computer\'s own', { refused: true }]]) test(`on ${why}, Mod+V is nothing`, async t => {
	const f = await page(t, options);
	const p = f.page;
	await p.locator('#entry-input').click();
	await p.waitForTimeout(300);
	await p.keyboard.press('Alt+KeyV');
	await p.waitForTimeout(300);
	assert.equal(await p.locator('.clip-panel').isVisible(), false);
	assert.equal(await p.evaluate(async () => (await import('/js/pi-card.js')).activeKeyBindings().some(binding => binding.label.endsWith('+V'))), false, 'not offered');
	assert.equal(await p.locator('#entry-input').inputValue(), '');
	assert.deepEqual(f.errors, []);
});

test('a Wi-Fi password pasted into the system panel leaves the clipboard\'s history', async t => {
	const f = await page(t);
	const p = f.page;
	f.cliphist.put('kept');
	f.cliphist.put('correct horse');
	await p.evaluate(() => navigator.clipboard.writeText('correct horse'));
	await p.locator('.system-status').click();
	await p.locator('.system-wifi .system-item', { hasText: 'Neighbour0895C8' }).locator('.system-name').click();
	await p.locator('.system-password').click();
	await p.keyboard.press('Control+KeyV');
	assert.equal(await p.locator('.system-password').inputValue(), 'correct horse');
	await p.waitForFunction(() => true);
	for (let i = 0; i < 20 && f.cliphist.db.size > 1; i++) await p.waitForTimeout(50);
	assert.deepEqual([...f.cliphist.db.values()].map(String), ['kept']);
	assert.deepEqual(f.errors, []);
});

for (const theme of ['black', 'light-chalk']) test(`${theme}: a screenshot just taken: a small picture under the group, into the input bar, Files or deleted`, async t => {
	const f = await page(t, { theme });
	const p = f.page;
	const name = '2026-10-10-142501.png';
	// A picture of the screen, as the screenshot key takes it.
	await writeFile(join(f.shots, name), await p.screenshot());
	await p.locator('.system-status').waitFor({ state: 'visible' });
	await p.locator('#entry-input').click();
	await p.locator('#entry-input').fill('typing');
	f.send({ type: 'screenshot', name });
	const preview = p.locator('.shot-panel');
	await preview.locator('.shot-image').waitFor();
	await preview.locator('.shot-image').evaluate(image => image.complete || new Promise(resolve => { image.onload = resolve; }));
	assert.equal(await p.evaluate(() => document.activeElement.id), 'entry-input', 'it never takes the keys');
	await p.keyboard.type(' on');
	assert.equal(await p.locator('#entry-input').inputValue(), 'typing on');
	const [shown, group] = await Promise.all([box(p, '.shot-panel'), box(p, '.screen-status')]);
	assert.equal(shown.width, 320);
	assert.ok(Math.abs((shown.left + shown.right) / 2 - (group.left + group.right) / 2) < 1.5, 'centred under the group');
	assert.deepEqual(await preview.locator('button').allTextContents(), ['attach here', 'files', 'delete']);
	await shoot(p, `screenshot-${theme}`);
	await preview.locator('button', { hasText: 'attach' }).click();
	await p.waitForFunction(() => document.querySelector('#entry-input').value.includes('image 1') && document.querySelector('#entry-pending').hidden);
	assert.equal(f.uploads.length, 1, 'attach here explicitly uploads');
	assert.equal(await p.locator('.entry-inline-attachment').textContent(), 'image 1');
	await preview.waitFor({ state: 'hidden' });
	assert.match(await p.locator('#entry-input').inputValue(), /typing on image 1/);
	f.send({ type: 'screenshot', name });
	await preview.waitFor();
	await preview.locator('button', { hasText: 'files' }).click();
	await preview.waitFor({ state: 'hidden' });
	await p.waitForFunction(() => document.querySelector('.wm-files') && !document.querySelector('.wm-files').hidden);
	const opened = () => f.asked.some(url => new URL(url, 'http://x').searchParams.get('path') === `Pictures/screenshots/${name}`);
	for (let i = 0; i < 40 && !opened(); i++) await p.waitForTimeout(50);
	assert.ok(opened(), f.asked.join(' '));
	f.send({ type: 'screenshot', name });
	await preview.waitFor();
	await preview.locator('button', { hasText: 'delete' }).click();
	await preview.waitFor({ state: 'hidden' });
	await assert.rejects(access(join(f.shots, name)));
	assert.deepEqual(f.errors, []);
});

test('the preview goes by itself unless the pointer is on it; Escape or a press elsewhere sends it away', async t => {
	const f = await page(t);
	const p = f.page;
	await writeFile(join(f.shots, 'a.png'), PICTURE);
	await p.locator('.system-status').waitFor({ state: 'visible' });
	const preview = p.locator('.shot-panel');
	f.send({ type: 'screenshot', name: 'a.png' });
	await preview.waitFor();
	await p.keyboard.press('Escape');
	await preview.waitFor({ state: 'hidden' });
	f.send({ type: 'screenshot', name: 'a.png' });
	await preview.waitFor();
	await p.locator('#entry-input').click();
	await preview.waitFor({ state: 'hidden' });
	f.send({ type: 'screenshot', name: 'a.png' });
	await preview.waitFor();
	await preview.locator('.shot-image').hover();
	await p.waitForTimeout(8600);
	assert.equal(await preview.isVisible(), true, 'held while the pointer is on it');
	await p.mouse.move(5, 600);
	await preview.waitFor({ state: 'hidden', timeout: 9000 });
	assert.deepEqual(f.errors, []);
});
