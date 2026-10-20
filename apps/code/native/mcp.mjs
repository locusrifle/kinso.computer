// imperfect's own tools (tools.mjs), served as an MCP server at /mcp on
// imperfect's server. It is the one way every harness reaches them: Claude
// Code and Pi each connect to it as an ordinary MCP server (Streamable HTTP).
//
// Each session is handed its own token, sent as a bearer header. The token is
// who is calling: the session, the folder it works in, its harness and the
// window's dialogs for it, so a tool never takes those from the model. A
// request without a known token is refused. Only this computer may ask, for
// now; because the token travels in a header rather than with the
// connection, another computer could later reach a session's tools through
// /peer/<id>/mcp by dropping that one check.
//
// The protocol is the part of MCP these tools need: initialize, ping,
// tools/list, tools/call and notifications/cancelled (a stopped turn), each
// answered as one JSON body. An authenticated GET stream only invalidates the
// tool list; the harness's own MCP client refreshes it without stopping work.
import { randomBytes } from 'node:crypto';
import { toolContent } from './code-control.mjs';
import { TOOLS, DEVICE_HANDS, availableTools } from './tools.mjs';
import { onDeviceHandsChange } from '../../../system/device-hands.mjs';

// What runs each tool, by name (a test adds one that waits to be stopped).
export const runs = new Map([...TOOLS, DEVICE_HANDS].map(([tool, run]) => [tool.name, run]));
const callers = new Map(); // token -> session identity, active calls and notification streams
const toolListChanged = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
const notify = res => { if (!res.write(toolListChanged)) res.destroy(); };
onDeviceHandsChange(() => {
  for (const caller of callers.values()) for (const res of caller.streams) notify(res);
});

// Where the endpoint is, once imperfect's server listens (server.mjs). Tabs
// restored at start are made before that, so each is handed its tools when
// it can reach them.
let address = null;
const waiting = new Set();
export function serveMcpOn(port) {
  address = `http://127.0.0.1:${port}/mcp`;
  for (const go of [...waiting]) go();
  waiting.clear();
}

// Finish only this listener's idle notification streams before HTTP shutdown;
// server.close() otherwise waits on GET forever. Do not cancel active tool calls.
export function stopMcpOn(port) {
  if (address === `http://127.0.0.1:${port}/mcp`) address = null;
  for (const caller of callers.values()) for (const res of caller.streams) {
    if (res.socket?.localPort === port) res.end();
  }
}

// One session's way in. cwd() and session() are asked at each call.
// config(): the URL and headers a harness connects
// with, or null while imperfect is not serving yet; whenServing(fn) calls fn
// with them now, or once it is.
export function mcpSession({ cwd, session, harness, ui }) {
  const token = randomBytes(24).toString('base64url');
  callers.set(token, { cwd, session, harness, ui, calls: new Map(), streams: new Set() });
  const config = () => address && { url: address, headers: { Authorization: `Bearer ${token}` } };
  const mine = new Set();
  return {
    config,
    whenServing(fn) {
      if (address) { fn(config()); return; }
      const go = () => { mine.delete(go); if (callers.has(token)) fn(config()); };
      mine.add(go); waiting.add(go);
    },
    close() {
      for (const go of mine) waiting.delete(go);
      for (const call of callers.get(token)?.calls.values() ?? []) call.abort();
      for (const res of callers.get(token)?.streams ?? []) res.end();
      callers.delete(token);
    },
  };
}

// imperfect's own address on this computer, and nothing else.
const loopback = host => {
  try { return ['127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
};

async function readBody(req, limit = 4 * 1024 * 1024) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too long');
  }
  return body;
}

// server.mjs hands every request here first; true when it was this one's.
export async function serveMcp(req, res, path) {
  if (path !== '/mcp') return false;
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); return true; };
  if (!loopback(req.headers.host)) { res.writeHead(403).end('only this computer, for now'); return true; }
  const caller = callers.get(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]);
  if (!caller) { res.writeHead(403).end('no session has that token'); return true; }
  if (req.method === 'GET') {
    if (req.headers.origin !== undefined || !req.headers.accept?.includes('text/event-stream')) { res.writeHead(403).end(); return true; }
    if (caller.streams.size >= 4) { res.writeHead(429).end(); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    caller.streams.add(res);
    // Also invalidate on open/reopen: no event history or second session ID.
    notify(res);
    const heartbeat = setInterval(() => { if (!res.write(': alive\n\n')) res.destroy(); }, 15_000);
    heartbeat.unref();
    res.once('close', () => { clearInterval(heartbeat); caller.streams.delete(res); });
    return true;
  }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, GET' }).end(); return true; }
  let message;
  try { message = JSON.parse(await readBody(req)); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (message?.id === undefined) {
    // A notification. A stopped turn cancels its tool call.
    if (message?.method === 'notifications/cancelled') caller.calls.get(message.params?.requestId)?.abort();
    res.writeHead(202).end();
    return true;
  }
  return json(200, await answer(caller, message, res));
}

async function answer(caller, { id, method, params = {} }, res) {
  const result = value => ({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'imperfect', version: '1' } });
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools: availableTools().map(([tool]) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
  if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: `No method ${method}` } };
  const run = runs.get(params.name);
  if (!run) return { jsonrpc: '2.0', id, error: { code: -32602, message: `No tool ${params.name}` } };
  const stop = new AbortController();
  caller.calls.set(id, stop);
  // A harness that hangs up has stopped waiting too.
  res.once('close', () => { if (!res.writableEnded) stop.abort(); });
  const args = params.arguments ?? {};
  try {
    return result({ content: toolContent(await run({ ...args, cwd: args.cwd || caller.cwd(), session: caller.session(), harness: caller.harness, ui: caller.ui, signal: stop.signal })) });
  } catch (error) {
    return result({ content: [{ type: 'text', text: error?.message ?? String(error) }], isError: true });
  } finally { caller.calls.delete(id); }
}
