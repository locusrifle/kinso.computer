import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../../../desktop/lock/profile.js', import.meta.url), 'utf8');
function boot(search) {
  const sent = [], raf = [], intervals = [], timeout = [];
  let now = 10;
  const context = { URLSearchParams, location: { search }, performance: { now: () => now, timeOrigin: 1000 }, innerWidth: 1472, innerHeight: 920, devicePixelRatio: 2,
    requestAnimationFrame: cb => raf.push(cb), setInterval: cb => intervals.push(cb), clearInterval() {}, setTimeout: cb => timeout.push(cb) };
  context.window = { webkit: { messageHandlers: { imperfect: { postMessage: text => sent.push(JSON.parse(text.slice(8))) } } } };
  vm.runInNewContext(source, context);
  return { context, sent, raf, intervals, timeout, now: value => { now = value; } };
}
test('profiling requires explicit query, does no work otherwise', () => {
  const b = boot(''); assert.equal(b.context.window.__lockProfile, undefined); assert.equal(b.sent.length, 0); assert.equal(b.raf.length, 0);
});
test('bounded aggregate timing only, phases flush and stop after three minutes', () => {
  const b = boot('?profile=1'); const p = b.context.window.__lockProfile;
  p.sample('sky-draw-cpu', 12); p.sample('sky-draw-cpu', 510); p.sample('sky-draw-cpu', NaN);
  p.phase('contact');
  const g = b.sent.find(e => e.event === 'histogram').groups['approach:sky-draw-cpu'];
  assert.equal(g.n, 2); assert.equal(g.bins[1], 1); assert.equal(g.bins[8], 1);
  b.timeout[0](); const count = b.sent.length; p.sample('sky-draw-cpu', 4); p.mark('box'); b.intervals[0]();
  assert.equal(b.sent.length, count);
  assert.equal(JSON.stringify(b.sent).includes('typed'), false);
});
