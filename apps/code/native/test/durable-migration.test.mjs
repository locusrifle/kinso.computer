import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTabHost } from '../tabs.mjs';
import { listPiSessions } from '../runtime.mjs';
import { readDurableArchive } from '../durable-archive.mjs';
import { fixture } from './durable-fixture.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const picture = { type: 'image', mimeType: 'image/png', data: 'AAEC/+==' };
const jsonl = rows => Buffer.from(rows.map(row => ` ${JSON.stringify(row)} `).join('\r\n') + '\r\n');
const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp, message: { role: 'user', content: [{ type: 'text', text }, picture], timestamp: 1 } });
function classic(cwd, id) {
  return jsonl([
    { type: 'session', version: 3, id, cwd, timestamp, opaqueHeader: { preserved: true } },
    user('root', null, `${id}: original words — café`),
    user('abandoned', 'root', 'abandoned branch is still archived'),
    user('kept', 'root', `${id}: selected branch`),
    { type: 'custom', id: 'opaque', parentId: 'kept', timestamp, customType: 'fixture', data: { nested: ['do not drop me'] } },
    { type: 'model_change', id: 'model', parentId: 'opaque', timestamp, provider: 'openai-codex', modelId: 'gpt-6.1-sol' },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp, thinkingLevel: 'high' },
    { type: 'session_info', id: 'name', parentId: 'thinking', timestamp, name: `${id} saved name` },
  ]);
}

async function environment(t) {
  const dir = await mkdtemp(join(tmpdir(), 'durable-first-start-'));
  const agentDir = join(dir, 'agent'), stateDir = join(dir, 'state'), sessionDir = join(stateDir, 'sessions');
  const hosts = [], opened = [], attempts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    for (const item of opened) await item.runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(sessionDir, { recursive: true });
  const make = async options => {
    attempts.push(options.sessionPath);
    const item = await fixture(t, { dir, agentDir, sessionDir, ...options });
    opened.push(item);
    return item.runtime;
  };
  const start = async (options = {}) => {
    const host = await createTabHost({ cwd: dir, agentDir, sessionDir, stateDir, createRuntime: make,
      claudeAvailable: () => false, codexAvailable: () => false, ...options });
    hosts.push(host);
    return host;
  };
  const save = rows => writeFile(join(stateDir, 'open-tabs.json'), JSON.stringify(rows));
  const put = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); return path; };
  return { dir, agentDir, stateDir, sessionDir, opened, attempts, start, save, put };
}

// No SessionManager.open/create and no preparatory cutover: these are the files
// an untouched Classic installation supplies to its first Durable launch.
test('fresh launch imports saved Classic tabs, lists unopened histories lazily, and restarts with the same identities', async t => {
  const e = await environment(t);
  const laptop = await e.put(join(e.sessionDir, 'laptop.jsonl'), classic(e.dir, 'laptop-id'));
  const mac = await e.put(join(e.agentDir, 'sessions', '--Users-noah-workbench--', 'mac.jsonl'), classic(e.dir, 'mac-id'));
  const archived = await e.put(join(e.stateDir, 'sessions-from-the-other-runtime', '--old-workspace--', 'old.jsonl'), jsonl([
    { type: 'session', version: 1, id: 'old-id', cwd: e.dir, timestamp },
    { type: 'message', timestamp, message: { role: 'user', content: 'old v1 words', timestamp: 1 } },
  ]));
  const originals = new Map(await Promise.all([laptop, mac, archived].map(async path => [path, await readFile(path)])));
  await symlink(e.sessionDir, join(e.agentDir, 'sessions', 'alias-to-custom'));
  const alias = join(e.sessionDir, 'laptop-alias.jsonl'); await symlink(laptop, alias);
  // The oldest mapping had no harness field. Both forms must restore Pi.
  await e.save([{ session: laptop, cwd: e.dir, empty: false }, { agent: 'pi', session: mac, cwd: e.dir, focused: true, empty: false }]);
  const host = await e.start();
  assert.deepEqual(e.attempts, [laptop, mac], 'only the saved tabs instantiate runtimes');
  assert.equal(host.snapshot().sessionId, 'mac-id');
  assert.equal(host.snapshot().level, 'high');
  assert.deepEqual(host.snapshot().tabs.map(tab => [tab.sessionId, tab.sessionFile]), [
    ['laptop-id', `${laptop}.durable.sqlite`], ['mac-id', `${mac}.durable.sqlite`],
  ]);
  assert.equal(host.snapshot().name, 'mac-id saved name');
  for (const path of [laptop, mac]) {
    const archive = readDurableArchive(`${path}.durable.sqlite`);
    assert.equal(archive.entries.filter(entry => entry.kind === 'imperfect.legacy').length, 1);
    assert.equal(archive.entries.find(entry => entry.kind === 'imperfect.legacy').data.source, originals.get(path).toString());
    assert.ok(archive.entries.find(entry => entry.kind === 'imperfect.legacy').data.entries.some(entry => entry.id === 'abandoned'));
    assert.deepEqual(archive.messages.find(message => message.role === 'user').content[1], picture);
    assert.ok(!JSON.stringify(archive.messages).includes('abandoned branch is still archived'));
  }
  let rows = await host.command({ type: 'sessions' });
  assert.equal(rows.length, 3, 'no original/sidecar or symlink aliases in the sidebar');
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set(['laptop-id', 'mac-id', 'old-id']));
  assert.equal(rows.find(row => row.id === 'old-id').path, archived);
  assert.equal(await stat(`${archived}.durable.sqlite`).catch(() => null), null, 'listing does not mass-import histories');
  assert.equal(e.attempts.length, 2);
  const [a, b] = await Promise.all([
    host.command({ type: 'tab-open', agent: 'pi', path: alias }),
    host.command({ type: 'tab-open', agent: 'pi', path: `${laptop}.durable.sqlite` }),
  ]);
  assert.equal(a.id, b.id); assert.equal(e.attempts.length, 2);
  await host.command({ type: 'tab-open', agent: 'pi', path: archived });
  assert.equal(host.snapshot().sessionId, 'old-id');
  assert.match(JSON.stringify(host.snapshot().messages), /old v1 words/);
  rows = await host.command({ type: 'sessions' });
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.path.endsWith('.sqlite')));
  const before = host.snapshot().tabs.map(({ sessionId, sessionFile, name }) => ({ sessionId, sessionFile, name }));
  const transcripts = new Map(before.map(row => [row.sessionId, readDurableArchive(row.sessionFile).messages]));
  await host.command({ type: 'tab-focus', tabId: host.snapshot().tabs.find(tab => tab.sessionId === 'mac-id').id });
  await host.close();
  const saved = JSON.parse(await readFile(join(e.stateDir, 'open-tabs.json'), 'utf8'));
  assert.equal(saved.length, 3); assert.ok(saved.every(row => row.session.endsWith('.sqlite')));
  // An older/stale mapping may still name Classic, or name both aliases.
  // Reopening unchanged sources must reuse the committed import, not append it.
  await e.save([{ agent: 'pi', session: laptop, empty: false },
    { agent: 'pi', session: `${laptop}.durable.sqlite`, empty: false }, ...saved.slice(1)]);
  const restarted = await e.start();
  assert.equal(restarted.snapshot().sessionId, 'mac-id');
  assert.equal(restarted.snapshot().level, 'high');
  assert.deepEqual(restarted.snapshot().tabs.map(({ sessionId, sessionFile, name }) => ({ sessionId, sessionFile, name })), before);
  for (const row of before) {
    const archive = readDurableArchive(row.sessionFile);
    assert.deepEqual(archive.messages, transcripts.get(row.sessionId));
    assert.equal(archive.entries.filter(entry => entry.kind === 'imperfect.legacy').length, 1);
  }
  assert.equal((await restarted.command({ type: 'sessions' })).length, 3);
  assert.ok(e.opened.every(item => item.seen.length === 0), 'migration/restart makes no provider request or replay');
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes, path);
});

test('discovery includes flat and cwd-grouped runtime archives without merging distinct files by session id', async t => {
  const e = await environment(t);
  const files = [
    join(e.sessionDir, 'direct.jsonl'),
    join(e.sessionDir, '--custom-group--', 'nested.jsonl'),
    join(e.agentDir, 'sessions-from-the-other-runtime', 'flat.jsonl'),
    join(e.agentDir, 'sessions-from-the-other-runtime', '--old-cwd--', 'nested.jsonl'),
  ];
  for (const path of files) await e.put(path, classic(e.dir, 'same-id-but-distinct-branches'));
  const rows = await listPiSessions(e);
  assert.deepEqual(new Set(rows.map(row => row.path)), new Set(files));
  assert.equal(e.attempts.length, 0);
  for (const path of files) assert.equal(await stat(`${path}.durable.sqlite`).catch(() => null), null);
});

test('first-start saved tabs refuse missing, malformed, unsupported, or ambiguous sources without a fresh replacement', async t => {
  const header = { type: 'session', version: 3, id: 'invalid', timestamp };
  const cases = [
    ['missing', null],
    ['empty', Buffer.alloc(0)],
    ['truncated', Buffer.from('{"type":"session"')],
    ['invalid-utf8', Buffer.from([0xff, 0xfe])],
    ['unsupported', cwd => jsonl([{ ...header, cwd, version: 99 }])],
    ['orphan', cwd => jsonl([{ ...header, cwd }, user('one', 'missing', 'never import')])],
    ['duplicate', cwd => jsonl([{ ...header, cwd }, user('one', null, 'first'), user('one', null, 'second')])],
  ];
  for (const [name, source] of cases) await t.test(name, async t => {
    const e = await environment(t), path = join(e.sessionDir, `${name}.jsonl`);
    const bytes = typeof source === 'function' ? source(e.dir) : source;
    if (bytes !== null) await e.put(path, bytes);
    const row = { agent: 'pi', session: path, cwd: e.dir, empty: false, focused: true };
    await e.save([row]);
    const host = await e.start();
    assert.deepEqual(e.attempts, [path], 'no automatic fresh runtime after refusal');
    assert.deepEqual(host.snapshot().tabs, []);
    assert.equal(host.snapshot().handoff.recovery[0].session, path);
    assert.ok(host.snapshot().handoff.recovery[0].error);
    host.requestQuiesce(); await assert.rejects(host.waitForIdle(), /restore failed; handoff held/);
    assert.equal(await stat(`${path}.durable.sqlite`).catch(() => null), null);
    if (bytes !== null) assert.deepEqual(await readFile(path), bytes);
    const saved = JSON.parse(await readFile(join(e.stateDir, 'open-tabs.json'), 'utf8'));
    assert.deepEqual(saved.map(({ restoreError, ...saved }) => saved), [row]);
    assert.ok(saved[0].restoreError);
    await host.close();
    const restarted = await e.start();
    assert.deepEqual(e.attempts, [path, path]);
    assert.equal(restarted.snapshot().handoff.recovery.length, 1);
    assert.deepEqual(restarted.snapshot().tabs, []);
  });
});

test('a Classic source changed after import is refused before writing its existing sidecar', async t => {
  const e = await environment(t), path = join(e.sessionDir, 'original.jsonl'), original = classic(e.dir, 'stable-id');
  await e.put(path, original); await e.save([{ agent: 'pi', session: path, empty: false }]);
  const host = await e.start(), sidecar = host.snapshot().sessionFile;
  await host.close();
  const sqlite = await readFile(sidecar), archive = readDurableArchive(sidecar);
  const changed = Buffer.concat([original, jsonl([user('new-branch', 'name', 'written later by Classic')])]);
  for (const bytes of [changed, Buffer.from('{malformed'), null]) {
    if (bytes === null) await rm(path); else await writeFile(path, bytes);
    // A stale mapping (or an explicit history open) still names the source,
    // so never silently route around a missing/changed Classic branch.
    await e.save([{ agent: 'pi', session: path, empty: false }]);
    const refused = await e.start();
    assert.deepEqual(refused.snapshot().tabs, []);
    assert.equal(refused.snapshot().handoff.recovery.length, 1);
    if (bytes === changed) assert.match(refused.snapshot().handoff.recovery[0].error, /changed since import/);
    assert.deepEqual(await readFile(sidecar), sqlite);
    assert.deepEqual(readDurableArchive(sidecar), archive);
    if (bytes !== null) assert.deepEqual(await readFile(path), bytes);
    await refused.close();
  }
  // Once a tab explicitly names Durable, its archived original is sufficient;
  // Classic is no longer its backing store and may have been moved away.
  await e.save([{ agent: 'pi', session: sidecar, empty: false }]);
  const resumed = await e.start();
  assert.equal(resumed.snapshot().sessionId, 'stable-id');
  assert.deepEqual(resumed.snapshot().messages, archive.messages);
});

test('a foreign sidecar beside valid Classic history is preserved, never initialized as an import', async t => {
  const e = await environment(t), path = await e.put(join(e.sessionDir, 'legacy.jsonl'), classic(e.dir, 'legacy'));
  const sidecar = `${path}.durable.sqlite`, db = new DatabaseSync(sidecar);
  db.exec('CREATE TABLE unrelated (value TEXT)'); db.close();
  const before = await readFile(sidecar), original = await readFile(path);
  await e.save([{ agent: 'pi', session: path, empty: false }]);
  const host = await e.start();
  assert.deepEqual(host.snapshot().tabs, []);
  assert.match(host.snapshot().handoff.recovery[0].error, /no such table/);
  const rows = await listPiSessions(e);
  assert.equal(rows.length, 1); assert.equal(rows[0].path, sidecar); assert.equal(rows[0].readError, true);
  assert.deepEqual(await readFile(sidecar), before);
  assert.deepEqual(await readFile(path), original);
});
