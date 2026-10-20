import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Codex keeps its sign-in, its threads and its settings in its own home
// (~/.codex, or $CODEX_HOME), as the Codex CLI in a terminal does: the
// terminal and imperfect are two front doors onto one archive.
export const codexHome = (env = process.env) => env.CODEX_HOME?.trim() || join(env.HOME || homedir(), '.codex');

let authRevision = 0;
export const codexAuthRevision = () => authRevision;

// 'chatgpt' (a ChatGPT sign-in), 'apikey' or null, from the file the Codex
// CLI writes; nothing here refreshes or writes it. Every snapshot asks which
// harnesses can start, so the answer is kept a moment rather than read each
// time a word streams.
const kept = new Map();
export function codexAuth(env = process.env) {
  const file = join(codexHome(env), 'auth.json');
  const hit = kept.get(file);
  if (hit && hit.revision === authRevision && Date.now() - hit.at < 2000) return hit.value;
  let value = null;
  try {
    const auth = JSON.parse(readFileSync(file, 'utf8'));
    if (auth?.tokens?.access_token || auth?.tokens?.refresh_token) value = 'chatgpt';
    else if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) value = 'apikey';
  } catch { /* not signed in */ }
  kept.set(file, { at: Date.now(), revision: authRevision, value });
  return value;
}

// Codex's app server: JSON-RPC, one message a line, over the stdio of a
// `codex app-server` of imperfect's own. It is how Codex's own editor
// extensions drive it (threads, turns and the items in them), so a tab here
// is a Codex thread like any other, and `codex resume` in a terminal finds it.
// `codex` is the one on the PATH, as the person's terminal would run it.
export function codexServer({ spawnImpl = spawn, env = process.env, args = [] } = {}) {
  const child = spawnImpl('codex', ['app-server', ...args], { env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const events = new EventEmitter();
  const waiting = new Map();
  let seq = 0, buffer = '', ended = null;
  const end = error => {
    if (ended) return;
    ended = error;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
    events.emit('exit', error);
  };
  child.on('error', () => end(new Error('Codex could not start. Is the Codex CLI installed on this computer?')));
  child.on('exit', () => end(new Error('Codex stopped')));
  child.stdin.on('error', () => {}); // it ended; 'exit' says so
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.method) events.emit(msg.id != null ? 'request' : 'notification', msg);
      else if (waiting.has(msg?.id)) {
        const { resolve, reject } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'Codex refused')); else resolve(msg.result);
      }
    }
  });
  const write = msg => { if (!ended) child.stdin.write(`${JSON.stringify(msg)}\n`); };
  const call = (method, params) => ended ? Promise.reject(ended) : new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    write({ id, method, params });
  });
  const ready = call('initialize', { clientInfo: { name: 'imperfect', title: 'imperfect', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
    .then(result => { write({ method: 'initialized' }); return result; });
  ready.catch(() => {}); // a request says so
  return {
    events, ready,
    request: async (method, params = {}) => { await ready; return call(method, params); },
    respond: (id, result) => write({ id, result }),
    refuse: (id, message) => write({ id, error: { code: -32603, message } }),
    close() {
      if (ended) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      end(new Error('Codex closed'));
    },
  };
}

// Signing in is Codex's own device-code flow, asked of an app server started
// for it: Codex hands back a page and a code, the sheet shows them (auth.js),
// the person enters the code on any device, and Codex saves the sign-in where
// it always does. Nothing here sees a token, and no browser opens on this
// computer, which may be one the person reaches over the network.
export function createCodexSignIn({ serverImpl = codexServer, env = process.env } = {}) {
  async function withServer(signal, work) {
    if (signal?.aborted) throw new Error('Login cancelled');
    const server = serverImpl({ env });
    const stop = () => server.close();
    signal?.addEventListener('abort', stop, { once: true });
    try { return await work(server); }
    finally {
      signal?.removeEventListener('abort', stop);
      server.close();
      authRevision++; // an open Codex tab may hold the previous account
    }
  }
  return {
    configured: () => codexAuth(env),
    login: interaction => withServer(interaction.signal, async server => {
      let loginId = null;
      const completed = new Promise((resolve, reject) => {
        server.events.on('notification', ({ method, params }) => {
          if (method !== 'account/login/completed' || (loginId && params?.loginId && params.loginId !== loginId)) return;
          if (params?.success) resolve(); else reject(new Error('Codex sign-in did not complete'));
        });
        server.events.on('exit', reject);
      });
      completed.catch(() => {});
      const started = await server.request('account/login/start', { type: 'chatgptDeviceCode' });
      if (started?.type !== 'chatgptDeviceCode' || !/^https:\/\//.test(started.verificationUrl ?? '') || !started.userCode) throw new Error('Codex did not offer a device code');
      loginId = started.loginId;
      interaction.notify({ type: 'device_code', userCode: started.userCode, verificationUri: started.verificationUrl });
      await completed;
      authRevision++;
      if (codexAuth(env) !== 'chatgpt') throw new Error('Codex did not save a ChatGPT sign-in');
    }),
    logout: ({ signal } = {}) => withServer(signal, server => server.request('account/logout')),
  };
}

export const codexSignIn = createCodexSignIn();
