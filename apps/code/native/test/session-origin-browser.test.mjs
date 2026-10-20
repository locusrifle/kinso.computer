import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, serve, fixtureResponse } from '../../tools/gui-preview.mjs';

for (const cached of [true, false]) test(`${cached ? 'cached' : 'confirmed'} session change turns in the theme's diagonal over its column, including keys and reduced motion`, { timeout: 30000 }, async () => {
  const { server, sockets, port } = await serve('');
  const whole = id => {
    const data = fixture();
    data.sessionId = id;
    data.tabs = Array.from({ length: 24 }, (_, i) => ({ ...data.tabs[0], id: i ? `tab-${i}` : 'mirror', sessionId: i ? `tab-${i}` : 'mirror', focused: (i ? `tab-${i}` : 'mirror') === id }));
    data.messages = [{ role: 'assistant', content: `${id} only` }];
    data.busy = false; data.streaming = false;
    return data;
  };
  sockets.removeAllListeners('connection');
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'snapshot', data: whole('mirror') }));
    socket.on('message', raw => {
      const c = JSON.parse(raw);
      const data = c.type === 'tab-focus' ? { snapshot: whole(c.tabId) } : fixtureResponse(c);
      socket.send(JSON.stringify({ type: 'response', id: c.id, success: true, data }));
      if (cached && c.type === 'hello') for (let i = 1; i < 24; i++) socket.send(JSON.stringify({ type: 'tab-snapshot', tabId: `tab-${i}`, data: whole(`tab-${i}`) }));
    });
  });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: cached ? 1200 : 390, height: 900 }, hasTouch: !cached });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForSelector('[data-tab-id="tab-23"]');
    await page.waitForTimeout(250);
    await page.locator('#entry-input').fill('mirror draft');
    // Keep real animations, but pause each turn (turn.js) at its first frame. Both ways a session comes in, the
    // view transition's column and the cached column, must be the theme's own diagonal, never a circle.
    await page.evaluate(async () => {
      const { OPEN, OPENING } = await import('/js/turn.js');
      const reference = document.body.animate(OPEN, OPENING);
      window.diagonal = reference.effect.getKeyframes().map(frame => frame.clipPath);
      reference.cancel();
      window.reveals = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        const a = animate.call(this, frames, options);
        if (frames === OPEN) { a.pause(); window.reveals.push(a); }
        return a;
      };
    });
    const inspect = async id => {
      await page.waitForFunction(() => window.reveals.length > 0);
      const g = await page.evaluate(() => {
        const a = window.reveals.at(-1);
        return { frames: a.effect.getKeyframes().map(frame => frame.clipPath), diagonal: window.diagonal, timing: a.effect.getTiming(), pseudo: a.effect.pseudoElement, target: a.effect.target.className, text: document.querySelector('#entry-output').textContent };
      });
      assert.deepEqual(g.frames, g.diagonal, JSON.stringify(g));
      assert.match(g.frames[0], /^polygon\(/);
      assert.equal(g.timing.duration, 420);
      assert.equal(g.timing.easing, 'cubic-bezier(0.65, 0, 0.35, 1)');
      if (g.pseudo) assert.equal(g.pseudo, '::view-transition-new(session-panel)');
      else assert.match(g.target, /entry-screen/);
      assert.ok(g.text.includes(`${id} only`));
      assert.ok(!g.text.includes('mirror only'));
      assert.equal(await page.evaluate(() => document.activeElement.matches('.session-rail-open')), false, 'switching does not focus the new tab');
      if (process.env.ORIGIN_SCREENSHOTS && id === 'tab-23') {
        await page.evaluate(() => window.reveals.forEach(a => { a.currentTime = 210; }));
        await page.screenshot({ path: `${process.env.ORIGIN_SCREENSHOTS}/${cached ? 'cached' : 'confirmed'}-tab-reveal.png` });
      }
      await page.evaluate(() => { window.reveals.forEach(a => a.finish()); window.reveals = []; });
      await page.waitForTimeout(60);
    };
    await page.evaluate(() => document.querySelector('[data-tab-id="tab-23"] .session-rail-open').click());
    await inspect('tab-23'); // a tab clipped out of the strip turns the same way
    await page.keyboard.press('Alt+2');
    await inspect('tab-1');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.querySelector('[data-tab-id="mirror"] .session-rail-open').click());
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('mirror only'));
    assert.equal(await page.locator('#entry-input').inputValue(), 'mirror draft');
    assert.equal(await page.evaluate(() => window.reveals.length), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
