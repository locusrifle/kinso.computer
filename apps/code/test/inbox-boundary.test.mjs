// Whose messages a computer may show (system/inbox.mjs, inbox-lend.mjs,
// inbox-demo.mjs). The person's real inbox is for their own computers: the
// PC that keeps the Unipile key, and their own devices through the tailnet.
// A hosted computer (one someone unlocks on the web) shows the demo inbox:
// it never reads a key, never asks the PC, and its /peer/ does not reach
// the PC's /inbox/. The PC lends its inbox only to computers named in its
// own list, each by a token, read and draft only unless it says Send too,
// and taking one off the list puts the demo back at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../../system/server.mjs';
import { normalizeConfig } from '../../../system/machine.mjs';
import { createMachines } from '../../../system/machines.mjs';
import { inboxSource, runMessagesDraft, runMessagesRead, runMessagesSearch } from '../../../system/inbox.mjs';
import { DEMO_FILE, DEMO_SAID, createDemoInbox, minutesAgo, readDemo } from '../../../system/inbox-demo.mjs';
import { createLendHandler, lendCommand, readLend } from '../../../system/inbox-lend.mjs';
import { startFakeUnipile } from './fixtures/unipile.mjs';

const KEY = 'unipile-SECRET-access-token-boundary';
const runtime = name => ({
  events: new EventEmitter(), command: async () => ({}), close: async () => {},
  snapshot: () => ({ sessionId: `${name}-session`, cwd: '/', busy: false, failed: null, messages: [], tabs: [{ id: 't', sessionId: `${name}-session`, focused: true }] }),
});
const fakeMachines = (id, { peers = {}, caller = async () => null } = {}) => ({
  self: async () => id, selfId: async () => id, origins: async () => [], published: async () => '',
  list: async () => [{ id, name: id, url: '', self: true, reachable: true }],
  peer: async asked => peers[asked] ? { id: asked, name: asked, url: peers[asked]() } : null,
  caller,
});
const get = (url, path, headers = {}) => fetch(`${url}${path}`, { headers: { origin: url, ...headers } });
const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// A folder for the test's computers, gone once they are closed.
const opened = new Map();
async function place(t, prefix = 'inbox-boundary-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  opened.set(root, []);
  t.after(async () => {
    for (const app of opened.get(root).reverse()) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function computer(t, root, id, options) {
  await mkdir(join(root, id, 'credentials'), { recursive: true });
  const app = await createGueyServer({ stateDir: join(root, id, 'state'), runtime: runtime(id), sessionToken: `${id}-token`, ...options });
  opened.get(root).push(app);
  return { app, url: `http://127.0.0.1:${(await app.listen()).port}` };
}

test('which inbox: the person\'s own computers theirs, a hosted computer the demo unless its own settings say', () => {
  assert.deepEqual(inboxSource({}), { kind: 'personal' });
  assert.deepEqual(inboxSource({ hosted: true }), { kind: 'demo' });
  assert.deepEqual(inboxSource({ hosted: true, inbox: 'nonsense' }), { kind: 'demo' }, 'anything else is the default');
  assert.deepEqual(inboxSource({ hosted: true, inbox: 'http://evil.example:5069' }), { kind: 'demo' }, 'a lent inbox is only ever a loopback tunnel');
  assert.deepEqual(inboxSource({ hosted: true, inbox: 'own' }), { kind: 'own' });
  assert.deepEqual(inboxSource({ inbox: 'demo' }), { kind: 'demo' });
  assert.deepEqual(inboxSource({ hosted: true, inbox: 'http://127.0.0.1:14325' }), { kind: 'lent', url: 'http://127.0.0.1:14325' });
  assert.equal(normalizeConfig({ hosted: true }).inbox, undefined);
  assert.equal(normalizeConfig({ inbox: 'demo' }).inbox, 'demo');
  assert.equal(normalizeConfig({ inbox: 'http://127.0.0.1:14325' }).inbox, 'http://127.0.0.1:14325');
  assert.equal(normalizeConfig({ inbox: 'https://pc.example/inbox' }).inbox, undefined);
});

test('a hosted computer shows the demo inbox: never its key file, never the PC, not through /peer/ either', async t => {
  const fake = await startFakeUnipile({ key: KEY });
  t.after(() => fake.close());
  const root = await place(t);
  // The PC, as a hosted computer enrolled with it could reach it: anything asked of it is kept.
  const asked = [];
  const pc = createServer((req, res) => { asked.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"state":"ready","accounts":[],"conversations":[]}'); });
  await new Promise(done => pc.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { pc.closeAllConnections(); pc.close(done); }));
  const pcUrl = `http://127.0.0.1:${pc.address().port}`;
  const keyFile = join(root, 'cloud', 'credentials', 'unipile.json');
  const { url } = await computer(t, root, 'cloud', {
    hosted: true, authority: { id: 'pc', name: 'desktop' }, machines: fakeMachines('cloud', { peers: { pc: () => pcUrl } }), inbox: { keyFile },
  });
  // Even a key put on it is not read.
  await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: KEY }));

  const listed = await (await get(url, '/inbox/list')).json();
  assert.equal(listed.demo, true);
  assert.equal(listed.state, 'ready');
  assert.ok(listed.conversations.length >= 12 && listed.conversations.length <= 20, `${listed.conversations.length} conversations`);
  assert.deepEqual([...new Set(listed.conversations.map(c => c.source))].sort(), ['gmail', 'instagram', 'linkedin']);
  const key = listed.conversations.find(c => c.source === 'gmail').key;
  const thread = await (await get(url, `/inbox/thread?key=${encodeURIComponent(key)}&seen=1`)).json();
  assert.ok(thread.messages.length >= 1 && thread.demo);
  const sent = await (await post(url, '/inbox/send', { key, text: 'Wednesday works.', nonce: 'press-demo-01' })).json();
  assert.deepEqual(sent, { sent: false, demo: true, said: DEMO_SAID });
  assert.equal((await post(url, '/inbox/connect', {})).status, 400);
  assert.match(await runMessagesSearch({ query: '' }), /^This is the demo inbox: invented conversations/);

  // /peer/ never carries Messages to the PC.
  assert.equal((await get(url, '/peer/pc/inbox/list')).status, 403);
  assert.equal((await post(url, '/peer/pc/inbox/send', { key: 'chat:acc_linkedin:chat_priya', text: 'hi' })).status, 403);
  assert.deepEqual(asked, [], 'the PC was never asked');
  assert.equal(fake.requests.length, 0, 'Unipile was never asked');
  await assert.rejects(stat(join(root, 'cloud', 'state', 'inbox', 'store.json')), { code: 'ENOENT' });
});

test('the PC answers its real inbox only to its own screen and the person\'s own devices', async t => {
  const fake = await startFakeUnipile({ key: KEY });
  t.after(() => fake.close());
  const root = await place(t);
  const keyFile = join(root, 'pc', 'credentials', 'unipile.json');
  await mkdir(join(root, 'pc', 'credentials'), { recursive: true });
  await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: KEY }));
  // The tailnet, as `tailscale serve` says who asked: the laptop is the person's own; anything else is not.
  const own = { '100.70.0.2': { id: 'laptop', name: 'laptop' } };
  const { url } = await computer(t, root, 'pc', { machines: fakeMachines('pc', { caller: async ip => own[ip] ?? null }), inbox: { keyFile } });
  const through = (ip, login = 'person@example.com') => ({ 'x-forwarded-for': ip, ...(login ? { 'tailscale-user-login': login } : {}) });

  assert.equal((await get(url, '/inbox/list')).status, 200, 'this computer\'s own screen');
  assert.equal((await get(url, '/inbox/list', through('100.70.0.2'))).status, 200, 'the person\'s laptop');
  for (const [why, headers] of [
    ['a tagged node (no person)', through('100.70.0.2', '')],
    ['a device that is not the person\'s own, or a hosted computer', through('100.70.0.9')],
    ['an address off the tailnet', through('203.0.113.5')],
    ['Funnel', { 'tailscale-funnel-request': '?1' }],
    ['a name without an address', { 'tailscale-user-login': 'person@example.com' }],
  ]) {
    for (const path of ['/inbox/list', '/inbox/search?q=pilot', '/inbox/thread?key=chat%3Aacc_linkedin%3Achat_priya', '/inbox/avatar?key=chat%3Aacc_linkedin%3Achat_priya']) {
      const res = await get(url, path, headers);
      assert.equal(res.status, 403, `${why}: ${path}`);
      assert.doesNotMatch(await res.text(), /Priya|pilot/i);
    }
    assert.equal((await post(url, '/inbox/draft', { key: 'chat:acc_linkedin:chat_priya', text: 'x', by: 'Claude' }, headers)).status, 403, why);
    assert.equal((await post(url, '/inbox/send', { key: 'chat:acc_linkedin:chat_priya', text: 'x', nonce: 'press-refused-1' }, headers)).status, 403, why);
  }
  assert.deepEqual(fake.sent, []);
});

test('machines: a caller through the tailnet is the person\'s own device only if theirs, untagged and not hosted', async () => {
  const node = (id, name, ip, extra = {}) => ({ ID: id, StableID: id, DNSName: `${name}.tail.ts.net.`, OS: 'linux', UserID: 1, Online: true, TailscaleIPs: [ip], ...extra });
  const status = {
    Self: node('pcid', 'desktop', '100.70.0.1'),
    Peer: {
      a: node('lapid', 'laptop', '100.70.0.2'),
      b: node('phoneid', 'phone', '100.70.0.3', { OS: 'android' }),
      c: node('vmid', 'cloud', '100.70.0.4'),
      d: node('tagid', 'server', '100.70.0.5', { Tags: ['tag:server'] }),
      e: node('shareid', 'friend', '100.70.0.6', { UserID: 2 }),
      f: node('awayid', 'away', '100.70.0.7'),
      g: node('unknownid', 'unknown', '100.70.0.8'),
    },
  };
  const fetchImpl = async url => {
    if (url.includes('away')) throw new Error('unreachable');
    if (url.includes('unknown')) return new Response('{}');
    return new Response(JSON.stringify({ owner: { 'https://laptop.tail.ts.net/health': 'lapid', 'https://cloud.tail.ts.net/health': 'vmid', 'https://server.tail.ts.net/health': 'tagid', 'https://friend.tail.ts.net/health': 'shareid' }[url], protocol: 1, hosted: url.includes('cloud') }));
  };
  const machines = createMachines({ status: async () => status, serve: async () => ({}), fetchImpl });
  assert.equal((await machines.caller('100.70.0.1'))?.self, true);
  assert.equal((await machines.caller('100.70.0.2'))?.id, 'lapid');
  assert.equal((await machines.caller('::ffff:100.70.0.2'))?.id, 'lapid');
  assert.equal((await machines.caller('100.70.0.3'))?.id, 'phoneid', 'the phone is the person\'s');
  assert.equal(await machines.caller('100.70.0.4'), null, 'a computer that says it is hosted');
  assert.equal(await machines.caller('100.70.0.5'), null, 'a tagged node');
  assert.equal(await machines.caller('100.70.0.6'), null, 'someone else\'s shared device');
  assert.equal(await machines.caller('100.70.0.7'), null, 'an unreachable desktop is not verified personal');
  assert.equal(await machines.caller('100.70.0.8'), null, 'an unverified service is not personal');
  assert.equal(await machines.caller('100.70.0.99'), null);
  assert.equal(await machines.caller(''), null);
});

test('lending: the PC answers a cloud computer it names, by its token, to read and draft; off its list, the demo at once', async t => {
  const fake = await startFakeUnipile({ key: KEY });
  t.after(() => fake.close());
  const root = await place(t);
  const keyFile = join(root, 'pc', 'credentials', 'unipile.json');
  const lendFile = join(root, 'pc', 'credentials', 'inbox-lend.json');
  await mkdir(join(root, 'pc', 'credentials'), { recursive: true });
  await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: KEY }));
  const said = [];
  await lendCommand(['add', 'noah'], { file: lendFile, out: line => said.push(line) });
  const lendPort = 20000 + Math.floor(Math.random() * 20000);
  await writeFile(lendFile, JSON.stringify({ ...JSON.parse(await readFile(lendFile, 'utf8')), port: lendPort }));
  const token = (await readFile(join(root, 'pc', 'credentials', 'inbox-token-noah'), 'utf8')).trim();
  assert.ok(!said.join('\n').includes(token), 'the token is never printed');
  assert.ok(!(await readFile(lendFile, 'utf8')).includes(token), 'only its hash is kept');
  assert.equal((await stat(join(root, 'pc', 'credentials', 'inbox-token-noah'))).mode & 0o777, 0o600);
  assert.equal((await stat(lendFile)).mode & 0o777, 0o600);

  const pc = await computer(t, root, 'pc', { machines: fakeMachines('pc'), inbox: { keyFile }, lendFile });
  // The cloud computer: hosted, its lent inbox at the tunnel's address (here, the PC's port itself), its token.
  await mkdir(join(root, 'cloud', 'credentials'), { recursive: true });
  const tokenFile = join(root, 'cloud', 'credentials', 'inbox-token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const cloud = await computer(t, root, 'cloud', { hosted: true, inboxSetting: `http://127.0.0.1:${lendPort}`, machines: fakeMachines('cloud'),
    inbox: { keyFile: join(root, 'cloud', 'credentials', 'unipile.json'), tokenFile } });

  const listed = await (await get(cloud.url, '/inbox/list')).json();
  assert.equal(listed.state, 'ready');
  assert.ok(!listed.demo, 'the real inbox, lent');
  assert.equal(listed.canSend, false);
  assert.equal(listed.canConnect, false);
  assert.equal(listed.conversations[0].key, 'chat:acc_whatsapp:chat_mum');
  // Reading there marks nothing read here.
  const thread = await (await get(cloud.url, '/inbox/thread?key=chat%3Aacc_linkedin%3Achat_priya&seen=1')).json();
  assert.equal(thread.title, 'Priya Shah');
  assert.equal(thread.canSend, false);
  assert.equal(thread.canConnect, false);
  assert.equal((await (await get(pc.url, '/inbox/list')).json()).conversations.find(c => c.key === 'chat:acc_linkedin:chat_priya').unread, 1);
  const picture = await get(cloud.url, '/inbox/avatar?key=chat%3Aacc_linkedin%3Achat_priya');
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.equal(picture.headers.get('cache-control'), 'no-store');
  // A draft from there is said as from there; Send and Connect are not lent.
  const draft = await post(cloud.url, '/inbox/draft', { key: 'chat:acc_linkedin:chat_priya', text: 'Thursday works.', by: 'Claude' });
  assert.equal(draft.status, 200);
  const drafted = await draft.json();
  assert.equal(drafted.canSend, false);
  assert.match(await runMessagesDraft({ key: 'unused', text: 'draft only' }, { inbox: async () => ({ draft: async () => drafted }) }), /Sending is off on this computer/);
  assert.equal((await (await get(pc.url, '/inbox/thread?key=chat%3Aacc_linkedin%3Achat_priya')).json()).draft.by, 'Claude on noah');
  const send = await post(cloud.url, '/inbox/send', { key: 'chat:acc_linkedin:chat_priya', text: 'Thursday works.', nonce: 'press-lent-001' });
  assert.equal(send.status, 403);
  assert.match((await send.json()).error, /Sending is off on noah/);
  assert.equal((await post(cloud.url, '/inbox/connect', {})).status, 403);
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(fake.links, []);

  // The lent port answers only Messages, only to a token on the list, only through a tunnel.
  const lent = `http://127.0.0.1:${lendPort}`;
  assert.equal((await fetch(`${lent}/inbox/list`)).status, 403);
  assert.equal((await fetch(`${lent}/inbox/list`, { headers: { authorization: 'Bearer not-a-token-on-the-list-000' } })).status, 403);
  assert.equal((await fetch(`${lent}/inbox/list`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.5' } })).status, 403);
  assert.equal((await fetch(`${lent}/sessions.json`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(`${lent}/inbox/list`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

  // Send, when the PC says so.
  await lendCommand(['add', 'noah', '--send'], { file: lendFile, out: () => {} });
  const token2 = (await readFile(join(root, 'pc', 'credentials', 'inbox-token-noah'), 'utf8')).trim();
  await writeFile(tokenFile, token2);
  assert.equal((await post(cloud.url, '/inbox/send', { key: 'chat:acc_linkedin:chat_priya', text: 'Thursday works.', nonce: 'press-lent-002' })).status, 200);
  assert.equal(fake.sent.length, 1);

  // Off the list: the demo inbox from the next ask, and nothing of the PC's.
  await lendCommand(['remove', 'noah'], { file: lendFile, out: () => {} });
  const after = await (await get(cloud.url, '/inbox/list')).json();
  assert.equal(after.demo, true);
  assert.ok(!JSON.stringify(after).includes('Priya'));
  assert.equal((await readLend(lendFile)).computers.size, 0);
  await assert.rejects(stat(join(root, 'pc', 'credentials', 'inbox-token-noah')), { code: 'ENOENT' });

  assert.ok(fake.requests.every(r => r.key === KEY), 'only the PC\'s key ever reached Unipile');
  await assert.rejects(stat(join(root, 'cloud', 'state', 'inbox', 'store.json')), { code: 'ENOENT' }, 'nothing of Messages is kept on the cloud computer');
});

test('a lent computer with no token, or the PC away, is said as such and never shows real messages', async t => {
  const root = await place(t);
  const tokenFile = join(root, 'cloud', 'credentials', 'inbox-token');
  const cloud = await computer(t, root, 'cloud', { hosted: true, inboxSetting: 'http://127.0.0.1:59', machines: fakeMachines('cloud'), inbox: { tokenFile, keyFile: join(root, 'nope.json') } });
  assert.equal((await (await get(cloud.url, '/inbox/list')).json()).demo, true, 'no token: the demo');
  await writeFile(tokenFile, 'a'.repeat(43));
  const away = await get(cloud.url, '/inbox/list');
  assert.equal(away.status, 503);
  assert.match((await away.json()).error, /could not be reached|cannot reach/);
});

test('the demo inbox: invented, believable, in one file; search, read and draft work, and nothing is sent', async () => {
  const data = readDemo(DEMO_FILE);
  assert.ok(data.conversations.length >= 12 && data.conversations.length <= 20);
  assert.deepEqual([...new Set(data.conversations.map(c => c.source))].sort(), ['gmail', 'instagram', 'linkedin']);
  assert.equal(new Set(data.conversations.map(c => c.name)).size, data.conversations.length, 'everyone once');
  for (const c of data.conversations) {
    assert.ok(c.messages.length >= 1 && c.messages.length <= 5, c.key);
    if (c.address) assert.match(c.address, /\.example$/, 'an address that can never be real');
  }
  assert.ok(data.accounts.every(a => !a.handle || a.handle.endsWith('.example')));
  assert.ok(data.conversations.filter(c => c.unread).length >= 2);
  assert.equal(minutesAgo('2d 4h'), 2 * 1440 + 240);
  assert.equal(minutesAgo('45m'), 45);

  const told = [];
  let clock = Date.parse('2026-10-20T09:00:00Z');
  const demo = createDemoInbox({ now: () => clock, tell: m => told.push(m) });
  const newest = Math.min(...data.conversations.flatMap(c => c.messages.map(m => m.ago))) * 60_000;
  const listed = await demo.list();
  assert.equal(listed.conversations[0].at, clock - newest);
  clock += 86_400_000;
  assert.equal((await demo.list()).conversations[0].at, clock - newest, 'as fresh a day later: counted from when it is asked');
  const inbox = async () => demo;
  const found = await runMessagesSearch({ query: 'staging API' }, { inbox });
  assert.match(found, /This is the demo inbox/);
  const key = /key: (\S+)/.exec(found)[1];
  assert.match(await runMessagesRead({ key }, { inbox }), /demo inbox/);
  assert.match(await runMessagesDraft({ key, text: 'Wednesday 10am works. Staging is fine.', harness: 'claude' }, { inbox }), /demo inbox, so nothing can be sent/);
  assert.deepEqual(told.map(m => [m.type, m.key, m.by]), [['inbox-draft', key, 'Claude']]);
  assert.equal((await demo.thread(key)).draft.text, 'Wednesday 10am works. Staging is fine.');
  assert.deepEqual(await demo.send({ key, text: 'hi' }), { sent: false, demo: true, said: DEMO_SAID });
  await assert.rejects(demo.connect({}), /demo inbox/);
  // Opened, it is read here.
  const unread = listed.conversations.find(c => c.unread);
  await demo.thread(unread.key, { seen: true });
  assert.equal((await demo.list()).conversations.find(c => c.key === unread.key).unread, 0);
});

test('lending creates a private credentials folder on first use and contains local failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'inbox-first-lend-'));
  const file = join(root, 'new', 'credentials', 'inbox-lend.json');
  const said = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(done => { server.closeAllConnections(); server.close(done); });
    await rm(root, { recursive: true, force: true });
  });
  await lendCommand(['add', 'kinso'], { file, out: line => said.push(line) });
  const token = (await readFile(join(root, 'new', 'credentials', 'inbox-token-kinso'), 'utf8')).trim();
  assert.ok(!said.join('\n').includes(token));
  assert.equal((await stat(join(root, 'new', 'credentials'))).mode & 0o777, 0o700);
  assert.equal((await readLend(file)).computers.get('kinso').send, false);
  server = createServer(createLendHandler({ file, local: async () => { throw new Error(`private failure ${token}`); } }));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/inbox/list`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /private failure/);
});

test('an isolated server never adopts the live prefix inbox credentials implicitly', async t => {
  const fake = await startFakeUnipile({ key: KEY });
  t.after(() => fake.close());
  const root = await place(t);
  const previous = process.env.IMPERFECT_PREFIX;
  process.env.IMPERFECT_PREFIX = join(root, 'live-prefix');
  t.after(() => { if (previous === undefined) delete process.env.IMPERFECT_PREFIX; else process.env.IMPERFECT_PREFIX = previous; });
  await mkdir(join(process.env.IMPERFECT_PREFIX, 'credentials'), { recursive: true });
  await writeFile(join(process.env.IMPERFECT_PREFIX, 'credentials', 'unipile.json'), JSON.stringify({ dsn: fake.origin, apiKey: KEY }), { mode: 0o600 });
  const isolated = await computer(t, root, 'isolated', { machines: fakeMachines('isolated') });
  const listed = await (await get(isolated.url, '/inbox/list')).json();
  assert.equal(listed.state, 'no-key');
  assert.deepEqual(listed.conversations, []);
  assert.equal(fake.requests.length, 0, 'not even a read against the other prefix key');
});
