import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createDevServers, localAddress, runDevServer } from '../dev-servers.mjs';

// A real server in a real child process: prints its address the way vite does.
const SERVE = port => `node -e "require('http').createServer((q,s)=>s.end('hi')).listen(${port},()=>console.log('  \\x1b[32m➜\\x1b[0m  Local:   http://127.0.0.1:${port}/'))"`;
const QUIET = port => `node -e "require('http').createServer((q,s)=>s.end('hi')).listen(${port})"`;

function freePort() {
  return new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test('an address is read off what a server prints, and always named localhost', () => {
  assert.equal(localAddress('  \u001b[32m➜\u001b[0m  Local:   http://127.0.0.1:5173/'), 'http://localhost:5173/');
  assert.equal(localAddress('ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000'), 'http://localhost:3000/');
  assert.equal(localAddress('Network: http://192.168.1.4:5173/'), '');
});

test('imperfect starts a server, finds its address, keeps its output, and stops its whole process group', async () => {
  const servers = createDevServers();
  const port = await freePort();
  try {
    const { server, log } = await servers.start({ command: SERVE(port), cwd: process.cwd(), name: 'site' });
    assert.equal(server.url, `http://localhost:${port}/`);
    assert.equal(server.running, true);
    assert.match(log, /Local: {3}http:\/\/127\.0\.0\.1/);
    assert.equal(await (await fetch(server.url)).text(), 'hi');

    const again = await servers.start({ command: SERVE(port), cwd: process.cwd() });
    assert.equal(again.already, true);
    assert.equal(again.server.id, server.id);
    assert.equal(servers.list().length, 1);

    await servers.stop(server.id);
    assert.equal(servers.list().length, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  } finally { servers.stopAll(); }
});

test('a server that prints nothing is found on the port it was given; one that fails says how', async () => {
  const servers = createDevServers({ waitMs: 5000 });
  const port = await freePort();
  try {
    const { server } = await servers.start({ command: QUIET(port), cwd: process.cwd(), port });
    assert.equal(server.url, `http://localhost:${port}/`);
    const failed = await servers.start({ command: 'echo no such script >&2; exit 3', cwd: process.cwd() });
    assert.equal(failed.server.running, false);
    assert.equal(failed.server.exitCode, 3);
    assert.match(failed.log, /no such script/);
    await assert.rejects(servers.start({ command: '  ' }), /needs a command/);
    // A port already answered is another's: not taken for this server coming up.
    await assert.rejects(servers.start({ command: QUIET(port), cwd: '/tmp', port }), /already in use/);
  } finally { servers.stopAll(); }
});

test('the tool answers in words both harnesses pass on', async () => {
  const servers = createDevServers();
  const port = await freePort();
  try {
    assert.equal(await runDevServer({ action: 'list' }, servers), 'No dev servers are running.');
    const started = await runDevServer({ action: 'start', command: SERVE(port), cwd: process.cwd(), name: 'site' }, servers);
    assert.match(started, new RegExp(`^Started: site \\(s1\\) in .* is running at http://localhost:${port}/\\.`));
    assert.match(await runDevServer({ action: 'list' }, servers), new RegExp(`^s1  running  http://localhost:${port}/  site`));
    assert.match(await runDevServer({ action: 'log', id: 's1' }, servers), /Local:/);
    assert.equal(await runDevServer({ action: 'stop', id: 's1' }, servers), 'Stopped site (s1).');
    await assert.rejects(runDevServer({ action: 'stop', id: 's9' }, servers), /no dev server s9/);
  } finally { servers.stopAll(); }
});

test('a minified output line is bounded in the tool log', async () => {
  const servers = createDevServers();
  try {
    const result = await servers.start({ command: `node -e "console.log('x'.repeat(2000))"`, cwd: process.cwd() });
    assert.match(result.log, /^x{500}… \(1500 more characters\)$/);
    assert.ok(result.log.length < 600);
  } finally { servers.stopAll(); }
});
