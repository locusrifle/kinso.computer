import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWebsitePopups } from '../../../../desktop/electron/popups.mjs';

const ours = url => new URL(url).origin === 'http://127.0.0.1:5067';
function fixture(options = {}) {
  const page = new EventEmitter();
  page.session = {};
  page.setWindowOpenHandler = handler => { page.open = handler; };
  page.loadURL = () => assert.fail('window.open must not navigate the opener');
  installWebsitePopups(page, { ours, ...options });
  return page;
}

test('website popups keep Chromium creation, opener cookies and sandbox without a bridge', () => {
  const page = fixture({ windowOptions: { show: false } });
  for (const url of ['https://elevenlabs.io/__/auth/handler', 'about:blank']) {
    const answer = page.open({ url });
    assert.equal(answer.action, 'allow');
    assert.equal(answer.outlivesOpener, undefined);
    const prefs = answer.overrideBrowserWindowOptions.webPreferences;
    assert.equal(prefs.session, page.session);
    assert.equal(prefs.preload, '');
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
  }
});

test('website popups reject harness, privileged protocols and malformed addresses', () => {
  const page = fixture();
  for (const url of ['http://127.0.0.1:5067/', 'file:///tmp/a', 'javascript:alert(1)', 'data:text/html,x', 'not a URL']) {
    assert.deepEqual(page.open({ url }), { action: 'deny' });
  }
});

test('native and streamed browsers can register the real child without manually loading it', () => {
  const createWindow = options => options;
  let child;
  const native = fixture({ onWindow: win => { child = win; } });
  native.emit('did-create-window', 'child');
  assert.equal(child, 'child');
  const streamed = fixture({ createWindow });
  assert.equal(streamed.open({ url: 'https://example.com' }).createWindow, createWindow);
});
