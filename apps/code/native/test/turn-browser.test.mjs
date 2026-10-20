import test from 'node:test';
import assert from 'node:assert/strict';
import {harnessFixture} from './fixtures/harness-page.mjs';

// A new theme and a session (session-origin tests) still use turn.js's slanted band.
// Lock arrival alone uses an opacity fade; it must not change these turns.
test('a new theme turns in the shared diagonal over the whole window, and simply changes without view transitions', async () => {
 let css = 'body{--fixture:1}';
 const f = await harnessFixture({site:true, viewport:{width:1200,height:800}, messages:[{role:'assistant',content:'Ready.'}],
  handleRequest: async (req, res, path) => { if (path !== '/theme.css') return false; res.setHeader('Content-Type', 'text/css'); res.end(css); return true; }});
 const p = f.page;
 try {
  await p.evaluate(async () => {
   const {OPEN, OPENING} = await import('/js/turn.js');
   const reference = document.body.animate(OPEN, OPENING);
   globalThis.diagonal = reference.effect.getKeyframes().map(k => k.clipPath); reference.cancel();
   globalThis.turns = [];
   const animate = Element.prototype.animate;
   Element.prototype.animate = function(frames, options) { const a = animate.call(this, frames, options); if (frames === OPEN) { a.pause(); turns.push(a); } return a; };
   dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'one'}}));
  });
  css = 'body{--fixture:2}';
  await p.evaluate(() => dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'two'}})));
  await p.waitForFunction(() => turns.length === 1);
  const t = await p.evaluate(() => ({frames: turns[0].effect.getKeyframes().map(k => k.clipPath), diagonal, pseudo: turns[0].effect.pseudoElement, timing: turns[0].effect.getTiming(), turning: document.documentElement.classList.contains('turn')}));
  assert.deepEqual(t.frames, t.diagonal);
  assert.equal(t.pseudo, '::view-transition-new(root)');
  assert.equal(t.timing.duration, 420); assert.equal(t.timing.easing, 'cubic-bezier(0.65, 0, 0.35, 1)');
  assert.equal(t.turning, true);
  // the old look holds still beneath: nothing else animates in the transition
  const others = await p.evaluate(() => document.getAnimations().filter(a => a.effect?.pseudoElement && !turns.includes(a)).length);
  assert.equal(others, 0);
  await p.evaluate(() => turns[0].finish());
  await p.waitForFunction(() => !document.documentElement.classList.contains('turn'));
  assert.equal(await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--fixture').trim()), '2');
  css = 'body{--fixture:3}';
  await p.evaluate(() => { document.startViewTransition = undefined; dispatchEvent(new CustomEvent('imperfect-look', {detail: {rev: 'three'}})); });
  await p.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--fixture').trim() === '3');
  assert.equal(await p.evaluate(() => turns.length), 1);
  assert.deepEqual(f.errors, []);
 } finally { await f.close(); }
});
