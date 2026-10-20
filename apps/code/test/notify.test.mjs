import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createGueyServer } from '../../../system/server.mjs';
import { NOTIFY_TOOL, encrypt, limiter, makeKeys, provideNotify, pushService, runNotify, vapid } from '../../../system/notify.mjs';
import { TOOLS } from '../native/tools.mjs';
// A made-up Stripe-shaped key, assembled here so the store's secret check never sees one.
const FAKE_STRIPE = ['sk', 'live', '51HqTotallySecretValue000'].join('_');

const unb64 = text => Buffer.from(text, 'base64url');

// RFC 8291, section 5: the example message, encrypted exactly as the RFC does.
test('a push message is encrypted to its device exactly as RFC 8291 says', () => {
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'), sender: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' });
  assert.equal(out.subarray(0, 21).toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABB');
  assert.equal(out.subarray(21, 86).toString('base64url'), 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  assert.equal(out.subarray(86).toString('base64url'), '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
});

test('the VAPID header is an ES256 token for the push service, signed by this computer', () => {
  const keys = makeKeys();
  const header = vapid('https://fcm.googleapis.com/fcm/send/abc', keys, Date.UTC(2026, 9, 14));
  const [, token, key] = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
  assert.equal(key, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(unb64(head)), { typ: 'JWT', alg: 'ES256' });
  const body = JSON.parse(unb64(claims));
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.equal(body.exp, Date.UTC(2026, 9, 14) / 1000 + 12 * 3600);
  const raw = unb64(keys.publicKey);
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, unb64(signature)));
});

test('only the browsers\' own push services are posted to', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://jmt17.google.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(pushService(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.com/fcm.googleapis.com', 'https://google.com.evil.com/x', 'https://u:p@fcm.googleapis.com/x', 'file:///etc/passwd', 'nonsense']) assert.ok(!pushService(bad), bad);
});

test('at most five a minute and thirty an hour', () => {
  let now = 0;
  const allow = limiter({ now: () => now });
  for (let i = 0; i < 5; i++) assert.equal(allow(), 0);
  assert.equal(allow(), 60);
  for (let minute = 1; minute < 6; minute++) { now = minute * 60_000; for (let i = 0; i < 5; i++) assert.equal(allow(), 0); }
  now = 6 * 60_000;
  assert.ok(allow() > 3000, 'thirty in the hour');
  now = 3600_000;
  assert.equal(allow(), 0);
});

// A device, as a browser makes one: its key pair and auth secret. decrypt is
// the device's side of RFC 8291, written here independently of encrypt.
function device(endpoint) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    decrypt(body) {
      const salt = body.subarray(0, 16), length = body[20], sender = body.subarray(21, 21 + length);
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(sender), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]), 32));
      const prk = createHmac('sha256', salt).update(ikm).digest();
      const expand = (info, n) => createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, n);
      const data = body.subarray(21 + length);
      const decipher = createDecipheriv('aes-128-gcm', expand('Content-Encoding: aes128gcm\0', 16), expand('Content-Encoding: nonce\0', 12));
      decipher.setAuthTag(data.subarray(-16));
      const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'one record, the last');
      return JSON.parse(plain.subarray(0, -1));
    },
  };
}

async function world(t, { status = 201 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notify-'));
  await mkdir(join(root, 'credentials'));
  await writeFile(join(root, 'credentials', 'stripe'), FAKE_STRIPE + '\n');
  const pushed = [];
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [{ id: 'tab-7', sessionId: 'sess-7', focused: true }] }),
    async command() { return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, sessionToken: 'tok',
    notify: { dir: join(root, 'push'), credentials: join(root, 'credentials'), accepts: url => url.startsWith('https://push.test/'),
      send: async (url, init) => { pushed.push({ url, ...init }); return new Response('', { status: typeof status === 'function' ? status(url) : status }); } } });
  const { port } = await app.listen();
  t.after(async () => { await app.close(); provideNotify(undefined); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const page = (path, body) => fetch(`${origin}${path}`, body === undefined ? { headers: { origin } } : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const local = (body, headers = {}) => fetch(`${origin}/notify`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, port, origin, pushed, page, local };
}

test('a device turns notifications on; POST /notify reaches it encrypted, opening the session that sent it, with secrets taken out', async t => {
  const w = await world(t);
  const { key } = await (await fetch(`${w.origin}/push/key`)).json();
  assert.equal((await fetch(`${w.origin}/push/subscribe`, { method: 'POST', body: '{}' })).status, 403, 'a page must say its origin');
  assert.equal(unb64(key).length, 65);
  const vapidFile = await stat(join(w.root, 'push', 'vapid.json'));
  assert.equal(vapidFile.mode & 0o777, 0o600, 'the private key is the person\'s alone');
  assert.equal((await w.page('/push/key').then(r => r.json())).key, key, 'one key pair, kept');

  const phone = device('https://push.test/phone');
  assert.equal((await w.page('/push/subscribe', { subscription: { ...phone.subscription, endpoint: 'https://elsewhere.test/x' } })).status, 400);
  assert.deepEqual(await (await w.page('/push/subscribe', { subscription: phone.subscription, label: 'phone' })).json(), { devices: 1 });
  assert.deepEqual(await (await w.page('/push/subscribe', { subscription: phone.subscription })).json(), { devices: 1 }, 'the same device once');

  const res = await w.local({ title: 'New website enquiry', body: `Ada asked for a quote. key ${FAKE_STRIPE}`, tag: 'enquiry-1', session: 'tab-7' });
  assert.deepEqual(await res.json(), { devices: 1, delivered: 1, windows: 0 });
  const [push] = w.pushed;
  assert.equal(push.url, 'https://push.test/phone');
  assert.match(push.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(push.headers['content-encoding'], 'aes128gcm');
  assert.equal(push.headers.urgency, 'high');
  assert.ok(!push.body.includes('Ada'), 'the push service cannot read it');
  assert.deepEqual(phone.decrypt(push.body), { title: 'New website enquiry', body: 'Ada asked for a quote. key [redacted]', tag: 'enquiry-1', session: 'sess-7', url: '/?session=sess-7' });
});

test('POST /notify is for this computer alone: loopback, no page origin, the session token', async t => {
  const w = await world(t);
  assert.equal((await w.local({ title: 'x', body: 'y' }, { authorization: 'Bearer nope' })).status, 403);
  assert.equal((await w.local({ title: 'x', body: 'y' }, { origin: w.origin })).status, 403, 'a page cannot ask, even with the token');
  // Through a door, the Host is the computer's own name, never loopback.
  const viaDoor = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: w.port, path: '/notify', method: 'POST', headers: { host: 'tom.imperfect.computer', authorization: 'Bearer tok', 'content-type': 'application/json' } }, resolve);
    req.on('error', reject); req.end('{"title":"x","body":"y"}');
  });
  assert.equal(viaDoor.statusCode, 403);
  assert.equal((await w.local({})).status, 400, 'something to say');
  assert.equal((await w.local({ title: 'x', body: 'y' })).status, 200);
});

test('a flood is refused, long text is clipped, and a device the push service no longer knows is forgotten', async t => {
  const w = await world(t, { status: url => (url.endsWith('/gone') ? 410 : 201) });
  for (const name of ['phone', 'gone']) await w.page('/push/subscribe', { subscription: device(`https://push.test/${name}`).subscription });
  const first = await (await w.local({ title: 'T'.repeat(500), body: 'line one\nline two '.repeat(100) })).json();
  assert.deepEqual(first, { devices: 2, delivered: 1, windows: 0 });
  const kept = JSON.parse(await readFile(join(w.root, 'push', 'devices.json'), 'utf8'));
  assert.deepEqual(kept.map(d => d.endpoint), ['https://push.test/phone']);
  assert.equal((await stat(join(w.root, 'push', 'devices.json'))).mode & 0o777, 0o600);
  for (let i = 0; i < 4; i++) assert.equal((await w.local({ title: 'x', body: String(i) })).status, 200);
  const flood = await w.local({ title: 'x', body: 'six' });
  assert.equal(flood.status, 429);
  assert.ok(Number(flood.headers.get('retry-after')) > 0);
});

test('open windows are told too, and the notify tool is every harness\'s', async t => {
  const w = await world(t);
  assert.ok(TOOLS.some(([tool, run]) => tool === NOTIFY_TOOL && run === runNotify));
  assert.match(NOTIFY_TOOL.description, /use it rarely/);
  assert.match(await runNotify({ title: 'x', body: 'y', session: 'sess-7' }), /Nobody will see this/);
  const ws = new WebSocket(`ws://127.0.0.1:${w.port}/pi`, { headers: { origin: w.origin } });
  const told = new Promise(resolve => ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'notify') resolve(m); }));
  await new Promise(resolve => ws.once('open', resolve));
  try {
    assert.match(await runNotify({ title: 'Render finished', body: 'film.mp4 is ready', session: 'sess-7' }), /Sent to 0 of 0 devices with notifications on and 1 open window/);
    const { tag, ...rest } = await told;
    assert.deepEqual(rest, { type: 'notify', title: 'Render finished', body: 'film.mp4 is ready', session: 'sess-7', url: '/?session=sess-7' });
    assert.match(tag, /^n-[0-9a-f]{12}$/, 'one tag, so a device showing it twice shows it once');
    await runNotify({ title: 'a', body: 'b', session: 'sess-7', open_session: false });
  } finally { ws.terminate(); }
});
