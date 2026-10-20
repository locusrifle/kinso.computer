// Fixture-only deterministic evidence. Run in a capped user unit and hold
// flock /tmp/imperfect-browser-tests.lock; no installed app or provider access.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { launchChromium } from './test-browser.mjs';

const out = resolve(process.env.SHARK_EVIDENCE || '../evidence');
await mkdir(out, { recursive: true });
const root = resolve(import.meta.dirname, '..');
const fixture = `<!doctype html><meta charset="utf-8"><title>Shark spacing fixture</title>
<style>html,body{margin:0;overflow:hidden;background:#fcfcfb}canvas{width:100vw;height:100vh;display:block}
#bar{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:min(618px,88vw);height:88px;border:1px solid #ddd;background:#fcfcfbd9;backdrop-filter:blur(8px);font:16px sans-serif;color:#555;display:grid;place-content:center;pointer-events:none}</style>
<canvas></canvas><div id="bar">what do you want?</div><script>
let raf, clock=1000;
window.requestAnimationFrame=cb=>(raf=cb,1); window.cancelAnimationFrame=()=>{raf=null};
window.advance=n=>{for(let i=0;i<n;i++){const cb=raf;raf=null;clock+=1000/30;cb?.(clock)}};
</script><script type="module">
const {swim}=await import(location.search.includes('native')?'/native.js':'/website.mjs');
const bar=document.querySelector('#bar'), canvas=document.querySelector('canvas');
window.stop=swim(canvas,{seed:17,cell:14,enter:true,sharks:4,avoid:()=>[bar.getBoundingClientRect()]});
window.ready=true;
</script>`;
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/native.js') || req.url.startsWith('/website.mjs')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(resolve(root, req.url.startsWith('/native') ? 'apps/code/native/public/js/sharks.js' : 'website/for-kinso/sharks.mjs')));
  } else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
const errors = [], measurements = [];
try {
  browser = await launchChromium({ headless: true, args: ['--disable-gpu'] });
  for (const [copy, width, height] of [['website', 1440, 900], ['native', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${copy}`);
    await page.waitForFunction(() => window.ready);
    for (const [seconds, name] of [[0, 'entrance'], [8, '8s'], [12, '20s'], [15, '35s']]) {
      await page.evaluate(n => window.advance(n), seconds * 30);
      await page.screenshot({ path: resolve(out, `${copy}-${width}x${height}-${name}.png`) });
    }
    await page.setViewportSize({ width: copy === 'website' ? 320 : 844, height: copy === 'website' ? 900 : 390 });
    await page.evaluate(() => window.advance(1));
    await page.screenshot({ path: resolve(out, `${copy}-resize-immediate.png`) });
    await page.evaluate(() => window.advance(20 * 30));
    await page.screenshot({ path: resolve(out, `${copy}-resize-20s.png`) });
    measurements.push({ copy, ...await page.evaluate(() => ({ ...window.stop.stats, averageMs: window.stop.stats.ms / window.stop.stats.frames })) });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(out, 'result.json'), JSON.stringify({ measurements, errors }, null, 2));
  console.log(JSON.stringify({ out, measurements, errors }, null, 2));
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
