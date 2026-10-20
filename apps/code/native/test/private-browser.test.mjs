// The browser tool's headless mode (browser.mjs, desktop/electron/private.mjs):
// the project's own Electron, started with no display, driving pages from a
// local server. Nothing here reaches the person's window or the internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BROWSER_TOOL, PRIVATE_TABS, askPrivately, createBrowser, endPrivately, isPrivateTab, provideWindowPort, runBrowser, startPrivate } from '../browser.mjs';
import { privateBackendAddress } from '../../../../desktop/electron/drive.mjs';

// A site that remembers whoever it saw, by cookie, and a page that answers
// only after a while.
async function site(t) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/slow')) { const late = setTimeout(() => res.end('<title>Slow</title>late'), 3000); req.on('close', () => clearTimeout(late)); return; }
    if (req.url === '/file') { res.setHeader('content-disposition', 'attachment; filename=x.bin'); return res.end('bytes'); }
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/set')) res.setHeader('set-cookie', `who=${new URL(req.url, 'http://x').searchParams.get('who')}; Path=/`);
    res.end(`<title>Seen ${req.headers.cookie ?? 'nobody'}</title><body style="background:#f0f">
      <h1>Hello</h1><input aria-label="name"><button onclick="document.title = 'typed ' + document.querySelector('input').value">Go</button>
      <a href="/file">file</a><script>alert('blocked'); localStorage.n = (+localStorage.n || 0) + 1;</script><div style="height:3000px"></div></body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// The private browser as the machine would start it, watched.
function watched(t) {
  const started = [];
  const start = options => { const one = startPrivate(options); started.push(one); return one; };
  t.after(() => { for (const one of started) one.stop(); });
  return { started, ask: (request, options) => askPrivately(request, { ...options, start }) };
}
const profiles = async () => (await readdir(tmpdir())).filter(name => name.startsWith('imperfect-private-'));
const until = async (ok, ms = 5000) => { for (const end = Date.now() + ms; !(await ok()); await new Promise(r => setTimeout(r, 50))) if (Date.now() > end) return false; return true; };

test('headless is a field of the browser tool, off unless asked', () => {
  assert.equal(BROWSER_TOOL.parameters.properties.headless.type, 'boolean');
  assert.match(BROWSER_TOOL.description, /headless: true uses a private browser/);
});

// A child that does not launch Electron: failure/startup tests have no windows.
function silentChild(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  const alive = setInterval(() => {}, 1000);
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    clearInterval(alive);
    child.stdin.destroy();
    child.stdout.end();
    setImmediate(() => child.emit('exit', 0));
  };
  t.after(() => child.kill());
  return child;
}

test('private backend aliases are refused without contacting any human backend', () => {
  for (const address of ['http://localhost:5067/', 'http://desktop:5067/', 'http://example.org:5067/',
    'https://desktop.tail-test.ts.net/', 'https://laptop/', 'wss://desktop.tail-test.ts.net/pi',
    'https://100.64.0.1/', 'https://100.127.0.1/', 'https://[::1]/', 'ws://127.0.0.1:5067/pi']) {
    assert.equal(privateBackendAddress(address, 5067, 'desktop'), true, address);
  }
  for (const address of ['https://www.shopify.com/editions/winter2026', 'http://127.0.0.1:49123/',
    'https://desktop.tail-test.ts.net:8443/', 'https://100.128.0.1/', 'data:image/png,x']) {
    assert.equal(privateBackendAddress(address, 5067, 'desktop'), false, address);
  }
  assert.equal(privateBackendAddress('http://localhost:5099/', 5099), true);
});

test('a large positive headed number never becomes private', async () => {
  assert.equal(isPrivateTab(1001), false);
  const result = await runBrowser({ action: 'eval', tab: 1001, js: '1' }, {
    ask: async request => { assert.equal(request.tab, 1001); return { tab: 1001, value: 1 }; },
  });
  assert.equal(result, '1');
});

test('unknown negative numbers fail closed in either mode, never opening a human window', async () => {
  await assert.rejects(runBrowser({ action: 'look', tab: -999999 }, {
    ask: async () => assert.fail('human window must not be asked'),
  }), /private tab/);
  await assert.rejects(askPrivately({ do: 'open', tab: -999999, session: 's' }, {
    start: () => assert.fail('no helper should start'),
  }), /closed/);
});

test('a request already aborted never starts a private browser', async () => {
  await assert.rejects(askPrivately({ do: 'open', session: 's' }, {
    signal: AbortSignal.abort(), start: () => assert.fail('no helper should start'),
  }), /Stopped/);
});

test('cancelling during startup rejects promptly', async t => {
  const child = silentChild(t);
  const one = startPrivate({ run: () => child });
  t.after(() => one.stop());
  const stop = new AbortController();
  const began = Date.now();
  const asked = one.ask({ do: 'open', session: 's' }, { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(asked, /Stopped/);
  assert.ok(Date.now() - began < 1000);
});

test('a never-ready browser is killed on its bounded startup timeout', async t => {
  const child = silentChild(t);
  const one = startPrivate({ run: () => child, startupTimeout: 30 });
  await assert.rejects(one.ask({ do: 'open', session: 's' }), /did not start in time/);
  assert.equal(child.killed, true);
});

test('spawn errors reject readiness immediately instead of waiting for an exit that never comes', async t => {
  const child = silentChild(t);
  const one = startPrivate({ run: () => child });
  const asked = one.ask({ do: 'open', session: 's' });
  setImmediate(() => child.emit('error', new Error('ENOENT test')));
  await assert.rejects(asked, /could not start.*ENOENT test/);
  assert.equal(child.killed, true);
});

test('without headless the tool still asks the person\'s window, and never starts the private browser', async () => {
  const asked = [];
  const said = await runBrowser({ action: 'open', url: 'pi.dev', session: 's' }, { ask: async request => { asked.push(request); return { tab: 2, url: request.url, title: 'Pi' }; } });
  assert.equal(said, 'Opened Pi — https://pi.dev/ (tab 2), behind the tab in front');
  assert.deepEqual(asked.map(one => one.do), ['open']);
  // A session ending with no private browser running asks nothing of one.
  await endPrivately('s');
  const ended = [];
  await createBrowser({ self: async () => ({ id: 'pc', name: 'pc' }), peer: async () => null, sockets: async () => [] }).end('s').then(() => ended.push('s'));
  assert.deepEqual(ended, ['s']);
});

test('a private tab is used only in private, by its own session, on this computer', async t => {
  const url = await site(t);
  const { started, ask } = watched(t);
  const use = (args, session = 'a') => runBrowser({ session, headless: true, ...args }, { ask });
  const opened = await use({ action: 'open', url: `${url}/one` });
  const tab = Number(/tab (-\d+)/.exec(opened)[1]);
  assert.ok(tab <= PRIVATE_TABS && isPrivateTab(tab));
  assert.match(opened, /where no one sees it/);
  await assert.rejects(runBrowser({ session: 'a', action: 'look', tab }, { ask: async () => assert.fail('the person\'s window is not asked') }), /is a private tab: use it with headless: true/);
  await assert.rejects(use({ action: 'look', tab: 3 }), /Tab 3 is not a private tab/);
  await assert.rejects(use({ action: 'look', tab }, 'b'), /another session's/);
  await assert.rejects(use({ action: 'look', computer: 'laptop' }), /this computer only/);
  assert.match(await use({ action: 'look', computer: 'local' }), /Hello/);
  await assert.rejects(use({ action: 'front' }), /no window to bring to the front/);
  await assert.rejects(use({ action: 'look' }, 'b'), /no private tab open/);
  assert.equal(await use({ action: 'tabs' }, 'b'), 'On the private browser:\nNo tabs are open in the browser.');
  assert.equal(started.length, 1);
});

test('the private browser drives a page as the window does, with nothing to show, keep or ask', async t => {
  const url = await site(t);
  const { started, ask } = watched(t);
  const use = args => runBrowser({ session: 'a', headless: true, ...args }, { ask });
  await use({ action: 'open', url: `${url}/one` });
  // No display: it cannot draw a window anywhere.
  const env = (await readFile(`/proc/${started[0].child.pid}/environ`, 'utf8')).split('\0');
  assert.ok(!env.some(line => /^(WAYLAND_DISPLAY|DISPLAY)=/.test(line)));
  assert.match(await use({ action: 'look' }), /\[1\] input text "name"\n\[2\] button "Go"/, 'an alert did not stop the page');
  await use({ action: 'type', ref: 1, text: 'abc' });
  assert.equal(await use({ action: 'eval', js: `document.querySelector('input').value` }), 'abc');
  assert.match(await use({ action: 'click', ref: 2 }), /typed abc/);
  // Refs read current DOM geometry, which can be newer than the compositor's
  // mouse hit-test regions. No test sleep: the driver must submit this frame
  // before clicking, even for a hidden page on a busy computer.
  await use({ action: 'eval', js: `
    document.title = 'Waiting for moved click';
    window.movedClick = false;
    const button = document.querySelector('button');
    button.addEventListener('click', event => window.movedClick = event.isTrusted, { once: true });
    button.style.cssText = 'position:absolute;left:800px;top:600px';
    1
  ` });
  assert.match(await use({ action: 'click', ref: 2 }), /typed abc/);
  assert.equal(await use({ action: 'eval', js: 'window.movedClick' }), 'true', 'a real mouse event reached the moved button');
  assert.match(await use({ action: 'scroll', dy: 400 }), /Scrolled down 400 pixels/);
  await use({ action: 'key', key: 'Home' });
  assert.equal(await use({ action: 'eval', js: 'innerWidth + "x" + innerHeight' }), '1280x800');
  assert.equal(await use({ action: 'eval', js: 'navigator.permissions.query({ name: "geolocation" }).then(p => p.state)' }), 'denied');
  const [, picture] = await use({ action: 'look', screenshot: true });
  assert.equal(picture.mimeType, 'image/png');
  assert.ok(Buffer.from(picture.data, 'base64').length > 1000);
  // Popups open in the same tab; downloads are refused.
  await use({ action: 'eval', js: `window.open('${url}/two'), 1` });
  assert.ok(await until(async () => /\/two$/.test(await use({ action: 'eval', js: 'location.href' }))));
  assert.equal(await use({ action: 'tabs' }).then(list => list.split('\n').length), 2, 'one tab still');
  await use({ action: 'eval', js: `location.href = '${url}/file', 1` });
  assert.match(await use({ action: 'eval', js: 'location.pathname' }), /\/two/);
  await use({ action: 'back' });
  assert.match(await use({ action: 'eval', js: 'location.pathname' }), /\/one/);
});

test('each session starts with an empty profile of its own, forgotten when it ends, and the last one out stops the private browser', async t => {
  const url = await site(t);
  const { started, ask } = watched(t);
  const use = (args, session) => runBrowser({ session, headless: true, ...args }, { ask });
  assert.match(await use({ action: 'open', url: `${url}/set?who=a` }, 'a'), /Seen nobody/);
  assert.match(await use({ action: 'open', url: `${url}/again` }, 'a'), /Seen who=a/, 'a session keeps its own cookies');
  assert.match(await use({ action: 'open', url: `${url}/again` }, 'b'), /Seen nobody/, 'another session never sees them');
  assert.equal(await use({ action: 'eval', js: 'localStorage.n' }, 'b'), '1');
  const pid = started[0].child.pid;
  // Session a ends: its tabs close and what it kept is gone.
  await endPrivately('a');
  assert.match(await use({ action: 'tabs' }, 'a'), /No tabs are open/);
  assert.match(await use({ action: 'open', url: `${url}/again` }, 'a'), /Seen nobody/);
  assert.equal(await use({ action: 'eval', js: 'localStorage.n' }, 'a'), '1');
  // With no tab left anywhere it stops, and its profile folder goes with it.
  await endPrivately('a');
  await use({ action: 'close' }, 'b');
  await assert.rejects(use({ action: 'close' }, 'b'), /no private tab open/, 'without starting another to say so');
  assert.match(await use({ action: 'tabs' }, 'b'), /No tabs are open/);
  assert.ok(await until(() => started[0].child.exitCode !== null || started[0].child.signalCode !== null), 'it stopped');
  assert.ok(await until(async () => !(await profiles()).some(name => name.startsWith(`imperfect-private-${process.pid}-`))), 'its profile is gone');
  // Asked again, a fresh one starts, with nothing from before.
  assert.match(await use({ action: 'open', url: `${url}/again` }, 'b'), /Seen nobody/);
  assert.equal(started.length, 2);
  assert.notEqual(started[1].child.pid, pid);
});

test('a request is stopped when the agent stops it, and the private browser goes on', async t => {
  const url = await site(t);
  const { ask } = watched(t);
  const use = (args, signal) => runBrowser({ session: 'a', headless: true, signal, ...args }, { ask });
  await use({ action: 'open', url: `${url}/one` });
  const stop = new AbortController();
  const began = Date.now();
  const slow = use({ action: 'open', url: `${url}/slow` }, stop.signal);
  setTimeout(() => stop.abort(), 300);
  await assert.rejects(slow, /Stopped/);
  assert.ok(Date.now() - began < 3000);
  assert.match(await use({ action: 'eval', js: '"still " + 1' }), /still 1/);
});

test('ending the final session stops the real helper without an explicit tab close', async t => {
  const url = await site(t);
  const { started, ask } = watched(t);
  await runBrowser({ action: 'open', url, headless: true, session: 'last' }, { ask });
  await endPrivately('last');
  assert.ok(await until(() => started[0].child.exitCode !== null || started[0].child.signalCode !== null));
  assert.match(await runBrowser({ action: 'tabs', headless: true, session: 'last' }, { ask }), /No tabs are open/);
  assert.equal(started.length, 1);
});

test('private pages cannot reach a mock harness through open, frames, fetch or WebSockets', async t => {
  let reached = 0;
  const backend = createServer((_, res) => { reached++; res.end('mock, never the human backend'); });
  backend.on('upgrade', (_, socket) => { reached++; socket.destroy(); });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => backend.close());
  const port = backend.address().port;
  const address = `http://127.0.0.1:${port}`;
  provideWindowPort(port);
  t.after(() => provideWindowPort(5067));
  const url = await site(t);
  const { ask } = watched(t);
  const use = args => runBrowser({ session: 'network-guard', headless: true, ...args }, { ask });
  await assert.rejects(use({ action: 'open', url: address }), /web addresses only/);
  await use({ action: 'open', url });
  assert.equal(await use({ action: 'eval', js: `fetch('${address}/probe', {mode:'no-cors'}).then(()=>false,()=>true)` }), 'true');
  await use({ action: 'eval', js: `new Promise(resolve=>{const frame=document.createElement('iframe'); frame.src='${address}/frame'; document.body.appendChild(frame); setTimeout(()=>resolve(true),400)})` });
  assert.equal(await use({ action: 'eval', js: `new Promise(resolve=>{const socket=new WebSocket('ws://127.0.0.1:${port}/pi'); socket.onerror=()=>resolve(true); socket.onopen=()=>{socket.close();resolve(false)};setTimeout(()=>resolve('timeout'),1000)})` }), 'true');
  assert.equal(reached, 0, 'not even an HTTP request reached the mock harness');
});

test('a private browser that dies says so, and the next request starts another', async t => {
  const url = await site(t);
  const { started, ask } = watched(t);
  const use = args => runBrowser({ session: 'a', headless: true, ...args }, { ask });
  const opened = await use({ action: 'open', url: `${url}/one` });
  const tab = Number(/tab (-\d+)/.exec(opened)[1]);
  started[0].child.kill('SIGKILL');
  assert.ok(await until(() => started[0].child.signalCode !== null));
  await assert.rejects(use({ action: 'look', tab }), /closed/);
  assert.match(await use({ action: 'open', url: `${url}/one` }), new RegExp(`tab ${tab - 1}`), 'numbers are never reused');
  assert.equal(started.length, 2);
});
