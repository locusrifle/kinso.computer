import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ownerSessionKey } from '../public/js/owner-transport.js';
const source = readFileSync(new URL('../public/js/harness.js', import.meta.url), 'utf8');
const restore = source.slice(source.indexOf('export function restoreQueueItem'), source.indexOf('export function mountGueyPi')).replace('export ', '');
function fixture(queue) {
  const calls = [];
  let resolve;
  const context = vm.createContext({ ownerSessionKey, ownerKey: value => value, selectedOwner: 'desktop', state: { sessionId: 'a', queue }, input: { value: 'unsent', selectionStart: 2, selectionEnd: 4 }, attachments: [{ image: { data: 'original' } }], command: (...args) => { calls.push(args); return new Promise(r => { resolve = r; }); }, fail: error => { throw error; }, paintQueue() {}, saveDraft() {}, paintPending() {}, paintCaret() {}, hooks: {}, restoreQueueItem: null, choosing: null });
  context.focusedTabId = () => 't1';
  context.input.focus = () => {};
  context.input.setSelectionRange = (start, end) => { context.input.selectionStart = start; context.input.selectionEnd = end; };
  const start = source.indexOf('\tconst queueDrafts =');
  const end = source.indexOf('\tfunction paintQueue()', start);
  vm.runInContext(restore + source.slice(start, end), context);
  return { context, calls, run: code => vm.runInContext(code, context), reply: item => resolve({ item }) };
}
const items = [{ id: 'one', lane: 'steering', text: 'same' }, { id: 'two', lane: 'steering', text: 'same' }, { id: 'three', lane: 'steering', text: 'last' }];
test('stable ID selects one duplicate, guards in-flight requests, preserves text/images/selection', async () => {
  const f = fixture({ items });
  const pending = f.run("takeQueue({queueId:'two'})");
  await f.run("takeQueue({queueId:'one'})");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'queue-take');
  assert.equal(f.calls[0][1].queueId, 'two');
  assert.equal(f.calls[0][1].expectedSessionId, 'a');
  assert.equal(f.calls[0][1].expectedTabId, 't1');
  const image = { type: 'image', mimeType: 'image/png', data: 'bytes' };
  f.reply({ ...items[1], images: [image] }); await pending;
  assert.equal(f.context.input.value, 'same\n\nunsent');
  assert.equal(f.context.input.selectionStart, 8);
  assert.equal(f.run('attachments.length'), 2);
  assert.equal(f.run('attachments[1].image'), image);
  assert.equal(items.length, 3);
});
test('latest delegates acceptance ordering, empty result leaves editor intact', async () => {
  const f = fixture({ items }); const p = f.run('takeQueue({latest:true})');
  assert.equal(f.calls[0][1].latest, true);
  f.reply(null); await p;
  assert.equal(f.context.input.value, 'unsent');
});
test('response after session switch is retained only in originating draft', async () => {
  const f = fixture({ items }); const p = f.run('takeQueue({latest:true})');
  f.run("queueDrafts.set(ownerSessionKey('desktop', 'a'), captureQueueDraft()); state = {sessionId:'b'}; input.value = 'other'; attachments = [];");
  f.reply(items[2]); await p;
  assert.equal(f.context.input.value, 'other');
  assert.equal(f.run("queueDrafts.get(ownerSessionKey('desktop', 'a')).text"), 'last\n\nunsent');
  assert.equal(f.run("queueDrafts.get(ownerSessionKey('desktop', 'a')).attachments.length"), 1);
});
test('surface reload waits only for what is in flight or lives only in the window', () => {
  const f = fixture({ items });
  // What the window and the page's own last-resort reload both ask (harness.js).
  assert.match(source, /surfaceReloadSafe: reloadSafe,/);
  const at = source.indexOf('\tfunction reloadSafe() {');
  const safe = source.slice(at, source.indexOf('\n\t}\n', at) + 3);
  f.run(`input.value = ''; attachments = []; let promptAccepting = 0, usageOpen = false, switching = false, foregroundRequests = 0, attachmentProcessing = 0; const promptRetries = new Map(); const overlay = null, choosing = null, creating = false, slashMenu = {hidden:true}; let live = false; const voice = {holding: () => live}; let editing = false; const workbench = {unsaved: () => editing}; ${safe}; const safe = reloadSafe;`);
  assert.equal(f.run('safe()'), true);
  f.run('live = true');
  assert.equal(f.run('safe()'), false, 'a recording the mic holds holds a reload');
  f.run('live = false; queueTaking = true');
  assert.equal(f.run('safe()'), false);
  // A draft's words are kept across the reload; a picked file is not.
  f.run("queueTaking = false; queueDrafts.set('other', {text:'recovered',attachments:[]})");
  assert.equal(f.run('safe()'), true);
  f.run("queueDrafts.set('other', {text:'',attachments:[{image:{data:'bytes'}}]})");
  assert.equal(f.run('safe()'), false);
  f.run('queueDrafts.clear()');
  assert.equal(f.run('safe()'), true);
  f.run('promptAccepting = 1');
  assert.equal(f.run('safe()'), false);
  f.run("promptAccepting = 0; promptRetries.set('submission', 'stable-id')");
  assert.equal(f.run('safe()'), true, 'a prompt kept for its retry goes along through the reload, never holds it');
  // An open panel comes back after the reload, so it does not hold it.
  f.run('promptRetries.clear(); usageOpen = true');
  assert.equal(f.run('safe()'), true);
  // Words typed into a file in Files hold it until they are saved.
  f.run('editing = true');
  assert.equal(f.run('safe()'), false, 'a file being edited, not yet saved, holds a reload');
  f.run('editing = false');
  assert.equal(f.run('safe()'), true);
});

test('queue response with colliding session IDs stays in its originating owner draft', async () => {
  const f = fixture({ items });
  f.run("state.executionOwner = 'desktop'");
  const pending = f.run('takeQueue({latest:true})');
  f.run("queueDrafts.set(editorKey(state), captureQueueDraft()); state = {executionOwner:'laptop',sessionId:'a'}; input.value = 'laptop'; attachments = [];");
  f.reply({ ...items[0], images: [{ data: 'desktop-only' }] }); await pending;
  assert.equal(f.context.input.value, 'laptop');
  assert.equal(f.run("queueDrafts.get(ownerSessionKey('desktop', 'a')).text"), 'same\n\nunsent');
  assert.equal(f.run("queueDrafts.get(ownerSessionKey('desktop', 'a')).attachments[1].image.data"), 'desktop-only');
  assert.equal(f.run('attachments.length'), 0);
});

test('late verified serving identity does not orphan an in-flight queue recovery', async () => {
  const f = fixture({ items });
  f.run("state.executionOwner = '@serving'");
  const pending = f.run('takeQueue({latest:true})');
  f.context.ownerKey = owner => owner === '@serving' ? 'desktop' : owner;
  f.run("state.executionOwner = 'desktop'");
  f.reply(items[0]); await pending;
  assert.equal(f.context.input.value, 'same\n\nunsent');
  assert.equal(f.run('queueTaking'), false);
});
