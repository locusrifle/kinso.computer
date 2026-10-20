import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createClipboard, itemType, parseList, pngSize } from '../../../system/clipboard.mjs';
import { runTool } from '../../../system/controls.mjs';
import { createGueyServer } from '../../../system/server.mjs';
import { fakeCliphist, png } from './fixtures/system/cliphist.mjs';

async function serve(t, clipboard) {
  const server = createServer(async (req, res) => { if (!await clipboard.handle(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('capture claims one local window, completes once, and refuses while locked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capture-fence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'shot.png'), png(10, 10));
  const heard = [], begun = [];
  const base = await serve(t, createClipboard({ shots: dir, env: { XDG_RUNTIME_DIR: dir }, refuse: async () => '', onBegin: id => begun.push(id), onShot: (...args) => heard.push(args) }));
  const { capture } = await (await post(base, '/screenshots', { begin: true })).json();
  assert.deepEqual(begun, [capture]);
  assert.deepEqual(await (await post(base, '/screenshots', { claim: capture, window: 'one' })).json(), { claimed: true });
  assert.deepEqual(await (await post(base, '/screenshots', { claim: capture, window: 'two' })).json(), { claimed: false });
  for (let i = 0; i < 2; i++) assert.equal((await post(base, '/screenshots', { taken: 'shot.png', capture })).status, 200);
  assert.deepEqual(heard, [['shot.png', { capture, window: 'one' }]]);
  assert.equal((await post(base, '/screenshots', { taken: 'shot.png', capture: 'unknown' })).status, 409);
  await mkdir(join(dir, 'imperfect-lock')); await writeFile(join(dir, 'imperfect-lock', 'held'), '');
  assert.equal((await post(base, '/screenshots', { begin: true })).status, 403);
  assert.equal((await fetch(`${base}/screenshots/shot.png`)).status, 403);
  assert.equal((await fetch(`${base}/clipboard`)).status, 403);
});

test('cliphist\'s list: text and pictures, newest first; what an item is from its bytes', () => {
  const items = parseList('12\thello world\n9\t[[ binary data 1 MiB png 2944x1840 ]]\n3\t[[ binary data 12 KiB jpeg 64x48 ]]\n\nnot an item\n2\ttab\tinside\n');
  assert.deepEqual(items, [
    { id: '12', kind: 'text', text: 'hello world' },
    { id: '9', kind: 'image', size: '1 MiB', format: 'png', width: 2944, height: 1840 },
    { id: '3', kind: 'image', size: '12 KiB', format: 'jpeg', width: 64, height: 48 },
    { id: '2', kind: 'text', text: 'tab\tinside' },
  ]);
  assert.equal(parseList('1\ta\n2\tb\n3\tc\n', 2).length, 2);
  assert.equal(itemType(png(1, 1)), 'image/png');
  assert.equal(itemType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(itemType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(itemType(Buffer.from('plain words')), 'text/plain; charset=utf-8');
  assert.deepEqual(pngSize(png(2944, 1840)), { width: 2944, height: 1840 });
  assert.equal(pngSize(Buffer.from('text')), null);
});

test('the history: listed, each one whole, deleted, cleared; nothing copied yet is an empty list', async t => {
  const cliphist = fakeCliphist();
  const base = await serve(t, createClipboard({ run: cliphist.run, refuse: async () => '', env: {} }));
  assert.deepEqual(await (await fetch(`${base}/clipboard`)).json(), { items: [] });
  const words = cliphist.put('first line\n  second   line\n');
  const picture = cliphist.put(png(40, 30));
  const listed = (await (await fetch(`${base}/clipboard`)).json()).items;
  assert.deepEqual(listed.map(item => [item.id, item.kind]), [[picture, 'image'], [words, 'text']]);
  assert.equal(listed[1].text, 'first line second line');
  const text = await fetch(`${base}/clipboard/${words}`);
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await text.text(), 'first line\n  second   line\n', 'whole, as it was copied');
  const image = await fetch(`${base}/clipboard/${picture}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png(40, 30));
  assert.equal((await fetch(`${base}/clipboard/404`)).status, 404);
  assert.equal((await fetch(`${base}/clipboard/..%2Fetc`)).status, 404);
  const after = await (await post(base, '/clipboard', { do: 'delete', id: words })).json();
  assert.deepEqual(after.items.map(item => item.id), [picture]);
  assert.equal((await post(base, '/clipboard', { do: 'delete', id: '1; rm -rf' })).status, 400);
  assert.deepEqual(await (await post(base, '/clipboard', { do: 'wipe' })).json(), { items: [] });
  assert.equal((await post(base, '/clipboard', { do: 'reboot' })).status, 400);
  assert.ok(cliphist.calls.every(call => call.startsWith('-preview-width') || /^(decode \d+|delete|wipe)$/.test(call)), cliphist.calls.join('\n'));
});

test('a Wi-Fi password pasted into the system panel is forgotten, exactly it and nothing else', async t => {
  const cliphist = fakeCliphist();
  const base = await serve(t, createClipboard({ run: cliphist.run, refuse: async () => '', env: {} }));
  const kept = cliphist.put('the wifi is hunter2 at home');
  cliphist.put('hunter2');
  const near = cliphist.put('hunter2 ');
  cliphist.put('hunter2');
  const answer = await (await post(base, '/clipboard', { do: 'forget', text: 'hunter2' })).json();
  assert.deepEqual(answer.items.map(item => item.id).sort(), [kept, near].sort(), 'what only contains it, or differs by a space, stays');
  assert.equal((await post(base, '/clipboard', { do: 'forget', text: '   ' })).status, 400);
});

test('the history is cliphist\'s: imperfect OS\'s in memory, else its own place; none without cliphist', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'imperfect-clip-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const seen = [];
  const run = async (command, args) => { seen.push(args.slice(0, 2).join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  const ask = async env => {
    const clipboard = createClipboard({ run, refuse: async () => '', env });
    const res = { writeHead() {}, end() {} };
    await clipboard.handle({ method: 'GET', headers: {} }, res, '/clipboard');
  };
  await ask({ XDG_RUNTIME_DIR: runtime });
  await mkdir(join(runtime, 'cliphist'));
  await ask({ XDG_RUNTIME_DIR: runtime });
  await ask({ CLIPHIST_DB_PATH: '/elsewhere/db', XDG_RUNTIME_DIR: runtime });
  assert.deepEqual(seen, ['-preview-width 240', `-db-path ${join(runtime, 'cliphist', 'db')}`, '-db-path /elsewhere/db']);
  const base = await serve(t, createClipboard({ run: async () => ({ ok: false, missing: true, stdout: '', stderr: '' }), refuse: async () => '', env: {} }));
  const none = await fetch(`${base}/clipboard`);
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /no clipboard history/);
});

test('screenshots: one taken is told; served; deleted with its copy in the history', async t => {
  const shots = await mkdtemp(join(tmpdir(), 'imperfect-shots-'));
  t.after(() => rm(shots, { recursive: true, force: true }));
  const cliphist = fakeCliphist();
  const told = [];
  const base = await serve(t, createClipboard({ run: cliphist.run, refuse: async () => '', env: {}, shots, onShot: name => told.push(name) }));
  const name = '2026-10-10-142501.png';
  await writeFile(join(shots, name), png(300, 200, 'the shot'));
  const copy = cliphist.put(png(300, 200, 'the shot'));
  const other = cliphist.put(png(300, 200, 'another picture the same size'));
  const words = cliphist.put('words');
  assert.deepEqual(await (await post(base, '/screenshots', { taken: name })).json(), { taken: name });
  assert.deepEqual(told, [name]);
  for (const bad of ['../secret.png', '.hidden.png', 'shot.jpg', 'a/b.png', '']) assert.equal((await post(base, '/screenshots', { taken: bad })).status, 400, bad);
  assert.equal((await post(base, '/screenshots', { taken: 'not-there.png' })).status, 404);
  assert.deepEqual(told, [name], 'only a real one is told');
  const served = await fetch(`${base}/screenshots/${name}`);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(300, 200, 'the shot'));
  assert.equal((await fetch(`${base}/screenshots/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.deepEqual(await (await post(base, '/screenshots', { delete: name })).json(), { deleted: name });
  await assert.rejects(access(join(shots, name)));
  assert.deepEqual([...cliphist.db.keys()].sort(), [other, words].sort(), 'its copy left the history; nothing else did');
  assert.ok(!cliphist.db.has(copy));
});

test('only for the person at this screen: refused everything otherwise', async t => {
  const cliphist = fakeCliphist();
  cliphist.put('secret');
  const base = await serve(t, createClipboard({ run: cliphist.run, refuse: async () => 'only on this computer\'s own screen', env: {}, onShot: () => assert.fail('told') }));
  for (const [path, method, body] of [['/clipboard', 'GET'], ['/clipboard/1', 'GET'], ['/clipboard', 'POST', { do: 'wipe' }], ['/screenshots', 'POST', { taken: 'a.png' }], ['/screenshots/a.png', 'GET']]) {
    const res = await fetch(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.deepEqual(cliphist.calls, [], 'cliphist never ran');
});

test('the real server: screenshots told to this screen\'s own windows only; never through /peer/', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-clip-server-'));
  const shots = join(root, 'shots');
  await mkdir(shots);
  await writeFile(join(shots, 'shot.png'), png(10, 10));
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: root, messages: [] }), command: async () => ({}), close: async () => {} };
  // A window is its screen's own unless it says it is a guest; the real rule is controls.mjs refusal.
  const refuse = async req => (req.headers['x-guest'] ? 'guest' : '');
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, clipboard: { run: fakeCliphist().run, refuse, env: {}, shots } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { port } = await app.listen();
  const heard = { own: [], guest: [] };
  const sockets = await Promise.all(Object.keys(heard).map(async who => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { headers: who === 'guest' ? { 'x-guest': '1' } : {} });
    ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'screenshot') heard[who].push(message.name); });
    await new Promise(resolve => ws.once('open', resolve));
    return ws;
  }));
  t.after(() => { for (const ws of sockets) ws.close(); });
  const res = await fetch(`http://127.0.0.1:${port}/screenshots`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ taken: 'shot.png' }) });
  assert.equal(res.status, 200);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(heard, { own: ['shot.png'], guest: [] });
  const call = path => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  for (const path of ['/peer/desktop/clipboard', '/peer/desktop/clipboard/3', '/peer/desktop/%63lipboard', '/peer/desktop//screenshots/shot.png']) assert.equal(await call(path), 403, path);
});

test('the real server, the real rule: a window of this user at the loopback name is told; one by the tailnet name is not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-clip-owner-'));
  const shots = join(root, 'shots');
  await mkdir(shots);
  await writeFile(join(shots, 'shot.png'), png(10, 10));
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: root, messages: [] }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, origins: ['https://desktop.tail1234.ts.net'], clipboard: { run: fakeCliphist().run, env: {}, shots } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { port } = await app.listen();
  const heard = { here: [], tailnet: [] };
  const sockets = await Promise.all(Object.keys(heard).map(async who => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { headers: who === 'tailnet' ? { host: 'desktop.tail1234.ts.net' } : {} });
    ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'screenshot') heard[who].push(message.name); });
    await new Promise(resolve => ws.once('open', resolve));
    return ws;
  }));
  t.after(() => { for (const ws of sockets) ws.close(); });
  const taken = await fetch(`http://127.0.0.1:${port}/screenshots`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ taken: 'shot.png' }) });
  assert.equal(taken.status, 200, 'the capture script: loopback, this user, the exact origin');
  assert.equal((await fetch(`http://127.0.0.1:${port}/screenshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taken: 'shot.png' }) })).status, 403, 'no origin, no');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(heard, { here: ['shot.png'], tailnet: [] });
});

// cliphist itself, where it is installed (imperfect OS) or named by CLIPHIST.
const real = process.env.CLIPHIST || (() => { try { return execFileSync('sh', ['-c', 'command -v cliphist'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
test('with cliphist itself: stored, listed, decoded, forgotten; a sensitive copy is never stored', { skip: !real && 'cliphist is not here' }, async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'imperfect-cliphist-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await mkdir(join(runtime, 'cliphist'));
  const env = { XDG_RUNTIME_DIR: runtime };
  const db = join(runtime, 'cliphist', 'db');
  const store = (value, state = 'data') => execFileSync(real, ['-db-path', db, 'store'], { input: value, env: { ...process.env, CLIPBOARD_STATE: state } });
  const base = await serve(t, createClipboard({ run: (command, args, options) => runTool(command === 'cliphist' ? real : command, args, options), refuse: async () => '', env }));
  assert.deepEqual(await (await fetch(`${base}/clipboard`)).json(), { items: [] });
  store('hello\n  there');
  store(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  store('hunter2', 'sensitive');
  store('wifi: hunter2');
  const items = (await (await fetch(`${base}/clipboard`)).json()).items;
  assert.deepEqual(items.map(item => item.kind === 'text' ? item.text : `${item.format} ${item.width}x${item.height}`), ['wifi: hunter2', 'png 1x1', 'hello there']);
  assert.equal(await (await fetch(`${base}/clipboard/${items[2].id}`)).text(), 'hello\n  there');
  assert.equal((await fetch(`${base}/clipboard/${items[1].id}`)).headers.get('content-type'), 'image/png');
  store('hunter2');
  const forgot = (await (await post(base, '/clipboard', { do: 'forget', text: 'hunter2' })).json()).items;
  assert.deepEqual(forgot.map(item => item.text ?? item.format), ['wifi: hunter2', 'png', 'hello there']);
  assert.deepEqual(await (await post(base, '/clipboard', { do: 'wipe' })).json(), { items: [] });
  assert.ok((await readFile(db)).length > 0);
});
