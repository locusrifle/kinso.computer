// Questions in the complete harness: only the backend is a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

const realIndex = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const realFrame = async (_req, res, path) => {
  if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(realIndex); return true; }
  if (path === '/files/list') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: [] })); return true; }
  return false;
};
const question = index => ({ header: `Part ${index}`, question: `Question ${index}?`, options: [
  { label: 'Keep', description: 'Keep the unfinished thing. ' + 'a-long-description-'.repeat(40) },
  { label: 'Remove', description: 'Only this thing.' },
] });
async function setup(t, options = {}) {
  const f = await harnessFixture({ ...options, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'The conversation stays above the question.\n\n'.repeat(40) }] }] });
  t.after(() => f.close());
  const { page } = f;
  await page.addStyleTag({ content: themeCss(await testTheme('black')) });
  const replies = [];
  f.answer = command => {
    if (command.type === 'dialog') { replies.push(command); f.push({ ...f.tab, ui: { dialogs: [] } }); }
    if (command.type === 'models') return [{ provider: 'fixture', id: 'fixture', name: 'Fixture', engine: 'pi' }];
  };
  let id = 0;
  const open = async (method, fields = {}) => {
    f.push({ ...f.tab, ui: { dialogs: [{ id: `ask-${++id}`, method, title: 'A quiet question', ...fields }] } });
    await page.locator('#entry-dialog:not([hidden])').waitFor();
  };
  const closed = () => page.locator('#entry-dialog').waitFor({ state: 'hidden' });
  return { f, page, replies, open, closed };
}

test('questions replace the composer, keep drafts, wrap, and answer by keyboard', async t => {
  const { f, page, replies, open, closed } = await setup(t);
  await page.locator('#entry-input').fill('Unfinished words');
  await open('questions', { questions: [question(1)] });
  assert.equal(await page.locator('#entry-input-zone').isVisible(), false);
  assert.equal(await page.locator('.entry-status').isVisible(), true, 'the dock stays available for usage without answering the question');
  assert.equal(await page.locator('#entry-dialog').evaluate(node => node.scrollWidth > node.clientWidth), false);
  assert.equal(await page.locator('#entry-output').evaluate(node => node.scrollHeight > node.clientHeight), true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.choice), '0-0');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.entry-dialog-option.active').textContent(), 'RemoveOnly this thing.');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.choice), '0-1', 'repainting keeps the keys in the question');
  await page.keyboard.press('Enter'); await closed();
  assert.deepEqual(replies.at(-1).value, { 'Question 1?': 'Remove' });
  assert.equal(await page.locator('#entry-input').inputValue(), 'Unfinished words');
  assert.equal(await page.locator('#entry-input-zone').isVisible(), true);
  assert.equal(await page.locator('.entry-status').isVisible(), true);

  await open('questions', { questions: [question(2)] });
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  await page.locator('.entry-dialog-other textarea').fill('Something else');
  // A later snapshot must not erase an answer in progress.
  f.push({ ...f.tab, stats: { contextPercent: 12 } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.entry-dialog-other textarea').inputValue(), 'Something else');
  await page.keyboard.press('Enter'); await closed();
  assert.deepEqual(replies.at(-1).value, { 'Question 2?': 'Something else' });
  await open('questions', { questions: [question(3)] });
  await page.keyboard.press('Escape'); await closed();
  assert.equal(replies.at(-1).cancelled, true);
  assert.deepEqual(f.errors, []);
});

test('four questions and multiple choices, including Other, need an answer for every part', async t => {
  const { f, page, replies, open, closed } = await setup(t);
  await open('questions', { questions: [question(1), question(2), question(3), { ...question(4), multiSelect: true }] });
  const blocks = page.locator('.entry-dialog-question'), answer = page.locator('.entry-dialog-actions button').first();
  assert.equal(await answer.isDisabled(), true);
  for (let index = 0; index < 3; index++) await blocks.nth(index).getByRole('button', { name: /^Keep/ }).click();
  assert.equal(await answer.isDisabled(), true);
  const last = blocks.nth(3);
  await last.getByRole('button', { name: /^Keep/ }).click();
  await last.getByRole('button', { name: /^Remove/ }).click();
  await last.getByRole('button', { name: 'Other', exact: true }).click();
  await last.locator('textarea').fill('Reconsider');
  assert.equal(await answer.isDisabled(), false);
  await page.keyboard.press('Enter'); await closed();
  assert.deepEqual(replies.at(-1).value, { 'Question 1?': 'Keep', 'Question 2?': 'Keep', 'Question 3?': 'Keep', 'Question 4?': 'Keep, Remove, Reconsider' });
  assert.deepEqual(f.errors, []);
});

test('confirmation, select and text cancellation respond; the model picker keeps the composer', async t => {
  const { f, page, replies, open, closed } = await setup(t);
  for (const method of ['confirm', 'select', 'input', 'editor']) {
    await open(method, { message: 'A wrapped explanation', options: ['Keep', 'Remove'] });
    assert.equal(await page.locator('#entry-input-zone').isVisible(), false);
    await page.keyboard.press('Escape'); await closed();
    assert.equal(replies.at(-1).cancelled, true, `${method} cancels at the backend`);
  }
  await open('confirm', { message: 'Allow it?' });
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'no');
  await page.keyboard.press('Enter'); await closed();
  assert.equal(replies.at(-1).confirmed, false, 'Tab and Enter choose the focused answer');
  await open('editor', { prefill: 'Keep editing' });
  const editor = page.locator('#entry-dialog textarea');
  await editor.press('End'); await editor.press('Enter');
  assert.equal(await editor.inputValue(), 'Keep editing\n', 'editor Enter edits, unlike question Enter');
  await editor.press('Control+Enter'); await closed();
  assert.equal(replies.at(-1).value, 'Keep editing\n');
  await page.locator('#entry-pi-label').click();
  await page.locator('#entry-dialog.centre-box').waitFor();
  assert.equal(await page.locator('#entry-input-zone').isVisible(), true);
  await page.keyboard.press('Escape'); await closed();
  assert.deepEqual(f.errors, []);
});

for (const width of [320, 390, 1280, 1536]) for (const theme of ['black', 'light-chalk']) {
  test(`shared Claude/Pi questions fit their column and keep actions reachable (${width}px ${theme})`, async t => {
    const { f, page, replies, open, closed } = await setup(t, { site: true, handleRequest: realFrame, viewport: { width, height: 844 }, hasTouch: width < 700 });
    await page.addStyleTag({ content: themeCss(await testTheme(theme)) });
    await page.locator('#entry-input').fill('Draft before questions');
    const questions = Array.from({ length: 4 }, (_, i) => ({ ...question(i + 1), question: `Question ${i + 1}? ` + 'A long question that must wrap. '.repeat(12), multiSelect: i === 3 }));
    let claudeMarkup;
    for (const agent of ['claude', 'pi']) {
      f.push({ ...f.tab, agent });
      await open('questions', { questions });
      const markup = await page.locator('#entry-dialog').innerHTML();
      if (agent === 'claude') claudeMarkup = markup; else assert.equal(markup, claudeMarkup, 'one renderer regardless of harness');
      const geometry = await page.locator('#entry-dialog').evaluate(dialog => {
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const screen = dialog.parentElement;
        const content = dialog.querySelector('.entry-dialog-questions');
        const actions = dialog.querySelector('.entry-dialog-actions');
        return { dialog: rect(dialog), screen: rect(screen), content: rect(content), maxContentWidth: parseFloat(getComputedStyle(content).maxWidth), actions: rect(actions), dock: rect(document.querySelector('.entry-status')), scrollable: content.scrollHeight > content.clientHeight,
          clipped: [...dialog.querySelectorAll('.entry-dialog-title, .entry-dialog-option, .entry-dialog-option-label, small')].some(n => n.scrollWidth > n.clientWidth + 1),
          smallText: getComputedStyle(dialog).getPropertyValue('--text-s').trim(),
          textSizes: [...dialog.querySelectorAll('.entry-dialog-option small')].map(n => getComputedStyle(n).fontSize) };
      });
      assert.equal(geometry.clipped, false, JSON.stringify(geometry));
      assert.ok(geometry.dialog.left >= geometry.screen.left - 1 && geometry.dialog.right <= geometry.screen.right + 1, JSON.stringify(geometry));
      assert.ok(geometry.dialog.bottom <= geometry.dock.top + 1 || geometry.dialog.top >= geometry.dock.bottom - 1, 'does not overlap shared composer band');
      assert.ok(geometry.actions.top >= geometry.dialog.top && geometry.actions.bottom <= geometry.dialog.bottom, 'actions always visible');
      assert.ok(Math.abs(geometry.dialog.bottom - geometry.screen.bottom) < 2, 'question footer sits at the bottom of its owning area');
      assert.equal(geometry.scrollable, true);
      assert.ok(geometry.content.right - geometry.content.left <= geometry.maxContentWidth + 1, 'choices wrap at a readable column width');
      assert.ok(geometry.textSizes.every(size => size === geometry.smallText), 'question descriptions use the shared small-text token');
      if (process.env.QUESTION_SCREENSHOTS) await page.screenshot({ path: `${process.env.QUESTION_SCREENSHOTS}/${width}-${theme}-${agent}.png` });
      assert.equal(await page.locator('#entry-input-zone').isVisible(), false);
      const blocks = page.locator('.entry-dialog-question');
      for (let i = 0; i < 3; i++) await blocks.nth(i).getByRole('button', { name: /^Remove/ }).click();
      await blocks.nth(3).getByRole('button', { name: /^Keep/ }).click();
      await blocks.nth(3).getByRole('button', { name: 'Other', exact: true }).click();
      const other = blocks.nth(3).locator('textarea');
      await other.fill('First line'); await other.click(); await other.press('End'); await other.press('Shift+Enter'); await other.pressSequentially('Second line');
      assert.equal(await other.inputValue(), 'First line\nSecond line');
      await other.press('ArrowUp'); assert.equal(await other.evaluate(node => document.activeElement === node), true, 'arrows edit multiline text');
      if (width < 700) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '340px'));
        await page.waitForTimeout(80);
        const inset = await page.locator('#entry-dialog').evaluate(node => {
          const sheet = node.getBoundingClientRect(), actions = node.querySelector('.entry-dialog-actions').getBoundingClientRect();
          return { bottom: sheet.bottom, top: sheet.top, actionsTop: actions.top, actionsBottom: actions.bottom, transcriptHeight: document.querySelector('#entry-output').clientHeight, width: document.documentElement.scrollWidth };
        });
        assert.ok(Math.abs(inset.bottom - 360) < 2, JSON.stringify(inset));
        assert.ok(inset.actionsTop >= inset.top && inset.actionsBottom <= inset.bottom, 'actions remain above a simulated large keyboard');
        assert.ok(inset.transcriptHeight >= 58, 'leaves transcript room');
        assert.equal(inset.width, width);
      }
      await other.press('Enter'); await closed();
      assert.equal(replies.at(-1).value[questions[3].question], 'Keep, First line\nSecond line');
      assert.equal(await page.locator('#entry-input').inputValue(), 'Draft before questions');
      if (width < 700) {
        await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '0px'));
        await page.setViewportSize({ width, height: 844 });
      }
    }
    assert.deepEqual(f.errors, []);
  });
}

test('question draft survives usage and session navigation without answering another session', async t => {
  const { f, page, open, replies } = await setup(t, { site: true });
  await page.locator('#entry-input').fill('Draft A');
  await open('questions', { questions: [question(1)] });
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  await page.locator('.entry-dialog-other textarea').fill('Unfinished answer\nwith two lines');
  const stateA = f.tab;
  await page.locator('.entry-usage').click(); await page.locator('.usage-box').waitFor();
  f.push({ ...stateA, stats: { contextUsage: { percent: 42 } } });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => document.activeElement.closest('#entry-dialog') !== null), false);
  await page.locator('.usage-back').click();
  assert.equal(await page.locator('.entry-dialog-other textarea').inputValue(), 'Unfinished answer\nwith two lines');
  f.push({ ...stateA, sessionId: 'thread-b', tabs: [{ ...stateA.tabs[0], id: 'tab-b', sessionId: 'thread-b' }], ui: { dialogs: [] } });
  await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
  await page.locator('#entry-input').fill('Draft B');
  f.push(stateA);
  await page.locator('.entry-dialog-other textarea').waitFor();
  assert.equal(await page.locator('.entry-dialog-other textarea').inputValue(), 'Unfinished answer\nwith two lines');
  assert.equal(await page.locator('#entry-input').inputValue(), 'Draft A');
  assert.equal(replies.length, 0);
  assert.deepEqual(f.errors, []);
});

test('a question arriving while usage is open waits without focusing its hidden choices', async t => {
  const { f, page } = await setup(t, { site: true });
  await page.locator('.entry-usage').click(); await page.locator('.usage-box').waitFor();
  f.push({ ...f.tab, ui: { dialogs: [{ id: 'arrived-during-usage', method: 'questions', questions: [question(1)] }] } });
  await page.locator('#entry-dialog:not([hidden])').waitFor({ state: 'attached' });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#entry-dialog'))), false);
  assert.equal(await page.locator('#entry-dialog').isVisible(), false);
  await page.locator('.usage-back').click();
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  await page.locator('.entry-dialog-other textarea').fill('Waiting answer');
  assert.equal(await page.locator('.entry-dialog-other textarea').inputValue(), 'Waiting answer');
  assert.deepEqual(f.errors, []);
});

test('an arriving question stays inside its conversation and does not take Files keyboard focus', async t => {
  const { f, page, open } = await setup(t);
  await page.locator('.wm-files .workbench').waitFor();
  await page.evaluate(() => harness.showFiles());
  await page.waitForFunction(() => document.activeElement.classList.contains('workbench'));
  await open('questions', { questions: [question(1)] });
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('workbench')), true);
  const bounds = await page.locator('#entry-dialog').evaluate(node => {
    const q = node.getBoundingClientRect(), screen = node.parentElement.getBoundingClientRect();
    return { left: q.left, right: q.right, ownerLeft: screen.left, ownerRight: screen.right };
  });
  assert.ok(bounds.left >= bounds.ownerLeft && bounds.right <= bounds.ownerRight + 1);
  f.push({ ...f.tab, ui: { dialogs: [] } });
  await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('workbench')), true, 'expired question does not move focus back from Files');
  assert.deepEqual(f.errors, []);
});
