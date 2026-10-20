import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { themeCss } from '../../../../system/theme.mjs';
const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url), 'utf8')));
import { harnessFixture } from './fixtures/harness-page.mjs';
const row = { agent: 'pi', signedIn: true, accountId: 'fixture-account', windows: [{ name: '5 hours', used: 63, resetsAt: Date.now() + 3600000 }], resetCredits: { availableCount: 5, nextCreditId: 'fixture-credit', nextExpiresAt: Date.now() + 86400000 } };
async function fixture(t, width = 1200) {
  const f = await harnessFixture({ site: true, themeCSS, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Synthetic reset fixture; not live account data.' }] }], hasTouch: width < 500, viewport: { width, height: 900 } });
  t.after(() => f.close());
  const calls = []; f.answer = c => { calls.push(c); return c.type === 'usage' ? [row] : c.type === 'codex-reset-consume' ? { outcome: 'reset' } : undefined; };
  await f.page.locator('#entry-input').fill('composer draft never submitted');
  await f.page.evaluate(() => { window.composerFocus = 0; document.addEventListener('focusin', e => { if (e.target.id === 'entry-input') window.composerFocus++; }); });
  await f.page.locator('.entry-usage').click(); await f.page.getByText('5 resets available', { exact: false }).waitFor();
  return { f, page: f.page, calls, pane: f.page.locator('.usage-box') };
}
for (const width of [1200, 390]) test(`reset confirmation is explicit, exact-target, cancellable and draft-safe (${width}px)`, async t => {
  const { f, page, pane, calls } = await fixture(t, width);
  assert.equal(await pane.getByRole('meter').getAttribute('aria-valuenow'), '37');
  assert.ok(await pane.locator('.usage-content').evaluate(n => n.scrollWidth <= n.clientWidth), 'limits text wraps on narrow screens');
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  const group = pane.getByRole('group', { name: 'Confirm Codex reset' });
  assert.match(await group.innerText(), /fixture-credit.*fixture-account/);
  assert.match(await group.innerText(), /consumes one.*cannot be undone.*weekly reset date/);
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 0);
  await group.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await group.count(), 0); assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 0);
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  const shots = '/home/vaita/.imperfect/tasks/codex-banked-resets/shots'; await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/fixture-confirm-${width}.png` });
  await group.getByRole('button', { name: 'Confirm use reset', exact: true }).click();
  await pane.getByRole('status').getByText('Reset applied. Refresh limits to check the new windows.').waitFor();
  const sent = calls.filter(c => c.type === 'codex-reset-consume'); assert.equal(sent.length, 1);
  assert.equal(sent[0].accountId, 'fixture-account'); assert.equal(sent[0].creditId, 'fixture-credit'); assert.equal(sent[0].confirmed, true);
  assert.equal(sent[0].scope, 'computer'); assert.equal(sent[0].expectedTabId, undefined); assert.equal(sent[0].expectedSessionId, undefined);
  await pane.getByRole('button', { name: 'Back to conversation' }).click();
  assert.equal(await page.locator('#entry-input').inputValue(), 'composer draft never submitted');
  assert.equal(await page.evaluate(() => window.composerFocus), 0);
  assert.equal(calls.some(c => ['prompt', 'dialog', 'model', 'tab-new'].includes(c.type)), false); assert.deepEqual(f.errors, []);
});
for (const [outcome, message] of [['nothing_to_reset', 'Nothing to reset'], ['no_credit', 'No reset credit available'], ['already_redeemed', 'already redeemed'], ['uncertain', 'Result unknown']]) test(`UI outcome ${outcome} and uncertain retry keeps exact credit`, async t => {
  const { f, page, pane, calls } = await fixture(t);
  f.answer = c => { calls.push(c); return c.type === 'usage' ? [{ ...row, resetCredits: { ...row.resetCredits, nextCreditId: 'a-new-credit' } }] : c.type === 'codex-reset-consume' ? { outcome } : undefined; };
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click(); await pane.getByRole('button', { name: 'Confirm use reset', exact: true }).click();
  await pane.getByRole('status').getByText(message, { exact: false }).waitFor();
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 1);
  if (outcome === 'uncertain') {
    assert.equal(await pane.getByRole('button', { name: 'Use reset', exact: true }).count(), 0);
    await pane.getByRole('button', { name: 'Retry same reset' }).click(); await pane.getByRole('button', { name: 'Confirm retry' }).click();
    await pane.getByRole('button', { name: 'Retry same reset' }).waitFor();
    const attempts = calls.filter(c => c.type === 'codex-reset-consume');
    assert.deepEqual(attempts.map(c => c.creditId), ['fixture-credit', 'fixture-credit']);
    assert.equal(attempts[0].operationId, attempts[1].operationId, 'unknown retry retains the explicit intent ID');
  }
  assert.deepEqual(f.errors, []);
});
test('account-wide uncertain attempts survive view changes; failed refresh preserves known outcome and bars', async t => {
  const { f, page, pane, calls } = await fixture(t);
  f.answer = c => { calls.push(c); return c.type === 'usage' ? [{ ...row, resetAttempt: { creditId: 'previous-account-credit', operationId: 'previous-account-intent', uncertain: true } }] : c.type === 'codex-reset-consume' ? { outcome: 'reset' } : undefined; };
  await pane.getByRole('button', { name: 'Refresh limits' }).click();
  await pane.getByRole('button', { name: 'Retry same reset' }).click();
  assert.match(await pane.getByRole('group', { name: 'Confirm Codex reset' }).innerText(), /previous-account-credit/);
  f.answer = c => { calls.push(c); return c.type === 'usage' ? Promise.reject(new Error('private token trace')) : c.type === 'codex-reset-consume' ? { outcome: 'reset' } : undefined; };
  await pane.getByRole('button', { name: 'Confirm retry' }).click();
  await pane.getByText('Updated limits unavailable (computer may be offline) · try Refresh').waitFor();
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume')[0].creditId, 'previous-account-credit');
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume')[0].operationId, 'previous-account-intent');
  assert.equal(await pane.getByRole('meter').getAttribute('aria-valuenow'), '37');
  assert.doesNotMatch(await pane.innerText(), /private token trace/);
  assert.match(await pane.innerText(), /Reset applied/); assert.deepEqual(f.errors, []);
});
for (const [kind, operationId] of [['missing', undefined], ['empty', ''], ['oversized', 'x'.repeat(201)]]) test(`invalid ${kind} active intent shows unknown/refresh without inventing retry identity`, async t => {
  const { f, pane, calls } = await fixture(t);
  f.answer = c => {
    calls.push(c);
    return c.type === 'usage' ? [{ ...row, resetAttempt: { creditId: 'previous-account-credit', operationId, uncertain: true } }] : undefined;
  };
  await pane.getByRole('button', { name: 'Refresh limits' }).click();
  await pane.getByRole('status').getByText('Result unknown', { exact: false }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Retry same reset' }).count(), 0);
  assert.equal(await pane.getByRole('button', { name: 'Use reset', exact: true }).count(), 0);
  assert.match(await pane.innerText(), /Reset target unavailable or expired · try Refresh/);
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 0);
  assert.equal(await pane.getByRole('meter').getAttribute('aria-valuenow'), '37');
  assert.deepEqual(f.errors, []);
});
test('switching conversation with colliding session/tab IDs cancels confirmation, without changing usage computer', async t => {
  const f = await harnessFixture({ site: true, themeCSS, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Synthetic owner fixture.' }] }], machines: [{ id: 'a', name: 'fixture-desktop', self: true, reachable: true }, { id: 'b', name: 'fixture-laptop', reachable: true }] });
  t.after(() => f.close()); const { page } = f, calls = [];
  f.answer = c => { calls.push(c); return c.type === 'usage' ? [row] : c.type === 'tab-focus' ? { id: c.tabId, focused: true, snapshot: f.tab } : undefined; };
  await page.locator('#entry-input').fill('desktop draft');
  await page.locator('.entry-usage').click(); await page.getByRole('button', { name: 'Use reset', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirm Codex reset' });
  await confirm.waitFor(); assert.match(await confirm.innerText(), /computer fixture-desktop/);
  await page.locator('.session-rail-item[data-owner="b"] .session-rail-open').click();
  await page.locator('.session-rail-item.active[data-owner="b"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('.usage-reset-confirm'));
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 0);
  await page.locator('.session-rail-item[data-owner="a"] .session-rail-open').click();
  await page.locator('.session-rail-item.active[data-owner="a"]').waitFor();
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  assert.equal(await page.locator('#entry-input').inputValue(), 'desktop draft'); assert.deepEqual(f.errors, []);
});
test('session switching invalidates confirmation without consuming and preserves draft; unknown count retains bars', async t => {
  const { f, page, pane, calls } = await fixture(t);
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  const state = f.tab;
  f.answer = c => { calls.push(c); return c.type === 'usage' ? [{ ...row, resetCredits: null }] : undefined; };
  f.push({ ...state, sessionId: 'thread-b', tabs: [{ ...state.tabs[0], id: 'tab-b', sessionId: 'thread-b' }] });
  await pane.getByText('Banked resets unavailable · try Refresh').waitFor();
  assert.equal(await pane.getByRole('group', { name: 'Confirm Codex reset' }).count(), 0);
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').length, 0);
  assert.equal(await pane.getByRole('meter').getAttribute('aria-valuenow'), '37');
  assert.doesNotMatch(await pane.innerText(), /Bearer|not-a-token/); assert.deepEqual(f.errors, []);
});

for (const outcome of ['nothing_to_reset', 'not_applied']) test(`UI ${outcome} permits a fresh explicit intent, not an uncertain retry`, async t => {
  const { f, page, pane, calls } = await fixture(t);
  let consumes = 0;
  f.answer = c => {
    calls.push(c);
    if (c.type === 'usage') return [{ ...row, resetCredits: { ...row.resetCredits, nextCreditId: outcome === 'not_applied' ? 'fresh-credit' : 'fixture-credit' } }];
    if (c.type === 'codex-reset-consume') return { outcome: ++consumes === 1 ? outcome : 'reset' };
  };
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  await pane.getByRole('button', { name: 'Confirm use reset', exact: true }).click();
  await pane.getByRole('status').getByText(outcome === 'not_applied' ? 'Reset not sent' : 'Nothing to reset', { exact: false }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Retry same reset' }).count(), 0);
  if (outcome === 'not_applied') {
    await page.evaluate(() => {
      const banner = document.createElement('div'); banner.textContent = 'SYNTHETIC FIXTURE — no live account requests';
      banner.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:black;color:white;padding:8px'; document.body.append(banner);
    });
    await page.screenshot({ path: '/home/vaita/.imperfect/tasks/codex-banked-resets/shots/fixture-not-applied-1200.png' });
  }
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  await pane.getByRole('button', { name: 'Confirm use reset', exact: true }).click();
  await pane.getByRole('status').getByText('Reset applied', { exact: false }).waitFor();
  const sent = calls.filter(c => c.type === 'codex-reset-consume');
  assert.equal(sent.length, 2); assert.ok(sent.every(c => typeof c.operationId === 'string' && c.operationId.length > 0));
  assert.notEqual(sent[0].operationId, sent[1].operationId, 'new confirmation is not a resend');
  assert.equal(sent[1].creditId, outcome === 'not_applied' ? 'fresh-credit' : 'fixture-credit');
  assert.deepEqual(f.errors, []);
});

test("a local old noop receipt cannot mask another view's uncertain same-credit intent", async t => {
  const { f, pane, calls } = await fixture(t);
  let active = false;
  f.answer = c => {
    calls.push(c);
    if (c.type === 'usage') return [{ ...row, ...(active ? { resetAttempt: { creditId: 'fixture-credit', operationId: 'another-view-intent', uncertain: true } } : {}) }];
    if (c.type === 'codex-reset-consume') return { outcome: 'nothing_to_reset' };
  };
  await pane.getByRole('button', { name: 'Use reset', exact: true }).click();
  await pane.getByRole('button', { name: 'Confirm use reset', exact: true }).click();
  await pane.getByRole('status').getByText('Nothing to reset', { exact: false }).waitFor();
  active = true; await pane.getByRole('button', { name: 'Refresh limits' }).click();
  await pane.getByRole('status').getByText('Result unknown', { exact: false }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Use reset', exact: true }).count(), 0);
  await pane.getByRole('button', { name: 'Retry same reset' }).click();
  await pane.getByRole('button', { name: 'Confirm retry' }).click();
  await pane.getByRole('status').getByText('Nothing to reset', { exact: false }).waitFor();
  assert.equal(calls.filter(c => c.type === 'codex-reset-consume').at(-1).operationId, 'another-view-intent');
  assert.deepEqual(f.errors, []);
});
