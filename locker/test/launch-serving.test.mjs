import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { createLockerServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { config as launch } from '../../website/launch-config.mjs';

const SITE = fileURLToPath(new URL('../../website/', import.meta.url));
const website = path => readFile(new URL('../../website/' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The configured launch film, if any: none since the v8 trailer ("let's begin.") was archived; the unlock goes
// straight to the Mac. Pin a new film's SHA-256 here once its cut is final.
const FILM = launch.videoUrl && relative(SITE, fileURLToPath(launch.videoUrl));

test('no film is configured for now; a configured one is a fast-start MP4 (moov before mdat) at a same-origin media path', async () => {
  if (!FILM) { assert.equal(launch.videoUrl, null); assert.equal(launch.cuesUrl, undefined, 'no cues without a film'); return; }
  assert.match(FILM, /^media\/[^/]+\.mp4$/);
  const film = await website(FILM);
  assert.ok(film.length > 0);
  const atoms = [];
  for (let offset = 0; offset < film.length;) {
    let size = film.readUInt32BE(offset);
    const type = film.toString('ascii', offset + 4, offset + 8);
    if (size === 1) size = Number(film.readBigUInt64BE(offset + 8));
    if (size === 0) size = film.length - offset;
    assert.ok(size >= 8 && offset + size <= film.length);
    atoms.push(type); offset += size;
  }
  assert.ok(atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'));
});

test('both adapters import the same boot and its one scroll implementation, without copy-equality', async () => {
  const lock = await readFile(new URL('../../desktop/lock/lock.mjs', import.meta.url), 'utf8');
  const site = (await website('intro/intro.mjs')).toString();
  assert.match(lock, /from '\.\.\/\.\.\/website\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  assert.match(site, /from '\.\.\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  const sequence = (await website('boot/sequence.mjs')).toString();
  assert.match(sequence, /from '\.\/scroll\.mjs(?:\?v=[^']+)?'/);
  assert.match(sequence, /centred: true/);
  assert.doesNotMatch(site + sequence, /window\.lock|messageHandlers|S\.typed/);
  const siteScroll = await import('../../website/boot/scroll.mjs');
  const run = (module, events) => {
    const target = new EventTarget(), moved = [];
    let now = 0;
    const momentum = module.createMomentum();
    module.bindLockScroll({ active: () => true, height: () => 800, move: px => moved.push(px), momentum, clock: () => now, target });
    for (const [type, at, detail] of events) {
      now = at;
      if (type === 'step') { moved.push(momentum.step(now, 1 / 60)); continue; }
      const event = new Event(type, { cancelable: true });
      Object.assign(event, detail);
      target.dispatchEvent(event);
    }
    return moved.map(px => +px.toFixed(6));
  };
  const finger = y => ({ touches: [{ identifier: 1, clientY: y }] });
  const events = [
    ['wheel', 0, { deltaY: 40, deltaX: 0, deltaMode: 0 }], ['wheel', .016, { deltaY: 36, deltaX: 0, deltaMode: 0 }], ['step', .3],
    ['wheel', 1, { deltaY: -50, deltaX: 0, deltaMode: 0 }], ['wheel', 1.02, { deltaY: -3, deltaX: 0, deltaMode: 1 }], ['step', 1.3], ['step', 1.32],
    ['wheel', 2, { deltaY: 5, deltaX: 30, deltaMode: 0 }],
    ['touchstart', 3, finger(600)], ['touchmove', 3.02, finger(560)], ['touchmove', 3.04, finger(590)], ['touchmove', 3.06, finger(520)], ['touchend', 3.08, { touches: [] }], ['step', 3.3],
    ['touchstart', 4, finger(300)], ['touchmove', 4.02, finger(340)], ['touchmove', 4.04, finger(400)], ['touchend', 4.06, { touches: [] }], ['step', 4.3],
  ];
  assert.ok(run(siteScroll, events).some(px => px < 0), 'shared scroll includes moving apart');
  assert.deepEqual(run(siteScroll, [['wheel', 0, { deltaY: -40, deltaX: 0, deltaMode: 0 }], ['wheel', 1, { deltaY: 40, deltaX: 0, deltaMode: 0 }]]), [-16, 16], 'a wheel up moves them apart, down together, 0.4x a finger (a desk was too quick)');
  assert.deepEqual(run(siteScroll, [['touchstart', 0, finger(600)], ['touchmove', .02, finger(550)], ['touchmove', .04, finger(500)]]), [50, 50], 'a finger moving up brings them together');
  const down = run(siteScroll, [['touchstart', 0, finger(300)], ['touchmove', .02, finger(350)], ['touchmove', .04, finger(420)], ['touchend', .06, { touches: [] }], ['step', .3]]);
  assert.deepEqual(down.slice(0, 2), [-50, -70], 'a finger moving down moves them apart'); assert.ok(down[2] < 0, 'and coasts on, the same feel');
});

test('existing static locker serves launch modules and exact media byte ranges with configured narrow CSP', async t => {
  // Ephemeral test fixture only, not a dev preview server; no billing/provider/network integration.
  const store = openStore();
  const app = await createLockerServer({ store, mail:{ configured:false, async send() { throw new Error('No mail in static tests'); } },
    config:{ secure:false, hosts:'launch.test', demoOrigin:'https://noah.imperfect.computer' }, websiteDir:SITE, port:0,
    log:{ info() {}, warn() {}, error() {} } });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname:'127.0.0.1', port:address.port, path, headers:{ host:'launch.test', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const front = await get('/');
  assert.equal(front.status, 200); assert.deepEqual(front.body, await website('index.html'));
  assert.match(front.headers['content-security-policy'], /frame-src 'self' https:\/\/noah\.imperfect\.computer;/);
  assert.doesNotMatch(front.headers['content-security-policy'], /unsafe-inline|\*/);
  assert.equal(front.headers['referrer-policy'], 'same-origin');
  assert.match(front.body.toString(), /referrerpolicy="strict-origin-when-cross-origin"/);
  for (const path of ['/launch.mjs','/launch-config.mjs','/media.mjs','/intro/intro.mjs','/boot/sequence.mjs','/boot/scroll.mjs','/mac/desktop.mjs','/mac/shell.mjs','/mac/phone.mjs','/shop.mjs',
    '/macos/lock.mjs','/macos/launch.mjs','/macos/quicktime.mjs','/macos/genie.mjs','/macos/timings.mjs','/macos/window-picture.mjs']) {
    const response = await get(path); assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  }
  for (const path of ['/macos/lock.css', '/macos/quicktime.css', '/macos/genie.css', '/macos/wallpaper.css']) {
    const response = await get(path); assert.equal(response.status, 200); assert.equal(response.headers['content-type'], 'text/css; charset=utf-8');
  }
  const phoneVoice = await get('/mac/sounds/line-phone.m4a');
  assert.equal(phoneVoice.status, 200); assert.equal(phoneVoice.headers['content-type'], 'audio/mp4');
  assert.deepEqual(phoneVoice.body, await website('mac/sounds/line-phone.m4a'));
  const voices = await get('/mac/sounds/voice.json');
  assert.equal(voices.status, 200);
  assert.ok(JSON.parse(voices.body).lines.some(line => line.voice === 'mac/sounds/line-phone.m4a' && line.text === "And it's on your phone."));
  // Media plays from byte ranges (Safari asks for nothing else): the film when there is one, else a build voice.
  const MEDIA = FILM || 'mac/sounds/line-0.m4a', media = await website(MEDIA);
  const full = await get('/' + MEDIA);
  assert.equal(full.status, 200); assert.equal(full.headers['content-type'], FILM ? 'video/mp4' : 'audio/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes'); assert.equal(sha(full.body), sha(media));
  const mid = Math.floor(media.length / 2);
  for (const [range, start, end] of [['bytes=0-99',0,99], [`bytes=${mid}-${mid + 99}`,mid,mid + 99], ['bytes=-64',media.length-64,media.length-1]]) {
    const response = await get('/' + MEDIA, { range });
    assert.equal(response.status, 206); assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${media.length}`);
    assert.deepEqual(response.body, media.subarray(start,end+1));
  }
  const invalid = await get('/' + MEDIA, { range:`bytes=${media.length}-` });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers['content-range'], `bytes */${media.length}`);
  assert.equal((await get('/host.html')).status, 200);
  const shopHTML = await readFile(new URL('../public/store/shop.html', import.meta.url));
  for (const path of ['/shop', '/shop?os=mac', '/shop?os=linux', '/shop?os=windows', '/shop?os=mobile']) {
    const page = await get(path);
    assert.equal(page.status, 200, `${path}: the Shop is a real standalone page`);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.deepEqual(page.body, shopHTML);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'(?: [^;]+)?;/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|\*/);
    assert.doesNotMatch(page.body.toString(), /<iframe\b|mac\/|<script\b[^>]*>\s*[^<\s]/i);
  }
  // Noah's link for Kinso opens the Shop as Kinso might sell it, under the same strict policy; anything else is the Shop.
  // Where the store runs, kinso/ holds kinso.ai's own page rebuilt (never in this source); elsewhere kinso.html stands in.
  const kinso = await get('/shop?for=kinso');
  const clone = await readFile(new URL('../public/store/kinso/index.html', import.meta.url)).catch(() => null);
  assert.equal(kinso.status, 200); assert.equal(kinso.headers['cache-control'], 'no-store');
  assert.deepEqual(kinso.body, clone ?? await readFile(new URL('../public/store/kinso.html', import.meta.url)));
  assert.equal(kinso.headers['content-security-policy'], (await get('/shop')).headers['content-security-policy']);
  assert.doesNotMatch(kinso.body.toString(), /<iframe\b|<script\b(?![^>]*\ssrc=)|\sstyle=/i);
  assert.deepEqual((await get('/shop?for=someone')).body, shopHTML);
  for (const [path, type] of [['/kinso.css', 'text/css; charset=utf-8'], ['/fonts/inter-tight.woff2', 'font/woff2']]) {
    const asset = await get(path);
    assert.equal(asset.status, 200, path); assert.equal(asset.headers['content-type'], type, path);
    assert.deepEqual(asset.body, await readFile(new URL('../public/store' + path, import.meta.url)));
  }
  for (const [path, type] of [['/shop.js', 'text/javascript; charset=utf-8'], ['/shop.css', 'text/css; charset=utf-8'], ['/shop-platform.mjs', 'text/javascript; charset=utf-8'], ['/shop-thanks.js', 'text/javascript; charset=utf-8']]) {
    const asset = await get(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers['content-type'], type, `${path}: executable under nosniff and strict CSP`);
    assert.deepEqual(asset.body, await readFile(new URL('../public/store' + path, import.meta.url)));
  }
  for (const path of ['/buy', '/buy.html', '/rent.html']) {
    const moved = await get(path);
    assert.equal(moved.status, 302); assert.equal(moved.headers.location, '/');
  }
  for (const path of ['/world.html', '/galaxy.mjs', '/media/v4-launch.mp4', '/media/v8-lets-begin.mp4', '/media/v8-cues.json', '/mac/app.html', '/mac/browser-page.webp', '/mac/shop.mjs', '/mac/shop.css']) assert.equal((await get(path)).status, 404, `${path}: gone`);
  // The lock's door: with no lock file every password is refused, the same as a wrong one.
  const unlock = await get('/unlock'); assert.equal(unlock.status, 401); assert.deepEqual(JSON.parse(unlock.body), { ok:false });
});
