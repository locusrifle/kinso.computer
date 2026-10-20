import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get } from 'node:http';
import { createPhoneApp } from '../../../../system/phone-app.mjs';

async function serve(handler) {
  const server = createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end('none'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the phone asks which APK is current and fetches it here, or from the PC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-app-'));
  const sha256 = 'a'.repeat(64);
  try {
    for (const name of ['pc', 'laptop']) {
      await mkdir(join(dir, name, 'downloads'), { recursive: true });
      await writeFile(join(dir, name, 'binaries.json'), JSON.stringify({ android: { file: 'imperfect-android-1.apk', sha256, size: 3 } }));
    }
    await writeFile(join(dir, 'pc', 'downloads', 'imperfect-android-1.apk'), 'apk');
    const pc = await serve(createPhoneApp({ root: join(dir, 'pc'), downloads: join(dir, 'pc', 'downloads') }));
    const laptop = await serve(createPhoneApp({ root: join(dir, 'laptop'), downloads: join(dir, 'laptop', 'downloads'), authority: async () => pc.url }));
    try {
      assert.deepEqual(await (await fetch(`${laptop.url}/phone/android.json`)).json(), { sha256, size: 3 });
      const here = await fetch(`${pc.url}/phone/android.apk`);
      assert.equal(here.headers.get('content-type'), 'application/vnd.android.package-archive');
      assert.equal(await here.text(), 'apk');
      assert.equal(await (await fetch(`${laptop.url}/phone/android.apk`)).text(), 'apk', 'through the PC');
      assert.equal((await fetch(`${pc.url}/phone/android.apk`, { method: 'POST' })).status, 404);
    } finally { await laptop.close(); await pc.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// fetch() sends its own Host; the page is about the name it was asked by.
const asked = (url, host) => new Promise((resolve, reject) => {
  get(`${url}/phone`, { headers: { host } }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('the QR page opens the app on this computer, or downloads it', async () => {
  const site = await serve(createPhoneApp({ root: tmpdir(), downloads: tmpdir() }));
  try {
    const page = await asked(site.url, 'desk.tail-name.ts.net');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('href="intent://desk.tail-name.ts.net#Intent;scheme=imperfect;package=computer.imperfect.code;S.browser_fallback_url=https%3A%2F%2Fdesk.tail-name.ts.net%2Fphone%2Fandroid.apk;end"'));
    assert.ok(page.body.includes('href="https://desk.tail-name.ts.net/phone/android.apk"'));
    assert.equal((await asked(site.url, 'x"><script>')).status, 400);
  } finally { await site.close(); }
});
