import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { openStore } from '../store.mjs';
import { buyerWords, createLockerServer, createLimiter, render } from '../server.mjs';
import { release } from '../tools/release.mjs';
import { signWebhook } from '../stripe.mjs';

const WEBHOOK = 'whsec_test';
const exec = promisify(execFile);
const git = (args, options = {}) => exec('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false' }, ...options });

// A product directory like the PC's: a bare repository
// with one commit pinning an Android app, and that app in downloads/.
async function product() {
  const root = await mkdtemp(join(tmpdir(), 'locker-product-'));
  const work = join(root, 'work');
  await mkdir(join(root, 'downloads'), { recursive: true });
  await writeFile(join(root, 'downloads', 'imperfect-code-android-abc.apk'), 'not really an apk');
  await git(['init', '--quiet', '--initial-branch=main', work]);
  await writeFile(join(work, 'AGENTS.md'), '# for the agent\n');
  await writeFile(join(work, 'binaries.json'), JSON.stringify({ android: { file: 'imperfect-code-android-abc.apk', sha256: 'x', size: 17 } }));
  await git(['-C', work, 'add', '-A']);
  await git(['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'first']);
  await git(['clone', '--quiet', '--bare', work, join(root, 'imperfect.git')]);
  return root;
}

function fakeStripe() {
  const sessions = new Map();
  return {
    sessions,
    async checkoutSession(params) { const id = `cs_${sessions.size + 1}`; sessions.set(id, { id, url: `https://checkout.stripe.com/c/${id}`, params }); return sessions.get(id); },
    async retrieveSession(id) {
      const found = sessions.get(id);
      if (!found) throw new Error('No such session');
      return found.paid ?? { id, payment_status: 'unpaid', status: 'open', metadata: found.params.metadata };
    },
  };
}

async function boot({ stripe = fakeStripe(), hosts = 'shop.test, www.shop.test' } = {}) {
  const store = openStore();
  const sent = [];
  const mail = { configured: false, async send(note) { sent.push(note); } };
  const app = await createLockerServer({
    store, stripe, mail,
    config: { secure: false, hosts, stripe: { price: 'price_code', webhookSecret: WEBHOOK }, price: '$19', demoOrigin: 'https://demo.shop.test' },
    productDir: await product(),
    websiteDir: fileURLToPath(new URL('../../website/', import.meta.url)),
    port: 0,
    log: { info() {}, warn() {}, error() {} },
  });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  // fetch refuses to send a Host header, and the host is the whole point.
  const call = (host, path, init = {}) => new Promise((done, reject) => {
    const req = request(`${origin}${path}`, { method: init.method ?? 'GET', headers: { host, ...(init.headers ?? {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        done({ status: res.statusCode, headers: { get: name => { const v = res.headers[name.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : v; } }, text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
  return { app, store, sent, call, port: address.port };
}
const form = body => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

test('every host serves the cinematic launch, with retained handoff pages and narrowly configured embed policy', async () => {
  const { app, call } = await boot();
  try {
    assert.deepEqual(app.hosts, ['shop.test', 'www.shop.test']);
    assert.equal(app.base, 'http://shop.test');
    for (const host of ['shop.test', 'www.shop.test', 'elsewhere.test']) {
      const front = await call(host, '/');
      assert.equal(front.status, 200);
      const html = await front.text();
      assert.equal(html, await readFile(new URL('../../website/index.html', import.meta.url), 'utf8'), `${host} serves the actual launch source`);
      assert.match(html, /<script type="module" src="launch\.mjs(?:\?v=[\w-]+)?"/);
      assert.match(html, /<h1 id="launchHeading"[^>]*>imperfect: launch film and live computer<\/h1>/);
      assert.match(html, /<a class="keyboard-skip" id="skip" href="#computer">/);
      // The lock's field is drawn by macos/lock.mjs into #lockScreen; the page itself holds no form.
      assert.match(html, /<div id="lockScreen" hidden><\/div>/);
      assert.doesNotMatch(html, /id="power"/, 'the lock instead of the power button');
      assert.match(html, /<video id="film"[^>]*playsinline/);
      assert.match(html, /<iframe id="computer"[^>]*referrerpolicy="strict-origin-when-cross-origin"/);
      assert.doesNotMatch(html, /launchControls|id="own"/, 'no controls bar on the launch page');
      assert.doesNotMatch(html, /srcdoc=|href="\/#offers"|checkout\.stripe\.com/i, 'no simulated computer, dead offers target or new checkout');
      assert.equal(html.match(/<form\b[^>]*>/gi), null, 'no form in the page: the lock makes its own, which only asks the locker');
      const lockView = await readFile(new URL('../../website/macos/lock.mjs', import.meta.url), 'utf8');
      assert.match(lockView, /input\.type = 'password'/); assert.match(lockView, /setAttribute\('aria-label', 'Password'\)/);
      assert.equal(await (await call(host, '/index.html')).text(), html, 'explicit front URL serves the same page');
      assert.equal((await call(host, '/world.html')).status, 404, `${host}: the world page is gone`);
      for (const path of ['/host.html']) {
        const part = await call(host, path);
        assert.equal(part.status, 200, `${host}${path}`);
        assert.equal(part.headers.get('content-type'), 'text/html; charset=utf-8');
      }
      const moved = await call('shop.test', '/rent.html');
      assert.equal(moved.status, 302); assert.equal(moved.headers.get('location'), '/');
      assert.equal((await call('shop.test', '/shop/offer')).status, 200);
      const hostPage = await (await call(host, '/host.html')).text();
      assert.match(hostPage, /400/);
      assert.doesNotMatch(hostPage, /<form\b|checkout\.stripe\.com/i, 'new self-host offer does not submit to legacy checkout');
      assert.match(front.headers.get('content-security-policy'), /frame-src 'self' https:\/\/demo\.shop\.test;/);
      assert.equal(front.headers.get('cache-control'), host === 'elsewhere.test' ? 'public, max-age=300, stale-while-revalidate=86400' : 'no-cache');
    }
    const lockModule = await call('shop.test', '/lock.mjs');
    assert.equal(lockModule.status, 200);
    assert.equal(lockModule.headers.get('content-type'), 'text/javascript; charset=utf-8', 'the launch modules are served on store hosts');
    assert.equal((await call('shop.test', '/style.css?v=vision-1')).status, 200, 'the OS lock\'s shared styles stay');
    for (const path of ['/world.mjs', '/galaxy.mjs', '/config.mjs', '/opener/opener.mjs']) assert.equal((await call('elsewhere.test', path)).status, 404, `${path}: gone with the world page`);
    assert.equal((await call('imperfect.computer', '/nothing-here')).status, 404);
    const health = await (await call('shop.test', '/health')).json();
    assert.equal(health.site, 'store');
    assert.match(health.version, /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2}$/);
    assert.equal((await (await call('elsewhere.test', '/health')).json()).site, 'website');
    // The static launch keeps the website policy; the fixture's
    // demo origin remains exact, not widened to accommodate arbitrary frames.
    // launch-serving.test.mjs separately verifies the actual Noah origin and MP4.
    const site = await call('elsewhere.test', '/');
    assert.match(await site.text(), /<script type="module" src="launch\.mjs(?:\?v=[\w-]+)?"/);
    for (const path of ['/launch.mjs', '/launch-config.mjs', '/media.mjs', '/film.mjs', '/reveal.mjs', '/intro/intro.mjs', '/boot/sequence.mjs', '/boot/scroll.mjs', '/boot/sequence.css', '/sequence.css']) {
      const asset = await call('shop.test', path);
      assert.equal(asset.status, 200, path);
      assert.equal(asset.headers.get('content-type'), path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', path);
      assert.equal(await asset.text(), await readFile(new URL('../../website' + path, import.meta.url), 'utf8'), `${path} serves the applied source`);
    }
    for (const name of ['outfit-regular.woff2', 'outfit-medium.woff2', 'Outfit-OFL.txt']) {
      const font = await call('elsewhere.test', `/fonts/${name}`);
      assert.equal(font.status, 200, name);
      assert.equal(font.headers.get('content-type'), name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'font/woff2', name);
      assert.equal(Number(font.headers.get('content-length')), (await readFile(new URL(`../../website/fonts/${name}`, import.meta.url))).length, `${name}: the site serves its own subset font (font-src 'self')`);
    }
    const siteCsp = site.headers.get('content-security-policy');
    assert.match(siteCsp, /script-src 'self';/);
    assert.match(siteCsp, /connect-src 'self' https:\/\/demo\.shop\.test;/);
    assert.match(siteCsp, /frame-src 'self' https:\/\/demo\.shop\.test;/);
    assert.doesNotMatch(siteCsp, /blob:/);
    assert.match(siteCsp, /frame-ancestors 'self'/);
    assert.doesNotMatch(siteCsp, /'unsafe-inline'|'unsafe-eval'|\*/);
    const part = await call('elsewhere.test', '/opener/assets/hd/worlds/dragon.webp', { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206, 'static binary assets support byte ranges');
    assert.equal(part.headers.get('content-type'), 'image/webp');
    assert.match(part.headers.get('content-range'), /^bytes 0-99\/\d+$/);
    assert.equal(part.headers.get('content-length'), '100');
    assert.equal((await call('elsewhere.test', '/opener/assets/hd/worlds/dragon.webp', { headers: { range: 'bytes=999999999-' } })).status, 416);
    assert.equal((await call('elsewhere.test', '/opener/assets/worlds/pastoral.webp')).status, 404, 'the meadow world is gone');
    assert.equal((await call('elsewhere.test', '/opener/assets/sound/world-pastoral.opus')).status, 404, 'deleted sound design is no longer served');
    // The store borrows the website's typeface and black hole under /assets/.
    for (const path of ['/assets/js/wte/ttfx.wasm', '/assets/fonts/omarchy-font.ttf', '/assets/js/sequence.js']) assert.equal((await call('shop.test', path)).status, 200, path);
    assert.equal((await call('shop.test', '/shared/locker.css')).status, 200);
    // The Stripe return page frames nothing.
    const csp = (await call('shop.test', '/shop/thanks')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(csp, /frame-src 'none';/);
    assert.match(csp, /form-action 'self' https:\/\/checkout\.stripe\.com;/);
    // What may be kept, and for how long: scripts a page names with ?v=
    // briefly, anything asked for bare never unchecked; a page with a key in
    // it never.
    assert.equal((await call('shop.test', '/shop-thanks.js?v=1')).headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
    assert.equal((await call('shop.test', '/engine.js')).headers.get('cache-control'), 'no-cache');
    // The website's link preview and icons are the store's.
    for (const path of ['/og.png', '/goat.png', '/apple-touch-icon.png', '/favicon.ico']) assert.equal((await call('shop.test', path)).status, 200, path);
    for (const host of ['shop.test', 'elsewhere.test']) {
      for (const [path, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/x-icon'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/icon-maskable-192.png', 'image/png'], ['/icon-maskable-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
        const icon = await call(host, path);
        assert.equal(icon.status, 200, `${host}: ${path}`);
        assert.equal(icon.headers.get('content-type'), type, `${host}: ${path}`);
        if (path === '/favicon.svg') assert.equal(icon.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
      }
      const manifest = await (await call(host, '/manifest.webmanifest')).json();
      assert.equal(manifest.icons.length, 4);
    }
    assert.equal((await call('shop.test', '/assets/js/wordmark.js')).headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');
    assert.equal((await call('shop.test', '/thanks?session_id=cs_none')).headers.get('cache-control'), 'no-store');
    assert.equal((await call('shop.test', '/nothing')).headers.get('cache-control'), 'no-store');
  } finally { await app.close(); }
});

test('retired checkout cannot start new charges; legacy thanks still issues the key once paid', async () => {
  const stripe = fakeStripe();
  const { app, call, store } = await boot({ stripe });
  try {
    assert.equal((await call('shop.test', '/buy')).status, 302);
    assert.equal((await call('shop.test', '/buy', form({ email: 'locus@example.com' }))).status, 404);
    assert.equal(stripe.sessions.size, 0);
    // A Checkout Session created before the source became free.
    await stripe.checkoutSession({ metadata: { product: 'code' } });

    assert.equal((await call('shop.test', '/thanks?session_id=cs_1')).status, 402);

    stripe.sessions.get('cs_1').paid = { id: 'cs_1', payment_status: 'paid', status: 'complete', metadata: { product: 'code' }, customer: 'cus_1', customer_details: { email: 'locus@example.com' } };
    const thanks = await call('shop.test', '/thanks?session_id=cs_1');
    assert.equal(thanks.status, 200);
    const page = await thanks.text();
    const [key] = page.match(/ic_[a-f0-9]{40}/);
    assert.ok(page.includes(`install imperfect: git clone http://buyer:${key}@shop.test/imperfect.git ~/imperfect, then follow the agents file inside.`));
    assert.match(page, /the very first member/);
    assert.equal(store.licenseBySession('cs_1').key, key);
    assert.match(await (await call('shop.test', '/thanks?session_id=cs_1')).text(), new RegExp(key));

    // A 100% promotion code: nothing to pay, and the repo opens all the same.
    await stripe.checkoutSession({ metadata: { product: 'code' } });
    stripe.sessions.get('cs_2').paid = { id: 'cs_2', payment_status: 'no_payment_required', status: 'complete', metadata: { product: 'code' }, customer: 'cus_2', customer_details: { email: 'gift@example.com' } };
    assert.equal((await call('shop.test', '/thanks?session_id=cs_2')).status, 200);
    assert.ok(store.licenseBySession('cs_2'));

  } finally { await app.close(); }
});

test('retired buy addresses stay retired without Stripe, and notification addresses can still wait', async () => {
  const { app, call, store } = await boot({ stripe: null });
  try {
    const details = await call('shop.test', '/buy');
    assert.equal(details.status, 302);
    assert.equal(details.headers.get('location'), '/');
    const closed = await call('shop.test', '/buy', form({}));
    assert.equal(closed.status, 404);
    const done = await call('shop.test', '/notify', form({ email: ' Someone@Example.com ' }));
    assert.equal(done.status, 200);
    assert.match(await done.text(), /someone@example\.com gets one email/);
    await call('shop.test', '/notify', form({ email: 'someone@example.com' }));
    assert.deepEqual(store.waiting(), ['someone@example.com']);
    assert.equal((await call('shop.test', '/notify', form({ email: 'nope' }))).status, 400);
    assert.equal((await call('shop.test', '/index.html', { method: 'PUT', body: 'overwritten' })).status, 404, 'nothing writes to the site');
  } finally { await app.close(); }
});

test('a live key clones and fetches the product; nothing else gets in, and members do not push', async () => {
  const { app, store, port } = await boot({ hosts: '127.0.0.1' });
  try {
    const license = store.issueLicense({ email: 'a@example.com' });
    const dir = await mkdtemp(join(tmpdir(), 'locker-clone-'));
    const url = key => `http://buyer:${key}@127.0.0.1:${port}/imperfect.git`;
    await git(['clone', '--quiet', url(license.key), join(dir, 'mine')]);
    assert.equal(await readFile(join(dir, 'mine', 'AGENTS.md'), 'utf8'), '# for the agent\n');
    await git(['-C', join(dir, 'mine'), 'fetch', '--quiet', 'origin']);
    // Git sends the key as a password, but people put it anywhere.
    await git(['clone', '--quiet', `http://${license.key}@127.0.0.1:${port}/imperfect.git`, join(dir, 'user-field')]);
    assert.equal(store.license(license.key).downloads, 3);

    await assert.rejects(() => git(['clone', '--quiet', url(`ic_${'f'.repeat(40)}`), join(dir, 'guess')]), /401|Authentication failed|could not read/);
    await assert.rejects(() => git(['clone', '--quiet', `http://127.0.0.1:${port}/imperfect.git`, join(dir, 'anon')]), /401|Authentication failed|could not read/);
    await writeFile(join(dir, 'mine', 'mine.txt'), 'x');
    await git(['-C', join(dir, 'mine'), 'add', '-A']);
    await git(['-C', join(dir, 'mine'), '-c', 'user.name=b', '-c', 'user.email=b@b', 'commit', '--quiet', '-m', 'mine']);
    await assert.rejects(() => git(['-C', join(dir, 'mine'), 'push', 'origin', 'HEAD:main']), /only Locus pushes/);

    store.revokeLicense(license.key);
    await assert.rejects(() => git(['-C', join(dir, 'mine'), 'fetch', '--quiet', 'origin']), /401|Authentication failed|could not read/);
  } finally { await app.close(); }
});

test('pinned downloads and the phone link open only to a live key', async () => {
  const { app, call, store } = await boot();
  try {
    const license = store.issueLicense({ email: 'p@example.com' });
    const basic = `Basic ${Buffer.from(`buyer:${license.key}`).toString('base64')}`;
    assert.equal((await call('shop.test', '/download/imperfect-code-android-abc.apk')).status, 403);
    const file = await call('shop.test', '/download/imperfect-code-android-abc.apk', { headers: { authorization: basic } });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'not really an apk');
    // A path climbing out of downloads/ lands on the repository, which only speaks git.
    const climb = await call('shop.test', `/download/../imperfect.git/config?key=${license.key}`);
    assert.equal(climb.status, 403);
    assert.doesNotMatch(await climb.text(), /repositoryformatversion/);
    assert.equal((await call('shop.test', `/download/missing?key=${license.key}`)).status, 404);
    const phone = await call('shop.test', `/android?key=${license.key}`);
    assert.equal(phone.status, 200);
    assert.equal(phone.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(phone.headers.get('content-disposition'), /imperfect-code\.apk/);
    assert.equal((await call('shop.test', `/android?key=ic_${'0'.repeat(40)}`)).status, 403);
    assert.equal((await call('shop.test', '/install')).status, 200, 'public GitHub installer needs no membership key');
    for (const gone of ['/release/manifest.json', '/computer-setup']) assert.equal((await call('shop.test', `${gone}?key=${license.key}`)).status, 404);
  } finally { await app.close(); }
});

test('a signed webhook issues a key and mails the sentence; a duplicate is ignored; a forgery is refused', async () => {
  const { app, call, store, sent } = await boot();
  try {
    const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_9', payment_status: 'paid', metadata: { product: 'code' }, customer: 'cus_9', customer_details: { email: 'w@example.com' } } } });
    const post = (body, signature) => call('anything', '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body });
    assert.equal((await post(event, 'bad')).status, 400);
    assert.equal((await post(event, signWebhook(event, WEBHOOK))).status, 200);
    const license = store.licenseBySession('cs_9');
    assert.ok(license);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(`git clone http://buyer:${license.key}@shop.test/imperfect.git ~/imperfect`));
    assert.ok(sent[0].text.includes(`http://shop.test/android?key=${license.key}`));
    assert.equal((await (await post(event, signWebhook(event, WEBHOOK))).json()).duplicate, true);
    assert.equal(sent.length, 1);
  } finally { await app.close(); }
});

test('a bank payment is fulfilled when it settles, and a failed handler is retried rather than skipped', async () => {
  const { app, call, store, sent } = await boot();
  try {
    const post = body => call('anything', '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signWebhook(body, WEBHOOK) }, body });
    const session = payment_status => ({ id: 'cs_bank', payment_status, metadata: { product: 'code' }, customer: 'cus_b', customer_details: { email: 'b@example.com' } });
    const completed = JSON.stringify({ id: 'evt_c', type: 'checkout.session.completed', data: { object: session('unpaid') } });
    assert.equal((await post(completed)).status, 200);
    assert.equal(store.licenseBySession('cs_bank'), null);
    const settled = JSON.stringify({ id: 'evt_s', type: 'checkout.session.async_payment_succeeded', data: { object: session('paid') } });
    const issue = store.issueLicense;
    store.issueLicense = () => { throw new Error('disk full'); };
    assert.equal((await post(settled)).status, 500);
    store.issueLicense = issue;
    assert.equal((await post(settled)).status, 200);
    assert.ok(store.licenseBySession('cs_bank'));
    assert.equal(sent.length, 1);
  } finally { await app.close(); }
});

test('rendering escapes what people typed, and the limiter counts', () => {
  assert.equal(render('<b>{{name}}</b> {{{markup}}}', { name: '<script>', markup: '<i>ok</i>' }), '<b>&lt;script&gt;</b> <i>ok</i>');
  const limiter = createLimiter({ perMinute: 2 });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
});

test('release tags the version and sends each member one email, and will not run blind', async () => {
  const store = openStore();
  const root = await product();
  const repo = join(root, 'imperfect.git');
  const words = buyerWords({ hosts: ['shop.test'], secure: false });
  const sent = [];
  const mail = { configured: true, async send(note) { sent.push(note); } };
  const log = { info() {}, warn() {} };
  store.issueLicense({ email: 'a@example.com' });
  const gone = store.issueLicense({ email: 'b@example.com' });
  store.revokeLicense(gone.key);

  await assert.rejects(() => release({ version: 'one', store, mail, repo, words, log }), /usage/);
  await assert.rejects(() => release({ version: '1.0', store, mail: { configured: false }, repo, words, log }), /mail is not set up/);
  const kept = store.licensesByEmail('a@example.com')[0].key;
  assert.equal(store.latestRelease(), null);

  const dry = await release({ version: '1.0', dryRun: true, store, mail, repo, words, log });
  assert.equal(dry.dryRun, true);
  assert.equal(sent.length, 0);

  assert.deepEqual(await release({ version: '1.0', store, mail, repo, words, log }), { sent: 1, failed: [] });
  assert.equal(sent[0].to, 'a@example.com');
  assert.equal(sent[0].subject, 'the imperfect repo 1.0');
  assert.ok(sent[0].text.includes('- first'));
  assert.ok(sent[0].text.includes(words.updateSentence()));
  assert.ok(!/ic_[a-f0-9]{40}/.test(sent[0].text));
  assert.ok(store.activeLicense(kept));
  assert.equal((await git(['--git-dir', repo, 'tag', '--list'])).stdout.trim(), 'v1.0');
  assert.equal(store.activeLicense(gone.key), null);

  await assert.rejects(() => release({ version: '1.0', store, mail, repo, words, log }), /already gone out/);
  await assert.rejects(() => release({ version: '1.1', store, mail, repo, words, log }), /nothing pushed since 1.0/);
  await rm(root, { recursive: true, force: true });
});
