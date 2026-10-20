process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createMemoryRoute, gather, here, lock, logLines, memoryHome, readClaude, readPi, redactor, runRecall, search, shortId, sizes } from '../../../system/memory.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'memory');
// Made here, so no file in the repository looks like a key.
const SECRET = ['gh', 'p_', 'Q'.repeat(36)].join('');
const CREDENTIAL = ['Zq7', 'notAReal', 'Token42xyz'].join('');
const CLAUDE_ID = 'c1a0de00-1111-4222-8333-444455556666';
const PI_ID = '01a0aaaa-0000-7000-8000-00000000beef';
const at = iso => new Date(iso);
const NOW = Date.parse('2026-09-30T03:00:00Z');

async function fixture(name) {
  return (await readFile(join(FIXTURES, name), 'utf8')).replaceAll('@@SECRET@@', SECRET).replaceAll('@@CREDENTIAL@@', CREDENTIAL);
}

// A home with a Claude session, a Pi session, a worker transcript, a probe in
// /tmp and one still being written; ~/imperfect committed at two times.
async function world() {
  const home = await mkdtemp(join(tmpdir(), 'memory-'));
  const prefix = join(home, '.imperfect');
  const project = join(home, '.claude', 'projects', '-home-noah--imperfect-data-workspace');
  const pi = join(prefix, 'data', 'state', 'sessions');
  await mkdir(join(project, CLAUDE_ID, 'subagents'), { recursive: true });
  await mkdir(pi, { recursive: true });
  await mkdir(join(prefix, 'credentials'), { recursive: true });
  await writeFile(join(prefix, 'credentials', 'box-token'), `${CREDENTIAL}\n`);
  const files = {
    claude: join(project, `${CLAUDE_ID}.jsonl`),
    pi: join(pi, `2026-09-30T01-00-00-000Z_${PI_ID}.jsonl`),
    worker: join(project, CLAUDE_ID, 'subagents', 'agent-1.jsonl'),
    probe: join(home, '.claude', 'projects', '-tmp-probe', 'b0b0b0b0-1111-4222-8333-444455556666.jsonl'),
    busy: join(project, 'd0d0d0d0-1111-4222-8333-444455556666.jsonl'),
  };
  await mkdir(join(home, '.claude', 'projects', '-tmp-probe'), { recursive: true });
  await writeFile(files.claude, await fixture('claude.jsonl'));
  await writeFile(files.pi, await fixture('pi.jsonl'));
  await writeFile(files.worker, (await fixture('claude.jsonl')).replaceAll('Make the theme picker', 'WORKER PROMPT'));
  await writeFile(files.probe, (await fixture('claude.jsonl')).replaceAll('/home/noah/.imperfect/data/workspace', '/tmp/probe'));
  await writeFile(files.busy, (await fixture('claude.jsonl')).replaceAll('Make the theme picker', 'STILL TALKING'));
  for (const file of Object.values(files)) await utimes(file, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
  await utimes(files.busy, at('2026-09-30T02:55:00Z'), at('2026-09-30T02:55:00Z'));

  const repo = join(home, 'imperfect');
  const gitEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (when, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: { ...gitEnv, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }).trim();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { env: gitEnv });
  git('2026-09-29T00:00:00Z', 'commit', '--quiet', '--allow-empty', '-m', 'one');
  const first = git('2026-09-29T00:00:00Z', 'rev-parse', 'HEAD');
  git('2026-09-30T00:20:00Z', 'commit', '--quiet', '--allow-empty', '-m', 'two');
  const second = git('2026-09-30T00:20:00Z', 'rev-parse', 'HEAD');

  const dir = join(prefix, 'memory');
  const from = [{ name: 'laptop', run: here({ ...process.env, HOME: home }) }];
  const run = (now = NOW, ask) => gather({ prefix, dir, home, from, now, log: () => {}, ask });
  return { home, prefix, dir, files, first, second, repo, run };
}

// Another finished Claude session in the world: [time, who, text] a turn,
// who a tool for a tool call (text its command); written to last at mtime.
async function addLog(w, id, said, { cwd = '/home/noah/.imperfect/data/workspace', mtime = '2026-09-30T02:00:00Z' } = {}) {
  const file = join(w.home, '.claude', 'projects', '-home-noah--imperfect-data-workspace', `${id}.jsonl`);
  await writeFile(file, said.map(([timestamp, who, text], i) => JSON.stringify(who === 'noah'
    ? { type: 'user', uuid: `${id}-${i}`, sessionId: id, cwd, timestamp, message: { role: 'user', content: text } }
    : { type: 'assistant', uuid: `${id}-${i}`, sessionId: id, cwd, timestamp, message: { id: `m${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [who === 'agent' ? { type: 'text', text } : { type: 'tool_use', id: `t${i}`, name: who, input: { command: text } }] } })).join('\n'));
  await utimes(file, at(mtime), at(mtime));
  return file;
}

test('Claude: Noah word for word and the last answer before his next message; the rest is gone', async () => {
  const session = await readClaude(await fixture('claude.jsonl'));
  assert.equal(session.id, CLAUDE_ID);
  assert.equal(session.cwd, '/home/noah/.imperfect/data/workspace');
  assert.deepEqual(session.entries.map(entry => entry.who), ['noah', 'agent', 'noah', 'agent']);
  const [ask, answer, paste] = session.entries;
  assert.equal(ask.text, 'Make the theme picker only pictures, like this\n[image]', 'the reminder is cut, the picture is a marker');
  assert.equal(answer.text, `The worker finished: the picker is only pictures now.\n\nIt pushed with the key ${SECRET} in the remote, so rotate it.`,
    'the answer after a background report is the turn\'s last; the in-between text is dropped');
  assert.match(paste.text, /^\[pasted text: Handoff notes from the laptop\]\nwhat do you think\?/);
  assert.deepEqual(session.entries.map(({ line, end }) => [line, end]), [[3, undefined], [12, 13], [17, undefined], [18, undefined]], 'the line each is at in the log, and where a reply in two blocks ends');
  const all = session.entries.map(entry => entry.text).join('\n');
  for (const gone of ['TOOL OUTPUT', 'grep -n', 'read it first', 'Let me look', 'report back', 'task-notification', 'WORKER REPORT', 'SIDECHAIN', 'API Error', 'Continue from', 'interrupted', 'Today\'s date', 'iVBOR', 'second line of the paste']) {
    assert.ok(!all.includes(gone), `${gone} is not kept`);
  }
});

test('Claude: a stretch of the log written again, uuids and all, is read once', async () => {
  const text = await fixture('claude.jsonl');
  const lines = text.trim().split('\n');
  const again = [...lines, ...lines.slice(1, 12)].join('\n');
  assert.equal((await readClaude(again)).entries.filter(entry => entry.who === 'noah').length, 2);
  assert.deepEqual((await readClaude(again)).entries, (await readClaude(text)).entries);
});

test('Claude: what Noah sends while the agent works (a queued command, mid-turn) is his, and answered by what follows', async () => {
  const line = (record, at) => JSON.stringify({ sessionId: 's', cwd: '/home/noah/x', timestamp: `2026-10-19T05:${at}:00.000Z`, ...record });
  const log = [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'make the shop look like Kinso made it' } }, '00'),
    line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude', content: [{ type: 'text', text: 'Building it now.' }] } }, '01'),
    line({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', timestamp: '2026-10-19T05:02:00.000Z', prompt: [{ type: 'text', text: 'make it $39' }] } }, '02'),
    line({ type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' } }, '03'),
    line({ type: 'assistant', uuid: 'a2', message: { id: 'm2', model: 'claude', content: [{ type: 'text', text: 'It says US$39 now.' }] } }, '04'),
  ].join('\n');
  assert.deepEqual((await readClaude(log)).entries.map(({ who, text }) => [who, text]), [
    ['noah', 'make the shop look like Kinso made it'], ['agent', 'Building it now.'], ['noah', 'make it $39'], ['agent', 'It says US$39 now.']]);
});

test('Pi: a failed reply that was retried, tool calls and extension notes are dropped', async () => {
  const session = await readPi(await fixture('pi.jsonl'));
  assert.equal(session.id, PI_ID);
  assert.deepEqual(session.entries.map(({ who, text }) => [who, text]), [
    ['noah', 'why is the sound gone\n[image]'],
    ['agent', 'The headset had the sound; it plays on the speakers now.'],
    ['noah', '[spoken] thanks, that works'],
    ['agent', 'Glad it works.'],
  ]);
  assert.equal(shortId(PI_ID), '0000beef', 'a time-first id is told apart by its tail');
  assert.equal(shortId(CLAUDE_ID), 'c1a0de00');
});

// A log's bytes as a stream, in chunks of size, gzipped (and gunzipped as it
// is read) or not.
const stream = (text, size = 7, gzip = false) => {
  const bytes = gzip ? gzipSync(text) : Buffer.from(text);
  const chunks = Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
  return gzip ? chunks.pipe(createGunzip()) : chunks;
};

test('a log is read a line at a time: one longer than a string can be is read whole, unless a single line is that long', async () => {
  const text = await fixture('pi.jsonl');
  const longest = Math.max(...text.split('\n').map(line => Buffer.byteLength(line)));
  assert.ok(Buffer.byteLength(text) > 2 * longest, 'the whole log is longer than its longest line');
  for (const gzip of [false, true]) {
    assert.deepEqual(await readPi(stream(text, 7, gzip), longest), await readPi(text), 'streamed under a cap the whole log is over, it reads as its text does');
  }
  const said = 'ünïcödé 🌸 ok';
  assert.deepEqual(await Array.fromAsync(logLines(stream(`${said}\n\n${said}`, 3))), [said, '', said], 'a character cut between chunks is whole');
  await assert.rejects(readPi(stream(text, 64), longest - 1), new RegExp(`a line of more than ${longest - 1} bytes`), 'a line longer than the cap is the log\'s error');
  await assert.rejects(readPi(stream(`${'x'.repeat(100)}\n`, 1000), 99), /a line of more than 99 bytes/, 'a line in one chunk too');
});

test('pictures are let go as each line is read: a marker stays, the bytes never reach the transcript', async () => {
  const picture = `iVBORw0KGgo${'PICTUREBYTES'.repeat(1000)}`;
  const at = '2026-09-30T00:00:00Z';
  const pi = [
    { type: 'session', id: PI_ID, cwd: '/home/noah/imperfect', timestamp: at },
    { type: 'message', id: 'a', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'paint me a square' }, { type: 'image', data: picture, mimeType: 'image/png' }] } },
    { type: 'message', id: 'b', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'k', name: 'paint', arguments: { prompt: `like data:image/png;base64,${picture}`, content: `<img src="data:image/png;base64,${picture}">` } }] } },
    { type: 'message', id: 'c', timestamp: at, message: { role: 'toolResult', toolCallId: 'k', content: [{ type: 'text', text: `saved data:image/png;base64,${picture}` }, { type: 'image', data: picture }] } },
    { type: 'message', id: 'd', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: `Here it is: data:image/png;base64,${picture}` }] } },
  ].map(line => JSON.stringify(line)).join('\n');
  const session = await readPi(stream(pi, 4096, true));
  const said = JSON.stringify(session);
  assert.ok(!said.includes('PICTUREBYTES'), said.slice(0, 2000));
  assert.deepEqual(session.entries.map(entry => entry.text), ['paint me a square\n[image]', 'Here it is: [data]']);
  const call = session.events.find(event => event.who === 'tool');
  assert.equal(call.text, `paint(prompt=like [data], content=(${picture.length + 34} chars))`, 'what was written into a file is still only measured');
  assert.equal(call.result, 'saved [data] [image]');
});

test('secrets: shaped like a key, in a URL, or a value from the credentials box', () => {
  const redact = redactor([CREDENTIAL]);
  const said = redact(`key ${SECRET}, url https://buyer:${['ic', '_', 'a'.repeat(40)].join('')}@imperfect.computer/x, header Bearer abcdefghijklmnop, aws ${['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('')}, box ${CREDENTIAL}, sudo is hunter22`);
  for (const secret of [SECRET, 'a'.repeat(40), 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOP', CREDENTIAL, 'hunter22']) assert.ok(!said.includes(secret), said);
  assert.match(said, /https:\/\/\[redacted\]@imperfect\.computer/);
  assert.equal(redact('sudo is required here'), 'sudo is required here');
  const tail = 'A1b2C3d4E5f6G7h8J9k0';
  assert.equal(redact(`a tailnet key ${['tskey', 'auth', `k${tail}`, tail].join('-')} here`), 'a tailnet key [redacted] here', 'to the end of the token, not just its prefix');
  assert.equal(redact(`keys: ${['pk', 'sk', 'rk'].map(kind => `${kind}_test_51${tail}`).join('')}.`), 'keys: [redacted][redacted].', 'keys pasted end to end');
  assert.equal(redact(`a cloudflare token ${['cf', 'ut_', tail, tail].join('')} for dns`), 'a cloudflare token [redacted] for dns');
});

test('a slash command reads as it was typed; its output is dropped', async () => {
  const claude = async lines => (await readClaude(lines.map(line => JSON.stringify({ type: 'user', timestamp: '2026-09-30T00:00:00Z', message: { role: 'user', content: line } })).join('\n'))).entries.map(entry => entry.text);
  assert.deepEqual(await claude([
    '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check the build</command-args>',
    '<local-command-stdout>Set model to opus</local-command-stdout>',
    '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
  ]), ['/loop 5m check the build', '/clear']);
});

const headings = text => text.match(/^## .*$/gm) ?? [];

test('gathering: raw kept, and recent.md made from it: each exchange word for word, headed with where it was and the commit, secrets out', async () => {
  const w = await world();
  try {
    const result = await w.run();
    assert.equal(result.taken, 3, 'the Claude and Pi sessions and the probe; not the worker, not the one still being written');
    assert.deepEqual((await readdir(w.dir)).filter(name => name.endsWith('.md')), ['recent.md'], 'no file per session, and no days');
    for (const gone of ['days', 'projects', 'derived', 'index.json', 'open.json', 'nightly.json']) await assert.rejects(stat(join(w.dir, gone)), { code: 'ENOENT' }, gone);
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.equal(result.recentBytes, Buffer.byteLength(text));
    assert.ok(text.startsWith(`# recent: Noah's last 6 exchanges with his agents, oldest first\n\nMade 2026-09-30 03:00 (+00:00, the zone of every time here) from the logs of every session on every computer.`), text);
    assert.match(text, new RegExp(`The ground truth is the logs themselves, copied unchanged into ${w.dir}/raw/<computer>/<harness>/ \\(gzipped JSONL[^)]*\\), and each computer's ~/imperfect reflog in ${w.dir}/reflog/<computer>, which gives the commit at any moment\\.`));
    assert.deepEqual(headings(text), [
      `## 2026-09-30 00:00 · laptop · claude c1a0de00 · ~/.imperfect/data/workspace · commit ${w.first.slice(0, 12)}`,
      `## 2026-09-30 00:00 · laptop · claude c1a0de00 · ~/.imperfect/data/workspace · commit ${w.first.slice(0, 12)}`,
      `## 2026-09-30 00:30 · laptop · claude c1a0de00 · ~/.imperfect/data/workspace · commit ${w.second.slice(0, 12)} · still being written`,
      `## 2026-09-30 00:30 · laptop · claude c1a0de00 · ~/.imperfect/data/workspace · commit ${w.second.slice(0, 12)}`,
      `## 2026-09-30 01:00 · laptop · pi 0000beef · ~/.imperfect/data/workspace · commit ${w.second.slice(0, 12)}`,
      `## 2026-09-30 01:03 · laptop · pi 0000beef · ~/.imperfect/data/workspace · commit ${w.second.slice(0, 12)}`,
    ], 'in the order Noah spoke, across sessions; the one another computer is still writing is followed; not the probe in /tmp, not the worker');
    assert.ok(text.includes(`## 2026-09-30 00:00 · laptop · claude c1a0de00 · ~/.imperfect/data/workspace · commit ${w.first.slice(0, 12)}\n\nNoah:\n> Make the theme picker only pictures, like this\n> [image]\n\nAgent, 00:06:\n> The worker finished: the picker is only pictures now.\n>\n> It pushed with the key [redacted] in the remote, so rotate it.\n`), 'his words and the last of the reply, quoted, word for word');
    assert.match(text, /\nAgent, 00:31:\n> Keep the PC as the one box\.\n> ### 09:99 agent\n> ## 00:31–00:40 laptop claude c1a0de00\n/, 'nothing said reads as the structure');
    for (const gone of ['Let me look', 'report back', 'TOOL OUTPUT', 'WORKER PROMPT', 'Checking the mixer', 'Half an answer']) assert.ok(!text.includes(gone), gone);
    for (const secret of [SECRET, CREDENTIAL, 'hunter22']) assert.ok(!text.includes(secret), 'redacted');
    assert.match(text, /the box token is \[redacted\] and sudo is \[redacted\]/);

    const raw = gunzipSync(await readFile(join(w.dir, 'raw', 'laptop', 'claude', `${CLAUDE_ID}.jsonl.gz`))).toString('utf8');
    assert.equal(raw, await readFile(w.files.claude, 'utf8'), 'the cold copy is the log itself');
    assert.ok((await stat(join(w.dir, 'raw', 'laptop', 'claude', 'b0b0b0b0-1111-4222-8333-444455556666.jsonl.gz'))).isFile());
    assert.equal((await stat(w.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(w.dir, 'recent.md'))).mode & 0o777, 0o600);
    const done = JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8'));
    assert.deepEqual(Object.keys(done[`laptop:${w.files.claude}`]), ['size', 'mtime', 'raw']);
    const { logs, rawBytes, gzipBytes } = (await sizes({ dir: w.dir })).computers.laptop;
    assert.equal(logs, 3);
    assert.ok(rawBytes > gzipBytes && gzipBytes > 0);
    const pass = JSON.parse(await readFile(join(w.dir, 'pulse-pass.json'), 'utf8'));
    assert.deepEqual([pass.exchanges, pass.missed], [6, []]);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('calls are over: no recording is copied any more, and the ones memory kept stay as they are and are still counted', async () => {
  const w = await world();
  try {
    // A recording left on this computer from when there were calls.
    const calls = join(w.prefix, 'data', 'state', 'calls');
    await mkdir(calls, { recursive: true });
    const sound = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x80, 0x42]);
    const left = join(calls, '2026-09-30T00-10-00.webm');
    await writeFile(left, sound);
    await writeFile(join(calls, '2026-09-30T00-10-00.jsonl'), '{"t":0,"type":"call.started"}\n');
    await utimes(left, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
    // And one memory already took, with its line in .done.json.
    const kept = join(w.dir, 'raw', 'laptop', 'calls', '2026-09-29T20-00-00.webm');
    await mkdir(dirname(kept), { recursive: true });
    await writeFile(kept, sound);
    await writeFile(join(w.dir, '.done.json'), JSON.stringify({ 'laptop:/old/data/state/calls/2026-09-29T20-00-00.webm': { size: sound.length, mtime: 1, raw: 'raw/laptop/calls/2026-09-29T20-00-00.webm' } }));
    const result = await w.run();
    assert.equal(result.taken, 3, 'the three logs, and no recording');
    assert.deepEqual(await readdir(dirname(kept)), ['2026-09-29T20-00-00.webm'], 'nothing new beside what was kept');
    assert.deepEqual(await readFile(kept), sound, 'what was kept, byte for byte');
    assert.deepEqual(await readFile(left), sound, 'the recording on the computer is not touched');
    const { logs, calls: recorded, callBytes } = (await sizes({ dir: w.dir })).computers.laptop;
    assert.deepEqual({ logs, recorded, callBytes }, { logs: 3, recorded: 1, callBytes: sound.length });
    assert.equal(result.exchanges, 6, 'the exchanges are the sessions\'');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a session is taken once, again when it was resumed, and one another computer is still writing is followed until it is still', async () => {
  const w = await world();
  try {
    const recent = join(w.dir, 'recent.md'), busy = join(w.dir, 'live', 'laptop', 'claude', basename(w.files.busy));
    await w.run();
    const before = await readFile(recent, 'utf8');
    assert.equal(await readFile(busy, 'utf8'), await readFile(w.files.busy, 'utf8'), 'a copy of the log still being written, in live/, not raw/');
    assert.ok(!(await readdir(join(w.dir, 'raw', 'laptop', 'claude'))).some(name => name.startsWith('d0d0d0d0')));
    assert.equal((await w.run()).taken, 0, 'nothing changed');
    assert.equal(await readFile(recent, 'utf8'), before);
    await appendFile(w.files.pi, `${JSON.stringify({ type: 'message', id: 'e11', parentId: 'e10', timestamp: '2026-09-30T02:10:00.000Z', message: { role: 'user', content: 'one more thing: louder', timestamp: 0 } })}\n${JSON.stringify({ type: 'message', id: 'e12', parentId: 'e11', timestamp: '2026-09-30T02:11:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Louder now.' }], stopReason: 'stop', timestamp: 0 } })}\n`);
    await utimes(w.files.pi, at('2026-09-30T02:11:00Z'), at('2026-09-30T02:11:00Z'));
    assert.equal((await w.run()).taken, 1, 'the resumed one again, the busy one still followed');
    const after = await readFile(recent, 'utf8');
    assert.ok(after.endsWith('\n\n## 2026-09-30 02:10 · laptop · pi 0000beef · ~/.imperfect/data/workspace · commit ' + w.second.slice(0, 12) + '\n\nNoah:\n> one more thing: louder\n\nAgent, 02:11:\n> Louder now.\n'), after);
    const later = await w.run(Date.parse('2026-09-30T04:00:00Z'));
    assert.equal(later.taken, 1, 'the busy one, once it has been still for half an hour');
    assert.equal(later.live, 0);
    await assert.rejects(stat(busy), { code: 'ENOENT' }, 'and let go from live/');
    assert.match(await readFile(recent, 'utf8'), /\n> STILL TALKING/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('every run makes recent.md again from raw/ and the kept reflog alone', async () => {
  const w = await world();
  try {
    const recent = join(w.dir, 'recent.md'), still = Date.parse('2026-09-30T04:00:00Z');
    await w.run(still);
    const before = await readFile(recent, 'utf8');
    await rm(join(w.home, '.claude'), { recursive: true });
    await rm(join(w.home, 'imperfect'), { recursive: true });
    await writeFile(recent, 'scribbled over');
    assert.equal((await w.run(still)).taken, 0);
    assert.equal(await readFile(recent, 'utf8'), before, 'the same exchanges, commit stamps and all');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('exchanges in the order Noah spoke, across midnight and sessions; a replay is left out', async () => {
  const w = await world();
  try {
    const late = 'aa000000-1111-4222-8333-444455556666';
    await addLog(w, late, [
      ['2026-09-29T23:50:00Z', 'noah', 'start the overnight render of the film'],
      ['2026-09-29T23:52:00Z', 'agent', 'Started the render.'],
      ['2026-09-29T23:59:00Z', 'noah', 'tell me when the render finishes'],
      ['2026-09-30T00:10:00Z', 'agent', 'The render finished just after midnight.'],
    ]);
    const probe = "what's trending on X about Opus 5.5 this week?";
    await addLog(w, 'bb000000-1111-4222-8333-444455556666', [['2026-09-30T02:00:00Z', 'noah', probe], ['2026-09-30T02:01:00Z', 'agent', 'Outliers, first try.']]);
    await addLog(w, 'cc000000-1111-4222-8333-444455556666', [['2026-09-30T02:05:00Z', 'noah', probe], ['2026-09-30T02:05:30Z', 'agent', 'Outliers, second try.'], ['2026-09-30T02:06:00Z', 'noah', 'yes'], ['2026-09-30T02:06:30Z', 'agent', 'Posted.']]);
    await addLog(w, 'dd000000-1111-4222-8333-444455556666', [['2026-09-30T02:10:00Z', 'noah', probe], ['2026-09-30T02:11:00Z', 'agent', 'Outliers, third try.'], ['2026-09-30T02:12:00Z', 'noah', 'now chart the top five of them']]);
    const result = await w.run();
    assert.deepEqual([result.sessions, result.replays], [7, 1]);
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.deepEqual(headings(text).map(line => line.split(' · ').slice(0, 3).join(' · ')), [
      '## 2026-09-29 23:50 · laptop · claude aa000000',
      '## 2026-09-29 23:59 · laptop · claude aa000000',
      '## 2026-09-30 00:00 · laptop · claude c1a0de00',
      '## 2026-09-30 00:00 · laptop · claude c1a0de00',
      '## 2026-09-30 00:30 · laptop · claude c1a0de00',
      '## 2026-09-30 00:30 · laptop · claude c1a0de00',
      '## 2026-09-30 01:00 · laptop · pi 0000beef',
      '## 2026-09-30 01:03 · laptop · pi 0000beef',
      '## 2026-09-30 02:00 · laptop · claude bb000000',
      '## 2026-09-30 02:10 · laptop · claude dd000000',
      '## 2026-09-30 02:12 · laptop · claude dd000000',
    ]);
    assert.match(text, /\n> start the overnight render of the film\n\nAgent, 23:52:\n> Started the render\.\n/);
    assert.match(text, /\n> tell me when the render finishes\n\nAgent, 00:10:\n> The render finished just after midnight\.\n/, 'the reply after midnight is the exchange\'s');
    assert.match(text, /\n> now chart the top five of them\n\nAgent: \(no reply in words\)\n$/);
    assert.ok(!text.includes('second try') && !text.includes('Posted'), 'not the replay');
    assert.match(text, /third try/, 'something new said keeps a session its own');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("recent.md is Noah's last 20 exchanges, and only the logs they need are read", async () => {
  const w = await world();
  try {
    // Thirty more sessions, an exchange each, twenty minutes apart, each log
    // last written when its reply was.
    const start = Date.parse('2026-09-29T12:00:00Z');
    for (let i = 0; i < 30; i++) {
      const asked = new Date(start + i * 20 * 60_000), answered = new Date(asked.getTime() + 60_000);
      await addLog(w, `${String(i).padStart(4, '0')}0000-1111-4222-8333-444455556666`, [[asked.toISOString(), 'noah', `question ${i}`], [answered.toISOString(), 'agent', `answer ${i}`]], { mtime: answered.toISOString() });
    }
    await w.run();
    const all = await readFile(join(w.dir, 'recent.md'), 'utf8');
    const result = await w.run();
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.equal(text, all);
    assert.ok(text.startsWith("# recent: Noah's last 20 exchanges with his agents, oldest first\n"));
    assert.equal(headings(text).length, 20);
    const asked = [...text.matchAll(/^> question (\d+)$/gm)].map(m => Number(m[1]));
    assert.deepEqual(asked, Array.from({ length: 14 }, (_, i) => 16 + i), 'the newest, oldest first, beside the fixtures\' six');
    assert.match(text, /\n> question 29\n\nAgent, 21:41:\n> answer 29\n/);
    assert.ok(result.sessions < 20, `${result.sessions} sessions read, not all 33`);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a long reply is cut with the log and line where the whole is; a long message of Noah\'s too, further on', async () => {
  const w = await world();
  try {
    const id = 'ab000000-1111-4222-8333-444455556666';
    const reply = `${'a sentence of the reply. '.repeat(100)}THE END OF IT`, words = `${'what Noah said. '.repeat(500)}HIS LAST WORDS`;
    await addLog(w, id, [['2026-09-30T02:20:00Z', 'noah', 'tell me everything'], ['2026-09-30T02:21:00Z', 'agent', reply], ['2026-09-30T02:22:00Z', 'noah', words], ['2026-09-30T02:23:00Z', 'agent', 'Noted.']]);
    await w.run(Date.parse('2026-09-30T04:00:00Z'));
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8'), raw = join(w.dir, 'raw', 'laptop', 'claude', `${id}.jsonl.gz`);
    const shown = /\nAgent, 02:21:\n((?:>.*\n)+)/.exec(text)[1];
    assert.ok(!shown.includes('THE END OF IT'));
    assert.match(shown, /reply\. \[…\]\n>\n> \[cut: \d+ more characters\. The whole is line 2 of [^\n]*\]\n$/);
    assert.ok(shown.includes(`The whole is line 2 of ${raw}.]`), shown);
    const kept = shown.split('\n')[0].slice(2, -' […]'.length);
    assert.ok(kept.length <= 1500 && kept.length > 1300 && reply.startsWith(kept));
    assert.equal(Number(/\[cut: (\d+) more/.exec(shown)[1]), reply.length - kept.length);
    assert.match(text, /\n> what Noah said\. what Noah said\.[^\n]* \[…\]\n>\n> \[cut: \d+ more characters\. The whole is line 3 of [^\n]*\]\n\nAgent, 02:23:\n> Noted\.\n/);
    assert.ok(!text.includes('HIS LAST WORDS'));
    assert.equal(gunzipSync(await readFile(raw)).toString().split('\n')[1], JSON.stringify({ type: 'assistant', uuid: `${id}-1`, sessionId: id, cwd: '/home/noah/.imperfect/data/workspace', timestamp: '2026-09-30T02:21:00Z', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: reply }] } }), 'the line it points to holds the whole');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a secret once learned (.secrets) is still redacted', async () => {
  const w = await world();
  try {
    const secret = ['IG', 'pass-', 'w0rd9'].join('');
    await mkdir(w.dir, { recursive: true });
    await writeFile(join(w.dir, '.secrets'), `${createHash('sha256').update(secret).digest('hex')}\n`);
    await addLog(w, 'ab000000-1111-4222-8333-444455556666', [['2026-09-30T02:00:00Z', 'noah', `log in as locusrifle with ${secret} please`], ['2026-09-30T02:01:00Z', 'agent', 'Logged in.']]);
    await w.run();
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.match(text, /\n> log in as locusrifle with \[redacted\] please\n/);
    const [hit] = await search('locusrifle', { dir: w.dir, repo: w.repo });
    assert.equal(hit.text, 'log in as locusrifle with [redacted] please', 'and in what recall finds');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('secrets: a password said the other way round, and one learned', () => {
  const redact = redactor([], new Set([createHash('sha256').update('Zz9-learned').digest('hex')]));
  assert.equal(redact('locusrifle is the username trAWup-x5Q is the password'), 'locusrifle is the username [redacted] is the password');
  assert.equal(redact('what is the password'), 'what is the password');
  assert.equal(redact('it was Zz9-learned. Then Zz9-learnedly'), 'it was [redacted]. Then Zz9-learnedly');
});

test('a log is streamed into raw/, never held: one cut off is not kept, and is taken whole next run', async () => {
  const w = await world();
  try {
    const real = here({ ...process.env, HOME: w.home }), into = [], said = [];
    let broken = true;
    const run = (command, file) => {
      if (!command.startsWith('gzip ')) return real(command);
      into.push(file);
      return real(broken ? `${command} | head -c 100; exit 3` : command, file);
    };
    const pass = () => gather({ prefix: w.prefix, dir: w.dir, from: [{ name: 'laptop', run }], now: NOW, log: line => said.push(line) });
    assert.equal((await pass()).taken, 0);
    assert.equal(said.length, 4, said.join('\n'));
    assert.ok(into.length && into.every(file => file.endsWith('.part')), 'each written into a file as it comes');
    const left = await readdir(join(w.dir, 'raw'), { recursive: true });
    assert.deepEqual(left.filter(name => /\.(gz|part)$/.test(name)), [], 'nothing cut off is kept');
    assert.deepEqual(await readdir(join(w.dir, 'live', 'laptop', 'claude')), [], 'nor followed');
    broken = false;
    assert.equal((await pass()).taken, 3);
    assert.equal(gunzipSync(await readFile(join(w.dir, 'raw', 'laptop', 'pi', `${basename(w.files.pi)}.gz`))).toString('utf8'), await readFile(w.files.pi, 'utf8'));
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a computer that does not answer is skipped and caught up next run', async () => {
  const w = await world();
  try {
    const said = [];
    const result = await gather({ prefix: w.prefix, dir: w.dir, now: NOW, log: line => said.push(line), from: [{ name: 'away', run: async () => { throw new Error('ssh: connect timed out'); } }] });
    assert.equal(result.taken, 0);
    assert.deepEqual(result.missed, ['away']);
    assert.match(said[0], /^away: not reachable/);
    assert.deepEqual(JSON.parse(await readFile(join(w.dir, 'pulse-pass.json'), 'utf8')).missed, ['away']);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test("a log on this computer still being written is read where it is, linked in live/, never copied", async () => {
  const w = await world();
  try {
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const result = await gather({ prefix: w.prefix, dir: w.dir, from: local, now: NOW, log: () => {} });
    assert.deepEqual([result.taken, result.live], [3, 1], 'the finished logs copied, the busy one read in place');
    assert.ok(!(await readdir(join(w.dir, 'raw', 'laptop', 'claude'))).some(name => name.startsWith('d0d0d0d0')), 'not copied while it is written');
    assert.ok(!Object.keys(JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8'))).some(key => key.includes('d0d0d0d0')));
    const link = join(w.dir, 'live', 'laptop', 'claude', basename(w.files.busy));
    assert.equal(await readlink(link), w.files.busy, 'live/ links to it, by the name it will have in raw/');
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.match(text, /· still being written\n\nNoah:\n> \[pasted text: Handoff notes from the laptop\]/);
    assert.match(text, /\n> STILL TALKING only pictures, like this\n/);
    const later = await gather({ prefix: w.prefix, dir: w.dir, from: local, now: Date.parse('2026-09-30T04:00:00Z'), log: () => {} });
    assert.deepEqual([later.taken, later.live], [1, 0], 'once still it is copied');
    await assert.rejects(lstat(link), { code: 'ENOENT' }, 'and the link let go');
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a log another computer is still writing is fetched whole once, then only what it grew by; one written over is fetched whole again', async () => {
  const w = await world();
  try {
    const real = here({ ...process.env, HOME: w.home }), commands = [];
    const from = [{ name: 'laptop', run: (command, file) => { commands.push(command); return real(command, file); } }];
    const pass = (now = NOW) => gather({ prefix: w.prefix, dir: w.dir, from, now, log: () => {} });
    const copy = join(w.dir, 'live', 'laptop', 'claude', basename(w.files.busy));
    const fetched = () => commands.filter(command => command.includes(basename(w.files.busy)));
    await pass();
    assert.deepEqual(fetched().map(command => command.split(' ')[0]), ['gzip'], 'whole, the first time');
    await pass();
    assert.equal(fetched().length, 1, 'not again while it has not grown');
    const more = { type: 'user', uuid: 'more', sessionId: CLAUDE_ID, cwd: '/home/noah/.imperfect/data/workspace', timestamp: '2026-09-30T02:56:00Z', message: { role: 'user', content: 'and one more from the laptop' } };
    await appendFile(w.files.busy, `${JSON.stringify(more)}\n`);
    await utimes(w.files.busy, at('2026-09-30T02:56:00Z'), at('2026-09-30T02:56:00Z'));
    await pass();
    assert.match(fetched().at(-1), /^tail -c \+\d+ -- /, 'then only what it grew by');
    assert.equal(await readFile(copy, 'utf8'), await readFile(w.files.busy, 'utf8'));
    assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /\n> and one more from the laptop\n\nAgent: \(no reply in words yet\)\n$/);
    const over = (await readFile(w.files.busy, 'utf8')).replace('and one more from the laptop', 'and ONE more from the laptop') + `${JSON.stringify({ ...more, uuid: 'again', message: { role: 'user', content: 'again' } })}\n`;
    await writeFile(w.files.busy, over);
    await utimes(w.files.busy, at('2026-09-30T02:57:00Z'), at('2026-09-30T02:57:00Z'));
    await pass();
    assert.deepEqual(fetched().slice(-2).map(command => command.split(' ')[0]), ['tail', 'gzip'], 'what came before had changed: whole again');
    assert.equal(await readFile(copy, 'utf8'), over);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('a log of large pictures, copied into raw/ and read where it is being written, reaches recent.md only as markers', async () => {
  const w = await world();
  try {
    const picture = `iVBORw0KGgo${'PICTUREBYTES'.repeat(200_000)}`;
    const log = (id, minute) => [
      { type: 'session', id, cwd: '/home/noah/imperfect', timestamp: `2026-09-30T01:${minute}:00Z` },
      ...[`paint me a pink square at ${minute}`, `and a purple one at ${minute}`].flatMap((words, i) => [
        { type: 'message', id: `u${i}`, timestamp: `2026-09-30T01:${minute}:0${i}Z`, message: { role: 'user', content: [{ type: 'text', text: words }, { type: 'image', data: picture }] } },
        { type: 'message', id: `c${i}`, timestamp: `2026-09-30T01:${minute}:1${i}Z`, message: { role: 'assistant', content: [{ type: 'toolCall', id: `k${i}`, name: 'paint', arguments: { prompt: words } }] } },
        { type: 'message', id: `r${i}`, timestamp: `2026-09-30T01:${minute}:2${i}Z`, message: { role: 'toolResult', toolCallId: `k${i}`, content: [{ type: 'image', data: picture }, { type: 'text', text: `data:image/png;base64,${picture}` }] } },
        { type: 'message', id: `a${i}`, timestamp: `2026-09-30T01:${minute}:3${i}Z`, message: { role: 'assistant', content: [{ type: 'text', text: `Painted: ![square](data:image/png;base64,${picture})` }] } },
      ]),
    ].map(line => JSON.stringify(line)).join('\n');
    const sessions = join(w.prefix, 'data', 'state', 'sessions');
    const still = join(sessions, '2026-09-30T01-10-00-000Z_01a0cccc-0000-7000-8000-00000000beef.jsonl');
    const busy = join(sessions, '2026-09-30T01-20-00-000Z_01a0dddd-0000-7000-8000-00000000beef.jsonl');
    await writeFile(still, log('01a0cccc-0000-7000-8000-00000000beef', 10));
    await writeFile(busy, log('01a0dddd-0000-7000-8000-00000000beef', 20));
    assert.ok((await stat(still)).size > 10 * 2 ** 20, 'pictures of megabytes, a line each');
    await utimes(still, at('2026-09-30T02:00:00Z'), at('2026-09-30T02:00:00Z'));
    await utimes(busy, at('2026-09-30T02:45:00Z'), at('2026-09-30T02:45:00Z'));
    const said = [];
    const local = [{ name: 'laptop', run: here({ ...process.env, HOME: w.home }), local: true }];
    const result = await gather({ prefix: w.prefix, dir: w.dir, from: local, now: NOW, log: line => said.push(line) });
    assert.deepEqual(said, [], 'every log read');
    assert.equal(result.live, 2, 'the busy picture log and the busy Claude one, read where they are');
    const raw = join(w.dir, 'raw', 'laptop', 'pi', `${basename(still)}.gz`);
    assert.equal(gunzipSync(await readFile(raw)).toString('utf8'), await readFile(still, 'utf8'), 'copied into raw/ whole');
    const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
    assert.ok(!text.includes('PICTUREBYTES'), 'no picture bytes in memory');
    assert.match(text, /\n> paint me a pink square at 10\n> \[image\]\n\nAgent, 01:10:\n> Painted: !\[square\]\(\[data\]\)\n/);
    assert.match(text, /\n> and a purple one at 20\n> \[image\]\n/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('search: in the logs themselves, Noah first, newest first, with the neighbour, the line and the commit; recall reaches the PC', async () => {
  const w = await world();
  let server;
  try {
    await w.run(Date.parse('2026-09-30T04:00:00Z'));
    const hits = await search('picker', { dir: w.dir, repo: w.repo });
    assert.deepEqual(hits.map(hit => `${hit.who} ${hit.time.slice(11, 16)}`), ['noah 00:00', 'agent 00:06', 'agent 00:00'], 'the agents\' words as they worked too');
    assert.equal(hits[0].text, 'Make the theme picker only pictures, like this\n[image]');
    assert.match(hits[0].neighbour.text, /^The worker finished[^]*the key \[redacted\] in the remote/, 'the reply, secrets out');
    assert.equal(hits[0].time, '2026-09-30T00:00+00:00');
    assert.deepEqual([hits[0].computer, hits[0].harness, hits[0].session, hits[0].cwd], ['laptop', 'claude', 'c1a0de00', '~/.imperfect/data/workspace']);
    assert.deepEqual([hits[0].path, hits[0].line], [join(w.dir, 'raw', 'laptop', 'claude', `${CLAUDE_ID}.jsonl.gz`), 3]);
    assert.equal(hits[0].commit, w.first);
    assert.equal(hits[0].ancestor, true);
    assert.equal(hits[1].neighbour.who, 'noah', 'an answer brings its question');

    const the = await search('the', { dir: w.dir, repo: w.repo });
    assert.deepEqual(the.filter(hit => hit.who === 'noah').map(hit => `${hit.harness} ${hit.time.slice(11, 16)}`), ['pi 01:00', 'claude 00:30', 'claude 00:00'], 'newest first, each once');
    assert.equal(the.findIndex(hit => hit.who === 'agent'), the.filter(hit => hit.who === 'noah').length, "Noah's words rank first");
    assert.equal((await search('"one box"', { dir: w.dir, repo: w.repo }))[0].commit, w.second);
    assert.equal((await search('"### 09:99 agent"', { dir: w.dir, repo: w.repo }))[0].who, 'agent', 'a line that reads like structure is found as it was said');
    assert.deepEqual(await search('nothing-like-this', { dir: w.dir }), []);
    assert.deepEqual(await search('trending', { dir: w.dir }), [], 'not the probe in /tmp');
    assert.deepEqual((await search('"WORKER PROMPT"', { dir: w.dir })).length, 0, 'nor a worker\'s');
    assert.deepEqual(await search('"TOOL OUTPUT"', { dir: w.dir }), [], 'what a tool answered nobody said');
    assert.equal((await search('Picker "quote\\"d"', { dir: w.dir })).length, 0);

    // Another computer asks the PC.
    const route = createMemoryRoute({ dir: w.dir });
    server = createServer(async (req, res) => { if (!await route(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    const answer = await runRecall({ query: 'picker' }, { locate: async () => url });
    assert.match(answer, /^3 things said holding "picker"/);
    assert.match(answer, /1\. noah, 2026-09-30 00:00 on laptop \(claude c1a0de00, in ~\/\.imperfect\/data\/workspace\), commit [0-9a-f]{12}/);
    assert.match(answer, /\/raw\/laptop\/claude\/c1a0de00-[^\n]*\.jsonl\.gz, line 3\n/);
    assert.match(answer, /noah 00:00: Make the theme picker/);
    assert.match(answer, /agent 00:06: The worker finished/);
    const refused = await fetch(`${url}/memory`, { method: 'POST', body: '{"query":"picker"}' });
    assert.equal(refused.status, 403, 'an exact origin is required');
    await assert.rejects(runRecall({ query: 'picker' }, { locate: async () => '' }), /cannot reach it/);
    await assert.rejects(runRecall({}, { locate: async () => null }), /needs words to look for/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(w.home, { recursive: true, force: true });
  }
});

test('search reads a log still being written, and finds what Noah said in it', async () => {
  const w = await world();
  try {
    await w.run();
    const [hit] = await search('"STILL TALKING"', { dir: w.dir, repo: w.repo });
    assert.equal(hit.who, 'noah');
    assert.equal(hit.path, join(w.dir, 'live', 'laptop', 'claude', basename(w.files.busy)));
    assert.match(hit.neighbour.text, /^The worker finished/);
  } finally { await rm(w.home, { recursive: true, force: true }); }
});

test('memory lives on the authority, or here when this computer follows none', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'memory-home-'));
  try {
    const status = id => async () => (id ? { Self: { ID: id, DNSName: 'desk.example.ts.net.' } } : null);
    assert.equal(await memoryHome(prefix, status('')), 0, 'no machine.json: this computer is its own');
    await writeFile(join(prefix, 'machine.json'), JSON.stringify({ authority: { id: 'pcNODE1', name: 'desktop' } }));
    assert.equal(await memoryHome(prefix, status('pcNODE1')), 0);
    assert.equal(await memoryHome(prefix, status('laptopNODE2')), 1);
    assert.equal(await memoryHome(prefix, status('')), 2, 'no tailnet answer: cannot tell');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('one pass at a time, per memory folder; a pass that ends lets go', async () => {
  const one = await mkdtemp(join(tmpdir(), 'memory-lock-')), two = await mkdtemp(join(tmpdir(), 'memory-lock-'));
  try {
    const release = await lock(one);
    assert.ok(release);
    assert.equal(await lock(one), null, 'held');
    const other = await lock(two);
    assert.ok(other, 'another folder is another lock');
    await release();
    await other();
    const again = await lock(one);
    assert.ok(again, 'free again');
    await again();
  } finally { await rm(one, { recursive: true, force: true }); await rm(two, { recursive: true, force: true }); }
});

test('memory calls no model: its prompts are gone', async () => {
  for (const name of ['memory-prompt.md', 'memory-open-prompt.md', 'memory-nightly-prompt.md']) {
    await assert.rejects(stat(new URL(`../../../system/${name}`, import.meta.url)), { code: 'ENOENT' }, name);
  }
  const source = await readFile(new URL('../../../system/memory.mjs', import.meta.url), 'utf8');
  assert.ok(!/node_modules', '\.bin', 'pi'|\/sessions\/open/.test(source), 'neither Pi nor a session is started from memory');
});

test('recall bounds even an excessive requested hit count', async () => {
  await runRecall({ query: 'needle', limit: 999 }, { locate: async () => null, find: async (query, { limit }) => {
    assert.equal(query, 'needle'); assert.equal(limit, 20); return [];
  } });
});
