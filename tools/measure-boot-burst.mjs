// Numeric burst timings in Chromium; not a substitute for WebKitGTK on the laptop.
import { launchChromium } from './test-browser.mjs';
import { writeFile } from 'node:fs/promises';
import { BURST } from '../website/bootup.mjs';
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1472, height: 920 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    window.__burstFrames = [];
    let last = null;
    const frame = now => {
      const s = window.__lock?.();
      if (s && last !== null) window.__burstFrames.push({ tau: s.tau, ms: now - last });
      last = now; requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goto(new URL('../desktop/lock/index.html?world=dragon&profile=1', import.meta.url).href);
  await page.waitForFunction(() => window.__lockSaid?.includes('ready'), null, { timeout: 60000 });
  await page.evaluate(() => window.lock.nudge(100));
  await page.waitForFunction(burst => window.__lock().tau > burst + 1.2, BURST, { timeout: 60000 });
  const frames = await page.evaluate(() => window.__burstFrames);
  const ms = frames.filter(f => f.tau >= BURST - 0.2 && f.tau <= BURST + 1).map(f => f.ms).sort((a,b) => a-b);
  const report = { engine: 'Chromium', viewport: [1472,920], dpr: 2, burst: BURST, count: ms.length,
    median: ms[Math.floor(ms.length * .5)], p95: ms[Math.floor(ms.length * .95)], max: ms.at(-1), over33: ms.filter(n => n > 33.4).length };
  console.log(JSON.stringify(report));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ report, frames }, null, 2));
} finally { await browser.close(); }
