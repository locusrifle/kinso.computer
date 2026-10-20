// The real locker and real product frontend on isolated loopback servers.
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLockerServer } from '../../server.mjs';
import { openStore } from '../../store.mjs';
import { command, createSiteLocks, readTicket } from '../../site-locks.mjs';
import { launchProductFixture } from './launch-product.mjs';

export async function macosLaunch(browser, { viewport = { width: 1440, height: 900 }, reduced = false, appearance = 'dark', remembered = false, init } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'macos-launch-')), credentials = join(root, 'credentials');
  const files = { file: join(credentials, 'site-locks.json'), doorFile: join(credentials, 'site-door-secret'), credentials, out() {} };
  await command(['door-secret'], files);
  let origin;
  const product = await launchProductFixture({ launchOrigin: () => origin, verifyTicket: async ticket => readTicket(ticket, await readFile(files.doorFile)) });
  await command(['replace', 'noah', 'fixture-password', product.origin, '--ticket'], files);
  const store = openStore(), locks = createSiteLocks({ ...files, secure: false, log: { error() {} } });
  const app = await createLockerServer({ store, siteLocks: locks, mail: { configured: false, async send() { throw new Error('No mail in visual fixtures'); } },
    config: { secure: false, hosts: '127.0.0.1' }, port: 0, log: { info() {}, warn() {}, error() {} } });
  origin = `http://127.0.0.1:${(await app.listen()).port}`;
  const context = await browser.newContext({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference', colorScheme: appearance, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
  const page = await context.newPage(), errors = [], refusals = [];
  try { await access(new URL('../../../website/media/kinso-variations.mp4', import.meta.url)); }
  catch {
    // A clean checkout intentionally has no stand-in film. Generate fixture media outside Git.
    const media = join(root, 'fixture.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x16121e:s=320x180:r=30:d=45', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=45',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', media]);
    await context.route('**/media/kinso-variations.mp4*', async route => route.fulfill({ contentType: 'video/mp4', body: await readFile(media) }));
  }
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) refusals.push(m.text()); });
  await page.addInitScript(() => { window.__introClock = window.__macosClock = 100; window.__introWall = new Date(2026, 9, 19, 17, 4).getTime() / 1000; });
  if (init) await page.addInitScript(init);
  if (remembered) await context.request.post(origin + '/unlock', { data: { password: 'fixture-password' } });
  await page.goto(origin);
  await page.waitForFunction(() => window.__launch?.().phase === 'intro' && window.__launch().intro?.started, null, { timeout: 60000 });
  const step = async (seconds, dt = .1) => {
    await page.evaluate(async ({ seconds, dt }) => {
      for (let t = 0; t < seconds - 1e-8; t += dt) {
        const d = Math.min(dt, seconds - t); window.__introClock += d; window.__introWall += d; window.__macosClock += d;
        await new Promise(ok => requestAnimationFrame(ok));
      }
    }, { seconds, dt });
  };
  return { page, context, origin, product, errors, refusals, step,
    state: () => page.evaluate(() => window.__launch()),
    async lock() { await page.keyboard.press('ArrowDown'); await step(3); await step(9); },
    async close() { await context.close(); await app.close(); store.close(); await product.close(); await rm(root, { recursive: true, force: true }); },
  };
}
