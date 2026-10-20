// Notifications: an agent, or something of the person's own on this computer
// (a website's enquiry form, a timer), taps them on the shoulder on every
// device they turned notifications on for, even with imperfect closed.
//
// Web Push, with nothing in between but the browser's own push service
// (Google's for Chrome and Android, Mozilla's, Apple's for an iPhone's Home
// Screen app): this computer holds a VAPID key pair of its own, made the first
// time it is needed and kept in ~/.imperfect/push/ (never in the repository),
// and the subscriptions the person's devices gave it. Each message is
// encrypted to its device (RFC 8291) and signed as this computer (RFC 8292),
// so the push service carries it without being able to read it. public/sw.js
// shows it, and a tap opens imperfect at the session that sent it.
//
// Open windows are told too: imperfect's desktop app (Electron, which has no
// push service) and any window on a device not subscribed show it themselves
// (public/js/notify.js).
//
// Few and short: a title and a line, clipped, with anything shaped like a
// secret taken out, and at most a handful a minute, so nothing misbehaving
// can make a phone buzz all day.
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, createHmac, createCipheriv, randomBytes, sign, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialValues, redactor } from './memory.mjs';

const b64 = buffer => Buffer.from(buffer).toString('base64url');
const unb64 = text => Buffer.from(String(text ?? ''), 'base64url');

/* ------------------------------------------------------------- Web Push */

// RFC 8291: the message, encrypted to one subscription (aes128gcm, one record).
// salt and sender are only given by the tests (RFC 8291's own example).
export function encrypt(plaintext, { p256dh, auth }, { salt = randomBytes(16), sender } = {}) {
  const receiver = unb64(p256dh), secret = unb64(auth);
  if (receiver.length !== 65 || receiver[0] !== 4 || secret.length !== 16) throw new Error('not a push subscription');
  const ecdh = createECDH('prime256v1');
  if (sender) ecdh.setPrivateKey(unb64(sender)); else ecdh.generateKeys();
  const ours = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiver);
  const ikm = Buffer.from(hkdfSync('sha256', shared, secret, Buffer.concat([Buffer.from('WebPush: info\0'), receiver, ours]), 32));
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const expand = (info, length) => createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, length);
  const cipher = createCipheriv('aes-128-gcm', expand('Content-Encoding: aes128gcm\0', 16), expand('Content-Encoding: nonce\0', 12));
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = ours.length;
  return Buffer.concat([header, ours, body]);
}

// RFC 8292: who is sending, signed with this computer's key, for one push service.
export function vapid(endpoint, keys, now = Date.now()) {
  const part = value => b64(JSON.stringify(value));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://imperfect.computer' })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

export function makeKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(publicJwk.x), unb64(publicJwk.y)])), privateJwk };
}

// The push services of the browsers people use. A subscription naming any
// other address is refused, so this computer only ever posts to them.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/, /^([a-z0-9-]+\.)*google\.com$/];
export const pushService = endpoint => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && !url.username && PUSH_HOSTS.some(host => host.test(url.hostname));
  } catch { return false; }
};

/* ---------------------------------------------------- what is said, how often */

const LIMITS = { title: 80, body: 240 };
const plain = (text, most) => {
  const flat = String(text ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
};
// A tag replaces the device's earlier notification with the same one.
const tagOf = tag => String(tag ?? '').replace(/[^\w.:-]/g, '').slice(0, 64);

// At most 5 a minute and 30 an hour, from everything on this computer together.
export function limiter({ minute = 5, hour = 30, now = () => Date.now() } = {}) {
  const sent = [];
  return () => {
    const at = now();
    while (sent.length && at - sent[0] >= 3600_000) sent.shift();
    const lastMinute = sent.filter(t => at - t < 60_000);
    if (lastMinute.length >= minute) return Math.ceil((lastMinute[0] + 60_000 - at) / 1000);
    if (sent.length >= hour) return Math.ceil((sent[0] + 3600_000 - at) / 1000);
    sent.push(at);
    return 0;
  };
}

/* --------------------------------------------------------------- the box */

// dir: ~/.imperfect/push (vapid.json, the key pair; devices.json, the
// subscriptions). tell(message): every open window. session(id): the session
// as the windows know it. send: fetch, or the tests' push service.
export function createNotify({ dir, tell = () => {}, session = id => id, send = fetch, accepts = pushService, credentials = null, allow = limiter(), log = message => console.log(`notify: ${message}`) } = {}) {
  let keys = null, devices = null, saving = Promise.resolve();
  const save = (name, value) => (saving = saving.then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const next = join(dir, `.${name}.${process.pid}.tmp`);
    await writeFile(next, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
    await rename(next, join(dir, name));
  }));
  async function key() {
    if (keys) return keys;
    try { keys = JSON.parse(await readFile(join(dir, 'vapid.json'), 'utf8')); }
    catch { keys = makeKeys(); await save('vapid.json', keys); }
    return keys;
  }
  async function list() {
    if (!devices) {
      try { devices = JSON.parse(await readFile(join(dir, 'devices.json'), 'utf8')); } catch { devices = []; }
      if (!Array.isArray(devices)) devices = [];
    }
    return devices;
  }
  async function subscribe(subscription, label = '') {
    const { endpoint, keys: { p256dh, auth } = {} } = subscription ?? {};
    if (!accepts(endpoint) || unb64(p256dh).length !== 65 || unb64(auth).length !== 16) throw Object.assign(new Error('not a push subscription'), { status: 400 });
    const kept = (await list()).filter(device => device.endpoint !== endpoint);
    // A device subscribes again whenever its push service changes its address; the oldest go first.
    devices = [...kept, { endpoint, p256dh, auth, label: plain(label, 60), since: new Date().toISOString() }].slice(-20);
    await save('devices.json', devices);
    return devices.length;
  }
  async function unsubscribe(endpoint) {
    const before = (await list()).length;
    devices = devices.filter(device => device.endpoint !== endpoint);
    if (devices.length !== before) await save('devices.json', devices);
  }

  // { title, body, tag, session } -> { devices, delivered, windows }
  async function notify({ title, body, tag, session: from } = {}) {
    const clean = redactor(credentials ? await credentialValues(credentials).catch(() => []) : []);
    // The tag also makes the windows and push of one device show it once.
    const message = { title: plain(clean(title ?? ''), LIMITS.title) || 'imperfect', body: plain(clean(body ?? ''), LIMITS.body), tag: tagOf(tag) || `n-${randomBytes(6).toString('hex')}` };
    if (!message.body && message.title === 'imperfect') throw Object.assign(new Error('a notification needs a title or a body'), { status: 400 });
    const wait = allow();
    if (wait) throw Object.assign(new Error(`too many notifications; try again in ${wait} s`), { status: 429, retryAfter: wait });
    const sessionId = from ? String(session(String(from)) || '').slice(0, 200) : '';
    if (sessionId) message.session = sessionId;
    message.url = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
    const windows = tell(message) ?? 0;
    const payload = JSON.stringify(message);
    const pair = await key();
    const gone = new Set();
    const results = await Promise.all((await list()).map(async device => {
      try {
        const response = await send(device.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapid(device.endpoint, pair),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            // An enquiry is worth delivering to a phone that was off for the night, not for a week.
            ttl: '86400',
            urgency: 'high',
            ...(message.tag ? { topic: b64(createHash('sha256').update(message.tag).digest()).slice(0, 32) } : {}),
          },
          body: encrypt(payload, device),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) log(`${new URL(device.endpoint).hostname} answered ${response.status} ${(await response.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ')}`);
        // Gone: the device unsubscribed, or the browser was removed. A 404 can
        // also come in a device's first moments (seen once from FCM), so only
        // an older one is forgotten for it.
        if (response.status === 410 || (response.status === 404 && Date.now() - Date.parse(device.since) > 3600_000)) gone.add(device.endpoint);
        return response.ok;
      } catch (error) {
        log(`${new URL(device.endpoint).hostname} unreachable (${error.message})`);
        return false;
      }
    }));
    if (gone.size) { devices = devices.filter(device => !gone.has(device.endpoint)); await save('devices.json', devices); }
    return { devices: results.length, delivered: results.filter(Boolean).length, windows };
  }

  const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); return true; };
  async function readJson(req, limit = 8192) {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limit) throw Object.assign(new Error('too long'), { status: 413 });
    }
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }

  // The windows' side, as they turn notifications on and off: GET /push/key,
  // POST /push/subscribe, POST /push/unsubscribe. The two POSTs are guarded
  // like /browser: the exact origin is required, which a page elsewhere cannot claim and /peer/
  // drops. Behind a door (a rented computer), only once signed in.
  // local(req): the request is something of the person's own on this computer
  // (loopback, with the session token), for POST /notify.
  return {
    notify,
    async handle(req, res, path, { local = async () => false } = {}) {
      if (path === '/notify') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (!await local(req)) return json(res, 403, { error: 'only this computer, with its session token' });
        try { return json(res, 200, await notify(await readJson(req))); }
        catch (error) { return json(res, error.status || 500, { error: error.message }, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}); }
      }
      if (!path.startsWith('/push/')) return false;
      try {
        // The public half only; a page's GET carries no origin to check.
        if (path === '/push/key' && req.method === 'GET') return json(res, 200, { key: (await key()).publicKey });
        if (!req.headers.origin) return json(res, 403, { error: 'exact origin required' });
        if (path === '/push/subscribe' && req.method === 'POST') {
          const { subscription, label } = await readJson(req);
          return json(res, 200, { devices: await subscribe(subscription, label) });
        }
        if (path === '/push/unsubscribe' && req.method === 'POST') {
          await unsubscribe(String((await readJson(req)).endpoint ?? ''));
          return json(res, 200, { ok: true });
        }
      } catch (error) { return json(res, error.status || 500, { error: error.message }); }
      return json(res, 404, { error: 'not found' });
    },
  };
}

/* --------------------------------------------------------------- the tool */

const BOX = Symbol.for('imperfect.notify');
export function provideNotify(box) { globalThis[BOX] = box; }

export const NOTIFY_TOOL = {
  name: 'notify',
  description: "Send the person a notification on their phone and other devices, even with imperfect closed; tapping it opens this session. It interrupts them, so use it rarely: only when they asked to hear about something, when a long job they are waiting on has finished or failed, or when something arrives that needs them soon (a client's enquiry). Never for progress, a normal end of turn they are watching, or anything they did not ask to know. A short title and one plain line; no secrets, links or code.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'a few words, e.g. "Render finished"' },
      body: { type: 'string', description: 'one short line: what happened and what, if anything, they need to do' },
      tag: { type: 'string', description: 'optional: a later notification with the same tag replaces this one on the device' },
      open_session: { type: 'boolean', description: 'tapping it opens this session (default true); false opens imperfect at its front' },
    },
    required: ['title', 'body'],
  },
};

export async function runNotify({ title, body, tag, open_session: here = true, session }) {
  const box = globalThis[BOX];
  if (!box) throw new Error('Notifications are not available here.');
  const { devices, delivered, windows } = await box.notify({ title, body, tag, session: here === false || here === 'false' ? '' : session });
  if (!devices && !windows) return 'Nobody will see this: no device has notifications turned on and no imperfect window is open. If they want notifications, tell them to open imperfect on their phone and choose Turn on when it offers.';
  return `Sent to ${delivered} of ${devices} device${devices === 1 ? '' : 's'} with notifications on${windows ? ` and ${windows} open window${windows === 1 ? '' : 's'}` : ''}.`;
}
