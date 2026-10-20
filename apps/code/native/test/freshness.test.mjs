import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshness, WARN_MS, FAIL_MS, RELOAD_MS, BACKOFF_MS } from '../public/js/freshness.js';

// A clock that only moves when told to, and the timers on it.
function fakeClock() {
  let at = 1000, next = 1;
  const timers = new Map();
  const clock = {
    now: () => at,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, due: at + ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    async advance(ms) {
      const end = at + ms;
      for (;;) {
        const [id, timer] = [...timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0] ?? [];
        if (!timer) break;
        timers.delete(id); at = timer.due;
        await timer.fn();
        await settle();
      }
      at = end;
      await settle();
    },
  };
  return clock;
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function watched(options = {}) {
  const clock = fakeClock(), seen = [];
  const freshness = createFreshness({ ...clock, onChange: info => seen.push(info.phase), ...options });
  return { clock, seen, freshness };
}

test('a doubted view is tried at once, then with growing backoff, until it is current', async () => {
  const { clock, seen, freshness } = watched();
  const tries = [];
  freshness.stale({ owner: 'desk', attempt: () => { tries.push(clock.now()); } });
  await settle();
  assert.deepEqual(tries, [1000], 'the first try does not wait for anything');
  assert.equal(freshness.state.phase, 'stale');
  await clock.advance(BACKOFF_MS[0] + BACKOFF_MS[1] + BACKOFF_MS[2]);
  assert.deepEqual(tries, [1000, 1000 + BACKOFF_MS[0], 1000 + BACKOFF_MS[0] + BACKOFF_MS[1], 1000 + BACKOFF_MS[0] + BACKOFF_MS[1] + BACKOFF_MS[2]]);
  assert.equal(freshness.fresh(clock.now(), 'desk'), true);
  const count = tries.length;
  await clock.advance(60_000);
  assert.equal(tries.length, count, 'nothing is tried once it is current');
  assert.deepEqual(seen, ['stale', 'reconnecting', 'fresh']);
});

test('one that stays stale says so: reconnecting, then cannot be reached, and keeps trying', async () => {
  const { clock, freshness } = watched();
  let tries = 0;
  freshness.stale({ owner: 'lap', attempt: () => { tries++; } });
  await clock.advance(WARN_MS - 1);
  assert.equal(freshness.state.phase, 'stale');
  await clock.advance(1);
  assert.equal(freshness.state.phase, 'reconnecting');
  await clock.advance(FAIL_MS - WARN_MS);
  assert.equal(freshness.state.phase, 'unreachable');
  const before = tries;
  await clock.advance(60_000);
  assert.ok(tries >= before + 5, `still trying (${tries - before} more), never more often than the longest backoff`);
  assert.ok(tries - before <= 60_000 / BACKOFF_MS.at(-1) + 1);
  // Retry: at once, and with the whole time again before it says so.
  const now = tries;
  freshness.retry();
  await settle();
  assert.equal(tries, now + 1);
  assert.equal(freshness.state.phase, 'stale');
  await clock.advance(WARN_MS);
  assert.equal(freshness.state.phase, 'reconnecting');
});

test('attempts never overlap: the next waits for the last to end', async () => {
  const { clock, freshness } = watched();
  let running = 0, most = 0, release;
  freshness.stale({ owner: 'desk', attempt: () => { running++; most = Math.max(most, running); return new Promise(resolve => { release = () => { running--; resolve(); }; }); } });
  await clock.advance(20_000);
  assert.equal(most, 1);
  // Asked again meanwhile (the window looked at again): straight after it, not after a backoff.
  freshness.stale({ owner: 'desk', restart: true });
  release();
  await settle();
  assert.equal(running, 1, 'tried again as soon as the last one ended');
});

test('evidence from before the doubt, or of another view, does not make it current', async () => {
  const { clock, freshness } = watched();
  await clock.advance(100);
  freshness.stale({ owner: 'desk', attempt: () => {} });
  const since = clock.now();
  assert.equal(freshness.fresh(since - 1, 'desk'), false, 'a message already on its way');
  assert.equal(freshness.fresh(since, 'lap'), false, 'another computer');
  assert.equal(freshness.state.phase, 'stale');
  assert.equal(freshness.fresh(since, 'desk'), true);
  // A session asked for: only that session's view settles it.
  freshness.stale({ owner: 'lap', want: '["lap","tab-2"]', attempt: null });
  assert.equal(freshness.fresh(clock.now(), 'lap', '["lap","tab-1"]'), false);
  assert.equal(freshness.fresh(clock.now(), 'lap', '["lap","tab-2"]'), true);
  // Refused rather than unreachable: forgotten, nothing goes on trying.
  freshness.stale({ owner: 'lap', want: 'x' });
  freshness.forget('lap');
  assert.equal(freshness.state.phase, 'fresh');
});

test('looked at again, the clock starts again: a view doubted while hidden does not come back saying it cannot be reached', async () => {
  const { clock, freshness } = watched();
  freshness.stale({ owner: 'desk', attempt: () => {} });
  await clock.advance(5 * 60_000);
  assert.equal(freshness.state.phase, 'unreachable');
  freshness.stale({ owner: 'desk', restart: true });
  assert.equal(freshness.state.phase, 'stale');
  assert.equal(freshness.fresh(clock.now() - 1, 'desk'), false, 'nor does what came before it');
});

test('the last resort reloads only when reload says it did, and asks again later', async () => {
  const { clock, freshness } = watched();
  const asked = [];
  let willReload = false;
  freshness.stale({ owner: 'desk', attempt: () => {}, reload: () => { asked.push(clock.now()); return willReload; } });
  await clock.advance(RELOAD_MS - 1);
  assert.deepEqual(asked, []);
  await clock.advance(1);
  assert.deepEqual(asked, [1000 + RELOAD_MS]);
  willReload = true;
  await clock.advance(RELOAD_MS);
  assert.deepEqual(asked, [1000 + RELOAD_MS, 1000 + 2 * RELOAD_MS]);
  await clock.advance(5 * RELOAD_MS);
  assert.equal(asked.length, 2, 'not asked again once it reloaded');
  // A view made current in time is never reloaded.
  const other = watched();
  let reloads = 0;
  other.freshness.stale({ owner: 'desk', attempt: () => {}, reload: () => { reloads++; return true; } });
  await other.clock.advance(RELOAD_MS - 1);
  other.freshness.fresh(other.clock.now(), 'desk');
  await other.clock.advance(RELOAD_MS * 3);
  assert.equal(reloads, 0);
});

test('a doubt about another computer replaces the last; its tries stop', async () => {
  const { clock, freshness } = watched();
  const tries = [];
  freshness.stale({ owner: 'desk', attempt: () => { tries.push('desk'); } });
  freshness.stale({ owner: 'lap', attempt: () => { tries.push('lap'); } });
  await clock.advance(5000);
  assert.equal(tries[0], 'desk');
  assert.ok(tries.slice(1).every(owner => owner === 'lap') && tries.length > 2, tries.join());
  assert.equal(freshness.state.owner, 'lap');
});

test('doubted again while still stale (each refused socket closing) it keeps its backoff rather than trying in a loop', async () => {
  const { clock, freshness } = watched();
  let tries = 0;
  const doubt = () => freshness.stale({ owner: 'desk', attempt: () => { tries++; doubt(); } });
  doubt();
  await settle();
  await clock.advance(BACKOFF_MS[0] + BACKOFF_MS[1] - 1);
  assert.equal(tries, 2, 'once at first, once after the first backoff; none from being doubted again');
  assert.equal(freshness.state.phase, 'stale');
});
