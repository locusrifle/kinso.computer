// Lending Messages: the PC answering its inbox to a computer that is not
// the person's own (a cloud computer behind the site's lock), only while
// the person says so, and only for the computers they name.
//
// The list is ~/.imperfect/credentials/inbox-lend.json on the PC:
//   { "port": 5069, "computers": { "noah": { "token": "sha256:<hex>", "send": false } } }
// Each computer has a token of its own (only its hash is kept here). At
// start, with that file, imperfect listens on 127.0.0.1:<port> for the lent
// inbox and nothing else: /inbox/ read, draft and discard; Send only with
// "send": true; never Connect. The file is read at every ask, so taking a
// computer out of it (or the file away) stops it at once: that computer then
// shows the demo inbox. Nothing here is the key: Unipile is only ever asked
// by the PC.
//
// The other computer reaches the port through a tunnel the PC opens to it
// (ssh -R 127.0.0.1:<its port>:127.0.0.1:<port>), and says in its own
// machine.json "inbox": "http://127.0.0.1:<its port>", with its token in its
// ~/.imperfect/credentials/inbox-token (system/inbox.mjs, createLentInbox).
//
//   node system/inbox-lend.mjs add <computer> [--send]   a token for it, kept as
//        ~/.imperfect/credentials/inbox-token-<computer> (mode 600) to copy to it;
//        never printed
//   node system/inbox-lend.mjs remove <computer>          it shows the demo inbox again
//   node system/inbox-lend.mjs list
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isInboxPath, serveInbox } from './inbox.mjs';

export const LEND_PORT = 5069;
const ID = /^[a-z][a-z0-9-]{0,40}$/;
export const lendFile = (env = process.env) => join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'credentials', 'inbox-lend.json');
const hashOf = token => `sha256:${createHash('sha256').update(String(token)).digest('hex')}`;

// The file as it is now: { port, computers: Map(id -> { token, send }) }.
// Missing or broken is no one.
export async function readLend(file) {
  let raw;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return { port: 0, computers: new Map() }; }
  const computers = new Map();
  for (const [id, entry] of Object.entries(raw?.computers ?? {})) {
    if (ID.test(id) && /^sha256:[0-9a-f]{64}$/.test(entry?.token ?? '')) computers.set(id, { token: entry.token, send: entry.send === true });
  }
  const port = Number(raw?.port ?? LEND_PORT);
  return { port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : 0, computers };
}

// Which lent computer a request is, by its token, or null.
export async function lentComputer(req, file) {
  const asked = /^Bearer ([\w-]{20,200})$/.exec(String(req.headers.authorization ?? ''))?.[1];
  if (!asked) return null;
  const hash = Buffer.from(hashOf(asked));
  const { computers } = await readLend(file);
  let found = null;
  for (const [id, entry] of computers) {
    const kept = Buffer.from(entry.token);
    if (kept.length === hash.length && timingSafeEqual(kept, hash) && !found) found = { id, send: entry.send };
  }
  return found;
}

// The lent inbox's listener: local() is the PC's own inbox.
export function createLendHandler({ local, file = lendFile() }) {
  return async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    let path, search;
    try { ({ pathname: path, search } = new URL(req.url, 'http://lend')); } catch { json(400, { error: 'bad path' }); return; }
    if (!isInboxPath(path)) { json(404, { error: 'only Messages is lent' }); return; }
    // Only what came through a tunnel to this loopback port; never a page.
    if (req.headers['sec-fetch-site'] || req.headers['tailscale-user-login'] || req.headers['x-forwarded-for']) { json(403, { error: 'not here', lent: false }); return; }
    try {
      const lent = await lentComputer(req, file);
      if (!lent) { json(403, { error: 'Messages are not lent to this computer.', lent: false }); return; }
      const box = await local();
      if (!box) { json(503, { error: 'This computer does not keep Messages.' }); return; }
      await serveInbox(req, res, path, search, box, { lent });
    } catch {
      // A broken local store/list is a refusal, never an unhandled HTTP
      // callback rejection (or an error that echoes credentials).
      if (!res.headersSent) json(503, { error: 'Messages could not be lent right now.' });
      else res.destroy();
    }
  };
}

export async function listenLend({ local, file = lendFile(), log = console }) {
  const { port } = await readLend(file);
  if (!port) return null;
  const server = createServer({ requestTimeout: 120_000 }, createLendHandler({ local, file }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }).catch(error => {
    log.error(`inbox lend: could not listen on 127.0.0.1:${port} (${error.code || error.message}); Messages is lent to no one`);
    throw error;
  });
  return { port, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/* ------------------------------------------------------------ the list */

async function writeLend(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(next, file);
  await chmod(file, 0o600);
}
async function rawLend(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { port: LEND_PORT, computers: {} };
    throw new Error(`${file} is not JSON; fix or remove it first`);
  }
}

export async function lendCommand(args, { file = lendFile(), out = line => console.log(line) } = {}) {
  const [verb, id, ...rest] = args;
  if (verb === 'add') {
    if (!ID.test(id ?? '')) throw new Error('add <computer>: a short lower-case name, as the computer is called');
    const token = randomBytes(32).toString('base64url');
    const value = await rawLend(file);
    value.computers = { ...(value.computers ?? {}), [id]: { token: hashOf(token), send: rest.includes('--send') } };
    const tokenFile = join(dirname(file), `inbox-token-${id}`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await writeLend(file, value);
    out(`${id}: lent Messages to read and draft${rest.includes('--send') ? ', and to send' : ''}. Its token is in ${tokenFile} (mode 600): copy it to that computer's ~/.imperfect/credentials/inbox-token, then delete it here.`);
  } else if (verb === 'remove') {
    const value = await rawLend(file);
    if (!value.computers?.[id]) { out(`${id} was not lent Messages`); return; }
    delete value.computers[id];
    await writeLend(file, value);
    await rm(join(dirname(file), `inbox-token-${id}`), { force: true });
    out(`${id}: no longer lent Messages; it shows the demo inbox from its next ask.`);
  } else if (verb === 'list') {
    const { port, computers } = await readLend(file);
    if (!computers.size) { out('Messages is lent to no computer.'); return; }
    for (const [name, entry] of computers) out(`${name}\t${entry.send ? 'read, draft and send' : 'read and draft'}\t127.0.0.1:${port}`);
    await stat(file);
  } else throw new Error('node system/inbox-lend.mjs add <computer> [--send] | remove <computer> | list');
}

if (process.argv[1] === import.meta.filename) {
  lendCommand(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
