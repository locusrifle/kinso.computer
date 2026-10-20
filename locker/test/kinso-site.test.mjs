// kinso.computer: the launch page made for Kinso (website/variant.mjs, website/for-kinso/). imperfect.computer stays as
// it was; the Kinso site switches on its own names or ?for=kinso, tells its build to Noah's words, and keeps Kinso's own
// files (their logo, wordmark and type) out of this source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openStore } from '../store.mjs';
import { createLockerServer, kinsoFront } from '../server.mjs';
import { variantId, VARIANTS, KINSO_HOSTS } from '../../website/variant.mjs';
import { visitorShopURL } from '../../website/shop.mjs';
import { speak, align, heardWords, captions, captionAt, cueTime, paraStart, norm } from '../../website/for-kinso/timeline.mjs';
import { MEDIA, OPENER, BEATS } from '../../website/for-kinso/script.mjs';
import { DRAGS, MOMENTS } from '../../website/for-kinso/build.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'website');
const exists = path => stat(path).then(() => true, () => false);

test('Get yours sells Kinso\'s own source, with no Code menu or command window', async () => {
  assert.equal(VARIANTS.kinso.install, 'curl -fsSL https://kinso.computer/install | sh');
  assert.equal(VARIANTS.kinso.source.page, '/source');
  assert.equal(VARIANTS.kinso.menu.last, null);
  const shell = await readFile(join(SITE, 'mac/shell.mjs'), 'utf8');
  assert.doesNotMatch(shell, /openCode|glowMenu|shell-code|kinso-source-paid/);
  assert.match(shell, /variant.menu.last\]\.filter\(Boolean\)/);
  assert.doesNotMatch(await readFile(join(SITE, 'for-kinso/kinso.css'), 'utf8'), /shell-code|is-glowing/);
  assert.deepEqual(BEATS.find(beat => beat.name === 'The source'), {
    name: 'The source', screen: 'The Kinso Computer page in the browser: Get yours.',
    text: "If you'd like the source, press Get yours on the page. It's thirty-nine dollars, once, and then one command installs it with your own agent.",
  });
});

test('the variant is chosen by the address: kinso.computer, or ?for=kinso anywhere; imperfect otherwise', () => {
  assert.deepEqual(KINSO_HOSTS, ['kinso.computer', 'www.kinso.computer']);
  for (const hostname of ['kinso.computer', 'www.kinso.computer', 'KINSO.computer']) assert.equal(variantId({ hostname }), 'kinso', hostname);
  assert.equal(variantId({ hostname: '127.0.0.1', search: '?for=kinso' }), 'kinso');
  assert.equal(variantId({ hostname: 'imperfect.computer', search: '?a=1&for=kinso' }), 'kinso');
  for (const place of [{}, { hostname: 'imperfect.computer' }, { hostname: 'www.imperfect.computer' }, { hostname: 'computer.kinso.computer' },
    { hostname: 'kinso.computer.evil.test' }, { hostname: 'imperfect.computer', search: '?for=someone' }, { hostname: 'imperfect.computer', search: '?for=KINSO' }]) {
    assert.equal(variantId(place), 'imperfect', JSON.stringify(place));
  }
});

test('imperfect.computer keeps its own Dock, steps, lettering and phone; Kinso\'s differs only where it says', async () => {
  const plain = VARIANTS.imperfect;
  assert.deepEqual(plain.dock.map(([id]) => id), ['finder', 'safari', 'claude', 'chatgpt', 'imperfect', 'final-cut', 'imovie', 'notes', 'settings', 'app-store', 'launchpad', 'trash']);
  assert.deepEqual(plain.assembly, ['bare', 'claude', 'codex', 'files', 'browser', 'done']);
  assert.match(plain.lettering.src, /assets\/wordmark\/imperfect-spiky\.png$/);
  assert.deepEqual(plain.lettering.size, [1301, 728]);
  assert.equal(plain.lettering.stays, undefined); assert.equal(plain.lettering.standIn, undefined);
  assert.equal(plain.for, null); assert.equal(plain.phone, true); assert.equal(plain.lock, null); assert.equal(plain.title, null);
  assert.equal(plain.menu.last, 'Shop');
  const kinso = VARIANTS.kinso;
  assert.match(plain.wallpaper, /\/mac\/wallpaper\.webp$/);
  assert.match(kinso.wallpaper, /\/mac\/wallpaper-kinso\.webp$/);
  assert.equal(kinso.name, 'Kinso'); assert.equal(kinso.title, 'Kinso Computer'); assert.equal(kinso.lock.name, 'Kinso');
  assert.deepEqual(kinso.assembly, ['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']);
  assert.deepEqual(kinso.dock.map(([id]) => id), ['finder', 'safari', 'claude', 'chatgpt', 'gmail', 'linkedin', 'instagram', 'kinso', 'settings', 'app-store', 'launchpad', 'trash']);
  assert.equal(kinso.for, 'kinso'); assert.equal(kinso.phone, false); assert.equal(kinso.menu.last, null);
  // Kinso's colour logo, served from the git-ignored rebuild; never a file in this source.
  assert.equal(kinso.lettering.src, '/kinso/a/aa106999c9d67289.png');
  assert.deepEqual(kinso.lettering.size, [919, 1024]);
  assert.equal(kinso.lettering.colour, true);
  assert.deepEqual(kinso.lettering.drawOn, {
    src: '/kinso/logo-draw.svg?v=kinso-logo-lock-1', timing: '/kinso/logo-draw.json?v=kinso-logo-lock-1',
  });
  assert.deepEqual(kinso.lettering.mass, [-0.00547, 0.01372]);
  const { placeWordmark } = await import('../../website/wordmark.mjs');
  for (const [w, h] of [[1920, 1080], [390, 844]]) {
    const [x, y, mw, mh] = placeWordmark(w, h, kinso.lettering);
    assert.ok(Math.abs((w < h ? mw / w : mh / h) - (w < h ? .36 : .22)) < 1e-9);
    assert.equal(x + mw / 2, w / 2); assert.equal(y + mh / 2, h / 2);
  }
  assert.equal(kinso.lettering.stays, true); assert.equal(typeof kinso.lettering.standIn, 'function');
  for (const [id] of kinso.dock.filter(([id]) => id !== 'kinso' && id !== 'trash')) assert.ok(await exists(join(SITE, 'mac/icons', `dock-${id}.webp`)), id);
});

test('the Dock\'s new inboxes are drawn here; Kinso\'s own icon is drawn by the page from their logo', async () => {
  for (const id of ['gmail', 'linkedin', 'instagram']) {
    const bytes = await readFile(join(SITE, 'mac/icons', `dock-${id}.webp`));
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', id);
  }
  assert.equal(await exists(join(SITE, 'mac/icons/dock-kinso.webp')), false);
});

test('kinso.computer\'s Shop is Kinso\'s, without a ?for= in its address', () => {
  const mac = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' };
  assert.equal(visitorShopURL(mac, '', 'kinso'), 'https://kinso.computer/kinso/');
  assert.equal(visitorShopURL(mac, '?for=kinso'), 'https://kinso.computer/kinso/');
  assert.equal(visitorShopURL(mac, ''), 'https://imperfect.computer/shop?os=mac');
  assert.equal(visitorShopURL(mac, '', 'someone'), 'https://imperfect.computer/shop?os=mac');
});

test('the words: part 1 on the film, part 2 in eleven beats, read at a speaking pace until Noah records them', () => {
  assert.equal(OPENER.length, 5); assert.equal(BEATS.length, 11);
  for (const beat of BEATS) assert.ok(beat.name && beat.text, beat.name);
  const opener = speak(OPENER), build = speak(BEATS.map(beat => beat.text));
  assert.ok(opener.duration > 60 && opener.duration < 100, `part 1 reads in ${opener.duration} s`);
  assert.ok(build.duration > 110 && build.duration < 170, `part 2 reads in ${build.duration} s`);
  for (const [i, word] of build.words.entries()) {
    assert.ok(word.end > word.start, word.text);
    if (i) assert.ok(word.start >= build.words[i - 1].end - 1e-9, `${word.text} follows`);
  }
  for (let p = 1; p < BEATS.length; p++) assert.ok(paraStart(build.words, p) > paraStart(build.words, p - 1));
  const lines = captions(build.words);
  for (const line of lines) assert.ok(line.text.split(' ').length <= 13 + 4, line.text);
  assert.equal(lines.map(line => line.text).join(' '), build.words.map(word => word.text).join(' '), 'every word, once, in order');
  assert.equal(captionAt(lines, -1), null);
  assert.equal(captionAt(lines, lines[1].start + .01).text, lines[1].text);
});

test('every step of the build lands on a word that is said in its beat', () => {
  const { words } = speak(BEATS.map(beat => beat.text));
  const said = (para, word) => words.some(w => w.para === para && norm(w.text) === norm(word));
  for (const drag of DRAGS) assert.ok(said(drag.on.para, drag.on.word), `${drag.app}: "${drag.on.word}" in beat ${drag.on.para + 1}`);
  for (const [name, cue] of Object.entries(MOMENTS)) if (cue.word) assert.ok(said(cue.para, cue.word), `${name}: "${cue.word}" in beat ${cue.para + 1}`);
  const times = DRAGS.map(drag => cueTime(words, drag.on));
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'the apps go in the order they are named');
  assert.deepEqual(DRAGS.map(drag => drag.build).filter(Boolean), ['claude', 'codex', 'files', 'browser', 'messages']);
  assert.ok(cueTime(words, MOMENTS.done) < cueTime(words, MOMENTS.page) && cueTime(words, MOMENTS.page) < cueTime(words, MOMENTS.letGo));
  assert.equal(MOMENTS.glow, undefined); assert.equal(MOMENTS.code, undefined);
});

test('Noah\'s recording drops in: its word timings move every cue, and a pinned beat holds', () => {
  const paragraphs = BEATS.map(beat => beat.text), read = speak(paragraphs);
  // A take at a different speed, with a word misheard and one dropped: the cues follow the take.
  const recorded = { duration: read.duration * 1.3, words: read.words.flatMap((word, i) => i === 7 ? [] : [{ text: i === 12 ? 'harnessez' : word.text, start: word.start * 1.3, end: word.end * 1.3 }]) };
  const heard = align(paragraphs, recorded);
  assert.equal(heard.words.length, read.words.length, 'every scripted word has a time');
  for (const drag of DRAGS) assert.ok(Math.abs(cueTime(heard.words, drag.on) - cueTime(read.words, drag.on) * 1.3) < .05, drag.app);
  assert.equal(heardWords(recorded, heard).length, recorded.words.length);
  // An aside before beat 3 that says its first word ("Then") would take its place; pinned to its own beat, it cannot.
  const at = read.words.findIndex(word => word.para === 2), real = read.words[at];
  const aside = { text: 'then', start: real.start - .5, end: real.start - .3 };
  const take = { duration: read.duration, words: [...read.words.slice(0, at).map(word => ({ ...word })), aside, ...read.words.slice(at).map(word => ({ ...word }))] };
  assert.equal(align(paragraphs, take).words[at].start, aside.start, 'unpinned, the aside is taken for the beat');
  aside.beat = 2;
  assert.equal(align(paragraphs, take).words[at].start, real.start, 'pinned to beat 2, the beat starts on its own word');
});

test('the recordings named in script.mjs are there; the media folder holds nothing else of Kinso\'s', async () => {
  const named = [MEDIA.opener?.video ?? MEDIA.opener, MEDIA.opener?.words, MEDIA.launch?.video ?? MEDIA.launch, MEDIA.voiceover?.audio, MEDIA.voiceover?.words].filter(Boolean);
  for (const path of named) assert.ok(await exists(join(SITE, path.replace(/\?.*$/, ''))), path);
  const own = join(SITE, 'media/kinso');
  if (await exists(own)) for (const name of await readdir(own)) assert.match(name, /^(?:opener|launch|voiceover)(?:\.words)?\.(?:mp4|m4a|webm|mp3|json)$/, name);
});

test('Kinso\'s files stay out of this source; the computer\'s own address is never shown on kinso.computer', async () => {
  const run = promisify(execFile);
  const tracked = (await run('git', ['ls-files'], { cwd: ROOT, maxBuffer: 1 << 26 })).stdout.split('\n');
  assert.deepEqual(tracked.filter(path => path.startsWith('locker/public/store/kinso/')), []);
  assert.deepEqual(tracked.filter(path => /logo-draw\.(?:svg|json)$/.test(path)), [], 'client paths and calibration are never vendored');
  assert.deepEqual(tracked.filter(path => /\.woff2?$/.test(path) && path.startsWith('website/for-kinso/')), []);
  const ours = (await readdir(join(SITE, 'for-kinso'))).filter(name => /\.(?:mjs|css)$/.test(name));
  assert.deepEqual(ours.sort(), ['brand.mjs', 'build.mjs', 'film.mjs', 'kinso.css', 'lock-sharks.mjs', 'logo-lock.mjs', 'narration.mjs', 'script.mjs', 'sharks.mjs', 'site.mjs', 'timeline.mjs']);
  for (const name of ours) {
    const text = await readFile(join(SITE, 'for-kinso', name), 'utf8');
    assert.doesNotMatch(text, /computer\.kinso\.computer|noah\.imperfect\.computer/, `${name} names no computer`);
    // Their pictures and type are only ever asked for at /kinso/a/ (the git-ignored rebuild), never fetched elsewhere.
    for (const [, url] of text.matchAll(/url\(['"]?([^'")]+)/g)) assert.match(url, /^\/kinso\/a\/[0-9a-f]{16}\.woff2$/, url);
  }
  for (const name of ['launch.mjs', 'variant.mjs', 'index.html']) assert.doesNotMatch(await readFile(join(SITE, name), 'utf8'), /computer\.kinso\.computer/, name);
});

test('the locker names kinso.computer\'s front page for Kinso and serves their logo from the git-ignored copy, on any name', async () => {
  const page = kinsoFront(await readFile(join(SITE, 'index.html'), 'utf8'));
  assert.match(page, /<title>Kinso Computer<\/title>/);
  assert.match(page, /<meta property="og:title" content="Kinso Computer">/);
  assert.match(page, /<meta property="og:image" content="https:\/\/kinso\.computer\/kinso\/a\/[0-9a-f]{16}\.png">/);
  assert.match(page, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(page, /<title>imperfect<\/title>|og\.png/);
  assert.match(page, /launch\.mjs\?v=kinso-lift-2/);

  const publicDir = await mkdtemp(join(tmpdir(), 'kinso-public-'));
  await mkdir(join(publicDir, 'store/kinso/a'), { recursive: true });
  await writeFile(join(publicDir, 'store/kinso/a/0123456789abcdef.png'), 'mark');
  await writeFile(join(publicDir, 'store/kinso/index.html'), '<title>Kinso Computer</title><p>US$39 a month</p>');
  await writeFile(join(publicDir, 'store/kinso/kinso.js'), '// concept');
  await writeFile(join(publicDir, 'store/private.html'), 'not a concept');
  const app = await createLockerServer({ store: openStore(), stripe: null, mail: { configured: false, async send() {} },
    config: { secure: false, hosts: 'shop.test', stripe: {} }, publicDir, websiteDir: SITE, port: 0, log: { info() {}, warn() {}, error() {} } });
  const { port } = await app.listen();
  const get = (host, path) => new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
  try {
    for (const host of ['kinso.computer', 'www.kinso.computer']) {
      const front = await get(host, '/');
      assert.equal(front.status, 200); assert.match(front.body, /<title>Kinso Computer<\/title>/);
      assert.match(front.headers['content-security-policy'], /frame-ancestors 'self'/);
    }
    assert.match((await get('elsewhere.test', '/')).body, /<title>imperfect<\/title>/, 'other names keep imperfect\'s page');
    for (const host of ['kinso.computer', 'elsewhere.test', 'shop.test']) {
      const mark = await get(host, '/kinso/a/0123456789abcdef.png');
      assert.equal(mark.status, 200, host); assert.equal(mark.body, 'mark'); assert.equal(mark.headers['content-type'], 'image/png');
      assert.equal((await get(host, '/kinso/a/missing.png')).status, 404);
    }
    const concept = await get('kinso.computer', '/kinso/');
    assert.match(concept.body, /US\$39/);
    const policy = concept.headers['content-security-policy'];
    assert.match(policy, /frame-ancestors 'self' https:\/\/computer\.kinso\.computer https:\/\/kinso\.computer https:\/\/www\.kinso\.computer;/);
    assert.match(policy, /script-src 'self'; style-src 'self';/);
    assert.match(policy, /frame-src 'none'; form-action 'none';/);
    assert.doesNotMatch(policy, /unsafe-|\*|checkout\.stripe/);
    assert.match(concept.headers['cache-control'], /max-age=300,/);
    const freshEmbed = await get('kinso.computer', '/kinso/?v=kinso-embed-1');
    assert.equal(freshEmbed.status, 200);
    assert.equal(freshEmbed.body, concept.body);
    assert.equal(freshEmbed.headers['content-security-policy'], policy);
    const shop = await get('shop.test', '/shop');
    assert.match(shop.headers['content-security-policy'], /frame-ancestors 'none';/);
    assert.match(shop.headers['content-security-policy'], /frame-src 'none';/);
    assert.equal((await get('kinso.computer', '/kinso/kinso.js')).status, 200);
    assert.equal((await get('kinso.computer', '/kinso/a/../../../../package.json')).status, 404);
    assert.equal((await get('kinso.computer', '/kinso/%2f..%2fprivate.html')).status, 404, 'concept CSP never applies to other store files');
    assert.equal((await get('kinso.computer', '/for-kinso/site.mjs')).status, 200);
    for (const host of ['kinso.computer', 'www.kinso.computer']) {
      const install = await get(host, '/install');
      assert.equal(install.status, 200, host);
      assert.equal(install.headers['content-type'], 'text/plain; charset=utf-8');
      assert.match(install.body, /^#!\/bin\/sh\n/);
      assert.match(install.body, /repo='https:\/\/github\.com\/locusrifle\/kinso\.computer'/);
      assert.match(install.body, /dest="\$HOME\/imperfect"/);
      assert.doesNotMatch(install.body, /locusrifle\/imperfect\b|sudo/);
      await promisify(execFile)('sh', ['-n', '-c', install.body]);
    }
    assert.notEqual((await get('elsewhere.test', '/install')).body.includes('kinso.computer'), true, 'only Kinso\'s names give Kinso\'s installer');
  } finally { await app.close(); await rm(publicDir, { recursive: true, force: true }); }
});

test('every import of a changed module asks for it under one tag, so the page loads each once', async () => {
  const sources = [];
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!['vendor', 'node_modules', 'media', 'assets'].includes(entry.name)) await walk(path); }
    else if (/\.(?:mjs|html)$/.test(entry.name)) sources.push(path);
  } };
  await walk(SITE); sources.push(join(ROOT, 'desktop/lock/lock.mjs'), join(ROOT, 'desktop/lock/index.html'));
  const tags = new Map();
  for (const file of sources) {
    for (const [, spec, tag] of (await readFile(file, 'utf8')).matchAll(/(?:from |import\(|src=)['"]([^'"?]+\.mjs)\?v=([^'"]+)['"]/g)) {
      const target = relative(ROOT, join(file, '..', spec));
      (tags.get(target) ?? tags.set(target, new Set()).get(target)).add(tag);
    }
  }
  for (const [target, seen] of tags) assert.equal(seen.size, 1, `${target}: ${[...seen].join(', ')}`);
  // Every changed module and each tagged path to it asks for the new copy: the lock's lift (launch-config, macos/lock,
  // macos/launch, lock-sharks, variant's wallpapers) followed through every importer, including the native lock.
  for (const target of ['website/variant.mjs', 'website/wordmark.mjs', 'website/mac/shell.mjs', 'website/boot/sequence.mjs',
    'website/intro/intro.mjs', 'website/intro/goat.mjs', 'website/for-kinso/site.mjs', 'website/launch.mjs',
    'website/launch-config.mjs', 'website/for-kinso/lock-sharks.mjs', 'website/for-kinso/logo-lock.mjs',
    'website/macos/launch.mjs', 'website/macos/quicktime.mjs', 'website/macos/lock.mjs'])
    assert.deepEqual([...tags.get(target)], ['kinso-lift-2'], target);
  // The logo's own modules are unchanged since they drew it.
  for (const target of ['website/for-kinso/build.mjs', 'website/for-kinso/film.mjs', 'website/for-kinso/script.mjs', 'website/draw-on.mjs'])
    assert.deepEqual([...tags.get(target)], ['kinso-logo-lock-1'], target);
  // The shark engine (swimming, colours, no ink eyes) ships with the lift, so the lock asks for the new copy too.
  assert.deepEqual([...tags.get('website/for-kinso/sharks.mjs')], ['kinso-lift-2']);
  assert.match(await readFile(join(SITE, 'for-kinso/site.mjs'), 'utf8'), /kinso\.css\?v=kinso-lift-2/);
  // The native page is served with website as its base, not from its source directory.
  assert.match(await readFile(join(ROOT, 'desktop/lock/index.html'), 'utf8'), /lock\.mjs\?v=kinso-lift-2/);
  assert.match(await readFile(join(SITE, 'index.html'), 'utf8'), /mac\/desktop\.css\?v=kinso-logo-lock-1/);
});
