import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { run, username, httpsUrl, withLock, ProvisionError, localRegistry } from '../tools/provision.mjs';
import { syncOnce } from '../tools/rental-sync.mjs';
import { createAccounts } from '../accounts.mjs';
import { openStore } from '../store.mjs';

const pub = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
const DAY = 86400000;
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
async function fixture(t, { accounts = false } = {}) {
  const prefix = await mkdtemp(join(tmpdir(), 'provision-test-')), credentials = join(prefix, 'credentials');
  await mkdir(credentials, { mode: 0o700 });
  const file = (name, value, mode = 0o600) => writeFile(join(credentials, name), typeof value === 'string' ? value : JSON.stringify(value), { mode });
  await file('ovh-openstack.json', { applicationCredentialId: 'app-id', applicationCredentialSecret: 'FAKE-OPENSTACK-SECRET', projectId: 'project-id' });
  await file('cloudflare-api-token', 'FAKE-CLOUDFLARE-TOKEN');
  await file('accounts-public-key.pem', pub, 0o644);
  const wireField = bytes => { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };
  await file('ovh-cloud-ssh.pub', `ssh-ed25519 ${Buffer.concat([wireField(Buffer.from('ssh-ed25519')), wireField(Buffer.alloc(32, 1))]).toString('base64')} support`, 0o644);
  if (accounts) await file('accounts-operator-token', 'FAKE-ACCOUNTS-TOKEN');
  const config = { imageId: 'image-id', networkId: 'network-id', zoneId: 'zone-id', storeUrl: 'https://imperfect.computer', serviceHosts: ['compute.syd1.cloud.ovh.net', 'image.compute.syd1.cloud.ovh.net'], pollMs: 1, timeoutMs: 5, renters: { alice: { email: 'alice@example.test', ownerAccountId: 'account-alice' } } };
  const store = openStore(':memory:');
  t.after(async () => { store.close(); await rm(prefix, { recursive: true, force: true }); });
  const mock = { calls: [], servers: [], records: [], lostCreate: false, invisibleCreate: false, lostDns: false, healthBad: false, errorPath: null, foreignCatalog: false, accountOwner: 'account-alice', accountState: 'provisioning', noAccount: false, healthRedirect: false };
  const nova = 'https://compute.syd1.cloud.ovh.net/v2/project-id', glance = 'https://image.compute.syd1.cloud.ovh.net', cf = 'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records';
  const accountRecord = () => ({ username: 'alice', computerId: 'alice', state: mock.accountState, origin: 'https://alice.imperfect.computer', owner: mock.accountOwner, store: 'https://imperfect.computer', publicKey: pub, ...mock.accountOverrides });
  let clock = 100000, output = '';
  const fetch = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const body = options.body ? JSON.parse(options.body) : undefined;
    mock.calls.push({ url, options, body });
    if (mock.errorPath && url.includes(mock.errorPath)) return response({ error: 'FAKE-RAW-SECRET-IN-API-ERROR' }, 403);
    if (url === 'https://auth.cloud.ovh.net/v3/auth/tokens') {
      assert.deepEqual(body.auth.identity.methods, [mock.authMethod || 'application_credential']);
      if (mock.authMethod === 'password') {
        assert.deepEqual(body.auth.scope, { project: { id: 'project-id' } });
        assert.equal(body.auth.identity.password.user.domain.name, 'Default');
      }
      return response({ token: { project: { id: 'project-id' }, catalog: [
        { type: 'compute', endpoints: [{ region: 'SYD1', interface: 'public', url: mock.foreignCatalog ? 'https://evil.example/v2/project-id' : nova }] },
        { type: 'image', endpoints: [{ region: 'SYD1', interface: 'public', url: glance }] },
      ] } }, 201, { 'x-subject-token': 'FAKE-KEYSTONE-TOKEN' });
    }
    if (url.startsWith(nova) || url.startsWith(glance)) assert.equal(options.headers['X-Auth-Token'], 'FAKE-KEYSTONE-TOKEN');
    if (url === `${nova}/servers/detail`) return response({ servers: mock.invisibleCreate ? [] : mock.servers });
    if (url === `${nova}/flavors/detail`) return response({ flavors: [{ id: 'flavor-id', name: 'd2-8' }, { id: 'small', name: 'd2-4' }] });
    if (url === `${glance}/v2/images/image-id`) return response({ id: 'image-id', status: 'active' });
    if (url === `${nova}/servers` && options.method === 'POST') {
      mock.servers.push({ id: 'server-id', name: body.server.name, metadata: body.server.metadata, status: 'ACTIVE', addresses: { public: [{ version: 4, addr: '203.0.113.8' }] } });
      if (mock.lostCreate) { mock.lostCreate = false; throw new Error('FAKE-TRANSPORT-SECRET'); }
      return response({ server: { id: 'server-id' } }, 202);
    }
    if (url === `${nova}/servers/server-id/action`) { assert.deepEqual(body, { 'os-stop': null }); mock.servers[0].status = 'SHUTOFF'; return response(null, 202); }
    if (url === `${nova}/servers/server-id` && options.method === 'DELETE') { mock.servers = []; return response(null, 204); }
    if (url.startsWith(cf)) {
      assert.equal(options.headers.Authorization, 'Bearer FAKE-CLOUDFLARE-TOKEN');
      if (options.method === 'GET') return response({ success: true, result: mock.records, result_info: { total_pages: 1 } });
      if (options.method === 'POST') {
        mock.records.push({ id: 'dns-id', ...body });
        if (mock.lostDns) { mock.lostDns = false; throw new Error('FAKE-DNS-SECRET'); }
        return response({ success: true, result: mock.records[0] });
      }
      if (options.method === 'PUT') { mock.records = [{ id: 'dns-id', ...body }]; return response({ success: true }); }
      if (options.method === 'DELETE') { mock.records = []; return response({ success: true }); }
    }
    if (url.startsWith('https://imperfect.computer/api/accounts/computers')) {
      assert.equal(options.headers.Authorization, 'Bearer FAKE-ACCOUNTS-TOKEN');
      if (options.method === 'GET' && mock.noAccount) return response(null, 404);
      if (options.method === 'POST') { assert.equal(body.computerId, 'alice'); mock.accountState = body.state; mock.noAccount = false; }
      return response(accountRecord());
    }
    if (url === 'https://alice.imperfect.computer/healthz') {
      assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers['X-Auth-Token'], undefined);
      if (mock.healthRedirect) return response(null, 302, { Location: 'https://evil.example' });
      return response(mock.healthBad ? { up: false, version: '1' } : { up: true, version: '1' });
    }
    assert.fail(`Unexpected mocked request ${options.method} ${url}`);
  };
  const options = { prefix, config, fetch, store, now: () => clock, sleep: async ms => { clock += ms; }, out: { write: value => { output += value; } } };
  return { prefix, credentials, config, store, mock, options, file, nova, cf, invoke: (...args) => run(args, options), output: () => output, setClock: value => { clock = value; },
    state: async () => JSON.parse(await readFile(join(prefix, 'provision', 'alice.json'), 'utf8')),
    secrets: async () => JSON.parse(await readFile(join(credentials, 'provision', 'alice.json'), 'utf8')),
    posts: path => mock.calls.filter(c => c.url.endsWith(path) && c.options.method === 'POST') };
}

test('username, command and HTTPS validation fail closed', async () => {
  for (const name of ['noah', 'ab', '-alice', 'alice-', 'Alice', 'a'.repeat(21), '../alice', 'www', 'root']) assert.throws(() => username(name), ProvisionError);
  assert.equal(username('alice-123'), 'alice-123');
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?q=secret', 'https://example.com/#x', 'https://example.com:444']) assert.throws(() => httpsUrl(url), ProvisionError);
  await assert.rejects(run(['deprovision', 'alice', 'purge']), /Usage/);
});

test('dry-run and empty list read neither credentials nor services and make no changes', async t => {
  const f = await fixture(t); await rm(f.credentials, { recursive: true });
  await f.invoke('provision', 'alice', '--dry-run'); await f.invoke('deprovision', 'alice', 'delete', '--dry-run'); await f.invoke('list');
  assert.equal(f.mock.calls.length, 0); assert.equal(f.store.listLicenses().length, 0); assert.deepEqual(await readdir(f.prefix), []); assert.match(f.output(), /no credentials read/);
});

test('provision uses fetch end-to-end, persists only private bootstrap secrets, and is idempotent', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice');
  const state = await f.state(), settings = await f.secrets(), create = f.posts('/servers')[0].body.server;
  assert.equal(state.status, 'ready'); assert.equal(state.ownerAccountId, 'account-alice');
  assert.equal(create.flavorRef, 'small'); assert.equal(state.spec.flavor, 'd2-4'); assert.equal(create.imageRef, 'image-id'); assert.equal(create.config_drive, true); assert.deepEqual(create.networks, [{ uuid: 'network-id' }]);
  assert.equal(create.metadata.imperfect_deployment, state.deploymentId); assert.deepEqual(JSON.parse(Buffer.from(create.user_data, 'base64').toString()), settings);
  assert.deepEqual(Object.keys(settings).sort(), ['version', 'username', 'domain', 'ownerAccountId', 'storePublicKey', 'memberKey', 'supportSshKey', 'oneTimePassword', 'storeUrl'].sort());
  assert.match(settings.oneTimePassword, /^[\w-]{43}$/);
  assert.equal(Object.hasOwn(settings, 'sso'), false); // License fields alone retain PAM.
  assert.equal(f.mock.calls.some(c => c.url.includes('/api/accounts/')), false);
  assert.equal((await stat(join(f.credentials, 'provision', 'alice.json'))).mode & 0o777, 0o600); assert.equal((await stat(join(f.prefix, 'provision'))).mode & 0o777, 0o700);
  const stateText = await readFile(join(f.prefix, 'provision', 'alice.json'), 'utf8');
  for (const secret of [settings.memberKey, settings.oneTimePassword, 'FAKE-OPENSTACK-SECRET', 'alice@example.test']) { assert.ok(!stateText.includes(secret)); assert.ok(!f.output().includes(secret)); }
  assert.equal(f.mock.records[0].proxied, false); assert.match(f.mock.records[0].comment, /^imperfect:/);
  await f.invoke('provision', 'alice'); assert.equal(f.posts('/servers').length, 1); assert.equal(f.posts('/dns_records').length, 1); assert.equal(f.store.listLicenses().length, 1); assert.deepEqual(await f.secrets(), settings);
  await f.invoke('list'); assert.match(f.output(), /alice ready/);
});

test('accounts preferred for owner/key; Nova bootstrap opts into exact registered SSO', async t => {
  const f = await fixture(t, { accounts: true }); f.store.issueLicense({ email: 'alice@example.test' }); f.store.claimHandle(f.store.buyerByEmail('alice@example.test').id, 'alice');
  const registryKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  f.mock.accountOverrides = { publicKey: registryKey };
  f.config.renters = {}; await rm(join(f.credentials, 'accounts-public-key.pem')); await f.invoke('provision', 'alice');
  const settings = await f.secrets(), userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
  assert.equal(settings.storePublicKey, registryKey);
  assert.deepEqual(userData.sso, { storeUrl: 'https://imperfect.computer', computerId: 'alice', ownerAccountId: 'account-alice', storePublicKey: registryKey });
  assert.ok(JSON.stringify(userData) === JSON.stringify(settings));
  assert.match(userData.oneTimePassword, /^[\w-]{43}$/); // Required even though configured SSO disables PAM.
  for (const value of [JSON.stringify(settings), settings.memberKey, settings.oneTimePassword, 'FAKE-ACCOUNTS-TOKEN']) assert.ok(!f.output().includes(value));
  assert.equal(f.mock.accountState, 'ready'); assert.equal(f.posts('/api/accounts/computers').at(-1).body.state, 'ready');
});

test('missing accounts record registers computer id=username and supplies SSO to Nova', async t => {
  const f = await fixture(t, { accounts: true }); f.mock.noAccount = true; await f.invoke('provision', 'alice');
  assert.deepEqual(f.posts('/api/accounts/computers').map(c => c.body.state), ['provisioning', 'ready']);
  const userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
  assert.deepEqual(userData.sso, { storeUrl: 'https://imperfect.computer', computerId: 'alice', ownerAccountId: 'account-alice', storePublicKey: pub });
  await f.invoke('provision', 'alice'); assert.equal(f.posts('/servers').length, 1);
});

test('saved legacy PAM is never upgraded by later registration, before or after Nova intent', async t => {
  for (const stage of ['prepared', 'attempted', 'unresolved', 'ready']) await t.test(stage, async t => {
    const f = await fixture(t);
    if (stage === 'prepared') f.mock.errorPath = '/flavors/detail';
    if (['attempted', 'unresolved'].includes(stage)) f.mock.lostCreate = true;
    if (stage === 'ready') await f.invoke('provision', 'alice');
    else await assert.rejects(f.invoke('provision', 'alice'), /Nova request/);
    const path = join(f.credentials, 'provision', 'alice.json'), saved = await readFile(path, 'utf8');
    assert.equal(Object.hasOwn(JSON.parse(saved), 'sso'), false);
    await f.file('accounts-operator-token', 'FAKE-ACCOUNTS-TOKEN'); f.mock.errorPath = null;
    if (stage === 'unresolved') {
      f.mock.invisibleCreate = true;
      await assert.rejects(f.invoke('provision', 'alice'), /creation unresolved/);
    } else {
      await f.invoke('provision', 'alice'); assert.equal((await f.state()).status, 'ready');
    }
    assert.ok(await readFile(path, 'utf8') === saved);
    assert.equal(f.posts('/servers').length, 1);
    const userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
    assert.equal(Object.hasOwn(userData, 'sso'), false);
    assert.ok(JSON.stringify(userData) === JSON.stringify(JSON.parse(saved)));
    assert.equal(f.store.listLicenses().length, 1);
  });
});

test('saved registered SSO resumes unchanged before creation, after lost response and with existing VM', async t => {
  for (const stage of ['prepared', 'attempted', 'ready']) await t.test(stage, async t => {
    const f = await fixture(t, { accounts: true });
    if (stage === 'prepared') f.mock.errorPath = '/flavors/detail';
    if (stage === 'attempted') f.mock.lostCreate = true;
    if (stage === 'ready') await f.invoke('provision', 'alice');
    else await assert.rejects(f.invoke('provision', 'alice'), /Nova request/);
    const path = join(f.credentials, 'provision', 'alice.json'), saved = await readFile(path, 'utf8');
    assert.ok(JSON.parse(saved).sso);
    f.mock.errorPath = null; await f.invoke('provision', 'alice');
    assert.ok(await readFile(path, 'utf8') === saved);
    assert.equal(f.posts('/servers').length, 1); assert.equal(f.store.listLicenses().length, 1);
    const userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
    assert.ok(JSON.stringify(userData) === JSON.stringify(JSON.parse(saved)));
  });
});

test('saved SSO rejects partial, extra and mismatched fields without replacement or Nova POST', async t => {
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  const cases = {
    null: s => { s.sso = null; }, empty: s => { s.sso = {}; }, array: s => { s.sso = []; },
    'extra nested field': s => { s.sso.extra = 'unused'; },
    'extra root field': s => { s.extra = 'unused'; },
    'foreign store': s => { s.sso.storeUrl = 'https://foreign.example'; },
    'invalid store': s => { s.sso.storeUrl = 'http://imperfect.computer'; },
    'foreign computer': s => { s.sso.computerId = 'bob'; },
    'invalid computer': s => { s.sso.computerId = '../alice'; },
    'foreign owner': s => { s.sso.ownerAccountId = 'account-bob'; },
    'invalid owner': s => { s.sso.ownerAccountId = ''; },
    'foreign key': s => { s.sso.storePublicKey = otherKey; },
    'invalid key': s => { s.sso.storePublicKey = 'not a public key'; },
    'extra PEM data': s => { s.sso.storePublicKey += 'EXTRA'; },
  };
  for (const key of ['storeUrl', 'computerId', 'ownerAccountId', 'storePublicKey']) cases[`missing ${key}`] = s => { delete s.sso[key]; };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
    const f = await fixture(t, { accounts: true }); f.mock.errorPath = '/flavors/detail';
    await assert.rejects(f.invoke('provision', 'alice'), /Nova request/);
    const settings = await f.secrets(); mutate(settings);
    const path = join(f.credentials, 'provision', 'alice.json'), saved = JSON.stringify(settings);
    await writeFile(path, saved, { mode: 0o600 }); f.mock.errorPath = null;
    await assert.rejects(f.invoke('provision', 'alice'), /Saved SSO settings\/registry mismatch|Invalid saved bootstrap/);
    assert.ok(await readFile(path, 'utf8') === saved);
    assert.equal(f.posts('/servers').length, 0); assert.equal(f.store.listLicenses().length, 1);
    assert.ok(!f.output().includes(settings.memberKey)); assert.ok(!f.output().includes(settings.oneTimePassword));
  });
});

test('saved SSO requires authenticated registry and refuses changed authority even for existing VM', async t => {
  for (const change of ['token absent', 'owner', 'key', 'computer', 'store']) await t.test(change, async t => {
    const f = await fixture(t, { accounts: true }); await f.invoke('provision', 'alice');
    const path = join(f.credentials, 'provision', 'alice.json'), saved = await readFile(path, 'utf8');
    if (change === 'token absent') await rm(join(f.credentials, 'accounts-operator-token'));
    if (change === 'owner') f.mock.accountOwner = 'account-bob';
    if (change === 'key') f.mock.accountOverrides = { publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }) };
    if (change === 'computer') f.mock.accountOverrides = { computerId: 'bob' };
    if (change === 'store') f.mock.accountOverrides = { store: 'https://foreign.example' };
    await assert.rejects(f.invoke('provision', 'alice'), /Saved SSO settings\/registry mismatch|Accounts owner changed|Accounts public key changed|Accounts computer identity mismatch/);
    assert.ok(await readFile(path, 'utf8') === saved);
    assert.equal(f.posts('/servers').length, 1); assert.equal(f.store.listLicenses().length, 1);
  });
});

test('accounts owner collision refuses provisioning rather than trusting config', async t => {
  const f = await fixture(t, { accounts: true }); f.mock.accountOwner = 'foreign-owner'; await assert.rejects(f.invoke('provision', 'alice'), /owner mismatch/);
  assert.equal(f.posts('/servers').length, 0); assert.equal(f.store.listLicenses().length, 0);
});

test('explicit email mapping required when accounts have no matching buyer handle', async t => {
  const f = await fixture(t, { accounts: true }); delete f.config.renters.alice.email; await assert.rejects(f.invoke('provision', 'alice'), /buyer email/); assert.equal(f.posts('/servers').length, 0);
});

test('lost Nova POST response reconciles exact metadata, never creates twice', async t => {
  const f = await fixture(t); f.mock.lostCreate = true; await assert.rejects(f.invoke('provision', 'alice'), /Nova request failed/);
  const settings = await f.secrets(); assert.equal((await f.state()).createAttempted, true); await f.invoke('provision', 'alice');
  assert.equal(f.posts('/servers').length, 1); assert.equal((await f.state()).status, 'ready'); assert.deepEqual(await f.secrets(), settings);
});

test('invisible ambiguous Nova creation is blocked across retries', async t => {
  const f = await fixture(t); f.mock.lostCreate = true; f.mock.invisibleCreate = true; await assert.rejects(f.invoke('provision', 'alice'), /request failed/);
  await assert.rejects(f.invoke('provision', 'alice'), /creation unresolved/); assert.equal(f.posts('/servers').length, 1);
});

test('successful POST with not-yet-visible inventory times out without a duplicate', async t => {
  const f = await fixture(t); f.mock.invisibleCreate = true; await assert.rejects(f.invoke('provision', 'alice'), /readiness timed out/);
  await assert.rejects(f.invoke('provision', 'alice'), /creation unresolved/); assert.equal(f.posts('/servers').length, 1);
  f.mock.invisibleCreate = false; await f.invoke('provision', 'alice'); assert.equal(f.posts('/servers').length, 1);
});

test('lost Cloudflare POST response recovers owned comment without duplicate records', async t => {
  const f = await fixture(t); f.mock.lostDns = true; await assert.rejects(f.invoke('provision', 'alice'), /Cloudflare request failed/); await f.invoke('provision', 'alice');
  assert.equal(f.posts('/dns_records').length, 1); assert.equal(f.posts('/servers').length, 1);
});

test('ambiguous DNS POST that remains invisible cannot be repeated', async t => {
  const f = await fixture(t); f.mock.lostDns = true; await assert.rejects(f.invoke('provision', 'alice'), /request failed/); f.mock.records = [];
  await assert.rejects(f.invoke('provision', 'alice'), /DNS creation unresolved/); assert.equal(f.posts('/dns_records').length, 1);
});

test('foreign instance and DNS names deny collisions before licenses or VM mutation', async t => {
  for (const kind of ['instance', 'dns']) {
    const f = await fixture(t);
    if (kind === 'instance') f.mock.servers = [{ id: 'foreign', name: 'imperfect-alice', metadata: {}, status: 'ACTIVE' }];
    else f.mock.records = [{ id: 'foreign', name: 'alice.imperfect.computer', type: 'A', comment: 'foreign', content: '203.0.113.9' }];
    await assert.rejects(f.invoke('provision', 'alice'), /Foreign/); assert.equal(f.posts('/servers').length, 0); assert.equal(f.store.listLicenses().length, 0);
  }
});

test('stop requires retained ownership and foreign instance replacement is never changed', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); f.mock.servers[0].metadata = {};
  await assert.rejects(f.invoke('deprovision', 'alice', 'stop'), /Foreign instance/); assert.equal(f.posts('/action').length, 0);
});

test('stop retains 30 days, repeated stops do not extend deadline, delete revokes only computer key', async t => {
  const f = await fixture(t, { accounts: true }), own = f.store.issueLicense({ email: 'alice@example.test' }); await f.invoke('provision', 'alice'); const secrets = await f.secrets();
  await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /Retention/); await f.invoke('deprovision', 'alice', 'stop');
  const stopped = await f.state(); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.deleteAfter - stopped.stoppedAt, 30 * DAY); assert.equal(f.mock.accountState, 'stopped'); assert.equal(f.mock.records.length, 0);
  f.setClock(stopped.stoppedAt + DAY); await f.invoke('deprovision', 'alice', 'stop'); assert.equal((await f.state()).deleteAfter, stopped.deleteAfter); assert.equal(f.posts('/action').length, 1);
  assert.equal(f.store.activeLicense(secrets.memberKey).status, 'active'); await assert.rejects(f.invoke('provision', 'alice'), /Stopped computer/); await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /Retention/);
  f.setClock(stopped.deleteAfter); await f.invoke('deprovision', 'alice', 'delete'); assert.equal((await f.state()).status, 'deleted'); assert.equal(f.mock.servers.length, 0);
  assert.equal(f.store.license(secrets.memberKey).status, 'revoked'); assert.equal(f.store.license(own.key).status, 'active'); await assert.rejects(readFile(join(f.credentials, 'provision', 'alice.json')), /ENOENT/);
  await f.invoke('deprovision', 'alice', 'delete'); assert.equal(f.mock.calls.filter(c => c.options.method === 'DELETE' && c.url.includes('/servers/')).length, 1); await assert.rejects(f.invoke('provision', 'alice'), /Deleted username/);
});

test('running retained instance cannot be deleted even after deadline', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); await f.invoke('deprovision', 'alice', 'stop'); f.setClock((await f.state()).deleteAfter); f.mock.servers[0].status = 'ACTIVE';
  await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /Instance is running/); assert.equal(f.mock.calls.filter(c => c.options.method === 'DELETE' && c.url.includes('/servers/')).length, 0);
});

test('strict TLS door readiness does not mark ready on bad health or redirect', async t => {
  for (const failure of ['healthBad', 'healthRedirect']) {
    const f = await fixture(t); f.mock[failure] = true; await assert.rejects(f.invoke('provision', 'alice'), /Door TLS readiness timed out/); assert.equal((await f.state()).status, 'provisioning');
    f.mock[failure] = false; await f.invoke('provision', 'alice'); assert.equal((await f.state()).status, 'ready');
  }
});

test('catalog endpoint allowlist and HTTPS config prevent credentials reaching arbitrary services', async t => {
  const f = await fixture(t); f.mock.foreignCatalog = true; await assert.rejects(f.invoke('provision', 'alice'), /not allowlisted/); assert.equal(f.mock.calls.length, 1);
  f.config.storeUrl = 'http://imperfect.computer'; await assert.rejects(f.invoke('provision', 'alice'), /Invalid HTTPS/); assert.equal(f.mock.calls.length, 1);
});

test('raw API/transport errors never escape with secrets', async t => {
  const f = await fixture(t); f.mock.errorPath = '/auth/tokens';
  await assert.rejects(f.invoke('provision', 'alice'), e => e instanceof ProvisionError && !e.message.includes('FAKE') && /HTTP 403/.test(e.message)); assert.ok(!f.output().includes('FAKE'));
});

test('credential safety requires 0600 regular files and rejects symlinks', async t => {
  for (const name of ['ovh-openstack.json', 'cloudflare-api-token', 'accounts-operator-token']) { const f = await fixture(t, { accounts: true }); await chmod(join(f.credentials, name), 0o644); await assert.rejects(f.invoke('provision', 'alice'), /Unsafe provisioning file/); }
  const f = await fixture(t); await rm(join(f.credentials, 'cloudflare-api-token')); await symlink(join(f.credentials, 'ovh-openstack.json'), join(f.credentials, 'cloudflare-api-token')); await assert.rejects(f.invoke('provision', 'alice'), /missing or unsafe/);
});

test('alternate Cloudflare filename works without reading unrelated credentials', async t => {
  const f = await fixture(t); await rm(join(f.credentials, 'cloudflare-api-token')); await f.file('cloudflare-token', 'FAKE-CLOUDFLARE-TOKEN'); await f.invoke('provision', 'alice'); assert.equal((await f.state()).status, 'ready');
});

test('lock excludes concurrent operators, and stale locks fail closed', async t => {
  const f = await fixture(t), dir = join(f.prefix, 'provision'); await withLock(dir, async () => { await assert.rejects(f.invoke('provision', 'alice'), /locked/); });
  await writeFile(join(dir, 'operator.lock'), '999999999\n', { mode: 0o600 }); await assert.rejects(f.invoke('provision', 'alice'), /After a crash/); assert.equal(f.mock.calls.length, 0);
});

test('state/spec changes and missing bootstrap secrets cannot silently replace a VM', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); f.config.imageId = 'different-image'; await assert.rejects(f.invoke('provision', 'alice'), /state\/config mismatch/);
  f.config.imageId = 'image-id'; await rm(join(f.credentials, 'provision', 'alice.json')); await assert.rejects(f.invoke('provision', 'alice'), /Bootstrap secrets missing/); assert.equal(f.posts('/servers').length, 1);
});

test('revoked per-computer license and changed buyer cannot be replaced on retry', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); f.config.renters.alice.email = 'other@example.test'; await assert.rejects(f.invoke('provision', 'alice'), /buyer changed/);
  f.config.renters.alice.email = 'alice@example.test'; f.store.revokeLicense((await f.secrets()).memberKey); await assert.rejects(f.invoke('provision', 'alice'), /missing or revoked/); assert.equal(f.store.listLicenses().length, 1);
});

test('inventory pagination discovers foreign collisions; unsafe next links never receive tokens', async t => {
  for (const unsafe of [false, true]) {
    const f = await fixture(t), original = f.options.fetch;
    f.options.fetch = async (url, options) => {
      if (url === `${f.nova}/servers/detail`) return response({ servers: [], servers_links: [{ rel: 'next', href: unsafe ? 'https://evil.example/servers/detail' : `${f.nova}/servers/detail?marker=1` }] });
      if (url === `${f.nova}/servers/detail?marker=1`) return response({ servers: [{ name: 'imperfect-alice', id: 'foreign', metadata: {} }] });
      return original(url, options);
    };
    await assert.rejects(f.invoke('provision', 'alice'), unsafe ? /Unsafe OpenStack pagination/ : /Foreign instance/); assert.equal(f.posts('/servers').length, 0);
  }
});

test('foreign DNS collision on a later page is denied', async t => {
  const f = await fixture(t), original = f.options.fetch;
  f.options.fetch = async (url, options) => {
    if (url.startsWith(f.cf) && options.method === 'GET') return response({ success: true, result: new URL(url).searchParams.get('page') === '1' ? [] : [{ id: 'foreign', type: 'CNAME', name: 'alice.imperfect.computer' }], result_info: { total_pages: 2 } });
    return original(url, options);
  };
  await assert.rejects(f.invoke('provision', 'alice'), /Foreign DNS/); assert.equal(f.posts('/servers').length, 0);
});

test('duplicate owned metadata and DNS records are rejected', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); f.mock.servers.push({ ...f.mock.servers[0], id: 'duplicate' });
  await assert.rejects(f.invoke('provision', 'alice'), /Multiple owned instances/); f.mock.servers.pop(); f.mock.records.push({ ...f.mock.records[0], id: 'duplicate' });
  await assert.rejects(f.invoke('provision', 'alice'), /Multiple DNS records/);
});

test('owned DNS may update its IP/proxy but foreign comments cannot be adopted', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); f.mock.records[0].content = '203.0.113.9'; f.mock.records[0].proxied = true; await f.invoke('provision', 'alice');
  assert.equal(f.mock.records[0].content, '203.0.113.8'); assert.equal(f.mock.records[0].proxied, false); assert.equal(f.mock.calls.filter(c => c.options.method === 'PUT').length, 1);
  f.mock.records[0].comment = ''; await assert.rejects(f.invoke('provision', 'alice'), /Foreign DNS/);
});

test('accounts response identity and Keystone project are validated strictly', async t => {
  for (const kind of ['origin', 'project']) {
    const f = await fixture(t, { accounts: true }), original = f.options.fetch;
    f.options.fetch = async (url, options) => {
      const result = await original(url, options);
      if ((kind === 'origin' && url.includes('/api/accounts/')) || (kind === 'project' && url.endsWith('/auth/tokens'))) {
        const body = await result.json(); if (kind === 'origin') body.origin = 'https://foreign.imperfect.computer'; else body.token.project.id = 'foreign-project';
        return response(body, result.status, result.headers);
      }
      return result;
    };
    await assert.rejects(f.invoke('provision', 'alice'), /identity mismatch|project\/token mismatch/); assert.equal(f.posts('/servers').length, 0);
  }
});

test('invalid bootstrap public keys fail before member key issuance', async t => {
  for (const file of ['accounts-public-key.pem', 'ovh-cloud-ssh.pub']) {
    const f = await fixture(t); await f.file(file, file.endsWith('.pub') ? 'ssh-ed25519 AAAA invalid' : 'not a PEM public key');
    await assert.rejects(f.invoke('provision', 'alice'), /Invalid .*public key/); assert.equal(f.posts('/servers').length, 0); assert.equal(f.store.listLicenses().length, 0);
  }
});

test('project-scoped password fallback works and mixed credential modes fail closed', async t => {
  const f = await fixture(t); f.mock.authMethod = 'password';
  await f.file('ovh-openstack.json', { username: 'compute-user', password: 'FAKE-SCOPED-PASSWORD', projectId: 'project-id', userDomainName: 'Default' });
  await f.invoke('provision', 'alice'); assert.equal((await f.state()).status, 'ready');
  await f.file('ovh-openstack.json', { applicationCredentialId: 'app-id', applicationCredentialSecret: 'FAKE-SECRET', username: 'compute-user', password: 'FAKE-SCOPED-PASSWORD' });
  await assert.rejects(f.invoke('provision', 'alice'), /mixed OpenStack/);
});

test('lost deletion response recovers without another delete and revokes key even when local bootstrap was removed', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); const key = (await f.secrets()).memberKey;
  await f.invoke('deprovision', 'alice', 'stop'); f.setClock((await f.state()).deleteAfter);
  const original = f.options.fetch;
  f.options.fetch = async (url, options) => {
    const result = await original(url, options);
    if (url.endsWith('/servers/server-id') && options.method === 'DELETE') throw new Error('FAKE-DELETE-SECRET');
    return result;
  };
  await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /Nova request failed/);
  assert.equal((await f.state()).status, 'stopped'); await rm(join(f.credentials, 'provision', 'alice.json'));
  await f.invoke('deprovision', 'alice', 'delete'); assert.equal((await f.state()).status, 'deleted'); assert.equal(f.store.license(key).status, 'revoked');
  assert.equal(f.mock.calls.filter(c => c.options.method === 'DELETE' && c.url.includes('/servers/')).length, 1);
});

test('accounts ownership mismatch blocks stop before any Nova action', async t => {
  const f = await fixture(t, { accounts: true }); await f.invoke('provision', 'alice'); f.mock.accountOwner = 'foreign-owner';
  await assert.rejects(f.invoke('deprovision', 'alice', 'stop'), /owner changed/); assert.equal(f.posts('/action').length, 0);
});

test('image/network defaults can rotate without blocking retirement of older computers', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice');
  const original = (await f.state()).spec;
  f.config.imageId = 'next-image'; f.config.networkId = 'next-network'; f.config.securityGroupNames = ['new-renter'];
  await f.invoke('deprovision', 'alice', 'stop');
  assert.deepEqual((await f.state()).spec, original);
  f.setClock((await f.state()).deleteAfter); await f.invoke('deprovision', 'alice', 'delete');
  assert.equal((await f.state()).status, 'deleted'); assert.equal(f.posts('/servers').length, 1);
});

test('changed authenticated project refuses all existing deployment mutations', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice');
  assert.equal((await f.state()).projectId, 'project-id');
  await f.file('ovh-openstack.json', { applicationCredentialId: 'app-id', applicationCredentialSecret: 'FAKE-SECRET', projectId: 'other-project' });
  const original = f.options.fetch, before = f.mock.calls.length;
  f.options.fetch = async (url, options) => {
    const result = await original(url, options);
    if (url.endsWith('/auth/tokens')) {
      const data = await result.json(); data.token.project.id = 'other-project';
      data.token.catalog[0].endpoints[0].url = 'https://compute.syd1.cloud.ovh.net/v2/other-project';
      return response(data, 201, result.headers);
    }
    return result;
  };
  await assert.rejects(f.invoke('deprovision', 'alice', 'stop'), /Deployment project mismatch/);
  assert.equal(f.mock.calls.length, before + 1); assert.equal((await f.state()).projectId, 'project-id');
});

test('resumed retention resets before uncertain stop, never allowing early deletion', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); await f.invoke('deprovision', 'alice', 'stop');
  const old = await f.state(); f.setClock(old.stoppedAt + 29 * DAY); f.mock.servers[0].status = 'ACTIVE';
  const original = f.options.fetch; let lose = true;
  f.options.fetch = async (url, options) => {
    const result = await original(url, options);
    if (url.endsWith('/action') && lose) { lose = false; throw new Error('FAKE-LOST-STOP'); }
    return result;
  };
  await assert.rejects(f.invoke('deprovision', 'alice', 'stop'), /Nova request failed/);
  assert.equal((await f.state()).deleteAfter, undefined);
  await f.invoke('deprovision', 'alice', 'stop');
  const latest = await f.state(); assert.equal(latest.deleteAfter, old.stoppedAt + 59 * DAY);
  f.setClock(old.deleteAfter); await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /Retention/);
});

test('confirmed DNS record loss is safely repaired, unlike an ambiguous POST', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice');
  assert.equal((await f.state()).dnsCreateAttempted, false); f.mock.records = [];
  await f.invoke('provision', 'alice'); assert.equal(f.posts('/dns_records').length, 2);
  assert.equal(f.posts('/servers').length, 1); assert.equal(f.mock.records.length, 1);
});

test('license revocation failure never finalizes retirement and retry repairs it', async t => {
  const f = await fixture(t); await f.invoke('provision', 'alice'); const key = (await f.secrets()).memberKey;
  await f.invoke('deprovision', 'alice', 'stop'); f.setClock((await f.state()).deleteAfter);
  const revoke = f.store.revokeLicense; f.store.revokeLicense = () => null;
  await assert.rejects(f.invoke('deprovision', 'alice', 'delete'), /revocation failed/);
  assert.equal((await f.state()).status, 'stopped'); assert.equal(f.store.license(key).status, 'active');
  f.store.revokeLicense = revoke; await f.invoke('deprovision', 'alice', 'delete');
  assert.equal((await f.state()).status, 'deleted'); assert.equal(f.store.license(key).status, 'revoked');
});

test('extra PEM data is rejected before issuing or submitting bootstrap credentials', async t => {
  const f = await fixture(t); await f.file('accounts-public-key.pem', pub + 'EXTRA-PRIVATE-DATA');
  await assert.rejects(f.invoke('provision', 'alice'), /single SPKI PEM block/);
  assert.equal(f.store.listLicenses().length, 0); assert.equal(f.posts('/servers').length, 0);
  await f.file('accounts-public-key.pem', pub.replace(/\n/g, '\r\n').trim());
  await f.invoke('provision', 'alice'); assert.equal((await f.secrets()).storePublicKey, pub);
});

test('accounts infrastructure names and malformed saved settings fail closed', async t => {
  for (const name of ['login', 'checkout', 'ns1', 'autodiscover', 'community', 'staging', 'payments']) assert.throws(() => username(name), ProvisionError);
  const f = await fixture(t); f.config.securityGroupNames = ['renter-web']; await f.invoke('provision', 'alice');
  assert.deepEqual(f.posts('/servers')[0].body.server.security_groups, [{ name: 'renter-web' }]);
  const settings = await f.secrets(); settings.unexpected = 'unused';
  await writeFile(join(f.credentials, 'provision', 'alice.json'), JSON.stringify(settings), { mode: 0o600 });
  await assert.rejects(f.invoke('provision', 'alice'), /Invalid saved bootstrap/);
  assert.equal(f.posts('/servers').length, 1);
});

test('flavor defaults to d2-4, is configurable per deployment and per renter, and is validated', async t => {
  const f = await fixture(t); f.config.flavor = 'd2-8'; await f.invoke('provision', 'alice');
  assert.equal(f.posts('/servers')[0].body.server.flavorRef, 'flavor-id');
  const g = await fixture(t); g.config.renters.alice.flavor = 'd2-8'; await g.invoke('provision', 'alice', '--dry-run');
  assert.match(g.output(), /SYD1 d2-8/);
  for (const bad of ['', 'D2-4', 'd2 4', 7]) {
    const h = await fixture(t); h.config.flavor = bad;
    await assert.rejects(h.invoke('provision', 'alice', '--dry-run'), /Invalid flavor/);
  }
});

test('cloudflareTokenFile selects the zone-only DNS token', async t => {
  const f = await fixture(t); await f.file('cloudflare-zone-token', 'FAKE-CLOUDFLARE-TOKEN'); await f.file('cloudflare-api-token', 'WRONG-BROAD-TOKEN');
  f.config.cloudflareTokenFile = 'cloudflare-zone-token'; await f.invoke('provision', 'alice');
  assert.equal((await f.state()).status, 'ready');
  const g = await fixture(t); g.config.cloudflareTokenFile = '../cloudflare-api-token';
  await assert.rejects(g.invoke('provision', 'alice', '--dry-run'), /Invalid cloudflareTokenFile/);
});

test('dry-run names missing credential files without reading them', async t => {
  const f = await fixture(t); await rm(join(f.credentials, 'ovh-openstack.json')); delete f.config.renters.alice.email;
  await f.invoke('provision', 'alice', '--dry-run');
  assert.match(f.output(), /SYD1 d2-4/); assert.match(f.output(), /missing credentials: ovh-openstack.json\n/); assert.match(f.output(), /needs renters.alice.email/);
  assert.equal(f.mock.calls.length, 0); assert.doesNotMatch(f.output(), /FAKE/);
});

test('CLI dry-run works with config only and never creates store DB', async t => {
  const f = await fixture(t), home = join(f.prefix, 'fake-home'), prefix = join(home, '.imperfect');
  await mkdir(join(prefix, 'credentials'), { recursive: true, mode: 0o700 }); await writeFile(join(prefix, 'credentials', 'provision.json'), JSON.stringify(f.config), { mode: 0o600 });
  const child = spawnSync(process.execPath, [new URL('../tools/provision.mjs', import.meta.url).pathname, 'provision', 'alice', '--dry-run'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /dry-run/); assert.deepEqual(await readdir(prefix), ['credentials']);
  const insecure = spawnSync(process.execPath, [new URL('../tools/provision.mjs', import.meta.url).pathname, 'provision', 'alice', '--dry-run'], { env: { ...process.env, HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, encoding: 'utf8' });
  assert.equal(insecure.status, 2); assert.match(insecure.stderr, /TLS certificate verification/);
  const missingStore = spawnSync(process.execPath, [new URL('../tools/provision.mjs', import.meta.url).pathname, 'provision', 'alice'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(missingStore.status, 2); assert.match(missingStore.stderr, /existing owned local store/); assert.deepEqual(await readdir(prefix), ['credentials']);
});

test('the locker runs its own registry: no operator token, exact SSO, and assertions the door can verify', async t => {
  const f = await fixture(t);
  const account = f.store.createAccount({ username: 'alice', name: 'Alice', passwordHash: 'disposable-store-fixture-hash', email: 'alice@example.test' });
  f.config.renters = { alice: { email: 'alice@example.test', ownerAccountId: account.id } };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signerPem = publicKey.export({ format: 'pem', type: 'spki' });
  const registry = localRegistry({ store: f.store, storeUrl: 'https://imperfect.computer', publicKey: signerPem });
  await run(['provision', 'alice'], { ...f.options, registry });
  const userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
  assert.deepEqual(userData.sso, { storeUrl: 'https://imperfect.computer', computerId: 'alice', ownerAccountId: account.id, storePublicKey: signerPem });
  assert.equal(f.mock.calls.some(c => c.url.includes('/api/accounts/')), false);
  assert.equal(f.store.computerByUsername('alice').state, 'ready');
  const accounts = createAccounts({ store: f.store, config: { base: 'https://imperfect.computer', signerPrivateKey: privateKey } });
  const nonce = randomBytes(32).toString('base64url');
  const assertion = accounts.issueAssertion({ computer: f.store.computerByUsername('alice'), account: f.store.account(account.id), nonce });
  const [header, payload, signature] = assertion.split('.');
  assert.equal(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey(userData.sso.storePublicKey), Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual([claims.iss, claims.aud, claims.sub, claims.nonce], ['https://imperfect.computer', 'alice', account.id, nonce]);
  await run(['deprovision', 'alice', 'stop'], { ...f.options, registry });
  assert.equal(f.store.computerByUsername('alice').state, 'stopped');
  assert.throws(() => accounts.issueAssertion({ computer: f.store.computerByUsername('alice'), account: f.store.account(account.id), nonce }), /not available/);
});

test('the rental sync makes the computer through the real provisioner, with no operator token', async t => {
  const f = await fixture(t);
  const account = f.store.createAccount({ username: 'alice', name: 'Alice', passwordHash: 'disposable-store-fixture-hash', email: 'alice@example.test' });
  f.store.saveRental({ accountId: account.id, source: 'tester', status: 'active', startedAt: 1 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signerPem = publicKey.export({ format: 'pem', type: 'spki' });
  const sent = [];
  const summary = await syncOnce({ store: f.store, config: { ...f.config, renters: {} }, base: 'https://imperfect.computer', mail: { send: async m => { sent.push(m); return { delivered: true }; } },
    prefix: f.prefix, signerPem, out: { write: value => f.options.out.write(value) }, now: f.options.now, sleep: f.options.sleep, fetch: f.options.fetch });
  assert.deepEqual(summary, { provisioned: 1, stopped: 0, skipped: 0, failed: 0 });
  const userData = JSON.parse(Buffer.from(f.posts('/servers')[0].body.server.user_data, 'base64').toString());
  assert.equal(f.posts('/servers')[0].body.server.flavorRef, 'flavor-id'); // d2-8 for a tester
  assert.equal(userData.sso.ownerAccountId, account.id);
  assert.equal(userData.sso.storePublicKey, signerPem);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'alice@example.test');
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
});
