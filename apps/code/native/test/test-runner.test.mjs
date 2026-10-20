import test from 'node:test';
import assert from 'node:assert/strict';
import { drivesBrowser, testsFor, testFiles } from '../../../../tools/test-run.mjs';

const unit = 'apps/code/native/test/unit.test.mjs';
const browser = 'apps/code/native/test/ui-browser.test.mjs';
const tests = [unit, browser];

test('only tracked test-only changes narrow selection; an empty diff claims no verification', () => {
  assert.deepEqual(testsFor([browser], tests), [browser]);
  assert.deepEqual(testsFor([browser, unit, browser], tests), tests);
  assert.deepEqual(testsFor([], tests), []);
});

test('source, shared fixtures, runner, dependencies, config and HTTP assets conservatively select all suites', () => {
  for (const file of ['package.json', 'package-lock.json', 'config.json', 'AGENTS.md',
    'tools/test-run.mjs', 'tools/test-browser.mjs', 'system/server.mjs',
    'apps/code/native/test/fixtures/harness-page.mjs',
    'apps/code/native/public/css/imperfect.css', 'apps/code/native/public/index.html',
    'website/index.html', 'website/shop.css', 'website/launch.mjs',
    'apps/code/native/test/deleted.test.mjs']) {
    assert.deepEqual(testsFor([unit, file], tests), tests, file);
  }
});

test('phone, untracked and unknown changes refuse automatic verification instead of passing zero or partial tests', () => {
  assert.throws(() => testsFor(['phone/app/src/main/MainActivity.kt'], tests), /Phone changes need/);
  assert.throws(() => testsFor(['tools/new.mjs'], tests, { untracked: ['tools/new.mjs'] }), /Untracked changes/);
  assert.throws(() => testsFor(['unrecognised/file'], tests), /Unknown changed paths/);
});

test('browser classification follows transitive fixtures and cycles but not product imports', () => {
  const files = new Map([
    [unit, "import './fixtures/a.mjs'; import '../browser.mjs';"],
    ['apps/code/native/test/fixtures/a.mjs', "export { b } from './b.mjs';"],
    ['apps/code/native/test/fixtures/b.mjs', "import './a.mjs'; import { chromium } from 'playwright';"],
  ]);
  const read = file => { assert.ok(files.has(file), file); return files.get(file); };
  assert.equal(drivesBrowser(unit, { read }), true);
  files.set('apps/code/native/test/fixtures/b.mjs', "import './a.mjs';");
  assert.equal(drivesBrowser(unit, { read }), false);
  assert.equal(drivesBrowser(browser, { read: () => '' }), true);
  assert.equal(drivesBrowser(unit, { read: () => "import { startPrivate } from '../browser.mjs';" }), true);
  assert.equal(drivesBrowser(unit, { read: () => "import { launchChromium } from '../../../../tools/test-browser.mjs';" }), true);
  assert.equal(drivesBrowser(unit, { read: () => "const x = require('electron');" }), true);
});

test('real suite discovery includes the retained cheap regressions and recognizes browser fixtures', () => {
  const files = testFiles();
  for (const file of ['apps/code/native/test/safe-area.test.mjs', 'apps/code/native/test/owned-child.test.mjs', 'locker/test/website.test.mjs']) assert.ok(files.includes(file), file);
  for (const file of ['apps/code/native/test/browser.test.mjs', 'apps/code/native/test/private-browser.test.mjs', 'apps/code/native/test/window-layout-browser.test.mjs']) assert.equal(drivesBrowser(file), true, file);
  assert.equal(drivesBrowser('apps/code/native/test/dev-servers.test.mjs'), false);
});

test('unresolved fixture references take the serial lane and every real test file can be classified', () => {
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
  assert.equal(drivesBrowser(unit, { read: missing }), true);
  for (const file of testFiles()) assert.equal(typeof drivesBrowser(file), 'boolean', file);
});
