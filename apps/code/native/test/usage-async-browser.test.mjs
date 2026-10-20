import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Only usage.js and its real renderers: no app server, sockets, account or history.
// Deferred commands and manually driven timers make response ordering explicit.
async function fixture(t) {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://usage-fences.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<textarea id="entry-input"></textarea><div id="controls"></div><div class="entry-screen"></div>' });
    if (!/^\/js\/[a-z-]+\.js$/.test(path)) return route.abort();
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8') });
  });
  await page.goto('http://usage-fences.test/');
  await page.evaluate(async () => {
    const { mountUsage } = await import('/js/usage.js');
    const timers = new Map(); let nextTimer = 0;
    window.setTimeout = window.setInterval = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
    window.clearInterval = id => timers.delete(id);
    const state = { here: 'laptop', authority: 'pc', local: false };
    const owner = () => state.local ? state.here : state.authority;
    const pending = [];
    const usage = mountUsage({
      command: type => new Promise(resolve => pending.push({ type, owner: owner(), local: state.local, resolve })),
      identity: () => JSON.stringify([owner(), state.local]),
      cacheIdentity: () => JSON.stringify([state.here, owner(), state.local]),
      ownerLabel: owner, scopeLabel: () => `${owner()} · ${state.local ? 'local' : 'all'}`,
      selectScope: local => { state.local = local; },
    });
    document.querySelector('#controls').append(usage.button, usage.summary);
    window.fences = { state, pending, usage, tick: ms => { for (const timer of [...timers.values()]) if (timer.ms === ms) timer.fn(); } };
  });
  return page;
}
const limits = used => [{ agent: 'claude', signedIn: true, windows: [{ name: 'week', used, resetsAt: Date.now() + 86400000, windowDurationMins: 10080 }] }];
const history = tokens => ({ hours: [{ at: Date.now() - 1000, tokens, responses: 1, estimatedUSD: 0.01 }] });
const calls = page => page.evaluate(() => fences.pending.map(({ type, owner, local }) => ({ type, owner, local })));
async function settle(page, index, answer) {
  await page.evaluate(async ({ index, answer }) => {
    fences.pending[index].resolve(answer);
    // Drain both the request continuation and any immediately started Today read.
    await Promise.resolve(); await Promise.resolve();
  }, { index, answer });
}
const cached = (page, owner, local, here = 'laptop') => page.evaluate(({ owner, local, here }) =>
  JSON.parse(localStorage.getItem(`imperfect:usage-reflection:v1:${JSON.stringify([here, owner, local])}`) || 'null'), { owner, local, here });
const scope = (page, name) => page.getByRole('group', { name: 'Usage computer', exact: true }).getByRole('button', { name, exact: true }).click();
const metric = (page, name) => page.getByRole('group', { name: 'Usage metric', exact: true }).getByRole('button', { name, exact: true }).click();
const today = page => page.locator('.usage-today-tokens').textContent();

// All top-level cases are sequential; only the parent's serial runner executes them.
test('sidebar scope switch fences delayed PC limits from the laptop reflection while Usage is closed', async t => {
  const page = await fixture(t);
  await page.evaluate(() => fences.tick(1500));
  await page.evaluate(() => { fences.state.local = true; fences.usage.sync(); });
  assert.deepEqual(await calls(page), [
    { type: 'usage', owner: 'pc', local: false },
    { type: 'usage', owner: 'laptop', local: true },
  ], 'scope change reloads immediately, without waiting for the sidebar throttle');
  await settle(page, 0, limits(11));
  assert.equal(await cached(page, 'laptop', true), null, 'late PC data cannot populate the local cache');
  assert.equal(await page.locator('.usage-summary').textContent(), 'Usage');
  // An old finally must not release the new scope's in-flight request.
  await page.evaluate(() => fences.tick(1500));
  assert.equal((await calls(page)).length, 2);
  await settle(page, 1, limits(22));
  assert.equal((await cached(page, 'laptop', true)).limits.data[0].windows[0].used, 22);
  assert.match(await page.locator('.usage-summary').textContent(), /78%/);
  assert.equal(await page.locator('.usage-box').count(), 0);
});

test('sidebar owner A -> B -> A and cache-only changes invalidate old request tokens', async t => {
  const page = await fixture(t);
  await page.evaluate(() => fences.tick(1500)); // PC request 0
  await page.evaluate(() => { fences.state.authority = 'other'; fences.usage.sync(); }); // 1
  await page.evaluate(() => { fences.state.authority = 'pc'; fences.usage.sync(); }); // 2
  await settle(page, 2, limits(30));
  await settle(page, 0, limits(10));
  await settle(page, 1, limits(20));
  assert.equal((await cached(page, 'pc', false)).limits.data[0].windows[0].used, 30);
  assert.match(await page.locator('.usage-summary').textContent(), /70%/);
  await page.evaluate(() => { fences.state.here = 'another-viewer'; fences.usage.sync(); }); // identity unchanged, cache changed
  assert.equal((await calls(page)).length, 4);
  assert.equal(await page.locator('.usage-summary').textContent(), 'Usage', 'never display the old cache scope while reloading');
  await settle(page, 3, limits(40));
  assert.equal((await cached(page, 'pc', false, 'another-viewer')).limits.data[0].windows[0].used, 40);
  assert.equal((await cached(page, 'pc', false)).limits.data[0].windows[0].used, 30);
});

test('close/reopen starts a new Today read and an old callback cannot replace its fresh data', async t => {
  const page = await fixture(t);
  await page.locator('#entry-input').fill('keep this draft');
  await page.evaluate(() => fences.usage.button.click());
  await settle(page, 0, limits(10)); // Today 1 remains pending
  await page.evaluate(() => { fences.usage.close(); fences.usage.button.click(); });
  await settle(page, 2, limits(20)); // New Today 3 must not be blocked by Today 1
  assert.deepEqual((await calls(page)).map(c => c.type), ['usage', 'usage-history', 'usage', 'usage-history']);
  await settle(page, 3, history(777));
  assert.equal(await today(page), '777');
  await settle(page, 1, history(111));
  assert.equal(await today(page), '777');
  assert.equal((await cached(page, 'pc', false)).history.data.hours[0].tokens, 777);
  assert.equal(await page.locator('#entry-input').inputValue(), 'keep this draft');
});

test('Today scope A -> B -> A refuses stale history even after returning to the same identity', async t => {
  const page = await fixture(t);
  await page.evaluate(() => fences.usage.button.click());
  await settle(page, 0, limits(10)); // Today 1, PC
  await scope(page, 'This computer only'); // Sidebar 2, page 3
  await settle(page, 3, limits(20)); // Today 4, laptop
  await scope(page, 'All computers'); // Sidebar 5, page 6
  await settle(page, 6, limits(30)); // Today 7, PC again
  assert.deepEqual((await calls(page)).filter(c => c.type === 'usage-history').map(c => c.owner), ['pc', 'laptop', 'pc']);
  await settle(page, 7, history(700));
  await settle(page, 1, history(100));
  await settle(page, 4, history(400));
  assert.equal(await today(page), '700');
  assert.equal((await cached(page, 'pc', false)).history.data.hours[0].tokens, 700);
  assert.equal((await cached(page, 'laptop', true)).history, undefined);
  await settle(page, 5, limits(99)); // Older sidebar request must not replace newer page limits either.
  assert.equal((await cached(page, 'pc', false)).limits.data[0].windows[0].used, 30);
});

test('Limits still reads Today once, reuses it across metrics, and keeps the sidebar refresh', async t => {
  const page = await fixture(t);
  await page.evaluate(() => fences.usage.button.click());
  await settle(page, 0, limits(10));
  assert.equal((await calls(page))[1].type, 'usage-history', 'initial Limits includes the new Today history read');
  await settle(page, 1, history(500));
  for (const name of ['Cost', 'Graphs', 'Limits']) await metric(page, name);
  assert.equal((await calls(page)).length, 2, 'switching metrics does not rescan fresh history');
  assert.equal(await today(page), '500');
  await page.evaluate(() => fences.tick(1500));
  assert.equal((await calls(page))[2].type, 'usage', 'the scheduled sidebar read remains independent');
  await settle(page, 2, limits(25));
  assert.match(await page.locator('.usage-summary').textContent(), /75%/);
  assert.equal(await today(page), '500');
});

test('a newer sidebar reflection replaces the value Cost will reuse for Limits', async t => {
  const page = await fixture(t);
  await page.evaluate(() => fences.tick(1500));
  await settle(page, 0, []); // An earlier signed-out/empty limits reading.
  await page.evaluate(() => {
    localStorage.setItem('imperfect:usage-page:v1', JSON.stringify({ metric: 'cost', period: 30 }));
    fences.usage.button.click();
  });
  await settle(page, 1, history(500));
  await page.evaluate(() => fences.tick(1500));
  await settle(page, 2, limits(37));
  await metric(page, 'Limits');
  assert.equal(await page.getByRole('meter').first().getAttribute('aria-valuenow'), '63');
  assert.equal((await calls(page)).length, 3, 'fresh reflection is reused, not rescanned');
});
