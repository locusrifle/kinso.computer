import test from 'node:test';
import assert from 'node:assert/strict';
import { CAP, loadTabs, saveTabs, tabName, withTab, withoutTab } from '../public/js/workbench-tabs.js';

const ids = tabs => tabs.map(tab => tab.id);

test('a new tab opens just after the one in front, and comes to the front', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let next = withTab(tabs, 0, { id: 'n' });
  assert.deepEqual(ids(next.tabs), ['a', 'n', 'b', 'c']);
  assert.equal(next.active, 1);
  assert.deepEqual(next.dropped, []);
  next = withTab(tabs, 2, { id: 'n' });
  assert.deepEqual(ids(next.tabs), ['a', 'b', 'c', 'n']);
  assert.equal(next.active, 3);
  assert.deepEqual(ids(tabs), ['a', 'b', 'c'], 'the tabs it was given are left as they were');
});

test(`past ${CAP} tabs, opening one closes the oldest other, never the new one`, () => {
  const full = Array.from({ length: CAP }, (_, i) => ({ id: i }));
  let next = withTab(full, CAP - 1, { id: 'n' });
  assert.equal(next.tabs.length, CAP);
  assert.deepEqual(ids(next.dropped), [0]);
  assert.equal(next.tabs[next.active].id, 'n');
  next = withTab(full, 0, { id: 'n' });
  assert.deepEqual(ids(next.dropped), [0], 'the oldest, even when it was in front');
  assert.equal(next.tabs[next.active].id, 'n');
  assert.equal(next.active, 0);
  next = withTab([{ id: 'a' }, { id: 'b' }], 1, { id: 'n' }, 2);
  assert.deepEqual(ids(next.tabs), ['b', 'n']);
  assert.equal(next.active, 1);
});

test('closing the tab in front brings the next one (the one before, for the last); the only tab stays', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let next = withoutTab(tabs, 1, 1);
  assert.deepEqual(ids(next.tabs), ['a', 'c']);
  assert.equal(next.tabs[next.active].id, 'c');
  assert.equal(next.closed.id, 'b');
  next = withoutTab(tabs, 2, 2);
  assert.equal(next.tabs[next.active].id, 'b');
  next = withoutTab(tabs, 2, 0);
  assert.deepEqual(ids(next.tabs), ['b', 'c']);
  assert.equal(next.tabs[next.active].id, 'c', 'one behind closed: the same one stays in front');
  next = withoutTab(tabs, 0, 2);
  assert.equal(next.tabs[next.active].id, 'a');
  next = withoutTab([{ id: 'a' }], 0, 0);
  assert.equal(next.closed, null);
  assert.deepEqual(ids(next.tabs), ['a']);
  assert.equal(withoutTab(tabs, 0, 5).closed, null);
});

test('tabs are kept as their computer, folder and file, and read back only as that', () => {
  const kept = saveTabs([
    { owner: '', path: '/home/noah/workbench/kinso', file: '/home/noah/workbench/kinso/index.html', viewer: {}, listing: { entries: [] } },
    { owner: 'laptop', path: '/home/noah/Pictures', file: null },
  ], 1);
  assert.deepEqual(JSON.parse(kept), {
    tabs: [{ owner: '', path: '/home/noah/workbench/kinso', file: '/home/noah/workbench/kinso/index.html' }, { owner: 'laptop', path: '/home/noah/Pictures', file: null }],
    active: 1,
  });
  assert.deepEqual(loadTabs(kept), JSON.parse(kept));
  assert.deepEqual(loadTabs(''), { tabs: [], active: 0 });
  assert.deepEqual(loadTabs('not json'), { tabs: [], active: 0 });
  assert.deepEqual(loadTabs(JSON.stringify({ tabs: [{ path: 'relative' }, { path: '/ok', file: 'no', owner: 3 }, null, 'x'], active: 9 })), { tabs: [{ owner: '', path: '/ok', file: null }], active: 0 });
  const many = JSON.stringify({ tabs: Array.from({ length: 30 }, (_, i) => ({ owner: '', path: `/f${i}`, file: null })), active: 20 });
  assert.equal(loadTabs(many).tabs.length, CAP);
  assert.equal(loadTabs(many).active, CAP - 1);
});

test('a tab is named for the file open in it, else its folder', () => {
  assert.equal(tabName({ path: '/home/noah/workbench/kinso', file: '/home/noah/workbench/kinso/index.html' }), 'index.html');
  assert.equal(tabName({ path: '/home/noah/workbench/kinso', file: null }), 'kinso');
  assert.equal(tabName({ path: '/', file: null }), '/');
  assert.equal(tabName({ path: '', file: null }), 'Home');
});
