import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHandoff } from '../../../../system/server.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 200 && !check(); i++) await sleep(5); assert.ok(check()); };

for (const race of ['turn', 'session lifecycle', 'background']) {
  test(`work arriving at the final fence (${race}) lifts it and delays restart`, async () => {
    let fenced = false, active = false, background = [], inject = true, restarts = 0;
    const runtime = {
      events: new EventEmitter(),
      requestQuiesce() { fenced = true; if (inject) { inject = false; if (race === 'background') background = ['worker']; else active = true; } },
      isIdle: () => !active,
      async waitForIdle() { while (active) await sleep(5); },
      async resumeDelivery() { fenced = false; },
      background: () => background,
    };
    const control = createHandoff(runtime, () => { restarts++; }, { settle: 0, poll: 5 });
    control.request();
    await until(() => !inject && !fenced);
    assert.equal(restarts, 0);
    active = false; background = [];
    await until(() => restarts === 1);
    assert.equal(fenced, true);
  });
}

test('resume or a newer request during the final recheck invalidates the old restart', async () => {
  for (const action of ['resume', 'request']) {
    let fenced = false, waits = 0, release, restarts = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    const runtime = {
      events: new EventEmitter(), requestQuiesce() { fenced = true; }, isIdle: () => true,
      async waitForIdle() { if (++waits === 2) await blocked; },
      async resumeDelivery() { fenced = false; },
    };
    const control = createHandoff(runtime, () => { restarts++; }, { settle: 0 });
    control.request(); await until(() => waits === 2);
    control[action](); assert.equal(fenced, false); release();
    if (action === 'request') await until(() => restarts === 1);
    else { await sleep(30); assert.equal(restarts, 0); }
  }
});

test('restore failure remains held and fenced rather than silently restarting', async () => {
  let fenced = false, restarts = 0;
  const runtime = { events: new EventEmitter(), requestQuiesce() { fenced = true; },
    async resumeDelivery() { fenced = false; }, async waitForIdle() { throw new Error('Session restore failed; handoff held for review'); } };
  const control = createHandoff(runtime, () => { restarts++; }, { settle: 0 });
  control.request(); await until(() => control.snapshot().phase === 'held');
  assert.equal(fenced, true); assert.equal(restarts, 0); assert.match(control.snapshot().error, /restore failed/);
});
