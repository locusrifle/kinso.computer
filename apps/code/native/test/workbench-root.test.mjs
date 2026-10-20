import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPUTER_ROOT, fileComputers, viewCount, loadTabs, saveTabs, tabName } from '../public/js/workbench-tabs.js';

test('synthetic computer root persists its provenance without becoming a filesystem path', () => {
  const tabs = [{ owner: 'known-peer-id', path: COMPUTER_ROOT, file: null }, { owner: '', path: '/home/local', file: '/home/local/index.html' }];
  assert.deepEqual(loadTabs(saveTabs(tabs, 0)), { tabs, active: 0 });
  assert.equal(tabName(tabs[0]), 'Computers');
  assert.equal(viewCount([tabs[0]], 0), '+');
  assert.equal(viewCount(tabs, 0), '1/2');
  assert.equal(viewCount(tabs, 1), '2/2');
});

test('root includes self, known file peers and unprobed offline computers, never a known code-only device', () => {
  const self = { self: true, id: 'self', reachable: true };
  const peer = { id: 'stable-peer', reachable: true, capabilities: ['files'] };
  const offline = { id: 'offline', reachable: false, capabilities: [] };
  const phone = { id: 'phone', reachable: true, capabilities: ['code'] };
  assert.deepEqual(fileComputers([self, peer, offline, phone]), [self, peer, offline]);
  assert.deepEqual(fileComputers([self]), [self], 'a hosted inventory exposes only its own authorized machine');
  assert.deepEqual(fileComputers([]), [], 'no invented reachable machine when inventory is unavailable');
});
