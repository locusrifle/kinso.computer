// The launch page's lock (website/lock.mjs): passwords opening a computer. They are checked here,
// never in the page (the site's source is public), and live outside the repository, in a private file:
//
//   ~/.imperfect/credentials/site-locks.json   (mode 600; SITE_LOCKS_FILE in locker.env names another inside credentials)
//   { "version": 1,
//     "secret": "<hex: signs the cookie that remembers an unlock>",
//     "salt": "<hex>", "scrypt": { "N": 16384, "r": 8, "p": 1 },
//     "locks": [ { "id": "<id>", "url": "https://<id>.noah.imperfect.computer", "ticket": true, "hashes": ["<hex>", ...] } ] }
//
// A password is matched in any capitals and without the spaces round it (phones capitalise the first letter): its
// scrypt hash, with the file's one salt, against every lock's. One lock may have several (two spellings of one name).
//
// What a lock opens: its url, or with "ticket" its imperfect's door, with a ticket the door checks and turns into its
// own session (no second password): <url>/door/ticket?t=<token>, the token
//   base64url(payload) "." base64url(HMAC-SHA256(door secret, base64url(payload)))   (base64url unpadded)
//   payload: {"id":"<lock id>","exp":<unix seconds, now + 60>,"n":"<16 random bytes, base64url>"}
// the door secret 32 random bytes, stored raw in ~/.imperfect/credentials/site-door-secret (mode 600), the same file
// on the workbenches' computer. A fresh ticket is minted for every answer, so the page asks again just before it
// mounts the frame.
//
// The routes (server.mjs, on every host the site is served on):
//   POST /unlock {password}  right: 200 {ok, workbench: {id, url}} and an HttpOnly, Secure, SameSite=Strict cookie;
//                            wrong, unknown or too many tries: 401/429 {ok: false}, the same to the page.
//   GET /unlock              the cookie's workbench again (a reload does not ask), with a fresh ticket; else 401.
// The page's Content-Security-Policy frames only the origins the file names (frameOrigins).
//
// Change it with (no restart: the locker reads the file again when it changes):
//   node locker/site-locks.mjs add <id> <password> [<workbench-url> [--ticket]]   (a new id needs its url; "-": the
//                                                                                password from stdin)
//   node locker/site-locks.mjs replace <id> <password> <workbench-url> [--ticket] (only this lock/password; rotates
//                                                                                the remembered-unlock secret)
//   node locker/site-locks.mjs url <id> <workbench-url> [--ticket]
//   node locker/site-locks.mjs remove <id>
//   node locker/site-locks.mjs list
//   node locker/site-locks.mjs door-secret                                       (makes it, once; never prints it)

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const CREDENTIALS = join(homedir(), '.imperfect', 'credentials');
export const LOCKS_FILE = join(CREDENTIALS, 'site-locks.json');
export const DOOR_FILE = join(CREDENTIALS, 'site-door-secret');
export const TICKET_SECONDS = 60;
const REMEMBER_SECONDS = 30 * 24 * 3600;
const ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

export const normalise = password => String(password ?? '').trim().toLowerCase();
const b64url = bytes => Buffer.from(bytes).toString('base64url');

// A workbench's address: https, or http on this machine (tests), with no credentials.
export function workbenchUrl(value) {
  const url = new URL(String(value));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) throw new Error(`not a workbench address: ${value}`);
  url.hash = '';
  return url.href;
}

export async function hashPassword(password, { salt, scrypt: params = SCRYPT }) {
  const key = normalise(password);
  if (!key) throw new Error('an empty password opens nothing');
  return (await scrypt(key, Buffer.from(salt, 'hex'), 32, { ...params, maxmem: 64 * 1024 * 1024 })).toString('hex');
}

// The door's ticket for a lock (see the top of this file). now: ms.
export function mintTicket(id, secret, { now = Date.now(), nonce = randomBytes(16) } = {}) {
  const payload = b64url(JSON.stringify({ id, exp: Math.floor(now / 1000) + TICKET_SECONDS, n: b64url(nonce) }));
  return `${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}`;
}
// What the door does with it (here for the tests, and to show the door's side exactly).
export function readTicket(token, secret, { now = Date.now() } = {}) {
  const [payload, mac, extra] = String(token).split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const want = createHmac('sha256', secret).update(payload).digest(), got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof body?.id !== 'string' || !Number.isInteger(body.exp) || typeof body.n !== 'string' || body.exp <= Math.floor(now / 1000)) return null;
  return body;
}
export const ticketUrl = (url, token) => { const at = new URL('door/ticket', url.endsWith('/') ? url : `${url}/`); at.searchParams.set('t', token); return at.href; };

// A private regular file inside ~/.imperfect/credentials, as the locker's other credentials are (start.mjs).
async function privateFile(file, { credentials = CREDENTIALS, limit = 256 * 1024 } = {}) {
  const wanted = resolve(file);
  if (!wanted.startsWith(resolve(credentials) + sep)) throw new Error(`${file} must be inside ${credentials}`);
  let info;
  try { info = await lstat(wanted); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || (info.mode & 0o077) || info.size > limit) throw new Error(`${file} must be a private regular file (chmod 600)`);
  return readFile(wanted);
}

export function parseLocks(text) {
  const data = JSON.parse(text);
  if (data?.version !== 1 || !/^[0-9a-f]{32,}$/.test(data.secret ?? '') || !/^[0-9a-f]{16,}$/.test(data.salt ?? '') || !Array.isArray(data.locks)) throw new Error('not a site-locks file');
  const locks = data.locks.map(lock => {
    if (!ID.test(lock?.id ?? '') || !Array.isArray(lock.hashes) || !lock.hashes.every(hash => /^[0-9a-f]{64}$/.test(hash))) throw new Error(`bad lock ${lock?.id}`);
    return { id: lock.id, url: workbenchUrl(lock.url), ticket: lock.ticket === true, hashes: [...lock.hashes] };
  });
  return { version: 1, secret: data.secret, salt: data.salt, scrypt: { ...SCRYPT, ...data.scrypt }, locks };
}

// For the server. file: the private file; doorFile: the door's secret (read only if a lock has "ticket").
export function createSiteLocks({ file = LOCKS_FILE, doorFile = DOOR_FILE, credentials = CREDENTIALS, secure = true, now = Date.now,
  perMinute = 10, busy = 4, log = console } = {}) {
  let cache = { at: -Infinity, data: null, door: null };
  async function current() {
    if (now() - cache.at < 1000) return cache;
    try {
      const text = await privateFile(file, { credentials });
      const data = text ? parseLocks(text.toString('utf8')) : null;
      const door = data?.locks.some(lock => lock.ticket) ? await privateFile(doorFile, { credentials, limit: 4096 }) : null;
      if (door && door.length < 32) throw new Error(`${doorFile} must hold 32 random bytes`);
      cache = { at: now(), data, door };
    } catch (error) {
      log.error(`site locks: ${error.message}`); // fail closed: nothing opens
      cache = { at: now(), data: null, door: null };
    }
    return cache;
  }
  // Ten tries a minute from one address; a few checks at a time in all (scrypt is meant to be slow).
  const tries = new Map();
  let checking = 0;
  const allow = key => {
    const at = now(), row = tries.get(key) ?? { start: at, count: 0 };
    if (at - row.start > 60_000) { row.start = at; row.count = 0; }
    row.count += 1; tries.set(key, row);
    if (tries.size > 10_000) for (const [k, v] of tries) if (at - v.start > 60_000) tries.delete(k);
    return row.count <= perMinute;
  };
  const cookieName = secure ? '__Host-imperfect-lock' : 'imperfect-lock';
  const sign = (secret, value) => createHmac('sha256', Buffer.from(secret, 'hex')).update(value).digest('base64url');
  const remember = (data, id) => {
    const value = `${id}.${Math.floor(now() / 1000) + REMEMBER_SECONDS}`;
    return `${cookieName}=${value}.${sign(data.secret, value)}; Path=/; Max-Age=${REMEMBER_SECONDS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  };
  function rememberedId(data, header) {
    const raw = String(header ?? '').split(/;\s*/).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
    const at = raw.lastIndexOf('.'), value = raw.slice(0, at), mac = Buffer.from(raw.slice(at + 1), 'base64url'), want = Buffer.from(sign(data.secret, value), 'base64url');
    if (at < 0 || mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
    const [id, until] = [value.slice(0, value.lastIndexOf('.')), Number(value.slice(value.lastIndexOf('.') + 1))];
    return Number.isFinite(until) && until > now() / 1000 ? id : null;
  }
  // What the page gets: the lock's id and the frame's address, a fresh ticket in it if its imperfect has a door.
  function workbench({ data, door }, id) {
    const lock = data.locks.find(entry => entry.id === id);
    if (!lock) return null;
    if (!lock.ticket) return { id, url: lock.url };
    if (!door) { log.error(`site locks: ${id} goes through a door, but ${doorFile} is missing`); return null; }
    return { id, url: ticketUrl(lock.url, mintTicket(id, door.subarray(0, 32), { now: now() })) };
  }
  async function check({ data }, password) {
    const key = normalise(password);
    if (!data || !key || key.length > 256) return null;
    const hash = Buffer.from(await hashPassword(key, data), 'hex');
    let found = null;
    for (const lock of data.locks) for (const other of lock.hashes) if (timingSafeEqual(hash, Buffer.from(other, 'hex')) && !found) found = lock.id;
    return found;
  }
  const answer = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const no = (res, status = 401) => answer(res, status, { ok: false });
  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4096) return null; chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
  }
  return {
    cookieName,
    // The origins the page may frame: every lock's. null: no file, so the server's own default stands.
    async frameOrigins() {
      const { data } = await current();
      return data?.locks.length ? [...new Set(data.locks.map(lock => new URL(lock.url).origin))] : null;
    },
    // true if it answered (the /unlock route).
    async handle(req, res, url, clientKey) {
      if (url.pathname !== '/unlock') return false;
      if (req.method !== 'GET' && req.method !== 'POST') { answer(res, 405, { ok: false }, { allow: 'GET, POST' }); return true; }
      const state = await current();
      if (req.method === 'GET') {
        const id = state.data ? rememberedId(state.data, req.headers.cookie) : null;
        const bench = id ? workbench(state, id) : null;
        bench ? answer(res, 200, { ok: true, workbench: bench }) : no(res);
        return true;
      }
      // Only this page may ask: a browser's Origin must be the very host it asked.
      const origin = req.headers.origin;
      if (origin) { try { if (new URL(origin).host !== String(req.headers.host ?? '')) { no(res, 403); return true; } } catch { no(res, 403); return true; } }
      if (!allow(clientKey(req))) { no(res, 429); return true; }
      if (checking >= busy) { no(res, 429); return true; }
      const body = await readJson(req);
      checking++;
      let id = null;
      try { id = typeof body?.password === 'string' ? await check(state, body.password) : null; } finally { checking--; }
      const bench = id ? workbench(state, id) : null;
      if (!bench) { no(res); return true; }
      answer(res, 200, { ok: true, workbench: bench }, { 'set-cookie': remember(state.data, id) });
      return true;
    },
  };
}

// ---- the command line -------------------------------------------------------------------------------------------
async function writePrivate(file, bytes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(temp, 0o600);
  await rename(temp, file).catch(async error => { await rm(temp, { force: true }); throw error; });
}
const freshLocks = () => ({ version: 1, secret: randomBytes(32).toString('hex'), salt: randomBytes(16).toString('hex'), scrypt: { ...SCRYPT }, locks: [] });
async function load(file, credentials) {
  const text = await privateFile(file, { credentials });
  return text ? parseLocks(text.toString('utf8')) : freshLocks();
}
const save = (file, data) => writePrivate(file, JSON.stringify(data, null, 2) + '\n');
async function stdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''); }

export async function command(args, { file = process.env.SITE_LOCKS_FILE || LOCKS_FILE, doorFile = process.env.SITE_DOOR_FILE || DOOR_FILE, credentials = CREDENTIALS, out = console.log } = {}) {
  const [verb, ...rest] = args;
  const ticket = rest.includes('--ticket'), words = rest.filter(word => word !== '--ticket');
  const idOf = value => { const id = String(value ?? '').toLowerCase(); if (!ID.test(id)) throw new Error(`not an id: ${value} (a-z, 0-9, . _ -)`); return id; };
  if (verb === 'replace') {
    if (words.length !== 3) throw new Error('usage: node locker/site-locks.mjs replace <id> <password> <url> [--ticket]');
    const [rawId, rawPassword, rawUrl] = words;
    const id = idOf(rawId), url = workbenchUrl(rawUrl), password = rawPassword === '-' ? await stdin() : rawPassword;
    // Validate the private destination, then build a new file rather than retaining any old hashes or cookies.
    await privateFile(file, { credentials });
    const data = freshLocks();
    data.locks = [{ id, url, ticket, hashes: [await hashPassword(password, data)] }];
    await save(file, data); // one atomic rename; the door's shared ticket signer stays unchanged
    out(`Only ${id}: 1 password, opens ${url}${ticket ? ' through its door (a ticket)' : ''}; previous remembered unlocks revoked`);
  } else if (verb === 'add') {
    const [rawId, rawPassword, url] = words;
    const id = idOf(rawId), password = rawPassword === '-' ? await stdin() : rawPassword;
    const data = await load(file, credentials);
    const hash = await hashPassword(password, data);
    const taken = data.locks.find(lock => lock.hashes.includes(hash));
    if (taken && taken.id !== id) throw new Error(`that password already opens ${taken.id}`);
    let lock = data.locks.find(entry => entry.id === id);
    if (!lock) {
      if (!url) throw new Error(`${id} is new: give the workbench's address too`);
      lock = { id, url: workbenchUrl(url), ticket, hashes: [] };
      data.locks.push(lock);
    } else if (url) Object.assign(lock, { url: workbenchUrl(url), ticket });
    if (!lock.hashes.includes(hash)) lock.hashes.push(hash);
    await save(file, data);
    out(`${id}: ${lock.hashes.length} password${lock.hashes.length === 1 ? '' : 's'}, opens ${lock.url}${lock.ticket ? ' through its door (a ticket)' : ''}`);
  } else if (verb === 'url') {
    const [rawId, url] = words, id = idOf(rawId), data = await load(file, credentials);
    const lock = data.locks.find(entry => entry.id === id);
    if (!lock) throw new Error(`no lock ${id}`);
    Object.assign(lock, { url: workbenchUrl(url), ticket });
    await save(file, data);
    out(`${id} opens ${lock.url}${lock.ticket ? ' through its door (a ticket)' : ''}`);
  } else if (verb === 'remove') {
    const id = idOf(words[0]), data = await load(file, credentials);
    if (!data.locks.some(lock => lock.id === id)) throw new Error(`no lock ${id}`);
    data.locks = data.locks.filter(lock => lock.id !== id);
    await save(file, data);
    out(`${id} removed`);
  } else if (verb === 'list') {
    const data = await load(file, credentials);
    for (const lock of data.locks) out(`${lock.id}\t${lock.hashes.length} password${lock.hashes.length === 1 ? '' : 's'}\t${lock.url}${lock.ticket ? '\tticket' : ''}`);
    if (data.locks.some(lock => lock.ticket) && !await privateFile(doorFile, { credentials, limit: 4096 }).catch(() => null)) out(`(no door secret yet: node locker/site-locks.mjs door-secret)`);
  } else if (verb === 'door-secret') {
    if (await privateFile(doorFile, { credentials, limit: 4096 })) { out(`${doorFile} is already there (unchanged)`); return; }
    await writePrivate(doorFile, randomBytes(32));
    out(`${doorFile}: 32 random bytes, mode 600. Copy it to the workbenches' computer for their doors.`);
  } else {
    throw new Error('usage: node locker/site-locks.mjs add <id> <password> [<url> [--ticket]] | replace <id> <password> <url> [--ticket] | url <id> <url> [--ticket] | remove <id> | list | door-secret');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  process.umask(0o077);
  command(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
