// This computer's own settings (~/.imperfect/machine.json) and where its
// data lives. The settings are five: the port imperfect listens on, any
// origins it answers besides its own, the authority it follows, whether
// it is hosted: a computer someone uses only through the web (the demo's),
// which stands alone, never looking for others, so a new session simply
// starts on it; and which Messages it shows (inbox).
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export function paths(prefix) {
  const root = resolve(prefix);
  const data = join(root, 'data');
  return {
    prefix: root,
    config: join(root, 'machine.json'),
    workspace: join(data, 'workspace'),
    state: join(data, 'state'),
    agent: join(data, 'agent'),
    sessions: join(data, 'state', 'sessions'),
  };
}

function parseOrigins(value) {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.filter(Boolean).map(raw => {
    const url = new URL(String(raw).trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`origin must be http(s): ${raw}`);
    return url.origin;
  });
}

function parsePort(value) {
  if (value == null || value === '') return 5067;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${value}`);
  return port;
}

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Explicit SSH only: no scp shorthand, passwords, shell metacharacters or
// arbitrary public host. The username may differ from this Mac's login.
export function normalizeAuthorityGitUrl(value) {
  const invalid = () => { throw new Error('authority.gitUrl must be an SSH URL to a tailnet host with an absolute repository path'); };
  if (typeof value !== 'string' || !/^ssh:\/\/(?:[A-Za-z_][A-Za-z0-9_-]*@)?[a-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(value)) return invalid();
  const url = new URL(value);
  const host = url.hostname;
  const ip = host.split('.').map(Number);
  const tailIp = ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
  const dns = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const tailDns = host.endsWith('.ts.net') && host.slice(0, -7).split('.').every(label => dns.test(label));
  if (!(dns.test(host) || tailDns || tailIp) || value.split('/').slice(3).some(part => !part || part === '.' || part === '..')) return invalid();
  return value;
}
function cleanAuthority(raw = {}) {
  const id = String(raw?.id ?? '').trim();
  return {
    id: NODE_ID.test(id) ? id : '',
    name: /^[a-z0-9][a-z0-9-]{0,62}$/.test(String(raw?.name ?? '')) ? String(raw.name) : '',
    ...(raw?.gitUrl === undefined ? {} : { gitUrl: normalizeAuthorityGitUrl(raw.gitUrl) }),
  };
}

// Which Messages this computer shows (system/inbox.mjs, inboxSource):
// "demo", "own", or the PC's lent inbox at a loopback address; anything
// else is the default (the person's own, or the demo on a hosted computer).
function cleanInbox(value) {
  if (value === 'demo' || value === 'own') return value;
  return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value) ? value : '';
}

export function normalizeDeviceHandsAccount(value, { testInsecure = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['store', 'computerId', 'owner'].includes(key))) throw new Error('Invalid device hands account configuration');
  const { store, computerId, owner } = value;
  let url;
  try { url = new URL(store); } catch { throw new Error('Invalid device hands account configuration'); }
  if (typeof store !== 'string' || url.origin !== store || url.username || url.password || !(url.protocol === 'https:' || (testInsecure && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || ![computerId, owner].every(id => typeof id === 'string' && NODE_ID.test(id))) throw new Error('Invalid device hands account configuration');
  return { store, computerId, owner };
}

export function normalizeConfig(raw = {}) {
  if (raw.deviceHandsTokenFile !== undefined && (typeof raw.deviceHandsTokenFile !== 'string' || !isAbsolute(raw.deviceHandsTokenFile) || raw.deviceHandsTokenFile.includes('\0'))) throw new Error('deviceHandsTokenFile must be an absolute private file path');
  return { port: parsePort(raw.port), origins: parseOrigins(raw.origins), authority: cleanAuthority(raw.authority), hosted: raw.hosted === true,
    ...(cleanInbox(raw.inbox) ? { inbox: cleanInbox(raw.inbox) } : {}),
    ...(raw.deviceHandsTokenFile === undefined ? {} : { deviceHandsTokenFile: raw.deviceHandsTokenFile }),
    ...(raw.deviceHandsAccount === undefined ? {} : { deviceHandsAccount: normalizeDeviceHandsAccount(raw.deviceHandsAccount) }) };
}

export async function readConfig(prefix) {
  const raw = await readFile(paths(prefix).config, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  return normalizeConfig(raw);
}

export async function ensureDataDirs(prefix) {
  const target = paths(prefix);
  for (const dir of [target.workspace, target.state, target.agent, target.sessions]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return target;
}

export const resolvePrefix = (env = process.env) => resolve(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'));
