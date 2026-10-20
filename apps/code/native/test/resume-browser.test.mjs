// Coming back to a window: the real page (harness.js) against a fake
// computer whose sockets can die under it (fixtures/harness-page.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';

const said = text => [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text }] }];
const wait = async condition => {
  const deadline = Date.now() + 30000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'protocol barrier reached within 30 seconds');
    await delay(25);
  }
};
// Control only the behaviour clock: real layout/animation frames and socket
// delivery still run. Install after the initial view is fresh, so its timers
// have ended; preserve cancellation of any older, unrelated native timers.
const controlTime = async page => {
  await page.waitForFunction(() => document.querySelector('#entry-output').dataset.fresh === 'fresh', null, { timeout: 30000 });
  await page.evaluate(() => {
    let now = Date.now();
    const timers = new Map(), clear = window.clearTimeout.bind(window);
    Date.now = () => now;
    window.setTimeout = (fn, ms = 0, ...args) => {
      const id = {};
      timers.set(id, { at: now + Number(ms), fn: () => fn(...args) });
      return id;
    };
    window.clearTimeout = id => { if (!timers.delete(id)) clear(id); };
    window.advanceTime = async ms => {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at; timers.delete(id); timer.fn();
        // Freshness attempts and transport timeouts continue in microtasks.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = end;
    };
  });
};
const advance = (page, ms) => page.evaluate(ms => window.advanceTime(ms), ms);
// Screen off/on is an event boundary, not a real-wall sleep.
const hideAndShow = page => page.evaluate(() => {
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
});
const watch = page => page.evaluate(() => {
  const bar = document.querySelector('.loading-bar'), output = document.querySelector('#entry-output');
  window.watched = { bar: false, marks: new Set() };
  const look = () => { if (!bar.hidden) window.watched.bar = true; window.watched.marks.add(output.dataset.fresh); requestAnimationFrame(look); };
  look();
});
const watched = page => page.evaluate(() => ({ bar: window.watched.bar, marks: [...window.watched.marks] }));
const shows = (page, text) => page.waitForFunction(text => document.querySelector('#entry-output').textContent.includes(text), text, { timeout: 30000, polling: 'raf' });
const fresh = page => page.waitForFunction(() => document.querySelector('#entry-output').dataset.fresh === 'fresh', null, { timeout: 30000 });
const line = page => page.evaluate(() => { const line = document.querySelector('.entry-connection'); return line.hidden ? '' : line.textContent; });

test('looked at again with a dead socket: marked stale at once, replaced without waiting long, current again', { timeout: 120000 }, async () => {
  const fixture = await harnessFixture({ messages: said('before the screen went off') });
  const { page } = fixture;
  try {
    await controlTime(page);
    await watch(page);
    const hellos = fixture.commands.filter(c => c.type === 'hello').length;
    await hideAndShow(page);
    await wait(() => fixture.commands.filter(c => c.type === 'hello').length > hellos);
    await fresh(page);
    await advance(page, 400);
    assert.equal((await watched(page)).bar, false, 'a quick check never shows the bar');
    assert.equal(await page.evaluate(() => document.querySelector('#entry-output').dataset.fresh), 'fresh');
    fixture.mute();
    fixture.push({ ...fixture.tab, messages: said('while it was off') });
    await watch(page);
    await hideAndShow(page);
    assert.equal(await page.evaluate(() => document.querySelector('#entry-output').dataset.fresh), 'stale', 'marked at once, before anything is known');
    await advance(page, 150);
    await page.waitForFunction(() => window.watched.bar, null, { timeout: 30000 });
    await advance(page, 1349);
    assert.ok((await page.locator('#entry-output').textContent()).includes('before the screen went off'), 'dead socket is still being checked before its deadline');
    // At the 1500 ms socket deadline it is replaced, not after a backoff.
    await advance(page, 1);
    await shows(page, 'while it was off');
    await fresh(page);
    assert.equal((await watched(page)).bar, true, 'the bar showed while it was not known');
    assert.equal(await page.locator('.loading-bar').isHidden(), true);
    assert.equal(await page.evaluate(() => document.querySelector('#entry-output').classList.contains('entry-stale')), false);
    assert.equal(await line(page), '');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('looked at again as the clock ticks: the first answer counts, so nothing is tried twice', { timeout: 120000 }, async () => {
  const fixture = await harnessFixture({ messages: said('on screen') });
  const { page } = fixture;
  try {
    await fresh(page);
    await page.evaluate(() => { let at = Date.now(); Date.now = () => ++at; });
    const hellos = () => fixture.commands.filter(c => c.type === 'hello').length;
    const before = hellos();
    await hideAndShow(page);
    await wait(() => hellos() > before);
    await fresh(page);
    assert.equal(hellos() - before, 1, 'one question, one answer');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a computer that cannot be reached says so, keeps trying, and comes back on retry', { timeout: 120000 }, async () => {
  const fixture = await harnessFixture({ messages: said('the last that came') });
  const { page } = fixture;
  try {
    await controlTime(page);
    const attempts = [];
    page.on('websocket', socket => {
      const attempt = { closed: false };
      attempts.push(attempt);
      socket.on('close', () => { attempt.closed = true; });
    });
    fixture.mute();
    fixture.refuse = true;
    await hideAndShow(page);
    await advance(page, 300);
    assert.equal(await line(page), '', 'not in the first moments');
    assert.equal(await page.locator('.loading-bar').isVisible(), true);
    await advance(page, 1700);
    assert.match(await line(page), /this computer · reconnecting…/);
    assert.equal(await page.locator('.entry-connection-retry').isVisible(), false);
    await wait(() => attempts.length > 0 && attempts.every(attempt => attempt.closed));
    await advance(page, 8000);
    assert.equal(await page.evaluate(() => document.querySelector('.entry-connection').dataset.phase), 'unreachable');
    assert.match(await line(page), /can't reach this computer/);
    assert.equal(await page.locator('.entry-connection-retry').isVisible(), true);
    assert.ok(await page.evaluate(() => document.querySelector('#entry-output').classList.contains('entry-stale')), 'still marked');
    assert.ok((await page.locator('#entry-output').textContent()).includes('the last that came'), 'what was there stays to be read');
    // Drain the refused connection before retrying, without advancing to a
    // scheduled backoff. Retry must itself open/check a connection.
    await wait(() => attempts.length > 1 && attempts.every(attempt => attempt.closed));
    fixture.refuse = false;
    fixture.tab = { ...fixture.tab, messages: said('back again') };
    await page.locator('.entry-connection-retry').click();
    await shows(page, 'back again');
    await fresh(page);
    assert.equal(await line(page), '');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('on a phone, a session seen before is shown at once, marked stale, until its answer comes', { timeout: 120000 }, async () => {
  const fixture = await harnessFixture({ messages: said('session a'), viewport: { width: 390, height: 800 }, hasTouch: true });
  const { page } = fixture;
  try {
    await controlTime(page);
    const tabs = focus => [{ ...fixture.tab.tabs[0], focused: focus === 'tab-a' }, { id: 'tab-b', sessionId: 'thread-b', agent: 'pi', name: 'B', prompt: 'b', status: 'idle', focused: focus === 'tab-b' }];
    const views = { 'tab-a': { ...fixture.tab, sessionId: 'thread-a', messages: said('session a') }, 'tab-b': { ...fixture.tab, sessionId: 'thread-b', messages: said('session b') } };
    const late = [];
    fixture.answer = c => (c.type !== 'tab-focus' ? undefined
      : new Promise(resolve => late.push({ tabId: c.tabId, release: () => resolve({ id: c.tabId, focused: true, snapshot: { ...views[c.tabId], tabs: tabs(c.tabId) } }) })));
    fixture.push({ ...views['tab-a'], tabs: tabs('tab-a') });
    const enter = id => page.locator(`.session-rail-item[data-tab-id="${id}"] .session-rail-open`).click();
    const answer = async id => {
      await wait(() => late.some(reply => reply.tabId === id));
      late.splice(late.findIndex(reply => reply.tabId === id), 1)[0].release();
    };
    await page.waitForSelector('.session-rail-item[data-tab-id="tab-b"]', { timeout: 30000 });
    await enter('tab-b');
    await wait(() => late.some(reply => reply.tabId === 'tab-b'));
    await advance(page, 150);
    assert.ok((await page.locator('#entry-output').textContent()).includes('session a'));
    assert.equal(await page.evaluate(() => document.querySelector('#entry-output').dataset.fresh), 'stale');
    assert.equal(await page.locator('.loading-bar').isVisible(), true);
    await answer('tab-b');
    await shows(page, 'session b');
    await fresh(page);
    await enter('tab-a');
    // The answer is still held: this must be the cached view, not a fast
    // server response or a machine-dependent 100 ms wall-clock race.
    assert.ok((await page.locator('#entry-output').textContent()).includes('session a'), 'cached session shown before its answer');
    await wait(() => late.some(reply => reply.tabId === 'tab-a'));
    await advance(page, 150);
    assert.equal(await page.evaluate(() => document.querySelector('#entry-output').dataset.fresh), 'stale');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#entry-output')).opacity < 1, null, { timeout: 30000 });
    assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#entry-output')).opacity < 1), 'dimmed');
    await answer('tab-a');
    await page.waitForFunction(() => document.querySelector('#entry-output').dataset.fresh === 'fresh' && getComputedStyle(document.querySelector('#entry-output')).opacity === '1', null, { timeout: 30000 });
    assert.equal(await page.locator('.loading-bar').isHidden(), true);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
