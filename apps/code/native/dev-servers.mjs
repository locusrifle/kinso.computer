// Development servers the agents start through imperfect instead of in their own
// shells.
//
// An agent that runs `npm run dev &` in bash leaves a server that dies with the
// shell, or outlives everything and holds its port forever, and nobody can see
// what it printed. Here imperfect keeps the server: it runs in its own process
// group, its output is kept, its address is read off what it prints (or
// waited for on a port the agent names), and it stops when asked or when imperfect
// does. Every harness reaches the same servers through one tool, `dev_server`
// (imperfect's MCP endpoint, mcp.mjs), so a server Pi started is one Claude can
// stop.
//
// The address it reports is a local one, http://localhost:<port>/, which the
// `show` tool plays in the conversation (code-control.mjs).

import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const KEEP_LINES = 300;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
// What dev servers print when they are up: "Local: http://localhost:5173/".
const ADDRESS = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/;

export function localAddress(text) {
  const found = String(text ?? '').replace(ANSI, '').match(ADDRESS)?.[0];
  if (!found) return '';
  const url = new URL(found);
  url.hostname = 'localhost';
  return url.href;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = connect({ port, host }, () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

export function createDevServers({ spawnImpl = spawn, now = Date.now, waitMs = 20_000 } = {}) {
  const servers = new Map(), watchers = new Set();
  let next = 1;

  const view = server => ({
    id: server.id, name: server.name, command: server.command, cwd: server.cwd,
    url: server.url, running: server.exit == null, exitCode: server.exit, started: server.started, session: server.session,
  });
  // A line is kept whole but handed on at most 500 characters: one minified
  // error can be a whole bundle.
  const tail = (server, count = 20) => server.lines.slice(-count).map(line => line.length > 500 ? `${line.slice(0, 500)}… (${line.length - 500} more characters)` : line).join('\n');

  // session: the one that started it.
  async function start({ command, cwd, name = '', port = 0, session = '' } = {}) {
    command = String(command ?? '').trim();
    if (!command) throw new Error('dev_server start needs a command, e.g. "npm run dev"');
    cwd = String(cwd || process.cwd());
    for (const server of servers.values()) {
      if (server.exit == null && server.command === command && server.cwd === cwd) return { server: view(server), already: true, log: tail(server) };
    }
    // A port something already answers on would look like this server
    // coming up, when it is another's page.
    if (port && await portOpen(port)) throw new Error(`port ${port} is already in use by another server; start this one on a free port`);
    const id = `s${next++}`;
    const child = spawnImpl('bash', ['-lc', command], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Nothing opens a browser on the machine; the page opens in imperfect.
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const server = { id, name: String(name || command).slice(0, 80), command, cwd, child, started: now(), lines: [], url: '', exit: null, session: String(session || '') };
    servers.set(id, server);
    let pending = '';
    const settled = new Set();
    const wake = () => { for (const done of settled) done(); settled.clear(); };
    const take = chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(ANSI, '');
        server.lines.push(line);
        if (!server.url && !port) { const url = localAddress(line); if (url) { server.url = url; wake(); } }
      }
      if (server.lines.length > KEEP_LINES) server.lines.splice(0, server.lines.length - KEEP_LINES);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('exit', (code, signal) => { server.exit = code ?? (signal ? 128 : 0); wake(); });
    child.on('error', error => { server.lines.push(String(error.message)); server.exit = 127; wake(); });

    // Up when it prints its address, or when the port it was given answers.
    const deadline = now() + waitMs;
    while (!server.url && server.exit == null && now() < deadline) {
      if (port && await portOpen(port)) { server.url = `http://localhost:${port}/`; break; }
      await new Promise(resolve => { settled.add(resolve); setTimeout(resolve, port ? 400 : 1000); });
    }
    if (server.url) for (const watcher of watchers) watcher(view(server));
    return { server: view(server), log: tail(server) };
  }

  async function stop(id) {
    const server = servers.get(id);
    if (!server) throw new Error(`no dev server ${id}; list shows the ones there are`);
    if (server.exit == null) {
      const group = -server.child.pid;
      try { process.kill(group, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 30 && server.exit == null; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (server.exit == null) try { process.kill(group, 'SIGKILL'); } catch { /* already gone */ }
    }
    servers.delete(id);
    return view(server);
  }

  function stopAll() {
    for (const server of servers.values()) {
      if (server.exit == null) try { process.kill(-server.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  return {
    start, stop, stopAll,
    list: () => [...servers.values()].map(view),
    // Told of each server as its address is known.
    watch: fn => { watchers.add(fn); return () => watchers.delete(fn); },
    log: (id, count = 60) => { const server = servers.get(id); if (!server) throw new Error(`no dev server ${id}`); return tail(server, count); },
  };
}

// One set of servers per imperfect process, whichever harness asks.
let shared = null;
export function devServers() {
  if (!shared) {
    shared = createDevServers();
    process.once('exit', () => shared.stopAll());
  }
  return shared;
}

// The tool every harness offers, as words: what it does, what it takes and
// what it answers. Its fields are JSON Schema, written once here and served
// by imperfect's MCP endpoint.
export const DEV_SERVER_TOOL = {
  name: 'dev_server',
  description: 'Start, stop, list or read the output of a development server (vite, next dev, astro, a static server, anything that keeps running and serves pages). imperfect keeps it running beside the conversation, apart from your shell, and reports its local address; pass that address to show. Every server goes through this tool, never in the background of bash. Plain HTML pages, pictures, video, sound and PDFs need no server: show them directly.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'list', 'log'] },
      command: { type: 'string', description: 'start: the command that runs the server, e.g. npm run dev' },
      cwd: { type: 'string', description: "start: the folder to run it in (default: the session's)" },
      port: { type: 'number', description: 'start: the port it listens on, if it does not print its address' },
      name: { type: 'string', description: 'start: a short name for it' },
      id: { type: 'string', description: 'stop, log: which server, as list shows it (s1, s2, ...)' },
      lines: { type: 'number', description: 'log: how many lines (default 60)' },
    },
    required: ['action'],
  },
};

// session: the calling session, filled in by the harness, never by the model.
export async function runDevServer({ action = 'list', command, cwd, name, port, id, lines, session } = {}, servers = devServers()) {
  if (action === 'start') {
    const { server, already, log } = await servers.start({ command, cwd, name, port: Number(port) || 0, session });
    const state = server.running
      ? (server.url ? `is running at ${server.url}` : 'has started but has not printed a local address yet; read its log, or start it again with the port it uses')
      : `exited with code ${server.exitCode}`;
    return `${already ? 'Already running' : 'Started'}: ${server.name} (${server.id}) in ${server.cwd} ${state}.${log ? `\n\nlast output:\n${log}` : ''}`;
  }
  if (action === 'stop') {
    const server = await servers.stop(String(id ?? ''));
    return `Stopped ${server.name} (${server.id}).`;
  }
  if (action === 'log') return servers.log(String(id ?? ''), Number(lines) || 60) || '(no output yet)';
  const list = servers.list();
  if (!list.length) return 'No dev servers are running.';
  return list.map(s => `${s.id}  ${s.running ? 'running' : `exited ${s.exitCode}`}  ${s.url || '(no address yet)'}  ${s.name}  in ${s.cwd}`).join('\n');
}
