import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

for (const phone of [false, true]) {
  async function setup(t) {
    const f = await harnessFixture({ messages: [{ role: 'assistant', content: 'A conversation' }], viewport: { width: phone ? 390 : 1200, height: 900 }, hasTouch: phone });
    t.after(() => f.close());
    const tabs = [...f.tab.tabs, { ...f.tab.tabs[0], id: 'tab-b', sessionId: 'thread-b', focused: false, name: 'B' }];
    const a = { ...f.tab, tabs }, b = { ...f.tab, sessionId: 'thread-b', tabs: tabs.map(tab => ({ ...tab, focused: tab.id === 'tab-b' })), messages: [{ role: 'assistant', content: 'B conversation' }] };
    f.push(a);
    const calls = [];
    f.answer = c => {
      calls.push(c);
      if (c.type === 'tab-focus') { f.tab = c.tabId === 'tab-a' ? a : b; return { snapshot: f.tab }; }
    };
    const go = async id => {
      await f.page.evaluate(id => document.querySelector(`[data-tab-id="${id}"] .session-rail-open`).click(), id);
      await f.page.waitForFunction(id => harness.guiSnapshot().sessionId === id, id === 'tab-a' ? 'thread-a' : 'thread-b');
      await f.page.waitForTimeout(50);
    };
    await f.page.waitForSelector('[data-tab-id="tab-b"] .session-rail-open');
    await f.page.waitForTimeout(150); // the rail may follow the newly discovered B
    await go('tab-a');
    return { f, page: f.page, calls, a, b, go };
  }

  test(`${phone ? 'phone' : 'desktop'} leaves stalled requests and restores failed prompts only to their original draft`, async t => {
    const { f, page, calls, go } = await setup(t);
    const answer = f.answer;
    let models, prompt;
    f.answer = c => c.type === 'models' ? new Promise(resolve => { models = resolve; }) : c.type === 'prompt' ? (calls.push(c), new Promise(resolve => { prompt = resolve; })) : answer(c);
    await page.locator('#entry-input').fill('A draft');
    await page.locator('#entry-pi-label').click();
    await page.waitForTimeout(100);
    assert.ok(models);
    await go('tab-b');
    await page.locator('#entry-input').fill('B draft');
    models([{ provider: 'fixture', id: 'fixture' }]);
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#entry-dialog').isVisible(), false, 'late picker cannot appear in another session');
    await go('tab-a');
    assert.equal(await page.locator('#entry-input').inputValue(), 'A draft');
    await page.locator('#entry-input').press('Enter');
    await page.waitForTimeout(80);
    assert.ok(prompt);
    await go('tab-b');
    prompt({ accepted: false, error: 'fixture refused' });
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#entry-input').inputValue(), 'B draft');
    await go('tab-a');
    assert.equal(await page.locator('#entry-input').inputValue(), 'A draft');
    const sent = calls.find(c => c.type === 'prompt');
    assert.equal(sent.expectedSessionId, 'thread-a');
    assert.equal(sent.expectedTabId, 'tab-a');
    assert.deepEqual(f.errors, []);
  });

  test(`${phone ? 'phone' : 'desktop'} can leave a dialog without cancelling it, preserving its answer and original target`, async t => {
    const { f, page, calls, a, go } = await setup(t);
    a.ui = { dialogs: [{ id: 'same-dialog-id', method: 'input', title: 'A question' }] };
    f.push(a);
    await page.locator('#entry-dialog textarea').fill('unfinished answer');
    await page.evaluate(() => { window.originalAnswer = document.querySelector('#entry-dialog .entry-dialog-actions button'); });
    await go('tab-b');
    assert.equal(await page.locator('#entry-dialog').isVisible(), false);
    assert.equal(calls.some(c => c.type === 'dialog'), false, 'leaving is not cancellation');
    await page.locator('#entry-input').fill('B draft');
    await go('tab-a');
    assert.equal(await page.locator('#entry-dialog textarea').inputValue(), 'unfinished answer');
    await go('tab-b');
    // Even an already-dispatched callback from the detached sheet targets A.
    await page.evaluate(() => window.originalAnswer.click());
    await page.waitForTimeout(80);
    const reply = calls.find(c => c.type === 'dialog');
    assert.equal(reply.value, 'unfinished answer');
    assert.equal(reply.expectedSessionId, 'thread-a');
    assert.equal(reply.expectedTabId, 'tab-a');
    assert.equal(await page.locator('#entry-input').inputValue(), 'B draft');
    assert.deepEqual(f.errors, []);
  });

  test(`${phone ? 'phone' : 'desktop'} late dialog callbacks cannot dismiss another session's sheet with the same ID`, async t => {
    const { f, page, calls, a, b, go } = await setup(t);
    const ask = { id: 'same-id', method: 'input', title: 'Question' };
    a.ui = { dialogs: [ask] }; b.ui = { dialogs: [{ ...ask }] };
    f.push(a);
    await page.locator('#entry-dialog textarea').fill('A answer');
    await page.evaluate(() => { window.originalAnswer = document.querySelector('#entry-dialog .entry-dialog-actions button'); });
    await go('tab-b');
    await page.locator('#entry-dialog textarea').fill('B answer');
    await page.evaluate(() => window.originalAnswer.click());
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#entry-dialog textarea').inputValue(), 'B answer');
    const reply = calls.find(c => c.type === 'dialog');
    assert.equal(reply.expectedTabId, 'tab-a');
    assert.equal(reply.value, 'A answer');
    await page.locator('#entry-dialog .entry-dialog-actions button').first().click();
    await page.waitForTimeout(80);
    assert.equal(calls.filter(c => c.type === 'dialog').at(-1).expectedTabId, 'tab-b');
    assert.equal(calls.filter(c => c.type === 'dialog').at(-1).value, 'B answer');
    assert.deepEqual(f.errors, []);
  });

  test(`${phone ? 'phone' : 'desktop'} leaves an upload running in its original session`, async t => {
    const { f, page, go } = await setup(t);
    let finish, session;
    await page.route('**/upload', route => new Promise(resolve => {
      session = route.request().headers()['x-session-id'];
      finish = async () => { await route.fulfill({ json: { path: '/fixture/A.txt', size: 4 } }); resolve(); };
    }));
    await page.evaluate(() => { void harness.attachFiles([new File(['file'], 'A.txt', { type: 'text/plain' })]); });
    await page.waitForTimeout(100);
    assert.ok(finish);
    await go('tab-b');
    await page.locator('#entry-input').fill('B draft');
    await finish();
    await page.waitForTimeout(80);
    assert.equal(session, 'thread-a');
    assert.equal(await page.locator('#entry-input').inputValue(), 'B draft');
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 0);
    await go('tab-a');
    assert.equal(await page.evaluate(() => harness.composerStatus().attachments), 1);
    assert.match(await page.locator('#entry-pending').textContent(), /A.txt/);
    assert.deepEqual(f.errors, []);
  });

  test(`${phone ? 'phone' : 'desktop'} keeps a stalled voice attachment in the original composer`, async t => {
    const { f, page, go } = await setup(t);
    let finish;
    await page.route('**/transcribe', route => new Promise(resolve => { finish = async () => { await route.fulfill({ json: { text: 'A voice attachment' } }); resolve(); }; }));
    await page.evaluate(() => { void harness.attachFiles([new File(['audio'], 'note.wav', { type: 'audio/wav' })]); });
    await page.waitForTimeout(100);
    assert.ok(finish);
    await go('tab-b');
    await page.locator('#entry-input').fill('B draft');
    await finish();
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#entry-input').inputValue(), 'B draft');
    await go('tab-a');
    assert.match(await page.locator('#entry-input').inputValue(), /A voice attachment/);
    assert.deepEqual(f.errors, []);
  });
}
