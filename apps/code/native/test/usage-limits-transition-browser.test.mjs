import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { aggregateUsage, usageRecord } from '../usage-history.mjs';

for (const detail of [false, true]) test(`real harness keeps subscription limits available after Cost${detail ? ' and a model detail' : ''}`, async t => {
  const f = await harnessFixture({ site: true, viewport: { width: 1200, height: 900 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  t.after(() => f.close());
  const now = Date.now();
  const history = { ...aggregateUsage([usageRecord({ type: 'message', id: 'answer', timestamp: now, message: { role: 'assistant', provider: 'fixture', model: 'rated', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } } }, { agent: 'pi' })], { now, models: [{ provider: 'fixture', id: 'rated', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] }), historyCoverage: { complete: true } };
  const calls = [];
  f.answer = c => {
    calls.push(c.type);
    if (c.type === 'usage-history') return history;
    if (c.type === 'usage') return [{ agent: 'claude', signedIn: true, windows: [{ name: '5 hours', used: 37, resetsAt: now + 3600000 }] }];
  };
  const page = f.page, pane = page.locator('.usage-box');
  await page.evaluate(() => localStorage.setItem('imperfect:usage-page:v1', JSON.stringify({ metric: 'cost', period: 30 })));
  await page.locator('.entry-usage').click();
  await pane.locator('.usage-headline').waitFor();
  if (detail) {
    await pane.getByRole('button', { name: 'rated', exact: true }).click();
    await pane.getByRole('dialog', { name: 'rated', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await pane.getByRole('dialog').count(), 0);
  }
  await pane.getByRole('button', { name: 'Limits', exact: true }).click();
  try { await pane.getByRole('meter').first().waitFor({ timeout: 3000 }); }
  catch (error) {
    console.error('Synthetic Limits transition:', JSON.stringify({ calls, state: await pane.evaluate(n => ({ html: n.outerHTML, meters: [...n.querySelectorAll('[role="meter"]')].map(m => ({ box: m.getBoundingClientRect().toJSON(), inert: m.inert })) })) }));
    throw error;
  }
  assert.equal(await pane.getByRole('meter').first().getAttribute('aria-valuenow'), '63');
  assert.ok(calls.includes('usage'));
  assert.deepEqual(f.errors, []);
});
