import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const LOCK = { epoch: 1760083260, touched: 1760083270 };
const mount = page => page.evaluate(async lock => {
  const { mountArrival } = await import('/js/arrival.js');
  window.arrival = mountArrival({ onLock: fn => { window.tellLock = fn; fn(lock); } });
}, LOCK);
const look = page => page.evaluate(() => ({
  hidden: document.documentElement.classList.contains('locked-away'),
  effects: document.querySelectorAll('canvas.kept-sky, .stardust, #galaxyScene').length,
  background: getComputedStyle(document.documentElement).backgroundColor,
  ui: [...document.body.children].filter(e => e.localName !== 'script' && getComputedStyle(e).display !== 'none').map(e => +getComputedStyle(e).opacity),
}));
for (const reduced of [false, true]) test(`native lock release keeps the plain ground, never a sky (${reduced ? 'reduced' : 'fade'})`, async () => {
  const f = await harnessFixture({ site: true, viewport: { width: 1200, height: 800 }, themeCSS: themeCss({ background: '#121214', foreground: '#ffffff' }), handleRequest: async (req, res, path) => {
    if (path !== '/files/list') return false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: ['Downloads', 'projects', 'workbench'].map(name => ({ name, path: `/fixture/${name}`, dir: true, size: 0, mtime: 1 })) }));
    return true;
  }, messages: [{ role: 'assistant', content: 'Ready.' }] });
  try {
    const requests = [];
    f.page.on('request', r => requests.push(r.url()));
    if (reduced) await f.page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(f.page);
    let s = await look(f.page);
    assert.equal(s.hidden, true); assert.equal(s.effects, 0);
    assert.ok(s.ui.length && s.ui.every(o => o === 0));
    assert.notEqual(s.background, 'rgba(0, 0, 0, 0)', 'the app keeps its own ground even while locked');
    await f.page.evaluate(lock => { tellLock(lock); tellLock(null); }, LOCK);
    await f.page.waitForFunction(() => [...document.body.children].filter(e => e.localName !== 'script' && getComputedStyle(e).display !== 'none').every(e => +getComputedStyle(e).opacity === 1));
    s = await look(f.page);
    assert.equal(s.hidden, false); assert.equal(s.effects, 0); assert.ok(s.ui.every(o => o === 1));
    assert.ok(!requests.some(url => /kept-sky|stardust|\/website\/(sky|stars|scene)\.mjs/.test(url)), 'no dormant renderer downloads on unlock');
    if (process.env.GALAXY_EVIDENCE) await f.page.screenshot({ path: `${process.env.GALAXY_EVIDENCE}/app-${reduced ? 'reduced' : 'unlock'}.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('relocking during arrival cancels the fade, hides UI, and a stale unlock is harmless', async () => {
  const f = await harnessFixture({ site: true, messages: [{ role: 'assistant', content: 'Ready.' }] });
  try {
    await mount(f.page);
    await f.page.evaluate(lock => { tellLock(null); tellLock(lock); }, LOCK);
    await f.page.waitForTimeout(700);
    let s = await look(f.page);
    assert.equal(s.hidden, true); assert.equal(s.effects, 0); assert.ok(s.ui.every(o => o === 0));
    await f.page.evaluate(() => { tellLock(null); tellLock(null); });
    await f.page.waitForTimeout(700);
    s = await look(f.page);
    assert.equal(s.hidden, false); assert.ok(s.ui.every(o => o === 1));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('without a native lock no arrival mounts; framed helpers preserve the exact trusted-origin boundary', async () => {
  const f = await harnessFixture({ site: true, messages: [{ role: 'assistant', content: 'Ready.' }] });
  try {
    const result = await f.page.evaluate(async () => {
      const { mountArrival, framedByLaunch } = await import('/js/arrival.js');
      const win = (origin, framed = true) => { const w = { location: { origin } }; w.parent = framed ? {} : w; return w; };
      return { arrival: mountArrival(null), framed: [
        framedByLaunch(win('https://noah.imperfect.computer'), { referrer: 'https://imperfect.computer/' }),
        framedByLaunch(win('https://noah.imperfect.computer', false), { referrer: 'https://imperfect.computer/' }),
        framedByLaunch(win('https://noah.imperfect.computer'), { referrer: 'https://evil.example/' }),
        framedByLaunch(win('http://localhost:5100'), { referrer: 'https://imperfect.computer/' }),
      ] };
    });
    assert.deepEqual(result, { arrival: null, framed: [true, false, false, false] });
    assert.equal((await look(f.page)).effects, 0);
  } finally { await f.close(); }
});
