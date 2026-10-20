// Take a picture of the page after a real number of milliseconds.
//
// Chromium's --virtual-time-budget advances virtual time only when the
// renderer goes idle, and a 120fps canvas loop never does: a four second
// budget got two hundred milliseconds into the animation. So this drives a
// real browser (imperfect's own, test-browser.mjs) and waits in real time,
// which is the only way to photograph a moment in an animation and trust the clock.
//
// Several moments can be asked for at once, and they are taken from one run of
// the page. An animation is a sequence, and stills from separate runs of it
// are not: separate runs pick different effects, and even the same effect is
// seeded afresh. Comparing them tells you nothing.

import { dirname, extname, join } from 'node:path';

import { launchChromium } from './test-browser.mjs';

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// One `out` and one moment gives that file. Several moments number the files
// after the moment they were taken at, so a filmstrip sorts into order.
function nameFor(out, ms, count) {
  if (count === 1) return out;
  const suffix = extname(out) === '' ? '.png' : extname(out);
  const stem = out.slice(0, out.length - extname(out).length);
  return join(dirname(stem), `${stem.slice(dirname(stem).length + 1)}-${String(ms).padStart(6, '0')}${suffix}`);
}

export async function shoot({ url, out, after = 2000, width = 1280, height = 720 }) {
  const moments = (Array.isArray(after) ? after : [after]).map(Number).sort((a, b) => a - b);
  const browser = await launchChromium({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    // A page that threw takes black pictures and says nothing about why.
    const faults = [];
    page.on('pageerror', error => faults.push(error.stack || error.message));
    const started = Date.now();
    await page.goto(url, { waitUntil: 'commit' });

    const written = [];
    for (const ms of moments) {
      const left = ms - (Date.now() - started);
      if (left > 0) await waitFor(left);
      const file = nameFor(out, ms, moments.length);
      await page.screenshot({ path: file, animations: 'allow', caret: 'initial' });
      written.push(file);
    }
    return { files: written, faults };
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, out, ...after] = process.argv.slice(2);
  if (url === undefined || out === undefined) {
    process.stderr.write('usage: node tools/shot.mjs <url> <out.png> [ms ...]\n');
    process.exit(1);
  }
  const { files, faults } = await shoot({
    url,
    out,
    after: after.length === 0 ? [2000] : after,
    width: Number(process.env.WIDTH ?? 1280),
    height: Number(process.env.HEIGHT ?? 720),
  });
  for (const file of files) process.stdout.write(`${file}\n`);
  for (const fault of faults) process.stderr.write(`page threw: ${fault}\n`);
}
