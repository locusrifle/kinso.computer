import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { hostedFixture } from './fixtures/hosted-pages.mjs';
import { runShow } from '../code-control.mjs';

test('re-show opens the original behind a tab the person has reused, rather than taking that tab away', { timeout: 60000 }, async t => {
  const fixture = await hostedFixture(t);
  const { root, json, ask, evaluate } = fixture;
  const firstPath = join(root, 'original'), secondPath = join(root, 'elsewhere');
  for (const [path, title] of [[firstPath, 'Original'], [secondPath, 'Elsewhere']]) {
    await mkdir(path);
    await writeFile(join(path, 'index.html'), `<title>${title}</title><script>window.loadId=Math.random()</script><h1>${title}</h1>`);
  }
  const original = await json('/shown/view', { target: firstPath });
  const elsewhere = await json('/shown/view', { target: secondPath });
  await ask({ do: 'open', tab: original.tab, url: elsewhere.url });
  const before = await evaluate(original.tab, 'window.loadId');
  assert.equal(await evaluate(original.tab, 'location.href'), elsewhere.url);
  const shownAgain = await json('/shown/view', { target: firstPath, reload: true });
  assert.notEqual(shownAgain.tab, original.tab, 'a cached id is not identity after the person navigates it');
  assert.equal(shownAgain.url, original.url);
  assert.equal(await evaluate(original.tab, 'location.href'), elsewhere.url);
  assert.equal(await evaluate(original.tab, 'window.loadId'), before, 'the person’s reused document is not reloaded either');
  assert.equal((await json('/shown/view', { target: firstPath })).tab, shownAgain.tab, 'the new original tab is reused normally');
  assert.deepEqual(fixture.pageErrors, []);
});

test('a legitimate initial redirect still reuses its shown tab on refresh', { timeout: 60000 }, async t => {
  const fixture = await hostedFixture(t);
  const site = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/landing' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Landing</title><script>window.loadId=Math.random()</script>Landing');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => site.close(resolve)));
  const url = `http://localhost:${site.address().port}/`;
  await runShow({ path: url, session: 'proof-session' });
  const first = await fixture.json('/shown/view', { target: url });
  assert.equal(new URL(first.url).pathname, '/landing');
  const load = await fixture.evaluate(first.tab, 'window.loadId');
  const refreshed = await fixture.json('/shown/view', { target: url, reload: true });
  assert.equal(refreshed.tab, first.tab);
  assert.equal(refreshed.url, first.url);
  assert.notEqual(await fixture.evaluate(first.tab, 'window.loadId'), load);
});
