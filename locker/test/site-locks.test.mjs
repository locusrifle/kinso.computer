import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';
import { createLockerServer } from '../server.mjs';
import { command, createSiteLocks, mintTicket, normalise, readTicket, ticketUrl, TICKET_SECONDS } from '../site-locks.mjs';

// Fixture passwords only: the real ones live in the private file, never in the repository.
async function credentials() {
  const home = await mkdtemp(join(tmpdir(), 'site-locks-'));
  const dir = join(home, 'credentials');
  await mkdir(dir, { mode: 0o700 });
  const files = { file: join(dir, 'site-locks.json'), doorFile: join(dir, 'site-door-secret'), credentials: dir };
  const lines = [];
  const run = (...args) => command(args, { ...files, out: line => lines.push(line) });
  return { ...files, run, lines };
}
const b64 = value => Buffer.from(value).toString('base64url');

test('the command line keeps hashes, never passwords, in a private file; one id may have several passwords', async () => {
  const c = await credentials();
  await c.run('add', 'north', 'Fixture Alpha', 'https://noah.imperfect.computer');
  await c.run('add', 'south', 'fixture-bravo', 'https://south.noah.imperfect.computer', '--ticket');
  await c.run('add', 'south', 'fixture-bravo-2');
  await assert.rejects(c.run('add', 'east', 'fixture alpha', 'https://noah.imperfect.computer'), /already opens north/, 'one password, one workbench (any capitals)');
  await assert.rejects(c.run('add', 'west', 'fixture-charlie'), /give the workbench's address/);
  await assert.rejects(c.run('add', 'x', 'y', 'http://example.test'), /not a workbench address/, 'https only (or http on this machine)');
  await assert.rejects(c.run('add', 'x', 'y', 'https://user:pass@example.test'), /not a workbench address/);
  await assert.rejects(c.run('add', 'Bad Id!', 'y', 'https://example.test'), /not an id/);
  const info = await stat(c.file);
  assert.equal(info.mode & 0o777, 0o600);
  const text = await readFile(c.file, 'utf8');
  assert.doesNotMatch(text, /fixture|alpha|bravo/i, 'no password in the file');
  const data = JSON.parse(text);
  assert.deepEqual(data.locks.map(lock => [lock.id, lock.url, lock.ticket, lock.hashes.length]),
    [['north', 'https://noah.imperfect.computer/', false, 1], ['south', 'https://south.noah.imperfect.computer/', true, 2]]);
  await c.run('url', 'north', 'https://north.noah.imperfect.computer', '--ticket');
  await c.run('url', 'south', 'https://noah.imperfect.computer');
  assert.deepEqual(JSON.parse(await readFile(c.file, 'utf8')).locks.map(lock => [lock.url, lock.ticket]),
    [['https://north.noah.imperfect.computer/', true], ['https://noah.imperfect.computer/', false]], 'switchable per lock: its door with a ticket, or the fallback');
  await c.run('door-secret');
  assert.equal((await readFile(c.doorFile)).length, 32);
  assert.equal((await stat(c.doorFile)).mode & 0o777, 0o600);
  const before = await readFile(c.doorFile);
  await c.run('door-secret');
  assert.deepEqual(await readFile(c.doorFile), before, 'made once, never replaced');
  await c.run('remove', 'south');
  c.lines.length = 0; await c.run('list');
  assert.deepEqual(c.lines, ['north\t1 password\thttps://north.noah.imperfect.computer/\tticket']);
  assert.deepEqual((await readdir(join(c.file, '..'))).sort(), ['site-door-secret', 'site-locks.json'], 'no temporary files left');
  await chmod(c.file, 0o644);
  await assert.rejects(c.run('list'), /private regular file/, 'a readable file is refused');
});

test('replace creates one private lock from scratch and leaves the file untouched on invalid input', async () => {
  const c = await credentials();
  await c.run('replace', 'only', 'fixture-only', 'https://computer.example.test', '--ticket');
  const before = await readFile(c.file, 'utf8');
  const data = JSON.parse(before);
  assert.deepEqual(data.locks.map(({ id, url, ticket, hashes }) => [id, url, ticket, hashes.length]),
    [['only', 'https://computer.example.test/', true, 1]]);
  assert.equal((await stat(c.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(before + c.lines.join('\n'), /fixture-only/, 'neither storage nor output exposes the password');
  for (const args of [
    ['replace', 'only', 'fixture-only'],
    ['replace', 'only', 'fixture-only', 'https://computer.example.test', 'extra'],
    ['replace', 'Bad Id!', 'fixture-only', 'https://computer.example.test'],
    ['replace', 'only', '', 'https://computer.example.test'],
    ['replace', 'only', 'fixture-only', 'http://elsewhere.test'],
    ['replace', 'only', 'fixture-only', 'https://user:pass@elsewhere.test'],
  ]) {
    await assert.rejects(c.run(...args));
    assert.equal(await readFile(c.file, 'utf8'), before, 'invalid replacement never changes the previous locks');
  }
  await assert.rejects(command(['replace', 'only', 'fixture-only', 'https://computer.example.test'], {
    ...c, file: join(c.credentials, '..', 'outside.json'), out() {},
  }), /must be inside/);
  await chmod(c.file, 0o644);
  await assert.rejects(c.run('replace', 'only', 'fixture-only', 'https://computer.example.test'), /private regular file/);
  assert.equal(await readFile(c.file, 'utf8'), before, 'replace does not overwrite an insecure file');
  assert.deepEqual(await readdir(c.credentials), ['site-locks.json'], 'no temporary files left');
});

test('the door\'s ticket: exactly base64url(payload).base64url(HMAC-SHA256(secret, first part)), payload {id, exp: now + 60, n}', () => {
  const secret = Buffer.alloc(32, 7), now = 1_760_000_000_123, nonce = Buffer.alloc(16, 1);
  const token = mintTicket('north', secret, { now, nonce });
  const [payload, mac] = token.split('.');
  assert.equal(Buffer.from(payload, 'base64url').toString(), `{"id":"north","exp":${1_760_000_000 + TICKET_SECONDS},"n":"${b64(nonce)}"}`);
  assert.equal(mac, createHmac('sha256', secret).update(payload).digest('base64url'));
  assert.doesNotMatch(token, /[=+/]/, 'unpadded base64url');
  assert.deepEqual(readTicket(token, secret, { now }), { id: 'north', exp: 1_760_000_060, n: b64(nonce) });
  assert.equal(readTicket(token, secret, { now: now + 60_000 }), null, 'a minute, no more');
  assert.equal(readTicket(token, Buffer.alloc(32, 8), { now }), null, 'another secret');
  assert.equal(readTicket(`${b64('{"id":"east","exp":9999999999,"n":"x"}')}.${mac}`, secret, { now }), null, 'another payload');
  assert.notEqual(mintTicket('north', secret, { now }), mintTicket('north', secret, { now }), 'a new nonce every time');
  assert.equal(ticketUrl('https://north.noah.imperfect.computer/', token), `https://north.noah.imperfect.computer/door/ticket?t=${token}`);
  assert.equal(normalise('  North '), 'north');
});

async function serve({ c, hosts = 'imperfect.test', secure = false, now = Date.now, perMinute } = {}) {
  const store = openStore();
  const log = { info() {}, warn() {}, error() {} };
  const siteLocks = createSiteLocks({ file: c.file, doorFile: c.doorFile, credentials: c.credentials, secure, now, perMinute, log });
  const app = await createLockerServer({ store, siteLocks, mail: { configured: false, async send() {} }, log, port: 0,
    config: { secure, hosts, demoOrigin: 'https://noah.imperfect.computer' }, websiteDir: fileURLToPath(new URL('../../website/', import.meta.url)) });
  const { port } = await app.listen();
  const call = (path, { method = 'GET', headers = {}, body, ip = '10.0.0.1' } = {}) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'imperfect.test', 'cf-connecting-ip': ip, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const post = (password, options = {}) => call('/unlock', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://imperfect.test', ...options.headers }, body: JSON.stringify({ password }), ...options });
  return { call, post, close: async () => { await app.close(); store.close(); } };
}

test('POST /unlock: any capitals and spaces open the right workbench, with a fresh door ticket and a remembering cookie; anything else is one refusal', async () => {
  const c = await credentials();
  await c.run('add', 'north', 'fixture-alpha', 'https://north.noah.imperfect.computer', '--ticket');
  await c.run('add', 'east', 'fixture.bravo', 'https://noah.imperfect.computer');
  await c.run('add', 'south', 'fixture-charlie', 'https://south.noah.imperfect.computer', '--ticket');
  await c.run('add', 'south', 'fixture-charly');
  await c.run('door-secret');
  const secret = await readFile(c.doorFile);
  const s = await serve({ c, secure: true });
  try {
    for (const [typed, id] of [['  Fixture-Alpha ', 'north'], ['FIXTURE.BRAVO', 'east'], ['fixture-charlie', 'south'], ['Fixture-Charly', 'south']]) {
      const response = await s.post(typed);
      assert.equal(response.status, 200, typed);
      assert.equal(response.headers['cache-control'], 'no-store');
      const { ok, workbench } = JSON.parse(response.body);
      assert.equal(ok, true); assert.equal(workbench.id, id);
      if (id === 'east') assert.equal(workbench.url, 'https://noah.imperfect.computer/', 'the fallback: no ticket');
      else {
        const url = new URL(workbench.url);
        assert.equal(url.origin + url.pathname, `https://${id}.noah.imperfect.computer/door/ticket`);
        const ticket = readTicket(url.searchParams.get('t'), secret);
        assert.equal(ticket.id, id); assert.ok(ticket.exp - Date.now() / 1000 <= TICKET_SECONDS && ticket.exp - Date.now() / 1000 > TICKET_SECONDS - 5);
      }
      const cookie = response.headers['set-cookie'][0];
      assert.match(cookie, /^__Host-imperfect-lock=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
      // A reload: the cookie alone, a fresh ticket each time.
      const again = await s.call('/unlock', { headers: { cookie: cookie.split(';')[0] } });
      assert.equal(again.status, 200);
      const bench = JSON.parse(again.body).workbench;
      assert.equal(bench.id, id);
      if (id !== 'east') assert.notEqual(bench.url, workbench.url, 'a new ticket');
    }
    for (const wrong of ['', '   ', 'fixture', 'fixture-alpha2', 'x'.repeat(300)]) {
      const response = await s.post(wrong, { ip: '10.0.0.2' });
      assert.equal(response.status, 401, JSON.stringify(wrong)); assert.equal(response.body, '{"ok":false}');
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.equal((await s.call('/unlock')).status, 401, 'no cookie, no workbench');
    assert.equal((await s.call('/unlock', { headers: { cookie: '__Host-imperfect-lock=north.9999999999.forged' } })).status, 401, 'a forged cookie');
    assert.equal((await s.post('fixture-alpha', { headers: { origin: 'https://elsewhere.test' } })).status, 403, 'only the page itself may ask');
    assert.equal((await s.call('/unlock', { method: 'PUT' })).status, 405);
    // The page frames exactly the workbenches' origins.
    const front = await s.call('/');
    assert.match(front.headers['content-security-policy'], /frame-src 'self' https:\/\/north\.noah\.imperfect\.computer https:\/\/noah\.imperfect\.computer https:\/\/south\.noah\.imperfect\.computer;/);
  } finally { await s.close(); }
});

test('replace leaves only Noah\'s ticket: old passwords and cookies (even the same id) no longer unlock', async () => {
  const c = await credentials();
  await c.run('add', 'noah', 'fixture-previous', 'https://previous.example.test', '--ticket');
  await c.run('add', 'noah', 'fixture-alias');
  await c.run('add', 'retired', 'fixture-retired', 'https://retired.example.test', '--ticket');
  await c.run('door-secret');
  const door = await readFile(c.doorFile), before = JSON.parse(await readFile(c.file, 'utf8'));
  let clock = Date.now();
  const s = await serve({ c, secure: true, now: () => clock, perMinute: 100 });
  const cookieOf = response => response.headers['set-cookie'][0].split(';')[0];
  try {
    const oldCookies = [];
    for (const password of ['fixture-previous', 'fixture-alias', 'fixture-retired']) {
      const right = await s.post(password);
      assert.equal(right.status, 200);
      oldCookies.push(cookieOf(right));
    }
    await c.run('replace', 'noah', 'noah', 'https://noah.imperfect.computer', '--ticket');
    clock += 2000; // allow the existing one-second private-file cache to refresh
    const after = JSON.parse(await readFile(c.file, 'utf8'));
    assert.notEqual(after.secret, before.secret, 'rotate the remembered-unlock signer, not just the lock ids');
    assert.notEqual(after.salt, before.salt);
    assert.deepEqual(after.locks.map(({ id, url, ticket, hashes }) => [id, url, ticket, hashes.length]),
      [['noah', 'https://noah.imperfect.computer/', true, 1]]);
    assert.deepEqual(await readFile(c.doorFile), door, 'the VM ticket signer is not rotated');
    for (const password of ['fixture-previous', 'fixture-alias', 'fixture-retired', 'wrong', 'noah2', '']) {
      const wrong = await s.post(password);
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body, '{"ok":false}');
      assert.equal(wrong.headers['set-cookie'], undefined);
    }
    for (const cookie of oldCookies) assert.equal((await s.call('/unlock', { headers: { cookie } })).status, 401);
    let cookie;
    for (const password of ['noah', '  NOAH  ']) {
      const right = await s.post(password);
      assert.equal(right.status, 200);
      const { ok, workbench } = JSON.parse(right.body), url = new URL(workbench.url);
      assert.equal(ok, true);
      assert.equal(workbench.id, 'noah');
      assert.equal(url.origin + url.pathname, 'https://noah.imperfect.computer/door/ticket');
      assert.equal(readTicket(url.searchParams.get('t'), door, { now: clock }).id, 'noah');
      cookie = cookieOf(right);
      const remembered = await s.call('/unlock', { headers: { cookie } });
      assert.equal(remembered.status, 200);
      assert.notEqual(JSON.parse(remembered.body).workbench.url, workbench.url, 'a fresh ticket on reload');
    }
    assert.match((await s.call('/')).headers['content-security-policy'], /frame-src 'self' https:\/\/noah\.imperfect\.computer;/);
    await c.run('replace', 'noah', 'noah', 'https://noah.imperfect.computer', '--ticket');
    clock += 2000;
    assert.equal((await s.call('/unlock', { headers: { cookie } })).status, 401, 'replacing the same id/password still revokes remembered unlocks');
    assert.equal((await s.post('noah')).status, 200);
    assert.equal((await stat(c.file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(c.credentials)).sort(), ['site-door-secret', 'site-locks.json']);
  } finally { await s.close(); }
});

test('POST /unlock: ten tries a minute from one address; a removed lock\'s cookie opens nothing; no file or no door secret opens nothing', async () => {
  const c = await credentials();
  await c.run('add', 'north', 'fixture-alpha', 'https://noah.imperfect.computer');
  let clock = 1_760_000_000_000;
  const s = await serve({ c, now: () => clock });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await s.post('nope')).status, 401);
    assert.equal((await s.post('fixture-alpha')).status, 429, 'even the right one, while it waits');
    assert.equal((await s.post('fixture-alpha', { ip: '10.9.9.9' })).status, 200, 'another address is not held up');
    clock += 61_000;
    const right = await s.post('fixture-alpha');
    assert.equal(right.status, 200, 'a minute later');
    const cookie = right.headers['set-cookie'][0].split(';')[0];
    assert.match(cookie, /^imperfect-lock=/, 'plain http (tests): no __Host- prefix or Secure');
    await c.run('remove', 'north');
    await c.run('add', 'east', 'fixture-bravo', 'https://noah.imperfect.computer');
    clock += 2000; // the locker reads the file again when it changes
    assert.equal((await s.call('/unlock', { headers: { cookie } })).status, 401);
    await c.run('add', 'south', 'fixture-charlie', 'https://south.noah.imperfect.computer', '--ticket');
    clock += 2000;
    assert.equal((await s.post('fixture-charlie', { ip: '10.0.0.3' })).status, 401, 'a door with no secret here: closed');
    assert.equal((await s.post('fixture-bravo', { ip: '10.0.0.3' })).status, 200, 'the others still open');
    await chmod(c.file, 0o640);
    clock += 2000;
    assert.equal((await s.post('fixture-bravo', { ip: '10.0.0.4' })).status, 401, 'a readable file: closed');
  } finally { await s.close(); }
  const empty = await credentials();
  const none = await serve({ c: empty });
  try {
    assert.equal((await none.post('anything')).status, 401);
    assert.match((await none.call('/')).headers['content-security-policy'], /frame-src 'self' https:\/\/noah\.imperfect\.computer;/, 'no file: the configured demo origin, as before');
  } finally { await none.close(); }
});

test('the lock\'s passwords and workbench addresses are nowhere in the site\'s source', async () => {
  const site = fileURLToPath(new URL('../../website/', import.meta.url));
  for (const name of ['index.html', 'launch.mjs', 'launch-config.mjs', 'lock.mjs']) {
    const text = await readFile(join(site, name), 'utf8');
    assert.doesNotMatch(text, /noah\.imperfect\.computer|door\/ticket/, `${name} names no workbench`);
  }
  const lock = await readFile(join(site, 'lock.mjs'), 'utf8');
  assert.match(lock, /fetcher\('\/unlock'/);
  assert.doesNotMatch(lock, /scrypt|crypto\.subtle|digest\(|password ===|=== password/i, 'nothing is checked in the page');
});
