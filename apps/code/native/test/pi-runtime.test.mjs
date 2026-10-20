import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createRuntime, listPiSessions } from '../runtime.mjs';
import { readDurableArchive } from '../durable-archive.mjs';
import { SessionInfo } from '../durable-session.mjs';
import { createTabHost } from '../tabs.mjs';
import { fixture, answer, until, context } from './durable-fixture.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'AAEC/+==' };
const users = r => r.snapshot().messages.filter(m => m.role === 'user').map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join(''));
function held() {
  let release, entered;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  return { release, started, async respond(model, _transcript, count, options) { if (count === 1) { entered(); options.signal?.addEventListener('abort', release, { once: true }); await gate; } return answer(model); } };
}
test('explicit absent, empty or malformed histories never become fresh conversations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-missing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  await assert.rejects(createRuntime({ sessionPath: path }), /not found.*refusing/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await writeFile(path, ''); await assert.rejects(createRuntime({ sessionPath: path }), /empty.*refusing/);
  await writeFile(path, '{broken}\n'); await assert.rejects(createRuntime({ sessionPath: path }), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), '{broken}\n');
});

test('Durable owns steering, stable admissions, images and atomic queued-message editing', async t => {
  const hold = held(), { runtime: r, idle } = await fixture(t, { respond: hold.respond });
  const first = await r.command({ type: 'prompt', requestId: 'one', text: 'first' }); assert.equal(first.accepted, true); await hold.started;
  const second = await r.command({ type: 'prompt', requestId: 'two', text: 'look', images: [image], behavior: 'followUp' }); assert.equal(second.queued, true);
  const duplicate = await r.command({ type: 'prompt', requestId: 'two', text: 'look', images: [image] });
  assert.equal(duplicate.submissionId, second.submissionId); assert.equal(duplicate.duplicate, true);
  await r.command({ type: 'prompt', requestId: 'three', text: 'same' }); await r.command({ type: 'prompt', requestId: 'four', text: 'same' });
  const items = r.snapshot().queue.items;
  assert.deepEqual(items.map(i => i.text), ['look', 'same', 'same']); assert.deepEqual(items[0].images, [image]);
  const taken = await Promise.all([r.command({ type: 'queue-take', queueId: items[0].id }), r.command({ type: 'queue-take', queueId: items[0].id })]);
  assert.equal(taken.filter(v => v.item).length, 1); assert.deepEqual(taken.find(v => v.item).item.images, [image]);
  assert.equal((await r.command({ type: 'queue-take', latest: true })).item.id, items[2].id);
  hold.release(); await idle(); assert.deepEqual(users(r), ['first', 'same']); assert.equal(r.snapshot().busy, false);
  assert.equal((await r.command({ type: 'queue-take', queueId: items[1].id })).item, null);
});

test('abort returns only still-queued words and pictures', async t => {
  const hold = held(), { runtime: r, idle } = await fixture(t, { respond: hold.respond });
  await r.command({ type: 'prompt', text: 'first' }); await hold.started;
  await r.command({ type: 'prompt', text: 'waiting', images: [image] });
  const back = await r.command({ type: 'abort' }); await idle();
  assert.deepEqual(back.items.map(i => i.text), ['waiting']); assert.deepEqual(back.items[0].images, [image]);
  assert.deepEqual(users(r), ['first']); assert.deepEqual(r.snapshot().queue.items, []);
});

test('reopen preserves canonical session identity, model, effort, name and dedup receipts', async t => {
  const { runtime: r, dir, idle } = await fixture(t);
  await r.command({ type: 'name', name: 'Kept conversation' }); await r.command({ type: 'level', level: 'high' });
  const receipt = await r.command({ type: 'prompt', requestId: 'kept', text: 'hello' }); await idle();
  const before = r.snapshot(), path = before.sessionFile;
  const disk = readDurableArchive(path); assert.equal(disk.messages.length, 2); assert.equal(disk.info.name, 'Kept conversation');
  await assert.rejects(fixture(t, { dir, sessionPath: path }), /already has a writer/);
  await r.close(); const restored = await fixture(t, { dir, sessionPath: path });
  const after = restored.runtime.snapshot();
  assert.equal(after.source, 'pi'); assert.equal(after.sessionId, before.sessionId); assert.equal(after.name, before.name); assert.equal(after.level, 'high'); assert.deepEqual(after.messages, before.messages);
  const again = await restored.runtime.command({ type: 'prompt', requestId: 'kept', text: 'hello' });
  assert.equal(again.submissionId, receipt.submissionId); assert.equal(again.duplicate, true); assert.equal(restored.seen.length, 0);
  const rows = await listPiSessions({ agentDir: join(dir, 'agent'), sessionDir: join(dir, 'sessions') }); assert.equal(rows.length, 1); assert.equal(rows[0].id, before.sessionId);
});

test('old Pi history imports context and the whole tree without rewriting even a byte', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-import-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, join(dir, 'old'));
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'old words' }], timestamp: 1 });
  sm.appendMessage(answer({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }));
  sm.appendSessionInfo('Old name');
  const path = sm.getSessionFile(), bytes = await readFile(path);
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: path });
  assert.equal(r.snapshot().sessionId, sm.getSessionId()); assert.equal(r.snapshot().name, 'Old name'); assert.deepEqual(users(r), ['old words']);
  await r.command({ type: 'prompt', requestId: 'continued', text: 'new words' }); await idle();
  assert.ok(seen[0].messages.some(m => m.role === 'user' && m.content[0].text === 'old words'));
  assert.deepEqual(await readFile(path), bytes);
  const archive = readDurableArchive(r.snapshot().sessionFile); assert.equal(archive.entries.find(e => e.kind === 'imperfect.legacy').data.source, bytes.toString());
});

test('an imported branch exposes only the selected context while archiving every branch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-branch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const sm = SessionManager.create(dir, join(dir, 'old'));
  const root = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'root' }], timestamp: 1 });
  sm.appendMessage(answer({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }, [{ type: 'text', text: 'other branch reply' }]));
  sm.branch(root); sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'chosen branch' }], timestamp: 2 });
  const path = sm.getSessionFile(), bytes = await readFile(path);
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: path });
  assert.deepEqual(users(r), ['root', 'chosen branch']);
  assert.ok(!JSON.stringify(r.snapshot().messages).includes('other branch reply'));
  await r.command({ type: 'prompt', text: 'continue selected branch' }); await idle();
  assert.ok(!JSON.stringify(seen[0].messages).includes('other branch reply'));
  assert.match(readDurableArchive(r.snapshot().sessionFile).entries.find(e => e.kind === 'imperfect.legacy').data.source, /other branch reply/);
  assert.deepEqual(await readFile(path), bytes);
});

test('ChatGPT never silently falls back to an API key; Claude remains independent', async t => {
  const { runtime: r, models, seen } = await fixture(t);
  models.isUsingSubscription = () => false;
  await assert.rejects(r.command({ type: 'prompt', text: 'do not spend' }), /OAuth.*refusing API-key fallback/); assert.equal(seen.length, 0);
  await assert.rejects(r.command({ type: 'model', provider: 'anthropic', modelId: 'claude-opus-5-5' }), /Claude runs only in Claude Code/);
  assert.equal(r.snapshot().messages.length, 0);
});

test('questions use the existing canonical dialog and commit answers before continuation', async t => {
  const questions = [{ question: 'Which way?', header: 'Way', options: [{ label: 'left' }, { label: 'right' }] }];
  const { runtime: r, idle, seen } = await fixture(t, { respond: (model, _transcript, count) => count === 1 ? answer(model, [{ type: 'toolCall', id: 'ask-1', name: 'AskUserQuestion', arguments: { questions } }], 'toolUse') : answer(model) });
  await r.command({ type: 'prompt', text: 'ask me' }); await until(() => r.snapshot().ui.dialogs.length);
  const dialog = r.snapshot().ui.dialogs[0]; assert.equal(dialog.method, 'questions'); assert.deepEqual(dialog.questions, questions);
  await r.command({ type: 'dialog', dialogId: dialog.id, value: { 'Which way?': 'right' } }); await idle();
  assert.match(r.snapshot().messages.find(m => m.toolName === 'AskUserQuestion').content[0].text, /"Which way\?"="right"/); assert.equal(seen.length, 2);
});

test('uncertain effects permit a plain model report without a recovery dialog or clearing evidence', async t => {
  const { runtime: r, idle, seen } = await fixture(t);
  await r.session().conversation.commit(async tx => { (await tx.doc(SessionInfo, 1)).review.push({ name: 'send', reason: 'Response was lost; destination may already have received it' }); }, context);
  await r.command({ type: 'prompt', text: 'what happened?' }); await idle();
  assert.equal(seen.length, 1);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.match(JSON.stringify(seen[0]), /Inspect the destination\/state first/);
  assert.equal((await r.session().harness.snapshot(SessionInfo, 1, context)).review.length, 1);
});

test('the restart fence remains harness-neutral and releases held images once', async t => {
  const hold = held(), { runtime: r, idle } = await fixture(t, { respond: hold.respond });
  const host = await createTabHost({ createRuntime: () => r, listPiSessions: async () => [], checkUpdates: false });
  t.after(() => host.close());
  await host.command({ type: 'prompt', text: 'first' }); await hold.started; host.requestQuiesce();
  await host.command({ type: 'prompt', requestId: 'held', text: 'during', images: [image] });
  hold.release(); await host.waitForIdle(); assert.deepEqual(users(r), ['first']);
  await host.resumeDelivery(); await idle(); assert.deepEqual(users(r), ['first', 'during']);
});

test('Pi-specific execution hooks fail closed rather than pretending to be Durable extensions', async t => {
  await assert.rejects(fixture(t, { serviceOptions: { resourceLoaderOptions: { extensionFactories: [() => {}] } } }), /need a Durable port/);
});
