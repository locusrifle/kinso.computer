import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './durable-fixture.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'AAEC/+==' };
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('');

test('legacy display retains original active-branch words and pictures independently of model projection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-legacy-display-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const header = { type: 'session', version: 3, id: 'original-branch', cwd: dir, timestamp: '2026-01-01T00:00:00.000Z' };
  const user = (id, parentId, words, pictures = []) => ({ type: 'message', id, parentId, timestamp: header.timestamp, message: { role: 'user', content: [{ type: 'text', text: words }, ...pictures], timestamp: 1 } });
  const entries = [
    user('early', null, 'early original', [image]),
    user('abandoned', 'early', 'not on this branch'),
    user('kept', 'early', 'retained original', [image]),
    user('omitted', 'kept', 'omitted original'),
    { type: 'compaction', id: 'compact', parentId: 'omitted', timestamp: header.timestamp, firstKeptEntryId: 'kept', summary: 'earlier summary', tokensBefore: 1000 },
    { type: 'context_edit', id: 'replace', parentId: 'compact', timestamp: header.timestamp, targetId: 'kept', replacement: { content: 'model-only replacement' } },
    { type: 'context_edit', id: 'omit', parentId: 'replace', timestamp: header.timestamp, targetId: 'omitted', replacement: null },
    { type: 'branch_summary', id: 'branch', parentId: 'omit', timestamp: header.timestamp, fromId: 'abandoned', summary: 'branch summary' },
    { type: 'custom_message', id: 'custom', parentId: 'branch', timestamp: header.timestamp, customType: 'test', display: true, content: 'custom original' },
  ];
  const path = join(dir, 'legacy.jsonl'), source = [header, ...entries].map(JSON.stringify).join('\n') + '\n';
  await writeFile(path, source);
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: path });
  const originals = r.snapshot().messages.filter(message => message.role === 'user');
  assert.deepEqual(originals.map(text), ['early original', 'retained original', 'omitted original']);
  assert.deepEqual(originals[0].content[1], image);
  assert.deepEqual(originals[1].content[1], image);
  assert.ok(r.snapshot().messages.some(message => message.role === 'compactionSummary'));
  assert.ok(r.snapshot().messages.some(message => message.role === 'branchSummary'));
  assert.ok(r.snapshot().messages.some(message => message.role === 'custom' && message.content === 'custom original'));
  await r.command({ type: 'prompt', text: 'continue' });
  await idle();
  const request = JSON.stringify(seen[0].messages);
  assert.match(request, /model-only replacement/);
  for (const hidden of ['early original', 'retained original', 'omitted original', 'not on this branch']) assert.ok(!request.includes(hidden), hidden);
  assert.ok(!JSON.stringify(r.snapshot().messages).includes('model-only replacement'));
  const before = r.snapshot().messages;
  const sidecar = r.snapshot().sessionFile;
  await r.close();
  const reopened = await fixture(t, { dir, sessionPath: sidecar });
  assert.deepEqual(reopened.runtime.snapshot().messages, before);
  assert.equal(reopened.seen.length, 0);
  assert.equal(await readFile(path, 'utf8'), source);
});
