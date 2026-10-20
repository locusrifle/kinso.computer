import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardHasText, filesFromClipboardData, filesFromClipboardItems } from '../public/js/clipboard-files.js';

test('plain path text wins over stale images and stays a native paste', async () => {
  assert.equal(clipboardHasText({ types: ['text/plain', 'image/png'], getData: () => '/home/noah/with spaces.png' }), true);
  assert.equal(clipboardHasText({ getData: () => '/home/noah/a.png\n/home/noah/b.png' }), true);
  assert.equal(clipboardHasText({ types: ['text/plain'], getData: () => '' }), true);
  assert.equal(clipboardHasText({ types: ['image/png'] }), false);
  assert.equal(clipboardHasText(null), false);
  const { readFile } = await import('node:fs/promises');
  const harness = await readFile(new URL('../public/js/harness.js', import.meta.url), 'utf8');
  const start = harness.indexOf('async function ingestPasteCaptured(event)');
  const paste = harness.slice(start, harness.indexOf("document.addEventListener('paste'", start));
  assert.ok(paste.indexOf('clipboardHasText(event.clipboardData)) return;') < paste.indexOf('filesFromClipboardData(event.clipboardData)'));
});

test('a paste that already has files keeps them', () => {
  const file = { name: 'shot.png', type: 'image/png' };
  assert.deepEqual(filesFromClipboardData({ files: [file], items: [] }), [file]);
});

test('a paste that only has items still yields the image', () => {
  const file = { name: 'shot.png', type: 'image/png' };
  const bag = { files: [], items: [{ kind: 'file', getAsFile: () => file }, { kind: 'string' }] };
  assert.deepEqual(filesFromClipboardData(bag), [file]);
});

test('nothing on the event is an empty list, not a throw', () => {
  assert.deepEqual(filesFromClipboardData(null), []);
  assert.deepEqual(filesFromClipboardData({}), []);
});

test('the async clipboard API turns image items into files', async () => {
  const blob = new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' });
  const items = [{ types: ['text/plain', 'image/png'], getType: async type => type === 'image/png' ? blob : null }];
  const files = await filesFromClipboardItems(items);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'clipboard.png');
  assert.equal(files[0].type, 'image/png');
});
