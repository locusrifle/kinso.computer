#!/usr/bin/env node
// Operator-only. Never log settings, user-data, credentials or API response bodies.
import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createPublicKey, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
// Keep in step with accounts' reserved namespace, including infrastructure names.
const RESERVED = new Set('www store demo mail admin api noah locus vaita imperfect root support help status auth account accounts login logout signup billing checkout payments operator system static assets cdn ftp smtp imap pop webmail ns1 ns2 dns localhost test testing development staging dev app apps cloud computer computers door security abuse postmaster autoconfig autodiscover mta-sts community main master locker health renter'.split(' '));
export class ProvisionError extends Error {}
const fail = message => { throw new ProvisionError(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function username(value) {
  check(typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(value) && !RESERVED.has(value), 'Invalid or reserved username.');
  return value;
}
export function httpsUrl(value, { origin = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid HTTPS URL.'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443'), 'Invalid HTTPS URL.');
  check(!origin || (url.pathname === '/' && !isIP(url.hostname) && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)), 'Expected an HTTPS hostname origin.');
  return url.href.replace(/\/$/, '');
}
function supportKey(value) {
  check(typeof value === 'string' && /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]+={0,2}( [ -~]{0,128})?$/.test(value), 'Invalid support SSH public key.');
  try {
    const [type, encoded] = value.split(' '), bytes = Buffer.from(encoded, 'base64');
    check(bytes.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, ''), 'Invalid support SSH public key.');
    let offset = 0;
    const field = () => { const length = bytes.readUInt32BE(offset); offset += 4; check(length <= bytes.length - offset, 'Invalid support SSH public key.'); const part = bytes.subarray(offset, offset + length); offset += length; return part; };
    check(field().toString() === type, 'Invalid support SSH public key.');
    if (type === 'ssh-ed25519') check(field().length === 32, 'Invalid support SSH public key.');
    else { check(field().length > 0 && field().length >= 256, 'Invalid support SSH public key.'); }
    check(offset === bytes.length, 'Invalid support SSH public key.');
  } catch { fail('Invalid support SSH public key.'); }
  return value;
}
function publicKey(pem) {
  let key;
  try { key = createPublicKey(pem); check(key.asymmetricKeyType === 'ed25519', 'Store public key must be Ed25519.'); }
  catch { fail('Invalid store public key.'); }
  const canonical = key.export({ type: 'spki', format: 'pem' });
  check(typeof pem === 'string' && pem.replace(/\r\n/g, '\n').trim() === canonical.trim(), 'Store public key must be a single SPKI PEM block without extra data.');
  return canonical;
}
async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  check(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0, 'Unsafe provisioning directory permissions (require 0700).');
}
async function readSafe(path, { secret = true, optional = false } = {}) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; fail('Required provisioning file is missing or unsafe.'); }
  try {
    const st = await file.stat();
    check(st.isFile() && st.uid === process.getuid() && (secret ? (st.mode & 0o777) === 0o600 : (st.mode & 0o022) === 0) && st.size <= 65536, 'Unsafe provisioning file permissions (secrets require 0600).');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
function json(text) { try { return JSON.parse(text); } catch { fail('Invalid provisioning JSON.'); } }
async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(tmp, path);
  const dir = await open(resolve(path, '..'), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function withLock(dir, fn) {
  await privateDir(dir);
  const path = join(dir, 'operator.lock');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch { fail('Provisioning is locked. After a crash, verify no operator is running before removing operator.lock.'); }
  try { await file.writeFile(`${process.pid}\n`); await file.sync(); return await fn(); }
  finally { await file.close(); await unlink(path); }
}
function configuration(c) {
  check(c && id(c.imageId) && id(c.networkId) && id(c.zoneId), 'Config requires imageId, networkId and zoneId.');
  const storeUrl = httpsUrl(c.storeUrl || 'https://imperfect.computer', { origin: true });
  check(Array.isArray(c.serviceHosts) && c.serviceHosts.length && c.serviceHosts.every(h => typeof h === 'string' && /^[a-z0-9.-]+$/.test(h) && !isIP(h)), 'Config requires exact OpenStack serviceHosts allowlist.');
  for (const key of ['pollMs', 'timeoutMs']) if (c[key] !== undefined) check(Number.isInteger(c[key]) && c[key] >= 1 && c[key] <= 3600000, 'Invalid polling configuration.');
  for (const key of ['storePublicKeyFile', 'cloudflareTokenFile']) if (c[key] !== undefined) check(typeof c[key] === 'string' && /^[A-Za-z0-9_.-]+$/.test(c[key]) && !['.', '..'].includes(c[key]), `Invalid ${key} basename.`);
  // d2-4 (2 vCPU, 4 GB) is the rented computer; a renter may be given another.
  const flavor = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,31}$/.test(value);
  check(c.flavor === undefined || flavor(c.flavor), 'Invalid flavor name.');
  for (const renter of Object.values(c.renters || {})) check(renter?.flavor === undefined || flavor(renter.flavor), 'Invalid flavor name.');
  const securityGroupNames = c.securityGroupNames || ['default'];
  check(Array.isArray(securityGroupNames) && securityGroupNames.length > 0 && securityGroupNames.length <= 8 && new Set(securityGroupNames).size === securityGroupNames.length && securityGroupNames.every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)), 'Invalid existing security group names.');
  return { ...c, storeUrl, securityGroupNames, flavor: c.flavor || 'd2-4', pollMs: c.pollMs || 5000, timeoutMs: c.timeoutMs || 900000 };
}
function spec(c, name) { return { imageId: c.imageId, networkId: c.networkId, zoneId: c.zoneId, storeUrl: c.storeUrl, region: 'SYD1', flavor: c.renters?.[name]?.flavor || c.flavor, securityGroupNames: c.securityGroupNames }; }

// One strict transport for Keystone, Nova, Glance, Cloudflare, accounts and door.
// Authentication is per request; never attach a token to redirects or door checks.
export function transport(fetchImpl = globalThis.fetch) {
  return async (url, { method = 'GET', headers = {}, body, statuses = [200], label = 'API' } = {}) => {
    let response;
    try {
      response = await fetchImpl(url, { method, headers: { Accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { fail(`${label} request failed; reconcile before retrying.`); }
    check(!response.redirected && statuses.includes(response.status), `${label} request refused (HTTP ${Number(response.status) || 0}).`);
    let data = null;
    if (response.status !== 204 && response.status !== 404) {
      try {
        const text = await response.text();
        data = !text && response.status === 202 ? null : JSON.parse(text);
      } catch { fail(`${label} returned an invalid response.`); }
    }
    return { data, response };
  };
}
async function cloud(c, credentials, request) {
  const authUrl = httpsUrl(credentials.authUrl || 'https://auth.cloud.ovh.net/v3');
  check(new URL(authUrl).hostname === 'auth.cloud.ovh.net' && new URL(authUrl).pathname === '/v3', 'Keystone URL must be https://auth.cloud.ovh.net/v3.');
  let auth;
  if (credentials.applicationCredentialId || credentials.applicationCredentialSecret) {
    check(!credentials.username && !credentials.password && id(credentials.projectId) && id(credentials.applicationCredentialId) && typeof credentials.applicationCredentialSecret === 'string' && credentials.applicationCredentialSecret.length > 0, 'Invalid or mixed OpenStack application credential.');
    auth = { identity: { methods: ['application_credential'], application_credential: { id: credentials.applicationCredentialId, secret: credentials.applicationCredentialSecret } } };
  } else {
    // OVH projects may not expose application credentials. Accept only an
    // explicitly project-scoped runtime user, never an unscoped/admin token.
    check(id(credentials.username) && typeof credentials.password === 'string' && credentials.password.length > 0 && id(credentials.projectId) && id(credentials.userDomainName || 'Default') && id(credentials.projectDomainName || 'Default'), 'Invalid project-scoped OpenStack user credential.');
    auth = { identity: { methods: ['password'], password: { user: { name: credentials.username, password: credentials.password, domain: { name: credentials.userDomainName || 'Default' } } } }, scope: { project: { id: credentials.projectId } } };
  }
  const { data, response } = await request(`${authUrl}/auth/tokens`, { method: 'POST', statuses: [201], label: 'Keystone', body: { auth } });
  const token = response.headers.get('x-subject-token');
  const project = data?.token?.project?.id;
  check(token && id(project) && (!credentials.projectId || project === credentials.projectId), 'Keystone project/token mismatch.');
  function endpoint(type) {
    const endpoints = (data?.token?.catalog || []).filter(s => s.type === type).flatMap(s => s.endpoints || []).filter(e => e.interface === 'public' && e.region === 'SYD1');
    check(endpoints.length === 1, 'Missing or ambiguous SYD1 public service endpoint.');
    const url = httpsUrl(endpoints[0].url);
    check(c.serviceHosts.includes(new URL(url).hostname), 'OpenStack catalog endpoint is not allowlisted.');
    if (type === 'compute') check(new URL(url).pathname.endsWith(`/${project}`), 'Compute endpoint project mismatch.');
    return url;
  }
  const nova = endpoint('compute'), glance = endpoint('image');
  const api = (path, options = {}) => request(`${nova}${path}`, { ...options, headers: { 'X-Auth-Token': token }, label: 'Nova' });
  async function pages(path, field, linksField) {
    let next = `${nova}${path}`, rows = [], seen = new Set();
    while (next) {
      check(!seen.has(next) && seen.size < 100, 'Invalid OpenStack pagination.'); seen.add(next);
      const parsed = new URL(next), expected = new URL(`${nova}${path}`);
      check(parsed.origin === expected.origin && parsed.pathname === expected.pathname && !parsed.username && !parsed.password && !parsed.hash, 'Unsafe OpenStack pagination endpoint.');
      const { data } = await request(next, { headers: { 'X-Auth-Token': token }, label: 'Nova' });
      check(Array.isArray(data?.[field]), 'Invalid Nova inventory.'); rows.push(...data[field]);
      const links = (data[linksField] || []).filter(l => l.rel === 'next');
      check(links.length <= 1, 'Invalid OpenStack pagination.'); next = links[0]?.href;
    }
    return rows;
  }
  return { projectId: project, api, servers: () => pages('/servers/detail', 'servers', 'servers_links'), flavors: () => pages('/flavors/detail', 'flavors', 'flavors_links'),
    image: imageId => request(`${glance}${new URL(glance).pathname.endsWith('/v2') ? '' : '/v2'}/images/${imageId}`, { headers: { 'X-Auth-Token': token }, label: 'Glance' }) };
}
function owned(server, state, operatorId) {
  return server.metadata?.imperfect_operator === operatorId && server.metadata?.imperfect_deployment === state.deploymentId && server.metadata?.imperfect_username === state.username;
}
function reconcile(servers, state, operatorId) {
  const matches = servers.filter(s => owned(s, state, operatorId));
  check(matches.length <= 1, 'Multiple owned instances; operator reconciliation required.');
  check(!servers.some(s => (s.name === `imperfect-${state.username}` || s.id === state.serverId || s.metadata?.imperfect_username === state.username) && !owned(s, state, operatorId)), 'Foreign instance collision; refusing changes.');
  if (matches[0]) { check(id(matches[0].id) && (!state.serverId || state.serverId === matches[0].id), 'Owned instance identity changed.'); }
  return matches[0] || null;
}
function ipv4(server) {
  const addresses = Object.values(server.addresses || {}).flat().filter(a => a.version === 4 && isIP(a.addr) === 4 && !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.addr));
  const values = [...new Set(addresses.map(a => a.addr))];
  check(values.length === 1, 'Instance must have exactly one public IPv4 address.'); return values[0];
}
async function dnsClient(c, token, request) {
  check(typeof token === 'string' && token.trim(), 'Missing Cloudflare token.');
  const base = `https://api.cloudflare.com/client/v4/zones/${c.zoneId}/dns_records`;
  async function call(suffix, options = {}) {
    const { data } = await request(`${base}${suffix}`, { ...options, statuses: [200], headers: { Authorization: `Bearer ${token.trim()}` }, label: 'Cloudflare' });
    check(data?.success === true, 'Cloudflare refused request.'); return data;
  }
  async function records(domain) {
    let rows = [], page = 1, pages = 1;
    do {
      const data = await call(`?name=${encodeURIComponent(domain)}&per_page=100&page=${page}`);
      check(Array.isArray(data.result), 'Invalid DNS inventory.'); rows.push(...data.result);
      pages = data.result_info?.total_pages ?? 1;
      check(Number.isInteger(pages) && pages >= 0 && pages <= 100, 'Invalid DNS pagination.'); page++;
    } while (page <= pages);
    return rows;
  }
  function owner(state, operatorId) { return `imperfect:${operatorId}:${state.deploymentId}`; }
  async function inspect(state, operatorId) {
    const rows = await records(state.domain);
    check(rows.every(r => r.name === state.domain && r.type === 'A' && r.comment === owner(state, operatorId) && id(r.id)), 'Foreign DNS collision; refusing changes.');
    check(rows.length <= 1, 'Multiple DNS records; operator reconciliation required.'); return rows[0];
  }
  return { inspect,
    async ensure(state, operatorId, address) {
      const found = await inspect(state, operatorId);
      const body = { type: 'A', name: state.domain, content: address, ttl: 300, proxied: false, comment: owner(state, operatorId) };
      if (!found) {
        // A lost POST response must not be retried until its owned record is visible.
        check(!state.dnsCreateAttempted, 'DNS creation unresolved; reconcile the owned record before retrying.');
        state.dnsCreateAttempted = true; await state.save();
        await call('', { method: 'POST', body });
      } else if (found.content !== address || found.proxied !== false) await call(`/${found.id}`, { method: 'PUT', body });
      const confirmed = await inspect(state, operatorId);
      check(confirmed, 'DNS creation unresolved.');
      state.dnsRecordId = confirmed.id;
      state.dnsCreateAttempted = false; // A confirmed record may later be safely recreated.
      await state.save();
    },
    async remove(state, operatorId) { const found = await inspect(state, operatorId); if (found) await call(`/${found.id}`, { method: 'DELETE' }); },
  };
}
function registryRecord(storeUrl, data, state) {
  check(data && data.username === state.username && data.computerId === state.username && data.origin === state.domainOrigin && data.store === storeUrl && id(data.owner) && ['provisioning', 'ready', 'stopped', 'failed'].includes(data.state), 'Accounts computer identity mismatch.');
  if (state.ownerAccountId) check(state.ownerAccountId === data.owner, 'Accounts owner changed; refusing changes.');
  return { ...data, publicKey: publicKey(data.publicKey) };
}
// The locker's own registry, read and written in-process (same database, same
// checks as the HTTP route). Used when the operator runs beside the store.
export function localRegistry({ store, storeUrl, publicKey: pem }) {
  const record = (row, state) => row ? registryRecord(storeUrl, { username: row.username, computerId: row.computer_id, owner: row.owner, origin: `https://${row.username}.imperfect.computer`, store: storeUrl, state: row.state, publicKey: pem }, state) : null;
  return {
    async get(state) { return record(store.computerByUsername(state.username), state); },
    async set(state, status) {
      const row = store.registerComputer({ username: state.username, computerId: state.username, state: status });
      const result = record(row, state); check(result.state === status, 'Accounts state mismatch.'); return result;
    },
  };
}
// The locker's Ed25519 signer, as the SPKI PEM the door pins (its public half).
export async function signerPublicKey(prefix = join(homedir(), '.imperfect')) {
  const pem = await readSafe(join(prefix, 'credentials', 'accounts-signing-key.pem'));
  return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString();
}
export async function providerConfig(prefix = join(homedir(), '.imperfect')) {
  return json(await readSafe(join(prefix, 'credentials', 'provision.json'), { secret: false }));
}
function accountsClient(c, token, request) {
  if (!token) return null;
  const base = `${c.storeUrl}/api/accounts/computers`;
  const validate = (data, state) => registryRecord(c.storeUrl, data, state);
  return { async get(state) {
    const { data, response } = await request(`${base}/${state.username}`, { statuses: [200, 404], headers: { Authorization: `Bearer ${token.trim()}` }, label: 'Accounts' });
    return response.status === 404 ? null : validate(data, state);
  }, async set(state, status) {
    const { data } = await request(base, { method: 'POST', statuses: [200, 201], headers: { Authorization: `Bearer ${token.trim()}` }, label: 'Accounts', body: { username: state.username, computerId: state.username, state: status } });
    const record = validate(data, state); check(record.state === status, 'Accounts state mismatch.'); return record;
  } };
}
async function poll(c, now, sleep, step, label) {
  const deadline = now() + c.timeoutMs;
  do { const result = await step(); if (result) return result; await sleep(c.pollMs); } while (now() < deadline);
  fail(`${label} timed out; rerun to reconcile.`);
}

export async function run(args, { prefix = join(homedir(), '.imperfect'), config, fetch: fetchImpl = globalThis.fetch, store, registry = null, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), out = process.stdout } = {}) {
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => a !== '--dry-run');
  const [command, name, action] = positional;
  check((command === 'list' && positional.length === 1) || (command === 'provision' && positional.length === 2) || (command === 'deprovision' && positional.length === 3 && ['stop', 'delete'].includes(action)), 'Usage: provision.mjs provision <username> | list | deprovision <username> stop|delete [--dry-run]');
  if (name) username(name);
  check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS certificate verification must not be disabled.');
  prefix = resolve(prefix);
  const stateDir = join(prefix, 'provision'), credentialsDir = join(prefix, 'credentials');
  if (command === 'list') {
    const files = await readdir(stateDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const file of files.sort().filter(f => /^[a-z0-9-]+\.json$/.test(f) && f !== 'operator.json')) {
      const row = json(await readSafe(join(stateDir, file)));
      username(row.username); check(['provisioning', 'ready', 'stopped', 'deleted'].includes(row.status), 'Invalid provisioning state.');
      out.write(`${row.username} ${row.status}${row.deleteAfter ? ` delete-after=${new Date(row.deleteAfter).toISOString()}` : ''}\n`);
    }
    return;
  }
  const c = configuration(config || json(await readSafe(join(credentialsDir, 'provision.json'), { secret: false })));
  if (dryRun) {
    out.write(`${command} ${name}${action ? ` ${action}` : ''}: dry-run; SYD1 ${spec(c, name).flavor}, https://${name}.imperfect.computer; no credentials read or changes made.\n`);
    // What a real run would need, by name only: never opened here.
    const needed = ['ovh-openstack.json', c.storePublicKeyFile || 'accounts-public-key.pem', 'ovh-cloud-ssh.pub'];
    const missing = [];
    for (const file of needed) if (!await lstat(join(credentialsDir, file)).catch(() => null)) missing.push(file);
    const dnsTokens = c.cloudflareTokenFile ? [c.cloudflareTokenFile] : ['cloudflare-api-token', 'cloudflare-token'];
    if (!(await Promise.all(dnsTokens.map(file => lstat(join(credentialsDir, file)).catch(() => null)))).some(Boolean)) missing.push(dnsTokens[0]);
    if (command === 'provision' && !c.renters?.[name]?.email) out.write(`needs renters.${name}.email unless a store buyer has the handle ${name}\n`);
    if (command === 'provision' && !c.renters?.[name]?.ownerAccountId) out.write(`needs renters.${name}.ownerAccountId unless accounts registers it\n`);
    out.write(missing.length ? `missing credentials: ${missing.join(', ')}\n` : 'credential files present\n');
    return;
  }
  return withLock(stateDir, async () => {
    let operator = await readSafe(join(stateDir, 'operator.json'), { optional: true });
    operator = operator ? json(operator) : { operatorId: randomUUID() };
    check(id(operator.operatorId), 'Invalid operator identity.');
    await atomicJson(join(stateDir, 'operator.json'), operator);
    const stateFile = join(stateDir, `${name}.json`);
    const existing = await readSafe(stateFile, { optional: true });
    check(existing || command === 'provision', 'No managed computer for that username.');
    const state = existing ? json(existing) : { version: 1, username: name, domain: `${name}.imperfect.computer`, domainOrigin: `https://${name}.imperfect.computer`, deploymentId: randomUUID(), status: 'provisioning', spec: spec(c, name) };
    check(state.version === 1 && state.username === name && state.domain === `${name}.imperfect.computer` && state.domainOrigin === `https://${name}.imperfect.computer` && id(state.deploymentId) && ['provisioning', 'ready', 'stopped', 'deleted'].includes(state.status) && (!state.serverId || id(state.serverId)), 'Invalid provisioning state; refusing changes.');
    check(state.spec?.region === 'SYD1' && state.spec.zoneId === c.zoneId && state.spec.storeUrl === c.storeUrl && (command !== 'provision' || JSON.stringify(state.spec) === JSON.stringify(spec(c, name))), 'Provisioning state/config mismatch; refusing changes.');
    state.save = () => atomicJson(stateFile, state);
    if (state.status === 'deleted') { check(command === 'deprovision', 'Deleted username cannot be reprovisioned automatically.'); out.write(`${name} deleted\n`); return; }
    check(command !== 'provision' || state.status !== 'stopped', 'Stopped computer is retained; refusing reprovision.');
    if (action === 'delete') {
      check(state.status === 'stopped' && Number.isFinite(state.deleteAfter) && now() >= state.deleteAfter, 'Retention has not elapsed (30 days after confirmed stop).');
      check(store, 'A local store database is required to revoke the computer license.');
    }
    await state.save();
    const request = transport(fetchImpl);
    const os = await cloud(c, json(await readSafe(join(credentialsDir, 'ovh-openstack.json'))), request);
    check(state.projectId ? state.projectId === os.projectId : !state.createAttempted && !state.serverId, 'Deployment project mismatch or missing binding; refusing changes.');
    state.projectId = os.projectId;
    await state.save();
    // Prefer a token that can only edit this zone's DNS (cloudflareTokenFile).
    const cf = c.cloudflareTokenFile ? await readSafe(join(credentialsDir, c.cloudflareTokenFile))
      : await readSafe(join(credentialsDir, 'cloudflare-api-token'), { optional: true }) ?? await readSafe(join(credentialsDir, 'cloudflare-token'));
    const dns = await dnsClient(c, cf, request);
    const operatorToken = registry ? null : await readSafe(join(credentialsDir, 'accounts-operator-token'), { optional: true });
    const accounts = registry ?? accountsClient(c, operatorToken, request);
    let server = reconcile(await os.servers(), state, operator.operatorId);
    await dns.inspect(state, operator.operatorId); // No license/VM mutation until foreign DNS is excluded.
    if (command === 'deprovision') {
      if (accounts) check(await accounts.get(state), 'Accounts registry missing; reconcile ownership before deprovisioning.');
      if (action === 'stop') {
        check(server, 'Managed instance missing; cannot establish retention.');
        state.serverId = server.id; await state.save();
        if (server.status !== 'SHUTOFF') {
          // Persist cancellation of an old retention epoch before an uncertain
          // stop response; a resumed computer gets a fresh full 30 days.
          delete state.stoppedAt; delete state.deleteAfter;
          await state.save();
          await os.api(`/servers/${server.id}/action`, { method: 'POST', body: { 'os-stop': null }, statuses: [202] });
          server = await poll(c, now, sleep, async () => {
            const found = reconcile(await os.servers(), state, operator.operatorId);
            check(found, 'Managed instance missing during stop.'); return found.status === 'SHUTOFF' ? found : null;
          }, 'Instance stop');
        }
        if (!Number.isFinite(state.stoppedAt)) { state.stoppedAt = now(); state.deleteAfter = state.stoppedAt + 30 * DAY; }
        state.status = 'stopped'; await state.save();
        await dns.remove(state, operator.operatorId);
        if (accounts) await accounts.set(state, 'stopped');
      } else {
        const license = store.licenseBySession(`provision:${state.deploymentId}`);
        check(license, 'Computer license missing; reconcile the local store before deletion.');
        const secretPath = join(credentialsDir, 'provision', `${name}.json`);
        const secretText = await readSafe(secretPath, { optional: true });
        if (secretText) check(license.key === json(secretText).memberKey, 'Computer license identity mismatch.');
        if (server) {
          check(server.status === 'SHUTOFF', 'Instance is running; stop it before deletion.');
          await dns.remove(state, operator.operatorId);
          await os.api(`/servers/${server.id}`, { method: 'DELETE', statuses: [204, 404] });
          await poll(c, now, sleep, async () => !reconcile(await os.servers(), state, operator.operatorId), 'Instance deletion');
        } else await dns.remove(state, operator.operatorId);
        if (accounts) await accounts.set(state, 'stopped'); // Contract has no deleted registry state.
        const revoked = store.revokeLicense(license.key);
        check(revoked?.key === license.key && revoked.status === 'revoked', 'Computer license revocation failed; retry retirement.');
        if (secretText) await unlink(secretPath);
        state.status = 'deleted'; await state.save();
      }
      out.write(`${name} ${state.status}${state.deleteAfter ? ` delete-after=${new Date(state.deleteAfter).toISOString()}` : ''}\n`); return;
    }
    if (!server) check(!state.createAttempted, 'Instance creation unresolved; owned metadata must appear before retry. Never blindly repeat Nova POST.');
    else { check(!['SHUTOFF', 'ERROR', 'DELETED'].includes(server.status), 'Managed instance is stopped or failed; operator review required.'); state.serverId = server.id; await state.save(); }
    check(store, 'A local store database is required.');
    const mapped = c.renters?.[name];
    let record = accounts ? await accounts.get(state) : null;
    if (accounts && !record) record = await accounts.set(state, 'provisioning');
    const owner = record?.owner || mapped?.ownerAccountId;
    check(id(owner), 'Missing renter ownerAccountId (accounts registry or renters mapping).');
    if (mapped?.ownerAccountId) check(mapped.ownerAccountId === owner, 'Renter mapping/accounts owner mismatch.');
    if (state.ownerAccountId) check(state.ownerAccountId === owner, 'Renter owner changed.');
    state.ownerAccountId = owner; await state.save();
    // Accounts intentionally do not expose email. Resolve an existing buyer handle,
    // otherwise require an explicit operator email mapping; never invent identity links.
    const buyerRows = store.listLicenses().filter(l => l.handle === name);
    const emails = [...new Set(buyerRows.map(l => l.email))];
    check(emails.length <= 1, 'Ambiguous store buyer handle.');
    const email = emails[0] || mapped?.email;
    check(typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'No store buyer email; configure renters.<username>.email.');
    if (mapped?.email && emails[0]) check(mapped.email.toLowerCase() === emails[0].toLowerCase(), 'Store buyer/mapping email mismatch.');
    const secretDir = join(credentialsDir, 'provision'); await privateDir(secretDir);
    const secretPath = join(secretDir, `${name}.json`);
    const saved = await readSafe(secretPath, { optional: true });
    const registeredSso = record ? { storeUrl: record.store, computerId: record.computerId, ownerAccountId: record.owner, storePublicKey: record.publicKey } : null;
    let settings;
    if (saved) {
      settings = json(saved);
      check(settings.username === name && settings.domain === state.domain && settings.ownerAccountId === owner && settings.storeUrl === c.storeUrl, 'Saved bootstrap identity mismatch.');
      const license = store.licenseBySession(`provision:${state.deploymentId}`);
      check(license?.status === 'active' && license.key === settings.memberKey, 'Computer license is missing or revoked.');
      check(store.buyer(license.buyer_id)?.email === email.trim().toLowerCase(), 'Computer license buyer changed.');
      check(Object.keys(settings).filter(key => key !== 'sso').sort().join(',') === 'domain,memberKey,oneTimePassword,ownerAccountId,storePublicKey,storeUrl,supportSshKey,username,version' && settings.version === 1 && /^ic_[a-f0-9]{40}$/.test(settings.memberKey) && /^[!-~]{24,128}$/.test(settings.oneTimePassword), 'Invalid saved bootstrap settings.');
      publicKey(settings.storePublicKey); supportKey(settings.supportSshKey);
      if (record) check(record.publicKey === settings.storePublicKey, 'Accounts public key changed; operator review required.');
      if (Object.hasOwn(settings, 'sso')) {
        const sso = settings.sso;
        // Exact equality to the authenticated, validated record also validates
        // every nested identity/origin/key. Never infer defaults or downgrade.
        check(registeredSso && sso && typeof sso === 'object' && !Array.isArray(sso) && Object.keys(sso).sort().join(',') === 'computerId,ownerAccountId,storePublicKey,storeUrl' && Object.entries(registeredSso).every(([key, value]) => sso[key] === value), 'Saved SSO settings/registry mismatch; refusing changes.');
      }
      // Saved payloads stay unchanged, including legacy PAM after registration.
    } else {
      check(!state.createAttempted && !server, 'Bootstrap secrets missing for existing/attempted instance; refusing replacement.');
      const pem = publicKey(record?.publicKey || await readSafe(join(credentialsDir, c.storePublicKeyFile || 'accounts-public-key.pem'), { secret: false }));
      const supportSshKey = supportKey((await readSafe(join(credentialsDir, 'ovh-cloud-ssh.pub'), { secret: false })).trim());
      const license = store.issueLicense({ email, stripeSession: `provision:${state.deploymentId}` });
      check(license.status === 'active' && /^ic_[a-f0-9]{40}$/.test(license.key), 'Computer license is revoked or invalid.');
      check(store.buyer(license.buyer_id)?.email === email.trim().toLowerCase(), 'Computer license buyer changed.');
      settings = { version: 1, username: name, domain: state.domain, ownerAccountId: owner, storePublicKey: publicKey(pem), memberKey: license.key, supportSshKey, oneTimePassword: randomBytes(32).toString('base64url'), storeUrl: c.storeUrl, ...(registeredSso ? { sso: registeredSso } : {}) };
      await atomicJson(secretPath, settings);
    }
    if (!server) {
      const flavors = (await os.flavors()).filter(f => f.name === state.spec.flavor);
      check(flavors.length === 1 && id(flavors[0].id), `Missing or ambiguous SYD1 ${state.spec.flavor} flavor.`);
      const image = (await os.image(c.imageId)).data;
      check(image?.id === c.imageId && image.status === 'active', 'Configured image is not active.');
      const userData = JSON.stringify(settings);
      check(Buffer.byteLength(userData) <= 16384, 'Bootstrap settings exceed image limit.');
      state.createAttempted = true; await state.save();
      // Ignore returned instance ids: reconcile full inventory and ownership even
      // on a successful response. If POST fails ambiguously, next run does the same.
      await os.api('/servers', { method: 'POST', statuses: [202], body: { server: { name: `imperfect-${name}`, imageRef: c.imageId, flavorRef: flavors[0].id, networks: [{ uuid: c.networkId }], security_groups: c.securityGroupNames.map(name => ({ name })), config_drive: true, user_data: Buffer.from(userData).toString('base64'), metadata: { imperfect_operator: operator.operatorId, imperfect_deployment: state.deploymentId, imperfect_username: name } } } });
    }
    server = await poll(c, now, sleep, async () => {
      const found = reconcile(await os.servers(), state, operator.operatorId);
      if (!found) return null;
      check(!['ERROR', 'SHUTOFF', 'DELETED'].includes(found.status), 'Instance failed or stopped; operator review required.');
      if (found.status !== 'ACTIVE') return null;
      return found;
    }, 'Instance readiness');
    state.serverId = server.id; state.address = ipv4(server); await state.save();
    await dns.ensure(state, operator.operatorId, state.address);
    await poll(c, now, sleep, async () => {
      try {
        const { data } = await request(`${state.domainOrigin}/healthz`, { label: 'Door' });
        return data?.up === true && typeof data.version === 'string' && data.version.length > 0 && (!c.expectedHealthVersion || data.version === c.expectedHealthVersion);
      } catch (error) { if (error instanceof ProvisionError) return false; throw error; }
    }, 'Door TLS readiness');
    if (accounts) await accounts.set(state, 'ready');
    state.status = 'ready'; await state.save();
    out.write(`${name} ready ${state.domainOrigin}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store;
  try {
    const args = process.argv.slice(2);
    if (!args.includes('--dry-run') && ['provision', 'deprovision'].includes(args[0])) {
      // Do not load locker.env/mail credentials: provisioning only needs its DB.
      const dbPath = join(homedir(), '.imperfect', 'locker', 'locker.db');
      const dbInfo = await lstat(dbPath).catch(() => null);
      check(dbInfo?.isFile() && dbInfo.uid === process.getuid(), 'An existing owned local store database is required.');
      const { openStore } = await import('../store.mjs');
      store = openStore(dbPath);
    }
    await run(args, { store });
  } catch (error) {
    process.stderr.write(`${error instanceof ProvisionError ? error.message : 'Provisioning failed; inspect local state and reconcile safely.'}\n`);
    process.exitCode = 2;
  } finally { store?.close(); }
}
