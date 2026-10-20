// Production dialog and harness, fake catalogue/transport: no SDK or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'A conversation with an unfinished draft.' }] }];
const index = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
const realFrame = async (_req, res, path) => {
  if (path !== '/') return false;
  res.setHeader('Content-Type', 'text/html'); res.end(index); return true;
};
// Claude runtime maps supportedModels.value/displayName/resolvedModel to
// id/name/resolvedModel (claude-runtime.mjs:modelView). Exercise those actual
// public fields, including a missing name and a resolved alias, not guessed names.
const claude = [
  { id: 'opus', name: 'Opus', resolvedModel: 'claude-opus-5-5' },
  { id: 'sonnet', name: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001' },
  { id: 'fable', name: 'Fable 5.1' },
].map(m => ({ ...m, provider: 'claude-agent', engine: 'claude', billing: 'Claude subscription · extra usage if enabled in Claude · ' + 'a very long billing explanation '.repeat(20) }));
const models = [
  { provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna', engine: 'pi', billing: 'Subscription' },
  { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol', engine: 'pi', billing: 'Subscription' },
  ...claude,
];
const names = ['Opus 5.5', 'Sonnet 5', 'Haiku 4.5', 'Fable 5.1', 'GPT-6 Luna', 'GPT-6 Sol'];
async function setup(t, options = {}) {
  const f = await harnessFixture({ messages, handleRequest: realFrame, ...options });
  t.after(() => f.close());
  f.answer = c => c.type === 'models' ? models : c.type === 'level' ? { current: 'medium', available: ['low', 'medium', 'high'] } : undefined;
  f.push({ ...f.tab, model: claude[0] });
  await f.page.waitForFunction(() => document.querySelector('#entry-pi-label .entry-model-name').textContent === 'Opus 5.5');
  return f;
}
const open = page => page.locator('#entry-pi-label').click();
const closed = page => page.locator('#entry-dialog').waitFor({ state: 'hidden' });

for (const width of [390, 400, 1280]) for (const theme of ['black', 'light-chalk']) {
  test(`model names, original marks and bounded billing fit ${width}px ${theme}, including a 200px keyboard inset`, async t => {
    const f = await setup(t, { viewport: { width, height: 844 }, hasTouch: width < 700 });
    const { page } = f;
    await page.addStyleTag({ content: themeCss(await testTheme(theme)) });
    await open(page);
    assert.deepEqual(await page.locator('#entry-dialog .entry-dialog-option-label').allTextContents(), names);
    assert.equal(await page.locator('#entry-dialog .entry-dialog-option.active .entry-dialog-option-label').textContent(), 'Opus 5.5');
    assert.deepEqual(await page.locator('#entry-dialog .entry-dialog-option small').allTextContents(), ['Claude Code · Subscription', 'Claude Code · Subscription', 'Claude Code · Subscription', 'Claude Code · Subscription', 'Pi · Subscription', 'Pi · Subscription']);
    const marks = await page.locator('#entry-dialog .entry-dialog-option > svg').evaluateAll(nodes => nodes.map(n => ({ agent: n.dataset.agent, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, viewBox: n.getAttribute('viewBox'), firstPath: n.querySelector('path').getAttribute('d') })));
    assert.deepEqual(marks.map(m => m.agent), ['claude', 'claude', 'claude', 'claude', 'pi', 'pi']);
    assert.ok(marks.every(m => m.width === 16 && m.height === 16));
    const original = await page.evaluate(async () => {
      const { harnessMark } = await import('/js/agent-faces.js');
      return ['claude', 'pi'].map(agent => { const m = harnessMark(agent); return { viewBox: m.getAttribute('viewBox'), firstPath: m.querySelector('path').getAttribute('d') }; });
    });
    for (const m of marks) assert.deepEqual({ viewBox: m.viewBox, firstPath: m.firstPath }, original[m.agent === 'claude' ? 0 : 1]);
    assert.match(await page.locator('#entry-dialog .entry-dialog-option').first().getAttribute('title'), /extra usage.*a very long billing explanation/);
    assert.match(await page.locator('#entry-dialog-billing').textContent(), /extra usage.*cost more/);
    assert.equal(await page.getByRole('button', { name: 'Close picker', exact: true }).count(), 1);
    for (const inset of width < 700 ? [0, 200] : [0]) {
      await page.evaluate(inset => document.documentElement.style.setProperty('--safe-bottom', `${inset}px`), inset);
      const geometry = await page.locator('#entry-dialog').evaluate(dialog => {
        const box = dialog.getBoundingClientRect();
        const close = dialog.querySelector('.entry-dialog-close').getBoundingClientRect();
        const footer = dialog.querySelector('.entry-dialog-billing').getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, closeTop: close.top, closeBottom: close.bottom, footerBottom: footer.bottom,
          overflow: dialog.scrollWidth > dialog.clientWidth + 1,
          rows: [...dialog.querySelectorAll('.entry-dialog-option')].map(row => {
            const name = row.querySelector('.entry-dialog-option-label'), note = row.querySelector('small');
            return { nameWidth: name.clientWidth, nameOverflow: name.scrollWidth > name.clientWidth + 1, noteWidth: note.clientWidth, noteOverflow: note.scrollWidth > note.clientWidth + 1, fontSize: parseFloat(getComputedStyle(name).fontSize) };
          }) };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 844 - inset + 1, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false, JSON.stringify(geometry));
      assert.ok(geometry.closeTop >= geometry.top && geometry.closeBottom <= geometry.bottom && geometry.footerBottom <= geometry.bottom, JSON.stringify(geometry));
      assert.ok(geometry.rows.every(r => r.nameWidth >= 80 && !r.nameOverflow && r.noteWidth <= 16 * r.fontSize && !r.noteOverflow && r.fontSize >= 13), JSON.stringify(geometry));
    }
    if (width === 390 && theme === 'black' && process.env.MODEL_PICKER_PREVIEW) {
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '0px'));
      await page.locator('#entry-dialog').screenshot({ path: process.env.MODEL_PICKER_PREVIEW });
      if (process.env.MODEL_PICKER_FULL_PREVIEW) await page.screenshot({ path: process.env.MODEL_PICKER_FULL_PREVIEW });
    }
    await page.locator('.compact-search').fill('Luna');
    assert.deepEqual(await page.locator('#entry-dialog .entry-dialog-option-label').allTextContents(), ['GPT-6 Luna']);
    await page.locator('.compact-search').fill('');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.entry-dialog-option.active .entry-dialog-option-label').textContent(), 'Sonnet 5');
    await page.keyboard.press('Escape'); await closed(page);
    assert.deepEqual(f.errors, []);
  });
}

for (const how of ['outside', 'outside-composer', 'outside-trigger', 'outside-mic', 'close', 'escape', 'close-enter']) {
  test(`${how} dismisses model and effort pickers, preserving draft and caret`, async t => {
    const f = await setup(t, { viewport: { width: 390, height: 700 }, hasTouch: true });
    const { page } = f;
    await page.evaluate(() => {
      window.pickerMicRequests = 0;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { window.pickerMicRequests++; throw new Error('fixture microphone only'); } } });
    });
    await page.locator('#entry-input').fill('An unfinished thought');
    await page.locator('#entry-input').evaluate(n => { n.focus(); n.setSelectionRange(3, 7, 'backward'); });
    const dismiss = async () => {
      if (how === 'outside') await page.touchscreen.tap(5, 5);
      if (how === 'outside-composer') await page.locator('#entry-input').tap({ position: { x: 5, y: 10 } });
      if (how === 'outside-trigger') await page.locator('#entry-pi-label').tap();
      if (how === 'outside-mic') await page.locator('.entry-voice[data-state]').tap();
      if (how === 'close') await page.getByRole('button', { name: 'Close picker', exact: true }).click();
      if (how === 'escape') await page.keyboard.press('Escape');
      if (how === 'close-enter') { await page.getByRole('button', { name: 'Close picker', exact: true }).focus(); await page.keyboard.press('Enter'); }
      await closed(page);
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#entry-dialog').isVisible(), false, 'outside dismissal must not reopen the picker on a later click');
      assert.equal(await page.evaluate(() => window.pickerMicRequests), 0, 'dismissal must not also start a microphone request');
      assert.deepEqual(await page.locator('#entry-input').evaluate(n => [n.value, n.selectionStart, n.selectionEnd, n.selectionDirection, document.activeElement === n]), ['An unfinished thought', 3, 7, 'backward', true]);
    };
    await open(page); await dismiss();
    assert.equal(f.commands.filter(c => c.type === 'model').length, 0);
    await open(page);
    await page.locator('.compact-search').fill('Sol'); await page.keyboard.press('Enter');
    await page.locator('#entry-dialog .entry-dialog-title', { hasText: 'effort' }).waitFor();
    await dismiss();
    assert.equal(f.commands.filter(c => c.type === 'level' && c.level).length, 0);
    assert.deepEqual(f.errors, []);
  });
}

test('API and unknown billing remain truthful, unavailable Claude is not invented, current old/provider rows survive grouping', async t => {
  const f = await setup(t);
  const older = { ...models[0], id: 'gpt-5-luna', name: 'GPT-5 Luna', billing: 'Subscription status unknown' };
  const api = { ...models[0], provider: 'openai', billing: 'API / provider billing' };
  f.answer = c => c.type === 'models' ? [older, models[0], api] : undefined;
  f.push({ ...f.tab, model: older });
  await f.page.waitForFunction(() => document.querySelector('#entry-pi-label .entry-model-name').textContent === 'GPT-5 Luna');
  await open(f.page);
  assert.deepEqual(await f.page.locator('.entry-dialog-option-label').allTextContents(), ['GPT-5 Luna', 'GPT-6 Luna', 'GPT-6 Luna']);
  assert.deepEqual(await f.page.locator('.entry-dialog-option small').allTextContents(), ['Pi · Unknown', 'Pi · Subscription', 'Pi · API']);
  assert.equal(await f.page.locator('.entry-dialog-option.active .entry-dialog-option-label').textContent(), 'GPT-5 Luna');
  assert.equal(await f.page.locator('#entry-dialog svg[data-agent="claude"]').count(), 0);
  await f.page.keyboard.press('Escape'); await closed(f.page);
  f.push({ ...f.tab, model: api });
  await open(f.page);
  assert.equal(await f.page.locator('.entry-dialog-option.active small').textContent(), 'Pi · API', 'same display name does not select the wrong provider');
});

test('dismissal while another catalogue is pending prevents its late popup', async t => {
  const f = await setup(t);
  await open(f.page);
  let resolve;
  f.answer = c => c.type === 'models' ? new Promise(r => { resolve = r; }) : undefined;
  // Click, rather than pointerdown: exercise a refresh already in flight while
  // the first picker is still open. Real outside pointerdown cancels instead.
  await f.page.locator('#entry-pi-label').evaluate(n => n.click());
  await f.page.waitForTimeout(40);
  assert.ok(resolve);
  await f.page.getByRole('button', { name: 'Close picker', exact: true }).click();
  resolve(models);
  await f.page.waitForTimeout(100);
  assert.equal(await f.page.locator('#entry-dialog').isVisible(), false);
  assert.equal(f.commands.filter(c => c.type === 'model').length, 0);
});

test('later selection wins over a late catalogue and sends model/effort to captured original tab', async t => {
  const f = await setup(t);
  let release, calls = 0;
  f.answer = c => c.type === 'models' ? (++calls === 1 ? new Promise(r => { release = r; }) : models) : c.type === 'level' ? { current: 'medium', available: ['low', 'medium', 'high'] } : undefined;
  await open(f.page);
  await f.page.waitForTimeout(40);
  await f.page.locator('#entry-pi-label').evaluate(n => n.click());
  await f.page.locator('.compact-search').fill('Luna');
  await f.page.locator('.entry-dialog-option', { hasText: 'GPT-6 Luna' }).click();
  await f.page.locator('.entry-dialog-title', { hasText: 'effort' }).waitFor();
  await f.page.keyboard.press('ArrowDown'); await f.page.keyboard.press('Enter'); await closed(f.page);
  release(models);
  await f.page.waitForTimeout(100);
  const model = f.commands.find(c => c.type === 'model');
  assert.deepEqual([model.provider, model.modelId, model.expectedSessionId, model.expectedTabId], ['openai-codex', 'gpt-6-luna', 'thread-a', 'tab-a']);
  const level = f.commands.find(c => c.type === 'level' && c.level);
  assert.deepEqual([level.level, level.expectedSessionId, level.expectedTabId], ['high', 'thread-a', 'tab-a']);
  assert.equal(await f.page.locator('#entry-dialog').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test('navigation invalidates late model/effort queries and never sends to the newly selected session', async t => {
  const f = await setup(t);
  let release;
  f.answer = c => c.type === 'models' ? models : c.type === 'level' ? new Promise(r => { release = r; }) : undefined;
  await open(f.page);
  await f.page.locator('.compact-search').fill('Sol'); await f.page.keyboard.press('Enter');
  await f.page.waitForTimeout(40);
  assert.ok(release);
  f.push({ ...f.tab, sessionId: 'thread-b', tabs: [{ id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'pi', name: 'B', status: 'idle' }] });
  await f.page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
  release({ current: 'medium', available: ['low', 'medium', 'high'] });
  await f.page.waitForTimeout(100);
  assert.equal(await f.page.locator('#entry-dialog').isVisible(), false);
  const query = f.commands.find(c => c.type === 'level');
  assert.deepEqual([query.expectedSessionId, query.expectedTabId], ['thread-a', 'tab-a']);
  assert.equal(f.commands.filter(c => c.type === 'level' && c.level).length, 0);
});

for (const snapshotFirst of [true, false]) test(`cross-harness ${snapshotFirst ? 'snapshot' : 'response'} first carries the draft and sets effort on the resulting tab`, async t => {
  const f = await setup(t);
  const { page } = f;
  f.answer = c => {
    if (c.type === 'models') return models;
    if (c.type === 'model') {
      const next = { ...f.tab, agent: 'claude', sessionId: 'thread-c', model: claude[0], tabs: [{ ...f.tab.tabs[0], focused: false }, { id: 'tab-c', sessionId: 'thread-c', agent: 'claude', focused: true, name: 'C', status: 'idle' }] };
      if (snapshotFirst) f.push(next); else setTimeout(() => f.push(next), 0);
      return {};
    }
    if (c.type === 'level') return new Promise(resolve => setTimeout(() => resolve({ current: 'low', available: ['low', 'high'] }), 20));
  };
  await page.locator('#entry-input').fill('Draft follows the harness');
  await open(page); await page.keyboard.press('Enter');
  await page.locator('.entry-dialog-title', { hasText: 'effort' }).waitFor();
  assert.equal(await page.locator('#entry-input').inputValue(), 'Draft follows the harness');
  await page.locator('.entry-dialog-option', { hasText: 'high' }).click(); await closed(page);
  const chosen = f.commands.find(c => c.type === 'model');
  assert.deepEqual([chosen.provider, chosen.modelId, chosen.expectedSessionId, chosen.expectedTabId], ['claude-agent', 'opus', 'thread-a', 'tab-a']);
  const level = f.commands.find(c => c.type === 'level' && c.level);
  assert.deepEqual([level.level, level.expectedSessionId, level.expectedTabId], ['high', 'thread-c', 'tab-c']);
  assert.deepEqual(f.errors, []);
});

test('outside taps do not dismiss or answer an SDK permission dialog', async t => {
  const f = await setup(t, { viewport: { width: 390, height: 700 }, hasTouch: true });
  f.push({ ...f.tab, agent: 'claude', ui: { dialogs: [{ id: 'permission', method: 'confirm', title: 'Allow a tool?', message: 'Run this command?' }] } });
  await f.page.locator('#entry-dialog.input-dialog').waitFor();
  await f.page.touchscreen.tap(5, 5);
  assert.equal(await f.page.locator('#entry-dialog').isVisible(), true);
  assert.equal(f.commands.filter(c => c.type === 'dialog').length, 0);
  await f.page.locator('#entry-dialog').focus();
  await f.page.keyboard.press('Escape'); await closed(f.page);
  const reply = f.commands.find(c => c.type === 'dialog');
  assert.equal(reply.cancelled, true);
});

test('colliding identities on two owners: model and effort stay on their captured computer, stale callbacks do nothing', async t => {
  const f = await setup(t, { machines: [{ id: 'a', name: 'Desktop', self: true, reachable: true }, { id: 'b', name: 'Laptop', reachable: true }] });
  const { page } = f, calls = [];
  f.answer = (c, owner) => {
    calls.push({ ...c, owner: owner || 'a' });
    if (c.type === 'models') return models;
    if (c.type === 'level') return { current: 'medium', available: ['low', 'medium', 'high'] };
    if (c.type === 'snapshot') return f.tab;
    if (c.type === 'tab-focus') return { snapshot: f.tab };
  };
  const go = async owner => {
    await page.locator(`.session-rail-item[data-owner="${owner}"] .session-rail-open`).evaluate(n => n.click());
    await page.waitForFunction(owner => harness.guiSnapshot().owner === owner, owner);
  };
  await page.locator('.session-rail-item[data-owner="b"]').waitFor();
  await go('b');
  await open(page);
  await page.locator('.compact-search').fill('Luna'); await page.keyboard.press('Enter');
  await page.locator('.entry-dialog-title', { hasText: 'effort' }).waitFor();
  await page.locator('.entry-dialog-option', { hasText: 'high' }).click(); await closed(page);
  assert.deepEqual(calls.filter(c => c.type === 'model' || c.type === 'level').map(c => [c.owner, c.expectedSessionId, c.expectedTabId]), [['b', 'thread-a', 'tab-a'], ['b', 'thread-a', 'tab-a'], ['b', 'thread-a', 'tab-a']]);
  await open(page);
  await page.locator('.compact-search').fill('Sol'); await page.keyboard.press('Enter');
  await page.locator('.entry-dialog-title', { hasText: 'effort' }).waitFor();
  await page.locator('.entry-dialog-option', { hasText: 'high' }).evaluate(n => { globalThis.oldEffortChoice = n; });
  await go('a');
  const before = calls.filter(c => c.type === 'level' && c.level).length;
  await page.evaluate(() => oldEffortChoice.click());
  await page.waitForTimeout(80);
  assert.equal(calls.filter(c => c.type === 'level' && c.level).length, before);
  let release;
  const answer = f.answer;
  f.answer = (c, owner) => c.type === 'models' ? new Promise(r => { release = r; }) : answer(c, owner);
  await open(page);
  await page.waitForTimeout(40);
  assert.ok(release);
  await go('b');
  release(models);
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#entry-dialog').isVisible(), false);
  assert.deepEqual(f.errors, []);
});
