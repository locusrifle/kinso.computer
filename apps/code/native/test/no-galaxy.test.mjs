import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
const root = new URL('../../../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
test('effect sources are removed, not just hidden: lock, website, composer and account pages stay renderer-free', async () => {
  for (const path of ['website/scene.mjs', 'website/sky.mjs', 'website/stars.mjs', 'website/blackhole/blackhole.mjs', 'website/opener/air.mjs', 'apps/code/native/public/js/kept-sky.js', 'apps/code/native/public/js/stardust.js']) {
    await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' }, path);
  }
  for (const path of ['website/boot/sequence.mjs', 'website/intro/intro.mjs', 'desktop/lock/lock.mjs', 'website/launch.mjs', 'website/reveal.mjs', 'apps/code/native/public/js/arrival.js']) {
    assert.doesNotMatch(await read(path), /createStars|createSky|createAir|createScene|contactBurst|kept-sky|warpTable|warpOf/);
  }
  for (const path of ['website/index.html', 'desktop/lock/index.html']) assert.doesNotMatch(await read(path), /galaxyScene/);
  assert.doesNotMatch(await read('website/landing.css'), /radial-gradient|body::before/);
  assert.doesNotMatch(await read('apps/code/native/public/css/imperfect.css'), /\.kept-sky|\.stardust/);
});
test('the shared browser fixture stays lightweight after removal of the website sky ingress', async () => {
  await assert.rejects(access(new URL('system/website-sky.mjs', root)), { code: 'ENOENT' });
  const fixture = await read('apps/code/native/test/fixtures/harness-page.mjs');
  assert.match(fixture, /import \{ launchChromium, TEST_TIMEOUT \} from/);
  assert.doesNotMatch(fixture, /system\/server\.mjs|WEBSITE_SKY|website-sky\.mjs/);
  assert.doesNotMatch(await read('system/server.mjs'), /WEBSITE_SKY|website-sky\.mjs/);
});
test('every changed website/file-lock import edge selects the fresh no-effect graph', async () => {
  for (const [path, edge] of [
    ['website/index.html', 'launch.mjs'], ['website/index.html', 'sequence.css'],
    ['website/launch.mjs', 'intro/intro.mjs'], ['website/launch.mjs', 'film.mjs'], ['website/launch.mjs', 'launch-config.mjs'],
    ['website/intro/intro.mjs', 'boot/sequence.mjs'], ['desktop/lock/lock.mjs', 'boot/sequence.mjs'],
    ['website/boot/sequence.mjs', 'reveal.mjs'], ['website/sequence.css', 'boot/sequence.css'],
    ['desktop/lock/index.html', 'desktop/lock/lock.mjs'], ['desktop/lock/index.html', 'boot/sequence.css'], ['desktop/lock/index.html', 'style.css'],
    ['website/host.html', 'landing.css'], ['locker/accounts.mjs', 'landing.css'], ['locker/server.mjs', 'landing.css'], ['locker/shop.mjs', 'landing.css'],
  ]) assert.match(await read(path), new RegExp(`${edge.replace(/\./g, '\\.')}\\?v=(?:plain|kinso)-1\\b`), `${path} refreshes ${edge}`);
});
