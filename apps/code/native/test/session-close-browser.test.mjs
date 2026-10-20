import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }] }];
const closes = fixture => fixture.commands.filter(c => c.type === 'tab-close');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real touch input to a production harness on loopback; all backend sessions
// are fake. Hold a finger while snapshots/selection change before release.
async function finger(fixture, selector = '[data-tab-id="tab-a"]') {
  const { page } = fixture;
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box);
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + 25, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  return {
    async move(distance = 240) {
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + distance * i / 6, y }] });
    },
    async end(cancel = false) {
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      await wait(300);
      await cdp.detach();
    },
  };
}

async function busy(fixture, fields = {}) {
  const snap = { ...fixture.tab, instanceId: 'host-a', busy: true, streaming: true, ...fields };
  snap.tabs = snap.tabs.map(tab => ({ ...tab, busy: true, status: 'working' }));
  fixture.push(snap);
  await fixture.page.waitForFunction(() => document.querySelector('[data-tab-id="tab-a"]')?.dataset.state === 'working');
  return snap;
}

const phone = () => harnessFixture({ messages, viewport: { width: 390, height: 800 }, hasTouch: true });

test('phone busy swipe is an explicit, identity-bound close; short and cancelled gestures do not close', { timeout: 30000 }, async () => {
  const fixture = await phone();
  try {
    await busy(fixture);
    await fixture.page.evaluate(() => harness.toggleRail());
    let drag = await finger(fixture); await drag.move(20); await drag.end();
    assert.deepEqual(closes(fixture), []);
    drag = await finger(fixture); await drag.move(); await drag.end(true);
    assert.deepEqual(closes(fixture), []);
    drag = await finger(fixture); await drag.move(); await drag.end();
    assert.equal(closes(fixture).length, 1);
    const close = closes(fixture)[0];
    assert.equal(close.tabId, 'tab-a');
    assert.equal(close.closeConfirmed, true);
    assert.equal(close.gesture, 'swipe');
    assert.equal(close.expectedTabId, 'tab-a');
    assert.equal(close.expectedSessionId, 'thread-a');
    assert.equal(close.expectedInstanceId, 'host-a');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

for (const change of ['session', 'host', 'fresh host']) test(`long swipe cannot cancel a reused tab after ${change} replacement`, { timeout: 30000 }, async () => {
  const fixture = await phone();
  try {
    const fresh = change === 'fresh host';
    const before = await busy(fixture, fresh ? { sessionId: null, tabs: [{ ...fixture.tab.tabs[0], sessionId: null }] } : {});
    await fixture.page.evaluate(() => harness.toggleRail());
    const drag = await finger(fixture);
    // Replace before motion too: pointer capture must not depend on a row
    // that an incoming snapshot may have removed from the DOM.
    const next = change === 'session' ? { ...before, sessionId: 'replacement', tabs: [{ ...before.tabs[0], sessionId: 'replacement' }] }
      : { ...before, instanceId: 'host-replacement' };
    fixture.push(next);
    await wait(150);
    await drag.move(); await drag.end();
    assert.deepEqual(closes(fixture), []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('the first session id arriving mid-swipe does not defeat a same-host cancellation', { timeout: 30000 }, async () => {
  const fixture = await phone();
  try {
    const before = await busy(fixture, { sessionId: null, tabs: [{ ...fixture.tab.tabs[0], sessionId: null }] });
    await fixture.page.evaluate(() => harness.toggleRail());
    const drag = await finger(fixture);
    fixture.push({ ...before, sessionId: 'created', tabs: [{ ...before.tabs[0], sessionId: 'created' }] });
    await wait(150);
    await drag.move(); await drag.end();
    assert.equal(closes(fixture).length, 1);
    assert.equal(closes(fixture)[0].expectedSessionId, null);
    assert.equal(closes(fixture)[0].expectedInstanceId, 'host-a');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('grabbed owner and tab survive a context switch and mutable row data', { timeout: 30000 }, async () => {
  const fixture = await harnessFixture({ messages, viewport: { width: 390, height: 800 }, hasTouch: true,
    machines: [{ id: 'desktop', self: true, reachable: true }, { id: 'laptop', self: false, reachable: true }] });
  const routed = [];
  try {
    const local = await busy(fixture);
    const peer = { ...local, instanceId: 'laptop-host', sessionId: 'laptop-session', tabs: [{ ...local.tabs[0], sessionId: 'laptop-session', name: 'Laptop', focused: true }] };
    fixture.answer = (c, owner) => {
      routed.push({ c, owner });
      if (c.type === 'snapshot') return owner ? peer : local;
      if (c.type === 'tab-focus') return { id: c.tabId, snapshot: owner ? peer : local };
    };
    fixture.sendFrom('laptop', { type: 'snapshot', data: peer });
    await fixture.page.waitForSelector('[data-owner="laptop"][data-tab-id="tab-a"]');
    await fixture.page.evaluate(() => harness.toggleRail());
    const drag = await finger(fixture, '[data-owner="desktop"][data-tab-id="tab-a"]');
    await drag.move();
    await fixture.page.locator('[data-owner="laptop"][data-tab-id="tab-a"] .session-rail-open').evaluate(node => node.click());
    await fixture.page.waitForFunction(() => harness.guiSnapshot().owner === 'laptop');
    await fixture.page.locator('[data-owner="desktop"][data-tab-id="tab-a"]').evaluate(node => { node.dataset.owner = 'laptop'; node.dataset.tabId = 'different'; });
    await drag.end();
    const sent = routed.filter(({ c }) => c.type === 'tab-close');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].owner, '', 'original serving owner, not the newly selected laptop');
    assert.equal(sent[0].c.tabId, 'tab-a');
    assert.equal(sent[0].c.expectedSessionId, 'thread-a');
    assert.equal(sent[0].c.expectedInstanceId, 'host-a');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('generic closeTab binds the intended busy tab and Mod+Esc uses confirmed close', { timeout: 30000 }, async () => {
  const fixture = await phone();
  try {
    await busy(fixture);
    await fixture.page.evaluate(() => harness.closeTab('tab-a', { closeConfirmed: true }));
    assert.equal(closes(fixture)[0].expectedSessionId, 'thread-a');
    assert.equal(closes(fixture)[0].expectedInstanceId, 'host-a');
    assert.equal(closes(fixture)[0].gesture, 'tool');
  } finally { await fixture.close(); }
  const site = await harnessFixture({ messages, site: true, desk: true });
  try {
    const snap = { ...site.tab, instanceId: 'keyboard-host', busy: true, tabs: site.tab.tabs.map(tab => ({ ...tab, busy: true })) };
    site.push(snap);
    await wait(100);
    await site.page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'l', metaKey: true, bubbles: true, cancelable: true }));
    });
    await wait(100);
    assert.equal(closes(site).length, 0, 'wtype Super+l must not close the focused session');
    await site.page.keyboard.press('Meta+Escape');
    for (let i = 0; i < 50 && !closes(site).length; i++) await wait(20);
    assert.equal(closes(site).length, 1);
    assert.equal(closes(site)[0].closeConfirmed, true);
    assert.equal(closes(site)[0].gesture, 'key');
    assert.equal(closes(site)[0].expectedSessionId, 'thread-a');
    assert.equal(closes(site)[0].expectedInstanceId, 'keyboard-host');
    assert.deepEqual(site.errors, []);
  } finally { await site.close(); }
});
