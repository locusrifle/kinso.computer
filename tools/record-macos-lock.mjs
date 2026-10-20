// Deterministic 60 fps evidence, using the production pages and isolated product transports.
// Run under flock /tmp/imperfect-browser-tests.lock. No installed service or keeper is contacted.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChromium } from './test-browser.mjs';
import { macosLaunch } from '../locker/test/fixtures/macos-launch.mjs';
import { harnessFixture } from '../apps/code/native/test/fixtures/harness-page.mjs';
import { INTRO, STEPS } from '../website/mac/desktop.mjs';
import { themeCss } from '../system/theme.mjs';

const out = resolve(process.argv[2] || '/tmp/imperfect-macos-lock'); await mkdir(out, { recursive: true });
const durations = Object.fromEntries([INTRO, ...STEPS].map(line => [line.voice.split('/').pop(), line.durationMs / 1000]));
durations['drag-to-trash.m4a'] = .7;
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const DT = 1 / 60;

async function soundtrack(label) {
  const timeline = JSON.parse(await readFile(join(out, label + '-timeline.json'), 'utf8'));
  const args = ['-v', 'error', '-y', '-i', join(out, label + '-silent.mp4')], filters = [], tracks = [];
  for (const [i, cue] of timeline.cues.entries()) {
    const source = cue.src.startsWith('http:') ? join('website', new URL(cue.src).pathname) : cue.src;
    args.push('-i', resolve(source));
    filters.push(`[${i + 1}:a]atempo=${cue.rate},adelay=${Math.round(cue.at * 1000)}:all=1[cue${i}]`); tracks.push(`[cue${i}]`);
  }
  filters.push(`${tracks.join('')}amix=inputs=${tracks.length}:normalize=0,apad,atrim=duration=${timeline.duration + DT}[mix]`);
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-threads', '2', '-movflags', '+faststart', join(out, label + '.mp4'));
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  proc.stderr.on('data', b => { error += b; }); const [code] = await once(proc, 'close'); if (code) throw new Error(error);
}

// Only the recorder substitutes audio clocks. It records their actual source URLs
// and rates for the companion soundtrack; playback is tested separately, unmodified.
function audioClock(durations) {
  if (window !== top) return;
  // The existing Mac narration also has watchdogs and pointer flights. Advance
  // their timers and RAF timestamps with the capture, never with render speed.
  const raf = window.requestAnimationFrame.bind(window), timers = new Map(), animations = new WeakMap(); let nextTimer = 1;
  Object.defineProperty(performance, 'now', { value: () => window.__macosClock * 1000 });
  window.requestAnimationFrame = callback => raf(() => callback(performance.now()));
  window.setTimeout = (callback, ms = 0, ...args) => { const id = nextTimer++; timers.set(id, { at: window.__macosClock + Math.max(0, ms) / 1000, callback, args }); return id; };
  window.clearTimeout = id => timers.delete(id);
  const NativeAudio = window.Audio; window.__recordAudio = []; window.__recordCues = [];
  window.Audio = function(...args) {
    const a = new NativeAudio(...args); let time = 0, playing = false;
    Object.defineProperties(a, { currentTime: { get: () => time, set: t => { time = t; } }, paused: { get: () => !playing } });
    a.play = () => {
      playing = true;
      if (!a.muted) window.__recordCues.push({ at: window.__macosClock - 100, src: a.src, rate: a.playbackRate });
      return Promise.resolve();
    };
    a.pause = () => { playing = false; };
    a.advance = dt => {
      if (!playing) return; time += dt * a.playbackRate;
      const duration = durations[a.src.split('/').pop()] || .7;
      if (time >= duration) { time = duration; playing = false; a.dispatchEvent(new Event('ended')); }
    };
    window.__recordAudio.push(a); return a;
  };
  window.__recordAdvance = dt => {
    window.__introClock += dt; window.__introWall += dt; window.__macosClock += dt;
    window.__recordAudio.forEach(a => a.advance(dt));
    for (const [id, timer] of timers) if (timer.at <= window.__macosClock) { timers.delete(id); timer.callback(...timer.args); }
    for (const a of document.getAnimations()) {
      if (a.playState === 'finished') continue;
      if (!animations.has(a)) { animations.set(a, { at: window.__macosClock, from: a.currentTime || 0 }); a.pause(); }
      const start = animations.get(a), time = (window.__macosClock - start.at) * 1000 + start.from;
      a.currentTime = time;
      if (time >= a.effect.getComputedTiming().endTime) a.finish();
    }
  };
}
async function encoder(label, viewport) {
  const file = join(out, label + '-silent.mp4');
  const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', '60', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let error = ''; proc.stderr.on('data', b => { error += b; }); const closed = once(proc, 'close');
  const streams = new Map();
  async function painted(cdp) {
    if (!streams.has(cdp)) {
      const stream = { data: null, first: null }; streams.set(cdp, stream);
      stream.first = new Promise(resolve => {
        cdp.on('Page.screencastFrame', frame => { stream.data = frame.data; resolve(); cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}); });
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
      await stream.first;
    }
    // Flush the clock's paint. An unchanged scene reuses its identical last frame.
    await cdp.send('Runtime.evaluate', { expression: 'new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)))', awaitPromise: true });
    return streams.get(cdp).data;
  }
  return { async frame(cdp) { const data = await painted(cdp); if (!proc.stdin.write(Buffer.from(data, 'base64'))) await once(proc.stdin, 'drain'); },
    async close() { proc.stdin.end(); const [code] = await closed; if (code) throw new Error(error); } };
}
async function website(label, viewport) {
  const f = await macosLaunch(browser, { viewport, init: '(' + audioClock.toString() + ')(' + JSON.stringify(durations) + ')' });
  const { page } = f, cdp = await page.context().newCDPSession(page), video = await encoder(label, viewport);
  let time = 0, approached = false, readyAt, wrong = false, wrongAt, submitted = false, filmAt, filmEnded = false, demoAt, bootAt;
  const phases = [], selected = new Set(); let previous;
  try {
    for (let frame = 0; frame < 60 * 160; frame++) {
      if (frame % 300 === 0) console.log(label, 'frame', frame);
      const s = await page.evaluate(() => ({ phase: window.__launch().phase, lock: window.__launch().lock.state, intro: window.__launch().intro,
        quicktime: window.__launch().quicktime, movie: !!document.getElementById('quicktimeVideo') }));
      if (bootAt === undefined && s.intro?.soundAt !== null) bootAt = s.intro.soundAt - 100;
      if (s.phase !== previous) { phases.push({ frame, time, phase: s.phase }); previous = s.phase; console.log(label, frame, s.phase); }
      if (!approached && time >= .5) { approached = true; await page.keyboard.press('ArrowDown'); }
      if (s.phase === 'ready' && readyAt === undefined) readyAt = time;
      if (!wrong && readyAt !== undefined && time >= readyAt + .7) { wrong = true; await page.locator('#password').fill('refused'); await page.keyboard.press('Enter'); }
      if (s.lock === 'wrong' && wrongAt === undefined) wrongAt = time;
      if (!submitted && wrongAt !== undefined && time >= wrongAt + 1) { submitted = true; await page.locator('#password').fill('fixture-password'); await page.keyboard.press('Enter'); }
      if (s.movie) await page.evaluate(() => {
        const v = document.getElementById('quicktimeVideo'); v.loop = true;
        if (!v.dataset.recording) { v.dataset.recording = 'true'; Object.defineProperty(v, 'currentTime', { get: () => window.__recordFilmTime || 0, set() {} }); }
      });
      if (s.phase === 'quicktime' && filmAt === undefined) filmAt = time;
      if (filmAt !== undefined) await page.evaluate(t => { window.__recordFilmTime = Math.min(t, 45); }, time - filmAt);
      if (!filmEnded && filmAt !== undefined && time - filmAt >= 45) { filmEnded = true; await page.locator('#quicktimeVideo').evaluate(v => v.dispatchEvent(new Event('ended'))); }
      if (s.phase === 'demo' && demoAt === undefined) demoAt = time;
      const key = s.intro?.wordmark?.opacity > .99 && s.intro.tau < 7 ? 'wordmark' : s.phase === 'ready' && s.lock === 'idle' ? 'lock' : s.lock === 'wrong' ? 'wrong' : null;
      if (key && !selected.has(key)) { selected.add(key); await page.screenshot({ path: join(out, `${label}-${key}.png`) }); }
      await video.frame(cdp);
      if (demoAt !== undefined && time - demoAt > 1) break;
      time += DT;
      await page.evaluate(async dt => {
        window.__recordAdvance(dt);
        await new Promise(ok => requestAnimationFrame(ok));
      }, DT);
    }
    const cues = await page.evaluate(() => window.__recordCues);
    if (bootAt !== undefined) cues.push({ at: bootAt, src: 'website/assets/sound/bootup.m4a', rate: 1 });
    if (filmAt !== undefined) cues.push({ at: filmAt, src: 'website/media/kinso-variations.mp4', rate: 1 });
    await writeFile(join(out, label + '-timeline.json'), JSON.stringify({ fps: 60, viewport, duration: time, phases, cues, errors: f.errors, csp: f.refusals }, null, 2));
    if (demoAt === undefined) throw new Error(`${label} did not reach the finished computer`);
    if (f.errors.length || f.refusals.length) throw new Error(JSON.stringify({ errors: f.errors, csp: f.refusals }));
  } finally { await video.close(); await f.close(); }
  await soundtrack(label);
}
async function native(label, viewport) {
  const page = await browser.newPage({ viewport, colorScheme: 'dark' });
  await page.addInitScript(() => { window.__lockClock = 100; window.__lockWall = 1760083230; });
  await page.goto(pathToFileURL(resolve('desktop/lock/index.html')).href + '?epoch=1760083200');
  await page.waitForFunction(() => window.__lockSaid?.includes('ready'));
  const themeCSS = themeCss(JSON.parse(await readFile(new URL('../apps/code/native/themes/mac-dark.json', import.meta.url), 'utf8')));
  const app = await harnessFixture({ browser, site: true, viewport, themeCSS, messages: [{ role: 'assistant', content: 'Ready.' }],
    handleRequest: async (req, res, path) => {
      if (path === '/files/list') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: [] })); return true; }
      if (path === '/files/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); return true; }
      return false;
    } });
  await page.bringToFront();
  const cdp = await page.context().newCDPSession(page), appCDP = await app.page.context().newCDPSession(app.page), video = await encoder(label, viewport);
  let time = 0, approached = false, boxAt, wrong = false, answered = false, goneAt, appHeld = false, bootAt;
  const phases = []; let previous;
  try {
    for (let frame = 0; frame < 60 * 30; frame++) {
      if (frame % 300 === 0) console.log(label, 'frame', frame);
      const s = await page.evaluate(() => window.__lock());
      if (bootAt === undefined && s.soundAt !== null) bootAt = s.soundAt - 100;
      if (s.phase !== previous) { phases.push({ frame, time, phase: s.phase }); previous = s.phase; console.log(label, frame, s.phase); }
      if (!approached && time >= .5) { approached = true; await page.evaluate(() => window.lock.key(5)); }
      if (s.phase === 'box' && boxAt === undefined) boxAt = time;
      if (boxAt !== undefined && !appHeld) {
        appHeld = true;
        await app.page.evaluate(async ({ epoch, touched, wall }) => {
          const { mountArrival } = await import('/js/arrival.js'); window.__recordWall = wall;
          window.__recordArrival = mountArrival({ onLock: fn => { window.__recordHear = fn; fn({ epoch, touched }); } }, { clock: () => window.__recordWall });
        }, { epoch: s.epoch, touched: s.touched, wall: 1760083230 + time });
        await app.page.waitForFunction(() => document.documentElement.classList.contains('locked-away'));
      }
      if (!wrong && boxAt !== undefined && time - boxAt > .7) { wrong = true; await page.evaluate(() => { window.lock.check(); window.lock.answer(false); }); }
      if (!answered && boxAt !== undefined && time - boxAt > 1.8) { answered = true; await page.evaluate(() => { window.lock.key(4); window.lock.check(); window.lock.answer(true); }); }
      if (goneAt === undefined && s.said.includes('done')) { goneAt = time; await app.page.bringToFront(); await app.page.evaluate(() => window.__recordHear(null)); }
      if (goneAt !== undefined) await app.page.evaluate(({ wall, since }) => {
        window.__recordWall = wall;
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = since * 1000; if (since * 1000 >= a.effect.getComputedTiming().endTime) a.finish(); }
      }, { wall: 1760083230 + time, since: time - goneAt });
      await video.frame(goneAt === undefined ? cdp : appCDP);
      if (goneAt !== undefined && time - goneAt > 1.5) break;
      time += DT;
      await page.evaluate(async dt => { window.__lockClock += dt; window.__lockWall += dt; await new Promise(ok => requestAnimationFrame(ok)); }, DT);
    }
    await writeFile(join(out, label + '-timeline.json'), JSON.stringify({ fps: 60, viewport, duration: time, phases,
      cues: [{ at: bootAt, src: 'website/assets/sound/bootup.m4a', rate: 1 }], errors: app.errors }, null, 2));
    if (goneAt === undefined) throw new Error(`${label} did not release`);
  } finally { await video.close(); await app.close(); await page.close(); }
  await soundtrack(label);
}
try {
  for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    if (!process.argv[3] || process.argv[3] === `website-${size}`) await website(`website-${size}-flow`, viewport);
    if (!process.argv[3] || process.argv[3] === `native-${size}`) await native(`native-${size}-flow`, viewport);
  }
} finally { await browser.close(); }
