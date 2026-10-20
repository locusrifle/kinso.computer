// The real imperfect page, served with a small, synthetic snapshot behind its
// socket, for the browser tests. No live service, agent execution, personal
// session or credentials are used.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MIME } from '../../../system/files.mjs';

import { canonicalSnapshot } from '../native/canonical.mjs';

const PUBLIC = fileURLToPath(new URL('../native/public/', import.meta.url));
const USER_TEXT = 'List the project files.';
const COMMAND = 'ls';
const SESSIONS = [
  ['Project files', 40_000], ['Example task', 600_000], ['Review changes', 2_500_000],
].map(([name, ago], i) => ({
  id: `s${i}`, path: `s${i}`, name, firstMessage: '', cwd: '/workspace',
  modified: Date.now() - ago, agent: 'pi', live: false, takenOver: null,
}));

const MODELS = [
  { provider: 'claude-agent', id: 'claude-opus-5-5', name: 'Opus 5.5', engine: 'claude' },
  { provider: 'claude-agent', id: 'claude-sonnet-5', name: 'Sonnet 5', engine: 'claude' },
  { provider: 'openai-codex', id: 'gpt-6', name: 'GPT-6', engine: 'pi' },
  { provider: 'zai', id: 'glm-5', name: 'GLM 5', engine: 'pi' },
];

// What a new conversation opens on (startup.mjs), for each harness.
const STARTUP = {
  pi: { version: 'Pi 0.99.2', cwd: '~/workspace', sections: [
    { name: 'Context', compact: '~/AGENTS.md, AGENTS.md', expanded: '~/AGENTS.md\n~/workspace/AGENTS.md' },
    { name: 'Skills', compact: 'diagnose-crash', expanded: '~/.pi/agent/skills/diagnose-crash/SKILL.md' },
    { name: 'Extensions', compact: 'imperfect-environment', expanded: '~/imperfect/apps/code/native/extensions/imperfect-environment' },
    { name: 'Tools', compact: 'bash, code_session, dev_server, edit, read, show, write' },
  ] },
  claude: { version: 'Claude Code 2.1.286', cwd: '~/workspace', sections: [
    { name: 'Context', compact: '~/CLAUDE.md, CLAUDE.md, AGENTS.md', expanded: '~/CLAUDE.md\n~/workspace/CLAUDE.md\n~/workspace/AGENTS.md' },
    { name: 'Skills', compact: 'claude-api, code-review, dataviz, diagnose-crash, init, loop, run, schedule, security-review, simplify, update-config', expanded: 'claude-api (built-in)\ncode-review (built-in)\ndataviz (built-in)\ndiagnose-crash (userSettings)\ninit (built-in)\nloop (built-in)\nrun (built-in)\nschedule (built-in)\nsecurity-review (built-in)\nsimplify (built-in)\nupdate-config (built-in)' },
    { name: 'MCP', compact: 'imperfect', expanded: 'imperfect: dev_server, code_session, show' },
    { name: 'Tools', compact: 'Agent, Bash, Edit, Glob, Grep, Read, Skill, WebFetch, WebSearch, Write, code_session, dev_server, show' },
  ] },
};

// `empty` is a conversation not yet begun, which opens on its overview.
export function fixture({ empty = false, agent = 'pi' } = {}) {
  const claude = agent === 'claude';
  return canonicalSnapshot({
    agent, source: agent, sessionId: 'mirror', cwd: '/workspace',
    model: claude ? { id: 'opus', provider: 'claude-agent', name: 'Opus 5.5' } : { id: 'gpt-6', provider: 'openai-codex', name: 'gpt-6' },
    level: claude ? 'high' : 'low',
    busy: !empty, streaming: !empty,
    failed: null, operation: null, commands: [],
    tabs: [
      { id: 'mirror', sessionId: 'mirror', focused: true, status: empty ? 'idle' : 'working', agent, model: claude ? 'Opus 5.5' : 'gpt-6', name: empty ? '' : 'Project files', prompt: empty ? '' : USER_TEXT },
      { id: 'other', sessionId: 'other', focused: false, status: 'idle', agent: 'pi', model: 'gpt-6', name: 'Example task', prompt: 'Review the changes.' },
    ],
    windows: [], queue: { steering: [], items: [] },
    stats: { tokens: { input: 1200, output: 0 }, cost: 0, contextUsage: { tokens: 68400, contextWindow: 200000, percent: 34.2 } },
    ui: { dialogs: [] },
    startup: STARTUP[agent],
    turnStartedAt: Date.now() - 22_000,
    messages: empty ? [] : [
      { role: 'custom', customType: 'notice', display: true, content: 'Example Pi session' },
      // Empty prose must not create a stray bullet before the tool call.
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: USER_TEXT }, { type: 'image', name: 'example.png' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: COMMAND } }] },
    ],
    partial: null,
  });
}

// Read-only protocol fixture. It deliberately does not impersonate SDK output.
export function fixtureResponse(message) {
  if (message.type === 'sessions') return SESSIONS;
  if (message.type === 'models') return MODELS;
  if (message.type === 'level') return { current: 'low', available: ['off', 'low', 'medium', 'high'] };
  return {};
}

export async function serve(css, shape = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (path === '/theme.css') return send('text/css', css);
    const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
    try {
      const body = await readFile(join(PUBLIC, file));
      return send(MIME[extname(file)] ?? 'application/octet-stream', body);
    } catch { res.writeHead(404); res.end('no'); }
  });
  const sockets = new WebSocketServer({ server, path: '/pi' });
  sockets.on('connection', socket => {
    const push = () => socket.send(JSON.stringify({ type: 'snapshot', data: fixture(shape) }));
    socket.on('message', raw => {
      let message = {};
      try { message = JSON.parse(raw); } catch { return; }
      try {
        const data = fixtureResponse(message);
        socket.send(JSON.stringify({ type: 'response', id: message.id, success: true, data }));
      } catch (error) {
        socket.send(JSON.stringify({ type: 'response', id: message.id, success: false, error: error.message }));
      }
    });
    push();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, sockets, port: server.address().port };
}
